/**
 * Client-side avatar renderer — replaces Simli WebRTC with local Canvas 2D + Web Audio.
 *
 * Eliminates:
 * - 12s Simli WebRTC warmup
 * - Server round-trip for face rendering
 * - 6000-byte rechunking
 * - simli-client dependency for audio path
 *
 * Audio plays via Web Audio API (AudioBufferSourceNode → GainNode → AnalyserNode → destination).
 * AnalyserNode provides RMS amplitude for mouth animation. Gapless scheduling via nextPlayTime.
 */
import { useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';

export interface ClientAvatarHandle {
  sendAudio: (pcm: Uint8Array) => void;
  flushAudio: () => void;
  getLastRenderStartMs: () => number;
  getLipSyncSamples: () => number[];
  resetStats: () => void;
  resetForInteraction: () => void;
  unlockAudio: () => void;
  /** Milliseconds of audio still scheduled to play via Web Audio API */
  getRemainingPlayMs: () => number;
}

interface Props {
  isActive: boolean;
  onReady?: (ms: number) => void;
}

// ── Particle system types ──
interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  r: number; alpha: number;
  phase: number; speed: number;
}

interface Star {
  x: number; y: number;
  r: number; alpha: number;
  twinkleSpeed: number; twinklePhase: number;
}

function createParticles(count: number): Particle[] {
  return Array.from({ length: count }, () => ({
    x: Math.random(), y: Math.random(),
    vx: (Math.random() - 0.5) * 0.0003,
    vy: (Math.random() - 0.5) * 0.0003,
    r: 1 + Math.random() * 2.5,
    alpha: 0.1 + Math.random() * 0.3,
    phase: Math.random() * Math.PI * 2,
    speed: 0.005 + Math.random() * 0.015,
  }));
}

function createStars(count: number): Star[] {
  return Array.from({ length: count }, () => ({
    x: Math.random(), y: Math.random(),
    r: 0.3 + Math.random() * 1.2,
    alpha: 0.15 + Math.random() * 0.4,
    twinkleSpeed: 0.01 + Math.random() * 0.03,
    twinklePhase: Math.random() * Math.PI * 2,
  }));
}

export const ClientAvatar = forwardRef<ClientAvatarHandle, Props>(({ isActive, onReady }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const nextPlayTimeRef = useRef(0);
  const lastRenderStartMsRef = useRef(0);
  const mountTimeRef = useRef(Date.now());
  const animFrameRef = useRef(0);
  const isActiveRef = useRef(isActive);
  // Track active sources for barge-in stop
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  // Smooth amplitude for mouth animation
  const amplitudeRef = useRef(0);
  // Blink state
  const blinkRef = useRef(0); // 0 = open, >0 = closing/closed
  const nextBlinkRef = useRef(Date.now() + 2000 + Math.random() * 3000);
  // Animation phases
  const glowPhaseRef = useRef(0);
  const frameCountRef = useRef(0);
  // Particle systems (initialized once)
  const particlesRef = useRef<Particle[]>(createParticles(18));
  const starsRef = useRef<Star[]>(createStars(60));
  // Frequency data for waveform ring
  const freqDataRef = useRef<Uint8Array | null>(null);
  // Stable ref for callback
  const onReadyRef = useRef(onReady);

  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);

  // Ensure AudioContext exists (lazy init)
  const ensureAudioCtx = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      const ctx = new AudioContext({ sampleRate: 16000 });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      const gain = ctx.createGain();
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      gainRef.current = gain;
      nextPlayTimeRef.current = 0;
    }
    return audioCtxRef.current;
  }, []);

  // Canvas render loop — runs continuously, reads amplitude from AnalyserNode
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Fire onReady immediately — no WebRTC warmup
    const readyMs = Date.now() - mountTimeRef.current;
    onReadyRef.current?.(readyMs);

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }

      const ctx = canvas.getContext('2d')!;
      ctx.save();
      ctx.scale(dpr, dpr);

      const w = rect.width;
      const h = rect.height;
      const cx = w / 2;
      const cy = h / 2 - 10;
      const frame = frameCountRef.current++;

      // Read audio amplitude from AnalyserNode
      let rawAmplitude = 0;
      if (analyserRef.current) {
        const data = new Uint8Array(analyserRef.current.fftSize);
        analyserRef.current.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        rawAmplitude = Math.sqrt(sum / data.length);

        // Grab frequency data for waveform ring
        if (!freqDataRef.current) freqDataRef.current = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(freqDataRef.current);
      }
      // Smooth amplitude (fast attack, slower release)
      const target = rawAmplitude;
      const speed = target > amplitudeRef.current ? 0.4 : 0.12;
      amplitudeRef.current += (target - amplitudeRef.current) * speed;
      const amp = amplitudeRef.current;

      // Blink logic
      const now = Date.now();
      if (now >= nextBlinkRef.current && blinkRef.current === 0) {
        blinkRef.current = 1;
        setTimeout(() => { blinkRef.current = 0; }, 120);
        nextBlinkRef.current = now + 2500 + Math.random() * 4000;
      }

      // Phase accumulators
      glowPhaseRef.current += 0.015;
      const glowPulse = 0.5 + 0.5 * Math.sin(glowPhaseRef.current);
      const breathe = 1 + 0.008 * Math.sin(frame * 0.025); // subtle breathing
      const active = isActiveRef.current;

      // ── Clear ──
      ctx.clearRect(0, 0, w, h);

      // ── Background gradient ──
      const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, h * 0.85);
      bgGrad.addColorStop(0, '#0a1628');
      bgGrad.addColorStop(0.6, '#060e1a');
      bgGrad.addColorStop(1, '#030810');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // ── Starfield ──
      for (const star of starsRef.current) {
        star.twinklePhase += star.twinkleSpeed;
        const twinkle = 0.3 + 0.7 * Math.abs(Math.sin(star.twinklePhase));
        const sa = star.alpha * twinkle * (active ? 0.6 : 1);
        ctx.fillStyle = `rgba(140, 180, 220, ${sa})`;
        ctx.beginPath();
        ctx.arc(star.x * w, star.y * h, star.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Floating particles ──
      for (const p of particlesRef.current) {
        p.phase += p.speed;
        p.x += p.vx + Math.sin(p.phase) * 0.0002;
        p.y += p.vy + Math.cos(p.phase) * 0.0002;
        // Wrap around edges
        if (p.x < -0.05) p.x = 1.05; if (p.x > 1.05) p.x = -0.05;
        if (p.y < -0.05) p.y = 1.05; if (p.y > 1.05) p.y = -0.05;

        const px = p.x * w;
        const py = p.y * h;
        const distToHead = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
        const headR = Math.min(w, h) * 0.26 * breathe;
        // Particles near the head glow brighter when active
        const proximity = Math.max(0, 1 - distToHead / (headR * 3));
        const pa = p.alpha * (1 + (active ? amp * 2 : 0) * proximity);

        // Draw particle with glow
        const pGrad = ctx.createRadialGradient(px, py, 0, px, py, p.r * 3);
        pGrad.addColorStop(0, `rgba(62, 207, 207, ${pa * 0.8})`);
        pGrad.addColorStop(0.5, `rgba(62, 207, 207, ${pa * 0.2})`);
        pGrad.addColorStop(1, 'rgba(62, 207, 207, 0)');
        ctx.fillStyle = pGrad;
        ctx.beginPath();
        ctx.arc(px, py, p.r * 3, 0, Math.PI * 2);
        ctx.fill();

        // Core
        ctx.fillStyle = `rgba(120, 230, 230, ${pa})`;
        ctx.beginPath();
        ctx.arc(px, py, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Draw connecting lines between nearby particles ──
      const particles = particlesRef.current;
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = (particles[i].x - particles[j].x) * w;
          const dy = (particles[i].y - particles[j].y) * h;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 100) {
            const la = (1 - dist / 100) * 0.06 * (active ? 1 + amp : 1);
            ctx.strokeStyle = `rgba(62, 207, 207, ${la})`;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(particles[i].x * w, particles[i].y * h);
            ctx.lineTo(particles[j].x * w, particles[j].y * h);
            ctx.stroke();
          }
        }
      }

      // ── Head ──
      const headR = Math.min(w, h) * 0.26 * breathe;

      // Large ambient glow
      const glowAlpha = active ? 0.06 + amp * 0.12 : 0.02 + glowPulse * 0.015;
      const glowGrad = ctx.createRadialGradient(cx, cy, headR * 0.8, cx, cy, headR * 2.5);
      glowGrad.addColorStop(0, `rgba(62, 207, 207, ${glowAlpha})`);
      glowGrad.addColorStop(0.5, `rgba(40, 140, 180, ${glowAlpha * 0.3})`);
      glowGrad.addColorStop(1, 'rgba(62, 207, 207, 0)');
      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, headR * 2.5, 0, Math.PI * 2);
      ctx.fill();

      // ── Audio-reactive waveform ring ──
      if (active && freqDataRef.current && amp > 0.01) {
        const freqData = freqDataRef.current;
        const ringR = headR * 1.35;
        const segments = 64;
        ctx.beginPath();
        for (let i = 0; i <= segments; i++) {
          const angle = (i / segments) * Math.PI * 2 - Math.PI / 2;
          const freqIdx = Math.floor((i / segments) * freqData.length * 0.6);
          const freqVal = (freqData[freqIdx] ?? 0) / 255;
          const spike = freqVal * headR * 0.25 * Math.min(1, amp * 4);
          const r = ringR + spike;
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = `rgba(62, 207, 207, ${0.15 + amp * 0.3})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Inner ring mirror (subtle)
        ctx.beginPath();
        for (let i = 0; i <= segments; i++) {
          const angle = (i / segments) * Math.PI * 2 - Math.PI / 2;
          const freqIdx = Math.floor((i / segments) * freqData.length * 0.6);
          const freqVal = (freqData[freqIdx] ?? 0) / 255;
          const spike = freqVal * headR * 0.12 * Math.min(1, amp * 4);
          const r = ringR - spike;
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = `rgba(62, 207, 207, ${0.08 + amp * 0.12})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (!active) {
        // Idle: subtle dashed orbital ring
        const ringR = headR * 1.35;
        ctx.setLineDash([4, 8]);
        ctx.strokeStyle = `rgba(62, 207, 207, ${0.04 + glowPulse * 0.03})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── Orbital dots ──
      const orbitR = headR * 1.35;
      const orbitCount = 5;
      const orbitSpeed = active ? 0.008 + amp * 0.01 : 0.003;
      for (let i = 0; i < orbitCount; i++) {
        const baseAngle = (i / orbitCount) * Math.PI * 2;
        const angle = baseAngle + frame * orbitSpeed;
        const ox = cx + Math.cos(angle) * orbitR;
        const oy = cy + Math.sin(angle) * orbitR;
        const dotR = 2 + (active ? amp * 3 : 0);
        const dotAlpha = active ? 0.4 + amp * 0.4 : 0.12 + glowPulse * 0.08;

        // Dot glow
        const dGrad = ctx.createRadialGradient(ox, oy, 0, ox, oy, dotR * 4);
        dGrad.addColorStop(0, `rgba(62, 207, 207, ${dotAlpha * 0.5})`);
        dGrad.addColorStop(1, 'rgba(62, 207, 207, 0)');
        ctx.fillStyle = dGrad;
        ctx.beginPath();
        ctx.arc(ox, oy, dotR * 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(140, 240, 240, ${dotAlpha})`;
        ctx.beginPath();
        ctx.arc(ox, oy, dotR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Head fill — glass-like with inner gradient
      const headGrad = ctx.createRadialGradient(cx - headR * 0.3, cy - headR * 0.3, 0, cx, cy, headR);
      headGrad.addColorStop(0, '#1e3d5f');
      headGrad.addColorStop(0.5, '#142d47');
      headGrad.addColorStop(1, '#0c1f33');
      ctx.fillStyle = headGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, headR, 0, Math.PI * 2);
      ctx.fill();

      // Head specular highlight (top-left)
      const specGrad = ctx.createRadialGradient(cx - headR * 0.35, cy - headR * 0.35, 0, cx - headR * 0.2, cy - headR * 0.2, headR * 0.7);
      specGrad.addColorStop(0, 'rgba(100, 200, 220, 0.08)');
      specGrad.addColorStop(1, 'rgba(100, 200, 220, 0)');
      ctx.fillStyle = specGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, headR, 0, Math.PI * 2);
      ctx.fill();

      // Head border — double ring
      const borderAlpha = active ? 0.25 + amp * 0.35 : 0.1 + glowPulse * 0.05;
      ctx.strokeStyle = `rgba(62, 207, 207, ${borderAlpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, headR, 0, Math.PI * 2);
      ctx.stroke();

      // Inner accent ring
      ctx.strokeStyle = `rgba(62, 207, 207, ${borderAlpha * 0.3})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, headR * 0.92, 0, Math.PI * 2);
      ctx.stroke();

      // ── Eyes ──
      const eyeSpacing = headR * 0.34;
      const eyeY = cy - headR * 0.1;
      const eyeR = headR * 0.1;
      const blinkScale = Math.max(0.05, 1 - blinkRef.current * 0.95);
      const eyeAlpha = active ? 0.85 + amp * 0.15 : 0.5 + glowPulse * 0.2;

      for (const side of [-1, 1]) {
        const ex = cx + side * eyeSpacing;

        // Eye socket shadow
        ctx.fillStyle = 'rgba(0, 10, 20, 0.3)';
        ctx.beginPath();
        ctx.ellipse(ex, eyeY + 1, eyeR * 1.4, eyeR * 1.2 * blinkScale, 0, 0, Math.PI * 2);
        ctx.fill();

        // Outer iris ring
        const irisGrad = ctx.createRadialGradient(ex, eyeY, eyeR * 0.3, ex, eyeY, eyeR * 1.2);
        irisGrad.addColorStop(0, `rgba(62, 207, 207, ${eyeAlpha * 0.6})`);
        irisGrad.addColorStop(0.6, `rgba(30, 160, 180, ${eyeAlpha * 0.3})`);
        irisGrad.addColorStop(1, `rgba(20, 80, 100, ${eyeAlpha * 0.1})`);
        ctx.fillStyle = irisGrad;
        ctx.beginPath();
        ctx.ellipse(ex, eyeY, eyeR * 1.2, eyeR * 1.1 * blinkScale, 0, 0, Math.PI * 2);
        ctx.fill();

        // Pupil glow
        ctx.shadowColor = '#3ecfcf';
        ctx.shadowBlur = active ? 15 + amp * 12 : 8;
        ctx.fillStyle = `rgba(62, 220, 220, ${eyeAlpha})`;
        ctx.beginPath();
        ctx.ellipse(ex, eyeY, eyeR * 0.7, eyeR * 0.65 * blinkScale, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Inner pupil (dark center)
        ctx.fillStyle = `rgba(8, 30, 50, ${0.6 * blinkScale})`;
        ctx.beginPath();
        ctx.ellipse(ex, eyeY, eyeR * 0.25, eyeR * 0.22 * blinkScale, 0, 0, Math.PI * 2);
        ctx.fill();

        // Specular highlights
        ctx.fillStyle = `rgba(255, 255, 255, ${0.45 * blinkScale})`;
        ctx.beginPath();
        ctx.ellipse(ex - eyeR * 0.25, eyeY - eyeR * 0.25, eyeR * 0.18, eyeR * 0.15 * blinkScale, -0.3, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(255, 255, 255, ${0.2 * blinkScale})`;
        ctx.beginPath();
        ctx.ellipse(ex + eyeR * 0.3, eyeY + eyeR * 0.15, eyeR * 0.08, eyeR * 0.06 * blinkScale, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Nose hint ── (very subtle)
      ctx.strokeStyle = `rgba(62, 207, 207, ${active ? 0.05 : 0.025})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy + headR * 0.05);
      ctx.lineTo(cx - headR * 0.03, cy + headR * 0.18);
      ctx.stroke();

      // ── Mouth ──
      const mouthY = cy + headR * 0.35;
      const mouthW = headR * 0.28;
      const mouthOpen = Math.min(1, amp * 5);

      if (mouthOpen > 0.05) {
        // Open mouth — rounded rectangle shape
        const mouthH = 2 + mouthOpen * headR * 0.2;
        const mouthWScale = mouthW * (0.6 + mouthOpen * 0.4);

        // Mouth interior glow
        const mGrad = ctx.createRadialGradient(cx, mouthY, 0, cx, mouthY, Math.max(mouthWScale, mouthH));
        mGrad.addColorStop(0, `rgba(20, 180, 200, ${0.2 + mouthOpen * 0.15})`);
        mGrad.addColorStop(0.7, `rgba(62, 207, 207, ${0.1 + mouthOpen * 0.1})`);
        mGrad.addColorStop(1, `rgba(62, 207, 207, ${0.05})`);
        ctx.fillStyle = mGrad;
        ctx.beginPath();
        ctx.ellipse(cx, mouthY, mouthWScale, mouthH, 0, 0, Math.PI * 2);
        ctx.fill();

        // Mouth outline
        ctx.strokeStyle = `rgba(62, 207, 207, ${0.25 + mouthOpen * 0.25})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(cx, mouthY, mouthWScale, mouthH, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // Closed — slight smile curve
        ctx.strokeStyle = `rgba(62, 207, 207, ${active ? 0.25 : 0.1})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx - mouthW * 0.65, mouthY);
        ctx.bezierCurveTo(
          cx - mouthW * 0.2, mouthY + 4,
          cx + mouthW * 0.2, mouthY + 4,
          cx + mouthW * 0.65, mouthY,
        );
        ctx.stroke();
      }

      // ── Forehead "M" mark ──
      ctx.font = `600 ${headR * 0.18}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgba(62, 207, 207, ${active ? 0.07 : 0.03})`;
      ctx.fillText('M', cx, cy - headR * 0.5);

      // ── Status indicator ──
      const statusY = cy + headR + 30;
      const statusAlpha = active ? 0.9 : 0.35;
      ctx.fillStyle = active ? `rgba(62, 207, 207, ${statusAlpha})` : `rgba(100, 120, 140, ${statusAlpha})`;
      ctx.beginPath();
      ctx.arc(cx - 30, statusY, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(active ? 'Speaking' : 'Listening', cx - 23, statusY);

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(draw);
    };

    animFrameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []); // stable — reads isActive via ref

  useImperativeHandle(ref, () => ({
    sendAudio: (pcm: Uint8Array) => {
      const ctx = ensureAudioCtx();
      if (ctx.state === 'suspended') ctx.resume();

      if (lastRenderStartMsRef.current === 0) {
        lastRenderStartMsRef.current = Date.now();
      }

      // Convert Int16 PCM → Float32
      const samples = pcm.length / 2;
      const audioBuffer = ctx.createBuffer(1, samples, 16000);
      const channel = audioBuffer.getChannelData(0);
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let i = 0; i < samples; i++) {
        channel[i] = view.getInt16(i * 2, true) / 32768;
      }

      // Schedule gapless playback
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainRef.current!);

      const now = ctx.currentTime;
      if (nextPlayTimeRef.current < now) {
        nextPlayTimeRef.current = now; // catch up if we fell behind
      }
      source.start(nextPlayTimeRef.current);
      nextPlayTimeRef.current += audioBuffer.duration;

      // Track for barge-in cleanup
      activeSourcesRef.current.add(source);
      source.onended = () => activeSourcesRef.current.delete(source);
    },

    flushAudio: () => {
      // No rechunking — nothing to flush
    },

    getLastRenderStartMs: () => lastRenderStartMsRef.current,
    getLipSyncSamples: () => [], // no server-rendered frames to measure drift against

    resetStats: () => {
      lastRenderStartMsRef.current = 0;
    },

    resetForInteraction: () => {
      lastRenderStartMsRef.current = 0;
      amplitudeRef.current = 0;
      nextPlayTimeRef.current = 0;
      // Stop all playing/scheduled audio (barge-in)
      for (const src of activeSourcesRef.current) {
        try { src.stop(); } catch { /* already stopped */ }
      }
      activeSourcesRef.current.clear();
    },

    unlockAudio: () => {
      const ctx = ensureAudioCtx();
      ctx.resume().catch(() => {});
    },

    getRemainingPlayMs: () => {
      if (!audioCtxRef.current) return 0;
      const remaining = nextPlayTimeRef.current - audioCtxRef.current.currentTime;
      return Math.max(0, Math.round(remaining * 1000));
    },
  }), [ensureAudioCtx]);

  return (
    <div style={{
      position: 'relative',
      borderRadius: 16,
      overflow: 'hidden',
      border: '1px solid rgba(62, 207, 207, 0.12)',
      background: 'var(--mirra-midnight)',
      height: 420,
      flexShrink: 0,
    }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
});

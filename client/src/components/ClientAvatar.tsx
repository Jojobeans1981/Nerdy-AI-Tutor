/**
 * Client-side cartoon avatar — polished AI tutor character rendered on Canvas 2D.
 *
 * Features:
 * - Cartoon-style face with proper shading, eyebrows, detailed eyes, visible body
 * - Audio-reactive mouth, eye glow, breathing, ambient particles
 * - Web Audio API playback (AudioBufferSourceNode → GainNode → AnalyserNode → destination)
 * - AnalyserNode provides RMS amplitude for animation
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
  getRemainingPlayMs: () => number;
  resetPlaybackClock: () => void;
}

interface Props {
  isActive: boolean;
  onReady?: (ms: number) => void;
}

// ── Drawing helpers ──

/** Draw a rounded rectangle path */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Draw one detailed cartoon eye */
function drawEye(
  ctx: CanvasRenderingContext2D,
  ex: number, ey: number, size: number,
  blinkScale: number, active: boolean, amp: number, glowPulse: number,
) {
  const sw = size * 1.25;  // sclera width (bigger = cuter)
  const sh = size * 1.05;  // sclera height

  // Eyelid shadow
  ctx.fillStyle = 'rgba(30, 60, 100, 0.2)';
  ctx.beginPath();
  ctx.ellipse(ex, ey - 1, sw + 2, (sh + 2) * blinkScale, 0, 0, Math.PI * 2);
  ctx.fill();

  // Eyelashes (cute feminine touch) — drawn on top half of eye
  if (blinkScale > 0.3) {
    ctx.strokeStyle = 'rgba(20, 50, 70, 0.5)';
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    // Top lash — three lashes fanning out
    for (let l = 0; l < 3; l++) {
      const angle = -0.6 + l * 0.6; // fan from -0.6 to 0.6 radians
      const lx = ex + Math.cos(angle - Math.PI / 2) * sw * 0.85;
      const ly = ey - sh * blinkScale * 0.85 + Math.sin(angle - Math.PI / 2) * sh * 0.1;
      const tipX = lx + Math.cos(angle - Math.PI / 2 - 0.3) * size * 0.22;
      const tipY = ly + Math.sin(angle - Math.PI / 2 - 0.3) * size * 0.22;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
    }
  }

  // Sclera (white of eye)
  const scleraGrad = ctx.createRadialGradient(ex - sw * 0.15, ey - sh * 0.15, 0, ex, ey, sw);
  scleraGrad.addColorStop(0, '#ffffff');
  scleraGrad.addColorStop(0.7, '#e8eef5');
  scleraGrad.addColorStop(1, '#c5d0de');
  ctx.fillStyle = scleraGrad;
  ctx.beginPath();
  ctx.ellipse(ex, ey, sw, sh * blinkScale, 0, 0, Math.PI * 2);
  ctx.fill();

  // Sclera border
  ctx.strokeStyle = 'rgba(40, 70, 110, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(ex, ey, sw, sh * blinkScale, 0, 0, Math.PI * 2);
  ctx.stroke();

  if (blinkScale < 0.2) return; // fully blinked — skip iris/pupil

  // Iris (large for cute anime-style look)
  const irisR = size * 0.62;
  const irisGrad = ctx.createRadialGradient(ex, ey - irisR * 0.2, irisR * 0.15, ex, ey, irisR);
  irisGrad.addColorStop(0, '#5ef5f5');
  irisGrad.addColorStop(0.4, '#3ecfcf');
  irisGrad.addColorStop(0.75, '#1a9090');
  irisGrad.addColorStop(1, '#0d5555');
  ctx.fillStyle = irisGrad;
  ctx.beginPath();
  ctx.arc(ex, ey, irisR * Math.min(1, blinkScale * 1.3), 0, Math.PI * 2);
  ctx.fill();

  // Iris detail ring
  ctx.strokeStyle = 'rgba(62, 207, 207, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.arc(ex, ey, irisR * 0.7, 0, Math.PI * 2);
  ctx.stroke();

  // Pupil (bigger = cuter)
  const pupilR = size * 0.25 * (active ? 1 + amp * 0.15 : 1);
  ctx.fillStyle = '#051015';
  ctx.beginPath();
  ctx.arc(ex, ey, pupilR, 0, Math.PI * 2);
  ctx.fill();

  // Eye glow (behind specular)
  if (active) {
    ctx.shadowColor = '#3ecfcf';
    ctx.shadowBlur = 8 + amp * 12;
    ctx.fillStyle = `rgba(62, 207, 207, ${0.05 + amp * 0.1})`;
    ctx.beginPath();
    ctx.arc(ex, ey, irisR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Specular highlight (large — anime sparkle)
  ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * blinkScale})`;
  ctx.beginPath();
  ctx.ellipse(ex - size * 0.18, ey - size * 0.2, size * 0.2, size * 0.16, -0.3, 0, Math.PI * 2);
  ctx.fill();

  // Specular highlight (small)
  ctx.fillStyle = `rgba(255, 255, 255, ${0.5 * blinkScale})`;
  ctx.beginPath();
  ctx.ellipse(ex + size * 0.15, ey + size * 0.12, size * 0.09, size * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();

  // Third tiny sparkle (extra cute)
  ctx.fillStyle = `rgba(255, 255, 255, ${0.3 * blinkScale})`;
  ctx.beginPath();
  ctx.arc(ex - size * 0.05, ey + size * 0.18, size * 0.035, 0, Math.PI * 2);
  ctx.fill();
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
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const amplitudeRef = useRef(0);
  // Smoothed mouth shape parameters (driven by frequency bands)
  const jawOpenRef = useRef(0);      // vertical opening — low freq energy
  const mouthWidthRef = useRef(0);   // horizontal spread — mid freq energy ("ee", "ae")
  const lipRoundRef = useRef(0);     // roundness — low present but mid absent ("oo", "oh")
  const consonantRef = useRef(0);    // high-freq energy — tight/thin mouth ("s", "t", "f")
  const blinkRef = useRef(0);
  const nextBlinkRef = useRef(Date.now() + 2000 + Math.random() * 3000);
  const glowPhaseRef = useRef(0);
  const frameCountRef = useRef(0);
  const onReadyRef = useRef(onReady);

  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);

  const ensureAudioCtx = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      const ctx = new AudioContext({ sampleRate: 16000 });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.25;
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

  // ── Main render loop ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const readyMs = Date.now() - mountTimeRef.current;
    onReadyRef.current?.(readyMs);

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(rect.width * dpr);
      const ph = Math.round(rect.height * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }

      const ctx = canvas.getContext('2d')!;
      ctx.save();
      ctx.scale(dpr, dpr);

      const w = rect.width;
      const h = rect.height;
      const cx = w / 2;
      const frame = frameCountRef.current++;

      // ── Read amplitude + frequency bands for mouth shapes ──
      let rawAmp = 0;
      let bandLow = 0, bandMid = 0, bandHigh = 0;
      if (analyserRef.current) {
        // RMS amplitude from time-domain data
        const data = new Uint8Array(analyserRef.current.fftSize);
        analyserRef.current.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        rawAmp = Math.sqrt(sum / data.length);

        // Frequency band analysis for viseme-like mouth shapes
        // fftSize=256 → 128 bins, sampleRate=16000 → bin width ≈ 62.5 Hz
        // Band 0-5   (0-312 Hz):    fundamental voice frequency → jaw drop
        // Band 5-16  (312-1000 Hz): vowel formants → mouth width ("ee"/"ae" vs "oo")
        // Band 16-50 (1000-3125 Hz): consonant energy → lip tension ("s", "t", "f")
        const freq = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(freq);
        let lowSum = 0, midSum = 0, highSum = 0;
        for (let i = 0; i < 5; i++) lowSum += freq[i];
        for (let i = 5; i < 16; i++) midSum += freq[i];
        for (let i = 16; i < 50; i++) highSum += freq[i];
        bandLow = lowSum / (5 * 255);
        bandMid = midSum / (11 * 255);
        bandHigh = highSum / (34 * 255);
      }
      // Smooth overall amplitude — fast attack, medium release for snappy close
      const spd = rawAmp > amplitudeRef.current ? 0.45 : 0.3;
      amplitudeRef.current += (rawAmp - amplitudeRef.current) * spd;
      const amp = amplitudeRef.current;

      // Smooth a value toward target with asymmetric attack/release
      const sm = (ref: React.RefObject<number>, target: number, attack: number, release: number) => {
        const s = target > ref.current ? attack : release;
        ref.current += (target - ref.current) * s;
        return ref.current;
      };

      // Amplitude gates everything — mouth fully closes when audio is quiet.
      // Frequency RATIOS determine shape only when amplitude is present.
      const clampedAmp = Math.min(1, Math.max(0, (amp - 0.025) * 5));
      // Non-linear curve: emphasize small openings, compress large ones (less puppet-like)
      const shapedAmp = Math.pow(clampedAmp, 0.75);

      // Frequency ratios (only meaningful when there's signal)
      const totalEnergy = bandLow + bandMid + bandHigh + 0.001;
      const lowRatio = bandLow / totalEnergy;
      const midRatio = bandMid / totalEnergy;
      const highRatio = bandHigh / totalEnergy;

      // Micro-jitter: tiny random variation per frame for organic feel
      const jitter = 1 + (Math.random() - 0.5) * 0.06;

      // jawOpen: amplitude drives opening, frequency modulates range
      const jawOpen = sm(jawOpenRef, shapedAmp * (0.65 + lowRatio * 0.35) * jitter, 0.55, 0.6);
      // mouthWidth: mid-dominant = wide ("ee"), low-dominant = narrow ("oo")
      const mouthWidth = sm(mouthWidthRef, shapedAmp * midRatio * 1.6, 0.45, 0.5);
      // lipRound: low dominant with weak mid = pursed ("oo", "oh")
      const lipRound = sm(lipRoundRef, shapedAmp * Math.max(0, lowRatio - midRatio) * 1.8, 0.35, 0.5);
      // consonant: high-freq dominant = thin/tight ("s", "t")
      const consonant = sm(consonantRef, shapedAmp * highRatio * 1.8, 0.5, 0.55);

      // Blink
      const now = Date.now();
      if (now >= nextBlinkRef.current && blinkRef.current === 0) {
        blinkRef.current = 1;
        setTimeout(() => { blinkRef.current = 0; }, 130);
        nextBlinkRef.current = now + 2500 + Math.random() * 4000;
      }
      const blinkScale = Math.max(0.05, 1 - blinkRef.current * 0.95);

      glowPhaseRef.current += 0.015;
      const glowPulse = 0.5 + 0.5 * Math.sin(glowPhaseRef.current);
      const breathe = 1 + 0.005 * Math.sin(frame * 0.03);
      const active = isActiveRef.current;

      // ── Scaling ──
      // Design space: 400×420 centered. Scale to fit container.
      const scale = Math.min(w / 400, h / 420) * breathe;
      const ox = cx; // origin x = center
      const oy = h * 0.48; // origin y = slightly above center

      ctx.clearRect(0, 0, w, h);

      // ── Background ──
      const bgGrad = ctx.createRadialGradient(cx, oy - 20, 0, cx, oy, h * 0.85);
      bgGrad.addColorStop(0, '#0c1a2e');
      bgGrad.addColorStop(0.5, '#071222');
      bgGrad.addColorStop(1, '#030a14');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // ── Ambient particles ──
      for (let i = 0; i < 20; i++) {
        const t = frame * 0.001 + i * 1.37;
        const px = cx + Math.sin(t * 0.7 + i) * w * 0.4;
        const py = oy + Math.cos(t * 0.5 + i * 0.8) * h * 0.35;
        const pr = 1 + (i % 3) * 0.8;
        const pa = (0.08 + 0.06 * Math.sin(t * 2)) * (active ? 1 + amp : 1);
        ctx.fillStyle = `rgba(62, 207, 207, ${pa})`;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Character shadow on background ──
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.beginPath();
      ctx.ellipse(ox, oy + 145 * scale, 65 * scale, 12 * scale, 0, 0, Math.PI * 2);
      ctx.fill();

      // ── Body — button-down shirt with shoulders ──
      const torsoTop = oy + 68 * scale;
      const shoulderW = 105 * scale; // wide shoulders
      const torsoH = 90 * scale;

      // Shoulders (curved, wider than torso)
      const shirtGrad = ctx.createLinearGradient(ox, torsoTop, ox, torsoTop + torsoH);
      shirtGrad.addColorStop(0, '#1a3050');
      shirtGrad.addColorStop(0.3, '#152845');
      shirtGrad.addColorStop(0.7, '#10203a');
      shirtGrad.addColorStop(1, '#0b1830');
      ctx.fillStyle = shirtGrad;
      ctx.beginPath();
      // Left shoulder curve
      ctx.moveTo(ox - shoulderW, torsoTop + 25 * scale);
      ctx.quadraticCurveTo(ox - shoulderW, torsoTop + 5 * scale, ox - 55 * scale, torsoTop);
      // Neckline left
      ctx.lineTo(ox - 20 * scale, torsoTop - 5 * scale);
      // Neckline dip (V-neck shape for collar)
      ctx.lineTo(ox, torsoTop + 18 * scale);
      // Neckline right
      ctx.lineTo(ox + 20 * scale, torsoTop - 5 * scale);
      ctx.lineTo(ox + 55 * scale, torsoTop);
      // Right shoulder curve
      ctx.quadraticCurveTo(ox + shoulderW, torsoTop + 5 * scale, ox + shoulderW, torsoTop + 25 * scale);
      // Torso sides
      ctx.lineTo(ox + shoulderW - 5 * scale, torsoTop + torsoH);
      ctx.lineTo(ox - shoulderW + 5 * scale, torsoTop + torsoH);
      ctx.closePath();
      ctx.fill();

      // Shirt fold shadow (left side)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
      ctx.beginPath();
      ctx.moveTo(ox - 5 * scale, torsoTop + 18 * scale);
      ctx.quadraticCurveTo(ox - 15 * scale, torsoTop + 45 * scale, ox - 10 * scale, torsoTop + torsoH);
      ctx.lineTo(ox - shoulderW + 5 * scale, torsoTop + torsoH);
      ctx.lineTo(ox - shoulderW, torsoTop + 25 * scale);
      ctx.quadraticCurveTo(ox - shoulderW, torsoTop + 10 * scale, ox - 55 * scale, torsoTop);
      ctx.lineTo(ox - 20 * scale, torsoTop - 5 * scale);
      ctx.closePath();
      ctx.fill();

      // Shirt highlight (right shoulder)
      ctx.fillStyle = 'rgba(100, 160, 200, 0.04)';
      ctx.beginPath();
      ctx.moveTo(ox + 30 * scale, torsoTop);
      ctx.quadraticCurveTo(ox + shoulderW, torsoTop + 5 * scale, ox + shoulderW, torsoTop + 25 * scale);
      ctx.lineTo(ox + shoulderW - 5 * scale, torsoTop + 40 * scale);
      ctx.quadraticCurveTo(ox + 50 * scale, torsoTop + 15 * scale, ox + 30 * scale, torsoTop);
      ctx.closePath();
      ctx.fill();

      // Collar — folded shirt collar
      ctx.fillStyle = '#1e3555';
      // Left collar flap
      ctx.beginPath();
      ctx.moveTo(ox - 20 * scale, torsoTop - 5 * scale);
      ctx.lineTo(ox - 35 * scale, torsoTop - 2 * scale);
      ctx.lineTo(ox - 30 * scale, torsoTop + 12 * scale);
      ctx.lineTo(ox - 8 * scale, torsoTop + 10 * scale);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(62, 207, 207, 0.1)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      // Right collar flap
      ctx.fillStyle = '#1e3555';
      ctx.beginPath();
      ctx.moveTo(ox + 20 * scale, torsoTop - 5 * scale);
      ctx.lineTo(ox + 35 * scale, torsoTop - 2 * scale);
      ctx.lineTo(ox + 30 * scale, torsoTop + 12 * scale);
      ctx.lineTo(ox + 8 * scale, torsoTop + 10 * scale);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Button placket (center line)
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ox, torsoTop + 18 * scale);
      ctx.lineTo(ox, torsoTop + torsoH);
      ctx.stroke();

      // Buttons (3)
      for (let b = 0; b < 3; b++) {
        const by = torsoTop + (28 + b * 20) * scale;
        const br = 2.5 * scale;
        // Button body
        ctx.fillStyle = '#0e1e35';
        ctx.strokeStyle = 'rgba(62, 207, 207, 0.15)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(ox, by, br, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Button holes (two tiny dots)
        ctx.fillStyle = 'rgba(62, 207, 207, 0.12)';
        ctx.beginPath();
        ctx.arc(ox - 1 * scale, by, 0.6 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ox + 1 * scale, by, 0.6 * scale, 0, Math.PI * 2);
        ctx.fill();
      }

      // Collar gem/pin (at V of neckline)
      ctx.fillStyle = `rgba(62, 207, 207, ${active ? 0.6 + amp * 0.3 : 0.2 + glowPulse * 0.1})`;
      ctx.shadowColor = '#3ecfcf';
      ctx.shadowBlur = active ? 6 + amp * 8 : 3;
      ctx.beginPath();
      // Diamond shape
      ctx.moveTo(ox, torsoTop + 14 * scale);
      ctx.lineTo(ox + 4 * scale, torsoTop + 18 * scale);
      ctx.lineTo(ox, torsoTop + 22 * scale);
      ctx.lineTo(ox - 4 * scale, torsoTop + 18 * scale);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;

      // ── Neck ──
      const neckW = 22 * scale;
      const neckH = 16 * scale;
      const neckGrad = ctx.createLinearGradient(ox - neckW, oy + 52 * scale, ox + neckW, oy + 52 * scale);
      neckGrad.addColorStop(0, '#3a7080');
      neckGrad.addColorStop(0.5, '#4a9098');
      neckGrad.addColorStop(1, '#3a7080');
      ctx.fillStyle = neckGrad;
      ctx.beginPath();
      ctx.moveTo(ox - neckW, oy + 52 * scale);
      ctx.quadraticCurveTo(ox - neckW * 0.6, oy + 52 * scale + neckH + 2 * scale, ox, oy + 52 * scale + neckH);
      ctx.quadraticCurveTo(ox + neckW * 0.6, oy + 52 * scale + neckH + 2 * scale, ox + neckW, oy + 52 * scale);
      ctx.closePath();
      ctx.fill();
      // Neck shadow under chin
      ctx.fillStyle = 'rgba(0, 20, 30, 0.2)';
      ctx.beginPath();
      ctx.ellipse(ox, oy + 53 * scale, neckW * 0.9, 4 * scale, 0, 0, Math.PI);
      ctx.fill();

      // ── Head ──
      const headW = 72 * scale;
      const headH = 82 * scale;
      const headCy = oy - 5 * scale;

      // ── Back hair (drawn before head so it appears behind) ──
      const backHairGrad = ctx.createLinearGradient(ox, headCy - headH * 0.7, ox, torsoTop + torsoH * 0.8);
      backHairGrad.addColorStop(0, '#1a5858');
      backHairGrad.addColorStop(0.4, '#155050');
      backHairGrad.addColorStop(0.8, '#104545');
      backHairGrad.addColorStop(1, '#0d3838');

      // Left side long hair (drapes past shoulder)
      ctx.fillStyle = backHairGrad;
      ctx.beginPath();
      ctx.moveTo(ox - headW * 0.55, headCy - headH * 0.5);
      ctx.quadraticCurveTo(ox - headW * 1.15, headCy - headH * 0.1, ox - headW * 1.1, headCy + headH * 0.3);
      ctx.quadraticCurveTo(ox - headW * 1.05, headCy + headH * 0.8, ox - shoulderW * 0.7, torsoTop + torsoH * 0.7);
      ctx.quadraticCurveTo(ox - shoulderW * 0.55, torsoTop + torsoH * 0.5, ox - headW * 0.85, headCy + headH * 0.2);
      ctx.quadraticCurveTo(ox - headW * 0.8, headCy - headH * 0.1, ox - headW * 0.4, headCy - headH * 0.45);
      ctx.closePath();
      ctx.fill();

      // Right side long hair (drapes past shoulder)
      ctx.fillStyle = backHairGrad;
      ctx.beginPath();
      ctx.moveTo(ox + headW * 0.55, headCy - headH * 0.5);
      ctx.quadraticCurveTo(ox + headW * 1.15, headCy - headH * 0.1, ox + headW * 1.1, headCy + headH * 0.3);
      ctx.quadraticCurveTo(ox + headW * 1.05, headCy + headH * 0.8, ox + shoulderW * 0.7, torsoTop + torsoH * 0.7);
      ctx.quadraticCurveTo(ox + shoulderW * 0.55, torsoTop + torsoH * 0.5, ox + headW * 0.85, headCy + headH * 0.2);
      ctx.quadraticCurveTo(ox + headW * 0.8, headCy - headH * 0.1, ox + headW * 0.4, headCy - headH * 0.45);
      ctx.closePath();
      ctx.fill();

      // Hair strand highlights (left side)
      ctx.strokeStyle = 'rgba(100, 210, 210, 0.08)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ox - headW * 0.7, headCy - headH * 0.2);
      ctx.quadraticCurveTo(ox - headW * 0.95, headCy + headH * 0.3, ox - shoulderW * 0.6, torsoTop + torsoH * 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ox - headW * 0.55, headCy - headH * 0.3);
      ctx.quadraticCurveTo(ox - headW * 0.85, headCy + headH * 0.2, ox - shoulderW * 0.65, torsoTop + torsoH * 0.4);
      ctx.stroke();

      // Hair strand highlights (right side)
      ctx.beginPath();
      ctx.moveTo(ox + headW * 0.7, headCy - headH * 0.2);
      ctx.quadraticCurveTo(ox + headW * 0.95, headCy + headH * 0.3, ox + shoulderW * 0.6, torsoTop + torsoH * 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ox + headW * 0.55, headCy - headH * 0.3);
      ctx.quadraticCurveTo(ox + headW * 0.85, headCy + headH * 0.2, ox + shoulderW * 0.65, torsoTop + torsoH * 0.4);
      ctx.stroke();

      // Head outer glow
      const hGlowAlpha = active ? 0.06 + amp * 0.12 : 0.02 + glowPulse * 0.01;
      ctx.fillStyle = `rgba(62, 207, 207, ${hGlowAlpha})`;
      ctx.shadowColor = '#3ecfcf';
      ctx.shadowBlur = active ? 30 + amp * 20 : 15;
      ctx.beginPath();
      ctx.ellipse(ox, headCy, headW + 10 * scale, headH + 10 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Head shape — slightly rounded rectangle (more face-like)
      const headGrad = ctx.createRadialGradient(
        ox - headW * 0.2, headCy - headH * 0.25, 0,
        ox, headCy, headH,
      );
      headGrad.addColorStop(0, '#6ec4c4');
      headGrad.addColorStop(0.35, '#4aa0a0');
      headGrad.addColorStop(0.7, '#358585');
      headGrad.addColorStop(1, '#1f6060');

      ctx.fillStyle = headGrad;
      ctx.beginPath();
      // Rounder face shape — softer chin for cuter proportions
      const fhW = headW; // forehead width
      const chW = headW * 0.72; // narrower chin = cuter
      ctx.moveTo(ox - fhW * 0.6, headCy - headH * 0.55); // top-left start
      ctx.quadraticCurveTo(ox, headCy - headH * 0.7, ox + fhW * 0.6, headCy - headH * 0.55); // forehead curve
      ctx.quadraticCurveTo(ox + fhW, headCy - headH * 0.2, ox + fhW, headCy + headH * 0.05); // right temple
      ctx.quadraticCurveTo(ox + chW, headCy + headH * 0.5, ox, headCy + headH * 0.6); // right jaw to chin
      ctx.quadraticCurveTo(ox - chW, headCy + headH * 0.5, ox - fhW, headCy + headH * 0.05); // left jaw
      ctx.quadraticCurveTo(ox - fhW, headCy - headH * 0.2, ox - fhW * 0.6, headCy - headH * 0.55); // left temple
      ctx.closePath();
      ctx.fill();

      // Face highlight (forehead sheen)
      const sheenGrad = ctx.createRadialGradient(
        ox - headW * 0.1, headCy - headH * 0.35, 0,
        ox, headCy - headH * 0.2, headW * 0.6,
      );
      sheenGrad.addColorStop(0, 'rgba(140, 230, 230, 0.12)');
      sheenGrad.addColorStop(1, 'rgba(140, 230, 230, 0)');
      ctx.fillStyle = sheenGrad;
      ctx.beginPath();
      ctx.ellipse(ox - headW * 0.1, headCy - headH * 0.3, headW * 0.5, headH * 0.25, -0.1, 0, Math.PI * 2);
      ctx.fill();

      // ── Eyebrows (softer, thinner — cuter) ──
      const browY = headCy - headH * 0.22;
      const browLift = active ? amp * 3 : 0;
      ctx.strokeStyle = 'rgba(26, 69, 69, 0.6)';
      ctx.lineWidth = 1.8 * scale;
      ctx.lineCap = 'round';
      // Left eyebrow — gentle arch
      ctx.beginPath();
      ctx.moveTo(ox - 35 * scale, browY + 1 * scale - browLift);
      ctx.quadraticCurveTo(ox - 26 * scale, browY - 6 * scale - browLift, ox - 16 * scale, browY - 1 * scale - browLift);
      ctx.stroke();
      // Right eyebrow
      ctx.beginPath();
      ctx.moveTo(ox + 16 * scale, browY - 1 * scale - browLift);
      ctx.quadraticCurveTo(ox + 26 * scale, browY - 6 * scale - browLift, ox + 35 * scale, browY + 1 * scale - browLift);
      ctx.stroke();

      // ── Eyes (bigger = cuter) ──
      const eyeSpacing = 28 * scale;
      const eyeY = headCy - headH * 0.03;
      const eyeSize = 19 * scale;
      drawEye(ctx, ox - eyeSpacing, eyeY, eyeSize, blinkScale, active, amp, glowPulse);
      drawEye(ctx, ox + eyeSpacing, eyeY, eyeSize, blinkScale, active, amp, glowPulse);

      // ── Nose (tiny dot — cute/minimal) ──
      ctx.fillStyle = 'rgba(30, 75, 75, 0.2)';
      ctx.beginPath();
      ctx.ellipse(ox, headCy + headH * 0.18, 2.5 * scale, 1.8 * scale, 0, 0, Math.PI * 2);
      ctx.fill();

      // ── Mouth (viseme-driven) ──
      // jawOpen  → vertical opening (low freq — fundamental)
      // mouthWidth → horizontal spread (mid freq — "ee"/"ae" wide, "oo" narrow)
      // lipRound → pursed/round shape (low present, mid absent — "oo"/"oh")
      // consonant → tight/thin (high freq — "s"/"t"/"f")
      const mouthY = headCy + headH * 0.34;
      const isSpeaking = amp > 0.025;

      if (isSpeaking) {
        // Derive mouth dimensions from frequency bands
        const baseW = 12 * scale;
        const mw = baseW + mouthWidth * 10 * scale - lipRound * 6 * scale - consonant * 4 * scale;
        // Jaw opening drives height — capped lower to avoid over-stretch
        const mh = (1.5 + jawOpen * 9) * scale;
        // Mouth center shifts down slightly when jaw opens wide
        const my = mouthY + jawOpen * 3 * scale;

        // Upper lip shape (bezier — flatter for consonants, arched for vowels)
        const upperArch = (1 - consonant * 0.6) * mh * 0.3;
        // Lower lip drops more with jaw
        const lowerDrop = mh * (0.7 + jawOpen * 0.3);

        // Mouth interior (dark cavity)
        ctx.fillStyle = '#081818';
        ctx.beginPath();
        ctx.moveTo(ox - mw, my);
        // Upper lip contour
        ctx.bezierCurveTo(
          ox - mw * 0.5, my - upperArch,
          ox + mw * 0.5, my - upperArch,
          ox + mw, my,
        );
        // Lower lip contour
        ctx.bezierCurveTo(
          ox + mw * 0.6, my + lowerDrop,
          ox - mw * 0.6, my + lowerDrop,
          ox - mw, my,
        );
        ctx.closePath();
        ctx.fill();

        // Tongue hint (visible when jaw is open wide)
        if (jawOpen > 0.4) {
          ctx.fillStyle = `rgba(60, 120, 120, ${jawOpen * 0.4})`;
          ctx.beginPath();
          ctx.ellipse(ox, my + lowerDrop * 0.55, mw * 0.45, lowerDrop * 0.2, 0, 0, Math.PI * 2);
          ctx.fill();
        }

        // Teeth (top row — visible when mouth opens enough)
        if (jawOpen > 0.15) {
          const teethAlpha = Math.min(0.7, jawOpen * 0.9);
          ctx.fillStyle = `rgba(220, 235, 240, ${teethAlpha})`;
          ctx.beginPath();
          ctx.moveTo(ox - mw * 0.7, my + 0.5 * scale);
          ctx.bezierCurveTo(
            ox - mw * 0.3, my - upperArch * 0.5,
            ox + mw * 0.3, my - upperArch * 0.5,
            ox + mw * 0.7, my + 0.5 * scale,
          );
          ctx.lineTo(ox + mw * 0.7, my + mh * 0.22);
          ctx.lineTo(ox - mw * 0.7, my + mh * 0.22);
          ctx.closePath();
          ctx.fill();

          // Tooth separators
          ctx.strokeStyle = `rgba(180, 200, 210, ${teethAlpha * 0.3})`;
          ctx.lineWidth = 0.5;
          const teethCount = 5;
          for (let t = 1; t < teethCount; t++) {
            const tx = ox - mw * 0.6 + (t / teethCount) * mw * 1.2;
            ctx.beginPath();
            ctx.moveTo(tx, my + 1 * scale);
            ctx.lineTo(tx, my + mh * 0.2);
            ctx.stroke();
          }
        }

        // Lower teeth hint (barely visible)
        if (jawOpen > 0.5) {
          ctx.fillStyle = `rgba(200, 215, 225, ${(jawOpen - 0.5) * 0.4})`;
          ctx.beginPath();
          const btY = my + lowerDrop - mh * 0.15;
          ctx.moveTo(ox - mw * 0.5, btY);
          ctx.lineTo(ox + mw * 0.5, btY);
          ctx.lineTo(ox + mw * 0.5, btY - mh * 0.12);
          ctx.lineTo(ox - mw * 0.5, btY - mh * 0.12);
          ctx.closePath();
          ctx.fill();
        }

        // Lip outline — upper lip
        ctx.strokeStyle = '#1a5555';
        ctx.lineWidth = 1.8 * scale;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(ox - mw, my);
        ctx.bezierCurveTo(
          ox - mw * 0.5, my - upperArch,
          ox + mw * 0.5, my - upperArch,
          ox + mw, my,
        );
        ctx.stroke();

        // Lip outline — lower lip (slightly thicker)
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.moveTo(ox - mw, my);
        ctx.bezierCurveTo(
          ox - mw * 0.6, my + lowerDrop,
          ox + mw * 0.6, my + lowerDrop,
          ox + mw, my,
        );
        ctx.stroke();

        // Lip corners (small dark accents)
        ctx.fillStyle = 'rgba(20, 60, 60, 0.4)';
        ctx.beginPath();
        ctx.arc(ox - mw, my, 1.2 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ox + mw, my, 1.2 * scale, 0, Math.PI * 2);
        ctx.fill();

        // Upper lip highlight (Cupid's bow)
        ctx.strokeStyle = `rgba(100, 200, 200, 0.15)`;
        ctx.lineWidth = 0.8 * scale;
        ctx.beginPath();
        ctx.moveTo(ox - mw * 0.3, my - upperArch * 0.6);
        ctx.quadraticCurveTo(ox, my - upperArch * 0.9, ox + mw * 0.3, my - upperArch * 0.6);
        ctx.stroke();

        // Lower lip sheen
        ctx.fillStyle = `rgba(80, 180, 180, 0.06)`;
        ctx.beginPath();
        ctx.ellipse(ox, my + lowerDrop * 0.65, mw * 0.4, lowerDrop * 0.15, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Closed mouth — cute happy smile (wider, more curved)
        ctx.strokeStyle = '#1a5050';
        ctx.lineWidth = 2 * scale;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(ox - 12 * scale, mouthY - 1 * scale);
        ctx.bezierCurveTo(
          ox - 5 * scale, mouthY + 7 * scale,
          ox + 5 * scale, mouthY + 7 * scale,
          ox + 12 * scale, mouthY - 1 * scale,
        );
        ctx.stroke();

        // Cute smile dimples
        ctx.fillStyle = 'rgba(26, 80, 80, 0.15)';
        ctx.beginPath();
        ctx.arc(ox - 13 * scale, mouthY, 1 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ox + 13 * scale, mouthY, 1 * scale, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Cheek blush (bigger, warmer pink — cute!) ──
      const cheekAlpha = active ? 0.12 + amp * 0.1 : 0.08 + glowPulse * 0.02;
      // Warm pink-coral tint instead of teal
      ctx.fillStyle = `rgba(255, 140, 160, ${cheekAlpha})`;
      ctx.beginPath();
      ctx.ellipse(ox - 42 * scale, headCy + headH * 0.18, 13 * scale, 8 * scale, -0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(ox + 42 * scale, headCy + headH * 0.18, 13 * scale, 8 * scale, 0.1, 0, Math.PI * 2);
      ctx.fill();

      // ── Hair top (bangs/fringe — drawn on top of head) ──
      ctx.fillStyle = '#1a5858';
      ctx.beginPath();
      ctx.moveTo(ox - headW * 0.7, headCy - headH * 0.48);
      ctx.quadraticCurveTo(ox - headW * 0.3, headCy - headH * 0.85, ox, headCy - headH * 0.72);
      ctx.quadraticCurveTo(ox + headW * 0.3, headCy - headH * 0.85, ox + headW * 0.7, headCy - headH * 0.48);
      ctx.quadraticCurveTo(ox + headW * 0.5, headCy - headH * 0.55, ox, headCy - headH * 0.58);
      ctx.quadraticCurveTo(ox - headW * 0.5, headCy - headH * 0.55, ox - headW * 0.7, headCy - headH * 0.48);
      ctx.closePath();
      ctx.fill();

      // Side-swept bangs
      ctx.fillStyle = '#1a5050';
      ctx.beginPath();
      ctx.moveTo(ox - headW * 0.6, headCy - headH * 0.5);
      ctx.quadraticCurveTo(ox - headW * 0.2, headCy - headH * 0.78, ox + headW * 0.1, headCy - headH * 0.6);
      ctx.quadraticCurveTo(ox - headW * 0.1, headCy - headH * 0.52, ox - headW * 0.4, headCy - headH * 0.48);
      ctx.closePath();
      ctx.fill();

      // Top hair highlight
      ctx.strokeStyle = 'rgba(100, 210, 210, 0.15)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ox - headW * 0.3, headCy - headH * 0.68);
      ctx.quadraticCurveTo(ox, headCy - headH * 0.78, ox + headW * 0.4, headCy - headH * 0.55);
      ctx.stroke();

      // ── Ear accents ──
      // Left ear
      ctx.fillStyle = '#2a7070';
      ctx.beginPath();
      ctx.ellipse(ox - headW - 2 * scale, headCy, 6 * scale, 12 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(62, 207, 207, ${active ? 0.3 + amp * 0.2 : 0.1})`;
      ctx.beginPath();
      ctx.arc(ox - headW - 2 * scale, headCy, 3 * scale, 0, Math.PI * 2);
      ctx.fill();
      // Right ear
      ctx.fillStyle = '#2a7070';
      ctx.beginPath();
      ctx.ellipse(ox + headW + 2 * scale, headCy, 6 * scale, 12 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(62, 207, 207, ${active ? 0.3 + amp * 0.2 : 0.1})`;
      ctx.beginPath();
      ctx.arc(ox + headW + 2 * scale, headCy, 3 * scale, 0, Math.PI * 2);
      ctx.fill();

      // ── Status bar at bottom ──
      const barY = h - 28;
      ctx.fillStyle = active ? '#3ecfcf' : '#334155';
      ctx.beginPath();
      ctx.arc(cx - 28, barY, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(active ? 'Speaking' : 'Listening', cx - 20, barY);

      // ── Audio wave indicator ──
      if (active && analyserRef.current) {
        const freq = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(freq);
        const barCount = 24;
        const barW = 3;
        const barGap = 3;
        const totalW = barCount * (barW + barGap);
        const startX = cx - totalW / 2;
        for (let i = 0; i < barCount; i++) {
          const fi = Math.floor((i / barCount) * freq.length * 0.4);
          const val = (freq[fi] / 255) * amp * 3;
          const bh = Math.max(1, val * 18);
          ctx.fillStyle = `rgba(62, 207, 207, ${0.15 + val * 0.3})`;
          roundRect(ctx, startX + i * (barW + barGap), barY - 18 - bh, barW, bh, 1);
          ctx.fill();
        }
      }

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(draw);
    };

    animFrameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  useImperativeHandle(ref, () => ({
    sendAudio: (pcm: Uint8Array) => {
      const ctx = ensureAudioCtx();
      if (ctx.state === 'suspended') ctx.resume();
      if (lastRenderStartMsRef.current === 0) lastRenderStartMsRef.current = Date.now();

      const samples = pcm.length / 2;
      const audioBuffer = ctx.createBuffer(1, samples, 16000);
      const channel = audioBuffer.getChannelData(0);
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let i = 0; i < samples; i++) {
        channel[i] = view.getInt16(i * 2, true) / 32768;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainRef.current!);

      const now = ctx.currentTime;
      if (nextPlayTimeRef.current < now) nextPlayTimeRef.current = now;
      source.start(nextPlayTimeRef.current);
      nextPlayTimeRef.current += audioBuffer.duration;

      activeSourcesRef.current.add(source);
      source.onended = () => activeSourcesRef.current.delete(source);
    },
    flushAudio: () => {},
    getLastRenderStartMs: () => lastRenderStartMsRef.current,
    getLipSyncSamples: () => [],
    resetStats: () => { lastRenderStartMsRef.current = 0; },
    resetForInteraction: () => {
      lastRenderStartMsRef.current = 0;
      amplitudeRef.current = 0;
      nextPlayTimeRef.current = 0;
      for (const src of activeSourcesRef.current) {
        try { src.stop(); } catch { /* already stopped */ }
      }
      activeSourcesRef.current.clear();
    },
    unlockAudio: () => { ensureAudioCtx().resume().catch(() => {}); },
    getRemainingPlayMs: () => {
      if (!audioCtxRef.current) return 0;
      const remaining = nextPlayTimeRef.current - audioCtxRef.current.currentTime;
      // Cap at 4s to prevent accumulated drift from inflating unmute delays
      return Math.max(0, Math.min(Math.round(remaining * 1000), 4000));
    },
    resetPlaybackClock: () => {
      if (audioCtxRef.current) {
        const was = nextPlayTimeRef.current;
        nextPlayTimeRef.current = audioCtxRef.current.currentTime;
        console.log(`[Avatar] Clock reset. currentTime: ${audioCtxRef.current.currentTime.toFixed(3)}, nextPlay was: ${was.toFixed(3)}`);
      }
    },
  }), [ensureAudioCtx]);

  return (
    <div style={{
      position: 'relative',
      borderRadius: 16,
      overflow: 'hidden',
      border: '1px solid rgba(62, 207, 207, 0.12)',
      background: '#050d18',
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

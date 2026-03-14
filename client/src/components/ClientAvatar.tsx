/**
 * Client-side SVG avatar — friendly AI tutor character with audio-reactive animations.
 *
 * Rendering: Inline SVG with CSS keyframe animations (idle) + rAF loop (amplitude-driven).
 * Audio: Web Audio API (AudioBufferSourceNode → GainNode → AnalyserNode → destination).
 * AnalyserNode provides RMS amplitude for mouth/eye/glow animation.
 */
import { useRef, useEffect, forwardRef, useImperativeHandle, useCallback, useState } from 'react';

export interface ClientAvatarHandle {
  sendAudio: (pcm: Uint8Array) => void;
  flushAudio: () => void;
  getLastRenderStartMs: () => number;
  getLipSyncSamples: () => number[];
  resetStats: () => void;
  resetForInteraction: () => void;
  unlockAudio: () => void;
  getRemainingPlayMs: () => number;
}

interface Props {
  isActive: boolean;
  onReady?: (ms: number) => void;
}

// Unique ID prefix to avoid SVG filter collisions
const FILTER_ID = 'mirra-av';

export const ClientAvatar = forwardRef<ClientAvatarHandle, Props>(({ isActive, onReady }, ref) => {
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
  const blinkRef = useRef(0);
  const nextBlinkRef = useRef(Date.now() + 2000 + Math.random() * 3000);
  const onReadyRef = useRef(onReady);

  // SVG element refs for rAF-driven animation
  const mouthRef = useRef<SVGPathElement>(null);
  const leftPupilRef = useRef<SVGCircleElement>(null);
  const rightPupilRef = useRef<SVGCircleElement>(null);
  const leftIrisRef = useRef<SVGCircleElement>(null);
  const rightIrisRef = useRef<SVGCircleElement>(null);
  const leftEyelidRef = useRef<SVGEllipseElement>(null);
  const rightEyelidRef = useRef<SVGEllipseElement>(null);
  const glowRef = useRef<SVGFEGaussianBlurElement>(null);
  const headGlowRef = useRef<SVGCircleElement>(null);
  const antennaGlowRef = useRef<SVGCircleElement>(null);
  const waveGroupRef = useRef<SVGGElement>(null);
  const statusDotRef = useRef<SVGCircleElement>(null);
  const statusTextRef = useRef<SVGTextElement>(null);
  const cheekLRef = useRef<SVGEllipseElement>(null);
  const cheekRRef = useRef<SVGEllipseElement>(null);

  const [ready, setReady] = useState(false);

  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);

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

  // Fire onReady on mount
  useEffect(() => {
    const readyMs = Date.now() - mountTimeRef.current;
    onReadyRef.current?.(readyMs);
    setReady(true);
  }, []);

  // rAF loop — reads amplitude and updates SVG elements directly (no re-renders)
  useEffect(() => {
    if (!ready) return;

    const loop = () => {
      // Read amplitude
      let rawAmp = 0;
      if (analyserRef.current) {
        const data = new Uint8Array(analyserRef.current.fftSize);
        analyserRef.current.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        rawAmp = Math.sqrt(sum / data.length);
      }
      const spd = rawAmp > amplitudeRef.current ? 0.4 : 0.12;
      amplitudeRef.current += (rawAmp - amplitudeRef.current) * spd;
      const amp = amplitudeRef.current;
      const active = isActiveRef.current;

      // Blink
      const now = Date.now();
      if (now >= nextBlinkRef.current && blinkRef.current === 0) {
        blinkRef.current = 1;
        setTimeout(() => { blinkRef.current = 0; }, 130);
        nextBlinkRef.current = now + 2500 + Math.random() * 4000;
      }
      const blinkScale = Math.max(0.05, 1 - blinkRef.current * 0.95);

      // ── Mouth ──
      const mouthOpen = Math.min(1, amp * 5);
      if (mouthRef.current) {
        if (mouthOpen > 0.04) {
          // Open: elliptical mouth
          const h = 2 + mouthOpen * 14;
          const w = 12 + mouthOpen * 8;
          mouthRef.current.setAttribute('d',
            `M${200 - w},248 Q${200 - w * 0.5},${248 + h} 200,${248 + h} Q${200 + w * 0.5},${248 + h} ${200 + w},248 Q${200 + w * 0.5},${248 - h * 0.3} 200,${248 - h * 0.2} Q${200 - w * 0.5},${248 - h * 0.3} ${200 - w},248 Z`
          );
          mouthRef.current.setAttribute('fill', `rgba(62, 207, 207, ${0.12 + mouthOpen * 0.15})`);
          mouthRef.current.setAttribute('stroke', `rgba(62, 207, 207, ${0.3 + mouthOpen * 0.3})`);
          mouthRef.current.setAttribute('stroke-width', '1.5');
        } else {
          // Closed: gentle smile
          mouthRef.current.setAttribute('d', 'M182,248 Q191,255 200,255 Q209,255 218,248');
          mouthRef.current.setAttribute('fill', 'none');
          mouthRef.current.setAttribute('stroke', `rgba(62, 207, 207, ${active ? 0.3 : 0.15})`);
          mouthRef.current.setAttribute('stroke-width', '2');
        }
      }

      // ── Eyes — pupil + iris pulse ──
      const pupilScale = active ? 1 + amp * 0.3 : 1;
      const irisGlow = active ? 0.7 + amp * 0.3 : 0.4;
      for (const [pupil, iris, eyelid] of [
        [leftPupilRef.current, leftIrisRef.current, leftEyelidRef.current],
        [rightPupilRef.current, rightIrisRef.current, rightEyelidRef.current],
      ] as const) {
        if (pupil) {
          pupil.setAttribute('r', String(5 * pupilScale));
          pupil.setAttribute('opacity', String(irisGlow + 0.2));
        }
        if (iris) {
          iris.setAttribute('opacity', String(irisGlow));
        }
        if (eyelid) {
          eyelid.setAttribute('ry', String(14 * blinkScale));
        }
      }

      // ── Cheek blush on speaking ──
      const cheekAlpha = active ? 0.06 + amp * 0.08 : 0.03;
      if (cheekLRef.current) cheekLRef.current.setAttribute('opacity', String(cheekAlpha));
      if (cheekRRef.current) cheekRRef.current.setAttribute('opacity', String(cheekAlpha));

      // ── Head outer glow ──
      if (headGlowRef.current) {
        const glowOpacity = active ? 0.08 + amp * 0.15 : 0.03;
        headGlowRef.current.setAttribute('opacity', String(glowOpacity));
      }

      // ── Antenna glow ──
      if (antennaGlowRef.current) {
        const aGlow = active ? 0.6 + amp * 0.4 : 0.2;
        antennaGlowRef.current.setAttribute('opacity', String(aGlow));
      }

      // ── Glow filter intensity ──
      if (glowRef.current) {
        const blur = active ? 4 + amp * 6 : 3;
        glowRef.current.setAttribute('stdDeviation', String(blur));
      }

      // ── Audio waveform bars ──
      if (waveGroupRef.current && analyserRef.current) {
        const freq = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(freq);
        const bars = waveGroupRef.current.children;
        const barCount = bars.length;
        for (let i = 0; i < barCount; i++) {
          const fi = Math.floor((i / barCount) * freq.length * 0.5);
          const val = active ? (freq[fi] / 255) * amp * 4 : 0;
          const h = Math.max(1, val * 30);
          const bar = bars[i] as SVGRectElement;
          bar.setAttribute('height', String(h));
          bar.setAttribute('y', String(350 - h));
          bar.setAttribute('opacity', String(active ? 0.15 + val * 0.4 : 0.05));
        }
      }

      // ── Status indicator ──
      if (statusDotRef.current) {
        statusDotRef.current.setAttribute('fill', active ? '#3ecfcf' : '#334155');
      }
      if (statusTextRef.current) {
        statusTextRef.current.textContent = active ? 'Speaking' : 'Listening';
        statusTextRef.current.setAttribute('fill', active ? '#3ecfcf' : '#475569');
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [ready]);

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
      return Math.max(0, Math.round(remaining * 1000));
    },
  }), [ensureAudioCtx]);

  // Build waveform bar elements (static count)
  const WAVE_BARS = 32;
  const barWidth = 6;
  const barGap = 2.5;
  const totalBarW = WAVE_BARS * (barWidth + barGap);
  const barStartX = 200 - totalBarW / 2;

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
      <style>{`
        @keyframes mirra-float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-6px); }
        }
        @keyframes mirra-orbit1 {
          from { transform: rotate(0deg) translateX(130px) rotate(0deg); }
          to   { transform: rotate(360deg) translateX(130px) rotate(-360deg); }
        }
        @keyframes mirra-orbit2 {
          from { transform: rotate(120deg) translateX(140px) rotate(-120deg); }
          to   { transform: rotate(480deg) translateX(140px) rotate(-480deg); }
        }
        @keyframes mirra-orbit3 {
          from { transform: rotate(240deg) translateX(120px) rotate(-240deg); }
          to   { transform: rotate(600deg) translateX(120px) rotate(-600deg); }
        }
        @keyframes mirra-pulse {
          0%, 100% { opacity: 0.15; }
          50% { opacity: 0.35; }
        }
        @keyframes mirra-twinkle {
          0%, 100% { opacity: 0.1; }
          50% { opacity: 0.5; }
        }
        @keyframes mirra-antenna-bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
        .mirra-character { animation: mirra-float 4s ease-in-out infinite; }
        .mirra-orb1 { animation: mirra-orbit1 12s linear infinite; transform-origin: 200px 200px; }
        .mirra-orb2 { animation: mirra-orbit2 16s linear infinite; transform-origin: 200px 200px; }
        .mirra-orb3 { animation: mirra-orbit3 10s linear infinite; transform-origin: 200px 200px; }
        .mirra-ring-pulse { animation: mirra-pulse 3s ease-in-out infinite; }
        .mirra-antenna { animation: mirra-antenna-bob 3s ease-in-out infinite; }
      `}</style>

      <svg
        viewBox="0 0 400 400"
        width="100%"
        height="100%"
        style={{ display: 'block' }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Glow filter */}
          <filter id={`${FILTER_ID}-glow`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur ref={glowRef} in="SourceGraphic" stdDeviation="3" />
          </filter>
          <filter id={`${FILTER_ID}-soft`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="8" />
          </filter>
          <filter id={`${FILTER_ID}-eye-glow`} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Head gradient */}
          <radialGradient id={`${FILTER_ID}-head`} cx="40%" cy="35%" r="60%">
            <stop offset="0%" stopColor="#1a3555" />
            <stop offset="60%" stopColor="#112845" />
            <stop offset="100%" stopColor="#0a1c30" />
          </radialGradient>

          {/* Eye gradient */}
          <radialGradient id={`${FILTER_ID}-iris`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#50e8e8" />
            <stop offset="50%" stopColor="#3ecfcf" />
            <stop offset="100%" stopColor="#1a8a8a" />
          </radialGradient>

          {/* Background gradient */}
          <radialGradient id={`${FILTER_ID}-bg`} cx="50%" cy="45%" r="70%">
            <stop offset="0%" stopColor="#0a1628" />
            <stop offset="60%" stopColor="#060e1a" />
            <stop offset="100%" stopColor="#030810" />
          </radialGradient>
        </defs>

        {/* Background */}
        <rect width="400" height="400" fill={`url(#${FILTER_ID}-bg)`} />

        {/* Stars */}
        {Array.from({ length: 30 }, (_, i) => (
          <circle
            key={`star-${i}`}
            cx={15 + (i * 127) % 370}
            cy={10 + (i * 83 + 50) % 380}
            r={0.5 + (i % 3) * 0.4}
            fill="#8cb4dc"
            opacity={0.15 + (i % 4) * 0.1}
            style={{ animation: `mirra-twinkle ${2 + (i % 3)}s ease-in-out ${(i * 0.3) % 2}s infinite` }}
          />
        ))}

        {/* Orbiting particles */}
        <g style={{ transformOrigin: '200px 200px' }}>
          <circle className="mirra-orb1" cx="200" cy="200" r="3.5" fill="#3ecfcf" opacity="0.25"
            filter={`url(#${FILTER_ID}-glow)`} />
          <circle className="mirra-orb2" cx="200" cy="200" r="2.5" fill="#5af0f0" opacity="0.2"
            filter={`url(#${FILTER_ID}-glow)`} />
          <circle className="mirra-orb3" cx="200" cy="200" r="3" fill="#3ecfcf" opacity="0.22"
            filter={`url(#${FILTER_ID}-glow)`} />
        </g>

        {/* Orbital ring (dashed) */}
        <circle cx="200" cy="200" r="130" fill="none" stroke="#3ecfcf" strokeWidth="0.8"
          strokeDasharray="5 10" className="mirra-ring-pulse" />

        {/* Character group — floats */}
        <g className="mirra-character">

          {/* Head outer glow */}
          <circle ref={headGlowRef} cx="200" cy="200" r="100"
            fill="#3ecfcf" opacity="0.05" filter={`url(#${FILTER_ID}-soft)`} />

          {/* ── Antenna ── */}
          <g className="mirra-antenna">
            {/* Antenna stem */}
            <line x1="200" y1="120" x2="200" y2="95" stroke="#1a4a6a" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="200" y1="120" x2="200" y2="95" stroke="#3ecfcf" strokeWidth="1" strokeLinecap="round" opacity="0.3" />
            {/* Antenna orb */}
            <circle ref={antennaGlowRef} cx="200" cy="90" r="8" fill="#3ecfcf" opacity="0.3"
              filter={`url(#${FILTER_ID}-glow)`} />
            <circle cx="200" cy="90" r="4" fill="#50e8e8" opacity="0.8" />
            <circle cx="198" cy="88" r="1.5" fill="white" opacity="0.6" />
          </g>

          {/* ── Head ── */}
          <ellipse cx="200" cy="210" rx="75" ry="85" fill={`url(#${FILTER_ID}-head)`} />

          {/* Head border */}
          <ellipse cx="200" cy="210" rx="75" ry="85" fill="none"
            stroke="#3ecfcf" strokeWidth="1.5" opacity="0.2" />

          {/* Specular highlight */}
          <ellipse cx="180" cy="170" rx="35" ry="25" fill="white" opacity="0.03" />

          {/* ── Ear nodes ── */}
          <circle cx="122" cy="200" r="8" fill="#0e2236" stroke="#3ecfcf" strokeWidth="1" opacity="0.5" />
          <circle cx="122" cy="200" r="3" fill="#3ecfcf" opacity="0.3" />
          <circle cx="278" cy="200" r="8" fill="#0e2236" stroke="#3ecfcf" strokeWidth="1" opacity="0.5" />
          <circle cx="278" cy="200" r="3" fill="#3ecfcf" opacity="0.3" />

          {/* ── Eyes ── */}
          {/* Left eye */}
          <g filter={`url(#${FILTER_ID}-eye-glow)`}>
            {/* Eye socket */}
            <ellipse cx="172" cy="200" rx="18" ry="16" fill="#081828" />
            {/* Iris */}
            <ellipse ref={leftEyelidRef} cx="172" cy="200" rx="15" ry="14"
              fill={`url(#${FILTER_ID}-iris)`} opacity="0.5" />
            {/* Pupil */}
            <circle ref={leftPupilRef} cx="172" cy="200" r="5" fill="#60f0f0" opacity="0.9" />
            {/* Pupil dark center */}
            <circle cx="172" cy="200" r="2" fill="#051520" opacity="0.7" />
            {/* Specular highlights */}
            <circle cx="168" cy="196" r="2.5" fill="white" opacity="0.5" />
            <circle cx="175" cy="203" r="1" fill="white" opacity="0.25" />
          </g>

          {/* Right eye */}
          <g filter={`url(#${FILTER_ID}-eye-glow)`}>
            <ellipse cx="228" cy="200" rx="18" ry="16" fill="#081828" />
            <ellipse ref={rightEyelidRef} cx="228" cy="200" rx="15" ry="14"
              fill={`url(#${FILTER_ID}-iris)`} opacity="0.5" />
            <circle ref={rightPupilRef} cx="228" cy="200" r="5" fill="#60f0f0" opacity="0.9" />
            <circle cx="228" cy="200" r="2" fill="#051520" opacity="0.7" />
            <circle cx="224" cy="196" r="2.5" fill="white" opacity="0.5" />
            <circle cx="231" cy="203" r="1" fill="white" opacity="0.25" />
          </g>

          {/* ── Cheek blush ── */}
          <ellipse ref={cheekLRef} cx="152" cy="230" rx="12" ry="6" fill="#3ecfcf" opacity="0.04" />
          <ellipse ref={cheekRRef} cx="248" cy="230" rx="12" ry="6" fill="#3ecfcf" opacity="0.04" />

          {/* ── Nose (tiny) ── */}
          <path d="M198,222 L200,228 L202,222" fill="none" stroke="#3ecfcf" strokeWidth="0.8" opacity="0.12" />

          {/* ── Mouth ── */}
          <path ref={mouthRef}
            d="M182,248 Q191,255 200,255 Q209,255 218,248"
            fill="none" stroke="rgba(62,207,207,0.2)" strokeWidth="2" strokeLinecap="round"
          />

          {/* ── "M" forehead watermark ── */}
          <text x="200" y="160" textAnchor="middle" dominantBaseline="middle"
            fontFamily="Inter, system-ui, sans-serif" fontWeight="600" fontSize="14"
            fill="#3ecfcf" opacity="0.05"
          >M</text>

          {/* ── Neck / collar ── */}
          <path d="M185,292 Q200,300 215,292" fill="none" stroke="#1a3a55" strokeWidth="2" opacity="0.4" />

        </g>{/* end character group */}

        {/* ── Audio waveform bars ── */}
        <g ref={waveGroupRef}>
          {Array.from({ length: WAVE_BARS }, (_, i) => (
            <rect
              key={`bar-${i}`}
              x={barStartX + i * (barWidth + barGap)}
              y={350}
              width={barWidth}
              height={1}
              rx={1}
              fill="#3ecfcf"
              opacity="0.05"
            />
          ))}
        </g>

        {/* ── Status indicator ── */}
        <circle ref={statusDotRef} cx="175" cy="375" r="3" fill="#334155" />
        <text ref={statusTextRef} x="183" y="376" fontSize="10" fontFamily="monospace"
          dominantBaseline="middle" fill="#475569">Listening</text>
      </svg>
    </div>
  );
});

import { useEffect, useState, useRef, useCallback } from 'react';

interface Props {
  selectedDeviceId: string | null;
  onSelect: (deviceId: string) => void;
}

export function MicSelector({ selectedDeviceId, onSelect }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [testLevel, setTestLevel] = useState(0);
  const testStreamRef = useRef<MediaStream | null>(null);
  const testCtxRef = useRef<AudioContext | null>(null);
  const testRafRef = useRef<number>(0);

  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      stream.getTracks().forEach((t) => t.stop());
      navigator.mediaDevices.enumerateDevices().then((all) => {
        const mics = all.filter((d) => d.kind === 'audioinput');
        console.log('[MicSelector] Available mics:', mics.map((m) => `${m.label} (${m.deviceId.slice(0, 8)})`));
        setDevices(mics);
        if (!selectedDeviceId && mics.length > 0) {
          onSelect(mics[0].deviceId);
        }
      });
    }).catch((err) => {
      console.error('[MicSelector] Permission denied:', err);
    });
  }, []);

  const stopTest = useCallback(() => {
    cancelAnimationFrame(testRafRef.current);
    testCtxRef.current?.close();
    testCtxRef.current = null;
    testStreamRef.current?.getTracks().forEach((t) => t.stop());
    testStreamRef.current = null;
    setTesting(false);
    setTestLevel(0);
  }, []);

  const startTest = useCallback(async () => {
    stopTest();
    try {
      const constraints: MediaStreamConstraints = {
        audio: selectedDeviceId
          ? { deviceId: { exact: selectedDeviceId }, echoCancellation: { ideal: true }, noiseSuppression: { ideal: false }, autoGainControl: { ideal: true } }
          : { echoCancellation: { ideal: true }, noiseSuppression: { ideal: false }, autoGainControl: { ideal: true } },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      testStreamRef.current = stream;
      const ctx = new AudioContext();
      testCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const update = () => {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        setTestLevel(Math.min(1, sum / buf.length / 128));
        testRafRef.current = requestAnimationFrame(update);
      };
      testRafRef.current = requestAnimationFrame(update);
      setTesting(true);
      // Auto-stop after 8s
      setTimeout(() => stopTest(), 8000);
    } catch (err) {
      console.error('[MicTest] Failed:', err);
    }
  }, [selectedDeviceId, stopTest]);

  // Stop test when device changes
  useEffect(() => {
    if (testing) stopTest();
  }, [selectedDeviceId]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <select
        value={selectedDeviceId || ''}
        onChange={(e) => onSelect(e.target.value)}
        style={{
          padding: '7px 12px',
          borderRadius: 8,
          border: '1px solid rgba(255,255,255,0.1)',
          background: 'rgba(255,255,255,0.04)',
          color: '#94a3b8',
          fontSize: 12,
          maxWidth: 200,
          outline: 'none',
          cursor: 'pointer',
        }}
      >
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Mic ${d.deviceId.slice(0, 8)}`}
          </option>
        ))}
      </select>

      <button
        onClick={testing ? stopTest : startTest}
        style={{
          padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
          fontSize: 11, fontWeight: 600,
          background: testing ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.06)',
          color: testing ? '#ef4444' : '#64748b',
        }}
      >
        {testing ? 'Stop' : 'Test'}
      </button>

      {/* Test level meter */}
      {testing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 80, height: 6, borderRadius: 3,
            background: 'rgba(255,255,255,0.06)', overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', borderRadius: 3,
              width: `${testLevel * 100}%`,
              background: testLevel > 0.05
                ? testLevel > 0.5 ? '#ef4444' : '#22c55e'
                : '#334155',
              transition: 'width 0.08s, background 0.15s',
            }} />
          </div>
          <span style={{
            fontSize: 10, fontWeight: 600,
            color: testLevel > 0.05 ? '#22c55e' : '#475569',
          }}>
            {testLevel > 0.05 ? 'Detected' : 'No signal'}
          </span>
        </div>
      )}
    </div>
  );
}

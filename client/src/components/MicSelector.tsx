import { useEffect, useState } from 'react';

interface Props {
  selectedDeviceId: string | null;
  onSelect: (deviceId: string) => void;
}

export function MicSelector({ selectedDeviceId, onSelect }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    // Need to request mic access first before enumerateDevices shows labels
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      // Stop the temp stream immediately
      stream.getTracks().forEach((t) => t.stop());

      navigator.mediaDevices.enumerateDevices().then((all) => {
        const mics = all.filter((d) => d.kind === 'audioinput');
        console.log('[MicSelector] Available mics:', mics.map((m) => `${m.label} (${m.deviceId.slice(0, 8)})`));
        setDevices(mics);
        // Auto-select first if none selected
        if (!selectedDeviceId && mics.length > 0) {
          onSelect(mics[0].deviceId);
        }
      });
    }).catch((err) => {
      console.error('[MicSelector] Permission denied:', err);
    });
  }, []);

  return (
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
  );
}

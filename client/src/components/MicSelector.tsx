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
        padding: '8px 12px',
        borderRadius: 8,
        border: '1px solid #333',
        background: '#1a1a2e',
        color: '#e0e0e0',
        fontSize: 12,
        maxWidth: 250,
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

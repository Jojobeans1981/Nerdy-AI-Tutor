import { useRef, useCallback, useEffect, useState } from 'react';

export interface LatencyReport {
  interaction_id: string;
  stt_ms: number;
  llm_first_token_ms: number;
  tts_first_byte_ms: number;
  avatar_render_ms: number;
  total_ms: number;
  timestamp: number;
}

interface WSMessage {
  type: string;
  [key: string]: any;
}

interface UseWebSocketReturn {
  isConnected: boolean;
  sendAudio: (data: ArrayBuffer) => void;
  sendJson: (msg: object) => void;
  onMessage: (handler: (msg: WSMessage) => void) => void;
  connect: () => void;
  disconnect: () => void;
}

export function useWebSocket(url: string): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<((msg: WSMessage) => void)[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      console.log('[WS] Connected');
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          handlersRef.current.forEach((h) => h(msg));
        } catch {
          // ignore non-JSON
        }
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      console.log('[WS] Disconnected');
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
  }, [url]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const sendAudio = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  const sendJson = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const onMessage = useCallback((handler: (msg: WSMessage) => void) => {
    // Replace — never accumulate. Every re-render that calls onMessage() replaces
    // the previous handler rather than stacking duplicates, which would cause every
    // message to be processed N times (once per render that triggered the effect).
    handlersRef.current = [handler];
  }, []);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  return { isConnected, sendAudio, sendJson, onMessage, connect, disconnect };
}

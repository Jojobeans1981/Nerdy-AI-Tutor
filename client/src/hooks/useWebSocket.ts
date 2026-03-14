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
  /** Number of reconnect attempts in the current reconnect cycle (0 when stable) */
  reconnectAttempts: number;
  /** True while a reconnect is pending or in-flight */
  isReconnecting: boolean;
  sendAudio: (data: ArrayBuffer) => void;
  sendJson: (msg: object) => void;
  /** sendJson that returns true if the socket was actually open and the message was sent. */
  sendJsonReliable: (msg: object) => boolean;
  onMessage: (handler: (msg: WSMessage) => void) => void;
  /** Register a handler for binary audio frames (raw PCM, 16-bit signed, 16kHz mono) */
  onAudio: (handler: (pcm: Uint8Array) => void) => void;
  connect: () => void;
  disconnect: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 1500;

export function useWebSocket(url: string): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<((msg: WSMessage) => void)[]>([]);
  const audioHandlerRef = useRef<((pcm: Uint8Array) => void) | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // FIX 7: reconnect state
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const reconnectAttemptsRef = useRef(0);
  const intentionalDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable ref to the connect function so the reconnect timer can call it
  const connectRef = useRef<(() => void) | null>(null);

  const connect = useCallback(() => {
    intentionalDisconnectRef.current = false;
    // Reset reconnect counters on an explicit connect call
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectAttemptsRef.current = 0;
    setReconnectAttempts(0);
    setIsReconnecting(false);

    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setIsReconnecting(false);
      reconnectAttemptsRef.current = 0;
      setReconnectAttempts(0);
      console.log('[WS] Connected');
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Binary frame: [0x01 = audio][raw PCM bytes]
        const view = new Uint8Array(event.data);
        if (view[0] === 0x01 && audioHandlerRef.current) {
          audioHandlerRef.current(view.subarray(1));
        }
        return;
      }
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          handlersRef.current.forEach((h) => h(msg));
        } catch {
          // ignore non-JSON
        }
      }
    };

    ws.onclose = (event) => {
      setIsConnected(false);
      console.log(`[WS] Closed — code: ${event.code}  reason: "${event.reason}"  wasClean: ${event.wasClean}`);
      // FIX 7: schedule reconnect unless user explicitly disconnected
      if (!intentionalDisconnectRef.current) {
        scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      // onclose will fire after onerror — reconnect logic handled there
    };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep connectRef in sync so the timer closure always calls the latest connect
  useEffect(() => { connectRef.current = connect; }, [connect]);

  // FIX 7: schedule a reconnect attempt
  const scheduleReconnect = useCallback(() => {
    const attempt = reconnectAttemptsRef.current + 1;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      setIsReconnecting(false);
      console.error(`[WS] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — giving up. Please refresh the page.`);
      return;
    }
    reconnectAttemptsRef.current = attempt;
    setReconnectAttempts(attempt);
    setIsReconnecting(true);
    console.log(`[WS] Reconnect attempt ${attempt} of ${MAX_RECONNECT_ATTEMPTS}`);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      connectRef.current?.();
    }, RECONNECT_DELAY_MS);
  }, []);

  const disconnect = useCallback(() => {
    intentionalDisconnectRef.current = true;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectAttemptsRef.current = 0;
    setReconnectAttempts(0);
    setIsReconnecting(false);
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const lastWsDropWarnRef = useRef(0);
  const sendAudio = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    } else {
      const now = Date.now();
      if (now - lastWsDropWarnRef.current > 2000) {
        lastWsDropWarnRef.current = now;
        console.warn(`[WS] sendAudio dropped — WS not open (readyState=${wsRef.current?.readyState ?? 'null'})`);
      }
    }
  }, []);

  const sendJson = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const sendJsonReliable = useCallback((msg: object): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
      return true;
    }
    console.warn(`[WS] sendJsonReliable failed — WS not open (readyState=${wsRef.current?.readyState ?? 'null'})`);
    return false;
  }, []);

  const onMessage = useCallback((handler: (msg: WSMessage) => void) => {
    handlersRef.current = [handler];
  }, []);

  const onAudio = useCallback((handler: (pcm: Uint8Array) => void) => {
    audioHandlerRef.current = handler;
  }, []);

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  return {
    isConnected,
    reconnectAttempts,
    isReconnecting,
    sendAudio,
    sendJson,
    sendJsonReliable,
    onMessage,
    onAudio,
    connect,
    disconnect,
  };
}

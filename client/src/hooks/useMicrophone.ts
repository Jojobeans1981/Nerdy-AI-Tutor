import { useRef, useCallback, useState } from 'react';

interface UseMicrophoneReturn {
  isRecording: boolean;
  startRecording: (onAudioData: (data: ArrayBuffer) => void, deviceId?: string | null) => Promise<void>;
  stopRecording: () => void;
}

export function useMicrophone(): UseMicrophoneReturn {
  const [isRecording, setIsRecording] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);

  const startRecording = useCallback(async (onAudioData: (data: ArrayBuffer) => void, deviceId?: string | null) => {
    try {
      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (deviceId) {
        audioConstraints.deviceId = { exact: deviceId };
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      console.log('[Mic] Using device:', stream.getAudioTracks()[0]?.label);

      streamRef.current = stream;

      // Use native sample rate — we'll downsample to 16kHz ourselves
      const audioContext = new AudioContext();
      contextRef.current = audioContext;
      const nativeSR = audioContext.sampleRate;

      console.log(`[Mic] Native sample rate: ${nativeSR}Hz`);

      // Register a simple processor worklet inline via blob URL
      const workletCode = `
        class PCMProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.buffer = [];
          }
          process(inputs) {
            const input = inputs[0];
            if (input && input[0]) {
              // Copy float32 samples and send to main thread
              const samples = new Float32Array(input[0]);
              this.port.postMessage(samples.buffer, [samples.buffer]);
            }
            return true;
          }
        }
        registerProcessor('pcm-processor', PCMProcessor);
      `;
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);

      await audioContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
      workletRef.current = workletNode;

      // Downsample from native rate to 16kHz and convert to int16 PCM
      const targetSR = 16000;
      const ratio = nativeSR / targetSR;
      let resampleBuffer: number[] = [];

      workletNode.port.onmessage = (event) => {
        const float32 = new Float32Array(event.data);

        // Accumulate and downsample
        for (let i = 0; i < float32.length; i++) {
          resampleBuffer.push(float32[i]);
        }

        // Output 16kHz chunks when we have enough samples
        const outputLen = Math.floor(resampleBuffer.length / ratio);
        if (outputLen > 0) {
          const int16 = new Int16Array(outputLen);
          for (let i = 0; i < outputLen; i++) {
            const srcIdx = Math.floor(i * ratio);
            const s = Math.max(-1, Math.min(1, resampleBuffer[srcIdx]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          // Remove consumed samples
          resampleBuffer = resampleBuffer.slice(Math.floor(outputLen * ratio));
          onAudioData(int16.buffer);
        }
      };

      source.connect(workletNode);
      workletNode.connect(audioContext.destination);
      setIsRecording(true);
      console.log('[Mic] Recording started');
    } catch (err) {
      console.error('[Mic] Failed to start:', err);
      alert('Microphone access failed. Please allow microphone permissions and try again.');
    }
  }, []);

  const stopRecording = useCallback(() => {
    workletRef.current?.disconnect();
    workletRef.current = null;
    contextRef.current?.close();
    contextRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setIsRecording(false);
    console.log('[Mic] Recording stopped');
  }, []);

  return { isRecording, startRecording, stopRecording };
}

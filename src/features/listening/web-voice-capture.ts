export type WebVoiceCaptureCapabilities = {
  liveTranscription: boolean;
  recordingUpload: boolean;
};

export type WebVoiceCaptureStrategy =
  | 'browser-transcription'
  | 'recording-upload'
  | 'unavailable';

/**
 * Prefer the browser's speech recognizer when it is present. Running a speech
 * recognizer and a MediaRecorder against the microphone at the same time is
 * unreliable in WebKit and Chromium, and can make an otherwise-supported mic
 * look broken.
 */
export function resolveWebVoiceCaptureStrategy(
  capabilities: WebVoiceCaptureCapabilities,
): WebVoiceCaptureStrategy {
  if (capabilities.liveTranscription) return 'browser-transcription';
  if (capabilities.recordingUpload) return 'recording-upload';
  return 'unavailable';
}

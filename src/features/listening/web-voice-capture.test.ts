import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWebVoiceCaptureStrategy } from './web-voice-capture';

test('prefers browser transcription over a simultaneous recording upload', () => {
  assert.equal(
    resolveWebVoiceCaptureStrategy({
      liveTranscription: true,
      recordingUpload: true,
    }),
    'browser-transcription',
  );
});

test('uses recording upload only when live browser transcription is absent', () => {
  assert.equal(
    resolveWebVoiceCaptureStrategy({
      liveTranscription: false,
      recordingUpload: true,
    }),
    'recording-upload',
  );
});

test('reports unavailable when the browser exposes neither capture path', () => {
  assert.equal(
    resolveWebVoiceCaptureStrategy({
      liveTranscription: false,
      recordingUpload: false,
    }),
    'unavailable',
  );
});

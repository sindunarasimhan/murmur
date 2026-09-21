import assert from 'node:assert/strict';
import test from 'node:test';

import {
  audioUploadFileName,
  DEFAULT_SPEECH_MODEL,
  DEFAULT_SPEECH_VOICE,
  DEFAULT_TRANSCRIBE_MODEL,
  getOpenAIAudioConfig,
  MAX_AUDIO_BYTES,
  MAX_SPEECH_CHARACTERS,
  validateAudioFile,
  validateSpeechText,
} from '@/server/openai-audio/contracts';

test('uses safe OpenAI audio defaults without requiring client-visible configuration', () => {
  assert.deepEqual(getOpenAIAudioConfig({}), {
    apiKey: null,
    speechModel: DEFAULT_SPEECH_MODEL,
    speechVoice: DEFAULT_SPEECH_VOICE,
    transcribeModel: DEFAULT_TRANSCRIBE_MODEL,
  });
});

test('accepts common recorded-audio MIME types through the size boundary', () => {
  assert.deepEqual(validateAudioFile({ size: MAX_AUDIO_BYTES, type: 'audio/m4a' }), { ok: true });
  assert.deepEqual(validateAudioFile({ size: 512, type: 'audio/webm' }), { ok: true });
});

test('rejects empty, oversized, and unsupported audio', () => {
  assert.equal(validateAudioFile({ size: 0, type: 'audio/wav' }).ok, false);

  const oversized = validateAudioFile({ size: MAX_AUDIO_BYTES + 1, type: 'audio/wav' });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.status, 413);

  const unsupported = validateAudioFile({ size: 100, type: 'text/plain' });
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.status, 415);
});

test('normalizes speech text and enforces the endpoint character limit', () => {
  assert.deepEqual(validateSpeechText('  explain this  '), {
    ok: true,
    text: 'explain this',
  });
  assert.equal(validateSpeechText(' ').ok, false);
  assert.equal(validateSpeechText('a'.repeat(MAX_SPEECH_CHARACTERS + 1)).ok, false);
});

test('gives format-sensitive uploads an extension that matches their MIME type', () => {
  assert.equal(audioUploadFileName({ name: 'question', type: 'audio/m4a' }), 'question.m4a');
  assert.equal(audioUploadFileName({ name: '', type: 'audio/webm' }), 'murmur-recording.webm');
  assert.equal(audioUploadFileName({ name: 'voice.wav', type: 'audio/wav' }), 'voice.wav');
});

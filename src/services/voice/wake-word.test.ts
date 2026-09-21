import assert from 'node:assert/strict';
import test from 'node:test';

import { matchMurmurWakeWord } from '@/services/voice/wake-word';

test('matches the wake phrase and preserves the spoken request after it', () => {
  assert.deepEqual(matchMurmurWakeWord('Hey, Murmur — what did that mean?'), {
    matched: true,
    request: 'what did that mean?',
  });
  assert.deepEqual(matchMurmurWakeWord('background words hey murmur skip ad'), {
    matched: true,
    request: 'skip ad',
  });
});

test('does not activate on the product name without the complete wake phrase', () => {
  for (const transcript of ['Murmur', 'hey there', 'they murmur quietly', '']) {
    assert.deepEqual(matchMurmurWakeWord(transcript), {
      matched: false,
      request: '',
    });
  }
});

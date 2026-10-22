import assert from 'node:assert/strict';
import test from 'node:test';
import { AbortController } from 'abort-controller';
import { loadEpisodeAudio } from './load-episode-audio';

const source = { uri: 'https://example.org/episode.mp3', name: 'Episode' };

test('episode loading and seeking work with React Native’s AbortSignal', async () => {
  const controller = new AbortController();
  assert.equal('throwIfAborted' in controller.signal, false);
  let loaded = false;
  let sought: number | undefined;
  const player = {
    get isLoaded() { return loaded; },
    replace: () => { setTimeout(() => { loaded = true; }, 5); },
    seekTo: async (seconds: number) => { sought = seconds; },
  };
  await loadEpisodeAudio(player, source, 37, controller.signal, () => false);
  assert.equal(sought, 37);
});

test('cancellation while native audio loads prevents seeking', async () => {
  const controller = new AbortController();
  let sought = false;
  const player = {
    isLoaded: false,
    replace: () => { controller.abort(); },
    seekTo: async () => { sought = true; },
  };
  await assert.rejects(loadEpisodeAudio(player, source, 0, controller.signal, () => false), { name: 'AbortError' });
  assert.equal(sought, false);
});

test('a pre-cancelled request never replaces the episode', async () => {
  const controller = new AbortController();
  controller.abort();
  const player = {
    isLoaded: true,
    replace: () => assert.fail('Must not replace cancelled audio'),
    seekTo: async () => assert.fail('Must not seek cancelled audio'),
  };
  await assert.rejects(loadEpisodeAudio(player, source, 0, controller.signal, () => false), { name: 'AbortError' });
});

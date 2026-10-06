import assert from 'node:assert/strict';
import test from 'node:test';
import { backendConfig } from './config';
import { createCatalogInterpreter } from './catalog-interpreter';

test('live catalog routing separates ending an episode from disabling voice', { skip: process.env.MURMUR_LIVE_SEMANTICS !== '1' }, async () => {
  const interpret = createCatalogInterpreter(backendConfig().providers.typesafe);
  const episodes = [{ id: 'brian', title: 'Brian Halligan', showTitle: 'Lenny’s Podcast', guest: 'Brian Halligan', description: 'HubSpot' }];
  for (const [utterance, expected] of [
    ['End the stream', 'home'],
    ['Stop this episode and take me home', 'home'],
    ['I am done with this podcast', 'home'],
    ['Turn off the microphone', 'stop'],
    ['Stop listening to me', 'stop'],
    ['Pause the podcast', 'current'],
    ['Could you get the podcast going again', 'resume'],
    ['Never mind', 'cancel'],
    ['Forget what I asked', 'cancel'],
  ] as const) {
    const result = await interpret({ utterance, currentEpisodeId: 'brian', history: [], episodes }, new AbortController().signal);
    assert.equal(result.kind, expected, utterance);
  }
});

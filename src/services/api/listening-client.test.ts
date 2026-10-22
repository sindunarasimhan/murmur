import assert from 'node:assert/strict';
import test from 'node:test';
import { voiceGatewayUrlForRuntime } from './listening-client';

test('deployed native voice uses the configured API origin without forcing the local backend port', () => {
  assert.equal(
    voiceGatewayUrlForRuntime({ platform: 'native', configuredBaseUrl: 'https://murmur-api.example.com/api' }),
    'wss://murmur-api.example.com/v2/voice',
  );
});

test('native development without a configured API still targets the local backend port', () => {
  assert.equal(
    voiceGatewayUrlForRuntime({ platform: 'native', development: true, expoHostUri: '192.168.1.24:8081' }),
    'ws://192.168.1.24:4545/v2/voice',
  );
});

test('explicit voice gateway override remains supported', () => {
  assert.equal(
    voiceGatewayUrlForRuntime({ platform: 'native', configuredBaseUrl: 'https://murmur-api.example.com/api' }, 'wss://voice.example.com/v2/live-voice'),
    'wss://voice.example.com/v2/live-voice',
  );
});

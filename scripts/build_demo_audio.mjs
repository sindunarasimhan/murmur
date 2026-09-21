#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(projectDirectory, 'assets/audio');
const audioPath = resolve(outputDirectory, 'murmur-handoff-demo.wav');
const markersPath = resolve(outputDirectory, 'murmur-handoff-demo-markers.json');

const sampleRate = 16_000;
const durationSeconds = 30;
const adStartSeconds = 10;
const adEndSeconds = 20;
const samples = new Int16Array(sampleRate * durationSeconds);

function envelope(time, segmentStart, segmentEnd) {
  const attack = Math.min(1, Math.max(0, (time - segmentStart) / 0.22));
  const release = Math.min(1, Math.max(0, (segmentEnd - time) / 0.32));
  return Math.min(attack, release);
}

function contentSignal(time, offset, frequencies) {
  const localTime = time - offset;
  const noteIndex = Math.floor(localTime / 2) % frequencies.length;
  const frequency = frequencies[noteIndex] ?? frequencies[0];
  const fundamental = Math.sin(2 * Math.PI * frequency * time);
  const overtone = Math.sin(2 * Math.PI * frequency * 1.5 * time) * 0.23;
  const breathing = 0.72 + Math.sin(2 * Math.PI * 0.12 * time) * 0.12;
  return (fundamental + overtone) * breathing;
}

for (let index = 0; index < samples.length; index += 1) {
  const time = index / sampleRate;
  let value;

  if (time < adStartSeconds) {
    value =
      contentSignal(time, 0, [196, 246.94, 293.66, 246.94]) *
      envelope(time, 0, adStartSeconds) *
      0.22;
  } else if (time < adEndSeconds) {
    const localTime = time - adStartSeconds;
    const pulsePosition = localTime % 0.8;
    const pulseEnvelope = pulsePosition < 0.46 ? Math.sin((pulsePosition / 0.46) * Math.PI) : 0;
    const frequency = Math.floor(localTime / 0.8) % 2 === 0 ? 659.25 : 783.99;
    value =
      (Math.sin(2 * Math.PI * frequency * time) +
        Math.sin(2 * Math.PI * frequency * 0.5 * time) * 0.18) *
      pulseEnvelope *
      envelope(time, adStartSeconds, adEndSeconds) *
      0.28;
  } else {
    value =
      contentSignal(time, adEndSeconds, [220, 277.18, 329.63, 440]) *
      envelope(time, adEndSeconds, durationSeconds) *
      0.2;
  }

  samples[index] = Math.max(-1, Math.min(1, value)) * 0x7fff;
}

const bytesPerSample = 2;
const dataLength = samples.length * bytesPerSample;
const wav = Buffer.alloc(44 + dataLength);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + dataLength, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
wav.writeUInt16LE(bytesPerSample, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(dataLength, 40);

for (let index = 0; index < samples.length; index += 1) {
  wav.writeInt16LE(samples[index] ?? 0, 44 + index * bytesPerSample);
}

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(audioPath, wav);
const versionId = `sha256-${createHash('sha256').update(wav).digest('hex').slice(0, 20)}`;
writeFileSync(
  markersPath,
  `${JSON.stringify({ adEndSeconds, adStartSeconds, durationSeconds, versionId }, null, 2)}\n`,
);

console.log(`Generated ${audioPath}`);
console.log(`Verified test interval: ${adStartSeconds}s–${adEndSeconds}s`);
console.log(`Asset identity: ${versionId}`);

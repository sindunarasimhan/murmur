// Rebuild the original fixture on macOS; no API calls or downloaded media.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = new URL('../backend/fixtures/', import.meta.url);
const script = JSON.parse(await readFile(new URL('field-notes-script.json', directory), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'murmur-narration-'));
const chunks = [];
const segments = [];
let totalBytes = 0;
try {
  for (const [index, segment] of script.segments.entries()) {
    const textPath = join(temporary, `${index}.txt`);
    const audioPath = join(temporary, `${index}.wav`);
    await writeFile(textPath, segment.text);
    execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '165', '-f', textPath, '-o', audioPath, '--file-format=WAVE', '--data-format=LEI16@24000']);
    const wav = await readFile(audioPath);
    let pcm;
    for (let offset = 12; offset + 8 <= wav.length;) {
      const size = wav.readUInt32LE(offset + 4);
      if (wav.toString('ascii', offset, offset + 4) === 'data') pcm = wav.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size + (size % 2);
    }
    if (!pcm?.length) throw new Error('Narration did not produce PCM audio');
    const silence = Buffer.alloc(24000); // Half a second between paragraphs.
    segments.push({ ...segment, startSeconds: totalBytes / 48000, endSeconds: (totalBytes + pcm.length) / 48000 });
    chunks.push(pcm, silence);
    totalBytes += pcm.length + silence.length;
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(totalBytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(totalBytes, 40);
  const audio = Buffer.concat([header, ...chunks]);
  const version = createHash('sha256').update(audio).digest('hex');
  await writeFile(new URL('field-notes.wav', directory), audio);
  await writeFile(new URL('field-notes.json', directory), JSON.stringify({ ...script, segments, version, durationSeconds: totalBytes / 48000 }, null, 2) + '\n');
  const requestText = join(temporary, 'voice-request.txt');
  await writeFile(requestText, 'Go deeper on that tradeoff.');
  execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '165', '-f', requestText, '-o', fileURLToPath(new URL('voice-request.wav', directory)), '--file-format=WAVE', '--data-format=LEI16@24000']);
  console.log(`Prepared ${segments.length} aligned passages, ${Math.round(totalBytes / 48000)} seconds.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

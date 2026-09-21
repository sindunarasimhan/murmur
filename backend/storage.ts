import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Immutable content-addressed objects. Mount this directory persistently in deployment. */
export class ObjectStore {
  constructor(private readonly directory: string) {}
  path(key: string) {
    if (!/^[a-f0-9]{64}\.(wav|mp3|json)$/.test(key)) throw new Error('Invalid object key');
    return resolve(this.directory, key);
  }
  async put(bytes: Buffer, extension: 'wav' | 'mp3' | 'json') {
    const key = `${createHash('sha256').update(bytes).digest('hex')}.${extension}`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = resolve(this.directory, `.pending-${randomUUID()}`);
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, this.path(key));
    return key;
  }
  read(key: string) { return readFile(this.path(key)); }
  stat(key: string) { return stat(this.path(key)); }
}

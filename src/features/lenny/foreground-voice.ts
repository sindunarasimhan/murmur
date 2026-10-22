type ForegroundVoicePorts = {
  activate(): Promise<void>;
  suspendVoice(): Promise<void>;
  dispose(): Promise<void>;
  fail(error: unknown): Promise<void>;
};

export class ForegroundVoice {
  private foreground = false;
  private disposed = false;
  private generation = 0;
  private cleanup: Promise<void> = Promise.resolve();

  constructor(private readonly voice: ForegroundVoicePorts) {}

  changed(state: string | null) {
    if (this.disposed || state === 'inactive' || state === null) return;
    if (state === 'background') {
      if (!this.foreground) return;
      this.foreground = false;
      this.generation++;
      this.cleanup = Promise.all([this.cleanup, this.voice.suspendVoice()])
        .then(() => undefined)
        .catch(async (error) => { await this.voice.fail(error).catch(() => undefined); });
      return;
    }
    if (state !== 'active' || this.foreground) return;
    this.foreground = true;
    const generation = ++this.generation;
    void this.cleanup.then(async () => {
      if (this.disposed || !this.foreground || generation !== this.generation) return;
      await this.voice.activate();
    }).catch((error) => {
      if (!this.disposed && generation === this.generation) return this.voice.fail(error);
    });
  }

  async dispose() {
    this.disposed = true;
    this.generation++;
    await this.voice.dispose();
  }
}

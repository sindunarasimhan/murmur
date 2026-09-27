type CapturePorts = {
  start(): Promise<void>;
  stop(): void;
  recordingMode(): Promise<void>;
  playbackMode(): Promise<void>;
  inputReady(): Promise<void>;
};

export class NativeVoiceCapture {
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private started = false;

  constructor(private readonly ports: CapturePorts) {}

  private serialize(operation: () => Promise<void>) {
    const pending = this.queue.catch(() => undefined).then(operation);
    this.queue = pending;
    return pending;
  }

  start() {
    const generation = ++this.generation;
    return this.serialize(async () => {
      if (generation !== this.generation) return;
      this.started = true;
      await this.ports.start();
      if (generation !== this.generation) return;
      await this.ports.recordingMode();
      if (generation !== this.generation) return;
      await this.ports.inputReady();
    });
  }

  stop() {
    this.generation++;
    return this.serialize(async () => {
      try {
        if (this.started) { this.ports.stop(); this.started = false; }
      }
      finally { await this.ports.playbackMode(); }
    });
  }
}

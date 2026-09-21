export const MAX_VOICE_BYTES = 24_000 * 2 * 15;
export const MAX_VOICE_MS = 25_000;

export class VoiceInputBudget {
  private bytes = 0;
  private frames = 0;
  private committed = false;
  accept(value: unknown): string {
    if (!value || typeof value !== 'object') throw new Error('Invalid voice input');
    const event = value as Record<string, unknown>;
    if (++this.frames > 1500) throw new Error('Too many voice frames');
    if (event.type === 'input_audio_buffer.append' && !this.committed && typeof event.audio === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(event.audio)) {
      const audio = Buffer.from(event.audio, 'base64');
      if (audio.length % 2 || !audio.length || audio.toString('base64') !== event.audio) throw new Error('Invalid PCM data');
      this.bytes += audio.length;
      if (this.bytes > MAX_VOICE_BYTES) throw new Error('Voice allowance exceeded');
      return JSON.stringify({ type: event.type, audio: event.audio });
    }
    if (event.type === 'input_audio_buffer.commit' && !this.committed && this.bytes >= 4800) {
      this.committed = true;
      return JSON.stringify({ type: event.type });
    }
    throw new Error('Unsupported voice input');
  }
}

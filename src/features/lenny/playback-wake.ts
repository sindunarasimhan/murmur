type Wake = { request: string; display: string };
type Prefix = { item: string; text: string; order: number; expires: number };
const WAKE = /\bhey[\s,.:!?—-]+(?:murmur|murmer|mur mur)\b[\s,.:!?—-]*/i;

export class PlaybackWake {
  private prefix?: Prefix;
  private continuation?: { item: string; prefix: Prefix };
  private orders = new Map<string, number>();
  private latest = 0;
  constructor(private readonly now = Date.now, private readonly windowMs = 2000) {}
  reset() {
    this.prefix = undefined; this.continuation = undefined;
    this.orders.clear(); this.latest = 0;
  }
  receive(text: string, item: string): Wake | undefined {
    let order = this.orders.get(item);
    if (order === undefined) {
      order = ++this.latest; this.orders.set(item, order);
      if (this.orders.size > 64) this.orders.delete(this.orders.keys().next().value!);
    }
    if (order < this.latest) return;
    const time = this.now();
    const direct = WAKE.exec(text);
    if (direct) {
      this.prefix = undefined; this.continuation = undefined;
      return { request: text.slice(direct.index + direct[0].length).trim(), display: text };
    }
    const continuing = this.continuation?.item === item;
    const carry = continuing ? this.continuation!.prefix : this.prefix;
    if (carry && carry.item !== item && carry.order + 1 === order && (continuing || time <= carry.expires)) {
      const display = `${carry.text} ${text}`;
      const match = WAKE.exec(display);
      this.prefix = undefined;
      if (match) {
        this.continuation = { item, prefix: carry };
        return { request: display.slice(match.index + match[0].length).trim(), display };
      }
    }
    this.continuation = undefined;
    if (/^hey[\s,.:!?—-]*$/i.test(text.trim())) {
      if (this.prefix?.item !== item) this.prefix = { item, text, order, expires: time + this.windowMs };
      else this.prefix.text = text;
    } else this.prefix = undefined;
    return;
  }
}

/** URL filtering is defense in depth; a public deployment also needs DNS-aware egress rules. */
export function parsePublicHttpsUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password ||
        (url.port && url.port !== '443') || !host.includes('.') ||
        host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return undefined;
    return url;
  } catch { return undefined; }
}

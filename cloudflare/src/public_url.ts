/** Lightweight public-URL validation shared by read-only research and browsers. */
export function validatePublicUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Unsafe application URL'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !host || !host.includes('.') && !host.includes(':') ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host === 'metadata.google.internal' || host.endsWith('.home.arpa')) {
    throw new Error('Unsafe application URL');
  }
  if (/^[\d.]+$/.test(host)) {
    const octets = host.split('.').map(Number);
    const [a, b, c] = octets;
    if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255) ||
        a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
        a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
        a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) ||
        a === 192 && b === 0 && (c === 0 || c === 2) || a === 192 && b === 88 && c === 99 ||
        a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113) {
      throw new Error('Unsafe application URL');
    }
  } else if (host.includes(':')) {
    const groups = host.replace(/^\[|\]$/g, '').split(':');
    const first = parseInt(groups[0] || '0', 16);
    const second = parseInt(groups[1] || '0', 16);
    // Permit global unicast, excluding documentation and transition networks.
    // This also rejects loopback, mapped IPv4, link-local, ULA and multicast.
    if ((first & 0xe000) !== 0x2000 || first === 0x2002 ||
        first === 0x2001 && (second === 0 || second === 0xdb8)) {
      throw new Error('Unsafe application URL');
    }
  }
  url.hash = '';
  return url.toString();
}

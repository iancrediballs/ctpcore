// crypto.randomUUID() exists only in SECURE contexts. The production PWA is
// https and fine — but the vite dev server tested from a phone on the LAN is
// plain http://192.168.x.x:1420, where randomUUID is undefined and every
// ledger post would die on its idempotency key. getRandomValues() has no such
// restriction, so fall back to assembling the v4 by hand.
export function makeUuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

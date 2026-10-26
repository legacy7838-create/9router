// Proxy pool types that are base-URL relays rather than socket proxies.
// Kept in one place so a new relay is registered everywhere at once.
export const RELAY_TYPES = Object.freeze([
  "vercel",
  "cloudflare",
  "deno",
  "netlify",
  "github",
]);

const RELAY_TYPE_SET = new Set(RELAY_TYPES);

export function isRelayType(type) {
  return RELAY_TYPE_SET.has(type);
}

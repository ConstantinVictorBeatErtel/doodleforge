// crypto.randomUUID() requires a secure context (HTTPS, or the literal host "localhost") —
// a phone hitting a plain-http LAN/Tailscale IP for testing doesn't get one, and Safari throws
// synchronously rather than leaving the method undefined-but-callable, which crashed the whole
// component tree with no error boundary to catch it. crypto.getRandomValues has no such
// restriction, so fall back to building a UUID from that (or Math.random as a last resort) —
// this only needs to be an anonymous per-browser id, not cryptographically unguessable.
function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Anonymous per-browser session (good enough for a hackathon; swap for Convex Auth/Clerk later).
export function getSessionId(): string {
  const k = "spatial-hack-session";
  let id = localStorage.getItem(k);
  if (!id) { id = generateId(); localStorage.setItem(k, id); }
  return id;
}
export const randomColor = () => `hsl(${Math.floor(Math.random() * 360)} 80% 60%)`;
export const roomFromUrl = () => new URLSearchParams(location.search).get("room") ?? "lobby";

import { isIP } from "node:net";
import type { Request } from "express";

// Requests reach the API through Cloudflare → cloudflared → nginx, so req.ip
// (trust proxy 1) is the internal proxy hop for every visitor (#230). Cloudflare
// sets CF-Connecting-IP to the real client and overwrites any value a client
// sends, so it's the address to key per-client limits on — but only when the
// request came from our own proxy (a private/loopback peer); a request reaching
// the API directly can't choose its own key that way.
const PRIVATE_PEER =
  /^(?:::ffff:)?(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)|^::1$|^f[cd][0-9a-f]{2}:/i;

export function isPrivatePeer(address: string | undefined): boolean {
  return !!address && PRIVATE_PEER.test(address);
}

/** The visitor's IP address for rate limiting. */
export function clientIp(req: Pick<Request, "headers" | "ip" | "socket">): string {
  const raw = req.headers["cf-connecting-ip"];
  const cf = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (cf && isIP(cf) && isPrivatePeer(req.socket?.remoteAddress)) return cf;
  return (req.ip ?? "unknown").toString();
}

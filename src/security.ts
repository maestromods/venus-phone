// Network and login guards: only private-network clients get an answer at all, every API call
// needs a PIN-backed session cookie, and PIN guessing is throttled.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIPv4, isIPv6 } from "node:net";

/** Loopback, RFC 1918, link-local and IPv6 unique-local/link-local addresses. */
export function isLocalAddress(raw: string | undefined): boolean {
  if (!raw) return false;
  let address = raw.trim().toLowerCase();
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (isIPv4(address)) {
    const [a = -1, b = -1] = address.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (isIPv6(address)) {
    return address === "::1" || /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address);
  }
  return false;
}

export function hashPin(pin: string, salt = randomBytes(16).toString("hex")): { salt: string; hash: string } {
  return { salt, hash: scryptSync(pin, salt, 32).toString("hex") };
}

export function checkPin(pin: string, stored: { salt: string; hash: string }): boolean {
  const attempt = scryptSync(pin, stored.salt, 32);
  const expected = Buffer.from(stored.hash, "hex");
  return attempt.length === expected.length && timingSafeEqual(attempt, expected);
}

/** A new PIN: at least 6 digits, or a passphrase of 8+ characters. Up to 64. */
export function isValidNewPin(pin: unknown): pin is string {
  if (typeof pin !== "string" || pin.length > 64 || /[\u0000-\u001f\u007f]/.test(pin)) return false;
  return /^[0-9]{6,}$/.test(pin) || pin.length >= 8;
}

export const NEW_PIN_RULE = "Use at least 6 digits, or a passphrase of 8 or more characters.";

/** Anything that might be a PIN someone already set (older versions allowed 4 digits). */
export function isPinAttempt(pin: unknown): pin is string {
  return typeof pin === "string" && pin.length >= 1 && pin.length <= 64;
}

// ---- DNS rebinding -----------------------------------------------------------------------------

/**
 * True when the request was addressed to this PC by one of its own names or addresses. A page on
 * another site that points its own domain at this PC (DNS rebinding) still sends its own domain
 * in the Host header, so it is refused here before it reaches anything.
 */
export function isOwnHost(hostHeader: string | undefined, own: { ips: string[]; names: string[] }, ports: number[]): boolean {
  if (!hostHeader) return false;
  let url: URL;
  try {
    url = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  const port = url.port ? Number(url.port) : 80;
  if (url.port && !ports.includes(port)) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "::1" || own.ips.includes(host) || own.names.includes(host);
}

// ---- Sessions ---------------------------------------------------------------------------------

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map<string, number>();
export const COOKIE = "vphone_voice_experiment";

export function createSession(): string {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function endAllSessions(): void {
  sessions.clear();
}

export function endSession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

export function sessionOf(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) {
      const token = rest.join("=");
      const expires = sessions.get(token);
      if (expires && expires > Date.now()) return token;
      sessions.delete(token);
    }
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean): string {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}

// ---- Throttling -----------------------------------------------------------------------------------

const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;

export function loginLockedFor(ip: string): number {
  const entry = failures.get(ip);
  if (!entry || entry.until < Date.now()) return 0;
  return entry.until - Date.now();
}

export function recordLoginFailure(ip: string): void {
  const entry = failures.get(ip) ?? { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILURES) {
    entry.until = Date.now() + LOCK_MS * Math.min(16, 2 ** (entry.count - MAX_FAILURES));
  }
  failures.set(ip, entry);
}

export function clearLoginFailures(ip: string): void {
  failures.delete(ip);
}

/**
 * Blocks cross-site requests to the API. Browsers send Sec-Fetch-Site on every request; anything
 * other than same-origin (or "none", a typed address) is refused. An Origin, when present, must be
 * exactly this server. Host is checked separately by isOwnHost, which is what stops rebinding.
 */
export function sameOrigin(req: IncomingMessage, secure: boolean): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true; // Same-origin requests from older browsers, and curl from this PC.
  try {
    const url = new URL(origin);
    return url.host === req.headers.host && url.protocol === (secure ? "https:" : "http:");
  } catch {
    return false;
  }
}

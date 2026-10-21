// Venus Phone: a LAN-only web app for texting the girls in a Venus University save.
// Run `npm start`, then open the printed https://<pc-ip>:<port> on your phone.

import { createReadStream, promises as fs } from "node:fs";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stopComfy } from "./comfy.js";
import { decryptSecret, encryptSecret, loadConfig, saveConfig, type AppConfig } from "./config.js";
import { GameFiles, isGameRunning } from "./game/files.js";
import { LlmError, validateEndpoint, type LlmSettings, type Provider, type ThinkingLevel } from "./llm.js";
import { Phone, PhoneError } from "./phone.js";
import { LocalVoice, VoiceCalls } from "./voice.js";
import { INCOMING_CHOICES, incomingSetting, loadIncoming, MAX_CHOICES, setIncoming, startIncomingLoop } from "./incoming.js";
import {
  admitLogin,
  checkPin,
  clearedCookie,
  clearLoginFailures,
  createSession,
  endAllSessions,
  endSession,
  hashPin,
  isLocalAddress,
  isOwnHost,
  isPinAttempt,
  isValidNewPin,
  loginLockedFor,
  NEW_PIN_RULE,
  recordLoginFailure,
  sameOrigin,
  sessionCookie,
  sessionOf,
} from "./security.js";
import { ensureTls, localNames, type TlsMaterial } from "./tls.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const MAX_BODY = 64 * 1024;
/** A send can carry a photo: 6 MB of image as base64, plus the text. */
const MAX_SEND_BODY = 9 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/manifest+json",
};
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

let config: AppConfig;
let phone: Phone;
const localVoice = new LocalVoice();
let calls: VoiceCalls;
let tls: TlsMaterial | null = null;

async function main(): Promise<void> {
  config = await loadConfig();
  if (!config.pin) await firstRunPin();
  const files = new GameFiles(config.gameDir);
  if (!(await files.exists())) {
    console.log("\nNo game folder chosen yet. Open the app and pick your Venus University folder.\n");
  }
  phone = new Phone(files);
  calls = new VoiceCalls(phone, localVoice);
  await phone.restore();
  await loadIncoming();
  startIncomingLoop(
    () => ({ playthroughId: phone.playthroughId(), contacts: phone.contactIds() }),
    async (charId, maxUnanswered) => {
      const hasKey = config.provider === "gemini" ? config.geminiKeyEnc : config.openrouterKeyEnc;
      if (!hasKey) return false;
      return phone.incoming(charId, await llmSettings(false), { enabled: config.photos, explicit: config.explicitPhotos }, maxUnanswered);
    },
  );

  const onError = (res: ServerResponse) => (err: unknown) => {
    console.error("[http]", err);
    if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong on the PC." });
    else res.end();
  };

  // Plain HTTP by default, like most self-hosted apps. HTTPS is opt-in ("https": true in
  // app-data/config.json, or VENUS_PHONE_HTTPS=1): then plain HTTP stays for this PC, and for the
  // setup page that hands out the certificate.
  if (config.https || process.env.VENUS_PHONE_HTTPS === "1") {
    try {
      tls = await ensureTls();
    } catch (err) {
      throw new Error(`Could not set up HTTPS: ${(err as Error).message}. HTTPS was requested, so the server has not started. Fix certificate setup before trying again.`);
    }
  }

  const servers: Array<{ close(): void }> = [];
  const http = createServer((req, res) => handle(req, res, false).catch(onError(res)));
  http.requestTimeout = 300_000;
  http.listen(config.port, "0.0.0.0");
  await once(http, "listening");
  servers.push(http);
  if (tls) {
    const secure = createHttpsServer({ pfx: tls.pfx, passphrase: tls.passphrase, minVersion: "TLSv1.2" }, (req, res) =>
      handle(req, res, true).catch(onError(res)),
    );
    secure.requestTimeout = 300_000;
    secure.listen(httpsPort(), "0.0.0.0");
    await once(secure, "listening");
    servers.push(secure);
  }

  console.log("\nVenus Phone is running.");
  if (tls) {
    console.log("\nOn your phone (same Wi-Fi), open:");
    for (const address of lanAddresses()) console.log(`  https://${address.ip}:${httpsPort()}${address.note}`);
    console.log("\nFirst time on a phone? Open the http:// address instead to install the certificate:");
    for (const address of lanAddresses()) if (!address.virtual) console.log(`  http://${address.ip}:${config.port}`);
    console.log(`\nCertificate fingerprint (SHA-256), to check on your phone:\n  ${tls.fingerprint}`);
  } else {
    console.log("\nOn your phone (same Wi-Fi), open:");
    for (const address of lanAddresses()) console.log(`  http://${address.ip}:${config.port}${address.note}`);
    console.log("\nNote: the connection is plain HTTP, so use Wi-Fi you trust.");
    console.log(`Enter your API key on this PC at http://localhost:${config.port} (exactly "localhost"; the 192.168 address won't unlock the key fields).`);
    console.log('For an encrypted connection, set "https": true in app-data/config.json and restart.');
  }
  console.log(`\nOn this PC: http://localhost:${config.port}`);
  console.log("\nOnly devices on your local network are answered. Press Ctrl+C to stop.\n");
  if (process.env.VENUS_VOICE_PRELOAD === "1") void localVoice.load().catch(err => console.error("[voice]", err.message));

  const shutdown = () => {
    calls.stop();
    stopComfy();
    for (const server of servers) server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function firstRunPin(): Promise<void> {
  const fromEnv = process.env.VENUS_PHONE_PIN;
  if (isValidNewPin(fromEnv)) {
    config.pin = hashPin(fromEnv);
    await saveConfig(config);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nFirst run: choose a PIN. ${NEW_PIN_RULE} You'll type it on your phone to unlock the app.`);
  for (;;) {
    const pin = (await rl.question("PIN: ")).trim();
    if (!isValidNewPin(pin)) {
      console.log(NEW_PIN_RULE);
      continue;
    }
    const again = (await rl.question("Same PIN again: ")).trim();
    if (again !== pin) {
      console.log("Those didn't match.");
      continue;
    }
    config.pin = hashPin(pin);
    await saveConfig(config);
    rl.close();
    return;
  }
}

const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|Bluetooth/i;

function httpsPort(): number {
  return Number(process.env.VENUS_PHONE_HTTPS_PORT ?? config.port + 1);
}

/** LAN addresses with their adapter names; real Wi-Fi/Ethernet first, virtual ones flagged. */
function lanAddresses(): Array<{ ip: string; note: string; virtual: boolean }> {
  const found: Array<{ ip: string; note: string; virtual: boolean }> = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal || !isLocalAddress(ni.address)) continue;
      const virtual = VIRTUAL_ADAPTER.test(name);
      found.push({ ip: ni.address, note: `   (${name}${virtual ? " — virtual adapter, your phone can't reach this" : ""})`, virtual });
    }
  }
  return found.sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

function isLoopback(address: string | undefined): boolean {
  const a = (address ?? "").replace(/^::ffff:/, "");
  return a === "127.0.0.1" || a === "::1";
}

// ---- Request handling ----------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse, secure: boolean): Promise<void> {
  // Anything not on the local network gets nothing at all.
  if (!isLocalAddress(req.socket.remoteAddress)) {
    req.socket.destroy();
    return;
  }
  // Only requests addressed to this PC by its own name or address (stops DNS rebinding).
  if (!isOwnHost(req.headers.host, localNames(), [config.port, httpsPort()])) {
    res.writeHead(421, { "Content-Type": "text/plain" });
    res.end("This address isn't served here.");
    return;
  }
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

  const url = new URL(req.url ?? "/", "http://local");
  const method = req.method ?? "GET";
  const loopback = isLoopback(req.socket.remoteAddress);

  // Over plain HTTP, other devices only get the certificate setup; everything else moves to HTTPS.
  if (!secure && !loopback && tls) {
    if (url.pathname === "/venus-phone-ca.cer") {
      res.writeHead(200, {
        "Content-Type": "application/x-x509-ca-cert",
        "Content-Disposition": 'attachment; filename="venus-phone-ca.cer"',
        "Content-Length": tls.caCer.length,
        "Cache-Control": "no-store",
      });
      res.end(tls.caCer);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/setup") return sendSetupPage(req, res);
    if (url.pathname === "/app.css" || url.pathname === "/icon.svg") return serveStatic(url.pathname, res);
    return redirectToHttps(req, res, url);
  }

  if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);
  res.setHeader("Cache-Control", "no-store");
  if (method !== "GET" && !sameOrigin(req, secure)) return sendJson(res, 403, { error: "Cross-site request refused." });

  const ip = req.socket.remoteAddress ?? "";
  const route = `${method} ${url.pathname}`;

  if (route === "POST /api/login") {
    const locked = loginLockedFor(ip);
    if (locked > 0) return sendJson(res, 429, { error: `Too many tries. Wait ${Math.ceil(locked / 1000)} seconds.` });
    const release = admitLogin(ip);
    if (!release) return sendJson(res, 429, { error: "Too many login requests. Try again shortly." });
    try {
      const body = await readJson(req);
      const remaining = loginLockedFor(ip);
      if (remaining > 0) return sendJson(res, 429, { error: `Too many tries. Wait ${Math.ceil(remaining / 1000)} seconds.` });
      if (!config.pin || !isPinAttempt(body.pin) || !checkPin(body.pin, config.pin)) {
        recordLoginFailure(ip);
        return sendJson(res, 401, { error: "Wrong PIN." });
      }
      clearLoginFailures(ip);
      res.setHeader("Set-Cookie", sessionCookie(createSession(), secure));
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      if (err instanceof BodyError) return sendJson(res, 400, { error: err.message });
      throw err;
    } finally { release(); }
  }

  const token = sessionOf(req);
  if (route === "GET /api/status") {
    if (!token) return sendJson(res, 200, { authed: false });
    return sendJson(res, 200, await status());
  }
  if (!token) return sendJson(res, 401, { error: "Locked. Enter your PIN." });

  try {
    if (route === "POST /api/logout") {
      await calls.logout(token);
      endSession(token);
      res.setHeader("Set-Cookie", clearedCookie(secure));
      return sendJson(res, 200, { ok: true });
    }
    if (route === "GET /api/voice/status") return sendJson(res, 200, localVoice.status());
    if (route === "POST /api/voice/load") { await readJson(req); return sendJson(res, 200, await localVoice.load()); }
    if (route === "GET /api/voice/voices") return sendJson(res, 200, await localVoice.request("voices"));
    if (route === "POST /api/voice/add") {
      const body = await readJson(req, 6 * 1024 * 1024);
      if (typeof body.audio !== "string" || typeof body.name !== "string") throw new PhoneError("Choose a WAV voice reference.");
      return sendJson(res, 200, await localVoice.request("add_voice", { audio: body.audio, name: body.name.slice(0, 80) }));
    }
    if (route === "POST /api/voice/test") {
      const body = await readJson(req);
      if (!localVoice.status().ready) throw new PhoneError("Load the voice models first.", 503);
      if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 300) throw new PhoneError("Enter up to 300 characters to preview.");
      return sendJson(res, 200, await localVoice.request("speak", { text: body.text, voice: typeof body.voice === "string" ? body.voice : "default" }));
    }
    if (route === "POST /api/calls/start") {
      const body = await readJson(req);
      if (typeof body.charId !== "string") throw new PhoneError("Choose a contact.");
      return sendJson(res, 200, await calls.start(token, body.charId, typeof body.voice === "string" ? body.voice : "default"));
    }
    const voiceRoute = /^\/api\/calls\/([a-f0-9-]{36})\/(heartbeat|turn|audio|ack|interrupt|transcribe|end)$/.exec(url.pathname);
    if (method === "POST" && voiceRoute?.[1]) {
      const body = await readJson(req, voiceRoute[2] === "transcribe" ? 6 * 1024 * 1024 : MAX_BODY);
      const id = voiceRoute[1];
      let result: unknown;
      switch (voiceRoute[2]) {
        case "heartbeat": result = calls.heartbeat(token, id); break;
        case "end": result = await calls.end(token, id); break;
        case "interrupt": result = await calls.interrupt(token, id); break;
        case "turn": result = await calls.turn(token, id, typeof body.text === "string" ? body.text : "", body.opening === true, await llmSettings(false)); break;
        case "audio": result = await calls.audio(token, id, String(body.replyId), Number(body.index)); break;
        case "ack": result = await calls.ack(token, id, String(body.replyId), Number(body.index)); break;
        case "transcribe":
          if (typeof body.audio !== "string") throw new PhoneError("No microphone audio received.");
          result = await calls.transcribe(token, id, body.audio); break;
      }
      return sendJson(res, 200, result);
    }
    if (route === "GET /api/browse") return sendJson(res, 200, await browse(url.searchParams.get("path") ?? ""));
    if (route === "GET /api/playthroughs") {
      const files = new GameFiles(config.gameDir);
      return sendJson(res, 200, { playthroughs: await files.listPlaythroughs() });
    }
    if (route === "POST /api/session") {
      const body = await readJson(req);
      if (typeof body.playthroughId !== "string" || typeof body.saveId !== "string") {
        return sendJson(res, 400, { error: "Pick a save." });
      }
      await phone.choose(body.playthroughId, body.saveId, body.discard === true);
      return sendJson(res, 200, await status());
    }
    if (route === "GET /api/contacts") return sendJson(res, 200, { contacts: phone.contacts() });
    if (route === "POST /api/sync") {
      const body = await readJson(req);
      return sendJson(res, 200, await phone.sync(typeof body.confirmedTarget === "string" ? body.confirmedTarget : undefined));
    }
    if (route === "GET /api/settings") return sendJson(res, 200, publicSettings());
    if (route === "POST /api/settings") {
      const body = await readJson(req);
      // API keys only travel over an encrypted connection, or never leave this PC.
      const sendsKey = ["geminiKey", "openrouterKey"].some((k) => typeof body[k] === "string" && (body[k] as string).trim());
      if (sendsKey && !secure && !loopback) {
        return sendJson(res, 403, {
          error: `For safety, enter API keys on the PC itself: open http://localhost:${config.port} there. (Or turn on HTTPS.)`,
        });
      }
      await updateSettings(body);
      return sendJson(res, 200, publicSettings());
    }
    if (route === "POST /api/pin") {
      const body = await readJson(req);
      const locked = loginLockedFor(ip);
      if (locked > 0) return sendJson(res, 429, { error: `Too many tries. Wait ${Math.ceil(locked / 1000)} seconds.` });
      if (!config.pin || !isPinAttempt(body.current) || !checkPin(body.current, config.pin)) {
        recordLoginFailure(ip);
        return sendJson(res, 401, { error: "Current PIN is wrong." });
      }
      if (!isValidNewPin(body.next)) return sendJson(res, 400, { error: NEW_PIN_RULE });
      if (settingsUpdating) throw new PhoneError("Wait for settings to finish saving.", 409);
      settingsUpdating = true;
      try {
        const next = { ...config, pin: hashPin(body.next) };
        await saveConfig(next);
        config = next;
      } finally { settingsUpdating = false; }
      endAllSessions();
      res.setHeader("Set-Cookie", sessionCookie(createSession(), secure));
      return sendJson(res, 200, { ok: true });
    }

    if (route === "GET /api/notices") {
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      return sendJson(res, 200, { notices: phone.noticesSince(since), unread: phone.unreadTotal(), now: Date.now() });
    }

    const chat = /^\/api\/chats\/([A-Za-z0-9-]{1,64})(\/send|\/incoming|\/delete|\/regenerate|\/unblock)?$/.exec(url.pathname);
    if (chat?.[1]) {
      const charId = chat[1];
      const pt = phone.playthroughId();
      if (method === "POST" && chat[2] === "/unblock") {
        await readJson(req);
        const thread = await phone.unblock(charId, await llmSettings(false));
        return sendJson(res, 200, { ...thread, incoming: pt ? incomingSetting(pt, charId) : null });
      }
      if (method === "POST" && (chat[2] === "/delete" || chat[2] === "/regenerate")) {
        const body = await readJson(req);
        if (typeof body.id !== "string" || !body.id || body.id.length > 200) return sendJson(res, 400, { error: "Choose a message." });
        const thread = chat[2] === "/delete"
          ? await phone.deleteMessage(charId, body.id)
          : await phone.regenerate(charId, body.id, await llmSettings(false), { enabled: config.photos, explicit: config.explicitPhotos });
        return sendJson(res, 200, { ...thread, incoming: pt ? incomingSetting(pt, charId) : null });
      }
      if (method === "GET" && !chat[2]) {
        const thread = phone.thread(charId);
        await phone.markRead(charId);
        return sendJson(res, 200, { ...thread, incoming: pt ? incomingSetting(pt, charId) : null });
      }
      if (method === "POST" && chat[2] === "/incoming") {
        const body = await readJson(req);
        const every = Number(body.everyMinutes);
        const max = Number(body.maxUnanswered);
        if (!pt || !(INCOMING_CHOICES as readonly number[]).includes(every)) return sendJson(res, 400, { error: "Pick how often." });
        if (!(MAX_CHOICES as readonly number[]).includes(max)) return sendJson(res, 400, { error: "Pick 1 to 10 texts." });
        phone.thread(charId); // validates the contact
        await setIncoming(pt, charId, every, max);
        return sendJson(res, 200, { incoming: incomingSetting(pt, charId) });
      }
      if (method === "POST" && chat[2] === "/send") {
        const body = await readJson(req, MAX_SEND_BODY);
        if (typeof body.text !== "string") return sendJson(res, 400, { error: "Type a message first." });
        const image = imageOf(body.image);
        const thread = await phone.send(
          charId,
          body.text,
          await llmSettings(Boolean(image)),
          { enabled: config.photos, explicit: config.explicitPhotos },
          image,
        );
        return sendJson(res, 200, { ...thread, incoming: pt ? incomingSetting(pt, charId) : null });
      }
    }
    const upload = /^\/api\/upload\/([A-Za-z0-9-]{1,64})\/([0-9a-f.-]{1,64}(?:jpg|png|webp))$/.exec(url.pathname);
    if (method === "GET" && upload?.[1] && upload[2]) return sendFile(res, await phone.uploadPath(upload[1], upload[2]), true);
    const photo = /^\/api\/photo\/([A-Za-z0-9-]{1,64})\/([a-z0-9_.]{1,64})$/.exec(url.pathname);
    if (method === "GET" && photo?.[1] && photo[2]) return sendFile(res, await phone.photoPath(photo[1], photo[2]), true);
    const avatar = /^\/api\/avatar\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname);
    if (method === "GET" && avatar?.[1]) {
      const file = await phone.avatarPath(avatar[1]);
      if (!file) return sendJson(res, 404, { error: "No picture." });
      return sendFile(res, file, true);
    }
    return sendJson(res, 404, { error: "Not found." });
  } catch (err) {
    if (err instanceof PhoneError) return sendJson(res, err.status, { error: err.message });
    if (err instanceof LlmError) return sendJson(res, 502, { error: err.message });
    if (err instanceof BodyError) return sendJson(res, 400, { error: err.message });
    throw err;
  }
}

/**
 * Folder picker for the game folder: lists folder names only (never file contents), on this PC.
 * Only reachable after the PIN, like every other API call.
 */
async function browse(raw: string) {
  const home = homedir();
  if (!raw.trim()) {
    const places: Array<{ name: string; path: string }> = [];
    for (const name of ["Desktop", "Downloads", "Documents", "Games"]) {
      const full = path.join(home, name);
      if (await isDir(full)) places.push({ name, path: full });
    }
    if (process.platform === "win32") {
      for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
        const root = `${letter}:\\`;
        if (await isDir(root)) places.push({ name: `${letter}: drive`, path: root });
      }
    } else {
      places.push({ name: "/", path: "/" });
    }
    return { path: "", parent: null, folders: places, gameDir: null };
  }
  const dir = path.resolve(raw.trim());
  let names: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    names = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("$"))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    throw new BodyError("That folder can't be opened.");
  }
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? "" : parent,
    folders: names.slice(0, 500).map((name) => ({ name, path: path.join(dir, name) })),
    gameDir: await GameFiles.resolveGameDir(dir),
  };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function status() {
  const hasKey = config.provider === "gemini" ? Boolean(config.geminiKeyEnc) : Boolean(config.openrouterKeyEnc);
  return {
    authed: true,
    https: Boolean(tls),
    gameReady: await new GameFiles(config.gameDir).exists(),
    hasKey,
    unread: phone.unreadTotal(),
    gameRunning: await isGameRunning(),
    session: phone.info(),
  };
}

function imageOf(raw: unknown): { mimeType: string; data: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { mimeType, data } = raw as Record<string, unknown>;
  if (typeof mimeType !== "string" || typeof data !== "string" || !data) return undefined;
  return { mimeType, data };
}

/** Photo messages use the compatible provider's image-capable model override when one is set. */
async function llmSettings(withImage: boolean): Promise<LlmSettings> {
  const snapshot = config;
  const gemini = snapshot.provider === "gemini";
  const openrouterModel = withImage && snapshot.openrouterVisionModel.trim() ? snapshot.openrouterVisionModel : snapshot.openrouterModel;
  return {
    provider: snapshot.provider,
    model: gemini ? snapshot.geminiModel : openrouterModel,
    apiKey: await decryptSecret(gemini ? snapshot.geminiKeyEnc : snapshot.openrouterKeyEnc),
    thinking: snapshot.thinking,
    endpointUrl: snapshot.endpointUrl,
  };
}

function publicSettings() {
  return {
    gameDir: config.gameDir,
    provider: config.provider,
    geminiModel: config.geminiModel,
    openrouterModel: config.openrouterModel,
    openrouterVisionModel: config.openrouterVisionModel,
    endpointUrl: config.endpointUrl,
    thinking: config.thinking,
    hasGeminiKey: Boolean(config.geminiKeyEnc),
    hasOpenrouterKey: Boolean(config.openrouterKeyEnc),
    photos: config.photos,
    explicitPhotos: config.explicitPhotos,
  };
}

const PROVIDERS: Provider[] = ["gemini", "openrouter"];
const THINKING: ThinkingLevel[] = ["minimal", "low", "medium", "high"];
let settingsUpdating = false;

async function updateSettings(body: Record<string, unknown>): Promise<void> {
  if (settingsUpdating) throw new PhoneError("Wait for settings to finish saving.", 409);
  settingsUpdating = true;
  try { await commitSettings(body); }
  finally { settingsUpdating = false; }
}

async function commitSettings(body: Record<string, unknown>): Promise<void> {
  const next = { ...config };
  const text = (value: unknown, max = 300) => (typeof value === "string" ? value.trim().slice(0, max) : undefined);
  if (PROVIDERS.includes(body.provider as Provider)) next.provider = body.provider as Provider;
  if (THINKING.includes(body.thinking as ThinkingLevel)) next.thinking = body.thinking as ThinkingLevel;
  const geminiModel = text(body.geminiModel, 100);
  if (geminiModel) next.geminiModel = geminiModel;
  const openrouterModel = text(body.openrouterModel, 200);
  if (openrouterModel) next.openrouterModel = openrouterModel;
  const visionModel = text(body.openrouterVisionModel, 200);
  if (visionModel !== undefined) next.openrouterVisionModel = visionModel;
  const endpointUrl = text(body.endpointUrl);
  if (endpointUrl) {
    try {
      next.endpointUrl = validateEndpoint(endpointUrl).href.replace(/\/+$/, "");
    } catch (err) {
      throw new BodyError((err as Error).message);
    }
  }
  const geminiKey = text(body.geminiKey, 500);
  if (geminiKey) next.geminiKeyEnc = await encryptSecret(geminiKey);
  if (body.clearGeminiKey === true) next.geminiKeyEnc = null;
  const openrouterKey = text(body.openrouterKey, 500);
  if (openrouterKey) next.openrouterKeyEnc = await encryptSecret(openrouterKey);
  if (body.clearOpenrouterKey === true) next.openrouterKeyEnc = null;
  if (typeof body.photos === "boolean") next.photos = body.photos;
  if (typeof body.explicitPhotos === "boolean") next.explicitPhotos = body.explicitPhotos;
  const picked = text(body.gameDir, 400);
  if (picked) {
    const gameDir = await GameFiles.resolveGameDir(picked);
    if (!gameDir) throw new BodyError("That isn't a Venus University folder. Pick the game folder, or its data or saves folder.");
    if (gameDir !== config.gameDir) {
      next.gameDir = gameDir;
      await phone.changeGameFiles(new GameFiles(gameDir), () => saveConfig(next));
      config = next;
      return;
    }
  }
  await saveConfig(next);
  config = next;
}

// ---- HTTPS setup ------------------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The PC's address as the phone typed it (already checked by isOwnHost), without the port. */
function hostnameOf(req: IncomingMessage): string {
  return new URL(`http://${req.headers.host ?? "localhost"}`).hostname;
}

function redirectToHttps(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const host = hostnameOf(req);
  res.writeHead(302, { Location: `https://${host.includes(":") ? `[${host}]` : host}:${httpsPort()}${url.pathname}${url.search}` });
  res.end();
}

/** Plain-HTTP page that hands out the CA certificate and explains how to trust it. */
function sendSetupPage(req: IncomingMessage, res: ServerResponse): void {
  const host = hostnameOf(req);
  const secureUrl = `https://${host}:${httpsPort()}/`;
  const fingerprint = tls?.fingerprint ?? "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up Bunnyboard</title><link rel="stylesheet" href="/app.css"></head>
<body><main class="pad stack" style="max-width:640px;margin:0 auto">
<h1>One-time setup</h1>
<p>This app uses an encrypted connection. Your phone needs to trust this PC's certificate once.</p>
<p><a class="primary" href="/venus-phone-ca.cer" download>Download the certificate</a></p>
<h2>iPhone / iPad</h2>
<ol>
<li>Tap <strong>Download the certificate</strong>, then <strong>Allow</strong>.</li>
<li>Open <strong>Settings → General → VPN &amp; Device Management</strong>, tap <strong>Venus Phone Local CA</strong>, and install it.</li>
<li>Open <strong>Settings → General → About → Certificate Trust Settings</strong> and turn on <strong>Venus Phone Local CA</strong>.</li>
</ol>
<h2>Android</h2>
<ol>
<li>Download the certificate.</li>
<li>Open <strong>Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate</strong> and pick the file.</li>
</ol>
<p>Before trusting it, check that its SHA-256 fingerprint matches the one the PC printed:</p>
<p><code style="word-break:break-all">${escapeHtml(fingerprint)}</code></p>
<p><a class="primary" href="${escapeHtml(secureUrl)}">Open Bunnyboard securely</a></p>
<p class="muted">Bookmark ${escapeHtml(secureUrl)} from now on.</p>
</main></body></html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    // This one page has a little inline styling; nothing runs on it.
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(html);
}

// ---- Plumbing ------------------------------------------------------------------------------------

class BodyError extends Error {}

function readJson(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { reject(new BodyError("Request body timed out.")); req.destroy(); }, 30_000).unref();
    const cleanup = () => clearTimeout(timer);
    req.once("aborted", () => { cleanup(); reject(new BodyError("Request aborted.")); });
    req.once("close", () => { cleanup(); reject(new BodyError("Request closed.")); });
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        cleanup();
        reject(new BodyError("That request is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      cleanup();
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new BodyError("That request was not valid JSON."));
      }
    });
    req.on("error", err => { cleanup(); reject(err); });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function sendFile(res: ServerResponse, file: string, privateCache = false): Promise<void> {
  const stat = await fs.stat(file);
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": stat.size,
    // The app's own page, script and styles are never cached, so updates show up on the next
    // load (iOS Safari otherwise keeps serving an old copy). Photos can be cached.
    "Cache-Control": privateCache ? "private, max-age=3600" : "no-store, must-revalidate",
  });
  createReadStream(file).pipe(res);
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: "Not found." });
  try {
    if (!(await fs.stat(full)).isFile()) throw new Error("not a file");
  } catch {
    return sendJson(res, 404, { error: "Not found." });
  }
  return sendFile(res, full);
}

main().catch((err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(`\nPort ${err.port} is already in use. If Venus Phone is running, open http://localhost:${config?.port ?? err.port}.`);
    console.error("Use stop-voice.cmd to stop this experimental build before restarting it.\n");
  } else console.error(err);
  process.exit(1);
});


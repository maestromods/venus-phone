import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Phone, PhoneError } from "./phone.js";
import { completeStructured, type LlmSettings } from "./llm.js";
import { buildTextingPrompt } from "./texting/prompt.js";

/** Private stdio transport: the Python worker never opens a network port. */
export class LocalVoice {
  private child?: ChildProcessWithoutNullStreams;
  private requests = new Map<string, { resolve(value: any): void; reject(reason: Error): void; timer: NodeJS.Timeout }>();
  private ready = false;
  private starting = false;
  private detail = "Voice models are not loaded yet.";
  private device = "";
  status() { return { installed: existsSync(this.python()), ready: this.ready, loading: this.starting, detail: this.detail, device: this.device }; }
  private python() { return process.env.VENUS_VOICE_PYTHON || path.resolve("voice/.venv/Scripts/python.exe"); }
  private start() {
    if (this.child) return;
    if (!existsSync(this.python())) throw new PhoneError("Run setup-voice.cmd in the experimental build first.", 503);
    const root = path.resolve("voice");
    const child = spawn(this.python(), ["-u", path.join(root, "worker.py")], {
      windowsHide: true,
      env: { ...process.env, HF_HOME: path.join(root, "models"), HF_HUB_DISABLE_XET: "1", HF_HUB_DISABLE_SYMLINKS_WARNING: "1", TORCH_HOME: path.join(root, "models/torch"), NUMBA_CACHE_DIR: path.join(root, "cache/numba"), PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", line => {
      try {
        const msg = JSON.parse(line);
        const pending = this.requests.get(msg.id);
        if (!pending) return;
        this.requests.delete(msg.id); clearTimeout(pending.timer);
        if (msg.error) pending.reject(new PhoneError(msg.error, 503)); else pending.resolve(msg.result);
      } catch { /* Third-party progress output is never interpreted as a response. */ }
    });
    child.stderr.on("data", data => process.stderr.write(`[voice] ${data}`));
    const stopped = () => {
      if (this.child !== child) return;
      this.child = undefined; this.ready = false; this.starting = false;
      for (const req of this.requests.values()) { clearTimeout(req.timer); req.reject(new PhoneError("The voice worker stopped. Load the models again.", 503)); }
      this.requests.clear();
    };
    child.on("exit", stopped); child.on("error", stopped);
  }
  request(method: string, params: unknown = {}, signal?: AbortSignal): Promise<any> {
    this.start();
    if (signal?.aborted) return Promise.reject(new PhoneError("Call interrupted.", 409));
    if (this.requests.size >= 8) return Promise.reject(new PhoneError("The voice worker is busy. Try again shortly.", 429));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = () => signal?.removeEventListener("abort", cancel);
      const cancel = () => {
        const pending = this.requests.get(id);
        if (!pending) return;
        clearTimeout(pending.timer); this.requests.delete(id); finish();
        this.child?.stdin.write(JSON.stringify({ id: randomUUID(), method: "cancel", params: { id } }) + "\n");
        reject(new PhoneError("Call interrupted.", 409));
      };
      const timer = setTimeout(() => { cancel(); }, method === "load" ? 20 * 60_000 : 120_000);
      this.requests.set(id, { timer, resolve: value => { finish(); resolve(value); }, reject: err => { finish(); reject(err); } });
      signal?.addEventListener("abort", cancel, { once: true });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async load() {
    if (this.ready || this.starting) return this.status();
    this.starting = true; this.detail = "Loading Chatterbox Turbo and Whisper. First run downloads the models.";
    void this.request("load").then(result => {
      this.ready = true; this.device = result.device; this.detail = "Local voice is ready.";
      console.log(`[voice] Local voice is ready on ${this.device}.`);
    }).catch(err => {
      this.detail = err.message;
      console.error(`[voice] Could not load local voice: ${err.message}`);
    }).finally(() => { this.starting = false; });
    return this.status();
  }
  stop() {
    const child = this.child;
    if (!child) return;
    // Windows virtualenv launchers spawn the real interpreter as a child.
    if (process.platform === "win32" && child.pid) execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    else child.kill();
  }
}

export function speechSegments(text: string): string[] {
  const cleaned = text.replace(/\[(?!chuckle\]|laugh\]|sigh\]|gasp\]|clear throat\]|cough\]|sniff\]|shush\]|groan\])[^\]]*\]/gi, "").replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim().slice(0, 550);
  const chunks: string[] = [];
  let remaining = cleaned;
  while (remaining) {
    if (remaining.length <= 220) { chunks.push(remaining); break; }
    const prefix = remaining.slice(0, 220);
    const matches = [...prefix.matchAll(/[.!?](?:["']?)(?:\s|$)/g)];
    const sentence = matches.at(-1);
    const cut = sentence && sentence.index! > 35 ? sentence.index! + sentence[0].trimEnd().length : Math.max(prefix.lastIndexOf(" "), 1);
    chunks.push(remaining.slice(0, cut).trim()); remaining = remaining.slice(cut).trim();
  }
  if (!chunks.length) throw new PhoneError("She didn't give a spoken reply. Try again.", 502);
  return chunks;
}

type Call = { id: string; owner: string; charId: string; lastSeen: number; controller: AbortController; busy: boolean; ended: boolean; epoch: number; pending?: { id: string; segments: string[]; acknowledged: number; action: string }; voice: string };
export class VoiceCalls {
  private active?: Call;
  private timer = setInterval(() => { if (this.active && Date.now() - this.active.lastSeen > 45_000) void this.end(this.active.owner, this.active.id).catch(console.error); }, 10_000).unref();
  constructor(private phone: Phone, readonly engine: LocalVoice) {}
  private get(owner: string, id: string) {
    const call = this.active;
    if (!call || call.id !== id || call.owner !== owner) throw new PhoneError("This call has ended. Start a new call.", 409);
    call.lastSeen = Date.now(); return call;
  }
  async start(owner: string, charId: string, voice: string) {
    if (this.active) throw new PhoneError("A call is already open. End it first, or wait 45 seconds after closing its tab.", 409);
    if (!this.engine.status().ready) throw new PhoneError("Load the local voice models first.", 503);
    this.phone.reserveVoiceCall(charId);
    const call: Call = { id: randomUUID(), owner, charId, voice, lastSeen: Date.now(), controller: new AbortController(), busy: false, ended: false, epoch: 0 };
    this.active = call;
    try { await this.phone.recordVoice(charId, call.id, "system", "Phone call started."); }
    catch (err) { this.active = undefined; this.phone.releaseVoiceCall(charId); throw err; }
    return { id: call.id, name: this.phone.thread(charId).name };
  }
  heartbeat(owner: string, id: string) { this.get(owner, id); return { ok: true }; }
  async interrupt(owner: string, id: string) {
    const call = this.get(owner, id);
    call.epoch++; call.controller.abort(); call.controller = new AbortController();
    const pending = call.pending; call.pending = undefined; call.busy = false;
    if (pending && pending.acknowledged < pending.segments.length) await this.phone.recordVoice(call.charId, id, "system", "Her spoken reply was interrupted; only completed speech is recorded.");
    return { ended: call.ended };
  }
  async turn(owner: string, id: string, text: string, opening: boolean, llm: LlmSettings) {
    const call = this.get(owner, id);
    if (call.ended) throw new PhoneError("She ended the call.", 409);
    if (call.busy || call.pending) throw new PhoneError("Interrupt or finish her reply before speaking again.", 409);
    if (!opening && !text.trim()) throw new PhoneError("Say or type something first.");
    call.busy = true;
    const epoch = ++call.epoch;
    const signal = call.controller.signal;
    const current = () => this.active === call && call.epoch === epoch && !signal.aborted;
    try {
      if (!opening) await this.phone.recordVoice(call.charId, id, "player", text.trim().slice(0, 2000));
      if (!current()) throw new PhoneError("Call interrupted.", 409);
      const context = await this.phone.voiceContext(call.charId);
      if (!current()) throw new PhoneError("Call interrupted.", 409);
      const background = buildTextingPrompt(context, "", undefined, "Background only").user.split("\nYOUR TURN\n")[0];
      const request = {
        system: "You perform one character in a fictional phone conversation. Speak in her own voice, with her personality, relationship and memories. Return only JSON matching the schema.",
        user: `${background}\n\nLIVE PHONE CALL\n${opening ? "The reader is calling her. Usually she answers with a short, natural greeting. She can decline if their established situation gives her a reason. Do not invent a greeting from the reader." : "Reply to the reader's latest spoken or typed words. The reader may use accessibility typing; treat it as their side of the call."}\nWrite speech, with natural contractions and varied rhythm. Usually 1-3 short sentences, at most 75 words. Occasional um, uh, ah, hmm, a pause or a self-correction is welcome when it fits. Most sentences need no filler. Never add an um or laugh mechanically to every reply. You can use [chuckle], [laugh], [sigh] or [gasp] sparingly. No emoji, stage directions, markdown or descriptions of actions.\nKeep talking freely. No compulsory question, repeated pet names, repeated reassurance, or routine goodnight/goodbye. The save clock is not a bedtime deadline. Let the subject develop; don't invent errands or tiredness to end the call.\nUse action continue normally. Use hangup if the reader says goodbye or an established reason calls for it. Use decline only for an unanswered opening call. Use block only for a convincing in-character reason to cut contact such as harassment, cruelty, threats or repeated boundary violations; ordinary disagreement or a short reply isn't a reason. Blocking ends the call and future texts. She can decline a request without ending the call.\nRecent [phone call] entries are conversation history. Do not claim to remember unheard or interrupted words. speech contains only what she says aloud.`,
        schema: { name: "phone_call_reply", schema: { type: "object", properties: { speech: { type: "string" }, action: { type: "string", enum: ["continue", "hangup", "decline", "block"] } }, required: ["speech", "action"], additionalProperties: false } },
      };
      const raw = await completeStructured(llm, request, signal) as { speech?: unknown; action?: unknown };
      if (!current()) throw new PhoneError("Call interrupted.", 409);
      if (typeof raw?.speech !== "string" || !["continue", "hangup", "decline", "block"].includes(String(raw.action))) throw new PhoneError("The AI returned an invalid call reply. Try again.", 502);
      const segments = speechSegments(raw.speech);
      const action = raw.action === "decline" && !opening ? "hangup" : String(raw.action);
      call.ended = action !== "continue";
      if (action === "block") await this.phone.blockFromVoice(call.charId, id);
      if (!current()) throw new PhoneError("Call interrupted.", 409);
      call.pending = { id: randomUUID(), segments, acknowledged: 0, action };
      return { replyId: call.pending.id, segments, action };
    } finally { if (call.epoch === epoch) call.busy = false; }
  }
  async audio(owner: string, id: string, replyId: string, index: number) {
    const call = this.get(owner, id), pending = call.pending;
    if (!pending || pending.id !== replyId || !Number.isInteger(index) || index < 0 || index >= pending.segments.length) throw new PhoneError("That spoken reply is no longer available.", 409);
    return this.engine.request("speak", { text: pending.segments[index], voice: call.voice }, call.controller.signal);
  }
  async ack(owner: string, id: string, replyId: string, index: number) {
    const call = this.get(owner, id), pending = call.pending;
    if (!pending || pending.id !== replyId) throw new PhoneError("Reply interrupted.", 409);
    if (index < pending.acknowledged) return { ok: true };
    if (index !== pending.acknowledged || index >= pending.segments.length) throw new PhoneError("Speech must be recorded in order.", 409);
    // Increment synchronously so duplicate acknowledgements cannot duplicate a transcript.
    pending.acknowledged++;
    await this.phone.recordVoice(call.charId, id, "contact", pending.segments[index]!);
    if (pending.acknowledged === pending.segments.length && call.pending === pending) call.pending = undefined;
    return { ok: true };
  }
  async transcribe(owner: string, id: string, audio: string) {
    const call = this.get(owner, id);
    if (call.ended) throw new PhoneError("She ended the call.", 409);
    return this.engine.request("transcribe", { audio }, call.controller.signal);
  }
  async end(owner: string, id: string) {
    const call = this.get(owner, id);
    call.controller.abort(); call.epoch++;
    // Keep the reservation until the final transcript write completes.
    try { await this.phone.recordVoice(call.charId, id, "system", "Phone call ended."); }
    finally { if (this.active === call) this.active = undefined; this.phone.releaseVoiceCall(call.charId); }
    return { ok: true };
  }
  async logout(owner: string) { if (this.active?.owner === owner) await this.end(owner, this.active.id); }
  stop() { clearInterval(this.timer); this.active?.controller.abort(); this.engine.stop(); }
}

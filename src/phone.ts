// The phone session: the save you picked, plus everything texted since, kept as a delta in
// ./app-data/session.json so nothing is lost between restarts. The game's files are only written
// on Sync (a new numbered save) and when one of her photos lands in the playthrough's photos folder.
// Photos you send stay in ./app-data/uploads; the game gets a written description of them.

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { renderPhoto } from "./comfy.js";
import { buildPhotoPrompt } from "./photoPrompt.js";
import { APP_DATA_DIR, writeJsonAtomic } from "./config.js";
import { formatDateBanner, seasonOfTerm, type Season } from "./game/calendar.js";
import { GameFiles, isGameRunning, isPhotoFile, SAFE_CHAR_ID, SAFE_NUMERIC_ID } from "./game/files.js";
import { semesterOf } from "./game/semesters.js";
import { emptyFlags, type Character, type ChatMessage, type ChatPhoto, type Conversation, type PlaythroughRecord, type SaveFile } from "./game/types.js";
import { completeStructured, type LlmSettings } from "./llm.js";
import { stripImageMetadata } from "./metadata.js";
import {
  allowedPhotoTier,
  captionForShot,
  isPhotoTier,
  PHOTO_SCHEMA_FIELDS,
  photoPromptLines,
  pickShot,
  settlePhoto,
  shotFromAsk,
  type PhotoSwitches,
  type ShotType,
} from "./texting/photos.js";
import type { PhotoTier } from "./game/types.js";
import {
  buildTextingPrompt,
  INCOMING_DIRECTION,
  UNBLOCK_DIRECTION,
  fitBubbles,
  parseTextingReply,
  pickBubbleCount,
  withoutPhotoNotes,
  READER_PHOTO_MARK,
  readerPhotoNote,
  type ReaderPhoto,
  type TextingImage,
  type TextingReply,
  type TextingRequest,
} from "./texting/prompt.js";

const SESSION_PATH = path.join(APP_DATA_DIR, "session.json");
const UPLOADS_DIR = path.join(APP_DATA_DIR, "uploads");
const UPLOAD_INDEX_PATH = path.join(UPLOADS_DIR, "index.json");
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const UPLOAD_FILE = /^[0-9a-f-]{36}\.(?:jpg|png|webp)$/;

interface Delta {
  /** Message tombstones, also applied when syncing onto a newer save. */
  deleted?: Record<string, string[]>;
  /** New bubbles per girl, in order. */
  added: Record<string, ChatMessage[]>;
  /** Her latest running recap of the thread. */
  summaries: Record<string, string>;
  /** Girls who blocked the reader over the phone. */
  blocked: string[];
  /** Explicit unblocks, including blocks inherited from the game's save. */
  unblocked?: string[];
  /** Her texts you haven't opened yet, per girl; carried into the game's unread badge on sync. */
  unread?: Record<string, number>;
}

interface SessionState {
  playthroughId: string;
  baseSaveId: string;
  baseSaveDate: number;
  baseFingerprint?: string;
  delta: Delta;
  /** Texts she started in a row that you haven't answered, per girl. */
  unanswered?: Record<string, number>;
}

/** Your photos by message id, kept across syncs so the app can still show them. */
type UploadIndex = Record<string, { playthroughId: string; charId: string; file: string; scene: string }>;

const emptyDelta = (): Delta => ({ added: {}, summaries: {}, blocked: [], unread: {} });
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class PhoneError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface IncomingNotice {
  charId: string;
  name: string;
  text: string;
  at: number;
}

export class Phone {
  private state: SessionState | null = null;
  private base: SaveFile | null = null;
  private record: PlaythroughRecord | null = null;
  private characters = new Map<string, Character>();
  private inFlight = new Set<string>();
  private syncing = false;
  private rendering = new Set<string>();
  private uploads: UploadIndex = {};
  /** Recent texts she started, for in-app notifications. */
  private notices: IncomingNotice[] = [];

  constructor(private files: GameFiles) {}

  private assertNotSyncing(): void {
    if (this.syncing) throw new PhoneError("Wait for sync to finish.", 409);
  }

  setGameFiles(files: GameFiles): void {
    this.assertNotSyncing();
    if (this.inFlight.size) throw new PhoneError("Wait for replies before changing the game folder.", 409);
    this.files = files;
    this.state = null;
    this.base = null;
  }

  async restore(): Promise<void> {
    try {
      this.uploads = JSON.parse(await fs.readFile(UPLOAD_INDEX_PATH, "utf8")) as UploadIndex;
    } catch {
      this.uploads = {};
    }
    let saved: SessionState;
    try {
      saved = JSON.parse(await fs.readFile(SESSION_PATH, "utf8")) as SessionState;
      saved.delta.unread ??= {};
      await this.load(saved);
    } catch {
      this.state = null;
      return;
    }
    // Photos that were still rendering when the app last closed.
    for (const [charId, added] of Object.entries(saved.delta.added)) {
      const character = this.characters.get(charId);
      if (!character) continue;
      for (const message of added) {
        if (!message.photo?.pending) continue;
        try {
          await fs.access(path.join(this.files.photosDir(saved.playthroughId, charId), message.photo.file));
          message.photo = { tier: message.photo.tier, scene: message.photo.scene, file: message.photo.file };
        } catch {
          void this.drawPhoto(saved.playthroughId, character, message);
        }
      }
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (this.state) await writeJsonAtomic(SESSION_PATH, this.state);
  }

  private async load(state: SessionState): Promise<void> {
    const base = await this.files.readSave(state.playthroughId, state.baseSaveId);
    const record = await this.files.readRecord(state.playthroughId);
    const characters = new Map<string, Character>();
    for (const charId of semesterOf(record, base.semester).chars) {
      const character = await this.files.readCharacter(charId);
      if (character) characters.set(charId, character);
    }
    this.state = state;
    state.baseFingerprint ??= fingerprint(base);
    this.base = base;
    this.record = record;
    this.characters = characters;
  }

  pendingCount(): number {
    if (!this.state) return 0;
    return Object.values(this.state.delta.added).reduce((n, list) => n + list.length, 0)
      + Object.values(this.state.delta.deleted ?? {}).reduce((n, list) => n + list.length, 0);
  }

  unreadTotal(): number {
    return Object.values(this.state?.delta.unread ?? {}).reduce((n, c) => n + c, 0);
  }

  playthroughId(): string | null {
    return this.state?.playthroughId ?? null;
  }

  info() {
    if (!this.state || !this.base || !this.record) return null;
    return {
      playthroughId: this.state.playthroughId,
      saveId: this.state.baseSaveId,
      player: `${this.record.playerFirstName} ${this.record.playerLastName}`.trim(),
      now: formatDateBanner(this.base.date, this.base.time, this.season()),
      unsynced: this.pendingCount(),
      unread: this.unreadTotal(),
    };
  }

  /** Her texts that arrived after `since` (ms), newest last. */
  noticesSince(since: number): IncomingNotice[] {
    return this.notices.filter((n) => n.at > since);
  }

  /** Starts texting from a save. Refuses to drop unsynced chats unless told to. */
  async choose(playthroughId: string, saveId: string, discard: boolean): Promise<void> {
    this.assertNotSyncing();
    if (this.inFlight.size) throw new PhoneError("Wait for replies before changing saves.", 409);
    if (this.pendingCount() > 0 && !discard) {
      throw new PhoneError("You have chats that are not synced yet. Sync first, or choose again to discard them.", 409);
    }
    const save = await this.files.readSave(playthroughId, saveId);
    await this.load({ playthroughId, baseSaveId: saveId, baseSaveDate: save.saveDate, delta: emptyDelta() });
    this.notices = [];
    await this.persist();
  }

  private season(): Season {
    return seasonOfTerm(this.record ? semesterOf(this.record, this.base?.semester).index : 0);
  }

  private require(): { state: SessionState; base: SaveFile; record: PlaythroughRecord } {
    if (!this.state || !this.base || !this.record) throw new PhoneError("Choose a save first.", 409);
    return { state: this.state, base: this.base, record: this.record };
  }

  /** The picked save with the delta laid over it, as the app shows it. */
  private view(): SaveFile {
    const { base, state, record } = this.require();
    const view = applyDelta(base, state.delta, false);
    // Profiles belong to the record, not the save. Join them only for display and prompts.
    for (const [id, profile] of Object.entries(semesterOf(record, base.semester).profiles)) {
      if (view.charInfo[id]) view.charInfo[id] = { ...profile, ...view.charInfo[id] };
    }
    return view;
  }

  /** Girls you can text in this save. */
  contactIds(): string[] {
    if (!this.state || !this.base || !this.record) return [];
    const save = this.view();
    return semesterOf(this.record, this.base.semester).chars.filter((charId) => this.characters.has(charId) && save.charInfo[charId]?.flags?.gaveContactInfo);
  }

  contacts() {
    const save = this.view();
    const { record, state } = this.require();
    return semesterOf(record, save.semester).chars
      .map((charId) => {
        const character = this.characters.get(charId);
        const info = save.charInfo[charId];
        const flags = info?.flags ?? emptyFlags();
        if (!character || !flags.gaveContactInfo) return null;
        const messages = save.bunnyboard.conversations[charId]?.messages ?? [];
        const last = [...messages].reverse().find((m) => m.sender !== "system") ?? messages[messages.length - 1];
        const hasPhoto = Boolean(last?.photo || this.readerPhotoOf(last));
        return {
          charId,
          name: `${character.firstName} ${character.lastName}`.trim(),
          firstName: character.firstName,
          blocked: flags.blocked,
          lastText: last ? displayText(last) || (hasPhoto ? "📷 Photo" : "") : "",
          lastFromMe: last?.sender === "player",
          busy: this.inFlight.has(charId),
          unread: state.delta.unread?.[charId] ?? 0,
          recency: messageOrder(save, charId),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.recency - a.recency || a.name.localeCompare(b.name))
      .map(({ recency: _recency, ...rest }) => rest);
  }

  private readerPhotoOf(message: ChatMessage | undefined): ReaderPhoto | null {
    if (!message || message.sender !== "player") return null;
    const own = message.readerPhoto as ReaderPhoto | undefined;
    if (own) return own;
    const indexed = this.uploads[message.id];
    return indexed && indexed.playthroughId === this.state?.playthroughId ? { file: indexed.file, scene: indexed.scene } : null;
  }

  /** Opening a thread marks her texts read. */
  async markRead(charId: string): Promise<void> {
    if (this.syncing) return;
    const unread = this.state?.delta.unread;
    if (unread?.[charId]) {
      delete unread[charId];
      await this.persist();
    }
  }

  thread(charId: string) {
    const character = this.characterOf(charId);
    const save = this.view();
    const messages = save.bunnyboard.conversations[charId]?.messages ?? [];
    const season = this.season();
    return {
      charId,
      name: `${character.firstName} ${character.lastName}`.trim(),
      blocked: save.charInfo[charId]?.flags?.blocked ?? false,
      busy: this.inFlight.has(charId),
      messages: messages.map((m) => {
        const mine = this.readerPhotoOf(m);
        return {
          id: m.id,
          canRegenerate: m.id === this.regenerationTarget(messages)?.id && !(save.charInfo[charId]?.flags?.blocked),
          sender: m.sender,
          text: displayText(m),
          stamp: formatDateBanner(m.date, m.time, season),
          photo: m.photo
            ? {
                file: m.photo.file,
                pending: Boolean(m.photo.pending) || this.rendering.has(m.id),
                failed: Boolean(m.photo.failed),
                scene: m.photo.scene,
              }
            : null,
          upload: mine ? { file: mine.file, scene: mine.scene } : null,
          reaction: typeof m.exReaction === "string" ? m.exReaction : null,
        };
      }),
    };
  }

  private characterOf(charId: string): Character {
    if (!SAFE_CHAR_ID.test(charId)) throw new PhoneError("Unknown contact.", 404);
    const character = this.characters.get(charId);
    if (!character) throw new PhoneError("Unknown contact.", 404);
    return character;
  }

  /** Only the latest reply can be replaced without invalidating later conversation. */
  private regenerationTarget(messages: ChatMessage[]): ChatMessage | undefined {
    const last = messages[messages.length - 1];
    return last?.sender === "contact" ? last : undefined;
  }

  async deleteMessage(charId: string, id: string) {
    this.assertNotSyncing();
    this.characterOf(charId);
    const { state } = this.require();
    if (this.inFlight.has(charId)) throw new PhoneError("Wait for the reply before editing messages.", 409);
    const message = this.view().bunnyboard.conversations[charId]?.messages.find((m) => m.id === id);
    if (!message) throw new PhoneError("Message not found.", 404);
    if (message.sender === "system") throw new PhoneError("System notices cannot be deleted.");
    this.removeMessages(charId, [id]);
    await this.persist();
    return this.thread(charId);
  }

  private removeMessages(charId: string, ids: string[]): void {
    const { state } = this.require();
    const deleted = (state.delta.deleted ??= {});
    deleted[charId] = [...new Set([...(deleted[charId] ?? []), ...ids])];
    state.delta.added[charId] = (state.delta.added[charId] ?? []).filter((m) => !ids.includes(m.id));
    // A recap may contain removed text. Clear it so future prompts use the surviving messages.
    state.delta.summaries[charId] = "";
    if (state.unanswered) delete state.unanswered[charId];
    if (state.delta.unread) delete state.delta.unread[charId];
    this.notices = this.notices.filter((n) => n.charId !== charId);
  }

  async regenerate(charId: string, id: string, llm: LlmSettings, photoSwitches: PhotoSwitches = { enabled: false, explicit: false }) {
    const { state } = this.require();
    const character = this.characterOf(charId);
    const save = this.view();
    this.assertCanText(charId, save, character);
    // Keep the replaced photo's filename reserved, even if its old render is still pending.
    const originalSave = structuredClone(save);
    const conversation = save.bunnyboard.conversations[charId];
    if (!conversation || this.regenerationTarget(conversation.messages)?.id !== id) {
      throw new PhoneError("Only the latest reply can be regenerated.", 409);
    }
    const messages = conversation.messages;
    const last = messages[messages.length - 1]!;
    let start = messages.length - 1;
    if (last.exPhoneTurn) {
      while (start > 0 && messages[start - 1]?.exPhoneTurn === last.exPhoneTurn) start--;
    } else if (last.exIncomingTurn) {
      while (start > 0 && messages[start - 1]?.exIncomingTurn === last.exIncomingTurn) start--;
    } else {
      while (start > 0 && messages[start - 1]?.sender === "contact" && !messages[start - 1]?.exIncomingTurn) start--;
    }
    const removed = messages.slice(start);
    const originalPhoto = [...removed].reverse().find((m) => m.photo)?.photo;
    let allowedPhoto: PhotoTier = "none";
    if (originalPhoto) {
      if (!photoSwitches.enabled) throw new PhoneError("Enable photos in Settings to regenerate this photo reply. The original reply has been kept.");
      const possible = allowedPhotoTier(character, save.charInfo[charId], save.date, photoSwitches);
      const originalAllowed = settlePhoto({ sendPhoto: true, photoPrompt: originalPhoto.scene, stated: originalPhoto.tier, allowed: possible });
      if (!originalAllowed.send) throw new PhoneError("This photo is outside the current photo settings or relationship limits. The original reply has been kept.");
      allowedPhoto = originalAllowed.tier;
    }
    conversation.messages = messages.slice(0, start);
    conversation.summary = null;
    const sent = conversation.messages[conversation.messages.length - 1];
    const incoming = Boolean(last.exIncomingTurn) || sent?.sender !== "player";
    if (!incoming) conversation.messages.pop();
    const text = !incoming && sent ? sent.text + (this.readerPhotoOf(sent) ? ` ${readerPhotoNote(this.readerPhotoOf(sent)!.scene)}` : "") : "";
    const photoShot = shotFromAsk(text) ?? (originalPhoto ? shotFromAsk(originalPhoto.scene) : null) ?? pickShot();
    const bubbles = pickBubbleCount(text);
    const request = buildTextingPrompt(
      { ...this.promptContext(save, character, allowedPhoto, Boolean(originalPhoto)), bubbles, photoShot, replacementPhoto: originalPhoto },
      text, undefined, incoming ? INCOMING_DIRECTION : undefined,
    );
    request.user += "\nREGENERATION\nWrite a fresh alternative with different wording and a different conversational beat. This replaces the previous reply. Do not mention regeneration.";
    this.inFlight.add(charId);
    try {
      const initial = cleanReply(parseTextingReply(await completeStructured(llm, request)), allowedPhoto);
      initial.messages = fitBubbles(initial.messages, bubbles);
      initial.photoPrompt = captionForShot(initial.photoPrompt, photoShot);
      const { reply } = originalPhoto
        ? await this.keepPhotoPromise(llm, request, character, save, initial, allowedPhoto, allowedPhoto, photoShot, true)
        : { reply: initial };
      if (!reply.messages.length) throw new PhoneError("No replacement was returned. Try again.", 502);
      if (originalPhoto && !reply.blocked && !settlePhoto({
        sendPhoto: reply.sendPhoto, photoPrompt: reply.photoPrompt,
        stated: isPhotoTier(reply.photoTier) ? reply.photoTier : undefined, allowed: allowedPhoto,
      }).send) throw new PhoneError("No replacement photo was returned. Your original reply is still here; try regenerating again.", 502);
      if (this.state !== state) throw new PhoneError("The selected save changed. Try again.", 409);
      this.removeMessages(charId, removed.map((m) => m.id));
      if (!incoming && sent) {
        // Drop the old reaction without replacing the player's message identity.
        const original = state.delta.added[charId]?.find((m) => m.id === sent.id);
        if (original) delete original.exReaction;
      }
      await this.file(charId, character, originalSave, [], reply, allowedPhoto, incoming);
      await this.markRead(charId);
    } finally {
      this.inFlight.delete(charId);
    }
    return this.thread(charId);
  }

  /** The hidden profile gesture reopens contact only after her message is ready. */
  async unblock(charId: string, llm: LlmSettings) {
    this.assertNotSyncing();
    const { state } = this.require();
    const character = this.characterOf(charId);
    const save = this.view();
    const flags = save.charInfo[charId]?.flags ?? emptyFlags();
    if (!flags.gaveContactInfo) throw new PhoneError(`${character.firstName} hasn't given you her number.`, 403);
    if (this.inFlight.has(charId)) throw new PhoneError(`${character.firstName} is still replying.`, 409);
    if (!flags.blocked) throw new PhoneError(`${character.firstName} hasn't blocked you.`, 409);
    const request = buildTextingPrompt(
      { ...this.promptContext(save, character, "none", false), bubbles: 1, unblocking: true },
      "", undefined, UNBLOCK_DIRECTION,
    );
    this.inFlight.add(charId);
    try {
      const reply = cleanReply(parseTextingReply(await completeStructured(llm, request)), "none");
      if (!reply.messages.length || reply.blocked) throw new PhoneError("No unblock message was returned. Try the profile gesture again.", 502);
      if (this.state !== state) throw new PhoneError("The selected save changed. Try again.", 409);
      reply.messages = fitBubbles(reply.messages, 1);
      await this.file(charId, character, save, [], reply, "none", true, true);
    } finally {
      this.inFlight.delete(charId);
    }
    return this.thread(charId);
  }

  private assertCanText(charId: string, save: SaveFile, character: Character): void {
    this.assertNotSyncing();
    const flags = save.charInfo[charId]?.flags ?? emptyFlags();
    if (!flags.gaveContactInfo) throw new PhoneError(`${character.firstName} hasn't given you her number.`, 403);
    if (flags.blocked) throw new PhoneError(`${character.firstName} has you blocked.`, 403);
    if (this.inFlight.has(charId)) throw new PhoneError(`${character.firstName} is still replying.`, 409);
  }

  /** Sends the reader's text (and photo) and waits for her reply. Her photo, if any, renders afterwards. */
  async send(charId: string, text: string, llm: LlmSettings, photoSwitches: PhotoSwitches, image?: TextingImage) {
    const { state } = this.require();
    const character = this.characterOf(charId);
    const trimmed = text.trim().slice(0, 2000);
    if (!trimmed && !image) throw new PhoneError("Type a message first.");
    const save = this.view();
    this.assertCanText(charId, save, character);

    // The cleaned photo is what gets stored and what the AI sees.
    let upload: { file: string; bytes: Buffer } | null = null;
    if (image) {
      upload = { file: `${randomUUID()}.${extensionOf(image)}`, bytes: checkedImage(image) };
      image = { mimeType: image.mimeType, data: upload.bytes.toString("base64") };
    }

    this.inFlight.add(charId);
    try {
      // She only considers a picture when he asks for one (or answers her offer of one), or now
      // and then on her own.
      const history = save.bunnyboard.conversations[charId]?.messages ?? [];
      const requested = photoRequested(trimmed, history);
      const spontaneous = !requested && !sentPhotoRecently(history) && Math.random() < SPONTANEOUS_PHOTO_CHANCE;
      const possiblePhoto = allowedPhotoTier(character, save.charInfo[charId], save.date, photoSwitches);
      const allowedPhoto = requested || spontaneous ? possiblePhoto : "none";
      // Now and then she may react to his text, and not if she reacted to one of his last few.
      const offerReaction = Boolean(trimmed) && !reactedRecently(history) && Math.random() < REACTION_CHANCE;
      // The kind of shot he asked for, if he named one; otherwise a varied pick.
      const photoShot = shotFromAsk(trimmed) ?? pickShot();
      const bubbles = pickBubbleCount(trimmed);
      const request = buildTextingPrompt(
        { ...this.promptContext(save, character, allowedPhoto, requested), offerReaction, photoShot, bubbles },
        trimmed,
        image,
      );
      const initial = cleanReply(parseTextingReply(await completeStructured(llm, request)), allowedPhoto);
      initial.messages = fitBubbles(initial.messages, bubbles);
      initial.photoPrompt = captionForShot(initial.photoPrompt, photoShot);
      if (initial.messages.length === 0) throw new PhoneError(`${character.firstName} didn't answer. Try again.`, 502);
      const kept = await this.keepPhotoPromise(llm, request, character, save, initial, allowedPhoto, possiblePhoto, photoShot, requested);
      const reply = kept.reply;

      const sent: ChatMessage = { id: randomUUID(), sender: "player", text: trimmed, date: save.date, time: save.time };
      // Kept as an "ex" field, the convention the game's community mods use for extra data.
      if (offerReaction && reply.reaction) sent.exReaction = reply.reaction;
      if (upload) {
        const dir = this.uploadDir(state.playthroughId, charId);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, upload.file), upload.bytes);
        const scene = reply.readerPhotoDescription || "a photo";
        sent.readerPhoto = { file: upload.file, scene } satisfies ReaderPhoto;
        this.uploads[sent.id] = { playthroughId: state.playthroughId, charId, file: upload.file, scene };
        await writeJsonAtomic(UPLOAD_INDEX_PATH, this.uploads);
      }
      if (state.unanswered) delete state.unanswered[charId];
      await this.file(charId, character, save, [sent], reply, kept.allowed, false);
      return this.thread(charId);
    } finally {
      this.inFlight.delete(charId);
    }
  }

  /**
   * She texts first, unprompted. Returns false when she can't right now (blocked, already
   * replying, or she's already waiting on an answer to two texts in a row).
   */
  async incoming(charId: string, llm: LlmSettings, photoSwitches: PhotoSwitches, maxUnanswered = 1): Promise<boolean> {
    if (!this.state || !this.base) return false;
    const character = this.characters.get(charId);
    if (!character) return false;
    const save = this.view();
    try {
      this.assertCanText(charId, save, character);
    } catch {
      return false;
    }
    const history = save.bunnyboard.conversations[charId]?.messages ?? [];
    // She stops once she has started this many texts in a row without an answer. The thread is
    // counted too, so this holds after a restart or sync, and for texts from the game.
    const limit = Math.min(10, Math.max(1, maxUnanswered));
    const started = Math.max(this.state.unanswered?.[charId] ?? 0, unansweredOpeners(history));
    if (started >= limit) return false;

    this.inFlight.add(charId);
    try {
      const spontaneous = !sentPhotoRecently(history) && Math.random() < SPONTANEOUS_PHOTO_CHANCE;
      const possiblePhoto = allowedPhotoTier(character, save.charInfo[charId], save.date, photoSwitches);
      const allowedPhoto = spontaneous ? possiblePhoto : "none";
      const photoShot = pickShot();
      // Texting first is usually one or two texts.
      const bubbles = Math.min(2, pickBubbleCount());
      const request = buildTextingPrompt(
        { ...this.promptContext(save, character, allowedPhoto, false), photoShot, bubbles },
        "",
        undefined,
        INCOMING_DIRECTION,
      );
      const initial = cleanReply(parseTextingReply(await completeStructured(llm, request)), allowedPhoto);
      initial.messages = fitBubbles(initial.messages, bubbles);
      initial.photoPrompt = captionForShot(initial.photoPrompt, photoShot);
      if (initial.messages.length === 0) return false;
      const kept = await this.keepPhotoPromise(llm, request, character, save, initial, allowedPhoto, possiblePhoto, photoShot, false);
      const reply = kept.reply;
      const unanswered = (this.state.unanswered ??= {});
      unanswered[charId] = (unanswered[charId] ?? 0) + 1;
      const replies = await this.file(charId, character, save, [], reply, kept.allowed, true);
      const first = replies[0];
      if (first) {
        this.notices.push({ charId, name: character.firstName, text: first.text, at: Date.now() });
        this.notices = this.notices.slice(-50);
      }
      return true;
    } finally {
      this.inFlight.delete(charId);
    }
  }

  /**
   * If her texts present a picture that didn't come with them ("happy now?", "took forever to
   * get the lighting right"), or she described one past what she sends at this point, ask once
   * more. The follow-up first decides whether her texts really are handing over a picture, then
   * writes it. It is still held to the same limits as every other picture.
   *
   * It runs when her texts plainly say so, or when a picture has been the topic and none came:
   * the model then judges the wording, so any phrasing is caught, not just a list of phrases.
   */
  private async keepPhotoPromise(
    llm: LlmSettings,
    request: TextingRequest,
    character: Character,
    save: SaveFile,
    reply: TextingReply,
    allowed: PhotoTier,
    possible: PhotoTier,
    shot: ShotType,
    photoContext: boolean,
  ): Promise<{ reply: TextingReply; allowed: PhotoTier }> {
    if (possible === "none" || reply.blocked) return { reply, allowed };
    const verdict = settlePhoto({
      sendPhoto: reply.sendPhoto,
      photoPrompt: reply.photoPrompt,
      stated: isPhotoTier(reply.photoTier) ? reply.photoTier : undefined,
      allowed,
    });
    if (verdict.send) return { reply, allowed };
    const described = reply.sendPhoto && reply.photoPrompt.trim();
    if (!described && !claimsPhoto(reply.messages) && !photoContext) return { reply, allowed };

    const name = character.firstName;
    const situation = described
      ? `She meant to send the picture "${reply.photoPrompt.trim()}", but that is more than she sends right now (${verdict.note ?? "over her limit"}).`
      : "No picture came with these texts.";
    const user = [
      request.user,
      "",
      "FOLLOW-UP",
      `${name}'s reply was: ${reply.messages.map((m) => `"${m}"`).join(" ")}`,
      situation,
      `Decide one thing first: do ${name}'s texts present a picture as being sent with them right now? Texts like "happy now?", "here", "took me forever to get the lighting right", "dont screenshot that" or "ur welcome" said right after he asked for one are handing a picture over, even without the word photo.`,
      `If they do, set "sendsPicture" true and write the picture she sends with them. If she is refusing, teasing, stalling, asking what he wants, or saying "later", set "sendsPicture" false and leave "photoPrompt" empty.`,
      "",
      ...photoPromptLines(character, save.charInfo[character.charId], possible, shot),
      'Answer with only "sendsPicture", "photoPrompt" and "photoTier".',
    ].join("\n");
    try {
      const raw = (await completeStructured(llm, {
        system: request.system,
        user,
        schema: {
          name: "photo",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["sendsPicture", "photoPrompt", "photoTier"],
            properties: {
              sendsPicture: { type: "boolean" },
              photoPrompt: PHOTO_SCHEMA_FIELDS.photoPrompt,
              photoTier: PHOTO_SCHEMA_FIELDS.photoTier,
            },
          },
        },
        ...(request.images ? { images: request.images } : {}),
      })) as Record<string, unknown>;
      const caption = captionForShot(typeof raw.photoPrompt === "string" ? raw.photoPrompt.trim() : "", shot);
      if (raw.sendsPicture !== true || !caption) {
        console.log(`[photo] ${name}: checked whether her texts were sending a picture; they weren't.`);
        return { reply, allowed };
      }
      console.log(`[photo] ${name} promised a picture without sending one; asked again: "${caption}"`);
      return {
        reply: { ...reply, sendPhoto: true, photoPrompt: caption, photoTier: typeof raw.photoTier === "string" ? raw.photoTier : undefined },
        allowed: possible,
      };
    } catch (err) {
      console.warn(`[photo] ${name} promised a picture; the follow-up failed: ${(err as Error).message}`);
      return { reply, allowed };
    }
  }

  private promptContext(save: SaveFile, character: Character, allowedPhoto: ReturnType<typeof allowedPhotoTier>, requested: boolean) {
    const { record } = this.require();
    return {
      save,
      character,
      roster: [...this.characters.values()].filter((c) => c.charId !== character.charId),
      player: { firstName: record.playerFirstName, lastName: record.playerLastName, termIndex: semesterOf(record, save.semester).index },
      season: this.season(),
      allowedPhoto,
      photoRequested: requested,
    };
  }

  /** Records a turn in the delta: his message (if any), her bubbles, summary, block, photo. */
  private async file(
    charId: string,
    character: Character,
    save: SaveFile,
    sent: ChatMessage[],
    reply: ReturnType<typeof parseTextingReply>,
    allowedPhoto: ReturnType<typeof allowedPhotoTier>,
    unread: boolean,
    unblocking = false,
  ): Promise<ChatMessage[]> {
    const { state } = this.require();
    const stamp = { date: save.date, time: save.time };
    // Texts she starts carry the same marker the game's own incoming texts do, plus a turn id so
    // several openers in a row can be told apart.
    const turn = unread ? randomUUID() : undefined;
    const phoneTurn = randomUUID();
    const replies: ChatMessage[] = reply.messages.map((t) => ({
      id: randomUUID(),
      sender: "contact",
      exPhoneTurn: phoneTurn,
      text: t,
      ...stamp,
      ...(unread ? { exReplyTo: "incoming-texts:incoming", exIncomingTurn: turn } : {}),
    }));
    const added: ChatMessage[] = [
      ...sent,
      ...(unblocking ? [{ id: randomUUID(), sender: "system" as const, text: `${character.firstName} unblocked you.`, ...stamp }] : []),
      ...replies,
    ];
    if (reply.blocked) added.push({ id: randomUUID(), sender: "system", text: `${character.firstName} blocked you.`, ...stamp });
    (state.delta.added[charId] ??= []).push(...added);
    if (reply.summary) state.delta.summaries[charId] = reply.summary;
    if (unblocking) {
      state.delta.blocked = state.delta.blocked.filter((id) => id !== charId);
      const unblocked = (state.delta.unblocked ??= []);
      if (!unblocked.includes(charId)) unblocked.push(charId);
      if (state.unanswered) delete state.unanswered[charId];
      if (!reply.summary) state.delta.summaries[charId] = "";
    } else if (reply.blocked) {
      if (!state.delta.blocked.includes(charId)) state.delta.blocked.push(charId);
      state.delta.unblocked = state.delta.unblocked?.filter((id) => id !== charId);
    }
    if (unread) {
      state.delta.unread ??= {};
      state.delta.unread[charId] = (state.delta.unread[charId] ?? 0) + replies.length;
    }

    if (!reply.blocked) {
      const verdict = settlePhoto({
        sendPhoto: reply.sendPhoto,
        photoPrompt: reply.photoPrompt,
        stated: isPhotoTier(reply.photoTier) ? reply.photoTier : undefined,
        allowed: allowedPhoto,
      });
      const lastReply = replies[replies.length - 1];
      // Why a picture did or didn't go out, so a missing or tamer photo can be traced.
      if (reply.sendPhoto || allowedPhoto !== "none") {
        const outcome = verdict.send ? `sent as ${verdict.tier}` : `not sent (${verdict.note ?? "she chose not to"})`;
        console.log(
          `[photo] ${character.firstName}: allowed up to ${allowedPhoto}; she said ${reply.photoTier ?? "-"}; ${outcome}` +
            (reply.photoPrompt.trim() ? ` — "${reply.photoPrompt.trim()}"` : ""),
        );
      }
      if (verdict.send && lastReply) {
        const file = await this.reservePhotoName(state.playthroughId, character, save);
        lastReply.photo = { tier: verdict.tier, scene: reply.photoPrompt.trim(), file, pending: true };
        void this.drawPhoto(state.playthroughId, character, lastReply);
      }
    }
    await this.persist();
    return replies;
  }

  private uploadDir(playthroughId: string, charId: string): string {
    if (!SAFE_NUMERIC_ID.test(playthroughId) || !SAFE_CHAR_ID.test(charId)) throw new PhoneError("Not found.", 404);
    return path.join(UPLOADS_DIR, playthroughId, charId);
  }

  async uploadPath(charId: string, file: string): Promise<string> {
    const { state } = this.require();
    this.characterOf(charId);
    if (!UPLOAD_FILE.test(file)) throw new PhoneError("Not found.", 404);
    const full = path.join(this.uploadDir(state.playthroughId, charId), file);
    try {
      await fs.access(full);
    } catch {
      throw new PhoneError("Not found.", 404);
    }
    return full;
  }

  private async reservePhotoName(playthroughId: string, character: Character, save: SaveFile): Promise<string> {
    const slug = character.firstName.toLowerCase().replace(/[^a-z0-9]/g, "") || character.charId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
    const taken = new Set<string>();
    try {
      for (const name of await fs.readdir(this.files.photosDir(playthroughId, character.charId))) taken.add(name);
    } catch {
      // No photos yet.
    }
    for (const m of save.bunnyboard.conversations[character.charId]?.messages ?? []) if (m.photo?.file) taken.add(m.photo.file);
    let highest = 0;
    const pattern = new RegExp(`^${slug}_chat_(\\d{3,6})\\.(?:png|webp)$`);
    for (const name of taken) {
      const match = pattern.exec(name);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    return `${slug}_chat_${String(highest + 1).padStart(3, "0")}.png`;
  }

  private async drawPhoto(playthroughId: string, character: Character, message: ChatMessage): Promise<void> {
    const photo = message.photo;
    if (!photo) return;
    this.rendering.add(message.id);
    const settle = async (next: ChatPhoto) => {
      message.photo = next;
      this.rendering.delete(message.id);
      // The message object lives in the delta, so persisting the session records the outcome.
      // This runs in the background, so a failed write is logged rather than thrown.
      if (this.state?.playthroughId === playthroughId) {
        await this.persist().catch((err) => console.warn(`[photo] couldn't save the photo's result: ${(err as Error).message}`));
      }
    };
    try {
      const dest = path.join(this.files.photosDir(playthroughId, character.charId), photo.file);
      const prompts = buildPhotoPrompt(character, photo.tier, photo.scene);
      // Logged like the game logs its own renders, so a picture that misses can be traced.
      console.log(`[photo] ${character.firstName} (${photo.tier}): "${photo.scene}"`);
      console.log(`[photo] → ${prompts.positive.replace(/\n\n/g, " | ")}`);
      await renderPhoto(this.files, prompts, dest);
      await settle({ tier: photo.tier, scene: photo.scene, file: photo.file });
    } catch (err) {
      console.warn(`[photo] ${character.firstName}'s photo failed: ${(err as Error).message}`);
      await settle({ tier: photo.tier, scene: photo.scene, file: photo.file, failed: true });
    }
  }

  async photoPath(charId: string, file: string): Promise<string> {
    const { state } = this.require();
    this.characterOf(charId);
    if (!isPhotoFile(file)) throw new PhoneError("Not found.", 404);
    const dir = this.files.photosDir(state.playthroughId, charId);
    for (const candidate of [file, file.replace(/\.png$/, ".webp"), file.replace(/\.webp$/, ".png")]) {
      const full = path.join(dir, candidate);
      try {
        await fs.access(full);
        return full;
      } catch {
        continue;
      }
    }
    throw new PhoneError("Not found.", 404);
  }

  avatarPath(charId: string): Promise<string | null> {
    this.characterOf(charId);
    return this.files.avatarPath(charId);
  }

  /**
   * Writes everything texted into a new numbered save in the same playthrough. If the game has
   * saved since you picked your save, the chats are laid over its newest save instead, so no
   * progress is lost either way.
   */
  async sync(confirmedTarget?: string) {
    this.assertNotSyncing();
    this.syncing = true;
    try { return await this.syncOnce(confirmedTarget); }
    finally { this.syncing = false; }
  }

  private async syncOnce(confirmedTarget?: string) {
    const { state, base: selected } = this.require();
    if (this.inFlight.size) throw new PhoneError("Wait for replies before syncing.", 409);
    if (this.rendering.size) throw new PhoneError("Wait for photos to finish before syncing.", 409);
    if (await isGameRunning()) {
      throw new PhoneError("Close Venus University before syncing; it would overwrite the synced save with its own autosave.", 409);
    }
    const messages = this.pendingCount();
    if (messages === 0) throw new PhoneError("Nothing new to sync. No save was written. To catch up with game progress, pick the newest save.");

    const saves = await this.files.listSaves(state.playthroughId);
    const newest = saves[0];
    const baseId = newest && newest.saveDate >= state.baseSaveDate ? newest.saveId : state.baseSaveId;
    const base = await this.files.readSave(state.playthroughId, baseId);
    // Autosave/manual slots can change in place without getting a new filename.
    const rebased = baseId !== state.baseSaveId || base.saveDate !== state.baseSaveDate || fingerprint(base) !== state.baseFingerprint;
    if (base.semester !== selected.semester) {
      throw new PhoneError("The newest save is in a different semester. Your chats are still kept here; choose a save in that semester to start a new phone session. Sync cannot move chats between semesters.", 409);
    }
    // Validate the current record before writing anything.
    const semester = semesterOf(await this.files.readRecord(state.playthroughId), base.semester);
    const token = fingerprint({ playthrough: state.playthroughId, selected: state.baseSaveId, base, delta: state.delta });
    if (rebased && confirmedTarget !== token) {
      return {
        requiresConfirmation: true as const,
        token,
        warning: `The game has changed since this phone session began. Sync will add ${messages} pending message changes to save ${baseId} (${formatDateBanner(base.date, base.time, seasonOfTerm(semester.index))}). Newer game progress is kept. Phone deletions and block/unblock decisions will also apply, and affected chat recaps will be cleared. Existing save files are never overwritten. Continue?`,
      };
    }
    const merged = applyDelta(base, state.delta, true);
    if (rebased) {
      const touched = new Set([...Object.keys(state.delta.added), ...Object.keys(state.delta.deleted ?? {}), ...Object.keys(state.delta.summaries)]);
      for (const id of touched) {
        if (merged.bunnyboard.conversations[id]) merged.bunnyboard.conversations[id].summary = "";
      }
    }
    const saveId = await this.files.writeNewSlotSave(state.playthroughId, merged);

    const written = await this.files.readSave(state.playthroughId, saveId);
    const unread = state.delta.unread ?? {};
    await this.load({
      playthroughId: state.playthroughId,
      baseSaveId: saveId,
      baseSaveDate: written.saveDate,
      delta: emptyDelta(),
      unanswered: state.unanswered ?? {},
    });
    // Unread stays unread in the app too.
    if (this.state) this.state.delta.unread = { ...unread };
    await this.persist();
    return { requiresConfirmation: false as const, saveId, rebased, messages };
  }
}

const PHOTO_WORDS = /\b(?:pics?|photos?|pictures?|selfies?|snaps?)\b/i;
/** Her texts say a picture is on its way or attached. */
const CLAIMS_PHOTO =
  /(?:\b(?:sending|sent|send(?:ing)? (?:it|one)|attached|attaching|here'?s|heres|incoming|taking|took|snapped|snapping|got)\b[^.!?\n]{0,30}\b(?:pics?|photos?|pictures?|selfies?|snaps?)\b)|📸|\b(?:here (?:you|u) go|there (?:you|u) go|here it is|enjoy)\b/i;

function claimsPhoto(messages: string[]): boolean {
  return messages.some((text) => CLAIMS_PHOTO.test(text));
}

/** "another one", "one more", "send more", "again": asking for more after a picture. */
const MORE_ASK = /\b(?:another|one more|1 more|more (?:pics?|photos?|of (?:that|those|you|u))|send (?:me )?more|again|keep (?:them|em) coming|next one|round two|part (?:2|two))\b/i;

/**
 * Whether this turn is about a picture: he asked now, he's asking for more after one she sent,
 * or a picture came up in the last few texts from either side (he asked a few messages back,
 * she offered one, or she's been stalling "ok ok wait").
 */
function photoRequested(newText: string, messages: ChatMessage[]): boolean {
  if (asksForPhoto(newText)) return true;
  let seen = 0;
  let afterPhoto = false;
  for (let i = messages.length - 1; i >= 0 && seen < 8; i--) {
    const m = messages[i];
    if (!m || m.sender === "system") continue;
    seen += 1;
    if (m.sender === "contact" && m.photo) {
      // She sent one recently: asking for more counts, and so does any picture talk since it.
      afterPhoto = true;
      if (MORE_ASK.test(newText)) return true;
      continue;
    }
    if (PHOTO_WORDS.test(m.text) || (m.sender === "player" && asksForPhoto(m.text))) {
      // Talk from before her last picture was answered by it, unless he asks for more now.
      if (!afterPhoto) return true;
    }
  }
  return false;
}

/** Odds she even thinks about sending an unasked-for picture on a given reply. */
const SPONTANEOUS_PHOTO_CHANCE = 0.12;
/** No unasked-for picture if she sent one within this many recent bubbles. */
const PHOTO_COOLDOWN_MESSAGES = 12;
/** Odds a reply even offers her the chance to react to his text with an emoji. */
const REACTION_CHANCE = 0.35;
/** No reaction if she reacted to any of his last this-many texts. */
const REACTION_COOLDOWN = 3;

function reactedRecently(messages: ChatMessage[]): boolean {
  return messages
    .filter((m) => m.sender === "player")
    .slice(-REACTION_COOLDOWN)
    .some((m) => typeof m.exReaction === "string" && m.exReaction);
}

/** How many texts she started in a row, at the end of the thread, since he last said anything. */
function unansweredOpeners(messages: ChatMessage[]): number {
  const turns = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.sender === "system") continue;
    if (m.sender === "player") break;
    if (m.exReplyTo !== "incoming-texts:incoming") break;
    turns.add(typeof m.exIncomingTurn === "string" ? m.exIncomingTurn : `old:${m.date}:${m.time}`);
  }
  return turns.size;
}

const PHOTO_ASK =
  /\b(?:pics?|pictures?|photos?|selfies?|snaps?|nudes?)\b|\bsend (?:me )?(?:one|something)\b|\bshow me\b|\bwhat (?:are|r) (?:you|u) wearing\b|\blet me see\b|\bwanna see\b/i;

function asksForPhoto(text: string): boolean {
  return PHOTO_ASK.test(text);
}

function sentPhotoRecently(messages: ChatMessage[]): boolean {
  return messages.slice(-PHOTO_COOLDOWN_MESSAGES).some((m) => m.sender === "contact" && m.photo);
}

function messageOrder(save: SaveFile, charId: string): number {
  // Threads with newer bubbles sort first: by the slot of their last message.
  const messages = save.bunnyboard.conversations[charId]?.messages ?? [];
  const last = messages[messages.length - 1];
  return last ? last.date * 2 + last.time + messages.length / 1e6 : -1;
}

/**
 * Her reply with any "[attached a photo: …]" notes taken out of the texts. If she wrote one
 * instead of actually attaching a picture, and pictures were allowed this turn, its description
 * becomes the photo. It still has to pass the same checks as any other picture.
 */
function cleanReply(raw: ReturnType<typeof parseTextingReply>, allowedPhoto: ReturnType<typeof allowedPhotoTier>) {
  const { reply, noted } = withoutPhotoNotes(raw);
  if (noted && allowedPhoto !== "none" && !(reply.sendPhoto && reply.photoPrompt.trim())) {
    console.log(`[photo] she wrote a photo note instead of sending one; sending it: "${noted}"`);
    reply.sendPhoto = true;
    reply.photoPrompt = noted;
  }
  // A picture with no words still needs a bubble to land in.
  if (reply.messages.length === 0 && reply.sendPhoto && reply.photoPrompt.trim()) reply.messages = [""];
  return reply;
}

/** A message's text without the photo note sync writes for the game. */
function displayText(message: ChatMessage): string {
  const at = message.text.indexOf(READER_PHOTO_MARK);
  return (at === -1 ? message.text : message.text.slice(0, at)).trim();
}

function extensionOf(image: TextingImage): string {
  return image.mimeType === "image/png" ? "png" : image.mimeType === "image/webp" ? "webp" : "jpg";
}

/** The upload's bytes, after checking it really is the image type it claims. */
function checkedImage(image: TextingImage): Buffer {
  if (!["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)) throw new PhoneError("Send a JPEG, PNG or WebP photo.");
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) throw new PhoneError("That photo is too large.");
  const hex = bytes.subarray(0, 12).toString("hex");
  const ok =
    (image.mimeType === "image/jpeg" && hex.startsWith("ffd8ff")) ||
    (image.mimeType === "image/png" && hex.startsWith("89504e470d0a1a0a")) ||
    (image.mimeType === "image/webp" && hex.startsWith("52494646") && hex.slice(16, 24) === "57454250");
  if (!ok) throw new PhoneError("That file isn't a photo.");
  try {
    return stripImageMetadata(bytes, image.mimeType);
  } catch {
    throw new PhoneError("That photo couldn't be read.");
  }
}

/**
 * Lays the phone's delta over a save without touching anything else in it. For the game, your
 * photos become a written note on your message and her unread texts raise the in-game badge.
 */
export function applyDelta(base: SaveFile, delta: Delta, forGame: boolean): SaveFile {
  const save: SaveFile = structuredClone(base);
  save.bunnyboard.conversations ??= {};
  for (const [charId, ids] of Object.entries(delta.deleted ?? {})) {
    const conversation = save.bunnyboard.conversations[charId];
    if (conversation) {
      const removed = conversation.messages.filter((m) => ids.includes(m.id) && m.sender === "contact").length;
      conversation.messages = conversation.messages.filter((m) => !ids.includes(m.id));
      conversation.unread = Math.max(0, (conversation.unread ?? 0) - removed);
    }
  }
  for (const [charId, added] of Object.entries(delta.added)) {
    const conversation: Conversation = save.bunnyboard.conversations[charId] ?? { charId, messages: [], unread: 0, summary: null };
    const have = new Set(conversation.messages.map((m) => m.id));
    const fresh = added
      .filter((m) => !have.has(m.id))
      .map((m) => {
        const copy = structuredClone(m);
        if (forGame && copy.readerPhoto) {
          const photo = copy.readerPhoto as ReaderPhoto;
          copy.text = `${copy.text}${copy.text ? " " : ""}${readerPhotoNote(photo.scene)}`;
          delete copy.readerPhoto;
        }
        return copy;
      });
    conversation.messages = [...conversation.messages, ...fresh];
    if (forGame) conversation.unread = (conversation.unread ?? 0) + (delta.unread?.[charId] ?? 0);
    save.bunnyboard.conversations[charId] = conversation;
  }
  for (const [charId, summary] of Object.entries(delta.summaries)) {
    const conversation = save.bunnyboard.conversations[charId];
    if (conversation) conversation.summary = summary;
  }
  for (const charId of delta.unblocked ?? []) {
    const info = save.charInfo[charId];
    if (info) info.flags = { ...(info.flags ?? emptyFlags()), blocked: false };
  }
  for (const charId of delta.blocked) {
    const info = save.charInfo[charId];
    if (info) info.flags = { ...(info.flags ?? emptyFlags()), blocked: true };
  }
  return save;
}


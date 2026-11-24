// Builds the DM request the same way the game's buildTextingPrompt does: the RITA persona as the
// system prompt, then READER / CHARACTER / NOW / TEXTING SO FAR / RECENT MESSAGES / YOUR TURN,
// with the PHOTOS block adapted from naudh1r's Photo Feature mod in Venus Extracurriculars,
// plus BLOCKING and SUMMARY, answered as one JSON object. DM photos are a mod feature.
// Player-authored lore and setting overrides come from the playthrough's lorebook sidecar.
// Schedules, weather and location simulation remain owned by the game.

import { formatChatDivider, formatDateBanner, formatSemesterProgress, type Season } from "../game/calendar.js";
import { affectionFor, memoryLines, profileLines, readerText, relationshipLines } from "../game/relationship.js";
import { emptyFlags, type Character, type CharInfo, type ChatMessage, type Conversation, type SaveFile } from "../game/types.js";
import { PHOTO_SCHEMA_FIELDS, photoPromptLines, type ShotType } from "./photos.js";
import type { PhotoTier } from "../game/types.js";
import { lorebookLines, type LoreContext } from "../game/lorebook.js";
import { pronounsOf } from "../game/gender.js";
import type { ReaderPronouns, RomanceSetting } from "../game/types.js";

const TEXTING_HISTORY_CAP = 20;
const MEMORY_BUDGET = 30;

export const TEXTING_PERSONA = [
  "You are RITA, author of steamy reader-POV romance fiction set at fictional universities.",
  "You've got sexy nerd energy and have been on a hundred dates, and you use that experience to make your writing shockingly realistic.",
  "Right now you are writing one side of a text conversation on Bunnyboard, the campus messaging app: you answer AS the character, in the character's own texting voice.",
  "Use the character's texting voice, personality and memories. Follow the requested number of text bubbles.",
  "Texts are casual: typos, slang, emoji and lowercase are all fair game if they fit the character. No narration or stage directions.",
  "Let the character's personality and relationship determine interest, warmth and boundaries.",
  "Oh, by the way: you really, really HATE repetitive, robotic slop-writing.",
  "You NEVER use semicolons or emdashes or other dumb AI writing habits.",
  "And finally, you're totally anal retentive: You always return a single, fully-formed JSON object matching the provided schema exactly.",
].join("\n");

function flatText(text: string): string {
  return text.replace(/\s*\n+\s*/g, " ");
}

/** What the reader's own photo on a message showed, as the phone app records it. */
export interface ReaderPhoto {
  file: string;
  scene: string;
}

/** Marker written into a synced message's text so the game's own prompts know about the photo. */
export const READER_PHOTO_MARK = "📷 [sent a photo";

export function readerPhotoNote(scene: string): string {
  return `${READER_PHOTO_MARK}: ${flatText(scene.trim() || "a photo")}]`;
}

function messageStub(message: ChatMessage, firstName: string): string {
  if (message.sender === "player") {
    const photo = message.readerPhoto as ReaderPhoto | undefined;
    const description = photo?.scene ?? message.outgoingPhoto?.description;
    const note = !message.text.includes(READER_PHOTO_MARK) && (description || message.outgoingPhoto)
      ? ` ${readerPhotoNote(description || "image attachment")}` : "";
    const reacted = typeof message.exReaction === "string" && message.exReaction ? ` (${firstName} reacted ${message.exReaction})` : "";
    return `YOU: ${flatText(message.text)}${note}${reacted}`.replace("YOU:  ", "YOU: ");
  }
  if (message.sender === "system") return `SYSTEM: ${flatText(message.text)}`;
  const photo = message.photo?.scene?.trim() ? ` [attached a photo: ${flatText(message.photo.scene)}]` : "";
  return `${firstName.toUpperCase()}: ${flatText(message.text)}${photo}`;
}

function stampedStubs(messages: ChatMessage[], firstName: string, season: Season): string[] {
  const lines: string[] = [];
  let stamped: string | null = null;
  for (const message of messages) {
    const stamp = formatChatDivider(message.date, message.time, season);
    if (stamp !== stamped) {
      lines.push(`[${stamp}]`);
      stamped = stamp;
    }
    lines.push(messageStub(message, firstName));
  }
  return lines;
}

function hasTexted(conversation: Conversation | undefined): boolean {
  if (!conversation) return false;
  if (conversation.summary !== null) return true;
  return conversation.messages.some((m) => m.sender === "player" || m.sender === "contact");
}

export interface TextingImage {
  mimeType: string;
  /** Base64, no data: prefix. */
  data: string;
}

export interface TextingRequest {
  system: string;
  user: string;
  schema: { name: string; schema: Record<string, unknown> };
  images?: TextingImage[];
}

export interface TextingContext {
  lorebook?: LoreContext;
  godlikeStandards?: boolean;
  feedLines?: string[];
  romance?: RomanceSetting;
  save: SaveFile;
  character: Character;
  roster: Character[];
  player: { firstName: string; lastName: string; termIndex: number; pronouns?: ReaderPronouns };
  season: Season;
  allowedPhoto: PhotoTier;
  /** He asked for a picture in this message; otherwise any picture is her own idea. */
  photoRequested: boolean;
  /** She may tap an emoji reaction onto his newest text this turn. */
  offerReaction?: boolean;
  /** The kind of shot her picture is, if she sends one this turn. */
  photoShot?: ShotType;
  /** How many text bubbles she sends this turn. */
  bubbles?: number;
  /** A player-triggered reconciliation, with no new message from the reader. */
  unblocking?: boolean;
  /** The photo in a reply being replaced; keep its context but generate a new shot. */
  replacementPhoto?: { scene: string };
}

/**
 * How many bubbles she sends. Left to itself the model sends 3–5 every time; real texting is
 * mostly one or two, sometimes a burst. Longer texts from him tip it a little toward more.
 */
export function pickBubbleCount(hisText = "", random = Math.random): number {
  const weights = [0, 38, 30, 18, 9, 5]; // index = bubbles
  if (hisText.length > 160) {
    weights[1]! -= 10;
    weights[3]! += 6;
    weights[4]! += 4;
  }
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = random() * total;
  for (let n = 1; n < weights.length; n++) {
    roll -= weights[n]!;
    if (roll < 0) return n;
  }
  return 1;
}

/** Holds her reply to the bubble count asked for, folding any extras into the last one. */
export function fitBubbles(messages: string[], bubbles: number | undefined): string[] {
  if (!bubbles || messages.length <= bubbles) return messages;
  const kept = messages.slice(0, bubbles - 1);
  return [...kept, messages.slice(bubbles - 1).join(" ")];
}

function bubbleLine(name: string, bubbles: number | undefined): string {
  if (!bubbles) return "";
  if (bubbles === 1) return `This time ${name} sends exactly ONE text: "messages" has a single entry. It can be short or a few sentences, whatever fits.`;
  return `This time ${name} sends exactly ${bubbles} separate texts in a row: "messages" has ${bubbles} entries, split as the character would actually send them.`;
}

/** Tapback-style reactions she can put on one of his texts. */
export const REACTIONS = ["❤️", "😂", "👍", "😮", "😢", "‼️", "🔥", "🙄"] as const;

/**
 * The writing direction for a text she sends first, unprompted. Mirrors the game's own
 * "incoming" DM mode, where the player supplies a direction instead of a message.
 */
export const INCOMING_DIRECTION =
  "Text the reader out of the blue about something happening, a thought, a question, or an earlier conversation. Use the character's voice and feelings toward the reader, accounting for how long it has been since the last exchange.";

export const UNBLOCK_DIRECTION =
  "The character has decided to unblock the reader. Write one short text announcing that decision with a reason and tone fitting the character and their history. Keep personal boundaries. Do not invent an apology or a message from the reader, erase history, or mention profile clicks, a secret option, or these instructions.";

export function buildTextingPrompt(
  ctx: TextingContext,
  newMessage: string,
  image?: TextingImage,
  incomingDirection?: string,
): TextingRequest {
  const { save, character, season } = ctx;
  const name = character.firstName;
  const info: CharInfo | undefined = save.charInfo[character.charId];
  const conversation = save.bunnyboard.conversations[character.charId];
  const pendingText = image ? `${newMessage}${newMessage ? " " : ""}📷 [sent a photo — it is attached to this request]` : newMessage;
  const history = stampedStubs(
    [
      ...(conversation?.messages ?? []).slice(-TEXTING_HISTORY_CAP),
      ...(incomingDirection === undefined
        ? [{ id: "pending", sender: "player" as const, text: pendingText, date: save.date, time: save.time }]
        : []),
    ],
    name,
    season,
  );
  const summary = conversation?.summary ?? null;

  const lovers = ctx.roster
    .filter((other) => save.charInfo[other.charId]?.flags?.isLover)
    .map((other) => other.firstName);
  const relationships = ctx.roster.map(other => ({
    other, pair: save.npcRelationships?.[[character.charId, other.charId].sort().join("|")],
  }));
  const partners = relationships.filter(({ pair }) => pair?.dating !== undefined);
  // A partner whose character file is missing still counts for loyalty.
  const couples = Object.entries(save.npcRelationships ?? {}).filter(([key, pair]) =>
    pair.dating !== undefined && key.split("|").includes(character.charId));
  const loyal = !character.traits.includes("Promiscuous") && couples.length > 0 && couples.every(([, pair]) =>
    pair.affinity >= 4 || (save.date - pair.dating! < 14 && !Object.values(pair.cheated ?? {}).some(day => day >= pair.dating!)));
  const loveLines = [
    ...partners.map(({ other }) => `${name} is dating ${other.firstName} ${other.lastName}.`),
    ...(affectionFor(info, save.date, character) > 30
      ? relationships.filter(({ pair }) => pair?.crush?.includes(character.charId)).map(({ other }) => `${name} has a crush on ${other.firstName} ${other.lastName}.`)
      : []),
  ];

  const characterBlock = [
    "CHARACTER",
    `${name} ${character.lastName}. Pronouns: ${pronounsOf(character).tag}.`,
    ...(info?.pursuing ? [`${name} has graduated and is now ${info.pursuing}.`] : info?.major ? [`${name} is a year ${info.year ?? 1} ${info.major} major.`] : []),
    ...profileLines(character, info?.flags ?? emptyFlags()),
    ...relationshipLines(character, info, save.date, save.stats, hasTexted(conversation), ctx.godlikeStandards, ctx.player.pronouns, ctx.romance, loyal),
    ...loveLines,
    ...memoryLines(character, info, MEMORY_BUDGET, season),
    ...(ctx.feedLines ?? []),
    // Only secrets already told to the reader belong in a DM. Unrevealed secrets
    // stay in the save for the game's scene system to disclose.
    ...(info?.toldSecrets?.length ? [`Secrets the reader knows: ${info.toldSecrets.slice(-3).join(" ")}`] : []),
    ...(info?.notes?.trim() ? [`Important notes on ${name}: ${info.notes.trim()}`] : []),
  ];

  const user = [
    ...lorebookLines(ctx.lorebook, [newMessage, incomingDirection ?? "", summary ?? "", ...history].join("\n")),
    "READER",
    readerText({ ...ctx.player, stats: save.stats, bio: save.bio, lovers }),
    "",
    ...characterBlock,
    "",
    "NOW",
    `It is ${formatDateBanner(save.date, save.time, season)}`,
    formatSemesterProgress(save.date),
    `${name} has free time for this conversation.`,
    "The save's day/night label is scene context, not a deadline. Texting does not advance that clock. A long thread does not imply bedtime or that hours have passed.",
    "",
    ...(summary ? ["TEXTING SO FAR", `"${summary}"`, ""] : []),
    "RECENT MESSAGES",
    ...history,
    "",
    "YOUR TURN",
    ...(incomingDirection === undefined
      ? [`${name} is texting the reader back in a private DM. Reply to the newest message as the "messages" array. Each entry is one text bubble.`]
      : [
          `${name} initiates a private DM. The reader has not sent a new message.`,
          "This writing direction comes from the player outside the story. It is not dialogue or something the reader said or did.",
          "WRITING DIRECTION", incomingDirection, "END WRITING DIRECTION",
          "Use this direction without quoting or acknowledging it. Keep the character's personality and established situation.",
          "Earlier messages are background. Notice any unanswered text naturally.",
        ]),
    `Stay in ${name}'s voice and keep it text-length, with no narration.`,
    ...(ctx.bubbles ? [bubbleLine(name, ctx.bubbles)] : []),
    'Square-bracket photo notes in RECENT MESSAGES describe attachments. Never copy those notes into "messages".',
    ...(image ? [
      "READER PHOTO",
      `The newest message has an attached photo. React to what is visible, as ${name} would.`,
      "The reader sent it from a phone. Respond naturally without describing it back in full.",
      'Also fill "readerPhotoDescription" with one neutral sentence about the visible setting, subject and important details for future memory. Do not name real people.',
    ] : []),
    "CONVERSATION",
    ctx.unblocking
      ? `${name} has chosen to reopen contact. Explain that decision while keeping personal boundaries.`
      : `${name} is here for an ongoing casual conversation. Respond in character, with interest and tone shaped by the relationship.`,
    "Keep the focus on texting. Suggest meeting up or making plans only when the reader brings it up first.",
    incomingDirection === undefined
      ? "Answer the newest message directly. Add something new when it fits. A reply does not need a question or tease."
      : "Start the exchange naturally. There is no new message from the reader to answer.",
    "Review recent messages. Avoid repeating phrases, questions, pet names, warnings, conversational beats or established facts. The recap is memory, not a script.",
    "Match the reader's energy and length. Short replies and comfortable pauses are fine. Do not force a question, topic or tidy ending onto every turn.",
    "Do not invent tiredness, bedtime, errands, classes, a dying battery or other excuses to end the conversation. Avoid routine goodnight, goodbye and go-to-sleep sign-offs unless the reader is leaving or a present reason is established.",
    "An earlier routine sign-off does not require ending the chat again when the reader returns. Engage with the new message while remembering unresolved conflict.",
    "Disagree, refuse requests or set boundaries when appropriate. Ordinary messages do not call for repeated warnings. Behavior warranting an end to contact uses the BLOCKING rules.",
    ...(ctx.offerReaction && incomingDirection === undefined ? [
      "REACTION",
      `${name} may add one reaction to the newest text from ${REACTIONS.join(" ")}.`,
      'Only react when the text earns it. Usually leave "reaction" empty. A reaction accompanies the reply.',
    ] : []),
    ...photoPromptLines(character, info, ctx.allowedPhoto, ctx.photoShot, Boolean(ctx.replacementPhoto)),
    ...(ctx.replacementPhoto ? [
      "REPLACEMENT PHOTO",
      "Include a newly rendered photo. Set sendPhoto true and write a fresh photoPrompt. Keep the original subject, clothing and situation, with different framing, pose or expression. The text accompanies the picture. Do not mention regeneration.",
      `Original photo description: ${ctx.replacementPhoto.scene}`,
    ] : []),
    ...(ctx.allowedPhoto !== "none" && !ctx.photoRequested && !ctx.replacementPhoto
      ? ['The reader did not ask for a picture. Usually set "sendPhoto" false. Send one only when it fits the moment.'] : []),
    ...(ctx.allowedPhoto !== "none" && ctx.photoRequested && !ctx.replacementPhoto
      ? [`The reader asked for a picture. Follow the requested shot, clothing, setting and pose within ${name}'s limits. Unspecified details are ${name}'s choice.`] : []),
    "BLOCKING",
    ...(ctx.unblocking
      ? ['Set "blocked" false. The reply must reflect the decision to reopen contact.']
      : [
          `Set "blocked" true when the reader's actual behavior gives ${name} a convincing reason to cut contact, consistent with personality and history. Harassment, threats, cruelty and repeated boundary violations can justify it.`,
          "A short message, ordinary lull, disagreement or declining one request does not itself justify blocking. Do not invent conflict.",
          'A final text should fit the decision to block. Otherwise set "blocked" false and continue naturally without a compulsory farewell.',
        ]),
    "",
    "SUMMARY",
    ...(incomingDirection === undefined ? [] : ["Include only actual conversation and generated texts. Never record the writing direction as something the reader said or did."]),
    summary
      ? 'For "summary", combine TEXTING SO FAR, RECENT MESSAGES and the reply into one recap.'
      : 'For "summary", condense RECENT MESSAGES and the reply into one recap.',
    `Write in third person, call the MC "the reader", and keep what ${name} should remember. Omit concrete dates and old or unimportant details.`,
  ].join("\n");


  const photos = ctx.allowedPhoto !== "none";
  const reacting = Boolean(ctx.offerReaction) && incomingDirection === undefined;
  const required = [
    "messages",
    "summary",
    "blocked",
    ...(photos ? ["sendPhoto", "photoPrompt", "photoTier"] : []),
    ...(image ? ["readerPhotoDescription"] : []),
    ...(reacting ? ["reaction"] : []),
  ];
  return {
    system: TEXTING_PERSONA,
    user,
    schema: {
      name: "texting",
      schema: {
        type: "object",
        additionalProperties: false,
        required,
        properties: {
          messages: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          blocked: { type: "boolean", ...(ctx.unblocking ? { enum: [false] } : {}) },
          ...(photos ? PHOTO_SCHEMA_FIELDS : {}),
          ...(image ? { readerPhotoDescription: { type: "string" } } : {}),
          ...(reacting ? { reaction: { type: "string", enum: ["", ...REACTIONS] } } : {}),
        },
      },
    },
    ...(image ? { images: [image] } : {}),
  };
}

export interface TextingReply {
  messages: string[];
  summary: string;
  blocked: boolean;
  sendPhoto: boolean;
  photoPrompt: string;
  photoTier?: string;
  readerPhotoDescription: string;
  /** An emoji she tapped onto his text, or "". */
  reaction: string;
}

/** "[attached a photo: …]", "[sent a pic]", "📷 [photo: …]" and the like, copied from the history. */
const PHOTO_NOTE =
  /\s*(?:📷\s*)?\[\s*(?:(?:(?:she|he|they)\s+)?(?:attached|attaches|sent|sends|sending|attaching)\s+)?(?:(?:a|an|another)\s+)?(?:photo|picture|pic|selfie|image|snap)\b[^\]:]*(?::\s*([^\]]*))?\]\s*/giu;

/**
 * Takes picture notes out of her texts. The first note's description becomes the photo she
 * meant to send, if she didn't set sendPhoto herself.
 */
export function withoutPhotoNotes(reply: TextingReply): { reply: TextingReply; noted: string | null } {
  let noted: string | null = null;
  const messages = reply.messages
    .map((text) =>
      text.replace(PHOTO_NOTE, (_whole, desc: string | undefined) => {
        if (noted === null && desc?.trim()) noted = desc.trim();
        return " ";
      }),
    )
    .map((text) => text.replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);
  return { reply: { ...reply, messages }, noted };
}

export function parseTextingReply(raw: unknown): TextingReply {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const messages = Array.isArray(data.messages)
    ? data.messages.filter((m): m is string => typeof m === "string").map((m) => m.trim()).filter(Boolean)
    : [];
  return {
    messages,
    summary: typeof data.summary === "string" ? data.summary.trim() : "",
    blocked: data.blocked === true,
    sendPhoto: data.sendPhoto === true,
    photoPrompt: typeof data.photoPrompt === "string" ? data.photoPrompt : "",
    photoTier: typeof data.photoTier === "string" ? data.photoTier : undefined,
    readerPhotoDescription: typeof data.readerPhotoDescription === "string" ? data.readerPhotoDescription.trim().slice(0, 400) : "",
    reaction: (REACTIONS as readonly string[]).includes(data.reaction as string) ? (data.reaction as string) : "",
  };
}


// Builds the DM request the same way the game's buildTextingPrompt does: the RITA persona as the
// system prompt, then READER / CHARACTER / NOW / TEXTING SO FAR / RECENT MESSAGES / YOUR TURN,
// with the Photo Feature's PHOTOS block, BLOCKING and SUMMARY, answered as one JSON object.
// Story lore, schedules, weather and location lines are game-engine state this app does not
// reproduce; the save's memories, summary and thread carry the history.

import { formatChatDivider, formatDateBanner, formatSemesterProgress, type Season } from "../game/calendar.js";
import { memoryLines, profileLines, readerText, relationshipLines } from "../game/relationship.js";
import { emptyFlags, type Character, type CharInfo, type ChatMessage, type Conversation, type SaveFile } from "../game/types.js";
import { PHOTO_SCHEMA_FIELDS, photoPromptLines, type ShotType } from "./photos.js";
import type { PhotoTier } from "../game/types.js";

const TEXTING_HISTORY_CAP = 20;
const MEMORY_BUDGET = 30;

export const TEXTING_PERSONA = [
  "You are RITA, author of steamy reader-POV romance fiction set at fictional universities.",
  "You've got sexy nerd energy and have been on a hundred dates, and you use that experience to make your writing shockingly realistic.",
  "Right now you are writing one side of a text conversation on Bunnyboard, the campus messaging app: you answer AS the character, in her own texting voice.",
  "Write in HER texting voice, keeping her personality and memories in mind. How many texts she sends each time is given in the instructions; follow it.",
  "Texts are casual: typos, slang, emoji and lowercase are all fair game if they fit her. No narration, no stage directions, just what she types.",
  "You make the women play hard to get; everything is a slow burn.",
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
    const note = photo && !message.text.includes(READER_PHOTO_MARK) ? ` ${readerPhotoNote(photo.scene)}` : "";
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
  save: SaveFile;
  character: Character;
  roster: Character[];
  player: { firstName: string; lastName: string; termIndex: number };
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
  return `This time ${name} sends exactly ${bubbles} separate texts in a row: "messages" has ${bubbles} entries, split the way she'd actually fire them off.`;
}

/** Tapback-style reactions she can put on one of his texts. */
export const REACTIONS = ["❤️", "😂", "👍", "😮", "😢", "‼️", "🔥", "🙄"] as const;

/**
 * The writing direction for a text she sends first, unprompted. Mirrors the game's own
 * "incoming" DM mode, where the player supplies a direction instead of a message.
 */
export const INCOMING_DIRECTION =
  "Text the reader out of the blue, the way she might at some point in her day: something she is doing or just saw, something on her mind, a question for him, or picking up on something from their earlier texts. Keep it natural for how long it has been since they last talked, and for how she feels about him.";

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

  const characterBlock = [
    "CHARACTER",
    `${name} ${character.lastName}.`,
    ...(info?.major ? [`${name} is a year ${info.year ?? 1} ${info.major} major.`] : []),
    ...profileLines(character, info?.flags ?? emptyFlags()),
    ...relationshipLines(character, info, save.date, save.stats, hasTexted(conversation)),
    ...memoryLines(character, info, MEMORY_BUDGET, season),
    ...(info?.notes?.trim() ? [`Important notes on ${name}: ${info.notes.trim()}`] : []),
  ];

  const user = [
    "READER",
    readerText({ ...ctx.player, stats: save.stats, bio: save.bio, lovers }),
    "",
    ...characterBlock,
    "",
    "NOW",
    `It is ${formatDateBanner(save.date, save.time, season)}`,
    formatSemesterProgress(save.date),
    `${name} has some free time right now and nowhere she needs to be.`,
    "",
    ...(summary ? ["TEXTING SO FAR", `"${summary}"`, ""] : []),
    "RECENT MESSAGES",
    "'''",
    ...history,
    "'''",
    "",
    "YOUR TURN",
    ...(incomingDirection === undefined
      ? [
          `${name} is texting the reader back in a private DM.`,
          `Write ${name}'s reply to the reader's newest message, the last line of RECENT MESSAGES, as the "messages" array: each entry is one text bubble she sends.`,
        ]
      : [
          `${name} initiates a private DM to the reader. The reader has not sent a new message.`,
          "The following writing direction comes from the player outside the story. It is not dialogue, a message she received, or something the reader said or did.",
          "WRITING DIRECTION",
          incomingDirection,
          "END WRITING DIRECTION",
          `Write the texts ${name} sends as the "messages" array. Do not quote or acknowledge the writing direction. Keep her personality and the established situation.`,
          "Earlier messages are background, not a new message to answer. If the reader never answered her last text, she can notice that the way she would.",
        ]),
    "Stay in her voice and keep it text-length: this is a phone thread, not prose.",
    ...(ctx.bubbles ? [bubbleLine(name, ctx.bubbles)] : []),
    `Notes in square brackets in RECENT MESSAGES, like "[attached a photo: ...]", are written by the phone app to show a picture that was sent. ${name} never types them: "messages" holds only the words she texts, never a description of a picture.`,
    "",
    ...(image
      ? [
          "HIS PHOTO",
          `The reader's newest message comes with a photo he took and sent ${name}; it is attached to this request. Look at it and react to what is actually in it, the way ${name} would: comment on it, tease, ask about it, or relate it to something of hers.`,
          "It is a picture he sent from his phone, not something happening in front of her. Don't describe it back to him in full; just respond to it naturally.",
          'Also fill "readerPhotoDescription": one plain, neutral sentence saying what the photo shows (the setting, the main subject, anything notable), so it can be remembered later. Do not name real people.',
          "",
        ]
      : []),
    "CONVERSATION",
    `This is an open-ended, back-and-forth text conversation, and ${name} is happy to keep it going for as long as the reader does.`,
    "She is not busy and is not about to leave: she never wraps the chat up, never says she has to go, has class, has to study or sleep, or that they should talk later.",
    "She does not steer toward meeting up, making plans or going to an event unless the reader brings it up first. The texting itself is the point.",
    "She answers what he actually said, then keeps the thread alive her own way: reacting, teasing, sharing something from her day, or asking him something back.",
    "Match his energy and length: a quick text gets a quick reply, a long one gets more back.",
    "How warm or guarded she is still comes from her personality and how she feels about the reader; she can be dry, teasing or unimpressed, but she stays in the conversation.",
    "",
    ...(ctx.offerReaction && incomingDirection === undefined
      ? [
          "REACTION",
          `${name} can tap one emoji reaction onto the reader's newest text, the way people react to a message on their phone: ${REACTIONS.join(" ")}.`,
          'Only when his text really earns one: it made her laugh, it was sweet, surprising, sad, or eye-roll worthy. Most texts get no reaction: leave "reaction" as an empty string.',
          "A reaction is extra to her reply, not instead of it.",
          "",
        ]
      : []),
    ...photoPromptLines(character, info, ctx.allowedPhoto, ctx.photoShot),
    ...(ctx.allowedPhoto !== "none" && !ctx.photoRequested
      ? [
          `The reader has not asked for a picture. ${name} may still send one if it genuinely fits the moment, but usually she just texts: default to "sendPhoto" false.`,
          "",
        ]
      : []),
    ...(ctx.allowedPhoto !== "none" && ctx.photoRequested
      ? [
          `The reader asked for a picture. If ${name} sends one, it is the picture he asked for, as far as she is willing: the kind of shot, the outfit, the place, the pose or the part of her he mentioned. Anything he didn't specify is her choice, following the shot described above.`,
          "",
        ]
      : []),
    "BLOCKING",
    `Set "blocked" to true only if these texts have pushed ${name} to cut the reader off completely. She is done, and blocks him on Bunnyboard as her last text lands.`,
    "Her final messages should read like somebody who is about to do that.",
    "Being annoyed, hurt, bored or angry is not enough on its own: people stay in threads they are angry in. Reserve it for wanting him gone.",
    "Otherwise set it to false.",
    "",
    "SUMMARY",
    ...(incomingDirection === undefined
      ? []
      : ["Include only actual conversation and the texts you generate. Do not record the writing direction as something the reader said or did."]),
    summary
      ? 'Then, for the "summary" field, fold the TEXTING SO FAR and the RECENT MESSAGES (plus your reply) into one merged recap.'
      : 'Then, for the "summary" field, condense the RECENT MESSAGES (plus your reply) into a single recap.',
    `Write it in third person, refer to the MC as "the reader", and keep anything ${name} should still remember later. Don't include concrete dates, and leave out old or unimportant information.`,
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
          blocked: { type: "boolean" },
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
  /\s*(?:📷\s*)?\[\s*(?:(?:she\s+)?(?:attached|attaches|sent|sends|sending|attaching)\s+)?(?:(?:a|an|another)\s+)?(?:photo|picture|pic|selfie|image|snap)\b[^\]:]*(?::\s*([^\]]*))?\]\s*/giu;

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

// When a girl may attach a picture to a DM, what the prompt tells her about it, and the check
// her caption has to pass. Adapted from naudh1r's Photo Feature mod in Venus Extracurriculars
// (allowedPhotoTier, settlePhoto, photoLines), separately from the base game's Photos feature.
// Source: https://github.com/naudh1r/venus-university/tree/photo-feature

import { affectionFor, dispositionOf } from "../game/relationship.js";
import { emptyFlags, hasTrait, type Character, type CharInfo, type Flags, type PhotoTier } from "../game/types.js";

const PHOTO_TIERS: PhotoTier[] = ["none", "everyday", "suggestive", "explicit"];
const rankOf = (tier: PhotoTier) => PHOTO_TIERS.indexOf(tier);

export function isPhotoTier(value: unknown): value is PhotoTier {
  return typeof value === "string" && (PHOTO_TIERS as string[]).includes(value);
}

export interface PhotoSwitches {
  /** Photos at all. */
  enabled: boolean;
  /** Undressed photos (the game's "No NSFW images" setting turned off). */
  explicit: boolean;
}

type Reason = "intimate" | "promiscuous" | "crush";

function photoReasonOf(flags: Flags, traits: string[]): Reason | null {
  if (flags.hadSex || flags.benefits || flags.isLover) return "intimate";
  if (hasTrait({ traits }, "Promiscuous")) return "promiscuous";
  if (flags.hasCrush) return "crush";
  return null;
}

export function allowedPhotoTier(character: Character, info: CharInfo | undefined, today: number, switches: PhotoSwitches): PhotoTier {
  if (!switches.enabled) return "none";
  const flags = info?.flags ?? emptyFlags();
  if (!flags.gaveContactInfo || flags.blocked) return "none";
  const feeling = dispositionOf(affectionFor(info, today));
  if (feeling === "hostile" || feeling === "annoyed") return "none";
  const noNsfw = !switches.explicit;
  if (hasTrait(character, "Promiscuous")) return noNsfw ? "suggestive" : "explicit";
  if (photoReasonOf(flags, character.traits) !== null && !noNsfw) return "explicit";
  if (flags.hasKissed || flags.hasCrush || flags.benefits || flags.isLover) return "suggestive";
  return "everyday";
}

// Word lists the game reads a caption with.
const EXPLICIT_WORDS = [
  "nude", "naked", "topless", "bottomless", "undressed", "nothing on", "wearing nothing", "no clothes",
  "without clothes", "fully exposed", "nipple", "breasts out", "bare breasts", "pussy", "vagina", "genital*",
  "masturbat*", "spread legs", "cum", "cumming", "sex", "anal", "anus", "asshole", "butthole", "butt plug",
  "buttplug", "anal beads", "bare-chested", "bare chested", "bare chest", "bare torso", "bare front",
  "bare from the waist up", "chest bare", "breasts bare", "exposed breasts", "exposed chest", "uncovered breasts",
  "shirtless", "braless", "no bra", "without a bra", "nothing covering", "wearing only", "wearing nothing but",
  "dressed in only", "in only her", "clad only in",
];
const SUGGESTIVE_WORDS = [
  "underwear", "lingerie", "bra", "panties", "bikini", "swimsuit", "swimwear", "towel", "lace", "cleavage",
  "thigh", "bare shoulder", "tease", "teasing", "seductive", "suggestive", "in bed", "bedroom eyes", "shower",
  "bath", "changing room", "skimpy", "revealing",
];
// The renderer draws one girl and nobody else: a caption with anyone else in it is refused.
const NOT_SOLO_WORDS = [
  "his hand", "his hands", "his fingers", "his tongue", "his lap", "his chest", "his arms", "on top of him",
  "riding him", "straddling him", "with him", "boyfriend", "another girl", "other girl", "two girls",
  "threesome", "couple", "blowjob", "fellatio", "handjob", "titjob", "paizuri", "deepthroat*", "intercourse",
  "creampie", "fucking him", "fucked by", "sucking him", "kissing him",
];
const PARTNER_BODY_WORDS = ["penis", "cock", "dick"];
const TOY_WORDS = ["dildo", "vibrator", "toy", "magic wand"];

function saysAny(text: string, words: string[]): boolean {
  return words.some((word) => {
    const stem = word.endsWith("*") ? word.slice(0, -1) : word;
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tail = word.endsWith("*") ? "" : "\\b";
    return new RegExp(`\\b${escaped}${tail}`).test(text);
  });
}

function describedPhotoTier(caption: string): PhotoTier {
  const text = caption.toLowerCase();
  if (!text.trim()) return "none";
  if (saysAny(text, EXPLICIT_WORDS)) return "explicit";
  if (saysAny(text, SUGGESTIVE_WORDS)) return "suggestive";
  return "everyday";
}

function describesSomebodyElse(caption: string): boolean {
  const text = caption.toLowerCase();
  if (saysAny(text, NOT_SOLO_WORDS)) return true;
  return saysAny(text, PARTNER_BODY_WORDS) && !saysAny(text, TOY_WORDS);
}

export type PhotoVerdict = { send: true; tier: Exclude<PhotoTier, "none"> } | { send: false; note?: string };

/** Whether the picture she described goes out, and at what tier. */
export function settlePhoto(input: { sendPhoto: boolean; photoPrompt: string; stated?: PhotoTier; allowed: PhotoTier }): PhotoVerdict {
  const { sendPhoto, photoPrompt, allowed, stated } = input;
  if (!sendPhoto || !photoPrompt.trim()) return { send: false };
  if (allowed === "none") return { send: false, note: "she sends him nothing" };
  if (describesSomebodyElse(photoPrompt)) return { send: false, note: "the picture is not of her alone" };
  const described = describedPhotoTier(photoPrompt);
  const tier = stated && rankOf(stated) > rankOf(described) ? stated : described;
  if (tier === "none" || rankOf(tier) > rankOf(allowed)) {
    return { send: false, note: `read as ${tier}, allowed ${allowed}` };
  }
  return { send: true, tier };
}

function spoken(tags: string[]): string {
  return tags.map((tag) => tag.replace(/_/g, " ")).join(", ");
}

function wardrobeLine(character: Character): string {
  const sets = [
    `everyday — ${spoken(character.outfit)}`,
    `PE kit — ${spoken(character.peOutfit)}`,
    `swimsuit — ${spoken(character.swimOutfit)}`,
    ...Object.values(character.customOutfits ?? {}).flatMap((set) => {
      const name = set?.name?.trim();
      return name && set && set.tags.length > 0 ? [`"${name}" — ${spoken(set.tags)}`] : [];
    }),
  ];
  return `${character.firstName}'s clothes: ${sets.join("; ")}. If the picture has her in one of these, say which — "her everyday clothes", "her PE kit", "her swimsuit"${sets.length > 3 ? ", or the name of the set" : ""} — rather than describing it.`;
}

const INTIMATE_REASON: Record<Reason, string> = {
  intimate: "She has already been that far with him, so nothing is being asked for the first time.",
  promiscuous: "This is nothing new for her: she sends pictures like this to people she's into, and he has her number.",
  crush:
    "She's into him, but they haven't been together. Sending one is her own decision, and not a small one: she does it when she wants to, never because he pushed.",
};

function opening(name: string): string[] {
  return [
    "PHOTOS",
    `${name} can attach one picture to this reply. Set "sendPhoto" and describe it in "photoPrompt".`,
    'That is the only way a picture gets sent: writing "[attached a photo: ...]" or describing it in "messages" sends nothing.',
  `If ${name}'s texts say she is sending, attaching or has just taken a picture, "sendPhoto" must be true with its "photoPrompt" in this same reply. If she isn't sending one now, her texts don't say she is.`,
  ];
}

// ---- Shot types -------------------------------------------------------------------------------
// Given a free choice, the model writes a selfie nearly every time. So the app picks the kind of
// shot each time a picture is possible, with selfies as just one option among several.

export type ShotType = "selfie" | "mirror" | "taken" | "timer" | "candid";

const SHOTS: Array<{ shot: ShotType; weight: number; line: (name: string) => string }> = [
  {
    shot: "selfie",
    weight: 2,
    line: (name) => `If ${name} sends one this time, it is a regular selfie: she holds the phone out at arm's length. Say "selfie" in the caption.`,
  },
  {
    shot: "mirror",
    weight: 2,
    line: (name) => `If ${name} sends one this time, it is a mirror selfie: she is photographing her reflection, phone in hand. Say "mirror selfie" in the caption.`,
  },
  {
    shot: "taken",
    weight: 3,
    line: (name) =>
      `If ${name} sends one this time, it is NOT a selfie: somebody else took it of her from a few steps away, so her whole outfit or most of her body is in frame. Say how much of her is in it ("full body", "from the knees up"), whether she is standing, sitting, leaning or lying, and her pose. Do not use the word selfie.`,
  },
  {
    shot: "timer",
    weight: 2,
    line: (name) =>
      `If ${name} sends one this time, it is NOT a selfie: she propped her phone up on a timer and posed for it, both hands free, a few feet back from the camera. Describe the pose and how much of her is in frame. Do not use the word selfie.`,
  },
  {
    shot: "candid",
    weight: 1,
    line: (name) =>
      `If ${name} sends one this time, it is NOT a selfie: a candid shot somebody snapped of her while she wasn't posing, caught mid-moment and looking away from the camera. Say "candid" and what she is doing. Do not use the word selfie.`,
  },
];

/** The kind of shot the reader's own text asks for, if it names one. */
export function shotFromAsk(text: string): ShotType | null {
  const t = text.toLowerCase();
  if (/\bmirror\b/.test(t)) return "mirror";
  if (/\b(?:candid|when (?:you(?:'?re| are)|ur) not looking|caught (?:you|u))\b/.test(t)) return "candid";
  if (/\b(?:timer|tripod|propped|prop (?:the|your|ur) phone)\b/.test(t)) return "timer";
  if (
    /\b(?:full[- ]?body|whole (?:outfit|body|fit)|head to toe|fit ?check|ootd|outfit|what (?:are )?(?:you|u)(?:'?re| are)? wearing|someone (?:take|took)|have (?:someone|somebody|a friend|your friend|ur friend) take|from (?:far|further) away)\b/.test(t)
  ) {
    return "taken";
  }
  if (/\bselfies?\b/.test(t)) return "selfie";
  return null;
}

export function pickShot(random = Math.random): ShotType {
  const total = SHOTS.reduce((sum, s) => sum + s.weight, 0);
  let roll = random() * total;
  for (const s of SHOTS) {
    roll -= s.weight;
    if (roll < 0) return s.shot;
  }
  return "taken";
}

/**
 * Keeps her caption to the shot that was asked for: a "selfie" in a caption for a photo
 * somebody took becomes a plain photo, since the image tags turn the word "selfie" into an
 * arm's-length shot.
 */
export function captionForShot(caption: string, shot: ShotType): string {
  if (shot === "selfie" || shot === "mirror") return caption;
  return caption
    .replace(/\bmirror[- ]selfies?\b/gi, "photo")
    .replace(/\bselfies?\b/gi, "photo")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function captioning(character: Character, shot: ShotType, replacement = false): string[] {
  const name = character.firstName;
  const shotLine = SHOTS.find((s) => s.shot === shot)?.line(name) ?? "";
  return [
    replacement
      ? 'This is a replacement of a reply that already included a picture. Include a fresh picture with the replacement: set "sendPhoto" true and supply its "photoPrompt".'
      : 'A picture is worth sending when the texts are already about one — she offers it, or he asked and she wants to. Most replies are just words: set "sendPhoto" false and leave "photoPrompt" empty.',
    `Write "photoPrompt" as what the picture shows, the way ${name} would caption it to herself. One sentence, and a full one: where she is, what she is wearing, how she is sitting or lying or standing, what her hands are doing, how close the shot is, and where she is looking.`,
    shotLine,
    'What is not written is not drawn. A caption that says only "a photo of me" gets a picture of nobody in particular.',
    wardrobeLine(character),
    'Then set "photoTier" to what that picture is, which is a separate question from whether she would send it: "everyday" for one with nothing on show, "suggestive" for underwear, swimwear or a towel, "explicit" for one where any part of her usually covered is not. Judge the picture you described, not the words you described it in — a caption that never says a word for it can still be a picture of one. "none" where there is no picture.',
  ];
}

function keeping(name: string): string[] {
  return [
    "Describe the picture itself: how she looks in it, not how it was taken or sent. A phone only appears in it when it's a mirror selfie.",
    `${name} is the only person in the picture. Whoever took it stays behind the camera: nobody else is in it, touching her, or doing anything with her.`,
    'Name nobody and nowhere: not herself, not the reader, not a building, a dorm or a place on the map. A picture cannot show a name. "her room", "a lecture hall", "the cafe" — what it looks like, never what it is called.',
    "Her texts should read like somebody who just sent that picture. Do not describe it in them.",
    "Any picture she has already sent is written into RECENT MESSAGES beside the text it came with. She knows what she sent him and would not send the same one twice.",
    "",
  ];
}

/** The PHOTOS block of a DM prompt; empty when she may not send one. */
export function photoPromptLines(character: Character, info: CharInfo | undefined, allowed: PhotoTier, shot: ShotType = "taken", replacement = false): string[] {
  if (allowed === "none") return [];
  const name = character.firstName;
  if (allowed === "explicit") {
    const reason = photoReasonOf(info?.flags ?? emptyFlags(), character.traits) ?? "crush";
    return [
      ...opening(name),
      `${name} will send anything of herself, undressed included. ${INTIMATE_REASON[reason]}`,
      ...captioning(character, shot, replacement),
      `So a picture of ${name} undressed is captioned as one, in plain words: what is bare, what she is doing, what the shot shows. Coy wording is a coy picture — "the top of a shirt" is a photograph of a shirt.`,
      `Write it as she would, not as a catalogue: she is sending this to ${reason === "intimate" ? "somebody she has slept with" : "somebody she's into"}, and she knows what she is doing.`,
      ...keeping(name),
    ];
  }
  return [
    ...opening(name),
    allowed === "suggestive"
      ? `${name} will send a flirty one — what she is wearing, a swimsuit, underwear — but nothing more than that. Nothing undressed.`
      : `${name} only sends ordinary pictures: where she is, what she is eating, her outfit, something that made her laugh. Nothing flirty, nothing undressed.`,
    ...captioning(character, shot, replacement),
    ...keeping(name),
  ];
}

export const PHOTO_SCHEMA_FIELDS = {
  sendPhoto: { type: "boolean" },
  photoPrompt: { type: "string" },
  photoTier: { type: "string", enum: [...PHOTO_TIERS] },
};


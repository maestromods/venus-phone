// When a girl may attach a picture to a DM, what the prompt tells her about it, and the check
// her caption has to pass. Adapted from naudh1r's Photo Feature mod in Venus Extracurriculars
// (allowedPhotoTier, settlePhoto, photoLines), separately from the base game's Photos feature.
// Source: https://github.com/naudh1r/venus-university/tree/photo-feature

import { affectionFor, dispositionOf } from "../game/relationship.js";
import { emptyFlags, hasTrait, type Character, type CharInfo, type Flags, type PhotoTier, type Gender } from "../game/types.js";

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
  const feeling = dispositionOf(affectionFor(info, today, character));
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

// Caption classification follows VE v0.9.2 Photo 1.9.0.
export function maleTopBare(caption: string): boolean {
  const text = caption.toLowerCase()
  return (
    saysAny(text, [
      'shirtless',
      'topless',
      'bare-chested',
      'bare chested',
      'bare chest',
      'bare torso',
      'bare front',
      'chest bare',
      'exposed chest',
      'nude from the waist up',
      'naked from the waist up',
      'bare from the waist up',
      'undressed from the waist up'
    ]) ||
    /\b(?:without (?:a |his )?shirt|shirt (?:off|removed)|nothing (?:on|covering) (?:his )?(?:chest|torso|upper body))\b/.test(
      text
    ) ||
    (/\b(?:wearing only|wearing nothing but|dressed in only|clad only in)\b/.test(text) &&
      saysAny(text, ['shorts', 'pants', 'jeans', 'trousers', 'boxers', 'briefs', 'swim trunks']))
  )
}

export function describedPhotoTier(photoPrompt: string, gender: Gender = 'female'): PhotoTier {
  const text = photoPrompt.toLowerCase()
  if (!text.trim()) return 'none'
  if (gender === 'male') {
    // An uncovered upper body is ordinary; removing a lower garment still is not.
    const upperOnly = [
      'topless',
      'bare-chested',
      'bare chested',
      'bare chest',
      'bare torso',
      'bare front',
      'bare from the waist up',
      'chest bare',
      'exposed chest',
      'shirtless',
      'nipple',
      'nothing covering'
    ]
    const onlyGarment = [
      'wearing only',
      'wearing nothing but',
      'dressed in only',
      'in only her',
      'clad only in'
    ]
    const explicit = EXPLICIT_WORDS.filter(
      (word) => !upperOnly.includes(word) && !onlyGarment.includes(word)
    )
    const bottomOff =
      /\b(?:pulling|tugging|sliding|taking) (?:down|off) (?:his |her |the )?(?:pants|shorts|boxers|briefs|underwear)\b|\b(?:bottomless|no (?:bottoms|underwear|boxers|briefs|pants)|without (?:underwear|boxers|briefs|pants)|(?:pants|shorts|trousers|boxers|briefs|underwear).{0,30}(?:down|off|aside)|(?:naked|nude|bare) (?:from the waist down|below the waist)|nothing (?:on )?below)\b/
    const onlyTop =
      /\b(?:wearing only|wearing nothing but|dressed in only|clad only in|in only his)\b/.test(
        text
      ) &&
      !saysAny(text, [
        'shorts',
        'pants',
        'jeans',
        'trousers',
        'boxers',
        'briefs',
        'underwear',
        'swim trunks',
        'swimsuit',
        'towel'
      ])
    const upper = text
      .replace(/\bwearing nothing but\b/g, 'wearing only')
      .replace(/\b(?:naked|nude|bare|undressed) (?:from the waist up|above the waist)\b/g, '')
      .replace(/\bnothing (?:covering|on) (?:his )?(?:chest|torso|upper body)\b/g, '')
    if (
      saysAny(upper, explicit) ||
      saysAny(text, ['penis', 'cock', 'dick', 'testicles', 'anus']) ||
      bottomOff.test(text) ||
      onlyTop
    )
      return 'explicit'
  } else if (saysAny(text, EXPLICIT_WORDS)) return 'explicit'
  if (saysAny(text, SUGGESTIVE_WORDS)) return 'suggestive'
  return 'everyday'
}

export function describesSomebodyElse(
  photoPrompt: string,
  gender: Gender = 'female'
): boolean {
  const text = photoPrompt.toLowerCase()
  const other =
    gender === 'male' ? NOT_SOLO_WORDS.filter((word) => !word.startsWith('his ')) : NOT_SOLO_WORDS
  if (
    saysAny(text, [
      ...other,
      ...(gender === 'male' ? ['with her'] : []),
      'another boy',
      'other boy',
      'two boys',
      'girlfriend',
      'kissing her',
      'riding her'
    ])
  )
    return true
  return (
    saysAny(text, gender === 'male' ? ['pussy', 'vagina', 'clitoris'] : PARTNER_BODY_WORDS) &&
    !saysAny(text, TOY_WORDS)
  )
}

export type PhotoVerdict = { send: true; tier: Exclude<PhotoTier, "none"> } | { send: false; note?: string };

/** Whether the picture she described goes out, and at what tier. */
export function settlePhoto(input: { sendPhoto: boolean; photoPrompt: string; stated?: PhotoTier; allowed: PhotoTier; gender?: Gender }): PhotoVerdict {
  const { sendPhoto, photoPrompt, allowed, stated } = input;
  if (!sendPhoto || !photoPrompt.trim()) return { send: false };
  if (allowed === "none") return { send: false, note: "photos are unavailable" };
  if (describesSomebodyElse(photoPrompt, input.gender)) return { send: false, note: "the picture includes another person" };
  const described = describedPhotoTier(photoPrompt, input.gender);
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
  return `${character.firstName}'s clothes: ${sets.join("; ")}. Name the chosen outfit when using one of these sets.`;
}

// ---- Shot types -------------------------------------------------------------------------------
// Given a free choice, the model writes a selfie nearly every time. So the app picks the kind of
// shot each time a picture is possible, with selfies as just one option among several.

export type ShotType = "selfie" | "mirror" | "taken" | "timer" | "candid";

const SHOTS: Array<{ shot: ShotType; weight: number }> = [
  { shot: "selfie", weight: 2 }, { shot: "mirror", weight: 2 },
  { shot: "taken", weight: 3 }, { shot: "timer", weight: 2 }, { shot: "candid", weight: 1 },
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

export function photoPromptLines(character: Character, info: CharInfo | undefined, allowed: PhotoTier, shot: ShotType = "taken", replacement = false): string[] {
  if (allowed === "none") return [];
  const name = character.firstName;
  const reason = photoReasonOf(info?.flags ?? emptyFlags(), character.traits);
  const framing: Record<ShotType, string> = {
    selfie: 'A regular selfie at arm\'s length. Say "selfie" in the caption.',
    mirror: 'A mirror selfie, with the phone visible in the reflection. Say "mirror selfie".',
    taken: 'Somebody else took the picture from a few steps away. Describe framing, posture and pose. Do not use the word selfie.',
    timer: 'A posed timer photo with both hands free, a few feet from the camera. Describe pose and framing. Do not use the word selfie.',
    candid: 'A candid moment without posing, looking away from the camera. Say "candid" and describe the activity. Do not use the word selfie.',
  };
  return [
    "PHOTOS",
    `${name} can attach one picture using "sendPhoto" and "photoPrompt". Describing it in "messages" sends nothing.`,
    replacement
      ? 'The original reply had a picture. Set "sendPhoto" true and supply a fresh "photoPrompt" with its replacement.'
      : 'Usually set "sendPhoto" false. Send a picture when the conversation calls for one and the character wants to. Text promising an attached picture must include it in the same reply.',
    allowed === "explicit"
      ? `${name} may send an undressed picture. ${reason === "intimate" ? "They have already been intimate." : "Sending one is a personal choice, never an obligation."}`
      : allowed === "suggestive"
        ? `${name} may send a flirty picture, swimwear or underwear, within the character's own boundaries.`
        : `${name} sends ordinary pictures of an outfit, activity or setting, with nothing flirty.`,
    `Write one complete sentence about ${name}'s appearance, clothing, setting, posture, hands, expression and framing. Use the character's pronouns.`,
    framing[shot],
    wardrobeLine(character),
    'Set "photoTier" from the described picture. "everyday" for ordinary clothing, "suggestive" for underwear or swimwear, "explicit" for exposed intimate anatomy. A male bare upper body alone is everyday. Never exceed the permitted tier.',
    `${name} is the only person in the frame. The photographer stays behind the camera.`,
    "Describe the appearance of places and people without using their names. The camera or phone appears only in a mirror selfie.",
    "Let the texts accompany the photo naturally. Do not describe the picture in the text bubbles, and do not repeat a picture already sent in RECENT MESSAGES.",
    "",
  ];
}

export const PHOTO_SCHEMA_FIELDS = {
  sendPhoto: { type: "boolean" },
  photoPrompt: { type: "string" },
  photoTier: { type: "string", enum: [...PHOTO_TIERS] },
};


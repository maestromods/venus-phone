// Turns her photo caption into ComfyUI tags, adapted from buildPhotoPrompt in naudh1r's
// Photo Feature mod in Venus Extracurriculars, not the base game's Photos feature.
// Source: https://github.com/naudh1r/venus-university/tree/photo-feature
// The checkpoint is tag-driven, so the caption's pose,
// framing, selfie type, outfit and what is or isn't covered all have to become tags; passing
// the sentence through alone gets a picture that ignores most of it.
//
// Left out from this adaptation of the mod: place-name stripping for its map locations (the prompt already tells
// her not to name places) and the optional "body details" mod, which is off by default there.

import type { Character } from "./game/types.js";

type Tier = "everyday" | "suggestive" | "explicit";

// ---- Matching ---------------------------------------------------------------------------------

const compiled = new Map<string, RegExp>();
function patternOf(cue: string): RegExp {
  let pattern = compiled.get(cue);
  if (!pattern) {
    const prefix = cue.endsWith("*");
    const stem = (prefix ? cue.slice(0, -1) : cue).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${stem}${prefix ? "" : "(?![\\p{L}\\p{N}_])"}`, "u");
    compiled.set(cue, pattern);
  }
  return pattern;
}
const says = (text: string, cue: string) => patternOf(cue).test(text);
const saysAny = (text: string, cues: readonly string[]) => cues.some((cue) => says(text, cue));
const uniq = (tags: string[]) => [...new Set(tags)];

// ---- Body regions: what the framing shows and the clothes cover ---------------------------------

type Region = "bust" | "nipples" | "stomach" | "hipsThighs" | "buttocks" | "pubic";
const REGIONS: Region[] = ["bust", "nipples", "stomach", "hipsThighs", "buttocks", "pubic"];
const SEEN_BY_DEFAULT: Region[] = ["bust", "nipples", "pubic", "hipsThighs"];
const FRAMING_SEEN: Array<{ cues: string[]; seen: Region[] }> = [
  { cues: ["waist up", "upper body", "bust shot", "headshot", "portrait", "close-up", "close up"], seen: ["bust", "nipples"] },
  {
    cues: ["all fours", "hands and knees", "bent over", "bending over", "ass up", "presenting", "spreading her ass", "spreading her cheeks", "grabbing her ass"],
    seen: ["buttocks", "hipsThighs", "pubic"],
  },
  { cues: ["from behind", "back view", "rear view", "back turned", "over her shoulder"], seen: ["buttocks", "hipsThighs"] },
  {
    cues: ["legs up", "legs in the air", "legs raised", "knees to her chest", "ankles up", "spread eagle", "spread-eagle"],
    seen: ["bust", "nipples", "pubic", "hipsThighs", "buttocks"],
  },
  { cues: ["on her back", "onto her back", "lying on her back", "lying back", "lying down"], seen: ["bust", "nipples", "pubic", "hipsThighs"] },
  { cues: ["waist down", "lower body", "bottomless", "no bottoms"], seen: ["pubic", "hipsThighs", "buttocks"] },
];
const SPREAD_CUES = ["spread legs", "legs apart", "legs open", "thighs spread", "legs spread", "spreading her pussy", "spread pussy"];
const REAR_CUES = ["spreading her ass", "spreading her cheeks", "holding her cheeks apart"];
const FRAMED_SEEN: Record<string, Region[]> = { face: [], waist: ["bust", "nipples"] };

function seenIn(caption: string, framing: string | null): Set<Region> {
  const text = caption.toLowerCase();
  const close = framing ? FRAMED_SEEN[framing] : undefined;
  const row = FRAMING_SEEN.find((rule) => saysAny(text, rule.cues));
  const seen = new Set<Region>(close ?? row?.seen ?? SEEN_BY_DEFAULT);
  if (saysAny(text, SPREAD_CUES)) seen.add("pubic");
  if (saysAny(text, REAR_CUES)) seen.add("buttocks");
  if (framing !== "face") seen.add("stomach");
  return seen;
}

const ALL: Region[] = [...REGIONS];
const TOP: Region[] = ["bust", "nipples", "stomach"];
const HIDES: Record<string, Region[]> = {
  dress: ALL, sundress: ALL, gown: ALL, uniform: ALL, pyjamas: ALL, pajamas: ALL,
  coat: TOP, jacket: TOP, hoodie: TOP, sweater: TOP, cardigan: TOP, shirt: TOP, blouse: TOP, "tank top": TOP,
  "crop top": ["bust", "nipples"],
  jeans: ["hipsThighs", "buttocks", "pubic"], trousers: ["hipsThighs", "buttocks", "pubic"], pants: ["hipsThighs", "buttocks", "pubic"],
  shorts: ["buttocks", "pubic"], skirt: ["buttocks", "pubic"],
  towel: ["bust", "nipples", "stomach", "pubic", "buttocks"],
  clothes: TOP, outfit: TOP,
};
const SHAPES: Record<string, Region[]> = {
  bra: ["bust", "nipples"], bralette: ["bust", "nipples"], "bikini top": ["bust", "nipples"],
  bikini: ["bust", "nipples", "pubic", "buttocks"], swimsuit: ["bust", "nipples", "pubic", "buttocks"], "one-piece": ["bust", "nipples", "pubic", "buttocks"],
  lingerie: ["bust", "nipples", "pubic"], negligee: ["bust", "nipples"], corset: ["bust", "nipples", "stomach"], lace: ["bust", "nipples"],
  panties: ["pubic", "buttocks"], underwear: ["bust", "nipples", "pubic", "buttocks"], thong: ["pubic"], "g-string": ["pubic"],
  leggings: ["hipsThighs", "buttocks", "pubic"], stockings: [],
};
const DISPLACED = "(?:pulled (?:to the side|aside|down|up|off)|bunched|hiked up|hitched up|lifted|pushed (?:up|aside|down)|moved aside|tugged (?:aside|down)|around her (?:ankles|knees))";
const displaced = (text: string, word: string) => new RegExp(`\\b${word}\\b(?:\\s+[a-z'-]+){0,2}?\\s+${DISPLACED}`).test(text);

const BARE_CUES = [
  "naked", "nude", "no clothes", "undressed", "without clothes", "fully exposed", "topless", "bottomless", "wearing nothing", "nothing on",
  "bare-chested", "bare chested", "bare chest", "bare torso", "bare front", "chest bare", "breasts bare", "exposed breasts", "exposed chest",
  "uncovered breasts", "shirtless", "braless", "no bra", "without a bra", "nothing covering", "wearing only", "wearing nothing but",
  "dressed in only", "in only her", "clad only in",
];

function coverageIn(caption: string, bare: boolean): Record<Region, "exposed" | "shape" | "hidden"> {
  const text = caption.toLowerCase();
  const coverage = Object.fromEntries(REGIONS.map((r) => [r, "exposed"])) as Record<Region, "exposed" | "shape" | "hidden">;
  if (bare && saysAny(text, BARE_CUES)) return coverage;
  for (const [word, regions] of Object.entries(SHAPES)) {
    if (!says(text, word) || displaced(text, word)) continue;
    for (const r of regions) coverage[r] = "shape";
  }
  for (const [word, regions] of Object.entries(HIDES)) {
    if (!says(text, word) || displaced(text, word)) continue;
    for (const r of regions) coverage[r] = "hidden";
  }
  return coverage;
}

const BARE_TAGS: Partial<Record<Region, string>> = { nipples: "nipples", stomach: "navel", pubic: "pussy" };
const THROUGH_CLOTH: Partial<Record<Region, string>> = { bust: "cleavage", hipsThighs: "wide_hips" };

function bodyTagsFor(caption: string, bare: boolean, framing: string | null): string[] {
  const seen = seenIn(caption, framing);
  const coverage = coverageIn(caption, bare);
  const tags: string[] = [];
  for (const region of REGIONS) {
    if (!seen.has(region)) continue;
    const state = coverage[region];
    if (state === "hidden") continue;
    const nude = BARE_TAGS[region];
    if (state === "exposed" && bare && nude) tags.push(nude);
    if (state === "shape") {
      const through = THROUGH_CLOTH[region];
      if (through) tags.push(through);
    }
  }
  return tags;
}

const describesNothingOn = (caption: string) =>
  saysAny(caption.toLowerCase(), ["naked", "nude", "no clothes", "undressed", "without clothes", "wearing nothing", "nothing on"]);

// ---- Framing and pose ---------------------------------------------------------------------------

const FRAMINGS = [
  { framing: "face", cues: ["face shot", "face only", "just her face", "headshot", "her face filling"], tags: ["close-up", "portrait"] },
  { framing: "waist", cues: ["waist up", "from the waist", "upper body", "chest up", "bust shot", "shoulders up"], tags: ["(upper_body:1.3)"] },
  { framing: "knees", cues: ["knees up", "from the knees", "thighs up", "thigh up", "mid-thigh", "mid thigh"], tags: ["cowboy_shot"] },
  { framing: "full", cues: ["full body", "full-body", "head to toe", "whole body", "full length", "full-length", "whole outfit"], tags: ["full_body"] },
];
const framingOf = (caption: string) => FRAMINGS.find((row) => saysAny(caption.toLowerCase(), row.cues))?.framing ?? null;
const framingTags = (framing: string) => FRAMINGS.find((row) => row.framing === framing)?.tags ?? [];
const FULL_BODY_CUES = FRAMINGS.find((row) => row.framing === "full")?.cues ?? [];
const FRAMING_TAGS = new Set(["close-up", "portrait", "upper_body", "cowboy_shot", "full_body", ...FRAMINGS.flatMap((row) => row.tags)]);

function framingInTags(tags: string[]): string | null {
  if (tags.includes("portrait")) return "face";
  if (tags.includes("full_body")) return "full";
  if (tags.some((tag) => tag === "upper_body" || tag.startsWith("(upper_body:"))) return "waist";
  if (tags.includes("cowboy_shot")) return "knees";
  return null;
}

interface Rule {
  cues: string[];
  tags: string[];
  implies?: string[];
}
const firstMatch = (text: string, table: Rule[]) => table.find((rule) => saysAny(text, rule.cues)) ?? null;

const DRESSED_POSITIONS: Rule[] = [
  { cues: ["close-up", "close up"], tags: ["close-up", "upper_body", "hand_up"] },
  { cues: ["face shot", "face only", "just her face"], tags: ["close-up", "portrait"] },
  { cues: ["on her stomach", "face down", "prone"], tags: ["lying", "on_stomach"] },
  { cues: ["on her side", "side lying"], tags: ["lying", "on_side"] },
  { cues: ["on her back", "lying back"], tags: ["lying", "on_back"] },
  { cues: ["lying", "laying", "on the bed", "on bed", "on the floor", "on the grass"], tags: ["lying", "arms_at_sides"] },
  { cues: ["sitting", "seated", "cross-legged", "on the chair", "on the couch", "on a bench"], tags: ["sitting", "cowboy_shot", "hands_on_lap"] },
  { cues: ["kneeling", "crouching"], tags: ["kneeling", "hands_on_own_thighs"] },
  { cues: ["leaning over", "leaning forward"], tags: ["leaning_forward", "hand_on_own_chin"] },
  { cues: ["leaning against", "leaning on"], tags: ["against_wall", "crossed_arms"] },
  { cues: ["standing", "walking"], tags: ["standing", "cowboy_shot", "hand_on_own_hip"] },
  { cues: ["stretching", "reaching up"], tags: ["standing", "arms_up", "armpits"] },
];
const FACING: Rule[] = [
  { cues: ["looking back", "glancing back", "over her shoulder"], tags: ["looking_back", "from_behind", "hand_on_own_hip"] },
  { cues: ["from behind", "back view", "rear view", "back turned"], tags: ["from_behind", "hand_on_own_hip"] },
  { cues: ["from the side", "side view", "in profile", "side profile", "profile shot"], tags: ["from_side", "profile"] },
];
const BARE_POSITIONS: Rule[] = [
  { cues: ["on all fours", "all fours", "hands and knees"], tags: ["all_fours", "solo"] },
  { cues: ["bent over", "bending over", "bent forward"], tags: ["bent_over", "solo", "hands_on_own_knees"] },
  { cues: ["from behind"], tags: ["from_behind", "solo", "ass_focus"] },
  { cues: ["legs up", "legs in the air", "legs raised", "knees to her chest", "ankles up"], tags: ["lying", "on_back", "solo", "legs_up", "knees_up"] },
  { cues: ["spread eagle", "spread-eagle", "splayed out"], tags: ["lying", "on_back", "solo", "spread_legs"] },
  { cues: ["on her back", "onto her back", "lying on her back", "lying back", "on back"], tags: ["lying", "on_back", "solo", "arms_up"] },
  { cues: ["on her stomach", "face down", "lying on her stomach", "prone"], tags: ["lying", "on_stomach", "solo", "head_rest"] },
  { cues: ["on her side", "lying on her side", "side lying"], tags: ["on_side", "solo", "head_rest"] },
  { cues: ["squatting", "squat"], tags: ["squatting", "solo", "spread_legs", "hand_on_own_thigh"] },
  { cues: ["on her knees", "kneeling"], tags: ["kneeling", "solo", "hands_on_own_thighs"] },
  { cues: ["against the wall", "against wall"], tags: ["against_wall", "solo", "arms_at_sides"] },
  { cues: ["sitting on the bed", "sitting on her bed"], tags: ["sitting", "on_bed", "solo", "hands_on_lap"] },
  { cues: ["sitting", "seated", "cross-legged"], tags: ["sitting", "solo", "spread_legs", "hands_on_own_thighs"] },
  { cues: ["standing"], tags: ["standing", "solo", "hand_on_own_hip", "cowboy_shot"] },
  { cues: ["lying", "laying", "on the bed", "on bed", "on the floor"], tags: ["lying", "solo", "arms_at_sides"] },
];
const BARE_POSITION_DEFAULT = ["standing", "solo", "hand_on_own_hip"];
const PLACEMENT_TAGS = new Set([
  "hand_on_own_hip", "hands_on_own_thighs", "hand_on_own_thigh", "hands_on_lap", "hands_on_own_knees", "hands_on_own_ass",
  "head_rest", "arms_at_sides", "arms_up", "hand_up", "hand_on_own_chin", "crossed_arms",
]);
const BUSY_HAND_CUES = [
  "holding", "holds", "clutching", "carrying", "sipping", "drinking", "eating", "taking a bite", "reading", "waving", "hugging", "cradling",
  "playing with her hair", "resting on her hand", "cheek on her hand", "chin on her hand", "chin in her hand", "propped", "biting", "bites",
  "in hand", "in her hand", "in one hand", "glass of", "cup of", "mug of", "tucking her hair", "fixing her hair",
];
const HAND_ACTIONS: Rule[] = [
  {
    cues: [
      "touching herself", "playing with herself", "fingering", "fingers herself", "finger herself", "rubbing herself", "hand between her legs",
      "fingers inside", "masturbat*", "pleasuring herself", "rubbing her clit", "playing with her clit", "two fingers", "slips a finger",
      "slides a finger", "working her fingers",
    ],
    tags: ["masturbation", "fingering", "between_legs"],
    implies: ["lying", "on_back", "solo", "spread_legs"],
  },
  {
    cues: [
      "squeezing her breasts", "cupping her breasts", "cupping herself", "groping", "fondling", "grabbing her breasts", "playing with her nipples",
      "pinching her nipple", "tweaking her nipple", "hand on her breast", "hands on her breasts",
    ],
    tags: ["grabbing_own_breast"],
  },
  {
    cues: ["spreading her pussy", "spreading herself open", "holding herself open", "spreading her lips", "pulling herself open"],
    tags: ["spread_pussy", "pussy", "spread_legs"],
    implies: ["lying", "on_back", "solo", "spread_legs"],
  },
  {
    cues: ["spreading her ass", "spreading her cheeks", "holding her cheeks apart", "grabbing her ass"],
    tags: ["grabbing_own_ass", "ass_focus"],
    implies: ["bent_over", "solo"],
  },
  { cues: ["dildo", "toy inside her", "fucking herself with"], tags: ["sex_toy", "dildo", "vaginal_object_insertion"], implies: ["lying", "on_back", "solo", "spread_legs"] },
  { cues: ["vibrator", "magic wand", "vibe on her"], tags: ["vibrator", "sex_toy", "clitoris"], implies: ["sitting", "solo", "spread_legs"] },
];
const BREAST_ACTION = HAND_ACTIONS[1]!;
const NIPPLE_VERBS = ["play*", "teas*", "pinch*", "tweak*", "roll*", "squeez*", "tug*", "rub*", "flick*"];
const VAGUE_TOUCH: Rule = { cues: ["touching", "hand on", "caressing"], tags: ["hand_on_own_chest"] };
const MODIFIERS: Rule[] = [
  {
    cues: [
      "lifting her skirt", "skirt up", "panties aside", "pulling down her panties", "taking off her bra", "unbuttoning", "unzipping",
      "sliding off", "slipping off", "lifting her shirt", "lifting her top",
    ],
    tags: ["undressing", "clothes_pull"],
  },
  { cues: ["finger in her mouth", "sucking her finger", "biting her lip", "tongue out", "licking her lips", "blowing a kiss", "come-hither"], tags: ["seductive_smile"] },
  { cues: ["orgasm", "climax", "cumming", "ahegao", "ecstasy", "eyes rolled", "trembling with"], tags: ["orgasm", "open_mouth", "rolling_eyes"] },
  { cues: ["squirt", "gushing", "female ejaculation"], tags: ["female_ejaculation"] },
  { cues: ["spread legs", "legs apart", "legs open", "thighs spread", "legs spread"], tags: ["spread_legs"] },
  { cues: ["arching", "arched back", "arches her back"], tags: ["arched_back"] },
  { cues: ["soaking wet", "dripping", "soaked"], tags: ["wet", "sweat"] },
  { cues: ["blushing", "red cheeks", "flushed", "cheeks pink", "cheeks red"], tags: ["blush"] },
  { cues: ["at the camera", "at the phone", "looking at viewer", "eye contact", "staring at"], tags: ["looking_at_viewer"] },
  { cues: ["mirror"], tags: ["mirror", "reflection"] },
  {
    cues: ["from below", "low angle", "from under", "shot low", "shot from low", "looking up at her", "angled up", "camera low", "phone low"],
    tags: ["from_below"],
  },
  {
    cues: ["from above", "high angle", "overhead shot", "shot from above", "looking down at her", "angled down", "camera high", "phone high", "held up high"],
    tags: ["from_above"],
  },
];
const DRESSED_MODIFIERS = new Set(["from_below", "from_above", "undressing", "seductive_smile", "arched_back", "blush", "looking_at_viewer", "mirror"]);

function onePlacement(tags: string[]): string[] {
  const first = tags.find((tag) => PLACEMENT_TAGS.has(tag));
  return tags.filter((tag) => !PLACEMENT_TAGS.has(tag) || tag === first);
}

function poseTagsOf(caption: string, bare: boolean): string[] {
  const text = caption.toLowerCase();
  const tags: string[] = [];
  const dressed = firstMatch(text, DRESSED_POSITIONS);
  const facing = firstMatch(text, FACING);
  if (!bare) {
    if (dressed) tags.push(...dressed.tags);
    if (facing) tags.push(...facing.tags);
    for (const modifier of MODIFIERS) {
      if (DRESSED_MODIFIERS.has(modifier.tags[0]!) && saysAny(text, modifier.cues)) tags.push(...modifier.tags);
    }
    return onePlacement(uniq(tags));
  }
  const position = firstMatch(text, BARE_POSITIONS);
  const matched = HAND_ACTIONS.filter((action) => saysAny(text, action.cues)).slice(0, 2);
  const looseNipples = matched.length === 0 && says(text, "nipple") && saysAny(text, NIPPLE_VERBS);
  const hands = looseNipples ? [BREAST_ACTION] : matched;
  const implied = hands.find((action) => action.implies)?.implies;
  tags.push(...(position?.tags ?? dressed?.tags ?? implied ?? BARE_POSITION_DEFAULT));
  if (facing) tags.push(...facing.tags);
  for (const modifier of MODIFIERS) if (saysAny(text, modifier.cues)) tags.push(...modifier.tags);
  if (hands.length > 0) {
    const kept = tags.filter((tag) => !PLACEMENT_TAGS.has(tag));
    return uniq([...kept, ...hands.flatMap((action) => action.tags)]);
  }
  if (!tags.some((tag) => PLACEMENT_TAGS.has(tag)) && saysAny(text, VAGUE_TOUCH.cues)) tags.push(...VAGUE_TOUCH.tags);
  return onePlacement(uniq(tags));
}

const PHONE_NEGATIVE = ["phone", "cellphone", "smartphone", "holding_phone"];
const CAMERA_CUES = ["holding a camera", "her camera", "a camera in", "film camera", "polaroid"];
const PEACE_CUES = ["peace sign", "v sign", "v-sign", "flashing a v"];

function selfieShot(text: string, tags: string[]): { tags: string[]; negative: string[] } | null {
  if (!says(text, "selfie")) return null;
  const has = (tag: string) => tags.includes(tag);
  const peace = saysAny(text, PEACE_CUES);
  if (says(text, "mirror")) {
    const turned = new Set(["from_behind", "looking_back", "from_side", "profile"]);
    const kept = tags.filter((tag) => !FRAMING_TAGS.has(tag) && !turned.has(tag));
    const framing = framingOf(text);
    const frame = framing ? [...framingTags(framing)] : says(text, "close") || says(text, "close-up") ? [] : ["full_body"];
    return { tags: uniq([...kept, "mirror", "reflection", "holding_phone", ...frame]), negative: [] };
  }
  const kept = tags.filter((tag) => !FRAMING_TAGS.has(tag) && !PLACEMENT_TAGS.has(tag));
  const camera = saysAny(text, CAMERA_CUES) ? [] : ["camera"];
  const busy = !peace && saysAny(text, BUSY_HAND_CUES);
  const negative = [...PHONE_NEGATIVE, ...camera, ...(busy ? ["v"] : [])];
  const low = has("from_below") ? ["looking_down"] : [];
  const shot = (add: string[], extra: string[] = []) => ({
    tags: uniq([...kept, ...add, ...low, ...(peace ? ["v"] : [])]),
    negative: [...negative, ...extra],
  });
  const whole = saysAny(text, FULL_BODY_CUES);
  if (has("on_stomach")) {
    const rest = kept.filter((tag) => tag !== "on_stomach" && tag !== "from_above");
    const legs = whole ? ["(legs_up:1.1)"] : ["upper_body"];
    return { tags: uniq(["(on_stomach:1.2)", ...legs, ...rest, "outstretched_arm"]), negative: [...negative, "on_back"] };
  }
  if (has("on_side")) {
    return shot(["selfie", "from_above", ...(whole ? [] : ["upper_body"])], ["on_back", "on_stomach", "open_hand", "spread_fingers", "reaching_towards_viewer"]);
  }
  if (has("on_back") && !whole) return shot(["selfie", "from_above", "outstretched_arm", "upper_body"], ["on_stomach"]);
  if (whole || has("lying") || has("sitting")) {
    const angle = has("from_below") ? [] : ["from_above", "looking_up"];
    return shot(["full_body", ...angle, "(outstretched_arm:1.2)", "foreshortening"]);
  }
  return shot(["selfie", "upper_body", "outstretched_arm", "foreshortening"]);
}

const CLOSE_CUES = ["close-up", "close up", "upper body", "waist up", "face shot", "just her face"];
const LYING_CUES: Array<[string, string[]]> = [
  ["on_stomach", ["on her stomach", "face down", "prone"]],
  ["on_side", ["on her side", "side lying"]],
  ["on_back", ["on her back", "lying back"]],
];
function closeLying(text: string, tags: string[]): string[] | null {
  if (!saysAny(text, CLOSE_CUES)) return null;
  const lying = LYING_CUES.find(([, cues]) => saysAny(text, cues))?.[0];
  if (!lying) return null;
  const kept = tags.filter((tag) => !FRAMING_TAGS.has(tag) && tag !== "hand_up" && !LYING_CUES.some(([pose]) => pose === tag));
  return uniq(["lying", lying, lying === "on_stomach" ? "upper_body" : "(upper_body:1.3)", ...kept]);
}
function withFraming(text: string, tags: string[]): string[] {
  const framing = framingOf(text);
  if (!framing) return [...tags];
  return uniq([...tags.filter((tag) => !FRAMING_TAGS.has(tag)), ...framingTags(framing)]);
}
function lyingNegative(tags: string[]): string[] {
  if (tags.includes("on_stomach")) return ["on_back"];
  if (tags.includes("on_side")) return ["on_back", "on_stomach"];
  if (tags.includes("on_back")) return ["on_stomach"];
  return [];
}

const CANDID_CUES = ["candid", "not looking", "isn't looking", "is not looking", "looking away", "unaware", "doesn't notice", "does not notice", "not posing", "isn't posing"];
const CROSS_LEGGED_CUES = ["cross-legged", "cross legged", "criss-cross", "legs folded under"];
const CROSSED_CUES = ["legs crossed", "crossed legs", "crosses her legs", "crossing her legs", "legs tightly crossed", "thighs pressed together", "knees together"];

function photoPose(caption: string, bare: boolean): { tags: string[]; negative: string[] } {
  const text = caption.toLowerCase();
  let tags = poseTagsOf(caption, bare);
  if (saysAny(text, CANDID_CUES)) tags = uniq([...tags.filter((tag) => tag !== "looking_at_viewer"), "looking_away"]);
  if (saysAny(text, CROSS_LEGGED_CUES)) tags = uniq([...tags, "indian_style"]);
  if (saysAny(text, CROSSED_CUES)) tags = uniq([...tags.filter((tag) => tag !== "spread_legs"), "crossed_legs"]);
  if (tags.includes("looking_at_viewer")) tags = tags.filter((tag) => tag !== "profile");
  tags = closeLying(text, tags) ?? withFraming(text, tags);
  if (saysAny(text, BUSY_HAND_CUES)) tags = tags.filter((tag) => !PLACEMENT_TAGS.has(tag));
  const noCamera = saysAny(text, CAMERA_CUES) ? [] : ["camera"];
  return selfieShot(text, tags) ?? { tags, negative: [...lyingNegative(tags), ...noCamera] };
}

// ---- Caption clean-up ---------------------------------------------------------------------------

const HOLDS_CAMERA = /\b(?:camera|phone|cellphone|smartphone)\b/;
const HOLDING_IT = /\b(?:hold\w*|rais\w*|angl\w*|aim\w*|lift\w*|tilt\w*|grip\w*|clutch\w*|extend\w*)\b/;
function withoutCameraHold(scene: string): string {
  const text = scene.toLowerCase();
  if (!says(text, "selfie") || says(text, "mirror") || saysAny(text, CAMERA_CUES)) return scene;
  return scene
    .split(/,|;|\s+while\s+|\s+as\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !(HOLDS_CAMERA.test(part.toLowerCase()) && HOLDING_IT.test(part.toLowerCase())))
    .join(", ");
}
function withoutHeldObject(scene: string): string {
  if (!says(scene.toLowerCase(), "mirror")) return scene;
  const verb = "(?:holding|clutching|carrying|cradling|sipping|drinking)";
  const hand = "in\\s+(?:her\\s+|one\\s+|her\\s+free\\s+|her\\s+other\\s+)?hand";
  const held = new RegExp(`\\s*,?\\s*\\b(?:with|${verb})\\s+(?:a|an|her|the|some|one)?\\s*[^,.;]*?\\b${hand}\\b`, "gi");
  const holding = new RegExp(`\\s*,?\\s*\\b${verb}\\s+[^,.;]*`, "gi");
  const keepCamera = (part: string) => (/\b(?:phone|camera)\b/i.test(part) ? part : "");
  return scene.replace(held, keepCamera).replace(holding, keepCamera).replace(/\s{2,}/g, " ").replace(/\s+([,.;])/g, "$1").trim();
}
function withoutWhoTookIt(scene: string): string {
  const person = "(?:friend|roommate|bestie|best friend|boyfriend|sister|mom)";
  const taker = `(?:(?:a|her|my|his|the)\\s+${person}|somebody|someone)`;
  const takenBy = new RegExp(`\\s*,?\\s*(?:taken|shot|snapped)\\s+by\\s+${taker}\\b`, "gi");
  const tookOf = new RegExp(`\\b(?:that\\s+)?${taker}\\s+(?:took|snapped|shot)(?:\\s+of\\s+(?:her|me))?\\s*`, "gi");
  return scene.replace(takenBy, "").replace(tookOf, "").replace(/\s{2,}/g, " ").replace(/\s+([,.;])/g, "$1").trim();
}
function lookingAtViewer(scene: string): string {
  if (/\b(?:her|a|film)\s+camera\b|\bpolaroid\b/i.test(scene)) return scene;
  return scene.replace(/\b(at|into|toward|towards|to)\s+the\s+(?:camera|lens|phone)\b/gi, (_whole, word: string) => `${word} the viewer`);
}
const drinkNotLiquid = (scene: string) => scene.replace(/\bliquid\b/gi, (word) => (word[0] === "L" ? "Drink" : "drink"));
function shopNotDrink(scene: string): string {
  if (/\b(?:holding|holds|sipping|drinking|cup of|glass of|mug of)\b/i.test(scene)) return scene;
  return scene.replace(/\b(?:bubble tea|boba)\s+(shop|caf[eé]|bar|place|store)\b/gi, "tea $1");
}

// Food-named colours ("cream sweater") get drawn as food; the game swaps in plain colours.
const FOOD_COLOURS: Record<string, string> = {
  cream: "ivory", milk: "white", vanilla: "off-white", latte: "beige", butter: "pale yellow", honey: "amber", caramel: "light brown",
  cinnamon: "brown", coffee: "brown", mocha: "brown", chocolate: "dark brown", wine: "burgundy", cherry: "red", strawberry: "pink",
  peach: "light orange", lemon: "yellow", mint: "light green",
};
const COLOURED_THINGS = [
  "shirt", "blouse", "top", "sweater", "cardigan", "hoodie", "jacket", "coat", "dress", "sundress", "skirt", "shorts", "jeans", "trousers",
  "pants", "socks", "stockings", "thighhighs", "tights", "bra", "panties", "lingerie", "underwear", "bikini", "swimsuit", "towel", "robe",
  "pajamas", "pyjamas", "nightie", "sheets", "blanket", "pillow", "scarf", "hat", "beanie", "ribbon", "bow", "nails", "lipstick", "hair",
  "heels", "shoes", "sneakers", "boots", "loafers", "bag", "knit", "wall", "walls",
].join("|");
const FOOD_COLOUR = new RegExp(
  `\\b(${Object.keys(FOOD_COLOURS).join("|")})(?:[- ]colou?red)?\\b(?=(?:[\\s-]+[a-z]+){0,2}?[\\s-]+(?:${COLOURED_THINGS})s?\\b)`,
  "gi",
);
const SHADE_OF = new RegExp(
  `\\b(?:${Object.keys(FOOD_COLOURS).join("|")})[\\s-]+(red|pink|blonde|brown|white|black|yellow|orange|green|blue|purple|beige|gold|silver)\\b`,
  "gi",
);
function plainColours(scene: string): string {
  return scene.replace(SHADE_OF, "$1").replace(FOOD_COLOUR, (word, food: string) => {
    const plain = FOOD_COLOURS[food.toLowerCase()] ?? food;
    return word[0] === word[0]?.toUpperCase() ? plain[0]!.toUpperCase() + plain.slice(1) : plain;
  });
}

const DORMS = ["Elysium Village", "Lowrise 1", "Lowrise 2", "Lowrise 3", "Lowrise 4", "Lowrise 5"];
function withoutNames(character: Character, scene: string): string {
  const names = [`${character.firstName} ${character.lastName}`, character.firstName, character.lastName, ...DORMS]
    .filter((name) => name && name.length > 2)
    .sort((a, b) => b.length - a.length);
  const stripped = names.reduce(
    (text, name) => text.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:['’]s)?\\b`, "gi"), ""),
    scene,
  );
  return stripped.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/^[\s,]+/, "").trim();
}

// ---- Wardrobe and legwear -----------------------------------------------------------------------

const CLOTHING_WORDS = [
  "wearing", "dressed", "outfit", "clothes", "dress", "sundress", "gown", "coat", "jacket", "hoodie", "sweater", "cardigan", "shirt", "blouse",
  "top", "tank top", "crop top", "uniform", "pyjamas", "pajamas", "jeans", "trousers", "pants", "shorts", "skirt", "towel", "bra", "bralette",
  "bikini", "swimsuit", "swimwear", "one-piece", "lingerie", "negligee", "corset", "panties", "underwear", "thong", "g-string", "leggings",
  "stockings", "robe", "bathrobe", "kimono", "yukata", "apron", "costume",
];
const describesClothing = (caption: string) => saysAny(caption.toLowerCase().replace(/\btop of\b/g, ""), CLOTHING_WORDS);

const SWIM_GARMENTS = ["swimsuit", "swimwear", "bikini", "one-piece", "bathing suit"];
const PE_GARMENTS = ["pe kit", "pe uniform", "pe clothes", "gym clothes", "gym kit", "sportswear", "tracksuit"];
const MAIN_NAMES = ["everyday clothes", "everyday outfit", "usual clothes", "usual outfit", "her clothes", "her outfit"];
const SWIM_PLACES = ["pool", "poolside", "beach", "swimming", "swim"];
const PE_PLACES = ["pe", "gym", "workout", "working out", "running", "jogging", "training", "yoga"];

/** One of her own outfit sets, or null where the caption dresses her in something else. */
function photoWardrobe(character: Character, caption: string, captionDressesHer: boolean, swimwearAllowed: boolean): string[] | null {
  const text = caption.toLowerCase();
  for (const set of Object.values(character.customOutfits ?? {})) {
    const name = set?.name?.trim().toLowerCase();
    if (name && set && saysAny(text, [name])) return set.tags.filter((tag) => typeof tag === "string");
  }
  if (saysAny(text, SWIM_GARMENTS)) return character.swimOutfit;
  if (saysAny(text, PE_GARMENTS)) return character.peOutfit;
  if (saysAny(text, MAIN_NAMES)) return character.outfit;
  if (captionDressesHer) return null;
  if (swimwearAllowed && saysAny(text, SWIM_PLACES)) return character.swimOutfit;
  if (saysAny(text, PE_PLACES)) return character.peOutfit;
  return character.outfit;
}

const LEG_ITEMS = ["thigh[- ]?highs?", "thighhighs?", "stockings?", "pantyhose", "tights", "leggings", "kneehighs?", "knee[- ]highs?", "over[- ]the[- ]knee", "socks?", "legwear", "fishnets?"].join("|");
const LEGWEAR = new RegExp(`\\b(?:${LEG_ITEMS})\\b`);
const LEGWEAR_NEGATIVE: Array<[string, RegExp]> = [
  ["pantyhose", /\b(?:pantyhose|tights)\b/],
  ["leggings", /\bleggings\b/],
  ["latex", /\blatex\b/],
  ["thighhighs", /\b(?:thigh[- ]?highs?|thighhighs?|stockings?|over[- ]the[- ]knee)\b/],
];
const LEG_COLOURS = ["pink", "red", "blue", "green", "purple", "yellow", "orange", "brown", "grey"];
function legwear(text: string): { positive: string[]; negative: string[] } {
  const named = LEGWEAR.test(text);
  const short = /\b(?:skirt|shorts|dress|sundress|swimsuit|bikini|towel|nightie|nightgown)\b/.test(text);
  const negative = LEGWEAR_NEGATIVE.filter(([, said]) => !said.test(text)).map(([tag]) => tag);
  const coloured = LEG_COLOURS.filter((colour) => new RegExp(`\\b${colour}\\b(?:\\s+[a-z-]+){0,2}\\s+(?:${LEG_ITEMS})\\b`).test(text));
  if (coloured.length === 0) negative.push("colored_legwear");
  for (const colour of LEG_COLOURS) {
    if (new RegExp(`\\b${colour}\\b`).test(text) && !coloured.includes(colour)) negative.push(`${colour}_legwear`);
  }
  return { positive: !named && short ? ["bare_legs"] : [], negative };
}

const DISPLACEMENTS = [
  { garments: ["thong", "panties", "g-string", "underwear", "bikini bottom"], tag: "panties_aside" },
  { garments: ["skirt", "dress"], tag: "skirt_lift" },
  { garments: ["shirt", "top", "blouse", "sweater", "hoodie", "tank top", "crop top"], tag: "shirt_lift" },
  { garments: ["bra", "bikini top"], tag: "bra_lift" },
];
const MOVED = "(?:pulled (?:to the side|aside|down|up|off)|bunched|hiked up|hitched up|lifted|pushed (?:up|aside|down)|moved aside|tugged (?:aside|down))";
function displacedTags(scene: string): string[] {
  const text = scene.toLowerCase();
  const tags = DISPLACEMENTS.filter(({ garments }) =>
    garments.some((garment) => new RegExp(`\\b${garment}\\b(?:\\s+[a-z'-]+){0,2}?\\s+${MOVED}`).test(text)),
  ).map(({ tag }) => tag);
  if (tags.length === 0 && new RegExp(`\\b${MOVED}`).test(text)) tags.push("clothes_pull");
  return tags;
}

// ---- The prompt ---------------------------------------------------------------------------------

const PHOTO_QUALITY = "masterpiece, best_quality, very_aesthetic";
const PHOTO_BASE = "1girl, solo, depth_of_field";
const PHOTO_NEGATIVE =
  "worst_quality, bad_quality, lowres, simple_background, white_background, transparent_background, multiple_views, reference_sheet, english_text, speech_bubble, artist_name, watermark, signature, 1boy, multiple_boys, multiple_girls, 2girls, hetero, penis, sex, gold, photo_(medium), cum, bad_hands, extra_digits, fewer_digits";
const BARE_POSITIVE = "uncensored";
const BARE_NEGATIVE = "censored, mosaic_censoring, bar_censor, convenient_censoring";
const DRESSED_NEGATIVE: Array<[string, RegExp]> = [
  ["nude", /\b(?:nude|naked)\b/],
  ["nipples", /\bnipples?\b/],
  ["areolae", /\bareola/],
  ["pussy", /\bpussy\b/],
  ["pantyshot", /\b(?:pantyshot|panties|underwear|knickers)\b/],
];
const SHOWS_CLEAVAGE =
  /\b(?:cleavage|unbuttoned|open[- ]shirt|low[- ]cut|plunging|off[- ]shoulder|strapless|tube top|bikini|swimsuit|bra|lingerie|towel|deep v)\b/;
const SPILL_NEGATIVE: Array<[string, RegExp]> = [
  ["paint_splatter", /\b(?:paint|splatter)/],
  ["splashing", /\bsplash/],
  ["stain", /\bstain/],
];
const EVERYDAY_DROPS = new Set(["undressing", "clothes_pull"]);
/** The game only adds these for petite builds; they are kept on every photo here. */
const AGE_GUARD = ["loli", "child", "aged_down"];

export function buildPhotoPrompt(character: Character, tier: Tier, caption: string): { positive: string; negative: string } {
  const scene = shopNotDrink(drinkNotLiquid(plainColours(withoutNames(character, caption.trim()))));
  const bare = tier === "explicit";
  const dressed = describesClothing(scene);
  const pose = photoPose(scene, bare);
  if (tier === "everyday") pose.tags = pose.tags.filter((tag) => !EVERYDAY_DROPS.has(tag));
  const body = bodyTagsFor(scene, bare, framingInTags(pose.tags));
  const wardrobe = bare
    ? dressed && !describesNothingOn(scene)
      ? ["partially_undressed", ...displacedTags(scene), BARE_POSITIVE].join(", ")
      : `nude, completely_nude, ${BARE_POSITIVE}`
    : plainColours((photoWardrobe(character, scene, dressed, tier !== "everyday") ?? []).join(", "));
  const appearance = character.baseAppearance ?? [];
  const base = appearance.includes("1girl") ? PHOTO_BASE.replace("1girl, ", "") : PHOTO_BASE;
  const worn = `${appearance.join(" ")} ${wardrobe} ${scene}`.toLowerCase().replace(/_/g, " ");
  const legs = legwear(worn);
  const sentence = lookingAtViewer(withoutHeldObject(withoutCameraHold(withoutWhoTookIt(scene)))).replace(/[.!?]+$/, "");

  const positive = [
    `${PHOTO_QUALITY}, ${base}`,
    appearance.join(", "),
    body.join(", "),
    [wardrobe, ...legs.positive].filter((part) => part.length > 0).join(", "),
    [sentence, pose.tags.join(", ")].filter((part) => part.length > 0).join(", "),
  ]
    .filter((group) => group.length > 0)
    .join(",\n\n");

  const dressedNegative = bare
    ? []
    : [
        ...DRESSED_NEGATIVE.filter(([, said]) => !said.test(worn)).map(([tag]) => tag),
        ...(tier === "everyday" && !SHOWS_CLEAVAGE.test(worn) ? ["cleavage", "downblouse"] : []),
      ];
  const negative = [
    PHOTO_NEGATIVE,
    ...(bare ? [BARE_NEGATIVE] : []),
    ...dressedNegative,
    ...legs.negative,
    ...SPILL_NEGATIVE.filter(([, said]) => !said.test(scene.toLowerCase())).map(([tag]) => tag),
    ...pose.negative,
    ...AGE_GUARD,
    ...(character.negativeTags ?? []),
  ].join(", ");
  return { positive, negative };
}

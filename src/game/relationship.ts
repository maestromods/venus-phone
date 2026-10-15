// Affection, disposition and the relationship lines a texting prompt carries.
// Ported from the game's renderer (affectionFor, dispositionOf, relationshipLines, readerText);
// a few rarely-hit branches (mood cycles, Echo multipliers, liked-post bonus) are left out.

import { formatShortGameDate, readerYearPhrase, type Season } from "./calendar.js";
import { emptyFlags, hasTrait, type Character, type CharInfo, type Flags, type Memory, type Stats, type StatKey } from "./types.js";

const POINTS: Record<string, number> = { loved: 2, liked: 1, disliked: -1, hated: -2 };

function weightFor(daysAgo: number): number {
  if (daysAgo <= 7) return 4;
  if (daysAgo <= 30) return 2;
  return 1;
}

function spliceByDate(memories: Memory[], entry: Memory): Memory[] {
  let at = memories.length;
  while (at > 0 && (memories[at - 1]?.date ?? 0) > entry.date) at--;
  return [...memories.slice(0, at), entry, ...memories.slice(at)];
}

export function mergedMemories(info: CharInfo | undefined, window?: number): Memory[] {
  let merged = window ? (info?.memories ?? []).slice(-window) : (info?.memories ?? []);
  if (info?.textMemory) merged = spliceByDate(merged, info.textMemory);
  for (const entry of info?.jealousyMemories ?? []) merged = spliceByDate(merged, entry);
  for (const entry of info?.giftMemories ?? []) merged = spliceByDate(merged, entry);
  return merged;
}

export function affectionFor(info: CharInfo | undefined, today: number): number {
  let total = 0;
  for (const entry of mergedMemories(info, 20)) {
    const points = POINTS[entry.type];
    if (points === undefined) continue;
    total += points * weightFor(Math.max(0, today - entry.date));
  }
  return total;
}

export type Disposition = "devoted" | "trusted" | "friendly" | "neutral" | "annoyed" | "hostile";

const TIERS: Array<[number, Disposition]> = [
  [50, "devoted"],
  [30, "trusted"],
  [15, "friendly"],
  [-15, "neutral"],
  [-30, "annoyed"],
];

export function dispositionOf(affection: number): Disposition {
  for (const [floor, tier] of TIERS) if (affection > floor) return tier;
  return "hostile";
}

const DISPOSITION_PHRASE: Record<Disposition, string> = {
  devoted: "is devoted to",
  trusted: "trusts",
  friendly: "is friendly towards",
  neutral: "doesn't particularly care about",
  annoyed: "is annoyed by",
  hostile: "hates",
};

function behaviorLevelOf(flags: Flags, affection: number): string {
  if (flags.isLover) return "withLover";
  if (flags.hasCrush) return "withCrush";
  if (affection <= -15 || flags.brokenUp > 0) return "withEnemy";
  if (affection > 15) return "withFriends";
  return "withStrangers";
}

// Stat tiers: the same thresholds the game uses.
const TIER_THRESHOLDS = [-15, 0, 15, 35, 60, 100];
const PREFERRED_TIER = 3;
const OTHER_TIER = 2;
const CRUSH_FLOOR = TIER_THRESHOLDS[PREFERRED_TIER] ?? 35;
const STAT_KEYS: StatKey[] = ["brain", "body", "heart"];
const STAT_REQUIREMENT_PHRASES: Record<StatKey, string> = { brain: "smarter", body: "more fit", heart: "more charming" };
const STAT_PHRASES: Record<StatKey, string[]> = {
  brain: ["kind of dumb", "not that interesting", "decently smart", "pretty smart", "exceptionally smart", "a god-like genius"],
  body: ["weak and clumsy", "a little plain", "decently fit", "pretty strong and fast", "exceptionally strong and fast", "a god-like superathlete"],
  heart: ["socially awkward", "somewhat forgettable", "easy to get along with", "pretty charming", "exceptionally charming", "a god-like seducer"],
};

function tierOf(points: number): number {
  for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
    if (points >= (TIER_THRESHOLDS[i] ?? Infinity)) return i;
  }
  return 0;
}

function missingCrushStatOf(character: Character, stats: Stats): StatKey | null {
  const preferred = character.preferredStat ?? "heart";
  if (stats[preferred] < CRUSH_FLOOR) return preferred;
  if (!hasTrait(character, "High Standards")) return null;
  return STAT_KEYS.find((key) => key !== preferred && tierOf(stats[key]) < OTHER_TIER) ?? null;
}

function statusLine(name: string, flags: Flags, affection: number, texted: boolean): string | null {
  const disposition = dispositionOf(affection);
  if (!flags.hasMet) {
    return texted ? null : `${name} and the reader are speaking for the first time.`;
  }
  if (flags.isLover) {
    if (disposition === "hostile") return `${name} is breaking up with the reader right now.`;
    if (disposition === "annoyed") return `${name} is thinking of breaking up with the reader.`;
    if (disposition === "neutral") return `${name} and the reader are lovers but their relationship is in danger.`;
    return `${name} and the reader are lovers.`;
  }
  if (flags.benefits) {
    if (flags.hasCrush && flags.friendZoned) {
      return `${name} and the reader are friends with benefits. She wants to be his girlfriend, but the reader has friendzoned her.`;
    }
    if (flags.hasCrush) return `${name} and the reader are friends with benefits, but she wants to make things official.`;
    if (flags.friendZoned || flags.friendZonedBy) return `${name} and the reader are friends with benefits, and she's okay with that.`;
    return affection <= -15
      ? `${name} and the reader have an enemies with benefits relationship.`
      : `${name} and the reader have a friends with benefits relationship.`;
  }
  if (flags.friendZonedBy) return `${name} has friendzoned the reader.`;
  if (flags.friendZoned && flags.hasCrush) return `${name} has a crush on the reader, but the reader has friendzoned her.`;
  if (flags.friendZoned) return `The reader has friendzoned ${name}.`;
  if (flags.hasCrush) return `${name} has a crush on the reader.`;
  return null;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function profileLines(character: Character, flags: Flags): string[] {
  const lines: string[] = [];
  if (character.personality) lines.push(character.personality);
  if (character.backstory) lines.push(`Backstory: ${character.backstory}`);
  if (flags.isLover || flags.hasCrush || flags.benefits) {
    const parts = [character.datingHistory, character.datingPreference, character.kinks]
      .filter((part): part is string => Boolean(part?.trim()))
      .map(sentence);
    if (character.isVirgin && !flags.hadSex) parts.push(`${character.firstName} is a virgin.`);
    if (parts.length > 0) lines.push(`Love life: ${parts.join(" ")}`);
  }
  if (character.likes.length > 0) lines.push(`Likes: ${character.likes.join(", ")}`);
  if (character.dislikes.length > 0) lines.push(`Dislikes: ${character.dislikes.join(", ")}`);
  return lines;
}

export function relationshipLines(
  character: Character,
  info: CharInfo | undefined,
  today: number,
  stats: Stats,
  texted: boolean,
): string[] {
  const name = character.firstName;
  const flags = info?.flags ?? emptyFlags();
  const affection = affectionFor(info, today);
  const lines: string[] = [];
  const behavior = character.behavior[behaviorLevelOf(flags, affection)];
  if (behavior) lines.push(behavior);
  const disposition = dispositionOf(affection);
  if (!flags.hasCrush || disposition !== "neutral") lines.push(`${name} ${DISPOSITION_PHRASE[disposition]} the reader.`);
  if (flags.brokenUp > 0) {
    const times = flags.brokenUp === 1 ? "once" : `${flags.brokenUp} times`;
    lines.push(
      flags.isLover
        ? `${name} and the reader have broken up ${times}, but are lovers right now.`
        : `${name} and the reader have broken up ${times}.`,
    );
  }
  if (!flags.isLover && !flags.hasCrush && !flags.benefits) {
    const missing = missingCrushStatOf(character, stats);
    if (missing) {
      lines.push(
        `${name} doesn't feel any attraction towards the reader ${flags.brokenUp > 0 ? "anymore" : "yet"}. He needs to be ${STAT_REQUIREMENT_PHRASES[missing]} first. ${name} won't make or accept romantic advances.`,
      );
    }
  }
  const status = statusLine(name, flags, affection, texted);
  if (status) lines.push(status);
  if (flags.harem && (flags.isLover || flags.hasCrush || flags.benefits)) {
    lines.push(`${name} is okay with the reader seeing other girls.`);
  }
  return lines;
}

/** "the reader" stands in for "you" inside a memory, as the game's readerize() does. */
function readerize(desc: string): string {
  return desc.replace(/\byou\b/gi, "the reader");
}

export function memoryLines(character: Character, info: CharInfo | undefined, budget: number, season: Season): string[] {
  const memories = dedupe(mergedMemories(info)).slice(-budget);
  if (memories.length === 0) return [];
  return [
    `${character.firstName}'s Memories:`,
    ...memories.map((entry) => {
      const desc = entry === info?.textMemory ? `${entry.desc.replace(/[.!?…]+$/, "")} over text.` : entry.desc;
      return `- ${formatShortGameDate(entry.date, season)}: ${character.firstName} ${entry.type} that ${readerize(desc)}`;
    }),
  ];
}

function dedupe(memories: Memory[]): Memory[] {
  const seen = new Set<string>();
  return memories.filter((entry) => {
    const key = `${entry.date}|${entry.type}|${entry.desc}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function describePlayer(stats: Stats): string {
  const ordered = [...STAT_KEYS].sort((a, b) => stats[a] - stats[b]);
  const phrases = ordered.map((key) => STAT_PHRASES[key][tierOf(stats[key])] ?? "");
  return `The reader is ${phrases[0]}, he is ${phrases[1]}, and he is ${phrases[2]}.`;
}

export function readerText(opts: {
  firstName: string;
  lastName: string;
  termIndex: number;
  stats: Stats;
  bio?: string;
  lovers: string[];
}): string {
  const parts = [
    `The reader is ${readerYearPhrase(opts.termIndex)} named ${opts.firstName} ${opts.lastName}, a male who has a single dorm in Lowrise 4.`,
    describePlayer(opts.stats),
  ];
  if (opts.bio?.trim()) parts.push(sentence(opts.bio.trim()));
  if (opts.lovers.length > 0) parts.push(`The reader is dating ${opts.lovers.join(" and ")}.`);
  return parts.join(" ");
}

import { formatShortGameDate, type Season } from "./calendar.js";
import type { Character, SaveFile } from "./types.js";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** An explicitly cleared mod slice takes precedence over its legacy fields. */
function recordData(record: Record<string, unknown>, mod: string, legacy: unknown) {
  const data = object(object(record.ex)[mod]).data;
  return object(data === undefined ? legacy : data);
}

export function savedPhoto(record: Record<string, unknown>) {
  return recordData(record, "photo-feature", record.photo);
}

export function recentFeedLines(save: SaveFile, character: Character, roster: ReadonlyMap<string, Character>, season: Season, photos: boolean): string[] {
  const posts = (save.charInfo[character.charId]?.feed ?? [])
    .filter(post => typeof post.text === "string" && !(photos && savedPhoto(post).held === true))
    .slice(-2);
  if (!posts.length) return [];
  const lines = [`${character.firstName}'s latest public feed posts:`];
  for (const post of posts) {
    lines.push(`- ${formatShortGameDate(post.date, season)}: "${post.text}"`);
    const photo = savedPhoto(post);
    if (photos && typeof photo.file === "string" && photo.file && !photo.pending && !photo.failed &&
        typeof photo.scene === "string" && photo.scene.trim()) {
      const other = typeof photo.with === "string" && roster.get(photo.with);
      lines.push(`  With a photo of her${other ? " and " + other.firstName : ""}: ${photo.scene.replace(/\s+/g, " ").trim()}`);
    }
    if (!Array.isArray(post.comments)) continue;
    const shown = post.comments.map(object).filter(c => typeof c.at === "number" && c.at <= save.date * 2 + save.time && typeof c.text === "string")
      .map(c => ({ id: c.id, text: c.text, data: recordData(c, "bunnyfeeds", c) }));
    const his = shown.filter(c => c.data.player === true && typeof c.id === "string");
    const replies = shown.filter(c => c.data.charId === character.charId && his.some(h => h.id === c.data.replyTo));
    for (const h of his.filter(h => replies.some(r => r.data.replyTo === h.id))) lines.push(`  The reader commented: "${h.text}"`);
    for (const reply of replies) lines.push(`  ${character.firstName} answered: "${reply.text}"`);
  }
  return lines;
}

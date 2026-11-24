import type { PlaythroughRecord, SaveFile } from "./types.js";

/** Mirrors 0.5.0's semesterOf: the record's top level always describes semester zero. */
export function semesterOf(record: PlaythroughRecord, id?: string, save?: Pick<SaveFile, "transfers">) {
  const semester = id === undefined ? { index: 0, chars: record.chars, alumni: [], profiles: record.profiles ?? {} } : record.semesters?.[id];
  if (!semester) throw new Error("This save's semester is missing from its playthrough record.");
  const transfers = save?.transfers ?? [];
  return {
    index: semester.index,
    // Graduates remain available for texting in the game.
    chars: [...new Set([...semester.chars, ...semester.alumni, ...transfers.map(t => t.charId)])],
    profiles: { ...semester.profiles, ...Object.fromEntries(transfers.map(t => [t.charId, t.profile])) },
  };
}

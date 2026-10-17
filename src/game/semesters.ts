import type { PlaythroughRecord } from "./types.js";

/** Mirrors 0.5.0's semesterOf: the record's top level always describes semester zero. */
export function semesterOf(record: PlaythroughRecord, id?: string) {
  if (id === undefined) return { index: 0, chars: record.chars, profiles: record.profiles ?? {} };
  const semester = record.semesters?.[id];
  if (!semester) throw new Error("This save's semester is missing from its playthrough record.");
  return {
    index: semester.index,
    // Graduates remain available for texting in the game.
    chars: [...new Set([...semester.chars, ...semester.alumni])],
    profiles: semester.profiles,
  };
}

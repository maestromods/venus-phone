// The game's calendar: day 0 is the first day of the term, two slots a day (0 = day, 1 = night).
// Mirrors dateFromDay / formatChatDivider / formatDateBanner in the game's renderer.

export type Season = "spring" | "fall";

const ANCHOR_YEAR = 2015;
const ANCHORS: Record<Season, { month: number; day: number }> = {
  spring: { month: 0, day: 19 },
  fall: { month: 7, day: 17 },
};
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const YEAR_LABELS = ["freshman", "sophomore", "junior", "senior"];

export function seasonOfTerm(termIndex: number): Season {
  return termIndex % 2 === 0 ? "spring" : "fall";
}

/** The reader's year for a term index, as the game words it ("a freshman"). */
export function readerYearPhrase(termIndex: number): string {
  const year = Math.min(4, 1 + Math.ceil(termIndex / 2));
  return `a ${YEAR_LABELS[year - 1] ?? "student"}`;
}

function dateFromDay(date: number, season: Season): Date {
  const anchor = ANCHORS[season];
  return new Date(Date.UTC(ANCHOR_YEAR, anchor.month, anchor.day + date));
}

export function formatGameDate(date: number, season: Season): string {
  const at = dateFromDay(date, season);
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

export function formatShortGameDate(date: number, season: Season): string {
  const at = dateFromDay(date, season);
  return `${(MONTHS[at.getUTCMonth()] ?? "").slice(0, 3)} ${at.getUTCDate()}`;
}

export function formatWeekday(date: number, season: Season): string {
  return WEEKDAYS[dateFromDay(date, season).getUTCDay()] ?? "";
}

export function slotHalf(time: number): "day" | "night" {
  return time === 0 ? "day" : "night";
}

export function formatDateBanner(date: number, time: number, season: Season): string {
  return `${formatWeekday(date, season)}, ${formatGameDate(date, season)}. ${time === 0 ? "Day" : "Night"}.`;
}

export function formatChatDivider(date: number, time: number, season: Season): string {
  return `${formatShortGameDate(date, season)}, ${slotHalf(time)}`;
}

function ordinal(n: number): string {
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function formatSemesterProgress(date: number): string {
  const week = Math.floor(date / 7) + 1;
  return week === 1 ? `It's day ${date + 1} of the semester.` : `It's the ${ordinal(week)} week of the semester.`;
}

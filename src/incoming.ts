// Texts she starts on her own: a per-girl setting ("about every N minutes", or random), checked
// once a minute by the server. Intervals are jittered so it doesn't feel like a timer, and nobody
// texts during quiet hours on the PC's clock. Each girl also has a cap on how many texts she
// starts in a row before he answers.

import { promises as fs } from "node:fs";
import path from "node:path";
import { APP_DATA_DIR, writeJsonAtomic } from "./config.js";

const STORE_PATH = path.join(APP_DATA_DIR, "incoming.json");

/** Minutes between her texts; 0 is off, RANDOM picks a fresh gap each time. */
export const RANDOM = -1;
export const INCOMING_CHOICES = [0, 5, 15, 30, 60, 120, 240, 480, RANDOM] as const;
export const MAX_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const RANDOM_MIN = 5;
const RANDOM_MAX = 240;
const QUIET_FROM_HOUR = 23;
const QUIET_UNTIL_HOUR = 8;
const TICK_MS = 60_000;

interface Entry {
  everyMinutes: number;
  maxUnanswered: number;
  nextAt: number;
  /** Older versions stored hours. */
  everyHours?: number;
}

type Store = Record<string, Entry>;

let store: Store = {};

const keyOf = (playthroughId: string, charId: string) => `${playthroughId}:${charId}`;

export async function loadIncoming(): Promise<void> {
  try {
    store = JSON.parse(await fs.readFile(STORE_PATH, "utf8")) as Store;
  } catch {
    store = {};
  }
  for (const entry of Object.values(store)) {
    if (entry.everyMinutes === undefined && entry.everyHours) entry.everyMinutes = entry.everyHours * 60;
    delete entry.everyHours;
    entry.maxUnanswered ??= 1;
  }
}

function gapMinutes(everyMinutes: number): number {
  if (everyMinutes === RANDOM) {
    // Spread on a log scale, so short and long gaps are both common.
    const lo = Math.log(RANDOM_MIN);
    const hi = Math.log(RANDOM_MAX);
    return Math.exp(lo + Math.random() * (hi - lo));
  }
  return everyMinutes * (0.6 + Math.random() * 0.8);
}

function nextTime(everyMinutes: number, from = Date.now()): number {
  return from + gapMinutes(everyMinutes) * 60_000;
}

export function incomingSetting(playthroughId: string, charId: string): { everyMinutes: number; maxUnanswered: number } {
  const entry = store[keyOf(playthroughId, charId)];
  return { everyMinutes: entry?.everyMinutes ?? 0, maxUnanswered: entry?.maxUnanswered ?? 1 };
}

export async function setIncoming(playthroughId: string, charId: string, everyMinutes: number, maxUnanswered: number): Promise<void> {
  const key = keyOf(playthroughId, charId);
  const max = Math.min(10, Math.max(1, Math.round(maxUnanswered) || 1));
  if (!everyMinutes) {
    // Off: keep the cap so it's remembered if she's turned back on.
    store[key] = { everyMinutes: 0, maxUnanswered: max, nextAt: 0 };
  } else {
    const previous = store[key];
    const sameGap = previous?.everyMinutes === everyMinutes && previous.nextAt > Date.now();
    store[key] = { everyMinutes, maxUnanswered: max, nextAt: sameGap ? previous.nextAt : nextTime(everyMinutes) };
  }
  await writeJsonAtomic(STORE_PATH, store);
}

function quietNow(): boolean {
  const hour = new Date().getHours();
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

/** Runs `send` for each girl whose turn it is. `send` returns false when she couldn't text. */
export function startIncomingLoop(
  current: () => { playthroughId: string | null; contacts: string[] },
  send: (charId: string, maxUnanswered: number) => Promise<boolean>,
): void {
  let busy = false;
  setInterval(async () => {
    if (busy || quietNow()) return;
    const { playthroughId, contacts } = current();
    if (!playthroughId) return;
    busy = true;
    try {
      const now = Date.now();
      let changed = false;
      for (const charId of contacts) {
        const entry = store[keyOf(playthroughId, charId)];
        if (!entry?.everyMinutes || entry.nextAt > now) continue;
        try {
          await send(charId, entry.maxUnanswered);
        } catch (err) {
          console.warn(`[incoming] ${charId}: ${(err as Error).message}`);
        }
        // Whether or not she texted, her next chance comes around later.
        entry.nextAt = nextTime(entry.everyMinutes, now);
        changed = true;
        // One girl per minute at most, so several don't land at once.
        break;
      }
      if (changed) await writeJsonAtomic(STORE_PATH, store);
    } finally {
      busy = false;
    }
  }, TICK_MS);
}

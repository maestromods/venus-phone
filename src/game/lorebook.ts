import { promises as fs } from "node:fs";
import path from "node:path";
import type { GameFiles } from "./files.js";
import { SHIPPED_LORE } from "./lorebookData.js";

export interface LoreEntry { keys: string[]; text: string }
export interface LoreContext { setting?: string; entries: LoreEntry[] }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(key => typeof key === "string" && key.trim().length > 0);
}

/** The 0.6.0 sidecar belongs to a playthrough, not a save slot. Never write it during sync. */
export async function readLorebook(files: GameFiles, playthroughId: string, cityLife: boolean): Promise<LoreContext> {
  let raw: unknown;
  try { raw = JSON.parse(await fs.readFile(path.join(files.playthroughDir(playthroughId), "lorebook.json"), "utf8")); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    throw new Error("This playthrough's lorebook could not be read. Check it in the game before texting.");
  }
  const invalid = () => new Error("This playthrough's lorebook has an unsupported format. Check it in the game before texting.");
  if (!object(raw) || raw.schemaVersion !== 1 || !object(raw.edits) || !Array.isArray(raw.custom) ||
      (raw.setting !== undefined && typeof raw.setting !== "string")) throw invalid();
  const entries: LoreEntry[] = [];
  for (const [ref, edit] of Object.entries(raw.edits)) {
    if (!object(edit) || (edit.keys !== undefined && !keys(edit.keys)) || (edit.text !== undefined && typeof edit.text !== "string")) throw invalid();
    const shipped = SHIPPED_LORE.find(entry => entry.ref === ref);
    if (ref.startsWith("city_life_") && !cityLife) continue;
    // Unknown future entries work when the sidecar supplies both fields; never guess triggers.
    const entryKeys = edit.keys ?? shipped?.keys;
    const text = edit.text ?? shipped?.text;
    if (keys(entryKeys) && typeof text === "string" && text.trim()) entries.push({ keys: entryKeys, text });
  }
  for (const entry of raw.custom) {
    if (!object(entry) || !keys(entry.keys) || typeof entry.text !== "string") throw invalid();
    entries.push({ keys: entry.keys, text: entry.text });
  }
  return { ...(typeof raw.setting === "string" ? { setting: raw.setting } : {}), entries };
}

/** Same Unicode boundaries and optional plural as VU/VE; keys are literal text, never regex. */
export function lorebookLines(context: LoreContext | undefined, scan: string): string[] {
  if (!context) return [];
  const matched = context.entries.filter(entry => entry.keys.some(key => {
    const escaped = key.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    return escaped && new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?:e?s)?(?![\\p{L}\\p{N}_])`, "iu").test(scan);
  })).map(entry => entry.text.trim()).filter(Boolean);
  return [
    ...(context.setting?.trim() ? ["WORLD SETTING", context.setting.trim(), ""] : []),
    ...(matched.length ? ["LOREBOOK", ...new Set(matched), ""] : []),
  ];
}

/** Godlike Standards is an anytime mod, off by default; do not infer it from the trait alone. */
export async function godlikeStandardsOn(files: GameFiles): Promise<boolean> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(files.dataDir, "mods.json"), "utf8"));
    if (!object(raw) || !object(raw.on)) throw new Error("Invalid mod switches.");
    return raw.on["godlike-standards"] === true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("The game's mod settings could not be read. Check them in VE before texting.");
  }
}

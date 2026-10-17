// Reading and writing the game's data folder. Follows the game's own layout:
//   <game>/data/saves/<playthroughId>/{autosave,<numeric>,manualNN}.json, playthrough.json
//   <game>/data/saves/<playthroughId>/photos/<charId>/<slug>_chat_NNN.png
//   <game>/data/characters/<charId>/character.json  (or resources/assets/characters for shipped girls)

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { formatDateBanner, seasonOfTerm } from "./calendar.js";
import { semesterOf } from "./semesters.js";
import type { Character, PlaythroughRecord, SaveFile } from "./types.js";

export const SAFE_NUMERIC_ID = /^[0-9]{1,20}$/;
export const SAFE_CHAR_ID = /^[A-Za-z0-9-]{1,64}$/;
const SAVE_SCHEMA_VERSIONS = new Set([12, 13]);
const MANUAL_ID = /^manual(0[1-9]|[1-8][0-9]|90)$/;
const PHOTO_FILE = /^[a-z0-9]+_(?:bunnyboard|chat)_\d{3,6}\.(?:png|webp)$/;

export function isPhotoFile(file: string): boolean {
  return PHOTO_FILE.test(file);
}

export function isSaveId(saveId: string): boolean {
  return saveId === "autosave" || SAFE_NUMERIC_ID.test(saveId) || MANUAL_ID.test(saveId);
}

export class GameFiles {
  constructor(readonly gameDir: string) {}

  get dataDir(): string {
    return path.join(this.gameDir, "data");
  }
  get savesDir(): string {
    return path.join(this.dataDir, "saves");
  }
  get workflowsDir(): string {
    return path.join(this.gameDir, "resources", "assets", "workflows");
  }
  get comfyDir(): string {
    return path.join(this.dataDir, "services", "comfyui");
  }

  playthroughDir(playthroughId: string): string {
    if (!SAFE_NUMERIC_ID.test(playthroughId)) throw new Error("Invalid playthrough id.");
    return path.join(this.savesDir, playthroughId);
  }

  saveFilePath(playthroughId: string, saveId: string): string {
    if (!isSaveId(saveId)) throw new Error("Invalid save id.");
    return path.join(this.playthroughDir(playthroughId), `${saveId}.json`);
  }

  photosDir(playthroughId: string, charId: string): string {
    if (!SAFE_CHAR_ID.test(charId)) throw new Error("Invalid character id.");
    return path.join(this.playthroughDir(playthroughId), "photos", charId);
  }

  async exists(): Promise<boolean> {
    if (!this.gameDir) return false;
    try {
      return (await fs.stat(this.savesDir)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * The game folder for whatever the user picked: the game folder itself, its `data` folder,
   * the `saves` folder, or a playthrough folder inside it. Null if none of those fit.
   */
  static async resolveGameDir(picked: string): Promise<string | null> {
    if (!picked.trim()) return null;
    let dir = path.resolve(picked.trim());
    for (let i = 0; i < 4; i++) {
      if (await new GameFiles(dir).exists()) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  async readRecord(playthroughId: string): Promise<PlaythroughRecord> {
    const raw = await fs.readFile(path.join(this.playthroughDir(playthroughId), "playthrough.json"), "utf8");
    return JSON.parse(raw) as PlaythroughRecord;
  }

  async readSave(playthroughId: string, saveId: string): Promise<SaveFile> {
    const raw = await fs.readFile(this.saveFilePath(playthroughId, saveId), "utf8");
    const save = JSON.parse(raw) as SaveFile;
    if (!SAVE_SCHEMA_VERSIONS.has(save.schemaVersion)) {
      throw new Error(
        `This save is schema version ${save.schemaVersion}; this app understands versions 12 and 13 (game 0.4.0 and 0.5.0).`,
      );
    }
    if (!save.bunnyboard || typeof save.bunnyboard !== "object") throw new Error("This save has no phone data.");
    save.bunnyboard.conversations ??= {};
    return save;
  }

  /** Every playthrough with a record, newest first, with its saves. */
  async listPlaythroughs(): Promise<PlaythroughSummary[]> {
    let ids: string[];
    try {
      ids = (await fs.readdir(this.savesDir)).filter((id) => SAFE_NUMERIC_ID.test(id));
    } catch {
      return [];
    }
    const out: PlaythroughSummary[] = [];
    for (const id of ids) {
      try {
        const record = await this.readRecord(id);
        const saves = (await this.listSaves(id)).flatMap((s) => {
          try {
            const season = seasonOfTerm(semesterOf(record, s.semester).index);
            return [{ ...s, when: formatDateBanner(s.date, s.time, season) }];
          } catch { return []; } // A missing semester must not hide the other valid saves.
        });
        if (saves.length === 0) continue;
        out.push({
          playthroughId: id,
          name: record.name ?? null,
          player: `${record.playerFirstName} ${record.playerLastName}`.trim(),
          saves,
        });
      } catch {
        // Not a playthrough this build can read; skip it.
      }
    }
    return out.sort((a, b) => (b.saves[0]?.saveDate ?? 0) - (a.saves[0]?.saveDate ?? 0));
  }

  /** The saves in one playthrough, newest first. */
  async listSaves(playthroughId: string): Promise<SaveSummary[]> {
    const dir = this.playthroughDir(playthroughId);
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
    const out: SaveSummary[] = [];
    for (const file of files) {
      const saveId = file.slice(0, -5);
      if (!isSaveId(saveId)) continue;
      try {
        const save = await this.readSave(playthroughId, saveId);
        out.push({
          saveId,
          kind: saveId === "autosave" ? "autosave" : saveId.startsWith("manual") ? "manual" : "slot",
          date: save.date,
          time: save.time,
          saveDate: save.saveDate,
          semester: save.semester,
        });
      } catch {
        // Unreadable or a different schema: not offered.
      }
    }
    return out.sort((a, b) => b.saveDate - a.saveDate);
  }

  /**
   * Writes a new numbered slot save, the kind the game writes at each time-slot boundary, so it
   * shows in the game's load menu. Never overwrites an existing file.
   */
  async writeNewSlotSave(playthroughId: string, save: SaveFile): Promise<string> {
    if (!SAVE_SCHEMA_VERSIONS.has(save.schemaVersion)) throw new Error("Cannot write an unsupported save schema.");
    const dir = this.playthroughDir(playthroughId);
    const taken = new Set((await fs.readdir(dir)).map((name) => name.replace(/\.json$/, "")));
    let candidate = Date.now();
    while (taken.has(String(candidate))) candidate += 1;
    const saveId = String(candidate);
    const stamped: SaveFile = { ...save, playthroughId, saveId, saveDate: Date.now() };
    const target = this.saveFilePath(playthroughId, saveId);
    const partial = `${target}.partial`;
    await fs.writeFile(partial, JSON.stringify(stamped), { encoding: "utf8", flag: "wx" });
    await fs.rename(partial, target);
    return saveId;
  }

  async readCharacter(charId: string): Promise<Character | null> {
    for (const dir of this.characterDirs(charId)) {
      try {
        const raw = await fs.readFile(path.join(dir, "character.json"), "utf8");
        const parsed = JSON.parse(raw) as Character;
        return { ...parsed, charId };
      } catch {
        continue;
      }
    }
    return null;
  }

  characterDirs(charId: string): string[] {
    if (!SAFE_CHAR_ID.test(charId)) throw new Error("Invalid character id.");
    return [
      path.join(this.dataDir, "characters", charId),
      path.join(this.gameDir, "resources", "assets", "characters", charId),
    ];
  }

  /** Her profile picture, falling back to her neutral sprite. */
  async avatarPath(charId: string): Promise<string | null> {
    const names = ["profile.png", "profile.webp", "neutral.png", "neutral.webp"];
    for (const dir of this.characterDirs(charId)) {
      for (const name of names) {
        const candidate = path.join(dir, "expressions", name);
        try {
          await fs.access(candidate);
          return candidate;
        } catch {
          continue;
        }
      }
    }
    return null;
  }
}

export interface SaveSummary {
  semester?: string;
  saveId: string;
  kind: "autosave" | "slot" | "manual";
  date: number;
  time: number;
  saveDate: number;
}

export interface PlaythroughSummary {
  playthroughId: string;
  name: string | null;
  player: string;
  saves: Array<SaveSummary & { when: string }>;
}

/** True while the game itself is open; syncing then would be overwritten by its next autosave. */
export function isGameRunning(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/FI", "IMAGENAME eq Venus University.exe", "/NH", "/FO", "CSV"],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(stdout.toLowerCase().includes("venus university.exe"));
      },
    );
  });
}

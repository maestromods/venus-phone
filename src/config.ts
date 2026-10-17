// App settings and the encrypted API keys, kept in ./app-data next to the app.
// Keys are encrypted with Windows DPAPI (current user), the same protection idea as the game's
// apiKeyEnc, so the file is useless if copied to another account or machine.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Provider, ThinkingLevel } from "./llm.js";

export const APP_DATA_DIR = path.resolve(process.env.VENUS_PHONE_DATA ?? "app-data");
const CONFIG_PATH = path.join(APP_DATA_DIR, "config.json");

export interface AppConfig {
  gameDir: string;
  port: number;
  pin: { salt: string; hash: string } | null;
  provider: Provider;
  geminiModel: string;
  openrouterModel: string;
  /** Used instead of openrouterModel when a message carries a photo. */
  openrouterVisionModel: string;
  endpointUrl: string;
  thinking: ThinkingLevel;
  geminiKeyEnc: string | null;
  openrouterKeyEnc: string | null;
  photos: boolean;
  explicitPhotos: boolean;
  /** Serve the phone over HTTPS with a certificate you install once per phone. Off by default. */
  https: boolean;
}

const DEFAULTS: AppConfig = {
  // Empty until the user picks their game folder in the app (or sets VENUS_GAME_DIR).
  gameDir: process.env.VENUS_GAME_DIR ?? "",
  port: Number(process.env.VENUS_PHONE_PORT ?? 8790),
  pin: null,
  provider: "gemini",
  geminiModel: "gemini-3.6-flash",
  openrouterModel: "deepseek/deepseek-v4.1-flash",
  openrouterVisionModel: "deepseek/deepseek-v4.1-flash",
  endpointUrl: "https://openrouter.ai/api/v1",
  thinking: "low",
  geminiKeyEnc: null,
  openrouterKeyEnc: null,
  photos: true,
  explicitPhotos: true,
  https: process.env.VENUS_PHONE_HTTPS === "1",
};

export async function loadConfig(): Promise<AppConfig> {
  await fs.mkdir(APP_DATA_DIR, { recursive: true });
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")) as Partial<AppConfig>;
    return { ...DEFAULTS, ...raw, ...(process.env.VENUS_PHONE_PORT ? { port: Number(process.env.VENUS_PHONE_PORT) } : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await writeJsonAtomic(CONFIG_PATH, config);
}

const writeQueues = new Map<string, Promise<void>>();

/**
 * Writes JSON via a temporary file and a rename, so a crash never leaves half a file. Writes to
 * the same file run one after another (a photo finishing mid-reply used to race the reply).
 */
export function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value, null, 2);
  const run = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const partial = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.partial`;
    await fs.writeFile(partial, data, "utf8");
    try {
      await fs.rename(partial, file);
    } catch (err) {
      await fs.rm(partial, { force: true });
      throw err;
    }
  };
  const next = (writeQueues.get(file) ?? Promise.resolve()).then(run, run);
  const settled = next.catch(() => undefined);
  writeQueues.set(file, settled);
  void settled.then(() => {
    if (writeQueues.get(file) === settled) writeQueues.delete(file);
  });
  return next;
}

// ---- DPAPI ----------------------------------------------------------------------------------

function powershell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(new Error("Windows could not encrypt or decrypt the API key.")) : resolve(stdout.trim())),
    );
    child.stdin?.end(input);
  });
}

const PROTECT =
  "Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); " +
  "$b=[Text.Encoding]::UTF8.GetBytes($s); " +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const UNPROTECT =
  "Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); " +
  "$b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,'CurrentUser'); " +
  "[Text.Encoding]::UTF8.GetString($b)";

export async function encryptSecret(plain: string): Promise<string> {
  if (process.platform !== "win32") throw new Error("Key encryption needs Windows.");
  return powershell(PROTECT, plain);
}

const decrypted = new Map<string, string>();

export async function decryptSecret(enc: string | null): Promise<string> {
  if (!enc) return "";
  const cached = decrypted.get(enc);
  if (cached !== undefined) return cached;
  const plain = await powershell(UNPROTECT, enc);
  decrypted.set(enc, plain);
  return plain;
}

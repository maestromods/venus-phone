// DM photos through the game's own local ComfyUI and its characterPhoto.json workflow, the same
// pipeline the in-game Photo Feature uses. ComfyUI only listens on 127.0.0.1.

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, openSync } from "node:fs";
import path from "node:path";
import type { GameFiles } from "./game/files.js";

const BASE_URL = "http://127.0.0.1:8188";
const PORT = "8188";
// Node ids in characterPhoto.json, as the game's PHOTO_NODE map names them.
const PHOTO_NODE = { seed: "14", positivePrompt: "4", negativePrompt: "5", saveImage: "41" };
const START_WAIT_MS = 4 * 60_000;
const RENDER_WAIT_MS = 10 * 60_000;

let started: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function isRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/system_stats`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureRunning(files: GameFiles): Promise<void> {
  if (await isRunning()) return;
  if (starting) return starting;
  starting = (async () => {
    const python = path.join(files.comfyDir, "python_embeded", "python.exe");
    const main = path.join(files.comfyDir, "ComfyUI", "main.py");
    try {
      await fs.access(python);
      await fs.access(main);
    } catch {
      throw new Error("The game's ComfyUI is not installed. Set it up from the game first.");
    }
    let log: number | "ignore" = "ignore";
    try {
      log = openSync(path.join(files.comfyDir, "comfyui.log"), "w");
    } catch {
      // Logging is optional.
    }
    started = spawn(python, ["-s", main, "--windows-standalone-build", "--port", PORT, "--disable-auto-launch"], {
      cwd: files.comfyDir,
      env: { ...process.env, TRANSPARENT_BACKGROUND_FILE_PATH: files.comfyDir },
      windowsHide: true,
      stdio: ["ignore", log, log],
    });
    started.on("exit", () => {
      started = null;
    });
    const deadline = Date.now() + START_WAIT_MS;
    while (Date.now() < deadline) {
      if (await isRunning()) return;
      await sleep(1500);
    }
    throw new Error("ComfyUI did not start in time.");
  })().finally(() => {
    starting = null;
  });
  return starting;
}

/** Stops the ComfyUI this app started, if any; one the game started is left alone. */
export function stopComfy(): void {
  started?.kill();
  started = null;
}

/** Renders one picture and writes it as a PNG to `destPath`. Jobs run one at a time. */
export function renderPhoto(files: GameFiles, prompts: { positive: string; negative: string }, destPath: string): Promise<void> {
  const job = queue.then(() => runPhoto(files, prompts, destPath));
  queue = job.catch(() => undefined);
  return job;
}

async function runPhoto(files: GameFiles, prompts: { positive: string; negative: string }, destPath: string): Promise<void> {
  await ensureRunning(files);
  const workflow = JSON.parse(await fs.readFile(path.join(files.workflowsDir, "characterPhoto.json"), "utf8")) as Record<
    string,
    { inputs: Record<string, unknown> } | undefined
  >;
  const node = (id: string) => {
    const found = workflow[id];
    if (!found) throw new Error(`characterPhoto.json has no node ${id}; this game build is not the one this app was made for.`);
    return found;
  };
  node(PHOTO_NODE.positivePrompt).inputs.text = prompts.positive;
  node(PHOTO_NODE.negativePrompt).inputs.text = prompts.negative;
  node(PHOTO_NODE.seed).inputs.seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

  const submit = await fetch(`${BASE_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: "venus-phone" }),
  });
  const submitted = (await submit.json()) as { prompt_id?: string; error?: unknown };
  if (!submit.ok || !submitted.prompt_id) throw new Error(`ComfyUI rejected the photo: ${JSON.stringify(submitted.error ?? submitted)}`);
  const promptId = submitted.prompt_id;

  const deadline = Date.now() + RENDER_WAIT_MS;
  let entry: HistoryEntry | undefined;
  while (Date.now() < deadline) {
    await sleep(1500);
    const response = await fetch(`${BASE_URL}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) continue;
    const history = (await response.json()) as Record<string, HistoryEntry>;
    entry = history[promptId];
    if (entry?.status?.completed !== undefined) break;
  }
  if (!entry?.status?.completed && entry?.status?.status_str !== "error") throw new Error("ComfyUI never finished the photo.");
  const image = entry.outputs?.[PHOTO_NODE.saveImage]?.images?.[0];
  if (!image) throw new Error(`ComfyUI produced no photo${entry.status?.status_str === "error" ? " (it reported an error)" : ""}.`);

  const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
  const view = await fetch(`${BASE_URL}/view?${params.toString()}`);
  if (!view.ok) throw new Error(`ComfyUI would not hand back the photo (HTTP ${view.status}).`);
  const bytes = Buffer.from(await view.arrayBuffer());
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("ComfyUI's photo is not a PNG.");

  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const partial = `${destPath}.partial`;
  await fs.writeFile(partial, bytes);
  await fs.rename(partial, destPath);

  // The game clears its copy out of ComfyUI's output folder; so does this.
  const outputRoot = path.resolve(files.comfyDir, "ComfyUI", "output");
  const leftover = path.resolve(outputRoot, image.subfolder ?? "", image.filename);
  if (leftover.toLowerCase().startsWith(outputRoot.toLowerCase() + path.sep)) await fs.rm(leftover, { force: true });
}

interface HistoryEntry {
  status?: { completed?: boolean; status_str?: string };
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

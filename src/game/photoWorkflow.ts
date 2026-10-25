import { promises as fs } from "node:fs";
import path from "node:path";
import type { GameFiles } from "./files.js";

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
interface ModelSettings { comfySource?: unknown; comfyModels?: Record<string, unknown>; comfyLoraWeight?: unknown }
const weightOf = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100 ? value : 1;

/** Bypass a LoRA using its own upstream model/clip links. */
function bypassLora(graph: Workflow, id: string): void {
  const loader = graph[id];
  if (!loader) return;
  for (const node of Object.values(graph)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value[0] === id) node.inputs[key] = loader.inputs[value[1] === 0 ? "model" : "clip"];
    }
  }
  delete graph[id];
}

/** Adapt the installed graph in memory; never change the game's workflow or settings. */
export function preparePhotoWorkflow(original: Workflow, kind: "photo" | "cg", prompts: { positive: string; negative: string }, seed: number, settings: ModelSettings = {}, characterLora?: unknown) {
  const workflow = structuredClone(original);
  const node = (id: string) => {
    if (!workflow[id]) throw new Error(`The installed ${kind === "photo" ? "characterPhoto" : "characterCg"}.json workflow is missing node ${id}.`);
    return workflow[id];
  };
  node("4").inputs.text = prompts.positive;
  node("5").inputs.text = prompts.negative;
  node("14").inputs.seed = seed;
  if (kind === "cg") {
    // 0.5.0 ships CGs, not the Photo Feature mod's DM graph. Free-form photos need
    // no staged pose image; keep the CG sampler/detailer and feed it the same prompts.
    node("50").inputs.text = prompts.positive;
    node("31").inputs.positive = ["50", 0];
    node("31").inputs.negative = ["5", 0];
    for (const id of ["12", "39", "51"]) delete workflow[id];
    const lora = characterLora as { name?: unknown; weight?: unknown } | undefined;
    if (lora && typeof lora.name === "string" && lora.name.trim()) {
      node("100").inputs.lora_name = lora.name;
      node("100").inputs.strength_model = node("100").inputs.strength_clip = weightOf(lora.weight);
    } else bypassLora(workflow, "100");
  }
  const picks = settings.comfyModels ?? {};
  for (const [id, entry] of Object.entries(workflow)) {
    const role = entry.class_type === "CheckpointLoaderSimple" ? "checkpoint"
      : entry.class_type === "LoraLoader" && id !== "100" ? "lora"
      : entry.class_type === "ControlNetLoader" ? "controlnet"
      : entry.class_type === "UpscaleModelLoader" ? "upscaler"
      : entry.class_type === "UltralyticsDetectorProvider" && String(entry.inputs.model_name).startsWith("segm/") ? "faceSegDetector"
      : entry.class_type === "UltralyticsDetectorProvider" && String(entry.inputs.model_name).startsWith("bbox/") ? "handDetector" : null;
    if (!role) continue;
    const pick = picks[role];
    if (role === "lora" && pick === "") { bypassLora(workflow, id); continue; }
    if (typeof pick === "string" && pick.trim()) entry.inputs[role === "checkpoint" ? "ckpt_name" : role === "lora" ? "lora_name" : role === "controlnet" ? "control_net_name" : "model_name"] = pick;
    if (role === "lora") entry.inputs.strength_model = entry.inputs.strength_clip = weightOf(settings.comfyLoraWeight);
  }
  const outputNode = kind === "photo" ? "41" : "9";
  node(outputNode);
  return { workflow, outputNode };
}

export async function loadPhotoWorkflow(files: GameFiles, prompts: { positive: string; negative: string }, seed: number, characterLora?: unknown) {
  let settings: ModelSettings = {};
  try { settings = JSON.parse(await fs.readFile(path.join(files.dataDir, "settings.json"), "utf8")); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The game's image settings could not be read."); }
  if (settings.comfySource === "external") throw new Error("Venus Phone currently uses the game's managed local ComfyUI. Select the managed server in the game's image settings to generate phone photos.");
  let kind: "photo" | "cg" = "photo", raw: string;
  try { raw = await fs.readFile(path.join(files.workflowsDir, "characterPhoto.json"), "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    kind = "cg";
    raw = await fs.readFile(path.join(files.workflowsDir, "characterCg.json"), "utf8");
  }
  return preparePhotoWorkflow(JSON.parse(raw) as Workflow, kind, prompts, seed, settings, characterLora);
}

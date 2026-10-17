import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preparePhotoWorkflow, loadPhotoWorkflow } from '../dist/game/photoWorkflow.js';
import { GameFiles } from '../dist/game/files.js';

const node = (class_type, inputs = {}) => ({ class_type, inputs });
// Synthetic graph with the same links/slots the shipped 0.5.0 CG graph uses.
const cg = {
  '1': node('CheckpointLoaderSimple', { ckpt_name: 'default.safetensors' }),
  '3': node('LoraLoader', { model: ['1', 0], clip: ['1', 1], lora_name: 'style.safetensors' }),
  '100': node('LoraLoader', { model: ['3', 0], clip: ['3', 1], lora_name: 'characterLora.safetensors' }),
  '4': node('CLIPTextEncode', { clip: ['100', 1], text: 'old' }),
  '5': node('CLIPTextEncode', { clip: ['100', 1], text: 'old' }),
  '50': node('CLIPTextEncode', { clip: ['100', 1], text: 'old' }),
  '14': node('SeedNode', { seed: 1 }),
  '7': node('KSampler', { model: ['100', 0], positive: ['4', 0], negative: ['5', 0], seed: ['14', 0] }),
  '12': node('ControlNetLoader'), '39': node('LoadImage'),
  '51': node('ControlNetApplyAdvanced', { positive: ['50', 0], negative: ['5', 0], control_net: ['12', 0], image: ['39', 0] }),
  '31': node('FaceDetailer', { model: ['100', 0], clip: ['100', 1], positive: ['51', 0], negative: ['51', 1], image: ['7', 0] }),
  '33': node('UltralyticsDetectorProvider', { model_name: 'segm/default.pt' }),
  '9': node('PreviewImage', { images: ['31', 0] }),
};
const prompts = { positive: 'portrait at a cafe', negative: 'blurry' };
test('vanilla CG fallback has no pose/placeholder dependencies and leaves the source graph unchanged', () => {
  const before = structuredClone(cg);
  const { workflow, outputNode } = preparePhotoWorkflow(cg, 'cg', prompts, 123);
  assert.equal(outputNode, '9');
  for (const id of ['100', '12', '39', '51']) assert.equal(workflow[id], undefined);
  assert.equal(workflow['50'].inputs.text, prompts.positive);
  assert.deepEqual(workflow['31'].inputs.positive, ['50', 0]);
  assert.deepEqual(workflow['31'].inputs.negative, ['5', 0]);
  assert.deepEqual(workflow['7'].inputs.model, ['3', 0]);
  for (const entry of Object.values(workflow)) {
    for (const value of Object.values(entry.inputs)) if (Array.isArray(value)) assert.ok(workflow[value[0]], `Dangling link ${value[0]}`);
  }
  assert.deepEqual(cg, before);
});
test('model selections, disabled style LoRA and real character LoRA are applied without losing links', () => {
  const { workflow } = preparePhotoWorkflow(cg, 'cg', prompts, 456, {
    comfyModels: { checkpoint: 'chosen.safetensors', lora: '', faceSegDetector: 'segm/chosen.pt' },
  }, { name: 'real-character.safetensors', weight: 0.7 });
  assert.equal(workflow['3'], undefined);
  assert.equal(workflow['1'].inputs.ckpt_name, 'chosen.safetensors');
  assert.equal(workflow['33'].inputs.model_name, 'segm/chosen.pt');
  assert.equal(workflow['100'].inputs.lora_name, 'real-character.safetensors');
  assert.equal(workflow['100'].inputs.strength_model, 0.7);
  assert.deepEqual(workflow['100'].inputs.model, ['1', 0]);
  assert.deepEqual(workflow['4'].inputs.clip, ['100', 1]);
  assert.equal(workflow['14'].inputs.seed, 456);
});
test('loader prefers the mod graph, falls back only when missing, and never writes game files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'venus-workflow-'));
  try {
    const files = new GameFiles(dir);
    await mkdir(files.workflowsDir, { recursive: true });
    await mkdir(files.dataDir, { recursive: true });
    const cgPath = path.join(files.workflowsDir, 'characterCg.json');
    const photoPath = path.join(files.workflowsDir, 'characterPhoto.json');
    await writeFile(cgPath, JSON.stringify(cg));
    const settingsPath = path.join(files.dataDir, 'settings.json');
    const settingsText = JSON.stringify({ comfyModels: { lora: 'custom.safetensors' }, comfyLoraWeight: 0.8 });
    await writeFile(settingsPath, settingsText);
    const fallback = await loadPhotoWorkflow(files, prompts, 100);
    assert.equal(fallback.outputNode, '9');
    assert.equal(fallback.workflow['3'].inputs.lora_name, 'custom.safetensors');
    assert.equal(fallback.workflow['3'].inputs.strength_clip, 0.8);
    assert.equal(await readFile(cgPath, 'utf8'), JSON.stringify(cg));
    assert.equal(await readFile(settingsPath, 'utf8'), settingsText);
    const mod = { '4': node('CLIPTextEncode'), '5': node('CLIPTextEncode'), '14': node('SeedNode'), '41': node('SaveImage') };
    await writeFile(photoPath, JSON.stringify(mod));
    assert.equal((await loadPhotoWorkflow(files, prompts, 101)).outputNode, '41');
    await writeFile(photoPath, '{malformed');
    await assert.rejects(loadPhotoWorkflow(files, prompts, 102));
    await writeFile(settingsPath, JSON.stringify({ comfySource: 'external' }));
    await assert.rejects(loadPhotoWorkflow(files, prompts, 103), /managed local ComfyUI/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

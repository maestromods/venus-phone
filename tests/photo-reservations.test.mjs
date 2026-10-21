import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { root, fixture, respond, settings, gate } from './helpers/session-fixture.mjs';

// Retain Phone's real render lifecycle, replacing only the external ComfyUI renderer.
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
let source = await readFile(path.join(dist, 'phone.js'), 'utf8');
assert.ok(source.includes('import { renderPhoto } from "./comfy.js";'));
source = source.replace('import { renderPhoto } from "./comfy.js";', 'const renderPhoto = (...args) => globalThis.qaRenderPhoto(...args);');
source = source.replace(/from "(\.\/[^\"]+)"/g, (_, relative) => `from "${pathToFileURL(path.join(dist, relative)).href}"`);
const modulePath = path.join(root, 'phone-renderer.mjs');
await writeFile(modulePath, source);
const { Phone } = await import(pathToFileURL(modulePath));
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < end, 'Background render settled'); await new Promise(resolve => setTimeout(resolve, 2)); }
}

test('deleted pending photos keep durable filenames; restart recovers only the owning job', async () => {
  const jobs = [];
  let tail = Promise.resolve();
  globalThis.qaRenderPhoto = (_files, _prompts, dest) => {
    const ready = gate();
    const job = { dest, ready, started: false };
    jobs.push(job);
    const running = tail.then(async () => {
      job.started = true;
      const content = await ready.promise;
      if (content === null) throw new Error('Synthetic interrupted render');
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content);
    });
    tail = running.catch(() => {});
    return running;
  };
  try {
    const { phone, files } = await fixture('alumni', Phone);
    respond('Synthetic picture', { sendPhoto: true, photoTier: 'everyday', photoPrompt: 'Standing outdoors in everyday clothes, waving.' });
    const first = await phone.send('girl', 'Send a photo', settings, { enabled: true, explicit: false });
    const original = first.messages.at(-1);
    await until(() => jobs.length === 1);
    assert.equal(phone.thread('girl').busy, false);
    await phone.deleteMessage('girl', original.id);
    const second = await phone.send('girl', 'Send another photo', settings, { enabled: true, explicit: false });
    const replacement = second.messages.at(-1);
    await until(() => jobs.length === 2);
    assert.notEqual(jobs[0].dest, jobs[1].dest);
    assert.equal(jobs[1].started, false);
    jobs[0].ready.release('SYNTHETIC DELETED IMAGE');
    await until(() => !phone.rendering.has(original.id));
    assert.equal(jobs[1].started, true);
    const restored = new Phone(files);
    await restored.restore();
    await until(() => jobs.length === 3);
    const recovering = restored.thread('girl').messages.at(-1);
    assert.equal(recovering.photo.pending, true);
    assert.equal(recovering.photo.file, replacement.photo.file);
    assert.equal(jobs[2].dest, jobs[1].dest);
    const reservation = JSON.parse(await readFile(jobs[2].dest + '.phone.json', 'utf8'));
    assert.equal(reservation.messageId, replacement.id);
    assert.equal(reservation.completed, false);
    jobs[1].ready.release(null); // The old process/job did not complete.
    jobs[2].ready.release('SYNTHETIC REPLACEMENT IMAGE');
    await tail;
    await until(() => restored.rendering.size === 0 && phone.rendering.size === 0);
    assert.equal(restored.thread('girl').messages.at(-1).photo.pending, false);
    assert.equal(await readFile(jobs[2].dest, 'utf8'), 'SYNTHETIC REPLACEMENT IMAGE');
    const again = new Phone(files); await again.restore();
    assert.equal(jobs.length, 3);
    assert.equal(again.thread('girl').messages.at(-1).photo.pending, false);
  } finally { for (const job of jobs) job.ready.release(null); await tail; delete globalThis.qaRenderPhoto; }
});

test('restoring an older pending photo reserves its name before deletion is possible', async () => {
  const { phone, files } = await fixture();
  const legacy = { id: 'legacy-photo', sender: 'contact', text: 'Synthetic', date: 1, time: 0, photo: { file: 'girl_chat_001.png', tier: 'everyday', scene: 'Standing outdoors.', pending: true } };
  phone.state.delta.added.girl = [legacy]; await phone.persist();
  const restored = new Phone(files);
  restored.drawPhoto = async () => {}; // Retain the incomplete legacy job without starting a renderer.
  await restored.restore();
  await restored.deleteMessage('girl', legacy.id);
  const name = await restored.reservePhotoName('1', restored.characters.get('girl'), restored.view(), 'replacement');
  assert.notEqual(name, legacy.photo.file);
});

test('exclusive photo claims survive failed renders and cannot be reused after deletion', async () => {
  globalThis.qaRenderPhoto = async () => { throw new Error('Synthetic renderer failure'); };
  try {
    const { phone, files } = await fixture('first', Phone);
    respond('Synthetic picture', { sendPhoto: true, photoTier: 'everyday', photoPrompt: 'Standing outdoors in everyday clothes, waving.' });
    await phone.send('girl', 'Send a photo', settings, { enabled: true, explicit: false });
    await until(() => phone.rendering.size === 0);
    const failed = phone.thread('girl').messages.at(-1);
    assert.equal(failed.photo.failed, true);
    await phone.deleteMessage('girl', failed.id);
    const restarted = new Phone(files); await restarted.restore();
    await restarted.send('girl', 'Send another photo', settings, { enabled: true, explicit: false });
    await until(() => restarted.rendering.size === 0);
    assert.notEqual(restarted.thread('girl').messages.at(-1).photo.file, failed.photo.file);
    const character = restarted.characters.get('girl'), save = restarted.view();
    const names = await Promise.all(['one', 'two'].map(id => restarted.reservePhotoName('1', character, save, id)));
    assert.notEqual(names[0], names[1]);
  } finally { delete globalThis.qaRenderPhoto; }
});

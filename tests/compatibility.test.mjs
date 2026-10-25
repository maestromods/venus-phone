import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// These saves are isolated fixtures. A real game running on the test PC is irrelevant.
const realExecFile = childProcess.execFile;
childProcess.execFile = (file, ...args) => {
  if (file === 'tasklist') { args.at(-1)(null, ''); return; }
  return realExecFile(file, ...args);
};
syncBuiltinESMExports();
after(() => { childProcess.execFile = realExecFile; syncBuiltinESMExports(); });

const root = await mkdtemp(path.join(os.tmpdir(), 'venus-compatibility-'));
process.env.VENUS_PHONE_DATA = path.join(root, 'phone');
const { GameFiles } = await import('../dist/game/files.js');
const { Phone } = await import('../dist/phone.js');
const { emptyFlags } = await import('../dist/game/types.js');
after(() => rm(root, { recursive: true, force: true }));

// Synthetic fixtures follow 0.5.0 shared/types.ts, saveRules.ts and semesters.ts.
const record = {
  schemaVersion: 3, playerFirstName: 'Test', playerLastName: 'Reader', chars: ['old'],
  profiles: { old: { year: 4, major: 'History' } },
  semesters: {
    '20': { index: 1, chars: ['new'], alumni: ['old'], profiles: {
      new: { year: 2, major: 'Physics' }, old: { year: 4, major: 'History', pursuing: 'teaching abroad' },
    } },
    '21': { index: 1, chars: ['other'], alumni: [], profiles: {} },
  },
};
function save(schemaVersion = 13, semester) {
  return {
    schemaVersion, ...(semester === undefined ? {} : { semester }), playthroughId: '1', saveId: '1', saveDate: 100,
    date: 0, time: 0, stats: { brain: 1, body: 1, heart: 1 },
    transcript: [{ subject: 'History', grade: 'A' }], unknownFutureField: { keep: true },
    charInfo: Object.fromEntries(['old', 'new', 'other'].map(id => [id, {
      flags: { ...emptyFlags(), gaveContactInfo: true }, memories: [], nameKnown: true,
    }])),
    bunnyboard: { posts: ['preserved'], conversations: { old: { charId: 'old', messages: [
      { id: 'original', text: 'Hello', sender: 'contact', date: 0, time: 0 },
    ], summary: null, unread: 0 } } },
  };
}
let sequence = 0;
async function fixture(base = save()) {
  const dir = path.join(root, String(++sequence));
  const files = new GameFiles(dir);
  await mkdir(files.playthroughDir('1'), { recursive: true });
  await writeFile(path.join(files.playthroughDir('1'), 'playthrough.json'), JSON.stringify(record));
  await writeFile(files.saveFilePath('1', '1'), JSON.stringify(base));
  for (const charId of ['old', 'new', 'other']) {
    const folder = path.join(dir, 'data', 'characters', charId);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'character.json'), JSON.stringify({ firstName: charId, lastName: '' }));
  }
  return files;
}

test('0.4 and 0.5 saves keep their schema and all unrelated data when written to a new slot', async () => {
  for (const version of [12, 13]) {
    const files = await fixture(save(version));
    const original = await files.readSave('1', '1');
    const before = await readFile(files.saveFilePath('1', '1'), 'utf8');
    const id = await files.writeNewSlotSave('1', original);
    const written = await files.readSave('1', id);
    assert.deepEqual({ ...written, saveId: original.saveId, saveDate: original.saveDate }, original);
    assert.equal(await readFile(files.saveFilePath('1', '1'), 'utf8'), before);
  }
});
test('unsupported schemas are rejected on both read and write', async () => {
  const files = await fixture(save(14));
  await assert.rejects(files.readSave('1', '1'), /versions 12 and 13/);
  await assert.rejects(files.writeNewSlotSave('1', save(14)), /unsupported/);
});
test('save picker uses each save\'s calendar and skips only missing semesters', async () => {
  const files = await fixture();
  await writeFile(files.saveFilePath('1', '2'), JSON.stringify({ ...save(13, '20'), saveDate: 200 }));
  await writeFile(files.saveFilePath('1', '3'), JSON.stringify({ ...save(13, 'missing'), saveDate: 300 }));
  const [playthrough] = await files.listPlaythroughs();
  assert.deepEqual(playthrough.saves.map(s => s.saveId), ['2', '1']);
  assert.match(playthrough.saves[0].when, /August 17/);
  assert.match(playthrough.saves[1].when, /January 19/);
});
test('later semesters load their roster, graduates, profiles and reader year without polluting saves', async () => {
  const files = await fixture(save(13, '20'));
  const phone = new Phone(files);
  await phone.choose('1', '1', false);
  assert.deepEqual(phone.contactIds(), ['new', 'old']);
  assert.deepEqual(phone.contacts().map(c => c.charId).sort(), ['new', 'old']);
  assert.match(phone.info().now, /August 17/);
  const view = phone.view();
  assert.equal(view.charInfo.new.major, 'Physics');
  assert.equal(view.charInfo.old.pursuing, 'teaching abroad');
  assert.equal((await phone.promptContext(view, phone.characters.get('new'), 'none', false)).player.termIndex, 1);
  assert.equal(phone.base.charInfo.new.major, undefined);
  const restored = new Phone(files);
  await restored.restore();
  assert.deepEqual(restored.contactIds(), ['new', 'old']);
});
test('a missing semester refuses selection and keeps the previous session', async () => {
  const files = await fixture();
  const phone = new Phone(files);
  await phone.choose('1', '1', false);
  await writeFile(files.saveFilePath('1', '2'), JSON.stringify(save(13, 'missing')));
  await assert.rejects(phone.choose('1', '2', false), /semester is missing/);
  assert.equal(phone.info().saveId, '1');
});
test('sync rebases in the same semester, preserving schema, profiles separation and game progress', async () => {
  const files = await fixture(save(13, '20'));
  const phone = new Phone(files);
  await phone.choose('1', '1', false);
  await phone.deleteMessage('old', 'original');
  await writeFile(files.saveFilePath('1', '2'), JSON.stringify({ ...save(13, '20'), saveDate: 200, money: 777 }));
  const preview = await phone.sync();
  assert.equal(preview.requiresConfirmation, true);
  assert.equal(phone.pendingCount(), 1);
  const result = await phone.sync(preview.token);
  assert.equal(result.rebased, true);
  const written = await files.readSave('1', result.saveId);
  assert.equal(written.schemaVersion, 13);
  assert.equal(written.semester, '20');
  assert.equal(written.money, 777);
  assert.deepEqual(written.bunnyboard.conversations.old.messages, []);
  assert.equal(written.charInfo.old.pursuing, undefined);
  assert.deepEqual(written.unknownFutureField, { keep: true });
  assert.equal(written.bunnyboard.conversations.old.summary, '');
  const savedFiles = await readdir(files.playthroughDir('1'));
  await assert.rejects(phone.sync(), /Nothing new to sync/);
  assert.deepEqual(await readdir(files.playthroughDir('1')), savedFiles);
});
test('rewritten autosaves require confirmation even with the same id and timestamp, including after restore', async () => {
  const files = await fixture();
  const phone = new Phone(files);
  await phone.choose('1', '1', false);
  await phone.deleteMessage('old', 'original');
  await writeFile(files.saveFilePath('1', '1'), JSON.stringify({ ...save(), money: 100 }));
  const restored = new Phone(files);
  await restored.restore();
  const preview = await restored.sync();
  assert.equal(preview.requiresConfirmation, true);
  assert.match(preview.warning, /block\/unblock/);
  const before = await readdir(files.playthroughDir('1'));
  await writeFile(files.saveFilePath('1', '1'), JSON.stringify({ ...save(), money: 200 }));
  const updated = await restored.sync(preview.token);
  assert.equal(updated.requiresConfirmation, true);
  assert.notEqual(updated.token, preview.token);
  assert.deepEqual(await readdir(files.playthroughDir('1')), before);
  const result = await restored.sync(updated.token);
  assert.equal((await files.readSave('1', result.saveId)).money, 200);
});
test('an unchanged save syncs directly and refuses concurrent sync or message edits', async () => {
  const files = await fixture();
  const phone = new Phone(files);
  await phone.choose('1', '1', false);
  await phone.deleteMessage('old', 'original');
  const pending = phone.sync();
  await assert.rejects(phone.sync(), /Wait for sync/);
  await assert.rejects(phone.deleteMessage('old', 'original'), /Wait for sync/);
  const result = await pending;
  assert.equal(result.requiresConfirmation, false);
  assert.equal(result.rebased, false);
});
test('sync refuses another semester or continuation branch without writing or discarding edits', async () => {
  for (const [from, to] of [[undefined, '20'], ['20', undefined], ['20', '21']]) {
    const files = await fixture(save(13, from));
    const phone = new Phone(files);
    await phone.choose('1', '1', false);
    await phone.deleteMessage('old', 'original');
    await writeFile(files.saveFilePath('1', '2'), JSON.stringify({ ...save(13, to), saveDate: 200 }));
    const before = await readdir(files.playthroughDir('1'));
    await assert.rejects(phone.sync(), /different semester/);
    assert.equal(phone.pendingCount(), 1);
    assert.deepEqual(await readdir(files.playthroughDir('1')), before);
  }
});

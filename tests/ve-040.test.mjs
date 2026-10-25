import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, settings, photosOff, respond } from './helpers/session-fixture.mjs';
import { isSaveId, isPhotoFile } from '../dist/game/files.js';
import { readLorebook, lorebookLines } from '../dist/game/lorebook.js';
import { SHIPPED_LORE } from '../dist/game/lorebookData.js';
import { relationshipLines, describePlayer } from '../dist/game/relationship.js';

test('all 9990 manual slots are recognized without accepting noncanonical or unsafe paths', () => {
  for (let n = 1; n <= 9990; n++) assert.equal(isSaveId(`manual${String(n).padStart(2, '0')}`), true);
  for (const id of ['manual00', 'manual1', 'manual001', 'manual9991', 'manual10000', '../manual91', 'manual91.json']) assert.equal(isSaveId(id), false);
});

test('sync discovers newer manual9990, rechecks confirmation, and preserves game/mod progress', async () => {
  const { files, phone } = await fixture('current');
  respond('New phone reply'); await phone.send('girl', 'Hello', settings, photosOff);
  const newer = await files.readSave('1', '1');
  Object.assign(newer, { saveId: 'manual9990', saveDate: 200, money: 1700, date: 9,
    exStartingChallenge: { version: 2, floors: { brain: -100, body: -80, heart: -30 } },
    exTalents: { initialized: true, earned: 7, spent: 2, ranks: { synthetic: 1 }, bpFraction: 0.5 }, exStoryMemory: { entries: ['preserve'] },
    presetVars: { synthetic: 'keep' }, scene: { modData: { game: 'darts', score: 8 } },
    tallies: { visits: 3 }, replays: ['keep'], readerCold: 2,
  });
  const convo = newer.bunnyboard.conversations.girl;
  convo.messages.push({ id: 'game-new', sender: 'contact', text: 'Game progress', date: 9, time: 0, invite: true, exReplyTo: 'original' });
  convo.modRecap = { keep: true };
  newer.bunnyboard.notifications = [{ id: 'new-notification', unread: true }];
  const target = files.saveFilePath('1', 'manual9990');
  await writeFile(target, JSON.stringify(newer));
  assert.equal((await files.listSaves('1'))[0].saveId, 'manual9990');
  const warning = await phone.sync();
  assert.equal(warning.requiresConfirmation, true); assert.match(warning.warning, /manual9990/);
  newer.money = 1900; await writeFile(target, JSON.stringify(newer));
  const refreshed = await phone.sync(warning.token);
  assert.equal(refreshed.requiresConfirmation, true); assert.notEqual(refreshed.token, warning.token);
  const result = await phone.sync(refreshed.token);
  assert.equal(result.rebased, true);
  const saved = await files.readSave('1', result.saveId);
  const normalize = save => {
    const copy = structuredClone(save);
    delete copy.saveId; delete copy.saveDate; delete copy.bunnyboard.conversations;
    return copy;
  };
  assert.deepEqual(normalize(saved), normalize(newer));
  assert.deepEqual(saved.bunnyboard.conversations.girl.modRecap, convo.modRecap);
  assert.deepEqual(saved.bunnyboard.conversations.girl.messages.find(m => m.id === 'game-new'), convo.messages.at(-1));
  assert.ok(saved.bunnyboard.conversations.girl.messages.some(m => m.text === 'New phone reply'));
  assert.equal(await readFile(target, 'utf8'), JSON.stringify(newer));
});

test('lorebook reads fresh playthrough edits, inherits defaults, and gates City Life', async () => {
  const { files, phone } = await fixture();
  const shipped = SHIPPED_LORE.find(e => !e.ref.startsWith('city_life_'));
  const city = SHIPPED_LORE.find(e => e.ref.startsWith('city_life_'));
  const sidecar = path.join(files.playthroughDir('1'), 'lorebook.json');
  const book = { schemaVersion: 1, setting: 'Synthetic setting', edits: {
    [shipped.ref]: { text: 'Edited lore' }, [city.ref]: { text: 'City override' },
  }, custom: [{ id: 'custom1', keys: ['C++ club', 'café'], text: 'Club lore' }] };
  await writeFile(sidecar, JSON.stringify(book));
  const context = await readLorebook(files, '1', false);
  assert.ok(lorebookLines(context, shipped.keys[0]).includes('Edited lore'));
  assert.ok(lorebookLines(context, 'Visit the C++ club and cafés').includes('Club lore'));
  assert.ok(!lorebookLines(context, 'supercafé').includes('Club lore'));
  assert.ok(!lorebookLines(context, city.keys[0]).includes('City override'));
  assert.ok(lorebookLines(await readLorebook(files, '1', true), city.keys[0]).includes('City override'));
  book.edits[shipped.ref] = { keys: ['replacement-key'] };
  await writeFile(sidecar, JSON.stringify(book));
  const refreshed = await phone.promptContext(phone.view(), phone.characters.get('girl'), 'none', false);
  assert.ok(lorebookLines(refreshed.lorebook, 'replacement-key').includes(shipped.text));
  assert.ok(!lorebookLines(refreshed.lorebook, shipped.keys[0]).includes(shipped.text));
  await phone.choose('2', '1', true);
  assert.deepEqual((await phone.promptContext(phone.view(), phone.characters.get('girl'), 'none', false)).lorebook, { entries: [] });
  assert.equal(await readFile(sidecar, 'utf8'), JSON.stringify(book));
});

test('unreadable lorebook prevents a provider call and releases the generation reservation', async () => {
  const { files, phone } = await fixture();
  const sidecar = path.join(files.playthroughDir('1'), 'lorebook.json');
  await writeFile(sidecar, '{broken');
  globalThis.fetch = async () => { assert.fail('Must not send incomplete context'); };
  await assert.rejects(phone.send('girl', 'Hello', settings, photosOff), /lorebook/);
  await writeFile(sidecar, JSON.stringify({ schemaVersion: 1, edits: {}, custom: [] }));
  respond('Recovered'); await phone.send('girl', 'Hello again', settings, photosOff);
  assert.ok(phone.view().bunnyboard.conversations.girl.messages.some(m => m.text === 'Recovered'));
});

test('Godlike Standards follows the live switch, exempts lovers and permits Godly stats', async () => {
  const { files, phone } = await fixture();
  const character = { ...phone.characters.get('girl'), traits: ['Godlike'] };
  const save = phone.view(), info = save.charInfo.girl;
  const readContext = () => phone.promptContext(save, character, 'none', false);
  assert.equal((await readContext()).godlikeStandards, false);
  await writeFile(path.join(files.dataDir, 'mods.json'), JSON.stringify({ on: { 'godlike-standards': true }, options: {} }));
  assert.equal((await readContext()).godlikeStandards, true);
  const lines = (stats, enabled = true, state = info) => relationshipLines(character, state, 1, stats, true, enabled).join('\n');
  assert.match(lines(save.stats), /100 points each/);
  assert.doesNotMatch(lines(save.stats, false), /100 points each/);
  assert.doesNotMatch(lines({ brain: 100, body: 100, heart: 100 }), /100 points each/);
  assert.doesNotMatch(lines(save.stats, true, { ...info, flags: { ...info.flags, isLover: true } }), /100 points each/);
  const stats = { brain: -100, body: -65, heart: -20 }, before = structuredClone(stats);
  assert.match(describePlayer(stats), /basic reasoning/);
  assert.match(describePlayer(stats), /tiring after small efforts/);
  assert.deepEqual(stats, before);
});

test('VE legacy photos and PNG/WebP fallbacks display without allowing path traversal', async () => {
  const { files, phone } = await fixture();
  const dir = files.photosDir('1', 'girl'); await mkdir(dir, { recursive: true });
  for (const file of ['photo_1234567890_a1b2c3d4.png', 'girl_chat_001.webp', 'girl_bunnyboard_001.png']) await writeFile(path.join(dir, file), 'synthetic');
  assert.equal(await phone.photoPath('girl', 'photo_1234567890_a1b2c3d4.png'), path.join(dir, 'photo_1234567890_a1b2c3d4.png'));
  assert.equal(await phone.photoPath('girl', 'girl_chat_001.png'), path.join(dir, 'girl_chat_001.webp'));
  assert.equal(await phone.photoPath('girl', 'girl_bunnyboard_001.webp'), path.join(dir, 'girl_bunnyboard_001.png'));
  for (const bad of ['../photo_1234567890_a1b2c3d4.png', 'photo_1_abcdefgh.png', 'file.svg']) {
    assert.equal(isPhotoFile(bad), false); await assert.rejects(phone.photoPath('girl', bad), /Not found/);
  }
});

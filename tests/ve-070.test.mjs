import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, settings, photosOff, respond } from './helpers/session-fixture.mjs';
import { affectionFor, relationshipLines } from '../dist/game/relationship.js';
import { allowedPhotoTier } from '../dist/texting/photos.js';
import { buildTextingPrompt } from '../dist/texting/prompt.js';

// Contracts checked against VE v0.7.0, commit 716d6bcb8ee2036e162eed76bd597ab53060cd90:
// shared/{types,saveRules,relationship,feed}.ts and renderer/prompts/textingPrompt.ts.
test('VE 0.7.0 sync preserves mod-owned slices and unfinished scene rollback state on newer progress', async () => {
  const { files, phone } = await fixture('current');
  respond('Phone update');
  await phone.send('girl', 'Hello', settings, photosOff);
  const newer = await files.readSave('1', '1');
  Object.assign(newer, {
    saveId: 'manual9990', saveDate: 200,
    ex: {
      'prompt-studio': { v: '1.0.0', data: { score: '42' } },
      'future-mod': { v: '9.0.0', data: { nested: [null, false, { keep: true }] } },
    },
    scene: { cast: ['girl'], transcript: [], summary: null, mods: { 'prompt-studio': [{ at: 1, before: { score: '41' } }], miniGame: { game: 'darts', score: 8 } } },
  });
  Object.assign(newer.charInfo.girl, { toldSecrets: ['Shared fact'], secrets: ['Unrevealed fact'], breakPenalty: { points: 17, halved: true } });
  newer.bunnyboard.conversations.girl.messages[0].ex = { 'future-mod': { v: '1', data: { keep: true } } };
  const source = files.saveFilePath('1', newer.saveId);
  await writeFile(source, JSON.stringify(newer));
  const recordPath = path.join(files.playthroughDir('1'), 'playthrough.json');
  const recordBefore = await readFile(recordPath, 'utf8');
  const warning = await phone.sync();
  assert.equal(warning.requiresConfirmation, true);
  const result = await phone.sync(warning.token);
  const saved = await files.readSave('1', result.saveId);
  assert.equal(saved.schemaVersion, 13);
  assert.deepEqual(saved.ex, newer.ex);
  assert.deepEqual(saved.scene, newer.scene);
  assert.deepEqual(saved.charInfo, newer.charInfo);
  assert.deepEqual(saved.bunnyboard.conversations.girl.messages[0], newer.bunnyboard.conversations.girl.messages[0]);
  assert.ok(saved.bunnyboard.conversations.girl.messages.some(m => m.text === 'Phone update'));
  assert.equal(await readFile(source, 'utf8'), JSON.stringify(newer));
  assert.equal(await readFile(recordPath, 'utf8'), recordBefore);
});

test('continued-semester penalties and fresh feed likes match VE affection and photo eligibility', async () => {
  const { phone } = await fixture('current');
  const character = phone.characters.get('girl');
  const info = structuredClone(phone.view().charInfo.girl);
  info.memories = [{ date: 1, type: 'liked', desc: 'a conversation' }];
  info.feed = Array.from({ length: 6 }, (_, i) => ({ date: i, liked: true, likedOn: i + 1 }));
  assert.equal(affectionFor(info, 1, character), 7);
  assert.equal(affectionFor(info, 1, { traits: ['Terminally Online'] }), 9);
  info.feed.at(-1).likedOn += 1;
  assert.equal(affectionFor(info, 1, character), 6);
  info.breakPenalty = { points: 43 };
  const before = structuredClone(info);
  assert.equal(affectionFor(info, 1, character), -37);
  assert.match(relationshipLines(character, info, 1, phone.view().stats, true).join('\n'), /hates the reader/);
  assert.equal(allowedPhotoTier(character, info, 1, { enabled: true, explicit: true }), 'none');
  assert.deepEqual(info, before);
  info.breakPenalty.halved = true;
  assert.equal(affectionFor(info, 1, character), -16);
  delete info.breakPenalty;
  assert.equal(allowedPhotoTier(character, info, 1, { enabled: true, explicit: true }), 'everyday');
});

test('VE 0.7.0 DM context carries only the newest three disclosed secrets', async () => {
  const { phone } = await fixture();
  const save = phone.view();
  save.charInfo.girl.toldSecrets = ['Old disclosed fact.', 'Known one.', 'Known two.', 'Known three.'];
  save.charInfo.girl.secrets = ['Hidden future revelation.'];
  const before = structuredClone(save);
  const ctx = await phone.promptContext(save, phone.characters.get('girl'), 'none', false);
  const request = buildTextingPrompt(ctx, 'Hello');
  assert.match(request.user, /Secrets the reader knows: Known one\. Known two\. Known three\./);
  assert.doesNotMatch(request.user, /Old disclosed fact|Hidden future revelation/);
  assert.deepEqual(save, before);
});

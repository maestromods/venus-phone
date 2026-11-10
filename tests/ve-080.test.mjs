import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, respond, settings, photosOff } from './helpers/session-fixture.mjs';
import { buildTextingPrompt } from '../dist/texting/prompt.js';
import { buildPhotoPrompt } from '../dist/photoPrompt.js';

const photo = { tier: 'everyday', scene: 'Standing by the lake', file: 'girl_chat_001.png' };
const slice = data => ({ 'photo-feature': { v: '1.7.2', data } });

test('VE 0.8 DM photos survive selection, render reservations and sync in both formats', async () => {
  const { files, phone } = await fixture();
  const resources = path.join(files.gameDir, 'resources');
  await mkdir(resources);
  await writeFile(path.join(resources, 'venus-extracurriculars.json'), JSON.stringify({ build: 'Venus Extracurriculars', buildVersion: '0.8.0' }));
  const save = await files.readSave('1', '1');
  const messages = save.bunnyboard.conversations.girl.messages;
  const base = messages[0];
  messages.push(
    { ...base, id: 'legacy', photo },
    { ...base, id: 'cleared', ex: slice(null), photo },
    { ...base, id: 'pending', ex: slice({ tier: 'everyday', pending: true }) },
    { ...base, id: 'migrated', ex: slice({ ...photo, with: 'friend' }), photo: { ...photo, scene: 'obsolete' } },
  );
  save.breakupsOwed = ['girl'];
  save.ex = { 'other-mod': { v: '2', data: { opaque: [null, false] } } };
  const source = JSON.stringify(save);
  await writeFile(files.saveFilePath('1', '1'), source);
  await phone.choose('1', '1', true);
  const shown = phone.thread('girl').messages;
  assert.equal(shown[1].photo.scene, photo.scene);
  assert.equal(shown[2].photo, null);
  assert.equal(shown[3].photo.pending, true);
  assert.equal(shown[4].photo.scene, photo.scene);
  const [modern, legacy] = files.photoDirs('1', 'girl');
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, photo.file), 'old png');
  assert.equal(await phone.photoPath('girl', photo.file), path.join(legacy, photo.file));
  await mkdir(modern, { recursive: true });
  await writeFile(path.join(modern, photo.file), 'modern png');
  assert.equal(await phone.photoPath('girl', photo.file), path.join(modern, photo.file));
  await writeFile(path.join(modern, 'girl_chat_001.webp'), 'modern webp');
  assert.equal(await phone.photoPath('girl', photo.file), path.join(modern, 'girl_chat_001.webp'));
  await assert.rejects(phone.photoPath('girl', '../autosave.json'), /Not found/);
  await writeFile(path.join(modern, 'girl_chat_012.json'), '{}');
  await writeFile(path.join(legacy, 'girl_chat_008.webp'), 'old webp');
  const fresh = await phone.reservePhotoName('1', phone.characters.get('girl'), phone.view(), 'new');
  assert.equal(fresh, 'girl_chat_013.png');
  respond('Reply');
  await phone.send('girl', 'Hello', settings, photosOff);
  const reply = phone.state.delta.added.girl.at(-1);
  reply.photo = { ...photo, file: fresh };
  reply.ex = { 'another-mod': { v: '1', data: 'keep' } };
  const result = await phone.sync();
  const written = await files.readSave('1', result.saveId);
  const synced = written.bunnyboard.conversations.girl.messages;
  assert.deepEqual(synced.slice(0, messages.length), messages);
  assert.deepEqual(synced.at(-1).ex, { ...reply.ex, ...slice(reply.photo) });
  assert.equal(synced.at(-1).photo, undefined);
  assert.equal(phone.thread('girl').messages.at(-1).photo.file, fresh);
  assert.deepEqual(written.breakupsOwed, save.breakupsOwed);
  assert.deepEqual(written.ex, save.ex);
  assert.equal(await readFile(files.saveFilePath('1', '1'), 'utf8'), source);
});

test('Bunnyfeeds prompts include only visible posts, pictures and publicly answered comments', async () => {
  const { files, phone } = await fixture();
  const save = phone.view();
  const person = phone.characters.get('girl');
  const comment = (id, text, at, data) => ({ id, text, at, ex: { bunnyfeeds: { v: '1.1.5', data } } });
  save.charInfo.girl.feed = [
    { date: 0, text: 'Too old' },
    { date: 0, text: 'Breakfast', photo: { ...photo, scene: 'Cleared photo' }, ex: slice(null) },
    { date: 1, text: 'Lake walk', ex: slice(photo), comments: [
      comment('a', 'Public question', 0, { player: true }),
      comment('b', 'Public answer', 1, { charId: 'girl', replyTo: 'a' }),
      { id: 'c', text: 'Unanswered question', at: 0, player: true },
      comment('d', 'Future answer', 3, { charId: 'girl', replyTo: 'c' }),
    ] },
    { date: 1, text: 'Held text', ex: slice({ ...photo, held: true }) },
  ];
  const prompt = async on => {
    await writeFile(path.join(files.dataDir, 'mods.json'), JSON.stringify({ on }));
    const ctx = await phone.promptContext(save, person, 'none', false);
    return buildTextingPrompt(ctx, 'Hello').user;
  };
  const enabled = await prompt({ bunnyfeeds: true, 'photo-feature': true });
  for (const visible of ['Breakfast', 'Lake walk', photo.scene, 'Public question', 'Public answer']) assert.ok(enabled.includes(visible));
  assert.doesNotMatch(enabled, /Too old|Held text|Unanswered question|Future answer|Cleared photo/);
  const noPhotos = await prompt({ bunnyfeeds: true });
  assert.match(noPhotos, /Held text/);
  assert.ok(!noPhotos.includes(photo.scene));
  assert.doesNotMatch(await prompt({ 'photo-feature': true }), /Lake walk|Public answer/);
});

test('explicit photo crops take precedence over default pose and selfie framing', async () => {
  const { phone } = await fixture();
  const character = phone.characters.get('girl');
  for (const [caption, tag] of [
    ['Standing for a close-up from the waist down', 'lower_body'],
    ['A close-up selfie at a cafe', '(upper_body:1.3)'],
    ['A medium close-up by the window', '(upper_body:1.3)'],
    ['A closeup by the window', 'portrait'],
  ]) assert.ok(buildPhotoPrompt(character, 'everyday', caption).positive.includes(tag), caption);
});

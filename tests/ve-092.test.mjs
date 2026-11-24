import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, respond, settings, photosOff } from './helpers/session-fixture.mjs';
import { buildTextingPrompt } from '../dist/texting/prompt.js';
import { buildPhotoPrompt } from '../dist/photoPrompt.js';
import { isRomanceable } from '../dist/game/relationship.js';
import { isPhotoFile } from '../dist/game/files.js';
import { describedPhotoTier, describesSomebodyElse, settlePhoto } from '../dist/texting/photos.js';

async function mark092(files) {
  const resources = path.join(files.gameDir, 'resources');
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(resources, 'venus-extracurriculars.json'), JSON.stringify({ build: 'Venus Extracurriculars', buildVersion: '0.9.2' }));
}

test('0.9.2 transfers join contacts and settled profiles; sync preserves newer game state', async () => {
  for (const mode of ['first', 'continued']) {
    const { files, phone } = await fixture(mode);
    await mark092(files);
    const recordPath = path.join(files.playthroughDir('1'), 'playthrough.json');
    const record = JSON.parse(await readFile(recordPath));
    record.playerPronouns = 'they';
    record.romance = { male: 'none', female: 'sexuality' };
    await writeFile(recordPath, JSON.stringify(record));
    const recordBytes = await readFile(recordPath);
    const save = await files.readSave('1', '1');
    const profile = { year: 2, dorm: 'lowrise_2', major: 'Biology', schedule: {}, transferredAt: 1, attractedTo: { male: true, female: false } };
    save.transfers = [{ charId: 'boy', profile, classes: { BIO: { preserve: true } } }];
    save.pendingTransfers = [{ charId: 'pending', profile }];
    save.charInfo.boy = structuredClone(save.charInfo.girl);
    save.charInfo.pending = structuredClone(save.charInfo.girl);
    save.npcRelationships = { 'boy|girl': { affinity: 5, dating: 0, crush: ['boy'], cheated: { girl: -1 } } };
    save.npcAdvice = [{ opaque: 'keep game-owned state' }];
    const character = { ...phone.characters.get('girl'), charId: 'boy', firstName: 'Alex', gender: 'male', attractedTo: { male: false, female: true } };
    for (const id of ['boy', 'pending']) {
      const dir = files.characterDirs(id)[0];
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'character.json'), JSON.stringify({ ...character, charId: id }));
    }
    await writeFile(files.saveFilePath('1', '1'), JSON.stringify(save));
    await phone.choose('1', '1', true);
    assert.deepEqual(phone.contactIds().sort(), ['boy', 'girl']);
    assert.deepEqual(phone.view().charInfo.boy.attractedTo, profile.attractedTo);
    const context = await phone.voiceContext('boy');
    const prompt = buildTextingPrompt(context, 'Hello').user;
    assert.match(prompt, /Alex .*Pronouns: he\/him/);
    assert.match(prompt, /they\/them pronouns/);
    assert.match(prompt, /never will/);
    assert.match(prompt, /Alex is dating Girl Synthetic/);
    assert.doesNotMatch(prompt, /Alex has a crush on Girl/); // undisclosed at low affection
    respond('Hello back');
    await phone.send('boy', 'Hello', settings, photosOff);
    const newer = { ...save, saveId: '2', saveDate: 200, money: 77, npcAdvice: [{ result: 'newer advice' }] };
    await writeFile(files.saveFilePath('1', '2'), JSON.stringify(newer));
    const warning = await phone.sync();
    assert.equal(warning.requiresConfirmation, true);
    const result = await phone.sync(warning.token);
    const written = await files.readSave('1', result.saveId);
    for (const key of ['transfers', 'pendingTransfers', 'npcRelationships', 'npcAdvice', 'money']) assert.deepEqual(written[key], newer[key]);
    assert.equal(written.bunnyboard.conversations.boy.messages.at(-1).text, 'Hello back');
    assert.deepEqual(await readFile(recordPath), recordBytes);
    assert.deepEqual(await files.readSave('1', '1'), save);
  }
});

test('0.9.2 native photos render, inform prompts and sync without rewriting old attachments', async () => {
  const { files, phone } = await fixture();
  await mark092(files);
  assert.equal(await files.photoRecordVersion(), '1.9.0');
  const save = await files.readSave('1', '1');
  const messages = save.bunnyboard.conversations.girl.messages;
  const base = messages[0];
  const image = { kind: 'image', file: 'uploadabc123_chat_001.webp', description: 'My garden' };
  messages.push(
    { ...base, id: 'random', ex: { 'photo-feature': { v: '1.9.0', data: { tier: 'everyday', scene: 'At the lake', file: 'a1b2c3d4e5.webp' } } } },
    { ...base, id: 'outgoing-image', sender: 'player', text: '', outgoingPhoto: image },
    { ...base, id: 'outgoing-description', sender: 'player', text: '', outgoingPhoto: { kind: 'description', description: 'Sunset at home' } },
  );
  await writeFile(files.saveFilePath('1', '1'), JSON.stringify(save));
  await phone.choose('1', '1', true);
  const modern = files.photoDirs('1', 'girl')[0];
  await mkdir(modern, { recursive: true });
  for (const file of ['a1b2c3d4e5.webp', image.file]) {
    await writeFile(path.join(modern, file), 'synthetic image');
    assert.equal(await phone.photoPath('girl', file), path.join(modern, file));
  }
  for (const file of ['../a1b2c3d4e5.webp', 'a1b2c3d4e5.json', 'aaaaaaaaaa.webp:secret', 'a1b2c3d4e5.webp/other']) assert.equal(isPhotoFile(file), false);
  const shown = phone.thread('girl').messages;
  assert.equal(shown[1].photo.file, 'a1b2c3d4e5.webp');
  assert.deepEqual(shown[2].outgoingPhoto, image);
  assert.equal(phone.contacts()[0].lastText, '📷 Photo');
  const prompt = buildTextingPrompt(await phone.voiceContext('girl'), 'Hello').user;
  for (const scene of ['At the lake', 'My garden', 'Sunset at home']) assert.ok(prompt.includes(scene));
  respond('Nice view');
  await phone.send('girl', 'Another view', settings, photosOff);
  const delta = phone.state.delta.added.girl;
  delta[0].readerPhoto = { file: 'local.jpg', scene: 'A city skyline' };
  delta.at(-1).photo = { tier: 'everyday', scene: 'A cafe', file: 'girl_chat_001.png' };
  const result = await phone.sync();
  const written = await files.readSave('1', result.saveId);
  const synced = written.bunnyboard.conversations.girl.messages;
  assert.deepEqual(synced.slice(0, messages.length), messages);
  assert.deepEqual(synced.at(-2).outgoingPhoto, { kind: 'description', description: 'A city skyline' });
  assert.equal(synced.at(-2).text, 'Another view');
  assert.equal(synced.at(-2).readerPhoto, undefined);
  assert.equal(synced.at(-1).ex['photo-feature'].v, '1.9.0');
  await assert.rejects(phone.sync(), /Nothing new to sync/);
});

test('romance follows reader pronouns, settled attraction, settings and established history', async () => {
  const { phone } = await fixture();
  const female = phone.characters.get('girl');
  const male = { ...female, gender: 'male' };
  for (const [character, reader, expected] of [[female, 'he', true], [female, 'she', false], [female, 'they', true], [male, 'he', false], [male, 'she', true], [male, 'they', true]]) {
    assert.equal(isRomanceable(character, undefined, reader), expected);
    const gender = character.gender ?? 'female';
    for (const level of ['none', 'all', 'everyone']) assert.equal(isRomanceable(character, undefined, reader, { [gender]: level }), level !== 'none');
    const ctx = await phone.voiceContext('girl');
    ctx.character = character;
    ctx.player.pronouns = reader;
    ctx.character.backstory = 'Her brother said he would visit.';
    const prompt = buildTextingPrompt(ctx, 'Hi').user;
    assert.ok(prompt.includes(`Pronouns: ${gender === 'male' ? 'he/him' : 'she/her'}`));
    assert.ok(prompt.includes(reader === 'they' ? 'they/them pronouns' : reader === 'she' ? 'a female (she/her)' : 'a male (he/him)'));
    assert.ok(prompt.includes('Her brother said he would visit.'));
  }
  assert.equal(isRomanceable(male, { attractedTo: { male: true, female: false } }, 'he'), true);
  assert.equal(isRomanceable(male, { attractedTo: { male: false, female: true } }, 'he'), false);
  for (const flags of [{ hasKissed: true }, { hadSex: true }, { isLover: true }, { benefits: true }, { brokenUp: 1 }]) assert.equal(isRomanceable(male, { flags }, 'he', { male: 'none' }), true);
  assert.equal(isRomanceable(male, { datingSince: 0 }, 'he', { male: 'none' }), true);
  assert.equal(isRomanceable(male, { flags: { hasCrush: true } }, 'he', { male: 'none' }), false);
});

test('NPC partners constrain new romance even when their character file is unavailable', async () => {
  const { phone } = await fixture();
  const ctx = await phone.voiceContext('girl');
  ctx.save.stats = { brain: 100, body: 100, heart: 100 };
  ctx.save.date = 30;
  const prompt = () => buildTextingPrompt(ctx, 'Hi').user;
  ctx.save.npcRelationships = { 'girl|missing': { affinity: 4, dating: 0 } };
  assert.match(prompt(), /won't make or accept romantic advances from anyone else/);
  ctx.save.npcRelationships['girl|missing'] = { affinity: 0, dating: 29 };
  assert.match(prompt(), /from anyone else/);
  ctx.save.npcRelationships['girl|missing'].cheated = { girl: 30 };
  assert.doesNotMatch(prompt(), /from anyone else/);
  ctx.save.npcRelationships['girl|missing'].affinity = 5;
  ctx.character.traits = ['Promiscuous'];
  assert.doesNotMatch(prompt(), /from anyone else/);
});

test('male photo captions retain gender, classify upper-body exposure and reject a second subject', async () => {
  const { phone } = await fixture();
  const male = { ...phone.characters.get('girl'), gender: 'male', firstName: 'Alex', baseAppearance: ['short_hair', '1girl', 'large_breasts'], outfit: ['shirt', 'jeans'], swimOutfit: ['swim_trunks'] };
  for (const scene of ['Shirtless with his hands on his hips, wearing jeans', 'Nude from the waist up, wearing shorts']) {
    assert.equal(describedPhotoTier(scene, 'male'), 'everyday');
    assert.equal(describesSomebodyElse(scene, 'male'), false);
    assert.deepEqual(settlePhoto({ sendPhoto: true, photoPrompt: scene, allowed: 'everyday', gender: 'male' }), { send: true, tier: 'everyday' });
    const tags = buildPhotoPrompt(male, 'everyday', scene);
    assert.match(tags.positive, /1boy, male_focus/);
    assert.doesNotMatch(tags.positive, /1girl|large_breasts|\bshirt\b/);
    assert.doesNotMatch(tags.negative, /\b1boy\b|\bnipples\b/);
    assert.match(tags.negative, /penis/);
  }
  assert.equal(describedPhotoTier('Shirtless', 'female'), 'explicit');
  assert.equal(describedPhotoTier('Pulling down his pants', 'male'), 'explicit');
  assert.equal(describesSomebodyElse('With his girlfriend', 'male'), true);
  assert.equal(settlePhoto({ sendPhoto: true, photoPrompt: 'Pulling down his pants', allowed: 'everyday', gender: 'male' }).send, false);
  assert.match(buildPhotoPrompt(phone.characters.get('girl'), 'everyday', 'A smile by the lake').positive, /1girl/);
});

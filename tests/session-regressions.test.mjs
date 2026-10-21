import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, Phone, applyDelta, fixture, settings, photosOff, answer, respond, gate } from './helpers/session-fixture.mjs';

for (const mode of ['first', 'current', 'alumni']) {
  test(`${mode}: unread counts survive repeated sync and reads without replaying increments`, async () => {
    const { files, phone } = await fixture(mode);
    respond('First opener'); await phone.incoming('girl', settings, photosOff, 10);
    const first = await phone.sync();
    assert.equal((await files.readSave('1', first.saveId)).bunnyboard.conversations.girl.unread, 1);
    assert.equal(phone.unreadTotal(), 1);
    assert.equal(phone.state.delta.unread.girl, undefined);
    respond('Second opener'); await phone.incoming('girl', settings, photosOff, 10);
    const second = await phone.sync();
    const saved = await files.readSave('1', second.saveId);
    assert.equal(saved.bunnyboard.conversations.girl.unread, 2);
    assert.equal(phone.contacts()[0].unread, 2);
    assert.deepEqual(saved.unchangedGameField, { keep: true });
    assert.deepEqual(saved.exCommunityData, { keep: ['synthetic'] });
    assert.equal(saved.semester, mode === 'first' ? undefined : '20');
    const restored = new Phone(files); await restored.restore();
    assert.equal(restored.unreadTotal(), 2);
    await restored.markRead('girl');
    assert.equal(restored.unreadTotal(), 0);
    const third = await restored.sync();
    assert.equal((await files.readSave('1', third.saveId)).bunnyboard.conversations.girl.unread, 0);
  });

  test(`${mode}: folder changes reject unsynced additions and deletions without changing session`, async () => {
    const other = await fixture(mode);
    const { phone } = await fixture(mode);
    await phone.deleteMessage('girl', 'base-1');
    const disk = await readFile(path.join(root, 'phone/session.json'), 'utf8');
    const state = phone.state, files = phone.files;
    assert.throws(() => phone.setGameFiles(other.files), /unsynced/);
    let committed = false;
    await assert.rejects(phone.changeGameFiles(other.files, async () => { committed = true; }), /unsynced/);
    assert.equal(committed, false); assert.equal(phone.state, state); assert.equal(phone.files, files);
    assert.equal(await readFile(path.join(root, 'phone/session.json'), 'utf8'), disk);
    await phone.choose('1', '1', true);
    respond('Reply'); await phone.send('girl', 'Keep this message', settings, photosOff);
    assert.throws(() => phone.setGameFiles(other.files), /unsynced/);
  });
}

test('selection reserves its whole async window against sends, incoming, voice, edits, sync and another selection', async () => {
  for (const next of ['playthrough', 'semester']) {
    const { phone, files } = await fixture('current');
    if (next === 'semester') {
      const save = await files.readSave('1', '1');
      await writeFile(files.saveFilePath('1', '2'), JSON.stringify({ ...save, semester: '21', date: 8, saveId: '2' }));
    }
    const entered = gate(), wait = gate();
    const original = files.readCharacter.bind(files);
    files.readCharacter = async id => { entered.release(); await wait.promise; return original(id); };
    const choosing = phone.choose(next === 'playthrough' ? '2' : '1', next === 'semester' ? '2' : '1', false);
    await entered.promise;
    await assert.rejects(phone.send('girl', 'Old context', settings, photosOff), /finish changing/);
    assert.equal(await phone.incoming('girl', settings, photosOff), false);
    assert.throws(() => phone.reserveVoiceCall('girl'), /finish changing/);
    await assert.rejects(phone.sync(), /finish changing/);
    await assert.rejects(phone.choose('1', '1', true), /finish changing/);
    await assert.rejects(phone.deleteMessage('girl', 'base-1'), /finish changing/);
    await assert.rejects(phone.regenerate('girl', 'base-1', settings), /finish changing/);
    await assert.rejects(phone.unblock('girl', settings), /finish changing/);
    wait.release(); await choosing;
    assert.equal(phone.state.delta.added.girl, undefined);
    assert.equal(phone.base.semester, next === 'semester' ? '21' : '20');
    assert.equal(phone.base.date, next === 'semester' ? 8 : 2);
  }
});

test('a pending reply or voice call prevents selection; failed selection releases the reservation', async () => {
  const { phone, files } = await fixture();
  const entered = gate(), wait = gate();
  globalThis.fetch = async () => { entered.release(); await wait.promise; return answer(); };
  const sending = phone.send('girl', 'Old context', settings, photosOff);
  await entered.promise;
  await assert.rejects(phone.choose('2', '1', true), /Wait for replies/);
  wait.release(); await sending;
  await phone.choose('1', '1', true);
  phone.reserveVoiceCall('girl');
  await assert.rejects(phone.choose('2', '1', true), /Wait for replies/);
  phone.releaseVoiceCall('girl');
  const state = phone.state;
  const original = files.readCharacter;
  files.readCharacter = async () => { throw new Error('Synthetic read failure'); };
  await assert.rejects(phone.choose('2', '1', true), /Synthetic read failure/);
  assert.equal(phone.state, state);
  files.readCharacter = original;
  await phone.choose('2', '1', true);
  assert.equal(phone.playthroughId(), '2');
});

test('folder settings commit is atomic and a restored session cannot cross folders', async () => {
  const other = await fixture();
  const { phone, files } = await fixture();
  const state = phone.state;
  await assert.rejects(phone.changeGameFiles(other.files, async () => { throw new Error('Synthetic settings failure'); }), /settings failure/);
  assert.equal(phone.state, state); assert.equal(phone.files, files);
  const entered = gate(), wait = gate();
  const changing = phone.changeGameFiles(other.files, async () => { entered.release(); await wait.promise; });
  await entered.promise;
  await assert.rejects(phone.send('girl', 'Keep context', settings, photosOff), /finish changing/);
  wait.release(); await changing;
  assert.equal(phone.info(), null);
  const restored = new Phone(other.files); await restored.restore();
  assert.equal(restored.info(), null);
  await restored.choose('1', '1', false);
  assert.equal(restored.files, other.files);
});

test('reading old messages does not clear newer game unread; already-present additions are not counted again', async () => {
  const { phone } = await fixture();
  const base = structuredClone(phone.base), thread = base.bunnyboard.conversations.girl;
  thread.messages.push({ id: 'new-game', sender: 'contact', text: 'New game text', date: 2, time: 0 });
  thread.unread = 2;
  const delta = { added: { girl: [thread.messages[1]] }, summaries: {}, blocked: [], read: { girl: ['base-1'] }, unread: { girl: 1 } };
  const merged = applyDelta(base, delta, true);
  assert.equal(merged.bunnyboard.conversations.girl.unread, 1);
  assert.equal(merged.bunnyboard.conversations.girl.messages.length, 2);
});

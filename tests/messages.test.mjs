import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(os.tmpdir(), 'venus-messages-'));
process.env.VENUS_PHONE_DATA = dir;
const { Phone, applyDelta } = await import('../dist/phone.js');
const { emptyFlags } = await import('../dist/game/types.js');
const base = {
  date: 1, time: 0, stats: { brain: 1, body: 1, heart: 1 },
  charInfo: { girl: { flags: { ...emptyFlags(), gaveContactInfo: true }, memories: [] } },
  bunnyboard: { conversations: { girl: { charId: 'girl', unread: 0, summary: 'Old reply recap', messages: [
    { id: 'p', sender: 'player', text: 'Hello', date: 1, time: 0 },
    { id: 'a', sender: 'contact', text: 'Old reply', date: 1, time: 0, exPhoneTurn: 'turn' },
    { id: 'b', sender: 'contact', text: 'Old followup', date: 1, time: 0, exPhoneTurn: 'turn' },
  ] } } },
};
function phone() {
  const p = new Phone({});
  p.base = structuredClone(base);
  p.state = { playthroughId: '1', baseSaveId: '1', delta: { added: {}, summaries: {}, blocked: [], unread: {} } };
  p.record = { chars: ['girl'], playerFirstName: 'Reader', playerLastName: '', term: { index: 0 } };
  p.characters.set('girl', { charId: 'girl', firstName: 'Girl', lastName: '', likes: [], dislikes: [], traits: [], behavior: {}, outfit: [], peOutfit: [], swimOutfit: [] });
  // Keep these tests focused on message lifecycle, independent of game profile formatting.
  p.promptContext = (save, character, allowedPhoto = 'none', photoRequested = false) => ({ save, character, roster: [], player: { firstName: 'Reader', lastName: '', termIndex: 0 }, season: 'spring', allowedPhoto, photoRequested });
  return p;
}
const settings = { provider: 'openrouter', endpointUrl: 'https://example.invalid', apiKey: 'test', model: 'test', thinking: 'low' };
const photos = { enabled: true, explicit: false };
function photoPhone() {
  const p = phone();
  p.base.bunnyboard.conversations.girl.messages[1].photo = {
    tier: 'everyday', scene: 'Sitting by a cafe window in her everyday clothes.', file: 'girl_chat_001.png', pending: true,
  };
  p.files.photosDir = () => path.join(dir, 'photos');
  p.renders = [];
  // Capture queued jobs without starting ComfyUI. The pending photo need not exist on disk yet.
  p.drawPhoto = async (playthrough, character, message) => { p.renders.push({ playthrough, character, message }); };
  return p;
}
let request;
const originalFetch = globalThis.fetch;
function respond(reply) {
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  };
}
test('message lifecycle', async (t) => {
  try {
    await t.test('deletion persists as a tombstone and clears stale recap', async () => {
      const p = phone();
      await p.deleteMessage('girl', 'a');
      assert.deepEqual(p.thread('girl').messages.map(m => m.id), ['p', 'b']);
      assert.equal(p.pendingCount(), 1);
      const newer = structuredClone(base);
      newer.bunnyboard.conversations.girl.messages.push({ id: 'new', sender: 'player', text: 'New save', date: 2, time: 0 });
      const merged = applyDelta(newer, p.state.delta, true);
      assert.deepEqual(merged.bunnyboard.conversations.girl.messages.map(m => m.id), ['p', 'b', 'new']);
      assert.equal(merged.bunnyboard.conversations.girl.summary, '');
      const restored = phone();
      restored.state = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(dir, 'session.json'), 'utf8'));
      assert.deepEqual(restored.thread('girl').messages.map(m => m.id), ['p', 'b']);
    });
    await t.test('regeneration replaces all bubbles and excludes old reply and recap from prompt', async () => {
      const p = phone();
      respond({ messages: ['Fresh reply'], summary: 'Fresh recap', blocked: false });
      const thread = await p.regenerate('girl', 'b', settings);
      assert.deepEqual(thread.messages.map(m => m.text), ['Hello', 'Fresh reply']);
      assert.equal(request.messages.at(-1).content.includes('Old reply'), false);
      assert.equal((request.messages.at(-1).content.match(/YOU: Hello/g) ?? []).length, 1);
      assert.equal(applyDelta(base, p.state.delta, true).bunnyboard.conversations.girl.summary, 'Fresh recap');
    });
    await t.test('incoming regeneration retains the opener marker and earlier incoming turns', async () => {
      const p = phone();
      const messages = p.base.bunnyboard.conversations.girl.messages;
      messages[1].exIncomingTurn = 'first';
      messages[1].exPhoneTurn = 'first';
      messages[1].exReplyTo = 'incoming-texts:incoming';
      messages[2].exIncomingTurn = 'second';
      messages[2].exPhoneTurn = 'second';
      messages[2].exReplyTo = 'incoming-texts:incoming';
      respond({ messages: ['New opener'], summary: 'Recap', blocked: false });
      const result = await p.regenerate('girl', 'b', settings);
      assert.deepEqual(result.messages.map(m => m.text), ['Hello', 'Old reply', 'New opener']);
      assert.equal(p.state.delta.added.girl.at(-1).exReplyTo, 'incoming-texts:incoming');
    });
    await t.test('failed regeneration leaves originals intact', async () => {
      const p = phone();
      const before = structuredClone(p.state);
      globalThis.fetch = async () => { throw new Error('Offline'); };
      await assert.rejects(p.regenerate('girl', 'b', settings));
      assert.deepEqual(p.state, before);
      assert.equal(p.inFlight.size, 0);
    });
    await t.test('photo regeneration replaces the whole reply and queues a distinct new photo each time', async () => {
      const p = photoPhone();
      const freshPhoto = 'Standing by the cafe window in her everyday clothes, smiling at the camera.';
      respond({ messages: ['How about this one?'], summary: 'A cafe photo.', blocked: false, sendPhoto: true, photoPrompt: freshPhoto, photoTier: 'everyday' });
      const result = await p.regenerate('girl', 'b', settings, photos);
      assert.deepEqual(result.messages.map(m => m.text), ['Hello', 'How about this one?']);
      assert.equal(result.messages.at(-1).photo.pending, true);
      assert.equal(result.messages.at(-1).photo.file, 'girl_chat_002.png');
      assert.equal(p.renders.length, 1);
      assert.equal(p.renders[0].message.photo.scene, freshPhoto);
      assert.equal(p.renders[0].playthrough, '1');
      assert.ok(request.response_format.json_schema.schema.required.includes('photoPrompt'));
      assert.match(request.messages.at(-1).content, /Sitting by a cafe window/);
      assert.doesNotMatch(request.messages.at(-1).content, /Old reply|Old followup/);
      assert.equal((request.messages.at(-1).content.match(/YOU: Hello/g) ?? []).length, 1);
      const again = await p.regenerate('girl', result.messages.at(-1).id, settings, photos);
      assert.equal(again.messages.at(-1).photo.file, 'girl_chat_003.png');
      assert.equal(p.renders.length, 2);
      assert.notEqual(p.renders[0].message.id, p.renders[1].message.id);
      assert.equal(applyDelta(base, p.state.delta, true).bunnyboard.conversations.girl.messages.at(-1).photo.file, 'girl_chat_003.png');
    });
    await t.test('photo generation metadata can be repaired before replacing a reply', async () => {
      const p = photoPhone();
      let requests = 0;
      globalThis.fetch = async () => {
        const reply = requests++ === 0
          ? { messages: ['Here you go!'], summary: 'A new picture.', blocked: false }
          : { sendsPicture: true, photoPrompt: 'Standing outdoors in her everyday clothes, waving at the camera.', photoTier: 'everyday' };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
      };
      const result = await p.regenerate('girl', 'b', settings, photos);
      assert.equal(requests, 2);
      assert.ok(result.messages.at(-1).photo);
      assert.equal(p.renders.length, 1);
    });
    await t.test('missing or disallowed replacement photos keep the existing reply intact', async () => {
      const p = photoPhone();
      const before = structuredClone(p.state);
      const messages = p.thread('girl').messages;
      for (const extra of [{ sendPhoto: false }, { sendPhoto: true, photoTier: 'suggestive', photoPrompt: 'Wearing a swimsuit by the pool.' }]) {
        respond({ messages: ['A replacement'], summary: 'New recap', blocked: false, ...extra });
        await assert.rejects(p.regenerate('girl', 'b', settings, photos), /No replacement photo/);
        assert.deepEqual(p.state, before);
        assert.deepEqual(p.thread('girl').messages, messages);
        assert.equal(p.renders.length, 0);
        assert.equal(p.inFlight.size, 0);
      }
      await assert.rejects(p.regenerate('girl', 'b', settings, { enabled: false, explicit: false }), /Enable photos/);
      p.base.bunnyboard.conversations.girl.messages[1].photo.tier = 'suggestive';
      await assert.rejects(p.regenerate('girl', 'b', settings, photos), /current photo settings or relationship limits/);
    });
    await t.test('regenerated incoming photos retain incoming markers, while a new block sends no photo', async () => {
      const p = photoPhone();
      for (const m of p.base.bunnyboard.conversations.girl.messages.slice(1)) m.exIncomingTurn = 'incoming';
      respond({ messages: ['Look at this.'], summary: 'Photo.', blocked: false, sendPhoto: true, photoPrompt: 'Standing at a cafe in her everyday clothes.', photoTier: 'everyday' });
      const result = await p.regenerate('girl', 'b', settings, photos);
      assert.equal(p.state.delta.added.girl.at(-1).exReplyTo, 'incoming-texts:incoming');
      assert.ok(result.messages.at(-1).photo);
      respond({ messages: ['Do not contact me again.'], summary: 'Blocked.', blocked: true });
      const blocked = await p.regenerate('girl', result.messages.at(-1).id, settings, photos);
      assert.equal(blocked.blocked, true);
      assert.equal(p.renders.length, 1);
    });
    await t.test('blocking survives deletion and rejects sending and regeneration', async () => {
      const p = phone();
      respond({ messages: ['Stop contacting me.'], summary: 'Blocked', blocked: true });
      const result = await p.regenerate('girl', 'b', settings);
      assert.equal(result.blocked, true);
      const last = result.messages.find(m => m.sender === 'contact');
      await p.deleteMessage('girl', last.id);
      assert.equal(p.thread('girl').blocked, true);
      assert.equal(applyDelta(base, p.state.delta, true).charInfo.girl.flags.blocked, true);
      await assert.rejects(p.send('girl', 'Hi', settings, { enabled: false, explicit: false }), /blocked/);
      await assert.rejects(p.regenerate('girl', 'b', settings), /blocked/);
    });
    await t.test('busy threads reject edits and older replies cannot be regenerated', async () => {
      const p = phone();
      await assert.rejects(p.regenerate('girl', 'a', settings), /latest/);
      p.inFlight.add('girl');
      await assert.rejects(p.deleteMessage('girl', 'a'), /Wait/);
      await assert.rejects(p.choose('1', '2', true), /Wait/);
    });
    await t.test('unblocking an inherited block persists and merges onto a newer game save', async () => {
      const p = phone();
      p.base.charInfo.girl.flags.blocked = true;
      const originalPlayerIds = p.thread('girl').messages.filter(m => m.sender === 'player').map(m => m.id);
      respond({ messages: ['I unblocked you.', 'We can try talking again.'], summary: 'Girl reopened contact.', blocked: false });
      const result = await p.unblock('girl', settings);
      assert.equal(result.blocked, false);
      assert.equal(result.busy, false);
      assert.equal(result.messages.at(-1).text, 'I unblocked you. We can try talking again.');
      assert.equal(result.messages.at(-2).text, 'Girl unblocked you.');
      assert.deepEqual(result.messages.filter(m => m.sender === 'player').map(m => m.id), originalPlayerIds);
      assert.match(request.messages.at(-1).content, /She has decided to unblock the reader/);
      assert.match(request.messages.at(-1).content, /The reader has not sent a new message/);
      const newer = structuredClone(p.base);
      newer.stats.brain = 9;
      const merged = applyDelta(newer, p.state.delta, true);
      assert.equal(merged.charInfo.girl.flags.blocked, false);
      assert.equal(merged.charInfo.girl.flags.gaveContactInfo, true);
      assert.equal(merged.stats.brain, 9);
      assert.equal(merged.bunnyboard.conversations.girl.summary, 'Girl reopened contact.');
      const restored = new Phone({
        readSave: async () => structuredClone(p.base), readRecord: async () => p.record,
        readCharacter: async id => p.characters.get(id),
      });
      await restored.restore();
      assert.equal(restored.thread('girl').blocked, false);
      assert.equal(restored.thread('girl').messages.at(-1).text, result.messages.at(-1).text);
      await restored.deleteMessage('girl', result.messages.at(-1).id);
      assert.equal(restored.thread('girl').blocked, false);
    });
    await t.test('phone block, unblock, and later block use the latest explicit decision', async () => {
      const p = phone();
      p.state.delta.blocked.push('girl');
      respond({ messages: ['I unblocked you.'], summary: 'Reopened contact.', blocked: false });
      await p.unblock('girl', settings);
      assert.deepEqual(p.state.delta.blocked, []);
      assert.equal(p.thread('girl').blocked, false);
      await assert.rejects(p.unblock('girl', settings), /hasn't blocked/);
      respond({ messages: ['That is enough.'], summary: 'Blocked again.', blocked: true });
      await p.send('girl', 'Hello again', settings, { enabled: false, explicit: false });
      assert.equal(p.thread('girl').blocked, true);
      assert.deepEqual(p.state.delta.unblocked, []);
      assert.equal(applyDelta(base, p.state.delta, true).charInfo.girl.flags.blocked, true);
    });
    await t.test('failed, empty, or contradictory unblock replies leave the block and history intact', async () => {
      const p = phone();
      p.state.delta.blocked.push('girl');
      const before = structuredClone(p.state);
      for (const reply of [null, { messages: [], blocked: false }, { messages: ['No.'], blocked: true }]) {
        if (reply === null) globalThis.fetch = async () => { throw new Error('Offline'); };
        else respond(reply);
        await assert.rejects(p.unblock('girl', settings));
        assert.deepEqual(p.state, before);
        assert.equal(p.thread('girl').blocked, true);
        assert.equal(p.inFlight.size, 0);
      }
    });
    await t.test('unblocking rejects unknown contacts, missing contact info, and concurrent requests', async () => {
      const p = phone();
      await assert.rejects(p.unblock('missing', settings), /Unknown contact/);
      p.base.charInfo.girl.flags.gaveContactInfo = false;
      await assert.rejects(p.unblock('girl', settings), /hasn't given/);
      p.base.charInfo.girl.flags.gaveContactInfo = true;
      p.state.delta.blocked.push('girl');
      let finish;
      globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
      const first = p.unblock('girl', settings);
      assert.equal(p.thread('girl').blocked, true);
      await assert.rejects(p.unblock('girl', settings), /still replying/);
      await assert.rejects(p.deleteMessage('girl', 'a'), /Wait/);
      await assert.rejects(p.choose('1', '2', true), /Wait/);
      await assert.rejects(p.sync(), /Wait/);
      finish(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ messages: ['I unblocked you.'], summary: 'Reopened contact.', blocked: false }) } }] })));
      await first;
      assert.equal(p.thread('girl').messages.filter(m => m.text === 'I unblocked you.').length, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

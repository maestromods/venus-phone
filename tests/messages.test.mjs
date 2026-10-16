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
  p.promptContext = (save, character) => ({ save, character, roster: [], player: { firstName: 'Reader', lastName: '', termIndex: 0 }, season: 'spring', allowedPhoto: 'none', photoRequested: false });
  return p;
}
const settings = { provider: 'openrouter', endpointUrl: 'https://example.invalid', apiKey: 'test', model: 'test', thinking: 'low' };
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
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

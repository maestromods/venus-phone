import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCalls, speechSegments } from '../dist/voice.js';
const llm = { provider: 'openrouter', endpointUrl: 'https://example.invalid', apiKey: 'test', model: 'test', thinking: 'low' };
function fixture() {
  const messages = [], reservations = new Set();
  const phone = {
    blocked: false, reservations,
    reserveVoiceCall(id) { if (this.blocked || reservations.has(id)) throw Error('Blocked or busy'); reservations.add(id); },
    releaseVoiceCall(id) { reservations.delete(id); },
    thread() { return { name: 'Test Girl' }; },
    async recordVoice(charId, callId, sender, text) { messages.push({ sender, text }); },
    async blockFromVoice() { this.blocked = true; },
    voiceContext() { return {
      save: { date: 1, time: 0, stats: { brain: 1, body: 1, heart: 1 }, charInfo: { girl: { flags: {}, memories: [] } }, bunnyboard: { conversations: { girl: { messages: [], summary: null } } } },
      character: { charId: 'girl', firstName: 'Test', lastName: '', likes: [], dislikes: [], traits: [], behavior: {}, outfit: [], peOutfit: [], swimOutfit: [] },
      roster: [], player: { firstName: 'Player', lastName: '', termIndex: 0 }, season: 'spring', allowedPhoto: 'none', photoRequested: false,
    }; },
  };
  const engine = { status: () => ({ ready: true }), request: async () => ({ audio: 'test' }), stop() {} };
  return { phone, messages, calls: new VoiceCalls(phone, engine) };
}
test('spoken call lifecycle, cancellation and authorization', async t => {
  const original = globalThis.fetch;
  const respond = (speech, action = 'continue') => { globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ speech, action }) } }] })); };
  try {
    await t.test('typed input is saved, unheard replies are not; acknowledgements are idempotent', async () => {
      const { calls, messages, phone } = fixture();
      try {
        const call = await calls.start('owner', 'girl', 'default');
        respond('Um, that sounds lovely.');
        const reply = await calls.turn('owner', call.id, 'How are you?', false, llm);
        assert.equal(messages.filter(m => m.sender === 'player').length, 1);
        assert.equal(messages.filter(m => m.sender === 'contact').length, 0);
        await assert.rejects(calls.audio('stranger', call.id, reply.replyId, 0));
        await calls.ack('owner', call.id, reply.replyId, 0);
        assert.equal(messages.filter(m => m.sender === 'contact').length, 1);
        await calls.end('owner', call.id);
        assert.equal(phone.reservations.size, 0);
      } finally { calls.stop(); }
    });
    await t.test('interrupt discards unheard speech and rejects stale audio', async () => {
      const { calls, messages } = fixture();
      try {
        const call = await calls.start('owner', 'girl', 'default'); respond('You will never hear this.');
        const reply = await calls.turn('owner', call.id, 'Hello', false, llm);
        await calls.interrupt('owner', call.id);
        await assert.rejects(calls.audio('owner', call.id, reply.replyId, 0));
        assert.equal(messages.filter(m => m.sender === 'contact').length, 0);
        respond('New response.'); await calls.turn('owner', call.id, 'A new thought', false, llm);
        await calls.end('owner', call.id);
      } finally { calls.stop(); }
    });
    await t.test('late model response cannot resurrect an ended call', async () => {
      const { calls, messages, phone } = fixture();
      try {
        const call = await calls.start('owner', 'girl', 'default');
        let finish, started; const ready = new Promise(r => started = r);
        globalThis.fetch = async () => { started(); return new Promise(r => finish = r); };
        const turn = calls.turn('owner', call.id, 'Hello', false, llm); await ready;
        await calls.end('owner', call.id);
        finish(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ speech: 'Too late', action: 'continue' }) } }] })));
        await assert.rejects(turn);
        assert.equal(messages.filter(m => m.sender === 'contact').length, 0);
        assert.equal(phone.reservations.size, 0);
      } finally { calls.stop(); }
    });
    await t.test('blocking persists even if her final speech is interrupted', async () => {
      const { calls, phone } = fixture();
      try {
        const call = await calls.start('owner', 'girl', 'default'); respond('Do not contact me again.', 'block');
        await calls.turn('owner', call.id, 'An offensive message', false, llm);
        assert.equal(phone.blocked, true);
        assert.equal((await calls.interrupt('owner', call.id)).ended, true);
        await assert.rejects(calls.turn('owner', call.id, 'Again', false, llm));
        await calls.end('owner', call.id);
        await assert.rejects(calls.start('owner', 'girl', 'default'));
      } finally { calls.stop(); }
    });
    await t.test('one call at a time, blank turns rejected, malformed responses recover', async () => {
      const { calls } = fixture();
      try {
        const call = await calls.start('owner', 'girl', 'default');
        await assert.rejects(calls.start('owner', 'girl', 'default'));
        await assert.rejects(calls.turn('owner', call.id, ' ', false, llm));
        respond('', 'continue'); await assert.rejects(calls.turn('owner', call.id, 'Hello', false, llm));
        respond('Recovered.'); await calls.turn('owner', call.id, 'Still there?', false, llm);
        await calls.end('owner', call.id);
      } finally { calls.stop(); }
    });
  } finally { globalThis.fetch = original; }
});
test('speech segmentation bounds chunks and removes unsupported direction tags', () => {
  const parts = speechSegments('Um, hello. [chuckle] [walks away] ' + 'A moderately long sentence to speak naturally. '.repeat(12));
  assert.ok(parts.every(p => p.length <= 220)); assert.match(parts.join(' '), /\[chuckle\]/); assert.doesNotMatch(parts.join(' '), /walks away/);
  assert.throws(() => speechSegments(' '));
});
test('microphone WAV encoder preserves duration and writes PCM16 at 16 kHz', async () => {
  const { wavBase64 } = await import('../public/voice.js');
  const bytes = Buffer.from(wavBase64([new Float32Array(48000).fill(0.25)], 48000), 'base64');
  assert.equal(bytes.length, 32044); assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(24), 16000); assert.equal(bytes.readInt16LE(44), 8192);
});

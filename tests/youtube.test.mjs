import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { youtubeLinks } from '../public/youtube-links.js';
import { WatchTogether, analyzeVideo, parseTimeline } from '../dist/youtube.js';
import { completeStructured } from '../dist/llm.js';

const url = 'https://www.youtube.com/watch?v=abcdefghijk';
const settings = { provider: 'openrouter', model: 'google/test-video', apiKey: 'synthetic', endpointUrl: 'https://example.invalid', thinking: 'low' };
const timeline = { title: 'Test video', duration: 120, moments: [
  { at: 4, observation: 'A person begins making coffee.' }, { at: 40, observation: 'A cup tips over.' }, { at: 80, observation: 'The person cleans up.' },
] };
function fixture(reply) {
  let identity = {}, clock = 0;
  const comments = [];
  const phone = { sessionIdentity: () => identity, thread: () => ({ charId: 'girl', busy: false, blocked: false }),
    async commentOnVideo(charId, context, llm, signal, current) { if (reply) await reply(signal); if (current()) comments.push(context); } };
  const service = new WatchTogether(phone, async () => structuredClone(timeline), () => clock);
  after(() => service.stop());
  let id;
  return { service, comments, phone, async start() { const result = await service.start('owner', 'girl', url, settings); id = result.id; return result; },
    tick(position, playing = true) { clock += 2000; return service.tick('owner', id, position, playing, settings); },
    async advance(to) { for (let at = 2; at <= to; at += 2) await this.tick(at); },
    changeSave() { identity = {}; },
  };
}
test('YouTube parsing canonicalizes watch/short/share links, timestamps and tracking without accepting arbitrary hosts', () => {
  assert.deepEqual(youtubeLinks('Watch https://youtu.be/abcdefghijk?si=tracking&t=1m3s.'), [{ id: 'abcdefghijk', url, startSeconds: 63 }]);
  assert.equal(youtubeLinks('https://m.youtube.com/shorts/abcdefghijk')[0].url, url);
  assert.equal(youtubeLinks(url + ' ' + url).length, 1);
  for (const text of ['https://youtube.com.attacker.test/watch?v=abcdefghijk', 'https://youtube.com@attacker.test/watch?v=abcdefghijk',
    'https://user@youtube.com/watch?v=abcdefghijk', 'https://youtube.com:8443/watch?v=abcdefghijk', 'https://youtube.com/playlist?list=test',
    'https://youtube.com/watch?v=invalid', 'http://127.0.0.1/video']) assert.equal(youtubeLinks(text).length, 0, text);
});
test('analysis refuses inaccessible videos, invalid timelines and unsupported values', () => {
  assert.throws(() => parseTimeline({ accessible: false }), /could not be watched/);
  assert.throws(() => parseTimeline({ accessible: true, title: 'x', durationSeconds: -1, moments: [] }), /invalid timeline/);
  const result = parseTimeline({ accessible: true, title: 'x', durationSeconds: 90, moments: [{ at: 4.1, observation: 'Hello' }, { at: 80, observation: 'Goodbye' }, { at: 150, observation: 'Invalid' }] });
  assert.deepEqual(result.moments.map(m => m.at), [5, 80]);
});
test('watch sessions isolate ownership and never expose future observations to the character', async () => {
  const f = fixture(); const result = await f.start();
  assert.match(result.id, /^[a-f0-9-]{36}$/); assert.equal(result.videoId, 'abcdefghijk'); assert.equal(result.moments, undefined);
  await assert.rejects(f.service.tick('other', result.id, 4, true, settings), /ended/);
  await f.advance(6);
  assert.equal(f.comments.length, 1); assert.match(f.comments[0], /making coffee/);
  assert.doesNotMatch(f.comments[0], /tips over|cleans up/);
  assert.doesNotMatch(f.service.contextFor('owner', 'girl'), /tips over|cleans up/);
  assert.equal(f.service.contextFor('other', 'girl'), undefined);
});
test('pausing and closing discard model replies already in flight', async () => {
  for (const action of ['pause', 'close']) {
    let resolve; const gate = new Promise(r => { resolve = r; });
    const f = fixture(() => gate); await f.start(); await f.tick(2);
    const pending = f.tick(4);
    if (action === 'pause') await f.tick(4, false); else f.service.end('owner');
    resolve(); await pending;
    assert.equal(f.comments.length, 0);
  }
});
test('seek skips missed reactions, rewind does not repeat comments, and changed saves invalidate sessions', async () => {
  const f = fixture(); await f.start(); await f.advance(6); assert.equal(f.comments.length, 1);
  await f.tick(75); assert.equal(f.comments.length, 1); assert.doesNotMatch(f.service.contextFor('owner', 'girl'), /tips over/);
  await f.tick(0); await f.advance(6); assert.equal(f.comments.length, 1);
  f.changeSave(); await assert.rejects(f.tick(8), /ended/);
});
test('an analysis result cannot resurrect a closed session', async () => {
  let resolve; const gate = new Promise(r => { resolve = r; });
  const f = fixture(); f.service.analyze = async () => { await gate; return timeline; };
  const pending = f.start(); f.service.end('owner'); resolve();
  await assert.rejects(pending, /closed/);
});
test('video requests attach actual media inputs on both providers, with AI Studio routing on OpenRouter', async () => {
  const original = globalThis.fetch; const requests = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    const result = JSON.stringify({ accessible: true, title: 'Test', durationSeconds: 15, moments: [{ at: 4, observation: 'A visible event.' }] });
    return new Response(JSON.stringify(body.contents ? { candidates: [{ content: { parts: [{ text: result }] }, finishReason: 'STOP' }] }
      : { choices: [{ message: { content: result } }] }));
  };
  try {
    await analyzeVideo(youtubeLinks(url)[0], settings, new AbortController().signal);
    await analyzeVideo(youtubeLinks(url)[0], { ...settings, provider: 'gemini' }, new AbortController().signal);
    assert.deepEqual(requests[0].messages.at(-1).content.at(-1), { type: 'video_url', video_url: { url } });
    assert.deepEqual(requests[0].provider, { only: ['Google AI Studio'], allow_fallbacks: false });
    assert.deepEqual(requests[1].contents[0].parts.at(-1), { fileData: { fileUri: url } });
    await completeStructured(settings, { system: '', user: 'Ordinary text', schema: { name: 'test', schema: {} } });
    assert.equal(requests[2].provider, undefined); assert.equal(requests[2].messages[0].content, 'Ordinary text');
  } finally { globalThis.fetch = original; }
});

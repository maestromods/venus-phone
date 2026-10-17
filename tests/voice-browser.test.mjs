import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../public/voice.js', import.meta.url), 'utf8')).replaceAll('export ', '');
function fixture({ secure = true, mode = 'microphone', permission, failStart = false } = {}) {
  const nodes = new Map(), events = [], requests = [], worklets = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', open: true, dataset: {}, hidden: false, textContent: '',
      setAttribute() {}, removeAttribute() {}, addEventListener() {}, replaceChildren() {}, append() {}, focus() {},
      showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  node('voice-mode').value = mode;
  node('voice-threshold').value = '0.025';
  const track = { stopped: false, stop() { this.stopped = true; events.push('stop'); } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const audioNode = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  class AudioContext {
    state = 'suspended'; sampleRate = 48000; destination = {};
    audioWorklet = { addModule: async () => { events.push('worklet'); } };
    async resume() { events.push('resume'); this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { return audioNode(); }
    createGain() { return audioNode(); }
  }
  const document = {
    getElementById: node, addEventListener() {}, createElement: () => node('line'), createTextNode: s => s,
    fullscreenElement: null,
    documentElement: { requestFullscreen() { events.push('fullscreen'); return Promise.resolve(); } },
    async exitFullscreen() { events.push('exit-fullscreen'); this.fullscreenElement = null; },
  };
  const ctx = vm.createContext({ document, window: { isSecureContext: secure, matchMedia: () => ({ matches: true }), addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia() { events.push('permission'); return permission ? permission(stream) : Promise.resolve(stream); } } },
    AudioContext, AudioWorkletNode: class { port = {}; constructor() { worklets.push(this); } connect() {} disconnect() {} },
    setInterval: () => 1, clearInterval() {}, AbortController, Blob, Date, Uint8Array, Float32Array, ArrayBuffer, DataView,
    btoa: s => Buffer.from(s, 'binary').toString('base64'), localStorage: { getItem() {}, setItem() {} },
    async fetch(url, options) {
      events.push(url); requests.push({ url, body: options.body ? JSON.parse(options.body) : undefined });
      const data = url === '/api/calls/start' ? { id: 'call', name: 'Test Contact' }
        : url.endsWith('/turn') ? { replyId: 'reply', segments: [], action: 'continue' }
        : url.endsWith('/transcribe') ? { text: 'Hello from the microphone' } : {};
      return { ok: !(failStart && url === '/api/calls/start'), json: async () => failStart && url === '/api/calls/start' ? { error: 'Server unavailable' } : data };
    },
  });
  vm.runInContext(source, ctx);
  vm.runInContext('charId = "test"; name = "Test"; modelsReady = true;', ctx);
  return { node, events, requests, track, worklets, document, run: js => vm.runInContext(js, ctx) };
}
test('microphone permission happens before network or fullscreen, then captured speech reaches transcription', async () => {
  const f = fixture();
  await f.node('voice-start').onclick();
  assert.equal(f.events[0], 'permission');
  assert.ok(f.events.indexOf('permission') < f.events.indexOf('/api/calls/start'));
  assert.ok(f.events.indexOf('worklet') < f.events.indexOf('fullscreen'));
  assert.equal(f.node('voice-mic-level').hidden, false);
  for (let i = 0; i < 8; i++) f.worklets[0].port.onmessage({ data: new Float32Array(2048).fill(0.1) });
  for (let i = 0; i < 24; i++) f.worklets[0].port.onmessage({ data: new Float32Array(2048) });
  await new Promise(resolve => setImmediate(resolve));
  const transcribe = f.requests.find(r => r.url.endsWith('/transcribe'));
  const wav = Buffer.from(transcribe.body.audio, 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.ok(f.requests.some(r => r.body?.text === 'Hello from the microphone'));
  await f.node('voice-end').onclick();
  assert.equal(f.track.stopped, true);
});
test('HTTP on a phone explains HTTPS without requesting a microphone or starting a call', async () => {
  const f = fixture({ secure: false });
  await f.node('voice-start').onclick();
  assert.equal(f.events.includes('permission'), false);
  assert.equal(f.requests.length, 0);
  assert.match(f.node('voice-error').textContent, /start-voice-https.cmd/);
  assert.equal(f.node('voice-mode').value, 'microphone');
});
test('denied microphone stays in microphone mode and never silently starts a typed call', async () => {
  const f = fixture({ permission: () => Promise.reject(Object.assign(new Error('Denied'), { name: 'NotAllowedError' })) });
  await f.node('voice-start').onclick();
  assert.match(f.node('voice-error').textContent, /permission was denied/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.node('voice-mode').value, 'microphone');
  assert.equal(f.node('voice-start').disabled, false);
});
test('ending while permission is pending stops a late stream without creating a server call', async () => {
  let grant;
  const f = fixture({ permission: stream => new Promise(resolve => { grant = () => resolve(stream); }) });
  const starting = f.node('voice-start').onclick();
  await f.node('voice-end').onclick(); grant(); await starting;
  assert.equal(f.track.stopped, true);
  assert.equal(f.requests.length, 0);
});
test('server startup failure releases the microphone and shows the failure', async () => {
  const f = fixture({ failStart: true });
  await f.node('voice-start').onclick();
  assert.equal(f.track.stopped, true);
  assert.match(f.node('voice-error').textContent, /Server unavailable/);
});
test('typed calls need no microphone, and switching to mic exits fullscreen before permission', async () => {
  const f = fixture({ mode: 'type' });
  await f.node('voice-start').onclick();
  assert.equal(f.events.includes('permission'), false);
  f.document.fullscreenElement = {};
  f.node('voice-mode').value = 'microphone';
  await f.node('voice-mode').onchange();
  assert.ok(f.events.indexOf('exit-fullscreen') < f.events.indexOf('permission'));
  await f.node('voice-end').onclick();
  assert.equal(f.track.stopped, true);
});

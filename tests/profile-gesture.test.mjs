import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const gesture = source.slice(source.indexOf('// ---- Hidden profile gesture'), source.indexOf('async function refreshThread('));
function fixture() {
  const elements = new Map();
  const calls = [];
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, dataset: {},
      addEventListener(_event, listener) { this.click = listener; },
      querySelectorAll() { return [{ dataset: { id: 'old' } }]; },
      replaceChildren() {}, setAttribute() {},
    });
    return elements.get(id);
  };
  const context = vm.createContext({ $, clock: 0, fixtureBlocked: true,
    performance: { now: () => context.clock },
    document: { querySelectorAll: () => [] },
    clearAttachment() {}, stopPolling() {},
    api: async (url, options) => { calls.push({ url, options }); return { charId: 'girl', blocked: false }; },
    revealReplies: async (_thread, before) => { assert.ok(before.has('old')); },
  });
  vm.runInContext(`let current='thread', openCharId='girl', attached=null, revealing=false, editingMessage=false, lastRenderKey='';
    function show(name) { current=name; }
    async function refreshThread() { threadBlocked=fixtureBlocked; threadBusy=false; }
    ${gesture}
    threadBlocked=true;`, context);
  return { context, calls, $, run: code => vm.runInContext(code, context),
    click: at => { context.clock = at; return $('thread-profile').click(); } };
}

test('three profile clicks within three seconds request one unblock', async () => {
  const f = fixture();
  await f.click(0); await f.click(1500);
  assert.equal(f.calls.length, 0);
  await f.click(3000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/api/chats/girl/unblock');
  assert.equal(f.$('thread-profile').disabled, false);
});

test('expired clicks do not count, but a fresh rolling triple does', async () => {
  const f = fixture();
  await f.click(0); await f.click(1600); await f.click(3001);
  assert.equal(f.calls.length, 0);
  await f.click(4600);
  assert.equal(f.calls.length, 1);
});

test('a gesture cannot span contacts or start while unblocked or busy', async () => {
  const f = fixture();
  await f.click(0); await f.click(100);
  await f.run('openThread("other")');
  await f.click(200);
  assert.equal(f.calls.length, 0);
  for (const state of ['threadBlocked=false', 'threadBlocked=true;threadBusy=true', 'threadBusy=false;revealing=true', 'revealing=false;editingMessage=true', 'editingMessage=false;current="contacts"']) {
    f.run(state);
    await f.click(300); await f.click(400); await f.click(500);
    assert.equal(f.calls.length, 0);
  }
});

test('extra clicks cannot duplicate a pending unblock and a failed request can be retried', async () => {
  const f = fixture();
  let reject;
  f.context.api = () => { f.calls.push('request'); return new Promise((_resolve, fail) => { reject = fail; }); };
  await f.click(0); await f.click(100);
  const pending = f.click(200);
  assert.equal(f.$('thread-profile').disabled, true);
  await f.click(300); await f.click(400); await f.click(500);
  assert.equal(f.calls.length, 1);
  reject(new Error('Offline'));
  await pending;
  assert.equal(f.$('thread-error').textContent, 'Offline');
  assert.equal(f.$('thread-profile').disabled, false);
  f.context.api = async () => { f.calls.push('retry'); return {}; };
  await f.click(600); await f.click(700); await f.click(800);
  assert.equal(f.calls.length, 2);
});

test('switching chats during an unblock keeps the response in its own chat and unlocks the new profile', async () => {
  const f = fixture();
  let finish;
  f.context.api = () => new Promise(resolve => { finish = resolve; });
  f.context.revealReplies = async () => assert.fail('Do not reveal another contact\'s reply here');
  await f.click(0); await f.click(100);
  const pending = f.click(200);
  await f.run('openThread("other")');
  finish({ charId: 'girl' });
  await pending;
  assert.equal(f.$('thread-profile').disabled, false);
  assert.equal(f.run('openCharId'), 'other');
});

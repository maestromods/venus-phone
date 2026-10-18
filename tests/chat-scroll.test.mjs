import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const viewport = source.slice(source.indexOf('let viewportScrollFrame'), source.indexOf('// ---- Your photos'));
function fixture({ top = 1400 } = {}) {
  const frames = new Map(), listeners = new Map(); let next = 0, height = 600, scrollTop = top;
  const list = { scrollHeight: 2000, get clientHeight() { return height; }, get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = Math.min(Math.max(0, value), this.scrollHeight - height); },
    addEventListener(name, fn) { listeners.set(`list:${name}`, fn); } };
  const draft = { scrollHeight: 136, style: { set height(value) { height = value === 'auto' ? 600 : 500; } },
    addEventListener(name, fn) { listeners.set(`draft:${name}`, fn); } };
  const vv = { height: 800, offsetTop: 0, addEventListener() {} };
  const context = vm.createContext({ current: 'thread', openCharId: 'test', $: id => id === 'messages' ? list : draft,
    window: { visualViewport: vv, addEventListener() {}, scrollTo() {} },
    document: { documentElement: { style: { setProperty(name, value) { if (name === '--vv-height') height = parseFloat(value) - 200; } } }, addEventListener() {} },
    requestAnimationFrame(fn) { frames.set(++next, fn); return next; }, cancelAnimationFrame(id) { frames.delete(id); }, setTimeout() {},
  });
  vm.runInContext(viewport, context);
  const frame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  frame();
  return { list, draft, listeners, context, frame, resize(value) { vv.height = value; vm.runInContext('fitViewport()', context); } };
}

test('keyboard opening by more than the old threshold keeps the newest message visible', () => {
  const f = fixture(); f.resize(450); f.frame();
  assert.equal(f.list.scrollTop + f.list.clientHeight, f.list.scrollHeight);
  for (const height of [400, 430, 600, 800]) { f.resize(height); f.frame(); assert.equal(f.list.scrollTop + f.list.clientHeight, f.list.scrollHeight); }
});
test('opening the keyboard preserves a reader\'s position in older messages', () => {
  const f = fixture({ top: 500 }); f.resize(450); f.frame(); assert.equal(f.list.scrollTop, 500);
});
test('growing the message composer also keeps the last message visible', () => {
  const f = fixture(); f.listeners.get('draft:input')(); f.frame();
  assert.equal(f.list.scrollTop + f.list.clientHeight, f.list.scrollHeight);
});
test('manual scrolling cancels the deferred correction', () => {
  const f = fixture(); f.resize(450); f.list.scrollTop = 600; f.listeners.get('list:scroll')(); f.frame();
  assert.equal(f.list.scrollTop, 600);
});
test('a pending correction cannot move another conversation', () => {
  const f = fixture(); f.resize(450); f.context.openCharId = 'other'; f.list.scrollTop = 200; f.frame();
  assert.equal(f.list.scrollTop, 200);
});

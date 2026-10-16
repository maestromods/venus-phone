import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('async function refreshThread('), source.indexOf('function photoNode('));

test('reactions stay visible throughout reply animation and controls unlock afterwards', async () => {
  const elements = new Map();
  function node(tag = 'div', props = {}, ...children) {
    return { tag, children, ...props, classList: { add() {}, toggle() {} },
      scrollHeight: 100, scrollTop: 0, clientHeight: 100,
      append(...items) { this.children.push(...items); },
      replaceChildren() { this.children = []; }, setAttribute() {},
      querySelector() { return get('send'); } };
  }
  function get(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); }
  function find(predicate, root = get('messages')) {
    return (root?.children ?? []).flatMap(child => [...(predicate(child) ? [child] : []), ...find(predicate, child)]);
  }
  const buttons = () => find(n => n.tag === 'button');
  const reactions = () => find(n => n.class === 'reaction').map(n => n.text);
  const thread = { charId: 'girl', name: 'Girl', busy: false, blocked: false, messages: [
    { id: 'old', sender: 'player', text: 'Earlier message', stamp: 'Today', reaction: '❤️' },
    { id: 'p', sender: 'player', text: 'Hello', stamp: 'Today', reaction: '😂' },
    { id: 'r1', sender: 'contact', text: 'Hi', stamp: 'Today' },
    { id: 'r2', sender: 'contact', text: 'That made me laugh', stamp: 'Today', canRegenerate: true },
  ] };
  const phases = [];
  const context = vm.createContext({ $: get, el: node, thread,
    document: { createTextNode: text => ({ text }), querySelectorAll: buttons },
    api: async url => { if (url.endsWith('/delete')) throw new Error('Request failed'); return thread; },
    confirm: () => true, startPolling() {}, stopPolling() {},
    setTimeout: callback => { phases.push(reactions()); queueMicrotask(callback); },
  });
  await vm.runInContext(`
    let openCharId='girl',lastRenderKey='',threadBlocked=false,threadBusy=false,unblockingCharId=null,profileClicks=[];
    ${section}
    revealReplies({ ...thread, busy: true }, new Set(['old','p']))
  `, context);
  assert.ok(phases.length >= 4);
  for (const visible of phases) assert.deepEqual(visible, ['❤️', '😂']);
  assert.deepEqual(reactions(), ['❤️', '😂']);
  assert.ok(buttons().every(button => !button.disabled));
  await vm.runInContext('editMessage(thread, thread.messages[0], "delete")', context);
  assert.ok(buttons().every(button => !button.disabled));
  assert.equal(get('thread-error').textContent, 'Request failed');
});

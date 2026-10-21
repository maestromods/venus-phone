import { test } from 'node:test';
// Offline VM DOM model using exact production show/navigation/contact-loading/thread-loading,
// rendering/reveal/composer/attachment functions. No browser, sockets, real data or providers.
// This strengthens control-flow evidence; it is not a visual/iOS/Safari smoke test.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=await readFile(new URL('../public/app.js', import.meta.url),'utf8');
function section(start,end) { const i=source.indexOf(start), j=source.indexOf(end,i); assert.ok(i>=0 && j>i); return source.slice(i,j); }
const sections=[
  section('function show(name)', '// ---- Start-up'),
  section('async function openContacts()', '$("sync-btn").addEventListener'),
  section('// ---- Hidden profile gesture', 'function photoNode('),
  section('function startPolling()', '// iOS Safari'),
  section('function clearAttachment()', '$("attach-btn").addEventListener'),
  section('$("composer").addEventListener("submit"', '// ---- Notifications'),
  section('for (const button of document.querySelectorAll("[data-go]"))', 'boot().catch'),
].join('\n');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function environment() {
  const nodes=new Map(), requests=[], timers=[], revoked=[];
  let pendingSend;
  class Node {
    constructor(tag='div') { this.tag=tag; this.children=[]; this.dataset={}; this.style={}; this.attrs={}; this.events={}; this.hidden=false; this.disabled=false; this.value=''; this.scrollTop=0; this.scrollHeight=100; this.clientHeight=100; const classes=new Set(); this.classList={add:v=>classes.add(v),toggle:(v,on)=>on?classes.add(v):classes.delete(v)}; }
    set textContent(value) { this.children=[]; this._text=String(value); }
    get textContent() { return (this._text??'')+this.children.map(n=>n.textContent??'').join(''); }
    append(...children) { for(const child of children) { child.parent=this; this.children.push(child); } }
    replaceChildren(...children) { for(const c of this.children) c.parent=null; this.children=[]; this._text=''; this.append(...children); }
    remove() { if(this.parent) this.parent.children=this.parent.children.filter(c=>c!==this); this.parent=null; }
    setAttribute(k,v) { this.attrs[k]=v; if(k==='disabled') this.disabled=true; if(k.startsWith('data-')) this.dataset[k.slice(5)]=String(v); }
    addEventListener(type,fn) { (this.events[type]??=[]).push(fn); }
    dispatch(type,event={}) { if(type==='click' && this.disabled) return; return Promise.all((this.events[type]??[]).map(fn=>fn({...event,preventDefault(){}}))); }
    focus() {}
    descendants() { return this.children.flatMap(c=>[c,...c.descendants()]); }
    querySelector(selector) { if(selector==='button[type=submit]' && this===get('composer')) return get('send'); if(selector==='h1') return null; return this.querySelectorAll(selector)[0]??null; }
    querySelectorAll(selector) { const all=this.descendants(); if(selector==='[data-id]') return all.filter(n=>'id' in n.dataset); if(selector==='.message-actions button') return all.filter(n=>n.tag==='button'&&n.parent?.className==='message-actions'); return []; }
  }
  function get(id) { if(!nodes.has(id)) nodes.set(id,new Node(id==='draft'?'textarea':'div')); return nodes.get(id); }
  const back=get('back'); back.dataset.go='contacts';
  const threads={ A:{charId:'A',name:'Alice',busy:false,blocked:false,messages:[]}, B:{charId:'B',name:'Beatrice',busy:false,blocked:false,messages:[{id:'b1',sender:'contact',text:'B history',stamp:'Today'}]} };
  const api=async (path,options)=>{
    requests.push(path);
    if(path.endsWith('/send')) return new Promise((resolve,reject)=>pendingSend={resolve,reject,path,body:options.body});
    if(path==='/api/status') return {session:{player:'Synthetic',now:'Today',unsynced:0}};
    if(path==='/api/contacts') return {contacts:Object.values(threads).map(t=>({charId:t.charId,name:t.name}))};
    const charId=path.split('/').at(-1);
    if(threads[charId]) return threads[charId];
    throw Error('Unexpected synthetic route '+path);
  };
  const document={body:new Node('body'),createElement:tag=>new Node(tag),createTextNode:text=>{const n=new Node('#text');n.textContent=text;return n;},querySelectorAll:selector=>selector==='[data-go]'?[back]:get('messages').querySelectorAll(selector)};
  const context=vm.createContext({performance:{now:()=>0},$:get,document,window:{scrollTo(){}},api,URL:{revokeObjectURL:url=>revoked.push(url)},confirm:()=>true,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},setInterval:()=>1,clearInterval(){},openSettings:async()=>{throw Error('Settings not part of test');}});
  vm.runInContext(`const views=['lock','folder','pick','contacts','thread','settings']; let current='thread',openCharId=null,pollTimer=null,lastRenderKey='',attached=null; const draft=$('draft'); ${sections}`,context);
  const run=js=>vm.runInContext(js,context);
  const goB=async()=>{await back.dispatch('click');await tick(); const bButton=get('contact-list').children[1].children[0]; await bButton.dispatch('click');await tick();};
  const submit=()=>get('composer').dispatch('submit');
  const visibleIds=()=>get('messages').querySelectorAll('[data-id]').map(n=>n.dataset.id);
  return {context,get,run,goB,submit,threads,timers,requests,revoked,visibleIds,pending:()=>pendingSend};
}

test('navigating during reply animation renders B immediately and ignores the late A timer', async () => {
  const e = environment(); await e.run("openThread('A')");
  e.get('draft').value = 'For A'; const sending = e.submit();
  e.pending().resolve({ ...e.threads.A, messages: [{ id: 'aR', sender: 'contact', text: 'A reply', stamp: 'Today' }] });
  await tick(); assert.equal(e.timers.length, 1);
  await e.goB();
  assert.equal(e.get('thread-title').textContent, 'Beatrice');
  assert.deepEqual(e.visibleIds(), ['b1']);
  e.get('draft').value = 'B draft';
  e.timers.shift().fn(); await sending;
  assert.equal(e.get('thread-title').textContent, 'Beatrice');
  assert.deepEqual(e.visibleIds(), ['b1']);
  assert.equal(e.get('draft').value, 'B draft');
});

test('late send failure retains A draft while preserving B draft and attachment', async () => {
  const e = environment(); await e.run("openThread('A')");
  e.get('draft').value = 'Only for A'; const sending = e.submit();
  await e.goB(); e.get('draft').value = 'New B draft';
  e.run("attached={url:'blob:B',data:'synthetic-B'}");
  e.pending().reject(new Error('Synthetic failure')); await sending;
  assert.equal(e.get('draft').value, 'New B draft');
  assert.equal(e.run('attached.url'), 'blob:B');
  assert.equal(e.get('thread-error').textContent, '');
  await e.run("openThread('A')");
  assert.equal(e.get('draft').value, 'Only for A');
  assert.equal(e.get('thread-error').textContent, 'Synthetic failure');
  await e.goB(); assert.equal(e.get('draft').value, 'New B draft');
  assert.equal(e.run('attached.url'), 'blob:B');
});

test('late photo success releases only the sent attachment', async () => {
  const e = environment(); await e.run("openThread('A')");
  e.run("attached={mimeType:'image/jpeg',data:'synthetic-A',url:'blob:A'}");
  const sending = e.submit(); await e.goB();
  e.run("attached={mimeType:'image/jpeg',data:'synthetic-B',url:'blob:B'}");
  e.get('attach-preview').hidden = false;
  e.pending().resolve(e.threads.A); await sending;
  assert.equal(e.run('attached.url'), 'blob:B');
  assert.equal(e.get('attach-preview').hidden, false);
  assert.deepEqual(e.revoked, ['blob:A']);
});

test('A-to-B-to-A navigation invalidates the old A reveal too', async () => {
  const e = environment(); await e.run("openThread('A')");
  e.get('draft').value = 'For A'; const sending = e.submit();
  e.pending().resolve({ ...e.threads.A, messages: [{ id: 'stale', sender: 'contact', text: 'Old snapshot', stamp: 'Today' }] });
  await tick(); await e.goB();
  e.threads.A.messages = [{ id: 'current', sender: 'contact', text: 'Current snapshot', stamp: 'Today' }];
  await e.run("openThread('A')");
  e.timers.shift().fn(); await sending;
  assert.deepEqual(e.visibleIds(), ['current']);
  assert.equal(e.run('revealing'), false);
});

test('out-of-order refresh responses cannot overwrite the newer view', async () => {
  const e = environment(); await e.run("openThread('A')");
  const responses = [];
  e.context.api = () => new Promise(resolve => responses.push(resolve));
  const older = e.run('refreshThread()'), newer = e.run('refreshThread()');
  responses[1]({ ...e.threads.A, messages: [{ id: 'new', sender: 'contact', text: 'Latest', stamp: 'Today' }] }); await newer;
  responses[0]({ ...e.threads.A, messages: [] }); await older;
  assert.deepEqual(e.visibleIds(), ['new']);
});

test('a failed send does not overwrite a newer draft in the same conversation', async () => {
  const e = environment(); await e.run("openThread('A')");
  e.get('draft').value = 'Unsent'; const sending = e.submit();
  e.get('draft').value = 'Keep typing';
  e.pending().reject(new Error('Synthetic failure')); await sending;
  assert.equal(e.get('draft').value, 'Keep typing');
  assert.match(e.get('thread-error').textContent, /Unsent/);
});

test('clearing a session prevents a late failure from restoring its old draft', async () => {
  const e = environment(); await e.run("openThread('A')");
  e.get('draft').value = 'Old session'; const sending = e.submit();
  e.run('clearSessionComposers()');
  await e.run("openThread('A')"); e.get('draft').value = 'New session';
  e.pending().reject(new Error('Old session failed')); await sending;
  assert.equal(e.get('draft').value, 'New session');
  assert.equal(e.get('thread-error').textContent, '');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Phone, applyDelta } from '../dist/phone.js';
import { emptyFlags } from '../dist/game/types.js';
const settings={provider:'openrouter',endpointUrl:'https://example.invalid',apiKey:'synthetic',model:'test',thinking:'low'};
function fixture() {
 const p=new Phone({});
 p.base={date:1,time:0,stats:{brain:1,body:1,heart:1},charInfo:{girl:{flags:{...emptyFlags(),gaveContactInfo:true},memories:[]}},
  bunnyboard:{conversations:{girl:{charId:'girl',unread:0,summary:null,messages:[]}}}};
 p.state={playthroughId:'1',baseSaveId:'1',delta:{added:{},summaries:{},blocked:[],unread:{}}};
 p.record={chars:['girl'],playerFirstName:'Test',playerLastName:'Reader',term:{index:0}};
 p.characters.set('girl',{charId:'girl',firstName:'Alex',lastName:'Turner',likes:[],dislikes:[],traits:[],behavior:{},outfit:[],peOutfit:[],swimOutfit:[]});
 p.promptContext=(save,character)=>({save,character,roster:[],player:{firstName:'Test',lastName:'Reader',termIndex:0},season:'spring',allowedPhoto:'none',photoRequested:false});
 p.persist=async()=>{};
 return p;
}
function response(reply) { return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(reply)}}]})); }
test('watch reactions persist with observed context, sync as chat, and keep blocking rules',async()=>{
 const original=globalThis.fetch;
 try {
  const p=fixture();globalThis.fetch=async()=>response({messages:['That was funny.'],summary:'Watched a funny moment.',blocked:false});
  await p.commentOnVideo('girl','Observed: a cup tipped over.',settings,new AbortController().signal,()=>true);
  const first=p.thread('girl').messages[0];assert.equal(first.text,'That was funny.');assert.equal(first.canRegenerate,false);
  const synced=applyDelta(p.base,p.state.delta,true);
  assert.match(synced.bunnyboard.conversations.girl.messages[0].exWatchContext,/cup tipped over/);
  globalThis.fetch=async()=>response({messages:['I told you to stop harassing me.'],summary:'Set a boundary.',blocked:true});
  await p.commentOnVideo('girl','Observed: a cup tipped over.',settings,new AbortController().signal,()=>true);
  assert.equal(p.thread('girl').blocked,true);
  await assert.rejects(p.commentOnVideo('girl','anything',settings,new AbortController().signal,()=>true),/blocked/);
 } finally {globalThis.fetch=original;}
});
test('closing a watch during generation never files a late reaction and releases the conversation',async()=>{
 const original=globalThis.fetch;
 try {
  const p=fixture();let resolve;globalThis.fetch=()=>new Promise(r=>{resolve=r;});let active=true;
  const pending=p.commentOnVideo('girl','Observed: a cup tipped over.',settings,new AbortController().signal,()=>active);
  assert.equal(p.thread('girl').busy,true);
  active=false;resolve(response({messages:['Too late.'],summary:'',blocked:false}));await pending;
  assert.deepEqual(p.thread('girl').messages,[]);assert.equal(p.thread('girl').busy,false);
 } finally {globalThis.fetch=original;}
});

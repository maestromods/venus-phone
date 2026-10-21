import { after } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

export const root = await mkdtemp(path.join(os.tmpdir(), 'venus-qa-'));
process.env.VENUS_PHONE_DATA = path.join(root, 'phone');
// Tests never query a user's running game or send provider requests.
const realExec = childProcess.execFile, realFetch = globalThis.fetch;
childProcess.execFile = (file, ...args) => {
  if (file === 'tasklist') { args.at(-1)(null, ''); return; }
  return realExec(file, ...args);
};
syncBuiltinESMExports();
globalThis.fetch = async () => { throw new Error('Unexpected network request in synthetic test'); };
after(async () => {
  childProcess.execFile = realExec; syncBuiltinESMExports(); globalThis.fetch = realFetch;
  await rm(root, { recursive: true, force: true });
});
export const { Phone, applyDelta } = await import('../../dist/phone.js');
const { GameFiles } = await import('../../dist/game/files.js');
const { emptyFlags } = await import('../../dist/game/types.js');
export const settings = { provider: 'openrouter', endpointUrl: 'https://example.invalid/v1', apiKey: 'synthetic', model: 'synthetic', thinking: 'low' };
export const photosOff = { enabled: false, explicit: false };
export const answer = (text = 'Synthetic reply', extra = {}) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ messages: [text], summary: 'Synthetic recap', blocked: false, ...extra }) } }] }));
export const respond = (text, extra) => { globalThis.fetch = async () => answer(text, extra); };
export function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

let sequence = 0;
export async function fixture(mode = 'first', PhoneClass = Phone) {
  const files = new GameFiles(path.join(root, `game-${++sequence}`));
  const profile = { year: 4, dorm: 'lowrise_1', schedule: {}, major: 'History' };
  const term = { index: 1, classes: {}, occasions: [], jobClosures: {}, weather: [], before: { history: {}, playerSchedule: {}, events: [] }, chars: mode === 'alumni' ? [] : ['girl'], alumni: mode === 'alumni' ? ['girl'] : [], profiles: { girl: profile } };
  const record = { schemaVersion: 3, classes: {}, occasions: [], jobClosures: {}, weather: [], chars: ['girl'], playerFirstName: 'Synthetic', playerLastName: 'Reader', profiles: { girl: profile }, semesters: { '20': term, '21': structuredClone(term) } };
  for (const pt of ['1', '2']) {
    await mkdir(files.playthroughDir(pt), { recursive: true });
    await writeFile(path.join(files.playthroughDir(pt), 'playthrough.json'), JSON.stringify(record));
    // Schema 13 fixture includes the required 0.5.0 save/record/semester fields.
    const save = {
      money: 0, playerSchedule: {}, history: {}, events: [], job: null, jobsClosed: [], inventory: [], classRecords: {}, gradesStanding: null, expelled: false, midtermStandingDone: false, finalsScoresShown: false,
      venusThrough: -1, bunnybotThrough: -1, bunnymapUnlocked: false, bunnyshopUnlocked: false, venusJobIntroSent: false, bunnybotContactIntroSent: false, bunnybotFirstPostNudgeSent: false, bunnybotTwoTimingTipSent: false, bunnybotDeferred: [],
      droppedClasses: {}, addedClasses: {}, npcRelationships: {}, npcOverlay: null, lastSlotCast: null, weekendOutings: {}, outingSlots: {}, springBreakAway: null, feedExtras: null, graduationSeen: false, farewellsDone: [], endingArtWanted: false, scene: null,
      schemaVersion: 13, ...(mode === 'first' ? {} : { semester: '20' }), unchangedGameField: { keep: true }, exCommunityData: { keep: ['synthetic'] }, playthroughId: pt, saveId: '1', saveDate: 100, date: Number(pt), time: 0, stats: { brain: 1, body: 1, heart: 1 },
      charInfo: { girl: { nameKnown: true, flags: { ...emptyFlags(), knowsTraits: false, knowsBackstory: false, knowsLoveLife: false, gaveContactInfo: true }, memories: [] } },
      bunnyboard: { posts: ['preserved'], requestsSent: [], requestsReceived: [], contactsBadge: 0, conversations: { girl: { charId: 'girl', unread: 0, summary: null, messages: [{ id: `base-${pt}`, sender: 'contact', text: `Base ${pt}`, date: Number(pt), time: 0 }] } } },
    };
    await writeFile(files.saveFilePath(pt, '1'), JSON.stringify(save));
  }
  const charDir = path.join(files.gameDir, 'data', 'characters', 'girl');
  await mkdir(charDir, { recursive: true });
  await writeFile(path.join(charDir, 'character.json'), JSON.stringify({ firstName: 'Girl', lastName: 'Synthetic', personality: '', backstory: '', likes: [], dislikes: [], traits: [], behavior: {}, outfit: [], peOutfit: [], swimOutfit: [], baseAppearance: [] }));
  const phone = new PhoneClass(files);
  await phone.choose('1', '1', false);
  return { files, phone };
}

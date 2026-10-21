import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { root, fixture, respond, gate } from './helpers/session-fixture.mjs';
import { hashPin, clearLoginFailures, createSession, sessionCookie, admitLogin } from '../dist/security.js';
import { completeStructured, validateEndpoint } from '../dist/llm.js';

// Exercise the original routes without app startup, DPAPI or real config writes.
// The login smoke test uses a temporary loopback HTTP listener and synthetic game files.
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
let source = await readFile(path.join(dist, 'server.js'), 'utf8');
const startup = source.lastIndexOf('\nmain().catch(');
assert.ok(startup > 0);
source = source.slice(0, startup);
const configImport = 'import { decryptSecret, encryptSecret, loadConfig, saveConfig } from "./config.js";';
const tlsImport = 'import { ensureTls, localNames } from "./tls.js";';
assert.ok(source.includes(configImport) && source.includes(tlsImport));
source = source.replace(configImport, 'const decryptSecret=async v=>v??"", encryptSecret=async v=>v, loadConfig=async()=>{throw Error("Startup prohibited");}, saveConfig=async v=>{await globalThis.qaSaveConfig(v);};');
source = source.replace(tlsImport, 'const ensureTls=async()=>{throw Error("TLS startup prohibited");}, localNames=()=>({ips:["127.0.0.1","192.168.50.1"],names:["localhost"]});');
source = source.replace(/from "(\.\/[^\"]+)"/g, (_, relative) => `from "${pathToFileURL(path.join(dist, relative)).href}"`);
source += '\nexport {handle,llmSettings}; export function configure(c,p){config=c;phone=p;tls=null;calls={logout:async()=>{}};} export function getConfig(){return config;}';
const modulePath = path.join(root, 'server-under-test.mjs');
await writeFile(modulePath, source);
const { handle, llmSettings, configure, getConfig } = await import(pathToFileURL(modulePath));
const host = '192.168.50.1:8790', ip = '192.168.50.6';
const config = () => ({ pin: hashPin('123456'), port: 8790, provider: 'openrouter', endpointUrl: 'https://example.invalid/v1', openrouterKeyEnc: 'synthetic-key', geminiKeyEnc: null, openrouterModel: 'synthetic', openrouterVisionModel: '', geminiModel: 'synthetic', thinking: 'low', gameDir: '', photos: false, explicitPhotos: false, https: false });
function pending(url, body, options = {}) {
  const req = new Readable({ read() {} });
  const cookie = sessionCookie(createSession(), options.secure ?? false, options.secure ? 8791 : 8790).split(';')[0];
  req.headers = { host, origin: 'http://' + host, 'sec-fetch-site': 'same-origin', ...(options.authed ? { cookie } : {}), ...options.headers };
  let destroyed = false;
  req.socket = { remoteAddress: options.ip ?? ip, destroy() { destroyed = true; } };
  req.method = 'POST'; req.url = url;
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
  const promise = handle(req, res, options.secure ?? false).then(() => ({ ...res, destroyed }));
  return { promise, req, finish(raw) { req.push(Buffer.from(raw ?? JSON.stringify(body))); req.push(null); } };
}
async function send(url, body, options) { const p = pending(url, body, options); p.finish(); return p.promise; }

test('real HTTP login survives an old voice cookie, PIN rotation and logout use the same scoped cookie', async () => {
  const { phone, files } = await fixture();
  const server = createServer((req, res) => {
    void handle(req, res, false).catch(err => { res.writeHead(500); res.end(err.message); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  configure({ ...config(), port, gameDir: files.gameDir }, phone);
  globalThis.qaSaveConfig = async () => {};
  const exchange = (url, body, cookie = '') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: url, method: body ? 'POST' : 'GET', headers: {
      Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', Cookie: cookie,
    } }, res => {
      let raw = '';
      res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const legacy = 'vphone_voice_experiment=' + createSession();
    assert.equal((await exchange('/api/status', null, legacy)).body.authed, false);
    assert.equal((await exchange('/api/login', { pin: 'wrong' })).status, 401);
    const login = await exchange('/api/login', { pin: '123456' });
    assert.equal(login.status, 200);
    const setCookie = login.headers['set-cookie'][0];
    assert.ok(setCookie.startsWith(`vphone_http_${port}=`));
    assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\//);
    assert.doesNotMatch(setCookie, /; Secure/);
    let cookie = setCookie.split(';')[0];
    assert.equal((await exchange('/api/status', null, legacy + '; ' + cookie)).body.authed, true);
    const changed = await exchange('/api/pin', { current: '123456', next: '654321' }, cookie);
    assert.equal(changed.status, 200);
    assert.ok(changed.headers['set-cookie'][0].startsWith(`vphone_http_${port}=`));
    assert.equal((await exchange('/api/status', null, cookie)).body.authed, false);
    cookie = changed.headers['set-cookie'][0].split(';')[0];
    assert.equal((await exchange('/api/status', null, cookie)).body.authed, true);
    const logout = await exchange('/api/logout', {}, cookie);
    assert.equal(logout.status, 200);
    assert.match(logout.headers['set-cookie'][0], new RegExp(`^vphone_http_${port}=;.*Max-Age=0`));
    assert.equal((await exchange('/api/status', null, cookie)).body.authed, false);
  } finally {
    delete globalThis.qaSaveConfig;
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('provider transport rejects cleartext LAN endpoints in settings and at request time', async () => {
  configure(config()); globalThis.qaSaveConfig = async () => {};
  assert.equal((await send('/api/login', {}, { ip: '203.0.113.10' })).destroyed, true);
  assert.equal((await send('/api/login', {}, { headers: { host: 'outside.invalid:8790' } })).status, 421);
  assert.equal((await send('/api/login', {}, { headers: { origin: 'https://outside.invalid', 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await send('/api/settings', { endpointUrl: 'https://other.invalid' })).status, 401);
  assert.equal((await send('/api/settings', { openrouterKey: 'synthetic-new' }, { authed: true })).status, 403);
  const before = structuredClone(getConfig());
  for (const endpointUrl of ['http://192.168.50.123:9999/v1', 'http://example.invalid/v1', 'ftp://127.0.0.1/v1', 'https://user:pass@example.invalid/v1']) {
    const result = await send('/api/settings', { endpointUrl, openrouterModel: 'changed' }, { authed: true });
    assert.equal(result.status, 400);
    assert.deepEqual(getConfig(), before);
  }
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('No request should leave'); };
  await assert.rejects(completeStructured({ ...(await llmSettings(false)), endpointUrl: 'http://192.168.50.123/v1' }, { user: 'Synthetic', schema: { name: 'test', schema: {} } }), /https/);
  assert.equal(called, false);
  for (const endpoint of ['http://localhost:1234/v1', 'http://127.0.0.1/v1', 'http://[::1]:1234/v1', 'https://api.example.invalid/v1']) assert.ok(validateEndpoint(endpoint));
  for (const endpoint of ['http://localhost.evil.invalid', 'http://10.0.0.1', 'file:///tmp/test', 'http://[::ffff:192.168.1.2]']) assert.throws(() => validateEndpoint(endpoint));
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })); };
  await completeStructured(await llmSettings(false), { user: 'Synthetic', schema: { name: 'test', schema: {} } });
  assert.equal(requests[0].url, 'https://example.invalid/v1/chat/completions');
  assert.equal(requests[0].options.redirect, 'error');
  delete globalThis.qaSaveConfig;
});

test('slow login bodies cannot verify PINs after the fifth failure; admission and cleanup stay bounded', async () => {
  configure(config()); clearLoginFailures(ip);
  for (let i = 0; i < 4; i++) assert.equal((await send('/api/login', { pin: 'wrong' })).status, 401);
  const admitted = Array.from({ length: 12 }, () => pending('/api/login', { pin: 'wrong' }));
  const statuses = [];
  for (const request of admitted) { request.finish(); statuses.push((await request.promise).status); }
  assert.deepEqual(statuses, [401, ...Array(11).fill(429)]);
  assert.equal((await send('/api/login', { pin: '123456' })).status, 429);
  clearLoginFailures(ip);
  assert.equal((await send('/api/login', { pin: '123456' })).status, 200);
  for (let i = 0; i < 5; i++) {
    const malformed = pending('/api/login', {}); malformed.finish('{');
    assert.equal((await malformed.promise).status, 400);
    const aborted = pending('/api/login', {}); aborted.req.emit('aborted');
    assert.equal((await aborted.promise).status, 400);
  }
  assert.equal((await send('/api/login', { pin: '123456' })).status, 200);
  const reservations = Array.from({ length: 32 }, (_, i) => admitLogin('synthetic-' + i));
  assert.ok(reservations.every(Boolean)); assert.equal(admitLogin('overflow'), null);
  for (const release of reservations) { release(); release(); }
  const released = admitLogin('after-cleanup'); assert.ok(released); released();
});

test('failed or busy folder changes leave both config and phone session unchanged', async () => {
  const other = await fixture();
  const { phone, files } = await fixture();
  const initial = { ...config(), gameDir: files.gameDir };
  configure(initial, phone);
  let writes = 0;
  globalThis.qaSaveConfig = async () => { writes++; };
  await phone.deleteMessage('girl', 'base-1');
  assert.equal((await send('/api/settings', { gameDir: other.files.gameDir, openrouterModel: 'changed' }, { authed: true })).status, 409);
  assert.equal(getConfig(), initial); assert.equal(phone.files, files); assert.equal(writes, 0);
  await phone.choose('1', '1', true);
  phone.reserveVoiceCall('girl');
  assert.equal((await send('/api/settings', { gameDir: other.files.gameDir }, { authed: true })).status, 409);
  phone.releaseVoiceCall('girl');
  assert.equal(getConfig(), initial); assert.equal(phone.files, files);
  globalThis.qaSaveConfig = async () => { throw new Error('Synthetic disk failure'); };
  await assert.rejects(send('/api/settings', { gameDir: other.files.gameDir }, { authed: true }), /Synthetic disk failure/);
  assert.equal(getConfig(), initial); assert.equal(phone.files, files);
  const entered = gate(), wait = gate();
  globalThis.qaSaveConfig = async () => { entered.release(); await wait.promise; };
  const changing = send('/api/settings', { gameDir: other.files.gameDir }, { authed: true });
  await entered.promise;
  assert.equal((await send('/api/settings', { openrouterModel: 'racing' }, { authed: true })).status, 409);
  wait.release(); assert.equal((await changing).status, 200);
  assert.equal(getConfig().gameDir, other.files.gameDir); assert.equal(phone.info(), null);
  assert.equal(getConfig().openrouterModel, initial.openrouterModel);
  delete globalThis.qaSaveConfig; respond();
});

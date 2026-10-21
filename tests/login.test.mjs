import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createSession, sessionCookie, sessionOf, clearedCookie } from '../dist/security.js';

test('HTTP, HTTPS and other ports cannot overwrite each other or the legacy secure cookie', () => {
  const listeners = [[false, 8790], [true, 8791], [false, 8792], [true, 8793]];
  const cookies = listeners.map(([secure, port]) => {
    const token = createSession();
    const serialized = sessionCookie(token, secure, port);
    const name = serialized.split('=')[0];
    assert.notEqual(name, 'vphone_voice_experiment');
    assert.equal(serialized.includes('; Secure'), secure);
    assert.equal(name.startsWith('__Host-'), secure);
    assert.match(serialized, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000/);
    assert.equal(clearedCookie(secure, port).split('=')[0], name);
    assert.match(clearedCookie(secure, port), /Max-Age=0/);
    return { token, name, pair: serialized.split(';')[0] };
  });
  assert.equal(new Set(cookies.map(c => c.name)).size, 4);
  const allCookies = 'vphone_voice_experiment=stale; ' + cookies.map(c => c.pair).join('; ');
  listeners.forEach(([secure, port], i) => {
    assert.equal(sessionOf({ headers: { cookie: allCookies } }, secure, port), cookies[i].token);
    const others = cookies.filter((_, n) => n !== i).map(c => c.pair).join('; ');
    assert.equal(sessionOf({ headers: { cookie: others } }, secure, port), undefined);
  });
});

// Run the production login handler and boot function; only DOM and API responses are modeled.
const client = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = client.indexOf('async function boot(');
const end = client.indexOf('// ---- Game folder picker', start);
assert.ok(start > 0 && end > start);
function loginClient({ accepted = true, authed = true } = {}) {
  const nodes = new Map(), views = [];
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', addEventListener(event, fn) { this[event] = fn; } });
    return nodes.get(id);
  };
  const context = vm.createContext({ $, show: view => views.push(view), api: async route => {
    if (route === '/api/login') {
      if (!accepted) throw Error('Wrong PIN.');
      return { ok: true };
    }
    assert.equal(route, '/api/status');
    return { authed, gameReady: true, session: {}, hasKey: true };
  }, openContacts: () => views.push('contacts') });
  vm.runInContext(client.slice(start, end), context);
  $('pin').value = '123456';
  return { $, views, boot: () => vm.runInContext('boot()', context), submit: () => $('lock-form').submit({ preventDefault() {} }) };
}

test('accepted PIN opens contacts; blocked cookies produce an explanation instead of a silent loop', async () => {
  const works = loginClient(); await works.submit();
  assert.deepEqual(works.views, ['contacts']);
  assert.equal(works.$('pin').value, '');
  assert.equal(works.$('lock-error').textContent, '');
  const blocked = loginClient({ authed: false }); await blocked.submit();
  assert.deepEqual(blocked.views, ['lock']);
  assert.match(blocked.$('lock-error').textContent, /PIN was accepted.*Allow cookies/);
});

test('normal locked startup stays quiet and wrong PIN keeps its original error', async () => {
  const locked = loginClient({ authed: false }); await locked.boot();
  assert.deepEqual(locked.views, ['lock']);
  assert.equal(locked.$('lock-error').textContent, '');
  const wrong = loginClient({ accepted: false }); await wrong.submit();
  assert.equal(wrong.$('lock-error').textContent, 'Wrong PIN.');
});

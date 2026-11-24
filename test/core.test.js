const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML, DOMParser } = require('linkedom');
const core = require('../src/core.js');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

test('findNoticeIds: unique ids by href', () => {
  const { document } = parseHTML(fx('serp.html'));
  assert.deepStrictEqual(core.findNoticeIds(document), ['86034604', '53710240', '90331217', '34117760']);
});

test('findNoticeIds: none', () => {
  const { document } = parseHTML('<html><body><a href="https://example.com/">x</a></body></html>');
  assert.deepStrictEqual(core.findNoticeIds(document), []);
});

test('parseNotice: works, hyphens, subdomains, singular, no originals, invalid skipped', () => {
  const n = core.parseNotice(fx('notice.html'), DOMParser);
  assert.strictEqual(n.works.length, 2);
  assert.strictEqual(n.works[0].description, "The Three Musketeers: D'Artagnan");
  assert.deepStrictEqual(n.works[0].domains, [
    { domain: 'kinozal.tv', count: 18 },
    { domain: 'nnmclub.to', count: 15 },
    { domain: 'rezka-ua.pub', count: 1 },
  ]);
  assert.strictEqual(n.works[1].description, 'John Wick: Chapter 4');
  assert.deepStrictEqual(n.works[1].domains, [
    { domain: 'kinozal.tv', count: 4 },
    { domain: '1337x.unblockninja.com', count: 3 },
  ]);
  const all = n.works.flatMap((w) => w.domains.map((d) => d.domain));
  assert.ok(!all.includes('megogo.net') && !all.includes('lionsgate.com'));
});

test('parseNotice: empty list', () => {
  assert.deepStrictEqual(core.parseNotice(fx('empty.html'), DOMParser), { works: [] });
});

test('parseNotice: wildcard accepted, dotless rejected', () => {
  const html = '<li class="work"><ol><li class="infringing_url"> *.foo.com - 2 URLs </li><li class="infringing_url">localhost - 3 URLs</li></ol></li>';
  const n = core.parseNotice(html, DOMParser);
  assert.deepStrictEqual(n.works[0].domains, [{ domain: '*.foo.com', count: 2 }]);
});

test('detectGate', () => {
  assert.strictEqual(core.detectGate(fx('captcha.html'), 'https://lumendatabase.org/captcha_gateway?destination=x'), 'captcha');
  assert.strictEqual(core.detectGate('<html></html>', 'https://lumendatabase.org/captcha_gateway?destination=x'), 'captcha');
  assert.strictEqual(core.detectGate(fx('captcha.html'), 'https://lumendatabase.org/notices/1'), 'captcha');
  assert.strictEqual(core.detectGate(fx('anubis.html'), 'https://lumendatabase.org/notices/1'), 'anubis');
  assert.strictEqual(core.detectGate(fx('notice.html'), 'https://lumendatabase.org/notices/1'), null);
  assert.strictEqual(core.detectGate(fx('empty.html'), 'https://lumendatabase.org/notices/1'), null);
});

test('aggregate: sums, descriptions, sort desc', () => {
  const a = core.parseNotice(fx('notice.html'), DOMParser);
  const b = { works: [{ description: 'Other', domains: [{ domain: 'nnmclub.to', count: 10 }, { domain: 'kinozal.tv', count: 1 }] }] };
  const rows = core.aggregate([a, b]);
  assert.deepStrictEqual(rows.map((r) => [r.domain, r.count]), [
    ['kinozal.tv', 23],
    ['nnmclub.to', 25],
    ['1337x.unblockninja.com', 3],
    ['rezka-ua.pub', 1],
  ].sort((x, y) => y[1] - x[1]));
  const kz = rows.find((r) => r.domain === 'kinozal.tv');
  assert.deepStrictEqual(kz.descriptions, ["The Three Musketeers: D'Artagnan", 'John Wick: Chapter 4', 'Other']);
});

test('buildSiteSearchUrl', () => {
  const u = new URL(core.buildSiteSearchUrl({ href: 'https://www.google.co.uk/search?q=john+wick+4+download&hl=en' }, 'kinozal.tv'));
  assert.strictEqual(u.origin, 'https://www.google.co.uk');
  assert.strictEqual(u.pathname, '/search');
  assert.strictEqual(u.searchParams.get('q'), 'site:kinozal.tv john wick 4 download');
  const w = new URL(core.buildSiteSearchUrl({ href: 'https://www.google.com/search?q=x' }, '*.foo.com'));
  assert.strictEqual(w.searchParams.get('q'), 'site:foo.com x');
});

function makeEnv() {
  const { document, window } = parseHTML(fx('serp.html'));
  const store = new Map();
  const storage = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } };
  return { document, window, store, storage, location: { href: 'https://www.google.com/search?q=wick' } };
}

const base = (env, fetchNotice, extra) => ({
  document: env.document, location: env.location, fetchNotice, storage: env.storage,
  sleep: async () => {}, DOMParser, ...extra,
});

test('run: one block first in #botstuff, no duplicates', async () => {
  const env = makeEnv();
  let calls = 0;
  const fetchNotice = async () => { calls++; return { status: 200, url: 'https://lumendatabase.org/notices/1', html: fx('notice.html') }; };
  const opts = base(env, fetchNotice, { language: 'ru' });
  await core.run(opts);
  assert.strictEqual(calls, 4);
  const blocks = env.document.querySelectorAll('#' + core.BLOCK_ID);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(env.document.getElementById('botstuff').firstChild, blocks[0]);
  assert.match(blocks[0].textContent, /Загружено 4 из 4 жалоб/);
  assert.match(blocks[0].textContent, /kinozal\.tv/);
  assert.strictEqual(await core.run(opts), null);
  assert.strictEqual(env.document.querySelectorAll('#' + core.BLOCK_ID).length, 1);
});

test('run: second page load uses cache', async () => {
  const env = makeEnv();
  let calls = 0;
  const fetchNotice = async () => { calls++; return { status: 200, url: 'u', html: fx('notice.html') }; };
  await core.run(base(env, fetchNotice, { language: 'en' }));
  const env2 = makeEnv();
  env2.storage = env.storage;
  await core.run(base(env2, fetchNotice, { language: 'en' }));
  assert.strictEqual(calls, 4);
});

test('run: stops on captcha, resumes on visibilitychange', async () => {
  const env = makeEnv();
  let gated = true;
  const seen = [];
  const fetchNotice = async (id) => {
    seen.push(id);
    if (gated) return { status: 200, url: 'https://lumendatabase.org/captcha_gateway?destination=x', html: fx('captcha.html') };
    return { status: 200, url: 'https://lumendatabase.org/notices/' + id, html: fx('notice.html') };
  };
  const opened = [];
  const ctl = await core.run(base(env, fetchNotice, { language: 'en', openWindow: (u) => opened.push(u) }));
  assert.strictEqual(ctl.status, 'gate');
  assert.deepStrictEqual(seen, ['86034604']);
  const block = env.document.getElementById(core.BLOCK_ID);
  assert.match(block.textContent, /confirm you are human/);
  [...block.querySelectorAll('button')].find((b) => b.textContent === 'Open Lumen').click();
  assert.deepStrictEqual(opened, ['https://lumendatabase.org/notices/86034604']);
  gated = false;
  Object.defineProperty(env.document, 'visibilityState', { value: 'visible', configurable: true });
  env.document.dispatchEvent(new env.window.Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(ctl.status, 'done');
  assert.match(env.document.getElementById(core.BLOCK_ID).textContent, /Loaded 4 of 4/);
});

test('run: onGate fires once, retry event resumes, tab-mode text', async () => {
  const env = makeEnv();
  let gated = true;
  let gates = 0;
  const fetchNotice = async (id) => gated
    ? { status: 403, url: 'https://lumendatabase.org/captcha_gateway', html: '' }
    : { status: 200, url: 'https://lumendatabase.org/notices/' + id, html: fx('notice.html') };
  const ctl = await core.run(base(env, fetchNotice, { language: 'ru', gateMode: 'tab', onGate: () => gates++ }));
  assert.strictEqual(ctl.status, 'gate');
  assert.match(env.document.getElementById(core.BLOCK_ID).textContent, /мы вернёмся сюда сами/);
  gated = false;
  env.document.dispatchEvent(new env.window.Event('google-unlocked:retry'));
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(ctl.status, 'done');
  assert.strictEqual(gates, 1);
});

test('language: ru / uk / other, page lang beats navigator', async () => {
  assert.strictEqual(core.strings('ru-RU').retry, 'Повторить');
  assert.strictEqual(core.strings('uk-UA').retry, 'Повторити');
  assert.strictEqual(core.strings('de').retry, 'Retry');
  assert.strictEqual(core.strings('').retry, 'Retry');
  const env = makeEnv();
  env.document.documentElement.setAttribute('lang', 'ru');
  globalThis.navigator;
  const fetchNotice = async () => ({ status: 200, url: 'u', html: fx('empty.html') });
  await core.run(base(env, fetchNotice, {}));
  assert.match(env.document.getElementById(core.BLOCK_ID).textContent, /Загружено 4 из 4/);
});

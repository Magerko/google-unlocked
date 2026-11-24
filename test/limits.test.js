const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML, DOMParser } = require('linkedom');
const core = require('../src/core.js');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const jsonFixture = () => JSON.parse(fx('notice.json'));
const at = (iso) => Date.parse(iso);

function makeEnv() {
  const { document, window } = parseHTML(fx('serp.html'));
  const store = new Map();
  const storage = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } };
  return { document, window, storage, location: { href: 'https://www.google.com/search?q=wick' } };
}
const base = (env, fetchNotice, extra) => ({
  document: env.document, location: env.location, fetchNotice, storage: env.storage,
  sleep: async () => {}, DOMParser, ...extra,
});

test('budgetCheck: minute boundary (9 allowed per minute)', () => {
  const now = at('2026-11-25T10:30:30Z');
  const minuteStart = at('2026-11-25T10:30:00Z');
  const eight = Array.from({ length: 8 }, (_, i) => minuteStart + i * 1000);
  assert.deepStrictEqual(core.budgetCheck(eight, now, 0), { ok: true });
  const nine = [...eight, minuteStart + 9000];
  assert.deepStrictEqual(core.budgetCheck(nine, now, 0), { limited: 'minute', resumeAt: minuteStart + 60000 + 2000 });
  const old = Array.from({ length: 9 }, (_, i) => minuteStart - 1000 - i);
  assert.deepStrictEqual(core.budgetCheck(old, now, 0), { ok: true });
  assert.deepStrictEqual(core.budgetCheck(nine, minuteStart + 60000, 0), { ok: true });
});

test('budgetCheck: hour boundary (28 allowed per UTC hour)', () => {
  const hourStart = at('2026-11-25T10:00:00Z');
  const now = at('2026-11-25T10:50:10Z');
  const spread = (n, b) => Array.from({ length: n }, (_, i) => b + i * 60000);
  assert.deepStrictEqual(core.budgetCheck(spread(27, hourStart), now, 0), { ok: true });
  assert.deepStrictEqual(core.budgetCheck(spread(28, hourStart), now, 0), { limited: 'hour', resumeAt: hourStart + 3600000 + 2000 });
  assert.deepStrictEqual(core.budgetCheck(spread(28, hourStart - 3600000), now, 0), { ok: true });
});

test('budgetCheck: blockedUntil after a real 429, and token limits', () => {
  const now = at('2026-11-25T10:50:10Z');
  const until = core.nextHourStart(now);
  assert.strictEqual(until, at('2026-11-25T11:00:00Z'));
  assert.deepStrictEqual(core.budgetCheck([], now, until), { limited: 'hour', resumeAt: until });
  assert.deepStrictEqual(core.budgetCheck([], until, until), { ok: true });
  const minuteStart = at('2026-11-25T10:50:00Z');
  const many = Array.from({ length: 54 }, (_, i) => minuteStart + i);
  assert.deepStrictEqual(core.budgetCheck(many, now, 0, core.LIMITS_TOKEN), { ok: true });
  assert.strictEqual(core.budgetCheck([...many, minuteStart + 60], now, 0, core.LIMITS_TOKEN).limited, 'minute');
  const lots = Array.from({ length: 500 }, (_, i) => minuteStart - i * 1000);
  assert.deepStrictEqual(core.budgetCheck(lots, now, 0, core.LIMITS_TOKEN), { ok: true });
});

test('run: limited shows time, cached complaints stay visible, auto-resumes at resumeAt', async () => {
  const env = makeEnv();
  await env.storage.set('gu:notice:34117760', { t: Date.now(), data: core.parseNotice(fx('notice.html'), DOMParser) });
  let limited = true;
  const seen = [];
  const fetchNotice = async (id) => {
    seen.push(id);
    if (limited) return { limited: 'hour', resumeAt: 5000000 };
    return { status: 200, url: 'u', html: fx('notice.html') };
  };
  const timers = [];
  const ctl = await core.run(base(env, fetchNotice, {
    language: 'en', now: () => 1000000, formatTime: () => '12:34',
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return 0; },
  }));
  assert.strictEqual(ctl.status, 'limited');
  const text = env.document.getElementById(core.BLOCK_ID).textContent;
  assert.match(text, /continue at 12:34/);
  assert.match(text, /Loaded 1 of 4/);
  assert.match(text, /kinozal\.tv/);
  assert.deepStrictEqual(seen, ['86034604']);
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 4000000);
  limited = false;
  timers[0].fn();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(ctl.status, 'done');
  assert.match(env.document.getElementById(core.BLOCK_ID).textContent, /Loaded 4 of 4/);
});

test('run: real 429 waits for the next UTC hour', async () => {
  const env = makeEnv();
  const timers = [];
  const now = at('2026-11-25T10:50:10Z');
  const ctl = await core.run(base(env, async () => ({ status: 429, url: 'u', html: 'Please wait' }), {
    language: 'en', now: () => now, setTimer: (fn, ms) => { timers.push(ms); return 0; },
  }));
  assert.strictEqual(ctl.status, 'limited');
  assert.deepStrictEqual(timers, [at('2026-11-25T11:00:00Z') - now]);
});

test('parseNoticeJson: groups by hostname, full URLs, http(s) only, cap 50', () => {
  const n = core.parseNoticeJson(jsonFixture());
  assert.strictEqual(n.works.length, 2);
  const d = Object.fromEntries(n.works[0].domains.map((x) => [x.domain, x]));
  assert.strictEqual(d['kinozal.tv'].count, 4);
  assert.deepStrictEqual(d['kinozal.tv'].urls, ['http://kinozal.tv/details.php?id=1', 'https://kinozal.tv/details.php?id=2', 'https://kinozal.tv/details.php?id=3']);
  assert.ok(d['rezka-ua.pub'] && d['1337x.unblockninja.com']);
  assert.ok(!Object.keys(d).some((k) => /example|javascript|ftp/.test(k)));
  assert.strictEqual(n.works[0].description, 'Film A');
  const many = n.works[1].domains[0];
  assert.strictEqual(many.count, 60);
  assert.strictEqual(many.urls.length, 50);
  assert.deepStrictEqual(core.parseNoticeJson({ foo: 1 }), { works: [] });
});

test('run: JSON (token) result is parsed and URLs expand on click', async () => {
  const env = makeEnv();
  const fetchNotice = async () => ({ status: 200, url: 'u', json: jsonFixture() });
  await core.run(base(env, fetchNotice, { language: 'en' }));
  const block = env.document.getElementById(core.BLOCK_ID);
  assert.ok(!block.querySelector('a[href="http://kinozal.tv/details.php?id=1"]'));
  [...block.querySelectorAll('li')].find((li) => li.textContent.startsWith('kinozal.tv')).querySelector('button').click();
  const link = env.document.querySelector('a[href="http://kinozal.tv/details.php?id=1"]');
  assert.ok(link);
  assert.strictEqual(link.getAttribute('rel'), 'noopener noreferrer');
  const rows = core.aggregate([core.parseNoticeJson(jsonFixture()), core.parseNoticeJson(jsonFixture())]);
  assert.ok(rows.every((r) => r.urls.length <= 50));
});

test('run: tokenRejected note is shown', async () => {
  const env = makeEnv();
  const fetchNotice = async () => ({ status: 200, url: 'u', html: fx('notice.html'), tokenRejected: true });
  await core.run(base(env, fetchNotice, { language: 'en' }));
  assert.match(env.document.getElementById(core.BLOCK_ID).textContent, /token was rejected/);
});

test('run: 404 is "unavailable" and cached empty; other failures are marked and not cached', async () => {
  const env = makeEnv();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let calls = 0;
  const fetchNotice = async (id) => {
    calls++;
    if (id === '86034604') return { status: 404, url: 'https://lumendatabase.org/notices/86034604', html: 'Not found' };
    if (id === '53710240') return { status: 500, url: 'https://lumendatabase.org/notices/53710240', html: '<h1>Oops</h1> broken' };
    if (id === '90331217') throw new Error('boom');
    return { status: 200, url: 'u', html: fx('notice.html') };
  };
  try {
    await core.run(base(env, fetchNotice, { language: 'en' }));
  } finally {
    console.warn = origWarn;
  }
  const block = env.document.getElementById(core.BLOCK_ID);
  assert.match(block.textContent, /Loaded 1 of 4 complaints. Unavailable: 1. Failed to load: 2/);
  const link = (id) => [...block.querySelectorAll('a')].find((a) => a.textContent.startsWith('#' + id));
  assert.match(link('86034604').getAttribute('title'), /unavailable/);
  assert.strictEqual(link('53710240').getAttribute('title'), 'HTTP 500');
  assert.strictEqual(link('90331217').getAttribute('title'), 'error: boom');
  assert.strictEqual(link('34117760').getAttribute('title'), null);
  assert.ok(link('53710240').textContent.endsWith('✕'));
  assert.ok(warns.some((w) => w.includes('53710240') && w.includes('HTTP 500') && w.includes('Oops broken')));
  assert.ok(warns.some((w) => w.includes('90331217') && w.includes('boom')));
  // Second page load: the 404 comes from the cache, failures are requested again.
  const env2 = makeEnv();
  env2.storage = env.storage;
  const seen = [];
  const f2 = async (id) => { seen.push(id); return { status: 200, url: 'u', html: fx('notice.html') }; };
  await core.run(base(env2, f2, { language: 'en' }));
  assert.deepStrictEqual(seen.sort(), ['53710240', '90331217']);
  assert.match(env2.document.getElementById(core.BLOCK_ID).textContent, /Unavailable: 1/);
});

const api = globalThis.browser ?? chrome;
// Chrome loads core.js here; Firefox lists it before background.js in the manifest.
if (typeof importScripts === "function") importScripts("core.js", "captcha-background.js");
const GU = globalThis.GoogleUnlocked;

const LUMEN = 'https://lumendatabase.org/';
const LOAD_TIMEOUT_MS = 20000;
const IDLE_CLOSE_MS = 20000;

// The service worker can be killed at any time, so state lives in storage.session
// (with an in-memory fallback if a browser lacks it).
let memState = {};
const sess = api.storage && api.storage.session;
async function loadState() {
  if (!sess) return memState;
  const o = await sess.get('state');
  return o.state || {};
}
async function saveState(s) {
  if (!sess) memState = s;
  else await sess.set({ state: s });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isCaptchaUrl = (u) => /\/captcha_gateway/i.test(u || '');
const isAnubisTitle = (t) => /not a bot/i.test(t || '');

async function getTab(id) {
  try {
    return await api.tabs.get(id);
  } catch (e) {
    return null;
  }
}

async function tabTitle(tabId) {
  try {
    const [r] = await api.scripting.executeScript({ target: { tabId }, func: () => document.title });
    return r && r.result;
  } catch (e) {
    console.warn('[Google Unlocked] title probe failed on tab', tabId, String((e && e.message) || e));
    return '';
  }
}

// Resolves when the tab reports "complete" or the time runs out.
function waitComplete(tabId, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      api.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, ms);
    api.tabs.onUpdated.addListener(onUpdated);
    getTab(tabId).then((t) => {
      if (!t || t.status === 'complete') finish();
    });
  });
}

// Anubis is a proof-of-work page that the browser solves by itself, so I wait for it to navigate away.
async function settle(tabId) {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await waitComplete(tabId, Math.max(0, deadline - Date.now()));
    const tab = await getTab(tabId);
    if (!tab) return 'gone';
    if (isCaptchaUrl(tab.url)) return 'captcha';
    if (!isAnubisTitle(await tabTitle(tabId))) return 'ok';
    await sleep(500);
  }
  return 'anubis';
}

async function getLumenTab(sender) {
  const state = await loadState();
  const tabs = await api.tabs.query({ url: LUMEN + '*' });
  let tab = tabs.find((t) => t.id === state.ownedTabId) || tabs[0];
  if (state.ownedTabId && !tabs.some((t) => t.id === state.ownedTabId)) delete state.ownedTabId;
  if (!tab) {
    // pages/about is outside Lumen's notices/search rate limit.
    const props = { url: LUMEN + 'pages/about', active: false };
    if (sender.tab) {
      props.windowId = sender.tab.windowId;
      props.index = sender.tab.index + 1;
    }
    tab = await api.tabs.create(props);
    state.ownedTabId = tab.id;
  }
  await saveState(state);
  return tab.id;
}

async function addWaiter(lumenTabId, sender) {
  const state = await loadState();
  if (!state.waiting || state.waiting.lumenTabId !== lumenTabId) state.waiting = { lumenTabId, requesters: [] };
  if (sender.tab) {
    state.waiting.requesters = state.waiting.requesters.filter((r) => r.tabId !== sender.tab.id);
    state.waiting.requesters.push({ tabId: sender.tab.id, windowId: sender.tab.windowId });
  }
  await saveState(state);
}

async function pageFetch(tabId, id) {
  const [r] = await api.scripting.executeScript({
    target: { tabId },
    func: async (nid) => {
      const res = await fetch('/notices/' + nid, { credentials: 'include' });
      return { status: res.status, url: res.url, html: await res.text() };
    },
    args: [id],
  });
  if (!r || !r.result) {
    console.warn('[Google Unlocked] notice', id, 'executeScript returned no result');
    throw new Error('no result from tab');
  }
  return r.result;
}

const titleOf = (html) => ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');

const MAX_MINUTE_WAIT_MS = 25000;
const HOUR_MS = 3600000;

async function getBudget(key) {
  const o = await api.storage.local.get(key);
  return o[key] || { stamps: [], blockedUntil: 0 };
}

function freshStamps(b, now) {
  return b.stamps.filter((t) => t > now - HOUR_MS);
}

// Checks the budget without spending it.
async function peekBudget(key, limits) {
  const b = await getBudget(key);
  const now = Date.now();
  return GU.budgetCheck(freshStamps(b, now), now, b.blockedUntil, limits);
}

// Spends one request. Short minute waits are done here, long ones are handed back to the page.
async function reserve(key, limits) {
  for (;;) {
    const b = await getBudget(key);
    const now = Date.now();
    b.stamps = freshStamps(b, now);
    const v = GU.budgetCheck(b.stamps, now, b.blockedUntil, limits);
    if (v.ok) {
      b.stamps.push(now);
      await api.storage.local.set({ [key]: b });
      return v;
    }
    if (v.limited === 'minute' && v.resumeAt - now <= MAX_MINUTE_WAIT_MS) {
      await sleep(v.resumeAt - now);
      continue;
    }
    return v;
  }
}

async function recordStamp(key) {
  const b = await getBudget(key);
  const now = Date.now();
  b.stamps = freshStamps(b, now);
  b.stamps.push(now);
  await api.storage.local.set({ [key]: b });
}

async function blockUntilNextHour() {
  const b = await getBudget('lumenBudget');
  b.blockedUntil = GU.nextHourStart(Date.now());
  await api.storage.local.set({ lumenBudget: b });
  return { limited: 'hour', resumeAt: b.blockedUntil };
}

async function toCaptcha(tabId, url) {
  const tab = await getTab(tabId);
  // Every captcha pass counts against Lumen's own limit, so I never re-navigate a tab that is already there.
  if (tab && !isCaptchaUrl(tab.url) && url.startsWith(LUMEN)) await api.tabs.update(tabId, { url });
}

async function loadViaTab(id, sender) {
  const pre = await peekBudget('lumenBudget');
  if (pre.limited === 'hour') return pre;
  const tabId = await getLumenTab(sender);
  let st = await settle(tabId);
  if (st === 'gone') {
    console.warn('[Google Unlocked] notice', id, 'Lumen tab was closed');
    throw new Error('Lumen tab was closed');
  }
  for (let attempt = 0; st === 'ok' && attempt < 2; attempt++) {
    const v = await reserve('lumenBudget');
    if (v.limited) return v;
    const res = await pageFetch(tabId, id);
    if (isCaptchaUrl(res.url)) {
      await toCaptcha(tabId, res.url);
      st = 'captcha';
      break;
    }
    if (isAnubisTitle(titleOf(res.html))) {
      // A normal navigation lets the browser solve Anubis; this page is outside the notices limit.
      await api.tabs.update(tabId, { url: LUMEN + 'pages/about' });
      st = await settle(tabId);
      continue;
    }
    if (res.status === 429) return blockUntilNextHour();
    return res;
  }
  await addWaiter(tabId, sender);
  return { gate: st === 'ok' ? 'anubis' : st, lumenTabId: tabId };
}

async function loadViaToken(id, token) {
  const v = await reserve('tokenBudget', GU.LIMITS_TOKEN);
  if (v.limited) return v;
  const res = await fetch(LUMEN + 'notices/' + id + '.json', {
    credentials: 'omit',
    headers: { 'X-Authentication-Token': token, Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) return { rejected: true };
  if (res.status === 429) return { limited: 'minute', resumeAt: (Math.floor(Date.now() / 60000) + 1) * 60000 + 2000 };
  if (!res.ok) return { status: res.status, url: res.url, html: '' };
  return { status: 200, url: res.url, json: await res.json() };
}

async function loadNotice(id, sender) {
  const cfg = await api.storage.local.get(['lumenToken', 'tokenRejected']);
  const token = (cfg.lumenToken || '').trim();
  if (token && !cfg.tokenRejected) {
    const r = await loadViaToken(id, token);
    if (!r.rejected) return r;
    await api.storage.local.set({ tokenRejected: true });
  }
  const r = await loadViaTab(id, sender);
  if (token) r.tokenRejected = true;
  return r;
}

// Requests go through the tab strictly one after another.
let chain = Promise.resolve();
let closeTimer = null;

function enqueue(id, sender) {
  const job = chain.then(() => loadNotice(id, sender));
  job.catch((e) => console.warn('[Google Unlocked] notice', id, String((e && e.message) || e)));
  chain = job.catch(() => {});
  job.finally(scheduleClose).catch(() => {});
  return job;
}

function scheduleClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(maybeClose, IDLE_CLOSE_MS);
}

async function maybeClose() {
  const state = await loadState();
  if (!state.ownedTabId) return;
  const tab = await getTab(state.ownedTabId);
  if (!tab) {
    delete state.ownedTabId;
    await saveState(state);
    return;
  }
  if (tab.active || isCaptchaUrl(tab.url) || (state.waiting && state.waiting.lumenTabId === tab.id)) {
    scheduleClose();
    return;
  }
  delete state.ownedTabId;
  await saveState(state);
  try {
    await api.tabs.remove(tab.id);
  } catch (e) { /* already gone */ }
}

async function focusTab(tabId, windowId) {
  const tab = await getTab(tabId);
  if (!tab) return false;
  await api.tabs.update(tabId, { active: true });
  await api.windows.update(windowId !== undefined ? windowId : tab.windowId, { focused: true });
  return true;
}

async function openLumen() {
  const state = await loadState();
  let tabId = state.waiting && state.waiting.lumenTabId;
  if (!tabId || !(await getTab(tabId))) {
    const tabs = await api.tabs.query({ url: LUMEN + '*' });
    tabId = tabs.length ? tabs[0].id : null;
  }
  if (tabId == null) return { ok: false };
  return { ok: await focusTab(tabId) };
}

async function onLumenTabUpdated(tabId, info, tab) {
  if (info.status !== 'complete') return;
  const state = await loadState();
  const w = state.waiting;
  if (!w || w.lumenTabId !== tabId || isCaptchaUrl(tab.url)) return;
  if (isAnubisTitle(await tabTitle(tabId))) return;
  delete state.waiting;
  await saveState(state);
  // The browser itself loaded the captcha destination, which is usually a notices page.
  if (/^\/(notices|search)/.test(new URL(tab.url).pathname)) await recordStamp('lumenBudget');
  const last = w.requesters[w.requesters.length - 1];
  if (last) await focusTab(last.tabId, last.windowId).catch(() => {});
  for (const r of w.requesters) {
    api.tabs.sendMessage(r.tabId, { type: 'lumenReady' }).catch(() => {});
  }
  scheduleClose();
}

api.tabs.onUpdated.addListener((tabId, info, tab) => {
  onLumenTabUpdated(tabId, info, tab).catch(() => {});
});

api.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadState();
  let changed = false;
  if (state.ownedTabId === tabId) {
    delete state.ownedTabId;
    changed = true;
  }
  if (state.waiting && state.waiting.lumenTabId === tabId) {
    delete state.waiting;
    changed = true;
  }
  if (changed) await saveState(state);
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'openLumen') {
    openLumen().then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type !== 'fetchNotice') return false;
  // Only digits are allowed so this can never become an open proxy.
  if (typeof msg.id !== 'string' || !/^\d+$/.test(msg.id)) {
    sendResponse({ error: 'bad id' });
    return false;
  }
  enqueue(msg.id, sender).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});

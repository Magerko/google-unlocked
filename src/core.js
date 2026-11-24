(function () {
  'use strict';

  const BLOCK_ID = 'google-unlocked-block';
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const CACHE_PREFIX = 'gu:notice:';
  const COLLAPSED_LIMIT = 30;
  const NOTICE_HREF = /lumendatabase\.org\/notices\/(\d+)/i;
  const LINE_RE = /^(.+?)\s+-\s+(\d+)\s+URLs?$/i;
  // Letters/digits/hyphens in dot-separated labels, optional leading "*.", at least one dot.
  const DOMAIN_RE = /^(\*\.)?[\p{L}\p{N}]([\p{L}\p{N}-]*[\p{L}\p{N}])?(\.[\p{L}\p{N}]([\p{L}\p{N}-]*[\p{L}\p{N}])?)+$/u;

  const STRINGS = {
    ru: {
      title: 'Сайты, удалённые из выдачи по жалобам DMCA',
      progress: (k, n) => `Загружено ${k} из ${n} жалоб`,
      failed: (f) => `Не удалось загрузить: ${f}`,
      unavailable: (n) => `Недоступно: ${n}`,
      reasonError: (m) => `ошибка: ${m}`,
      reasonGone: 'недоступна (удалена или скрыта в Lumen)',
      urls: (n) => `${n} URL`,
      search: 'искать на сайте',
      complaints: 'Жалобы:',
      empty: 'В загруженных жалобах доменов не найдено.',
      gate: 'Lumen просит подтвердить, что вы человек. Откройте Lumen, пройдите проверку (достаточно один раз за сессию) и вернитесь на эту вкладку.',
      gateTab: 'Открыли вкладку Lumen — пройдите проверку, мы вернёмся сюда сами.',
      limited: (time) => `Лимит Lumen: продолжим в ${time}`,
      tokenRejected: 'Токен Lumen не принят, работаем без него.',
      open: 'Открыть Lumen',
      retry: 'Повторить',
      showAll: (n) => `Показать все (${n})`,
      showLess: 'Свернуть',
    },
    uk: {
      title: 'Сайти, видалені з видачі за скаргами DMCA',
      progress: (k, n) => `Завантажено ${k} з ${n} скарг`,
      failed: (f) => `Не вдалося завантажити: ${f}`,
      unavailable: (n) => `Недоступно: ${n}`,
      reasonError: (m) => `помилка: ${m}`,
      reasonGone: 'недоступна (видалена або прихована в Lumen)',
      urls: (n) => `${n} URL`,
      search: 'шукати на сайті',
      complaints: 'Скарги:',
      empty: 'У завантажених скаргах доменів не знайдено.',
      gate: 'Lumen просить підтвердити, що ви людина. Відкрийте Lumen, пройдіть перевірку (достатньо один раз за сесію) і поверніться на цю вкладку.',
      gateTab: 'Відкрили вкладку Lumen — пройдіть перевірку, ми повернемося сюди самі.',
      limited: (time) => `Ліміт Lumen: продовжимо о ${time}`,
      tokenRejected: 'Токен Lumen не прийнято, працюємо без нього.',
      open: 'Відкрити Lumen',
      retry: 'Повторити',
      showAll: (n) => `Показати всі (${n})`,
      showLess: 'Згорнути',
    },
    en: {
      title: 'Sites removed from results by DMCA complaints',
      progress: (k, n) => `Loaded ${k} of ${n} complaints`,
      failed: (f) => `Failed to load: ${f}`,
      unavailable: (n) => `Unavailable: ${n}`,
      reasonError: (m) => `error: ${m}`,
      reasonGone: 'unavailable (removed or hidden in Lumen)',
      urls: (n) => `${n} URL${n === 1 ? '' : 's'}`,
      search: 'search this site',
      complaints: 'Complaints:',
      empty: 'No domains found in the loaded complaints.',
      gate: 'Lumen asks you to confirm you are human. Open Lumen, pass the check (once per session is enough) and come back to this tab.',
      gateTab: 'We opened a Lumen tab: pass the check there and we will bring you back here.',
      limited: (time) => `Lumen limit reached: we will continue at ${time}`,
      tokenRejected: 'Lumen token was rejected, working without it.',
      open: 'Open Lumen',
      retry: 'Retry',
      showAll: (n) => `Show all (${n})`,
      showLess: 'Show less',
    },
  };

  const MINUTE = 60000;
  const HOUR = 3600000;
  // Lumen allows 10/min and 30/h for anonymous notices/search paths; I keep a margin for manual browsing.
  const LIMITS_ANON = { minute: 9, hour: 28 };
  const LIMITS_TOKEN = { minute: 55, hour: Infinity };
  const MAX_URLS_PER_DOMAIN = 50;

  function nextHourStart(now) {
    return (Math.floor(now / HOUR) + 1) * HOUR;
  }

  // Lumen uses fixed windows aligned to the UTC epoch, so I count stamps inside the current minute/hour.
  function budgetCheck(stamps, now, blockedUntil, limits) {
    const lim = limits || LIMITS_ANON;
    if (blockedUntil && blockedUntil > now) return { limited: 'hour', resumeAt: blockedUntil };
    const hourStart = Math.floor(now / HOUR) * HOUR;
    const minuteStart = Math.floor(now / MINUTE) * MINUTE;
    let inHour = 0;
    let inMinute = 0;
    for (const t of stamps) {
      if (t >= hourStart) inHour++;
      if (t >= minuteStart) inMinute++;
    }
    if (inHour >= lim.hour) return { limited: 'hour', resumeAt: hourStart + HOUR + 2000 };
    if (inMinute >= lim.minute) return { limited: 'minute', resumeAt: minuteStart + MINUTE + 2000 };
    return { ok: true };
  }

  function parseNoticeJson(json) {
    let root = json && json.works ? json : null;
    if (!root && json && typeof json === 'object') {
      root = Object.values(json).find((v) => v && typeof v === 'object' && Array.isArray(v.works)) || null;
    }
    const works = [];
    for (const w of (root && root.works) || []) {
      const byHost = new Map();
      for (const item of w.infringing_urls || []) {
        const raw = typeof item === 'string' ? item : item && item.url;
        let u;
        try {
          u = new URL(String(raw).trim());
        } catch (e) {
          continue;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        u.hash = '';
        const domain = u.hostname.toLowerCase();
        if (!isValidDomain(domain)) continue;
        let e = byHost.get(domain);
        if (!e) {
          e = { domain, count: 0, urls: [] };
          byHost.set(domain, e);
        }
        e.count++;
        if (e.urls.length < MAX_URLS_PER_DOMAIN && !e.urls.includes(u.href)) e.urls.push(u.href);
      }
      works.push({ description: String(w.description || '').replace(/\s+/g, ' ').trim(), domains: [...byHost.values()] });
    }
    return { works };
  }

  function strings(lang) {
    const l = String(lang || '').toLowerCase();
    if (l.startsWith('ru')) return STRINGS.ru;
    if (l.startsWith('uk')) return STRINGS.uk;
    return STRINGS.en;
  }

  function findNoticeIds(doc) {
    const seen = new Set();
    const out = [];
    for (const a of doc.querySelectorAll('a[href*="lumendatabase.org/notices/"]')) {
      const m = NOTICE_HREF.exec(a.getAttribute('href') || '');
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
    return out;
  }

  function detectGate(html, finalUrl) {
    const text = String(html || '');
    if (/\/captcha_gateway/i.test(String(finalUrl || '')) || /<form[^>]+action=["']\/captcha_gateway/i.test(text)) {
      return 'captcha';
    }
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    const looksLikeNotice = /class="[^"]*\bwork\b/.test(text);
    if ((title && /not a bot/i.test(title[1])) || (/anubis/i.test(text) && !looksLikeNotice)) {
      return 'anubis';
    }
    return null;
  }

  function isValidDomain(d) {
    return d.length <= 253 && DOMAIN_RE.test(d);
  }

  function parseNotice(html, DOMParserCtor) {
    const doc = new DOMParserCtor().parseFromString(String(html), 'text/html');
    const works = [];
    for (const li of doc.querySelectorAll('li.work')) {
      const descEl = li.querySelector('.description .field');
      const description = descEl ? descEl.textContent.replace(/\s+/g, ' ').trim() : '';
      const domains = [];
      for (const item of li.querySelectorAll('li.infringing_url')) {
        const m = LINE_RE.exec(item.textContent.trim());
        if (!m) continue;
        const domain = m[1].trim().toLowerCase();
        if (!isValidDomain(domain)) continue;
        domains.push({ domain, count: parseInt(m[2], 10) });
      }
      works.push({ description, domains });
    }
    return { works };
  }

  function aggregate(results) {
    const map = new Map();
    for (const notice of results) {
      if (!notice || !notice.works) continue;
      for (const work of notice.works) {
        for (const { domain, count, urls } of work.domains) {
          let e = map.get(domain);
          if (!e) {
            e = { domain, count: 0, descriptions: [], urls: [] };
            map.set(domain, e);
          }
          e.count += count;
          for (const u of urls || []) {
            if (e.urls.length < MAX_URLS_PER_DOMAIN && !e.urls.includes(u)) e.urls.push(u);
          }
          if (work.description && !e.descriptions.includes(work.description)) {
            e.descriptions.push(work.description);
          }
        }
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  }

  function bareDomain(domain) {
    return domain.replace(/^\*\./, '');
  }

  function buildSiteSearchUrl(loc, domain) {
    const base = new URL(loc.href);
    const q = base.searchParams.get('q') || '';
    const url = new URL('/search', base.origin);
    url.searchParams.set('q', ('site:' + bareDomain(domain) + ' ' + q).trim());
    return url.href;
  }

  function el(doc, tag, props, children) {
    const e = doc.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        if (k === 'style') e.setAttribute('style', props[k]);
        else if (k === 'text') e.textContent = props[k];
        else e.setAttribute(k, props[k]);
      }
    }
    for (const c of children || []) e.appendChild(c);
    return e;
  }

  const BORDER = '1px solid color-mix(in srgb, currentColor 25%, transparent)';
  const MUTED = 'opacity:.7;';

  function findInsertion(doc) {
    const botstuff = doc.getElementById('botstuff');
    if (botstuff) return { parent: botstuff, before: botstuff.firstChild };
    const link = doc.querySelector('a[href*="lumendatabase.org/notices/"]');
    if (link) {
      let node = link.closest('div') || link;
      while (node.parentElement && node.parentElement !== doc.body && node.parentElement.children.length === 1) {
        node = node.parentElement;
      }
      if (node.parentNode) return { parent: node.parentNode, before: node };
    }
    return { parent: doc.getElementById('search') || doc.body, before: null };
  }

  async function run(opts) {
    const doc = opts.document;
    const loc = opts.location;
    const { fetchNotice, storage } = opts;
    const pageLang = doc.documentElement && doc.documentElement.getAttribute('lang');
    const t = strings(opts.language !== undefined ? opts.language : (pageLang || (typeof navigator !== 'undefined' ? navigator.language : '')));
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = opts.now || (() => Date.now());
    const delayMs = opts.delayMs !== undefined ? opts.delayMs : 2500;
    const DP = opts.DOMParser || globalThis.DOMParser;

    if (doc.getElementById(BLOCK_ID)) return null;

    const ids = [];
    const results = new Map();
    const failed = new Map();
    const unavailable = new Set();
    let status = 'idle'; // idle | loading | done | gate | rate
    let pumping = false;
    let expanded = false;
    let block = null;
    let observer = null;
    let gateAnnounced = false;
    let limitedUntil = 0;
    let limitTimer = null;
    let tokenRejected = false;
    const cacheChecked = new Set();
    const openDomains = new Set();
    const formatTime = opts.formatTime || ((ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));

    async function readCache(id) {
      try {
        const rec = await storage.get(CACHE_PREFIX + id);
        if (rec && rec.data && now() - rec.t < CACHE_TTL_MS) return rec.data;
      } catch (e) { /* cache is optional */ }
      return null;
    }

    async function writeCache(id, data) {
      try {
        await storage.set(CACHE_PREFIX + id, { t: now(), data });
      } catch (e) { /* cache is optional */ }
    }

    function firstPendingId() {
      return ids.find((id) => !results.has(id));
    }

    function noticeUrl(id) {
      return 'https://lumendatabase.org/notices/' + id;
    }

    function button(label, onClick) {
      const b = el(doc, 'button', {
        type: 'button',
        text: label,
        style: 'cursor:pointer;color:inherit;background:color-mix(in srgb, currentColor 10%, transparent);border:' + BORDER + ';border-radius:6px;padding:4px 10px;margin:6px 8px 0 0;font:inherit;',
      });
      b.addEventListener('click', onClick);
      return b;
    }

    function render() {
      if (!block) {
        block = el(doc, 'div', {
          id: BLOCK_ID,
          style: 'color:inherit;border:' + BORDER + ';border-radius:8px;padding:12px 16px;margin:12px 0;font-size:14px;line-height:1.5;',
        });
        const pos = findInsertion(doc);
        pos.parent.insertBefore(block, pos.before);
      }
      while (block.firstChild) block.removeChild(block.firstChild);

      block.appendChild(el(doc, 'div', { style: 'font-weight:600;font-size:16px;margin-bottom:4px;', text: t.title }));

      let progress = t.progress(results.size - unavailable.size, ids.length);
      if (unavailable.size) progress += '. ' + t.unavailable(unavailable.size);
      if (failed.size) progress += '. ' + t.failed(failed.size);
      block.appendChild(el(doc, 'div', { style: MUTED + 'margin-bottom:8px;', text: progress }));

      if (tokenRejected) {
        block.appendChild(el(doc, 'div', { style: MUTED + 'margin-bottom:8px;', text: t.tokenRejected }));
      }

      if (status === 'gate' || status === 'limited') {
        const box = el(doc, 'div', { style: 'border:' + BORDER + ';border-radius:6px;padding:8px 12px;margin-bottom:8px;' });
        box.appendChild(el(doc, 'div', { text: status === 'gate' ? (opts.gateMode === 'tab' ? t.gateTab : t.gate) : t.limited(formatTime(limitedUntil)) }));
        if (status === 'gate') {
          box.appendChild(button(t.open, () => {
            const id = firstPendingId() || ids[0];
            if (id) opts.openWindow ? opts.openWindow(noticeUrl(id)) : doc.defaultView.open(noticeUrl(id), '_blank', 'noopener,noreferrer');
          }));
        }
        box.appendChild(button(t.retry, retry));
        block.appendChild(box);
      }

      const rows = aggregate(ids.map((id) => results.get(id)).filter(Boolean));
      if (!rows.length && status === 'done') {
        block.appendChild(el(doc, 'div', { style: MUTED, text: t.empty }));
      }
      const shown = expanded ? rows : rows.slice(0, COLLAPSED_LIMIT);
      const list = el(doc, 'ul', { style: 'list-style:none;margin:0;padding:0;' });
      for (const row of shown) {
        const li = el(doc, 'li', { style: 'display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;padding:2px 0;' });
        const href = 'https://' + bareDomain(row.domain) + '/';
        const a = el(doc, 'a', { href, target: '_blank', rel: 'noopener noreferrer', style: 'color:inherit;font-weight:600;text-decoration:underline;', text: row.domain });
        if (row.descriptions.length) a.setAttribute('title', row.descriptions.slice(0, 10).join('\n'));
        li.appendChild(a);
        if (row.urls.length) {
          const toggle = button(t.urls(row.count), () => {
            if (openDomains.has(row.domain)) openDomains.delete(row.domain);
            else openDomains.add(row.domain);
            render();
          });
          toggle.setAttribute('style', 'cursor:pointer;color:inherit;background:none;border:0;padding:0;font:inherit;opacity:.7;text-decoration:underline dotted;');
          li.appendChild(toggle);
        } else {
          li.appendChild(el(doc, 'span', { style: MUTED, text: t.urls(row.count) }));
        }
        li.appendChild(el(doc, 'a', {
          href: buildSiteSearchUrl(loc, row.domain),
          style: 'color:inherit;opacity:.7;text-decoration:underline;',
          text: t.search,
        }));
        if (row.urls.length && openDomains.has(row.domain)) {
          const sub = el(doc, 'ul', { style: 'flex-basis:100%;margin:0 0 4px 16px;padding:0;list-style:none;font-size:12px;word-break:break-all;' });
          for (const u of row.urls) {
            sub.appendChild(el(doc, 'li', null, [el(doc, 'a', { href: u, target: '_blank', rel: 'noopener noreferrer', style: 'color:inherit;opacity:.85;', text: u })]));
          }
          li.appendChild(sub);
        }
        list.appendChild(li);
      }
      block.appendChild(list);
      if (rows.length > COLLAPSED_LIMIT) {
        block.appendChild(button(expanded ? t.showLess : t.showAll(rows.length), () => {
          expanded = !expanded;
          render();
        }));
      }

      if (ids.length) {
        const foot = el(doc, 'div', { style: MUTED + 'margin-top:8px;font-size:12px;word-break:break-word;' });
        foot.appendChild(doc.createTextNode(t.complaints + ' '));
        ids.forEach((id, i) => {
          if (i) foot.appendChild(doc.createTextNode(', '));
          const reason = failed.get(id) || (unavailable.has(id) ? t.reasonGone : '');
          const link = el(doc, 'a', { href: noticeUrl(id), target: '_blank', rel: 'noopener noreferrer', style: 'color:inherit;', text: '#' + id + (reason ? ' \u2715' : '') });
          if (reason) link.setAttribute('title', reason);
          foot.appendChild(link);
        });
        block.appendChild(foot);
      }
    }

    async function ensureCached(id) {
      if (cacheChecked.has(id)) return;
      cacheChecked.add(id);
      const cached = await readCache(id);
      if (cached) {
        results.set(id, cached);
        if (cached.unavailable) unavailable.add(id);
      }
    }

    function fail(id, reason, detail) {
      failed.set(id, reason);
      console.warn('[Google Unlocked] notice', id, detail || reason);
    }

    function enterLimited(at) {
      status = 'limited';
      limitedUntil = at;
      clearTimeout(limitTimer);
      limitTimer = setTimer(() => {
        if (status === 'limited' && !pumping) retry();
      }, Math.max(0, at - now()));
      if (limitTimer && limitTimer.unref) limitTimer.unref();
    }

    async function pump() {
      if (pumping) return;
      pumping = true;
      status = 'loading';
      render();
      try {
        // Cached complaints are shown first, regardless of any limit.
        for (const id of ids) await ensureCached(id);
        render();
        let fetchedLive = false;
        for (const id of ids) {
          if (results.has(id) || failed.has(id)) continue;
          await ensureCached(id);
          if (results.has(id)) {
            render();
            continue;
          }
          if (fetchedLive) await sleep(delayMs);
          fetchedLive = true;
          let res;
          try {
            res = await fetchNotice(id);
          } catch (e) {
            const msg = String((e && e.message) || e);
            fail(id, t.reasonError(msg));
            render();
            continue;
          }
          if (res.limited) {
            enterLimited(res.resumeAt);
            return;
          }
          if (res.tokenRejected) tokenRejected = true;
          if (!res.json && detectGate(res.html, res.url)) {
            status = 'gate';
            if (!gateAnnounced) {
              gateAnnounced = true;
              if (opts.onGate) opts.onGate();
            }
            return;
          }
          if (res.status === 429) {
            // Lumen sends no Retry-After and 429s count towards the limit, so I wait for the next UTC hour.
            enterLimited(nextHourStart(now()));
            return;
          }
          if (res.status === 404 || res.status === 410) {
            // Removed or hidden in Lumen: cache it as empty so it never costs request budget again.
            const gone = { works: [], unavailable: true };
            results.set(id, gone);
            unavailable.add(id);
            await writeCache(id, gone);
            render();
            continue;
          }
          if (res.status !== 200) {
            const text = String(res.html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
            fail(id, 'HTTP ' + res.status, 'HTTP ' + res.status + ' ' + res.url + ' ' + text);
            render();
            continue;
          }
          const parsed = res.json ? parseNoticeJson(res.json) : parseNotice(res.html, DP);
          results.set(id, parsed);
          await writeCache(id, parsed);
          render();
        }
        status = 'done';
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      } finally {
        pumping = false;
        render();
      }
    }

    function retry() {
      clearTimeout(limitTimer);
      failed.clear();
      return pump();
    }

    function addIds(found) {
      let added = false;
      for (const id of found) {
        if (!ids.includes(id)) {
          ids.push(id);
          added = true;
        }
      }
      return added;
    }

    function scan() {
      if (addIds(findNoticeIds(doc)) && !pumping && (status === 'idle' || status === 'done')) {
        pump();
      }
    }

    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'visible' && status === 'gate' && !pumping) retry();
    });

    // Lets the extension resume the queue once the user has passed the check in the Lumen tab.
    doc.addEventListener('google-unlocked:retry', () => {
      if (status === 'gate' && !pumping) retry();
    });

    const MO = (doc.defaultView && doc.defaultView.MutationObserver) || globalThis.MutationObserver;
    if (MO && doc.body) {
      let timer = null;
      observer = new MO(() => {
        clearTimeout(timer);
        timer = setTimeout(scan, 300);
      });
      observer.observe(doc.body, { childList: true, subtree: true });
      const giveUp = setTimeout(() => {
        if (observer) observer.disconnect();
        observer = null;
      }, 60000);
      if (giveUp && giveUp.unref) giveUp.unref();
    }

    addIds(findNoticeIds(doc));
    if (ids.length) await pump();

    return {
      retry,
      get status() { return status; },
      get ids() { return ids.slice(); },
    };
  }

  const api = { budgetCheck, parseNoticeJson, nextHourStart, LIMITS_ANON, LIMITS_TOKEN, findNoticeIds, detectGate, parseNotice, aggregate, buildSiteSearchUrl, run, strings, BLOCK_ID };
  globalThis.GoogleUnlocked = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

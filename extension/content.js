(function () {
  'use strict';
  const api = globalThis.browser ?? chrome;

  // Promise form works in both Chrome MV3 and Firefox.
  const fetchNotice = async (id) => {
    const res = await api.runtime.sendMessage({ type: 'fetchNotice', id });
    if (!res || res.error) throw new Error((res && res.error) || 'no response');
    // Core recognises the gate by this URL and stops the queue.
    if (res.gate) return { status: 403, url: 'https://lumendatabase.org/captcha_gateway', html: '' };
    return res;
  };

  const storage = {
    async get(key) {
      const o = await api.storage.local.get(key);
      return o[key];
    },
    async set(key, val) {
      await api.storage.local.set({ [key]: val });
    },
  };

  const openLumen = () => api.runtime.sendMessage({ type: 'openLumen' }).catch(() => {});

  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'lumenReady') document.dispatchEvent(new CustomEvent('google-unlocked:retry'));
  });

  globalThis.GoogleUnlocked.run({
    document,
    location,
    fetchNotice,
    storage,
    gateMode: 'tab',
    openWindow: openLumen,
    onGate: openLumen,
  });
})();

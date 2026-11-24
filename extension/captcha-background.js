// Native host stays alive while inference requests are pending, then releases RAM.
(() => {
  const api = globalThis.browser ?? chrome;
  let port, sequence = 0, idle;
  const pending = new Map();
  function infer(payload) {
    clearTimeout(idle);
    if (!port) {
      port = api.runtime.connectNative('org.google_unlocked.captcha');
      port.onMessage.addListener(message => {
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(message.id);
        request.resolve(message);
        if (!pending.size) idle = setTimeout(() => { port?.disconnect(); port = null; }, 15000);
      });
      port.onDisconnect.addListener(() => {
        const error = api.runtime.lastError?.message || 'Локальный процесс остановлен';
        port = null;
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.resolve({ error });
        }
        pending.clear();
      });
    }
    return new Promise(resolve => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: 'Превышено время распознавания' });
        if (!pending.size) { port?.disconnect(); port = null; }
      }, 45000);
      pending.set(id, { resolve, timer });
      try { port.postMessage({ ...payload, id }); }
      catch (error) { clearTimeout(timer); pending.delete(id); resolve({ error: error.message }); }
    });
  }
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['captchaConfig', 'captchaInfer', 'captchaTest', 'captchaStatus'].includes(message?.type)) return false;
    (async () => {
      const optionsPage = sender.url === api.runtime.getURL('options.html');
      if (message.type === 'captchaTest') {
        if (!optionsPage) throw new Error('Недопустимый источник');
        return infer({ kind: 'ping' });
      }
      const tab = sender.tab && await api.tabs.get(sender.tab.id);
      if (!tab || new URL(tab.url).origin !== 'https://lumendatabase.org' ||
          !new URL(tab.url).pathname.startsWith('/captcha_gateway')) return { enabled: false };
      const config = await api.storage.local.get('autoCaptcha');
      if (config.autoCaptcha === false) return { enabled: false };
      if (message.type === 'captchaConfig') return { enabled: true };
      if (message.type === 'captchaStatus') {
        await api.storage.local.set({ captchaStatus: String(message.text).slice(0, 300) });
        return { ok: true };
      }
      const url = new URL(sender.url);
      if (!['www.google.com', 'www.recaptcha.net'].includes(url.hostname) ||
          !url.pathname.startsWith('/recaptcha/')) throw new Error('Недопустимый фрейм');
      return infer({ kind: message.kind, task: message.task, images: message.images });
    })().then(respond, error => respond({ error: error.message }));
    return true;
  });
})();

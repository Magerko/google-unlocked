(function () {
  'use strict';
  const api = globalThis.browser ?? chrome;
  const lang = (navigator.language || '').toLowerCase();
  const T = lang.startsWith('ru')
    ? { hint: 'Необязательно. С токеном исследователя Lumen расширение запрашивает жалобы напрямую (лимит 60 в минуту, без часового) и показывает полные URL.', label: 'Токен Lumen', save: 'Сохранить', saved: 'Сохранено', link: 'Получить токен на lumendatabase.org' }
    : lang.startsWith('uk')
      ? { hint: 'Необов’язково. З токеном дослідника Lumen розширення запитує скарги напряму (ліміт 60 на хвилину, без годинного) і показує повні URL.', label: 'Токен Lumen', save: 'Зберегти', saved: 'Збережено', link: 'Отримати токен на lumendatabase.org' }
      : { hint: 'Optional. With a Lumen researcher token the extension queries complaints directly (60 per minute, no hourly cap) and shows full URLs.', label: 'Lumen token', save: 'Save', saved: 'Saved', link: 'Get a token at lumendatabase.org' };

  const $ = (id) => document.getElementById(id);
  $('hint').textContent = T.hint;
  $('label').textContent = T.label;
  $('save').textContent = T.save;
  $('link').textContent = T.link;

  $('extension-id').textContent = api.runtime.id;
  api.storage.local.get(['autoCaptcha', 'captchaStatus']).then(o => {
    $('auto-captcha').checked = o.autoCaptcha !== false;
    $('model-status').textContent = o.captchaStatus || '';
  });
  $('auto-captcha').addEventListener('change', () => api.storage.local.set({ autoCaptcha: $('auto-captcha').checked }));
  $('test-models').addEventListener('click', async () => {
    $('model-status').textContent = 'Загрузка моделей…';
    try {
      const result = await api.runtime.sendMessage({ type: 'captchaTest' });
      $('model-status').textContent = result?.ok ? 'Обе модели готовы к работе' : (result?.error || 'Нет ответа');
    } catch (error) { $('model-status').textContent = error.message; }
  });

  api.storage.local.get('lumenToken').then((o) => {
    $('token').value = o.lumenToken || '';
  });

  $('save').addEventListener('click', async () => {
    // A new token gets a fresh chance even if the previous one was rejected.
    await api.storage.local.set({ lumenToken: $('token').value.trim(), tokenRejected: false });
    $('status').textContent = T.saved;
  });
})();

(() => {
  'use strict';
  const api = globalThis.browser ?? chrome;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const send = message => api.runtime.sendMessage(message);
  const status = text => send({ type: 'captchaStatus', text }).catch(() => {});
  const visible = element => element && element.getClientRects().length > 0;
  function pixels(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }
  async function run() {
    const config = await send({ type: 'captchaConfig' });
    if (!config?.enabled) return;
    const deadline = Date.now() + 110000;
    let clicked = false, lastSignature = '', lastAction = 0, rounds = 0;
    while (Date.now() < deadline && rounds < 25) {
      await sleep(700);
      const current = await send({ type: 'captchaConfig' });
      if (!current?.enabled) return;
      // A top-frame form may require submission after the reCAPTCHA callback.
      if (location.hostname === 'lumendatabase.org') {
        const token = document.querySelector('textarea[name="g-recaptcha-response"]');
        if (token?.value && token.form) {
          const submit = token.form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
          if (submit && !submit.disabled) { submit.click(); return; }
        }
        continue;
      }
      const anchor = document.querySelector('#recaptcha-anchor');
      if (anchor) {
        if (anchor.getAttribute('aria-checked') === 'true') { await status('Капча решена'); return; }
        if (!clicked && !anchor.classList.contains('recaptcha-checkbox-loading')) {
          anchor.click(); clicked = true;
          await status('Автоматическое решение капчи…');
        }
        continue;
      }
      if (visible(document.querySelector('.rc-doscaptcha-header'))) throw new Error('Google ограничил попытки');
      const instructions = document.querySelector('.rc-imageselect-instructions');
      if (!visible(instructions)) continue;
      const cells = [...document.querySelectorAll('#rc-imageselect-target td')];
      if (![9, 16].includes(cells.length)) continue;
      if (document.querySelector('.rc-imageselect-dynamic-selected')) continue;
      const imgs = cells.map(cell => cell.querySelector('img'));
      if (imgs.some(img => !img?.complete || !img.naturalWidth)) continue;
      const sources = imgs.map(img => img.src);
      const task = instructions.innerText;
      const signature = task + sources.join('|');
      if (signature === lastSignature) {
        if (Date.now() - lastAction > 12000) throw new Error('Задание не изменилось после ответа');
        continue;
      }
      const replacements = imgs.some(img => img.classList.contains('rc-image-tile-11'));
      const kind = cells.length === 16 ? '4x4' : replacements ? 'tiles' : '3x3';
      const indexes = replacements ? imgs.flatMap((img, i) => img.classList.contains('rc-image-tile-11') ? [i] : []) : cells.map((_, i) => i);
      const images = kind === 'tiles' ? indexes.map(i => pixels(imgs[i])) : [pixels(imgs[0])];
      const result = await send({ type: 'captchaInfer', kind, task, images });
      if (result?.error) throw new Error(result.error);
      if (!Array.isArray(result?.selected) || result.selected.length !== indexes.length) throw new Error('Некорректный ответ модели');
      if (Date.now() >= deadline || !(await send({ type: 'captchaConfig' }))?.enabled) return;
      // Never apply inference to a challenge that changed while the model was running.
      if (!cells.every((cell, i) => cell.isConnected && cell.querySelector('img')?.src === sources[i]) || instructions.innerText !== task) continue;
      lastSignature = signature;
      rounds++;
      let selected = 0;
      for (let n = 0; n < indexes.length; n++) {
        const cell = cells[indexes[n]];
        const want = result.selected[n];
        if (want) selected++;
        if (want !== cell.classList.contains('rc-imageselect-tileselected')) {
          cell.click(); await sleep(250);
        }
      }
      const dynamic = replacements || task.split('\n').filter(line => line.trim()).length === 3 || /исчез|исчезнут|зник|none left|no more|disappear|пока не/i.test(task);
      if (!dynamic || selected === 0) {
        await sleep(700);
        const verify = document.querySelector('#recaptcha-verify-button');
        if (verify && !verify.disabled) verify.click();
      }
      lastAction = Date.now();
      await sleep(1300);
    }
    throw new Error('Время автоматического решения истекло');
  }
  run().catch(error => status('Решите капчу вручную: ' + error.message));
})();

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function bridge(tabUrl, settings = {}) {
  let listener, nativeCalls = 0;
  const api = {
    runtime: {
      getURL: file => 'chrome-extension://test/' + file,
      onMessage: { addListener: fn => { listener = fn; } },
      connectNative: () => {
        nativeCalls++;
        throw new Error('Native host is not installed');
      },
    },
    tabs: { get: async () => ({ url: tabUrl }) },
    storage: { local: { get: async () => settings, set: async () => {} } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/captcha-background.js'), 'utf8'),
    { chrome: api, URL, setTimeout, clearTimeout });
  return {
    calls: () => nativeCalls,
    send: (msg, url = 'https://www.google.com/recaptcha/api2/bframe') =>
      new Promise(resolve => listener(msg, { url, tab: { id: 1 } }, resolve)),
  };
}

test('captcha bridge never runs models for another website or normal Lumen page', async () => {
  for (const url of ['https://example.com/captcha_gateway', 'https://lumendatabase.org/notices/1']) {
    const b = bridge(url);
    assert.equal((await b.send({ type: 'captchaInfer' })).enabled, false);
    assert.equal(b.calls(), 0);
  }
});

test('captcha switch disables inference', async () => {
  const b = bridge('https://lumendatabase.org/captcha_gateway', { autoCaptcha: false });
  assert.equal((await b.send({ type: 'captchaInfer' })).enabled, false);
  assert.equal(b.calls(), 0);
});

test('missing native host returns a recoverable error', async () => {
  const b = bridge('https://lumendatabase.org/captcha_gateway');
  assert.equal((await b.send({ type: 'captchaInfer' })).error, 'Native host is not installed');
  assert.equal(b.calls(), 1);
});

test('only recaptcha frames and the options page can request native access', async () => {
  const b = bridge('https://lumendatabase.org/captcha_gateway');
  assert.ok((await b.send({ type: 'captchaInfer' }, 'https://evil.example/recaptcha/')).error);
  assert.ok((await b.send({ type: 'captchaTest' })).error);
  assert.equal(b.calls(), 0);
});

import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const p = (...a) => join(root, ...a);
const read = (f) => readFileSync(p(f), 'utf8');

const tlds = JSON.parse(read('src/google-domains.json'));
const matches = tlds.map((t) => `*://www.google.${t}/search*`);

rmSync(p('dist'), { recursive: true, force: true });

// Chrome warns on background.scripts and Firefox ignores service_worker, so I emit one manifest per browser.
for (const target of ['chrome', 'firefox']) {
  const out = `dist/${target}`;
  mkdirSync(p(out), { recursive: true });
  const manifest = JSON.parse(read('extension/manifest.template.json'));
  manifest.content_scripts[0].matches = matches;
  if (target === 'chrome') {
    delete manifest.background.scripts;
    delete manifest.browser_specific_settings;
  } else {
    delete manifest.background.service_worker;
    delete manifest.key;
    manifest.background.scripts = ['core.js', 'captcha-background.js', 'background.js'];
  }
  writeFileSync(p(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  copyFileSync(p('src/core.js'), p(out, 'core.js'));
  for (const f of ['captcha.js', 'captcha-background.js', 'content.js', 'background.js', 'options.html', 'options.js', '16.png', '32.png', '48.png', '128.png', '512.png']) {
    copyFileSync(p('extension', f), p(out, f));
  }
}

const header = read('userscript/header.js').replace('// __MATCHES__', matches.map((m) => `// @match        ${m}`).join('\n'));
const body = `(function () {\n'use strict';\n${read('src/core.js')}\n${read('userscript/glue.js')}\n})();\n`;
writeFileSync(p('dist/google-unlocked.user.js'), header + '\n' + body);

console.log(`built: ${matches.length} match patterns`);

// Boots the game in the browser and reports what the host logs.
//
//   node web/tests/boot.mjs --disc IMAGE --module gGZLE01_recomp.so
//        [--retraces N] [--seconds S] [--browser chrome|firefox] [--env NAME=VALUE]... [--log FILE]
//
// Serves build/web/site, imports the disc into a throwaway browser profile,
// lets the runtime check prepare it (main.dol and the RELs, revision 0
// verified), imports the game module you built from your disc, then starts
// the host (?run=game) with BLUEWAKE_MAX_RETRACES=N and waits for it to exit
// or for S seconds. The host's own "[perf] retrace=..." lines say how far the
// game ran. The profile, and the copies of the disc and the module in it,
// are deleted afterwards.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const site = path.resolve(opt('--site', path.join(root, 'build/web/site')));
const disc = opt('--disc', null);
const module = opt('--module', null);
const retraces = +opt('--retraces', 600);
const seconds = +opt('--seconds', 600);
const browserName = opt('--browser', 'chrome');
const logFile = opt('--log', null);
const extraEnv = args.flatMap((a, i) => (a === '--env' ? [args[i + 1]] : []));
if (!disc || !module) {
  console.error('usage: node web/tests/boot.mjs --disc IMAGE --module gGZLE01_recomp.so [--retraces N] [--seconds S]');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewake-boot-'));
const server = spawn('python3', [path.join(root, 'web/serve.py'), site, '--port', '0'], {
  env: { ...process.env, BLUEWAKE_SERVE_QUIET: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const base = await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => {
    const m = /at (http:\/\/[^ ]+\/)/.exec(String(d));
    if (m) resolve(m[1]);
  });
  server.on('exit', () => reject(new Error('web/serve.py exited')));
});

let page, close;
if (browserName === 'chrome') {
  const { chromium } = await import('playwright');
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    executablePath: process.env.BLUEWAKE_TEST_CHROME || '/usr/bin/google-chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan'],
  });
  page = ctx.pages()[0] || (await ctx.newPage());
  page.setFile = (sel, file) => page.setInputFiles(sel, file);
  page.waitFn = (fn, timeout) => page.waitForFunction(fn, null, { timeout, polling: 500 });
  close = () => ctx.close();
} else {
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    browser: 'firefox', executablePath: process.env.BLUEWAKE_TEST_FIREFOX || '/usr/bin/firefox', headless: true,
    userDataDir: path.join(tmp, 'profile'),
    extraPrefsFirefox: { 'dom.webgpu.enabled': true, 'dom.webgpu.workers.enabled': true },
  });
  page = await browser.newPage();
  page.setFile = async (sel, file) => (await page.$(sel)).uploadFile(file);
  page.waitFn = (fn, timeout) => page.waitForFunction(fn, { timeout, polling: 500 });
  close = () => browser.close();
}
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
let code = 1;
try {
  await page.goto(base);
  await page.waitFn(() => window.bluewake && window.bluewake.ready, 30000);
  await page.setFile('#pick', disc);
  await page.waitFn(() => window.bluewake.disc || document.getElementById('disc-status').classList.contains('error'), 600000);
  console.log(`disc: ${await page.evaluate(() => document.getElementById('disc-status').textContent)} (${elapsed()})`);
  await page.evaluate(() => document.getElementById('run').click());
  await page.waitFn(() => window.bluewake.check && (window.bluewake.check.done || window.bluewake.check.abort), 600000);
  const check = await page.evaluate(() => window.bluewake.check);
  const d = check.checks.find((c) => c.name === 'disc');
  console.log(`runtime check: ${check.passed} passed, ${check.failed} failed; disc: ${d ? d.detail : 'none'} (${elapsed()})`);
  await page.setFile('#pick-module', module);
  await page.waitFn(() => window.bluewake.module || document.getElementById('module-status').classList.contains('error'), 600000);
  console.log(`module: ${await page.evaluate(() => document.getElementById('module-status').textContent)} (${elapsed()})`);

  const url = new URL(base);
  url.searchParams.set('run', 'game');
  for (const e of [`BLUEWAKE_MAX_RETRACES=${retraces}`, ...extraEnv]) url.searchParams.append('env', e);
  await page.goto(url.href);
  const started = Date.now();
  let last = 0;
  while (Date.now() - started < seconds * 1000) {
    const g = await page.evaluate(() => window.bluewake.game && {
      exit: window.bluewake.game.exit, abort: window.bluewake.game.abort,
      retrace: window.bluewake.game.retrace, rate: window.bluewake.game.rate,
    });
    if (g && g.retrace !== last) {
      console.log(`  retrace ${g.retrace}, ${g.rate} retraces/s (${elapsed()})`);
      last = g.retrace;
    }
    if (g && (g.exit !== null || g.abort)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const log = await page.evaluate(() => document.getElementById('log').textContent);
  if (logFile) fs.writeFileSync(logFile, log);
  const g = await page.evaluate(() => window.bluewake.game);
  const lines = log.split('\n').filter((l) => l && !l.startsWith('[perf]'));
  console.log(lines.slice(0, 80).join('\n'));
  if (lines.length > 100) console.log(`  ... (${lines.length - 100} lines) ...\n${lines.slice(-20).join('\n')}`);
  console.log(`\ngame: exit ${g.exit}, abort ${g.abort}, last retrace ${g.retrace} at ${g.rate} retraces/s, ` +
    `${g.lines} log lines, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  if (errors.length) console.log(`page errors: ${errors.slice(0, 5).join(' | ')}`);
  code = g.abort || errors.length ? 1 : g.retrace >= retraces ? 0 : 1;
} catch (e) {
  console.log(`boot test: ${e && e.stack ? e.stack : e}`);
} finally {
  await close();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);

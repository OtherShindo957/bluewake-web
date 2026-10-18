// Browser smoke test for the BlueWake web build (milestone 1).
//
//   node web/tests/smoke.mjs [--browser chrome|firefox|all] [--disc IMAGE] [--site DIR] [--headful]
//
// Serves build/web/site with web/serve.py and, in each browser (system Chrome
// through Playwright, system Firefox through puppeteer-core/WebDriver BiDi,
// each with a throwaway profile):
//   - the page loads cross-origin isolated, with no page errors;
//   - the browser reports JSPI, WebGPU and the origin-private file system;
//   - files that are not the supported disc are refused before any copy
//     (random bytes, an RVZ image, another GameCube game, GZLE01 revision 1);
//   - a synthetic GZLE01 image (a header and a tiny DOL, no game data) is
//     imported and the runtime's shared importer rejects its main.dol as not
//     revision 0;
//     (headless Firefox does not capture WebGPU canvases in screenshots: its
//     pixel is checked only with --headful, which opens visible windows);
//   - with --disc, the real image is imported (CISO expanded) and the runtime
//     prepares main.dol and the 415 RELs from it;
//   - every other runtime check passes (threads, JSPI, CPU, OPFS, dlopen,
//     WebGPU) and the canvas shows the last frame's colour, read back from a
//     screenshot of the page.
// The disc image is copied only into the throwaway profile, which is deleted.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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
const which = opt('--browser', 'all');
const headful = args.includes('--headful');
const browsers = which === 'all' ? ['chrome', 'firefox'] : [which];

let failures = 0;
let passes = 0;
function expect(ok, label, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (ok) passes++;
  else failures++;
  return ok;
}

// --- test inputs (no game data) -------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewake-web-test-'));
function gcHeader(id, revision) {
  const h = Buffer.alloc(0x440);
  h.write(id, 0, 'ascii');
  h[7] = revision;
  h.writeUInt32BE(0xc2339f3d, 0x1c);
  h.write('BLUEWAKE WEB TEST IMAGE (NO GAME DATA)', 0x20, 'ascii');
  return h;
}
function syntheticDisc(file, id, revision) {
  // A header, a 0x100-byte DOL with one 0x100-byte text section, and an empty
  // FST: enough for the importer to reach main.dol's revision check.
  const size = 2 << 20;
  const img = Buffer.alloc(size);
  gcHeader(id, revision).copy(img, 0);
  const dolOff = 0x10000;
  img.writeUInt32BE(dolOff, 0x420);
  img.writeUInt32BE(0x20000, 0x424); // FST offset
  img.writeUInt32BE(0x0c, 0x428); // FST size: the root entry only
  img.writeUInt32BE(0x0c, 0x42c);
  img.writeUInt32BE(0x100, dolOff + 0x00); // text0 file offset
  img.writeUInt32BE(0x80003100, dolOff + 0x48); // text0 address
  img.writeUInt32BE(0x100, dolOff + 0x90); // text0 size
  img.writeUInt32BE(0x80003100, dolOff + 0xe0); // entry
  img.writeUInt32BE(0x4e800020, dolOff + 0x100); // blr
  img[0x20000] = 1; // FST root: a directory with one entry (itself)
  img.writeUInt32BE(1, 0x20000 + 8);
  fs.writeFileSync(file, img);
  return file;
}
const inputs = {
  random: path.join(tmp, 'random.iso'),
  rvz: path.join(tmp, 'game.rvz'),
  other: syntheticDisc(path.join(tmp, 'other.iso'), 'GMSE01', 0),
  rev1: syntheticDisc(path.join(tmp, 'rev1.iso'), 'GZLE01', 1),
  synthetic: syntheticDisc(path.join(tmp, 'synthetic.iso'), 'GZLE01', 0),
};
fs.writeFileSync(inputs.random, Buffer.from(Array.from({ length: 1 << 20 }, (_, i) => (i * 2654435761) >>> 24)));
fs.writeFileSync(inputs.rvz, Buffer.concat([Buffer.from('RVZ\x01', 'latin1'), Buffer.alloc(0x8000)]));

// --- PNG pixel reader (screenshots are 8-bit RGB(A), not interlaced) ------
function pngPixel(png, x, y) {
  let pos = 8;
  let width = 0, height = 0, channels = 4;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[data[9]];
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let r = 0; r < height; r++) {
    const f = raw[r * (stride + 1)];
    const line = Buffer.from(raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      line[i] = (line[i] + [0, a, b, (a + b) >> 1, pr][f]) & 255;
    }
    rows.push(line);
    prev = line;
  }
  const px = rows[y].subarray(x * channels, x * channels + 3);
  return [px[0], px[1], px[2]];
}

// --- browsers -----------------------------------------------------------
async function chromeSession() {
  const { chromium } = await import('playwright');
  const profile = fs.mkdtempSync(path.join(tmp, 'chrome-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.BLUEWAKE_TEST_CHROME || '/usr/bin/google-chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan'],
    viewport: { width: 900, height: 1400 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return {
    page,
    onConsole: (fn) => page.on('console', (m) => fn(m.text())),
    onError: (fn) => page.on('pageerror', (e) => fn(String(e))),
    goto: (url) => page.goto(url),
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    waitFor: (fn, timeout) => page.waitForFunction(fn, null, { timeout, polling: 250 }),
    setFile: (file) => page.setInputFiles('#pick', file),
    canvasPng: () => page.locator('#canvas').screenshot(),
    close: () => ctx.close(),
  };
}

async function firefoxSession() {
  const puppeteer = (await import('puppeteer-core')).default;
  const profile = fs.mkdtempSync(path.join(tmp, 'firefox-'));
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: process.env.BLUEWAKE_TEST_FIREFOX || '/usr/bin/firefox',
    headless: !headful,
    userDataDir: profile,
    extraPrefsFirefox: { 'dom.webgpu.enabled': true, 'dom.webgpu.workers.enabled': true, 'gfx.webgpu.ignore-blocklist': true },
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1400 });
  return {
    page,
    onConsole: (fn) => page.on('console', (m) => fn(m.text())),
    onError: (fn) => page.on('pageerror', (e) => fn(String(e))),
    goto: (url) => page.goto(url),
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    waitFor: (fn, timeout) => page.waitForFunction(fn, { timeout, polling: 250 }),
    setFile: async (file) => (await page.$('#pick')).uploadFile(file),
    canvasPng: async () => Buffer.from(await (await page.$('#canvas')).screenshot()),
    close: () => browser.close(),
  };
}

// --- the test -------------------------------------------------------------
async function importFile(s, file) {
  await s.evaluate(() => { window.__discBefore = document.getElementById('disc-status').textContent; });
  await s.setFile(file);
  await s.waitFor(() => {
    const t = document.getElementById('disc-status').textContent;
    return t !== window.__discBefore && !/^Copying/.test(t);
  }, 30 * 60 * 1000);
  return s.evaluate(() => ({
    text: document.getElementById('disc-status').textContent,
    error: document.getElementById('disc-status').classList.contains('error'),
    disc: window.bluewake.disc,
  }));
}

async function runCheck(s) {
  await s.evaluate(() => document.getElementById('run').click());
  await s.waitFor(() => window.bluewake.check && (window.bluewake.check.done || window.bluewake.check.abort), 20 * 60 * 1000);
  return s.evaluate(() => window.bluewake.check);
}

async function testBrowser(name, base) {
  console.log(`\n== ${name}`);
  const s = name === 'chrome' ? await chromeSession() : await firefoxSession();
  const errors = [];
  const log = [];
  s.onError((e) => errors.push(e));
  s.onConsole((t) => log.push(t));
  try {
    await s.goto(base);
    await s.waitFor(() => window.bluewake && window.bluewake.ready, 30000);
    const caps = await s.evaluate(() => window.bluewake.caps);
    expect(caps.isolated, 'page is cross-origin isolated');
    expect(caps.jspi, 'JSPI available');
    expect(caps.opfs, 'origin-private file system available');
    expect(caps.webgpu, 'WebGPU adapter', caps.gpu || caps.gpuError || '');

    let r = await importFile(s, inputs.random);
    expect(r.error && /not a GameCube disc/.test(r.text) && !r.disc, 'random bytes refused', r.text);
    r = await importFile(s, inputs.rvz);
    expect(r.error && /RVZ/.test(r.text) && !r.disc, 'RVZ image refused with a conversion hint', r.text);
    r = await importFile(s, inputs.other);
    expect(r.error && /GMSE01/.test(r.text) && !r.disc, 'another GameCube game refused', r.text);
    r = await importFile(s, inputs.rev1);
    expect(r.error && /revision 1/.test(r.text) && !r.disc, 'GZLE01 revision 1 refused', r.text);

    r = await importFile(s, inputs.synthetic);
    expect(!r.error && r.disc && r.disc.size === fs.statSync(inputs.synthetic).size, 'synthetic GZLE01 image stored in OPFS', r.text);
    let check = await runCheck(s);
    const discCheck = check.checks.find((c) => c.name === 'disc');
    expect(discCheck && discCheck.status === 'FAIL' && /revision|SHA-1|USA/i.test(discCheck.detail),
      'runtime importer rejects the synthetic main.dol', discCheck ? discCheck.detail : 'no disc check');

    if (disc) {
      // A fresh page: a run's runtime stays loaded in its page.
      await s.goto(base);
      await s.waitFor(() => window.bluewake && window.bluewake.ready, 30000);
      const t0 = Date.now();
      r = await importFile(s, disc);
      expect(!r.error && r.disc, 'your disc image stored in OPFS', `${r.text} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      check = await runCheck(s);
      const d = check.checks.find((c) => c.name === 'disc');
      expect(d && d.status === 'ok' && /415 RELs/.test(d.detail), 'runtime prepared main.dol and 415 RELs (revision 0 verified)', d ? d.detail : 'none');
    }

    for (const n of ['threads', 'jspi', 'cpu', 'opfs', 'dlopen', 'webgpu-instance', 'webgpu-adapter', 'webgpu-device', 'webgpu-surface', 'webgpu-frames']) {
      const c = check.checks.find((x) => x.name === n);
      expect(c && c.status === 'ok', `runtime check ${n}`, c ? c.detail : check.abort || 'missing');
    }
    expect(check.done && !check.abort, 'runtime check finished', check.abort || `${check.passed} passed, ${check.failed} failed, ${check.skipped} skipped`);

    if (name === 'firefox' && !headful) {
      console.log('  ----  canvas pixel not checked: headless Firefox does not capture WebGPU canvases (use --headful)');
    } else {
      const png = await s.canvasPng();
      const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      const px = pngPixel(png, w >> 1, h >> 1);
      const near = Math.abs(px[0] - 26) <= 3 && Math.abs(px[1] - 115) <= 3 && Math.abs(px[2] - 204) <= 3;
      expect(near, 'canvas shows the last WebGPU frame', `centre pixel rgb(${px.join(', ')}), expected rgb(26, 115, 204)`);
    }
    if (fs.existsSync(path.join(site, 'bluewake-aurora-check.wasm'))) {
      // The renderer (Aurora on WebGPU) starts, runs and stops without a game.
      await s.goto(base + 'aurora-check.html');
      await s.waitFor(() => window.auroraCheck && (window.auroraCheck.done || window.auroraCheck.abort), 120000);
      const a = await s.evaluate(() => window.auroraCheck);
      const api = a.lines.find((l) => /API: /.test(l)) || a.lines.find((l) => / API: /.test(l));
      const init = a.lines.find((l) => l.startsWith('[aurora-check] initialized'));
      expect(a.done && !a.abort && !!init, 'renderer starts and stops (Aurora on WebGPU)',
        a.abort || [api && api.trim(), a.lines.find((l) => /host turns/.test(l))].filter(Boolean).join('; '));
    }
    const pageErrors = [...errors, ...(await s.evaluate(() => (window.bluewake ? window.bluewake.errors : [])))];
    const gpuErrors = log.filter((l) => /\[webgpu\] (error|device lost)/.test(l));
    expect(pageErrors.length === 0 && gpuErrors.length === 0, 'no page or WebGPU errors', [...pageErrors, ...gpuErrors].join(' | '));
  } catch (e) {
    expect(false, `${name} run`, String(e && e.stack ? e.stack : e));
    if (log.length) console.log(log.slice(-40).map((l) => '    | ' + l).join('\n'));
  } finally {
    await s.close();
  }
}

if (!fs.existsSync(path.join(site, 'bluewake-runtime.wasm'))) {
  console.error(`${site} has no build: run web/build.sh first`);
  process.exit(2);
}
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
try {
  for (const b of browsers) await testBrowser(b, base);
} finally {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

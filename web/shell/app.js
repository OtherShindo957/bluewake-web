// BlueWake Web page: browser capabilities, disc import into private storage,
// and the WebAssembly runtime check (web/runtime/web_main.c).
//
// State for tests is published on window.bluewake: { caps, disc, check }.

const $ = (id) => document.getElementById(id);
const GC_MAGIC = 0xc2339f3d;
const GC_DISC_SIZE = 1459978240;
const state = (window.bluewake = { caps: {}, disc: null, check: null, errors: [] });

function addCheck(list, status, name, detail) {
  const li = document.createElement('li');
  li.className = status === 'ok' ? 'ok' : status === 'FAIL' ? 'fail' : 'skip';
  li.innerHTML = '<span class="state"></span><span class="name"></span><span class="detail"></span>';
  li.querySelector('.state').textContent = status === 'ok' ? 'ok' : status === 'FAIL' ? 'failed' : status;
  li.querySelector('.name').textContent = name;
  li.querySelector('.detail').textContent = detail;
  list.append(li);
}

function setDiscStatus(text, error = false) {
  $('disc-status').textContent = text;
  $('disc-status').classList.toggle('error', error);
}

// --- capabilities -----------------------------------------------------------
async function checkCapabilities() {
  const caps = state.caps;
  caps.isolated = self.crossOriginIsolated === true;
  caps.jspi = typeof WebAssembly.Suspending === 'function';
  caps.opfs = !!(navigator.storage && navigator.storage.getDirectory);
  caps.webgpu = false;
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      caps.webgpu = !!adapter;
      if (adapter) {
        caps.gpu = adapter.info ? `${adapter.info.vendor || 'unknown vendor'} ${adapter.info.architecture || ''}`.trim() : '';
        caps.dualSourceBlending = adapter.features.has('dual-source-blending');
      }
    } catch (e) {
      caps.gpuError = String(e);
    }
  }
  try {
    const est = await navigator.storage.estimate();
    caps.quota = est.quota;
  } catch (_) { /* reported as unknown */ }

  const list = $('caps');
  list.textContent = '';
  addCheck(list, caps.isolated ? 'ok' : 'FAIL', 'isolation',
    caps.isolated ? 'cross-origin isolated: threads (SharedArrayBuffer) available'
      : 'not cross-origin isolated: serve with web/serve.py (or let the page\'s service worker reload it)');
  addCheck(list, caps.jspi ? 'ok' : 'FAIL', 'jspi',
    caps.jspi ? 'WebAssembly JavaScript Promise Integration' : 'no JSPI: use a current Chrome, Edge or Firefox');
  const firefoxHint = /Firefox\//.test(navigator.userAgent)
    ? ' (Firefox on Linux: set dom.webgpu.enabled to true in about:config)' : '';
  addCheck(list, caps.webgpu ? 'ok' : 'FAIL', 'webgpu',
    caps.webgpu ? `adapter: ${caps.gpu || 'available'}${caps.dualSourceBlending ? ', dual-source blending' : ''}`
      : `no WebGPU adapter${firefoxHint}${caps.gpuError ? `: ${caps.gpuError}` : ''}`);
  const gb = caps.quota ? (caps.quota / 2 ** 30).toFixed(1) : null;
  const roomy = !caps.quota || caps.quota > 2 * GC_DISC_SIZE;
  addCheck(list, caps.opfs ? (roomy ? 'ok' : 'FAIL') : 'FAIL', 'storage',
    caps.opfs ? `origin-private file system, ${gb ? gb + ' GiB quota' : 'quota unknown'}${roomy ? '' : ' (too small for a disc: a private window?)'}`
      : 'no origin-private file system');
}

// --- disc -------------------------------------------------------------------
async function storedDisc() {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('bluewake');
    const marker = await (await dir.getFileHandle('disc.json')).getFile();
    return JSON.parse(await marker.text());
  } catch (_) {
    return null;
  }
}

async function showStoredDisc() {
  state.disc = await storedDisc();
  if (state.disc) {
    setDiscStatus(`Stored: ${state.disc.name} (${(state.disc.size / 2 ** 20).toFixed(1)} MiB), ` +
      `imported ${new Date(state.disc.imported).toLocaleString()}. The runtime check verifies it.`);
  } else {
    setDiscStatus('No disc stored in this browser yet.');
  }
  $('remove').hidden = !state.disc;
}

// Reads enough of the file to say what it is, before any copy.
async function identify(file) {
  const head = new Uint8Array(await file.slice(0, 0x8040).arrayBuffer());
  const view = new DataView(head.buffer);
  const ascii = (a, b) => String.fromCharCode(...head.subarray(a, b));
  if (ascii(0, 4) === 'RVZ\x01' || ascii(0, 4) === 'WIA\x01')
    return { error: 'This is a Dolphin RVZ/WIA image. BlueWake reads ISO, GCM or CISO: convert it in Dolphin (right-click the game, Convert File… → ISO).' };
  if (view.getUint32(0, true) === 0xb10bc001)
    return { error: 'This is a Dolphin GCZ image. Convert it to ISO in Dolphin (Convert File… → ISO).' };
  if (ascii(0, 4) === 'WBFS') return { error: 'This is a WBFS (Wii) image, not a GameCube disc.' };
  let kind = 'iso';
  let disc = head;
  if (ascii(0, 4) === 'CISO') {
    kind = 'ciso';
    disc = head.subarray(0x8000);
  }
  const dv = new DataView(disc.buffer, disc.byteOffset, 0x40);
  if (disc.length < 0x20 || dv.getUint32(0x1c) !== GC_MAGIC) {
    if (dv.getUint32(0x18) === 0x5d1c9ea3) return { error: 'This is a Wii disc, not a GameCube disc.' };
    return { error: 'This is not a GameCube disc image.' };
  }
  const id = String.fromCharCode(...disc.subarray(0, 6));
  if (id !== 'GZLE01')
    return { error: `This GameCube disc is ${id}, not The Wind Waker (USA, GZLE01).` };
  if (disc[7] !== 0)
    return { error: `This is GZLE01 revision ${disc[7]}; BlueWake supports revision 0 only.` };
  if (kind === 'iso' && file.size < 0x100000)
    return { error: 'The image is truncated.' };
  return { kind, id };
}

let importing = false;
async function importDisc(file) {
  if (importing) return;
  const info = await identify(file);
  if (info.error) {
    setDiscStatus(info.error, true);
    return;
  }
  importing = true;
  $('pick').disabled = true;
  $('run').disabled = true;
  // Ask to keep the storage, without waiting: Firefox asks the player with a
  // prompt, and the copy need not wait for the answer.
  navigator.storage.persist?.().catch(() => {});
  const bar = $('import-progress');
  bar.hidden = false;
  bar.value = 0;
  setDiscStatus(`Copying ${file.name} (${info.kind.toUpperCase()}) into this browser's private storage…`);
  const worker = new Worker('import-worker.js');
  try {
    await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'progress') bar.value = e.data.fraction;
        else if (e.data.type === 'done') resolve();
        else if (e.data.type === 'error') reject(new Error(e.data.message));
      };
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage({ op: 'import', file, kind: info.kind });
    });
    await showStoredDisc();
    await showStoredModule();
  } catch (e) {
    setDiscStatus(`Import failed: ${e.message}`, true);
  } finally {
    worker.terminate();
    bar.hidden = true;
    importing = false;
    $('pick').disabled = false;
    $('run').disabled = !runtimeReady();
  }
}

async function removeDisc() {
  const worker = new Worker('import-worker.js');
  await new Promise((resolve) => {
    worker.onmessage = resolve;
    worker.postMessage({ op: 'remove' });
  });
  worker.terminate();
  await showStoredDisc();
}

// --- game module ------------------------------------------------------------
async function storedModule() {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('bluewake');
    const file = await (await dir.getFileHandle('gGZLE01_recomp.so')).getFile();
    return { size: file.size, modified: file.lastModified };
  } catch (_) {
    return null;
  }
}

async function showStoredModule() {
  state.module = await storedModule();
  $('module-status').textContent = state.module
    ? `Stored: gGZLE01_recomp.so (${(state.module.size / 2 ** 20).toFixed(1)} MiB).`
    : 'No game module stored in this browser yet.';
  $('module-status').classList.remove('error');
  $('remove-module').hidden = !state.module;
  $('start').disabled = !(state.module && state.disc && runtimeReady());
}

// A WebAssembly side module starts with the wasm magic and a dylink.0 section.
async function isSideModule(file) {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const magic = head[0] === 0 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
  if (!magic || head[8] !== 0) return false;
  let at = 9;
  while (head[at] & 0x80) at++; // the section's size (LEB128)
  at++;
  const length = head[at++];
  return String.fromCharCode(...head.subarray(at, at + length)) === 'dylink.0';
}

async function workerOp(op, file, bar) {
  const worker = new Worker('import-worker.js');
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'progress' && bar) bar.value = e.data.fraction;
        else if (e.data.type === 'done') resolve(e.data);
        else if (e.data.type === 'error') reject(new Error(e.data.message));
      };
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage({ op, file });
    });
  } finally {
    worker.terminate();
  }
}

async function importModule(file) {
  if (!(await isSideModule(file))) {
    $('module-status').textContent = 'This is not a BlueWake game module for the browser (a WebAssembly side module, gGZLE01_recomp.so, built with web/README.md\'s steps).';
    $('module-status').classList.add('error');
    return;
  }
  const bar = $('module-progress');
  bar.hidden = false;
  $('module-status').textContent = `Storing ${file.name}…`;
  try {
    await workerOp('import-module', file, bar);
    await showStoredModule();
  } catch (e) {
    $('module-status').textContent = `Import failed: ${e.message}`;
    $('module-status').classList.add('error');
  } finally {
    bar.hidden = true;
  }
}

// Variables for the host, as the desktop's environment: ?env=NAME=VALUE (repeatable).
function pageEnv() {
  const env = {};
  for (const pair of new URLSearchParams(location.search).getAll('env')) {
    const eq = pair.indexOf('=');
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

// The game runs in a fresh page (?run=game): one WebAssembly runtime a page.
async function startGame() {
  $('run').disabled = $('start').disabled = true;
  $('pick').disabled = $('pick-module').disabled = true;
  const log = $('log');
  log.textContent = '';
  log.parentElement.open = true;
  const game = (state.game = { started: performance.now(), exit: null, abort: null, retrace: 0, rate: 0, lines: 0 });
  const line = (text) => {
    game.lines++;
    const m = /^\[perf\] retrace=(\d+) rate=([\d.]+)/.exec(text);
    if (m) {
      game.retrace = +m[1];
      game.rate = +m[2];
    }
    if (log.textContent.length > 400000) log.textContent = log.textContent.slice(-200000);
    log.textContent += text + '\n';
  };
  try {
    const { default: createBlueWake } = await import('./bluewake.mjs');
    await createBlueWake({
      canvas: $('canvas'),
      bluewakeEnv: pageEnv(),
      print: line,
      printErr: line,
      onExit: (code) => { game.exit = code; line(`[web] the game exited (${code})`); },
      onAbort: (what) => { game.abort = String(what); line(`[web] aborted: ${what}`); },
    });
  } catch (e) {
    game.abort = String(e && e.message ? e.message : e);
    line(`[web] the game did not start: ${game.abort}`);
  }
}

// --- runtime check -----------------------------------------------------------
function runtimeReady() {
  return state.caps.isolated && state.caps.jspi && !importing;
}

async function runCheck() {
  $('run').disabled = true;
  $('pick').disabled = true;
  const results = $('results');
  results.textContent = '';
  const log = $('log');
  log.textContent = '';
  const check = (state.check = { done: false, passed: 0, failed: 0, skipped: 0, checks: [], exit: null });
  const line = (text) => {
    log.textContent += text + '\n';
    const m = /^\[check\] ([\w-]+): (ok|FAIL|skipped) - (.*)$/.exec(text);
    if (m) {
      check.checks.push({ name: m[1], status: m[2], detail: m[3] });
      addCheck(results, m[2], m[1], m[3]);
    }
    const d = /^\[check\] done: (\d+) passed, (\d+) failed, (\d+) skipped$/.exec(text);
    if (d) Object.assign(check, { done: true, passed: +d[1], failed: +d[2], skipped: +d[3] });
  };
  try {
    const { default: createBlueWake } = await import('./bluewake-runtime.mjs');
    await createBlueWake({
      canvas: $('canvas'),
      print: line,
      printErr: (text) => line(text),
      onExit: (code) => { check.exit = code; },
      onAbort: (what) => { check.abort = String(what); line(`[web] aborted: ${what}`); },
    });
    $('fullscreen').disabled = false;
  } catch (e) {
    check.abort = String(e && e.message ? e.message : e);
    line(`[web] the runtime did not start: ${check.abort}`);
  } finally {
    $('pick').disabled = false;
  }
}

// --- page -------------------------------------------------------------------
window.addEventListener('error', (e) => state.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => state.errors.push(String(e.reason)));
$('pick').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importDisc(file);
});
$('remove').addEventListener('click', removeDisc);
$('run').addEventListener('click', runCheck);
$('fullscreen').addEventListener('click', () => $('stage').requestFullscreen().catch(() => {}));
$('pick-module').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importModule(file);
});
$('remove-module').addEventListener('click', async () => {
  await workerOp('remove-module');
  await showStoredModule();
});
$('start').addEventListener('click', () => {
  const url = new URL(location.href);
  url.searchParams.set('run', 'game');
  location.href = url.href;
});

await window.bluewakeIsolation; // a page about to reload under isolation-sw.js stops here
await checkCapabilities();
await showStoredDisc();
await showStoredModule();
$('run').disabled = !runtimeReady();
state.ready = true;
if (new URLSearchParams(location.search).get('run') === 'game') startGame();

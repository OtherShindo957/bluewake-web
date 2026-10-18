// Copies the player's disc image into this site's origin-private file system
// (OPFS) as bluewake/disc.iso. It runs in a worker because only workers get
// synchronous access handles, which write a 1.4 GB file without holding it in
// memory. The image never leaves the browser.
//
// A CISO image is expanded to a plain ISO on the way (BlueWake reads ISO/GCM
// only, as web/tools/ciso_to_iso.py does natively). The copy is written to
// disc.iso.part, read back at its first and last block, and only then moved
// to disc.iso with a marker (disc.json); an interrupted copy is never used.
// Preparing the game files from it (main.dol and the RELs) happens in the
// runtime, with the same importer the other platforms use.

const CHUNK = 8 << 20;
const CISO_HEADER = 0x8000;
const GC_DISC_SIZE = 1459978240;

async function bluewakeDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('bluewake', { create: true });
}

async function remove(dir, name, recursive = false) {
  try { await dir.removeEntry(name, { recursive }); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
}

function readSlice(file, start, end) {
  return file.slice(start, end).arrayBuffer().then((b) => new Uint8Array(b));
}

async function copy(file, kind, progress) {
  const dir = await bluewakeDir();
  await remove(dir, 'disc.iso.part');
  const part = await dir.getFileHandle('disc.iso.part', { create: true });
  const out = await part.createSyncAccessHandle();
  try {
    out.truncate(0);
    let written = 0;
    let total = file.size;
    const write = (bytes, at) => {
      const n = out.write(bytes, { at });
      if (n !== bytes.length) throw new Error(`the browser stored only ${n} of ${bytes.length} bytes (storage full?)`);
    };
    if (kind === 'ciso') {
      const header = await readSlice(file, 0, CISO_HEADER);
      const blockSize = new DataView(header.buffer).getUint32(4, true);
      const map = header.subarray(8);
      let last = -1;
      let stored = 0;
      for (let i = 0; i < map.length; i++) if (map[i] === 1) { last = i; stored++; }
      if (file.size < CISO_HEADER + stored * blockSize) throw new Error('the CISO image is truncated');
      total = (last + 1) * blockSize;
      let src = CISO_HEADER;
      for (let i = 0; i <= last; i++) {
        if (map[i] === 1) {
          for (let off = 0; off < blockSize; off += CHUNK) {
            const n = Math.min(CHUNK, blockSize - off);
            write(await readSlice(file, src + off, src + off + n), i * blockSize + off);
          }
          src += blockSize;
        } else {
          write(new Uint8Array(blockSize), i * blockSize);
        }
        written = (i + 1) * blockSize;
        progress(written / total);
      }
      if (total < GC_DISC_SIZE) { out.truncate(GC_DISC_SIZE); total = GC_DISC_SIZE; }
    } else {
      for (let at = 0; at < file.size; at += CHUNK) {
        write(await readSlice(file, at, Math.min(file.size, at + CHUNK)), at);
        written = Math.min(file.size, at + CHUNK);
        progress(written / total);
      }
    }
    out.flush();
    const size = out.getSize();
    if (size !== total) throw new Error(`the stored copy has ${size} bytes, ${total} expected (storage full?)`);
    // Read the copy back where a cut copy would differ: the disc header and the end.
    const head = new Uint8Array(0x20);
    out.read(head, { at: 0 });
    if (new DataView(head.buffer).getUint32(0x1c) !== 0xc2339f3d) throw new Error('the stored copy does not read back');
    const tail = new Uint8Array(16);
    if (out.read(tail, { at: size - tail.length }) !== tail.length) throw new Error('the stored copy is short');
    return size;
  } finally {
    out.close();
  }
}

async function commit(size, name) {
  const dir = await bluewakeDir();
  await remove(dir, 'disc.json');
  await remove(dir, 'disc.iso');
  // Game files prepared from an earlier disc belong to that disc.
  await remove(dir, 'game', true);
  const part = await dir.getFileHandle('disc.iso.part');
  await part.move('disc.iso');
  const marker = await dir.getFileHandle('disc.json', { create: true });
  const h = await marker.createSyncAccessHandle();
  try {
    const json = new TextEncoder().encode(JSON.stringify({ name, size, imported: new Date().toISOString() }));
    h.truncate(0);
    h.write(json, { at: 0 });
    h.flush();
  } finally {
    h.close();
  }
}

onmessage = async (event) => {
  const { op, file, kind } = event.data;
  try {
    if (op === 'import') {
      let last = -1;
      const size = await copy(file, kind, (fraction) => {
        const percent = Math.floor(fraction * 100);
        if (percent !== last) { last = percent; postMessage({ type: 'progress', fraction }); }
      });
      await commit(size, file.name);
      postMessage({ type: 'done', size });
    } else if (op === 'remove') {
      const dir = await bluewakeDir();
      for (const name of ['disc.json', 'disc.iso', 'disc.iso.part']) await remove(dir, name);
      await remove(dir, 'game', true);
      postMessage({ type: 'done' });
    }
  } catch (e) {
    try { await remove(await bluewakeDir(), 'disc.iso.part'); } catch (_) { /* keep the first error */ }
    postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
};

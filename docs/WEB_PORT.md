# BlueWake in the browser: design and status

The browser port runs BlueWake's own code (the host, RecompCore's runtime and
the game code DolRecomp translates from the player's disc) as WebAssembly in
the player's browser. It is not an emulator, a video stream or a recreation:
the translated PowerPC code is compiled to WebAssembly as it is compiled to
x86-64 or arm64 for the desktop builds. Building and testing:
[web/README.md](../web/README.md).

## Status

Each milestone is listed with what was actually run. "Compiles" never means
"runs".

| # | Milestone | State |
| --- | --- | --- |
| 1 | GXRuntime's core compiles for wasm32 and its own tests pass | **done, tested**: `gxruntime_tests` (loader, boot, DVD/FST, interrupts, MMIO, ARAM, card, save state…) "GXRuntime tests passed" under Node 26, unchanged source, with an 8 MiB stack |
| 1b | Browser runtime starts: threads, JSPI, OPFS, CPU core, shared disc importer, dlopen of a side module, WebGPU frames on the canvas | **done, tested** (`web/tests/smoke.mjs`): Chrome 154 25/25 with the user's disc (imported in 6 s, revision 0 verified and main.dol + 415 RELs prepared in OPFS in 3.6 s, the last WebGPU frame read back from a screenshot); Firefox 156 24/24 with the disc (headless; its canvas pixel checked in a headful run, 23/23) |
| 2 | Your disc → verified composite source on this machine | **done, tested**: `web/tools/translate.py` reproduces the profile's composite digest `54f54434…a770a` from the user's GZLE01 rev 0 ISO (16 s) |
| 2b | One translated chunk compiles to wasm and loads in both browsers | **done, tested**: the 2.2 MB `chunk_0081` (one of the four largest) compiles at -O2 (94 s, 675 MB); its function is 1,573,770 bytes of code (browsers allow 7,654,321); V8 validates and compiles it (Liftoff 0.2 s, TurboFan 2.2 s); Firefox 156 and Chrome 154 compile the module |
| 2c | The whole game module compiles and links as a wasm side module | in progress (compiling) |
| 3 | The host loads the module and boots the game | **host built and tested up to the module load**: the unchanged host and the donor DSP link as the main module; in Chrome it starts, dlopens a side module from private storage and stops at its missing `staticrecomp_get_module`, as it must for a module that is not the game (`web/tests/boot.mjs`) |
| 4 | Aurora renders through WebGPU | **renderer starts, untested with the game**: Aurora initializes on the browser's WebGPU (adapter, device with BC/ASTC/dual-source blending, surface on the canvas, SDL3 window and audio, pipeline cache, gxcore renderer), runs and shuts down in Chrome 154 and Firefox 156 (`aurora-check.html`, in `web/tests/smoke.mjs`); no game frame has been drawn yet |
| 5 | Audio (AudioWorklet), input (keyboard, Gamepad API), saves in OPFS | not started |
| 6 | Playable | not started |

## How BlueWake works, and what the browser changes

| Area | Desktop | Browser |
| --- | --- | --- |
| Disc input | `.iso`/`.gcm`, validated by `disc_import.c` (GZLE01, main.dol SHA-1 of revision 0), main.dol + 415 RELs extracted | The page copies the image into OPFS (CISO expanded to ISO on the way; RVZ/GCZ refused with a hint); the **same** `disc_import.c`, compiled to wasm, verifies and prepares it there |
| Translation | DolRecomp (C backend, Gekko) → `generate_composite.py` → digest check, at build time on the player's machine | The same, natively, on the player's machine (`web/tools/translate.py` reuses `scripts/linux/build.py`'s stages). Running DolRecomp and a C compiler for 877 MB of C inside a browser is not practical, and shipping translated code is not allowed |
| Generated code | ~750 C units, each one large function with a 4,096-entry computed-goto table (`&&label`) | WebAssembly has no indirect branch; LLVM's wasm backend expands each `goto *table[...]` into a `switch` (IndirectBrExpand). Measured: compiles, validates and runs within browser limits (above) |
| Game module | `gGZLE01_recomp.so/.dll/.dylib`, loaded by the host with `dlopen`; the module embeds its own copy of GXRuntime's CPU core with hidden visibility | A wasm **side module** built by the unchanged `cmake/composite` (Emscripten turns `SHARED` into `-fPIC -shared`), loaded with Emscripten's `dlopen`/`dlsym`. Keeps the same ABI checks, export lookups and the two runtime copies, so host code is unchanged |
| Guest memory | `CPUState.ram` → a 32 MiB allocation; guest addresses resolved as `base + offset`, REL aliases by range lookup | Unchanged: no fixed-address mapping is needed (unlike the Super Mario Sunshine port, which put MEM1 at 0x80000000). wasm32 pointers are 4 bytes; `sizeof(CPUState)` is 3,496 and host and module agree because they are built by the same compiler |
| Rare instructions | DolRecomp leaves them to `CPUState.instruction_fallback` → host's `cold_fallback.c` | Same C, compiled to wasm, verified by the runtime check |
| Floating point | Gekko FPSCR rounding mode and non-IEEE mode set the host FPU (SSE MXCSR / ARM FPCR) | **Divergence**: WebAssembly has round-to-nearest only and no flush-to-zero; GXRuntime already has a portable fallback (no host mode change). Games normally run round-to-nearest; to be watched |
| Threads | Host main loop blocks; Aurora's FIFO worker, pipeline compiles, audio | Emscripten pthreads (needs cross-origin isolation), `PROXY_TO_PTHREAD` so the main loop may block on a worker |
| Graphics | GXRuntime → Aurora (WGSL, `webgpu.h`) → Dawn → Vulkan/Metal/D3D12 | Aurora → `webgpu.h` from **emdawnwebgpu** → the browser's WebGPU. Vulkan is not reachable from a page; WebGPU is the same API Aurora already targets |
| Audio | DSP (Dolphin's interpreter + HLE Zelda ucode) → SDL3 | Same DSP code; output through an AudioWorklet (planned) |
| Input | SDL3 keyboard/gamepads | SDL3's Emscripten port and the Gamepad API (planned) |
| Saves | Memory card files, SRAM, settings | Files in OPFS through WasmFS (planned) |

## Decisions

1. **WebGPU, not WebGL 2.** Aurora already generates WGSL and drives
   `webgpu.h`; emdawnwebgpu provides `webgpu.h` over the browser's WebGPU.
   A WebGL 2 renderer would be a second GX backend written from scratch.
   Measured on this machine (Intel Raptor Lake-P): Chrome 154 offers
   WebGPU in the page and in a worker with an OffscreenCanvas, with
   dual-source blending (GX destination alpha) and BC textures. Firefox 156
   on Linux has WebGPU behind `dom.webgpu.enabled` (with it: adapter, device
   and OffscreenCanvas drawing in a worker, dual-source blending). A WebGL 2
   fallback stays possible later, not planned.
2. **The game is a side module, built by the player.** Translated game code
   is never distributed: the player translates and compiles it from their
   own disc (as `docs/DIRECTION.md` asks of every platform). The hosted page
   carries only the runtime, and loads the player's module from their
   browser's storage. This also keeps the native host/module boundary as is.
3. **Threads + PROXY_TO_PTHREAD + JSPI, not Asyncify.** The host blocks in
   its main loop; WebGPU's adapter/device requests and frame presentation
   must wait for the browser. JSPI suspends the wasm stack at those calls
   (both browsers support it, measured). Asyncify would rewrite every
   function of an 877 MB C program.
4. **The browser has no `wgpuSurfacePresent`** (emdawnwebgpu aborts on it): a
   frame appears when the worker owning the canvas returns to its event
   loop. Aurora's present becomes a JSPI yield (`emscripten_sleep`), which
   the runtime check uses.
5. **RecompCore stays pinned and clean.** Every builder refuses a modified
   `ref/recompcore`. Browser changes to RecompCore, when needed, are kept
   as patches under `web/patches/recompcore/` applied to a separate tree
   in `build/web/`, never pushed to RecompCore without the maintainers
   (AGENTS.md: runtime changes go to RecompCore `bluewake-next` by pull
   request). Shims in `web/` are preferred over patches.

## Known limits and open questions

- **Firefox on Linux** needs `dom.webgpu.enabled`; Safari not tested (no
  Mac here).
- **Build time and memory**: the module is 877 MB of C. Each chunk takes
  up to ~1.5 min and ~0.7 GB at -O2 with the Linux builder's flags
  (`-fno-slp-vectorize -mllvm -large-interval-freq-threshold=10`).
- **Dynamic linking with pthreads** is marked experimental by Emscripten;
  the runtime check loads a side module on the main worker. Side modules
  are loaded lazily on other threads; the game module is called only from
  the host's thread.
- **Compile time in the browser**: the first load compiles the whole module
  (TurboFan took 2.2 s for one of the largest functions); browsers cache
  compiled code for modules fetched by URL, not for bytes from OPFS. To be
  measured on the whole module.
- **Aurora's threads** (FIFO translation worker, pipeline compiler threads,
  texture decoding) call WebGPU from several threads on the desktop; in a
  browser a WebGPU device belongs to one thread. The web backend must keep
  WebGPU calls on the canvas's worker (Aurora's single-threaded paths).

## Development log

Newest first.

### 2026-10-17 (late night) — hosting, and one copy of the game module

- **Hosting.** `web/shell/isolation-sw.js` adds the cross-origin isolation
  headers on hosts that cannot send them (GitHub Pages); the page registers
  it and reloads once. Checked: the smoke test served by a plain
  `http.server` without the headers, 24/24 in Chrome.
  `.github/workflows/web-pages.yml` builds and publishes the site (no game
  code), run by hand only; not run.
- **One copy of the game module.** Emscripten shares a compiled side module
  with the other workers only when the browser's main thread loaded it.
  BlueWake loads it on the host's worker, so each other thread (the main
  thread's asynchronous catch-up, WasmFS's OPFS worker, audio and pipeline
  threads) would copy and compile its own instance of a module of hundreds
  of megabytes. `web/runtime/dylink_sync.js` loads side modules only on the
  thread the entry records (`web_dylink.c`); the others keep their function
  tables in step without instantiating it. Checked: the runtime check's log
  shows the main thread and a worker skipping the side module, which the
  loader thread loads and calls.
- **Module size.** Objects come to 0.61 of the C source: about 530 MB of
  objects for 868 MB of C. `-Os`/`-Oz` do not shrink a chunk (1.61 MB of
  code against 1.57 MB at -O2): translated PowerPC is straight-line code.
  Browsers accept modules up to 1 GB.

### 2026-10-17 (night) — the host and the renderer for the browser

- **Host.** `runtime/host/src` (the Linux list without the ImGui menus and
  the Wii U HD-texture importer) and the donor DSP compile unchanged and link
  as `bluewake.wasm`. `web/runtime/web_host_main.c` is the browser's
  `linux_entry.c`. `settings_menu.h` lists the browser with the platforms
  that have their own menus (the only shared change; native builds see no
  difference). Checked in Chrome: the host dlopens a module from OPFS.
- **Selective exports.** `MAIN_MODULE=1` links every archive whole, and
  CMake repeats archives on the link line for circular dependencies
  (`duplicate symbol` for xxhash, then ImGui). `MAIN_MODULE=2` exports only
  `web/runtime/main_module_exports.txt`: the C library functions the game
  module imports (from its objects: `atexit calloc fiprintf fma free getenv
  ldexp ldexpf stderr`, with a margin). Sizes: runtime check 13.4 → 4.4 MB,
  headless host 25.6 → 16.1 MB.
- **Aurora on WebGPU** (`web/patches/recompcore/0001-aurora-on-browser-webgpu.patch`,
  applied by `web/build.sh` to a worktree of the pinned RecompCore):
  emdawnwebgpu as Dawn, SDL3 from Emscripten's port, no Dawn-native paths,
  canvas surface, Core adapter, render worker not started (a WebGPU device
  belongs to one thread; items run inline, marked as the worker while they
  run), GX FIFO worker off (`DOL_GX_FIFO_WORKER=0`, an existing switch),
  present and buffer-map waits as JSPI suspensions. Problems met: ImGui's
  WebGPU backend refused emdawnwebgpu under `__EMSCRIPTEN__` (compiled as
  Dawn's); `wgpu::LoggingType` is Dawn-only; two `uint64_t`→`size_t`
  narrowings (32-bit); `execinfo.h`; Aurora's own `main()` was linked because
  the browser entry had another signature; `aurora_begin_frame` never
  returned (a buffer map waited for in a sleep loop, which a browser never
  completes); "must run on the render worker" checks; `FS.rmdir is not a
  function` (SDL3's drag-and-drop folder needs the JS FS API:
  `FORCE_FILESYSTEM`); a stale `GXRUNTIME_AURORA_DIR` cache entry pointed at
  the unpatched tree.
- Checked: `web/tests/smoke.mjs` 47/47 (Chrome and Firefox, the renderer
  check included).

### 2026-10-17 (evening) — the browser runtime check

`web/` added: `build.sh` (fetches the pinned RecompCore as the builders do,
then `emcmake` + CMake), `serve.py` (COOP/COEP), the runtime check
(`runtime/web_main.c`, `web_gpu.cpp`), the page (`shell/`) and
`tests/smoke.mjs`. Nothing outside `web/` and this file changed; the native
builders are untouched (`scripts/audit_repo.sh`: AUDIT PASS).

Tested in Chrome 154 and Firefox 156 (headless; Firefox also headful),
Intel Raptor Lake-P, with synthetic images and the user's GZLE01 rev 0 ISO:

- The page refuses random bytes, RVZ (with a Dolphin conversion hint),
  another GameCube game and GZLE01 revision 1 before any copy; a synthetic
  GZLE01 image (no game data) is stored and the runtime's importer rejects
  its main.dol as not revision 0.
- The real ISO is copied into OPFS in 5-7 s; the importer compiled to wasm
  verifies main.dol's SHA-1 and prepares main.dol (3,822,272 bytes) and 415
  RELs in `/opfs/bluewake/game` (Chrome 3.6 s, Firefox 39.6 s).
- threads (main() on a worker, isolated), JSPI (`emscripten_sleep`), CPU
  (24 MiB MEM1, 306 PowerPC instructions through `cold_fallback.c`, results
  and big-endian stores correct, `sizeof(CPUState)` 3,496), OPFS, dlopen (a
  side module loaded on the worker, both exports found, correct result, its
  own data kept), WebGPU (adapter, device with dual-source blending and BC,
  surface on the transferred canvas, 60 frames at 16.6 ms in Chrome and
  17.9 ms in Firefox, the last frame's colour exact in a screenshot).

Problems met and fixed:

1. `wasm-ld: relocation R_WASM_MEMORY_ADDR_LEB cannot be used against
   symbol ...; recompile with -fPIC` → the whole web build is
   position-independent (dynamic linking).
2. `SuspendError: trying to suspend without WebAssembly.promising` in
   `_emscripten_dlsync_self`: with MAIN_MODULE + pthreads + JSPI, a new
   thread's library catch-up calls Emscripten's async (JSPI) loader from its
   mailbox. `web/runtime/dylink_sync.js` makes that loader synchronous,
   which workers allow (Emscripten library override, documented there).
3. Exit handlers released the WebGPU device on the browser's main thread
   (`Cannot set properties of undefined (setting 'onuncapturederror')`) →
   the check keeps its WebGPU objects; the runtime stays alive after main()
   (`-sEXIT_RUNTIME=0`).
4. Firefox blanks a canvas whose worker has ended (measured with a probe:
   Chrome keeps the last frame) → same fix as 3.
5. Headless Firefox screenshots never contain WebGPU canvases (also on the
   main thread, measured) → its pixel is checked with `--headful`.
6. Firefox asks the player before granting persistent storage, and the
   page waited for the answer before copying → it no longer waits.
7. The importer expects its output folder to exist (its CLI creates it).
8. WasmFS cannot rename a directory on OPFS (`EBUSY`, a TODO in Emscripten's
   OPFS backend), which the importer's final swap does → the unchanged
   importer prepares into WasmFS memory and the runtime publishes the files
   into OPFS one by one (`.part` + rename) with a `prepared` marker last.

### 2026-10-17 — investigation, first wasm builds

Environment: Linux Mint 22.3, Intel Raptor Lake-P, Emscripten 6.0.12
(`~/dev/emsdk`), CMake 3.28.3, gcc 13, Node 26, Chrome 154, Chromium 153,
Firefox 156; about 2 GB of free memory during the work.

- `feature/web-port` created from `main` (145435b). RecompCore 338a3db and
  DolRecomp b8b5345 fetched as pinned.
- GXRuntime core: configured with `emcmake` (Aurora off), compiled and linked
  unchanged. `gxruntime_tests` first trapped in `cpu_init`
  (`memory access out of bounds`): the tests keep `CPUState` on the stack and
  Emscripten's default stack is 64 KiB; with `-sSTACK_SIZE=8MB` (the Linux
  default) the whole suite passes. Both guest-memory bounds tests pass.
- Browser capabilities measured with a probe page (headless): Chrome 154
  (with `--enable-unsafe-webgpu --enable-features=Vulkan`) and Firefox 156
  (with `dom.webgpu.enabled`): cross-origin isolation, SharedArrayBuffer,
  JSPI, wasm exceptions, memory64, 2.5 GB memory growth, AudioWorklet,
  Gamepad API, OPFS sync access handles in workers, WebGPU in the page and in
  a worker with OffscreenCanvas drawing. Firefox without the pref: no
  `navigator.gpu`.
- The user's disc: GZLE01 revision 0, main.dol SHA-1
  8d28bab68bb5078c38e43f29206f0bd01f7e7a67 (the supported one).
  `web/tools/translate.py` (the Linux builder's dependency, disc, extract,
  translate and generate stages, with the extractor built by `cc` and the
  translator by Make) produced the verified composite (digest
  `54f54434c3f9…a770a`) in 16 s: 206 DOL chunks, 415 RELs.
- One chunk to wasm: see milestone 2b. `wasm-dis` of that module wrote a
  5.2 GB text file (the switch lowering nests 4,096 blocks deep): do not
  disassemble whole chunks.

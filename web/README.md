# web/ — BlueWake in the browser (WebAssembly)

The browser port of BlueWake: the same host, runtime and translated game code
the desktop builds compile, built with Emscripten for WebAssembly and run in
the player's browser from their own disc. Design, decisions and status:
[docs/WEB_PORT.md](../docs/WEB_PORT.md).

**Status: early development.** The browser runtime starts and passes its
checks; the host and the renderer (Aurora on WebGPU) build and start; the
game module compiles to WebAssembly from your disc. The game has not run in
the browser yet.

| Path | What |
| --- | --- |
| `build.sh` | fetch the pinned RecompCore (as every builder does), configure `build/web/` with `emcmake`, build |
| `serve.py` | local server with the cross-origin isolation headers WebAssembly threads need |
| `CMakeLists.txt` | browser targets: `bluewake_web_runtime` (the runtime check), `bluewake_web_host` (the host, `bluewake.mjs`), `bluewake_web_aurora_check` (the renderer check), `bluewake_web_site` (the page) |
| `runtime/` | browser-only code: the runtime check (`web_main.c`, `web_gpu.cpp`), the host's entry (`web_host_main.c`), the renderer check (`web_aurora_check.c`), the no-renderer stand-in for `AURORA=0` builds (`web_aurora_stub.c`), a side-module fixture (`web_side_test.c`), the main module's exports (`main_module_exports.txt`), an Emscripten loader override (`dylink_sync.js`) |
| `patches/recompcore/` | RecompCore changes for the browser, applied by `build.sh` to a worktree of the pinned commit in `build/web/recompcore` (`ref/recompcore` stays exactly as pinned for the native builders) |
| `shell/` | the page: `index.html`, `app.js`, `style.css`, `import-worker.js` (disc copy into private storage) |
| `tools/translate.py` | your disc → the verified composite source (the Linux builder's own stages, without its desktop toolchain) |
| `tools/ciso_to_iso.py` | expand a CISO image into the ISO the native builders read |
| `tests/smoke.mjs` | browser test in Chrome and Firefox (synthetic images; your disc with `--disc`; the renderer check) |
| `tests/boot.mjs` | imports your disc and your game module and starts the host; reports how far the game runs |

## Toolchain

The Emscripten SDK, installed per user:

```sh
git clone https://github.com/emscripten-core/emsdk.git ~/dev/emsdk
~/dev/emsdk/emsdk install latest && ~/dev/emsdk/emsdk activate latest
```

`build.sh` finds it through `EMSDK`, `emcc` on `PATH`, `~/dev/emsdk` or
`~/emsdk`. Also needed: CMake 3.25+ (not 4.2.0-4.2.5 or 4.3.0-4.3.2, which
break Emscripten shared libraries), git, Python 3. Tested with emcc 6.0.12 and
CMake 3.28.

## Build and run

```sh
web/build.sh                  # build/web/site/
python3 web/serve.py          # http://127.0.0.1:8080/
```

Open the page in Chrome or Edge (or Firefox: on Linux, set
`dom.webgpu.enabled` to `true` in `about:config`; Firefox has not enabled
WebGPU there by default). It reports what the browser offers, lets you choose
your disc image (ISO, GCM or CISO; RVZ/GCZ are refused with a hint to convert
them in Dolphin) and runs the runtime check.

Your disc image is read with the File API and copied into this site's
origin-private file system (OPFS) in your browser; it is never uploaded. The
runtime check then verifies it with the importer every platform uses
(`apple/ios/src/disc_import.c`: GZLE01, main.dol's revision 0 SHA-1) and
prepares main.dol and the 415 RELs beside it, as the iPhone app does on first
run. **Remove stored disc** deletes all of it.

## Your game module

The game code is translated from your disc on your computer and is yours
alone: it is never committed, uploaded or deployed.

```sh
python3 web/tools/translate.py /path/to/GZLE01.iso      # build/web-game/composite-src (verified digest)
source ~/dev/emsdk/emsdk_env.sh
emcmake cmake -S cmake/composite -B build/web-game/module -DCMAKE_BUILD_TYPE=Release \
  "-DCMAKE_C_FLAGS=-pthread -fno-slp-vectorize -mllvm -large-interval-freq-threshold=10" \
  -DCMAKE_SHARED_LINKER_FLAGS=-pthread -DCOMPOSITE_DIR=$PWD/build/web-game/composite-src \
  -DGXRUNTIME_DIR=$PWD/ref/recompcore/GXRuntime \
  -DABI_DIR=$PWD/ref/recompcore/Source/Core/Core/PowerPC/StaticRecomp
cmake --build build/web-game/module -j2      # hours; about 0.7 GB of memory per job
```

This produces `gGZLE01_recomp.so`, a WebAssembly side module, from the
unchanged `cmake/composite` build. The browser host will load it with
`dlopen`, as the desktop host loads its native module.

## Tests

```sh
(cd web/tests && npm install)            # Playwright and puppeteer-core; the system browsers are used
node web/tests/smoke.mjs                 # Chrome and Firefox, synthetic images only
node web/tests/smoke.mjs --disc /path/to/GZLE01.iso    # also imports and prepares your disc
node web/tests/smoke.mjs --browser firefox
```

`BLUEWAKE_TEST_CHROME` and `BLUEWAKE_TEST_FIREFOX` choose the browser
binaries. Each browser runs headless in a throwaway profile; a disc given with
`--disc` is copied only into that profile, which is deleted afterwards.

## Privacy

The page never sends the disc image anywhere. Never put a disc image,
anything extracted from one, or a translated game module in this repository
or in a deployed site.

// Emscripten library override: load side modules synchronously.
//
// With -sJSPI, Emscripten's _dlopen_js (libdylink.js) loads a side module
// asynchronously and is a suspending import. It is also what every pthread
// calls to catch up with modules loaded elsewhere (_emscripten_dlsync_self),
// and that runs from the thread's mailbox, which JSPI did not enter: the
// first thread started after main() (WasmFS's OPFS worker, measured) died
// with "SuspendError: trying to suspend without WebAssembly.promising".
//
// BlueWake loads its game module with dlopen from worker threads only, and a
// worker may read and compile a module synchronously, so the synchronous
// loader (Emscripten's own path without Asyncify/JSPI) is correct here.
// Revisit when Emscripten makes the catch-up path JSPI-aware.
addToLibrary({
  _dlopen_js__deps: ['$dlopenInternal'],
  _dlopen_js__async: false,
  _dlopen_js: (handle) => dlopenInternal(handle, { loadAsync: false }),
});

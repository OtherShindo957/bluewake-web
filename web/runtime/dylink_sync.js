// Emscripten library overrides for BlueWake's side module (the game module).
//
// 1. Load synchronously. With -sJSPI, Emscripten's _dlopen_js (libdylink.js)
//    loads a side module asynchronously and is a suspending import. It is also
//    what every pthread calls to catch up with modules loaded elsewhere
//    (_emscripten_dlsync_self), from the thread's mailbox, which JSPI did not
//    enter: the first thread started after main() (WasmFS's OPFS worker,
//    measured) died with "SuspendError: trying to suspend without
//    WebAssembly.promising". A worker may read and compile a module
//    synchronously, so the synchronous loader is correct here.
//
// 2. Load only on the thread that dlopens. Emscripten shares a compiled side
//    module with other workers only when the browser's main thread loaded it;
//    loaded on a worker (the host's thread), every other thread catching up
//    copies the module's bytes and compiles its own instance. The game module
//    is hundreds of megabytes and only the host's thread calls into it, so the
//    other threads (and the main thread's asynchronous catch-up) keep their
//    function tables in step - the same indices reserved, left empty - without
//    instantiating it. The loader thread is recorded by the entry
//    (web_dylink.c); with none recorded, every thread loads, as Emscripten does.
//
// Revisit when Emscripten makes the catch-up path JSPI-aware and shares
// modules loaded on workers.
addToLibrary({
  $bluewakeLoadsHere__deps: ['bluewake_dl_loads_here'],
  $bluewakeLoadsHere: () => !!_bluewake_dl_loads_here(),

  // Reserves the library's table range on this thread without loading it.
  $bluewakeKeepTableInStep__deps: ['$wasmTable'],
  $bluewakeKeepTableInStep: (handle) => {
    var end = {{{ makeGetValue('handle', C_STRUCTS.dso.table_addr, '*') }}} +
              {{{ makeGetValue('handle', C_STRUCTS.dso.table_size, '*') }}};
    var length = Number(wasmTable.length);
    if (end > length) wasmTable.grow({{{ toIndexType('end - length') }}});
    err(`[web] ${UTF8ToString(handle + {{{ C_STRUCTS.dso.name }}})}: not instantiated on this thread ` +
        `(${ENVIRONMENT_IS_PTHREAD ? 'a worker' : 'the main thread'}; only the loader thread runs it)`);
    return handle;
  },

  _dlopen_js__deps: ['$dlopenInternal', '$bluewakeLoadsHere', '$bluewakeKeepTableInStep'],
  _dlopen_js__async: false,
  _dlopen_js: (handle) => bluewakeLoadsHere() ? dlopenInternal(handle, { loadAsync: false })
                                              : bluewakeKeepTableInStep(handle),

  _emscripten_dlopen_js__deps: ['$dlopenInternal', '$callUserCallback', '$dlSetError',
                                '$bluewakeLoadsHere', '$bluewakeKeepTableInStep'],
  _emscripten_dlopen_js: (handle, onsuccess, onerror, user_data) => {
    if (!bluewakeLoadsHere()) {
      bluewakeKeepTableInStep(handle);
      callUserCallback(() => {{{ makeDynCall('vpp', 'onsuccess') }}}(handle, user_data));
      return;
    }
    /** @param {Object=} e */
    function errorCallback(e) {
      var filename = UTF8ToString(handle + {{{ C_STRUCTS.dso.name }}});
      dlSetError(`'Could not load dynamic lib: ${filename}\n${e}`);
      {{{ runtimeKeepalivePop() }}}
      callUserCallback({{{ makeDynCall('vpp', 'onerror') }}}, handle, user_data);
    }
    function successCallback() {
      {{{ runtimeKeepalivePop() }}}
      callUserCallback({{{ makeDynCall('vpp', 'onsuccess') }}}, handle, user_data);
    }
    {{{ runtimeKeepalivePush() }}}
    var promise = dlopenInternal(handle, { loadAsync: true });
    if (promise) {
      promise.then(successCallback, errorCallback);
    } else {
      errorCallback();
    }
  },

  // A dlsym on the loader thread put a function in the table: take the same
  // slot here, so later slots keep the same indices on every thread.
  _dlsym_catchup_js__deps: ['$addFunction', '$getEmptyTableSlot', '$bluewakeLoadsHere'],
  _dlsym_catchup_js: (handle, symbolIndex) => {
    if (!bluewakeLoadsHere()) return getEmptyTableSlot();
    var lib = LDSO.loadedLibsByHandle[handle];
    var symDict = lib.exports;
    var symName = Object.keys(symDict)[symbolIndex];
    var sym = symDict[symName];
    return addFunction(sym, sym.sig);
  },
});

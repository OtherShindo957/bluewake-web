// Which thread loads side modules (see dylink_sync.js).
//
// The browser entries record their own thread here before the code that
// calls dlopen runs: the host's thread loads the game module and is the only
// one that calls into it. Other threads keep their function tables in step
// with it but do not compile and instantiate the module themselves.
#include <emscripten/emscripten.h>
#include <pthread.h>
#include <stdatomic.h>

static _Atomic(pthread_t) s_loader_thread;

void bluewake_dl_set_loader_thread(void)
{
    atomic_store(&s_loader_thread, pthread_self());
}

// 1 when this thread should load side modules: the recorded loader thread,
// or every thread when none was recorded (Emscripten's own behaviour).
EMSCRIPTEN_KEEPALIVE int bluewake_dl_loads_here(void)
{
    const pthread_t loader = atomic_load(&s_loader_thread);
    return loader == 0 || pthread_equal(loader, pthread_self());
}

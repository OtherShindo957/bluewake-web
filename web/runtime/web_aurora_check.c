// Renderer check (milestone 4, in progress): starts GXRuntime's Aurora backend
// as the host does (runtime/host/src/main.c, dol_aurora_initialize) on the
// worker that owns the page's canvas, keeps it presenting for a few seconds
// and shuts it down. It needs no game: what it shows is whether Aurora's
// window, WebGPU device and frame loop come up in the browser.
#include <emscripten/emscripten.h>
#include <stdio.h>
#include <stdlib.h>

#include "gxruntime/aurora_backend.h"

int main(int argc, char** argv)
{
    const AuroraBackendConfig config = {
        .app_name = "BlueWake",
        .window_width = 640u,
        .window_height = 480u,
        .vsync = true,
        .info_logging = true,
    };
    printf("[aurora-check] initializing\n");
    if (!dol_aurora_initialize(argc, argv, &config)) {
        printf("[aurora-check] FAIL: dol_aurora_initialize returned false\n");
        return 1;
    }
    const char* api = dol_aurora_backend_name();
    printf("[aurora-check] initialized: backend %s\n", api != NULL ? api : "(null)");
    const double start = emscripten_get_now();
    unsigned frames = 0;
    while (emscripten_get_now() - start < 3000.0) {
        aurora_backend_service_present();
        emscripten_sleep(16);
        ++frames;
    }
    DolAuroraFrameTiming timing;
    dol_aurora_frame_timing(&timing);
    printf("[aurora-check] %u host turns, %llu presents, %llu shown\n", frames, timing.presents, timing.shown);
    dol_aurora_shutdown();
    printf("[aurora-check] done\n");
    return 0;
}

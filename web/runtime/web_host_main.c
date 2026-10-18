// BlueWake browser entry: the counterpart of linux/src/linux_entry.c.
//
// main() runs on a worker (PROXY_TO_PTHREAD). It mounts the origin-private
// file system, fills in the default paths there and the Linux shim's
// defaults, then runs the unchanged host (runtime/host/src/main.c, compiled
// with main renamed to bluewake_host_main) with the player's game module.
//
// Private storage (OPFS, this site only, never uploaded):
//   /opfs/bluewake/disc.iso            the disc image the game reads (imported by the page)
//   /opfs/bluewake/game/main.dol, rels prepared from it (the runtime check, disc_import.c)
//   /opfs/bluewake/gGZLE01_recomp.so   the player's game module (built from their disc, imported by the page)
//   /opfs/bluewake/user/               memory card, SRAM, settings, save states
// Every default is only a default: a variable the page passes in
// (Module.bluewakeEnv) wins, as an environment variable does on the desktop.
#include <emscripten/emscripten.h>
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

int bluewake_host_main(int argc, char** argv);

#define OPFS_ROOT "/opfs"
#define BLUEWAKE_DIR OPFS_ROOT "/bluewake"

static void bw_default(const char* name, const char* value)
{
    const char* existing = getenv(name);
    if (existing != NULL && existing[0] != '\0')
        return;
    setenv(name, value, 1);
}

// Variables the page passes in: Module.bluewakeEnv = {NAME: "value", ...}.
EM_JS(char*, page_env, (void), {
    const env = Module['bluewakeEnv'] || {};
    const text = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
    return text ? stringToNewUTF8(text) : 0;
});

static void apply_page_env(void)
{
    char* text = page_env();
    if (text == NULL)
        return;
    for (char* line = strtok(text, "\n"); line != NULL; line = strtok(NULL, "\n")) {
        char* eq = strchr(line, '=');
        if (eq == NULL || eq == line)
            continue;
        *eq = '\0';
        setenv(line, eq + 1, 1);
        printf("[web] %s=%s\n", line, eq + 1);
    }
    free(text);
}

static int mount_opfs(void)
{
    struct stat st;
    if (stat(OPFS_ROOT, &st) == 0)
        return 0;
    backend_t opfs = wasmfs_create_opfs_backend();
    if (opfs == NULL || wasmfs_create_directory(OPFS_ROOT, 0777, opfs) != 0) {
        fprintf(stderr, "[web] cannot mount the origin-private file system (errno %d)\n", errno);
        return -1;
    }
    return 0;
}

// main(argc, argv), as Aurora's own entry (aurora::main) defines it: with that
// signature, this is the program's entry and Aurora's is never linked.
int main(int argc, char** argv)
{
    (void)argc;
    (void)argv;
    printf("[web] BlueWake host starting\n");
    if (mount_opfs() != 0)
        return 1;
    mkdir(BLUEWAKE_DIR, 0777);
    mkdir(BLUEWAKE_DIR "/user", 0777);
    apply_page_env();

    // The Linux shim's defaults (linux/src/linux_entry.c).
    bw_default("BLUEWAKE_PERF_LOG", "1");
    bw_default("BLUEWAKE_WALL_PACE", "1");
    bw_default("DOL_AUDIO_NO_THROTTLE", "1");
#if BLUEWAKE_WEB_AURORA
    // BLUEWAKE_RENDERER unset: Aurora, and headless if it cannot start (no
    // WebGPU in this browser), as the desktop host does without a window.
    // A WebGPU device belongs to the thread that made it (emdawnwebgpu): GX
    // is translated on the guest's thread, which owns the canvas, instead of
    // on Aurora's FIFO worker thread.
    bw_default("DOL_GX_FIFO_WORKER", "0");
#else
    bw_default("BLUEWAKE_RENDERER", "headless");
#endif
    bw_default("BLUEWAKE_CYCLE_CAP", "16384");
    bw_default("BLUEWAKE_MAX_BLOCKS", "100000000000");
    bw_default("BLUEWAKE_DSP_MODE", "hle");
    bw_default("BLUEWAKE_CLOCK", "now");
    bw_default("BLUEWAKE_SRAM", BLUEWAKE_DIR "/user/sram.bin");
    bw_default("BLUEWAKE_CARD_PATH", BLUEWAKE_DIR "/user/GZLE01.card");
    bw_default("BLUEWAKE_STATE_DIR", BLUEWAKE_DIR "/user/");
    bw_default("BLUEWAKE_SETTINGS", BLUEWAKE_DIR "/user/settings.ini");
    bw_default("DOL_AURORA_CACHE_DIR", BLUEWAKE_DIR "/user/");
    bw_default("DOL_AURORA_USER_DIR", BLUEWAKE_DIR "/user/");
    bw_default("BLUEWAKE_DOL", BLUEWAKE_DIR "/game/main.dol");
    bw_default("BLUEWAKE_RELS_DIR", BLUEWAKE_DIR "/game/rels");
    bw_default("BLUEWAKE_DISC", BLUEWAKE_DIR "/disc.iso");
    bw_default("BLUEWAKE_MODULE", BLUEWAKE_DIR "/gGZLE01_recomp.so");

    struct stat st;
    const char* module = getenv("BLUEWAKE_MODULE");
    if (stat(module, &st) != 0) {
        fprintf(stderr, "[web] no game module at %s: build yours from your disc and import it (web/README.md)\n",
                module);
        return 1;
    }
    printf("[web] game module %s (%.1f MiB)\n", module, st.st_size / 1048576.0);
    if (stat(getenv("BLUEWAKE_DOL"), &st) != 0) {
        fprintf(stderr, "[web] the disc is not prepared yet (%s is missing): import it and run the check\n",
                getenv("BLUEWAKE_DOL"));
        return 1;
    }
    char* host_argv[] = {"bluewake", (char*)module, NULL};
    const int rc = bluewake_host_main(2, host_argv);
    printf("[web] host exited with %d\n", rc);
    return rc;
}

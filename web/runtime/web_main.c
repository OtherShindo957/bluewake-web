// The browser runtime check (milestone 1 of docs/WEB_PORT.md).
//
// main() runs on a worker (PROXY_TO_PTHREAD), where blocking is allowed, as
// the host's main loop will. Each step reports its real result on stdout
// (web_check.h), which the page shows and the browser tests read:
//   threads  running on a worker, in a cross-origin isolated page
//   jspi     a blocking call can wait for the browser (emscripten_sleep)
//   cpu      GXRuntime's CPUState and 24 MiB MEM1, and a PowerPC program run
//            by the host's instruction fallback (runtime/host/src/cold_fallback.c)
//   opfs     the origin-private file system mounted at /opfs (WasmFS)
//   disc     the imported disc checked and prepared by the shared importer
//            (apple/ios/src/disc_import.c): GZLE01, main.dol's revision 0
//            SHA-1, 415 RELs, written to /opfs/bluewake/game
//   dlopen   a side module loaded and called the way the host loads the game
//   webgpu   instance, adapter, device and frames on the page's canvas
#include <dirent.h>
#include <dlfcn.h>
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "cold_fallback.h"
#include "core/cpu.h"
#include "disc_import.h"
#include "web_check.h"

#define OPFS_ROOT "/opfs"
#define BLUEWAKE_DIR OPFS_ROOT "/bluewake"
#define DISC_PATH BLUEWAKE_DIR "/disc.iso"
#define GAME_DIR BLUEWAKE_DIR "/game"

static int s_passed, s_failed, s_skipped;

static void report(const char* status, const char* name, const char* fmt, va_list ap)
{
    char detail[512];
    vsnprintf(detail, sizeof(detail), fmt, ap);
    printf("[check] %s: %s - %s\n", name, status, detail);
    fflush(stdout);
}

int web_check(bool ok, const char* name, const char* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    report(ok ? "ok" : "FAIL", name, fmt, ap);
    va_end(ap);
    if (ok)
        ++s_passed;
    else
        ++s_failed;
    return ok ? 0 : 1;
}

void web_check_skip(const char* name, const char* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    report("skipped", name, fmt, ap);
    va_end(ap);
    ++s_skipped;
}

EM_JS(int, page_is_isolated, (void), { return self.crossOriginIsolated ? 1 : 0; });

static void check_threads(void)
{
    const bool worker = !emscripten_is_main_browser_thread();
    web_check(worker && page_is_isolated(), "threads", "main() on a worker: %s; cross-origin isolated: %s; %d cores",
              worker ? "yes" : "no", page_is_isolated() ? "yes" : "no", emscripten_num_logical_cores());
}

static void check_jspi(void)
{
    const double before = emscripten_get_now();
    emscripten_sleep(20);
    const double waited = emscripten_get_now() - before;
    web_check(waited >= 15.0, "jspi", "emscripten_sleep(20) suspended the stack for %.1f ms", waited);
}

// lis r4,0x8030; li r3,0; loop: addi r3,r3,7; cmpwi r3,700; blt loop;
// ori r3,r3,0x1000; stw r3,0x10(r4); lwz r5,0x10(r4); blr
static const u32 kProgram[] = {
    0x3C808030u, 0x38600000u, 0x38630007u, 0x2C0302BCu, 0x4180FFF8u,
    0x60631000u, 0x90640010u, 0x80A40010u, 0x4E800020u,
};
#define PROGRAM_PC 0x80003100u
#define RETURN_SENTINEL 0x8180FFF0u

static void check_cpu(void)
{
    static CPUState cpu;
    if (!cpu_init(&cpu)) {
        web_check(false, "cpu", "cpu_init could not allocate MEM1");
        return;
    }
    for (u32 i = 0; i < sizeof(kProgram) / sizeof(kProgram[0]); ++i)
        mem_write32(&cpu, PROGRAM_PC + 4u * i, kProgram[i]);
    cpu.pc = PROGRAM_PC;
    cpu.lr = RETURN_SENTINEL;
    u32 executed = 0;
    while (cpu.pc != RETURN_SENTINEL && executed < 10000u && cpu.exception == 0u) {
        const u32 cia = cpu.pc;
        const u32 raw = mem_read32(&cpu, cia);
        cpu.pc = cia + 4u;
        if (!bluewake_cold_fallback_execute(&cpu, raw, cia)) {
            web_check(false, "cpu", "the fallback does not execute 0x%08X at 0x%08X", raw, cia);
            cpu_free(&cpu);
            return;
        }
        ++executed;
    }
    const u8* stored = cpu.ram + 0x00300010u;
    const bool big_endian = stored[0] == 0x00 && stored[1] == 0x00 && stored[2] == 0x12 && stored[3] == 0xBC;
    const bool ok = cpu.pc == RETURN_SENTINEL && cpu.gpr[3] == 0x12BCu && cpu.gpr[5] == 0x12BCu && big_endian;
    web_check(ok, "cpu", "MEM1 %u MiB; %u PowerPC instructions through the host's fallback: r3=0x%X r5=0x%X, "
              "stored big-endian %s, CPUState %zu bytes",
              cpu.ram_size >> 20, executed, cpu.gpr[3], cpu.gpr[5], big_endian ? "yes" : "no", sizeof(CPUState));
    cpu_free(&cpu);
}

static bool check_opfs(void)
{
    struct stat st;
    if (stat(OPFS_ROOT, &st) != 0) {
        backend_t opfs = wasmfs_create_opfs_backend();
        if (opfs == NULL || wasmfs_create_directory(OPFS_ROOT, 0777, opfs) != 0)
            return web_check(false, "opfs", "cannot mount the origin-private file system (errno %d)", errno) == 0;
    }
    mkdir(BLUEWAKE_DIR, 0777);
    const char* probe = BLUEWAKE_DIR "/.runtime-check";
    FILE* f = fopen(probe, "wb");
    bool ok = f != NULL && fwrite("ok", 1, 2, f) == 2;
    if (f != NULL)
        ok = fclose(f) == 0 && ok;
    unlink(probe);
    return web_check(ok, "opfs", "mounted at " OPFS_ROOT "; write and remove in " BLUEWAKE_DIR) == 0;
}

static int count_rels(const char* dir)
{
    DIR* d = opendir(dir);
    if (d == NULL)
        return -1;
    int n = 0;
    for (struct dirent* e; (e = readdir(d)) != NULL;) {
        const size_t len = strlen(e->d_name);
        if (len > 4 && strcmp(e->d_name + len - 4, ".rel") == 0)
            ++n;
    }
    closedir(d);
    return n;
}

static void import_progress(void* context, double fraction, const char* stage)
{
    int* last = context;
    const int percent = (int)(fraction * 100.0);
    if (percent / 10 != *last / 10) {
        printf("[import] %3d%% %s\n", percent, stage != NULL ? stage : "");
        fflush(stdout);
        *last = percent;
    }
}

// Copies one file into OPFS beside its final name and moves it into place, so
// a cut copy never looks complete.
static bool publish_file(const char* from, const char* to)
{
    char part[512];
    snprintf(part, sizeof(part), "%s.part", to);
    FILE* in = fopen(from, "rb");
    FILE* out = in != NULL ? fopen(part, "wb") : NULL;
    bool ok = in != NULL && out != NULL;
    static char buffer[1 << 16];
    for (size_t n; ok && (n = fread(buffer, 1, sizeof(buffer), in)) > 0;)
        ok = fwrite(buffer, 1, n, out) == n;
    if (in != NULL)
        ok = !ferror(in) && ok, fclose(in);
    if (out != NULL)
        ok = fclose(out) == 0 && ok;
    ok = ok && rename(part, to) == 0;
    if (!ok)
        unlink(part);
    return ok;
}

// Moves the importer's finished tree (main.dol, rels/*.rel) from memory into
// OPFS file by file. WasmFS cannot rename a directory on OPFS (its backend
// returns EBUSY), which the importer's final swap does, so the importer runs
// unchanged in memory and this publishes its result. The marker is written
// last: without it, the game files are prepared again.
static int publish_game(const char* from_dir)
{
    char from[512], to[512];
    mkdir(GAME_DIR, 0777);
    mkdir(GAME_DIR "/rels", 0777);
    unlink(GAME_DIR "/prepared");
    snprintf(from, sizeof(from), "%s/main.dol", from_dir);
    if (!publish_file(from, GAME_DIR "/main.dol"))
        return -1;
    snprintf(from, sizeof(from), "%s/rels", from_dir);
    DIR* d = opendir(from);
    if (d == NULL)
        return -1;
    int published = 0;
    for (struct dirent* e; (e = readdir(d)) != NULL;) {
        const size_t len = strlen(e->d_name);
        if (len <= 4 || strcmp(e->d_name + len - 4, ".rel") != 0)
            continue;
        snprintf(from, sizeof(from), "%s/rels/%s", from_dir, e->d_name);
        snprintf(to, sizeof(to), GAME_DIR "/rels/%s", e->d_name);
        if (!publish_file(from, to)) {
            closedir(d);
            return -1;
        }
        unlink(from);
        ++published;
    }
    closedir(d);
    FILE* marker = fopen(GAME_DIR "/prepared", "wb");
    if (marker == NULL || fprintf(marker, "%d\n", published) < 0 || fclose(marker) != 0)
        return -1;
    return published;
}

static void check_disc(void)
{
    struct stat st;
    if (stat(DISC_PATH, &st) != 0) {
        web_check_skip("disc", "no disc imported yet (choose your GZLE01 image on the page)");
        return;
    }
    char error[512] = "";
    if (bluewake_disc_check(DISC_PATH, error, sizeof(error)) != 0) {
        web_check(false, "disc", "%s", error);
        return;
    }
    struct stat dol, marker;
    if (stat(GAME_DIR "/prepared", &marker) == 0 && stat(GAME_DIR "/main.dol", &dol) == 0 &&
        count_rels(GAME_DIR "/rels") == 415) {
        web_check(true, "disc", "GZLE01, %.1f MiB; already prepared: main.dol %lld bytes and 415 RELs in " GAME_DIR,
                  st.st_size / 1048576.0, (long long)dol.st_size);
        return;
    }
    // The importer writes into an existing folder (its callers create it, as
    // scripts/ios/disc_extract.c does); in memory (WasmFS's default backend).
    const char* staging = "/tmp/bluewake-game";
    mkdir("/tmp", 0777);
    mkdir(staging, 0777);
    const double start = emscripten_get_now();
    int last = -10;
    if (bluewake_disc_prepare(DISC_PATH, staging, import_progress, &last, error, sizeof(error)) != 0) {
        web_check(false, "disc", "%s", error);
        return;
    }
    const int prepared = count_rels("/tmp/bluewake-game/rels");
    const int published = publish_game(staging);
    unlink("/tmp/bluewake-game/main.dol");
    rmdir("/tmp/bluewake-game/rels");
    rmdir(staging);
    const bool ok = published == 415 && prepared == 415 && stat(GAME_DIR "/main.dol", &dol) == 0 &&
                    count_rels(GAME_DIR "/rels") == 415;
    web_check(ok, "disc", "GZLE01 revision 0 (main.dol SHA-1 verified), %.1f MiB; prepared main.dol %lld bytes and "
              "%d RELs into " GAME_DIR " in %.1f s",
              st.st_size / 1048576.0, ok ? (long long)dol.st_size : 0LL, published,
              (emscripten_get_now() - start) / 1000.0);
}

// Fetches a file of the site into wasm memory (JSPI suspends this worker's
// stack while the browser downloads it).
EM_ASYNC_JS(void*, fetch_site_file, (const char* name, size_t* size), {
    const response = await fetch(UTF8ToString(name));
    if (!response.ok)
        return 0;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const ptr = _malloc(bytes.length);
    HEAPU8.set(bytes, ptr);
    HEAPU32[size >> 2] = bytes.length;
    return ptr;
});

static void check_dlopen(void)
{
    size_t size = 0;
    void* bytes = fetch_site_file("side-test.wasm", &size);
    if (bytes == NULL) {
        web_check(false, "dlopen", "side-test.wasm is missing from the site");
        return;
    }
    const char* path = "/tmp/side-test.so";
    mkdir("/tmp", 0777);
    FILE* f = fopen(path, "wb");
    const bool written = f != NULL && fwrite(bytes, 1, size, f) == size;
    if (f != NULL)
        fclose(f);
    free(bytes);
    if (!written) {
        web_check(false, "dlopen", "cannot write %s", path);
        return;
    }
    void* lib = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (lib == NULL) {
        web_check(false, "dlopen", "%s", dlerror());
        return;
    }
    unsigned (*mix)(unsigned) = (unsigned (*)(unsigned))dlsym(lib, "bluewake_side_test_mix");
    unsigned (*calls)(void) = (unsigned (*)(void))dlsym(lib, "bluewake_side_test_calls");
    if (mix == NULL || calls == NULL) {
        web_check(false, "dlopen", "dlsym: %s", dlerror());
        return;
    }
    // The same computation here, to compare.
    unsigned seed = 1234u, expected = 0;
    for (unsigned i = 0; i < 64; ++i) {
        seed = seed * 1664525u + 1013904223u;
        expected ^= seed >> (i & 7);
    }
    const unsigned got = mix(1234u);
    mix(1u);
    web_check(got == expected && calls() == 2u, "dlopen",
              "side module (%zu bytes) loaded on this worker; dlsym found both exports; result 0x%08X (expected "
              "0x%08X); its own data counted %u calls",
              size, got, expected, calls());
}

int main(void)
{
    printf("[web] BlueWake browser runtime check\n");
    check_threads();
    check_jspi();
    check_cpu();
    if (check_opfs())
        check_disc();
    else
        web_check_skip("disc", "needs the origin-private file system");
    check_dlopen();
    const char* frames = getenv("BLUEWAKE_WEB_FRAMES");
    bluewake_web_gpu_check(frames != NULL ? atoi(frames) : 60);
    printf("[check] done: %d passed, %d failed, %d skipped\n", s_passed, s_failed, s_skipped);
    fflush(stdout);
    return s_failed == 0 ? 0 : 1;
}

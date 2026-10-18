// The renderer API the host calls (GXRuntime's gxruntime/aurora_backend.h and
// the parts of Aurora's headers the host uses), answered "no renderer" until
// Aurora runs on WebGPU in the browser (docs/WEB_PORT.md, milestone 4).
//
// dol_aurora_initialize() returning false is the case the host already
// handles natively when no window can be opened: it installs GXRuntime's
// headless backend (runtime/host/src/main.c, "falling back to headless") and
// runs the game without a picture. Nothing here draws or pretends to.
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "gxruntime/aurora_backend.h"

bool dol_aurora_initialize(int argc, char** argv, const AuroraBackendConfig* config)
{
    (void)argc;
    (void)argv;
    (void)config;
    fprintf(stderr, "[web] Aurora is not built for the browser yet: no renderer\n");
    return false;
}

void dol_aurora_shutdown(void) {}
void dol_aurora_set_overlay(DolAuroraOverlayFn draw, void* user) { (void)draw; (void)user; }
void dol_aurora_set_event_observer(DolAuroraEventObserverFn observe, void* user) { (void)observe; (void)user; }
void dol_aurora_set_hold(DolAuroraHoldFn should_hold, void* user) { (void)should_hold; (void)user; }
void dol_aurora_set_hold_redraw(bool redraw) { (void)redraw; }
void dol_aurora_set_fast_forward(bool on) { (void)on; }
void dol_aurora_frame_timing(DolAuroraFrameTiming* out) { memset(out, 0, sizeof(*out)); }
unsigned long long dol_aurora_held_us(void) { return 0; }
void aurora_backend_service_present(void) {}
size_t dol_aurora_gx_save_state(void** out) { *out = NULL; return 0; }
bool dol_aurora_gx_load_state(const void* data, size_t size) { (void)data; (void)size; return true; }
void dol_aurora_gx_drain(void) {}
void dol_aurora_audio_resume(void) {}
const char* dol_aurora_backend_name(void) { return NULL; }

// Aurora's own API, as the host calls it directly (aurora/gfx.h: the HD look's
// effects, EFB peeks, readback, statistics; dolphin/pad.h: Aurora's
// controller ports). With no renderer: no effects, peeks that report nothing
// drawn (the host's callers check), no controllers bound to ports.
#include <aurora/gfx.h>
#include <dolphin/pad.h>

const AuroraStats* aurora_get_stats(void)
{
    static AuroraStats stats;
    return &stats;
}
void aurora_set_bloom(bool enabled) { (void)enabled; }
void aurora_set_far_blur(bool enabled) { (void)enabled; }
void aurora_set_ambient_occlusion(bool enabled) { (void)enabled; }
void aurora_set_sun_shadows(bool enabled) { (void)enabled; }
void aurora_set_sun_direction(float x, float y, float z) { (void)x; (void)y; (void)z; }
void aurora_set_edge_light(bool enabled) { (void)enabled; }
void aurora_set_torch_light(bool enabled) { (void)enabled; }
void aurora_set_point_lights(const float* lights, uint32_t count) { (void)lights; (void)count; }
void aurora_set_cloud_shadows(bool enabled) { (void)enabled; }
void aurora_set_world_view(const float inv_view[12], float tan_half_fovy, float aspect, float near_plane,
                           float sea_level, float seconds)
{
    (void)inv_view; (void)tan_half_fovy; (void)aspect; (void)near_plane; (void)sea_level; (void)seconds;
}
void aurora_set_copy_crop(uint32_t width, uint32_t height, float fraction) { (void)width; (void)height; (void)fraction; }
bool aurora_get_frame_interpolation(void) { return false; }
int aurora_get_frame_interp_steps(void) { return 1; }
bool aurora_color_peek_ready(void) { return false; }
bool aurora_peek_argb(uint16_t x, uint16_t y, uint32_t* color) { (void)x; (void)y; *color = 0; return false; }
bool aurora_peek_z(uint16_t x, uint16_t y, uint32_t* z) { (void)x; (void)y; *z = 0x00FFFFFFu; return false; }
void aurora_request_framebuffer_readback(void) {}
bool aurora_take_framebuffer_readback(const uint8_t** rgba, uint32_t* width, uint32_t* height)
{
    *rgba = NULL;
    *width = *height = 0;
    return false;
}

u32 PADCount(void) { return 0; }
s32 PADGetIndexForPort(u32 port) { (void)port; return -1; }
struct SDL_Gamepad* PADGetSDLGamepadForIndex(u32 index) { (void)index; return NULL; }
PADDeadZones* PADGetDeadZones(u32 port) { (void)port; return NULL; }
PADButtonMapping* PADGetButtonMappings(u32 port, u32* buttonCount) { (void)port; *buttonCount = 0; return NULL; }

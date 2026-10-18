// WebGPU part of the browser runtime check (web_main.c).
//
// Runs on the worker that owns the page's canvas (PROXY_TO_PTHREAD with the
// canvas transferred to it), the thread on which the host's renderer will
// run. It does what Aurora's device setup does (lib/webgpu/gpu.cpp) through
// emdawnwebgpu, the webgpu.h implementation over the browser's WebGPU:
// instance with timed WaitAny, adapter, device, a surface on the canvas,
// then clears a few frames. The browser has no wgpuSurfacePresent: a frame is
// shown when the worker returns to its event loop, which emscripten_sleep
// does under JSPI without unwinding the C stack.
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#include <webgpu/webgpu_cpp.h>

#include <cstdio>
#include <cstring>
#include <string>

#include "web_check.h"

namespace {

std::string str(wgpu::StringView view)
{
    return view.data ? std::string(view.data, view.length == WGPU_STRLEN ? strlen(view.data) : view.length)
                     : std::string();
}

}  // namespace

extern "C" int bluewake_web_gpu_check(int frames)
{
    static const wgpu::InstanceFeatureName instance_features[] = {wgpu::InstanceFeatureName::TimedWaitAny};
    wgpu::InstanceDescriptor instance_desc{};
    instance_desc.requiredFeatureCount = 1;
    instance_desc.requiredFeatures = instance_features;
    wgpu::Instance instance = wgpu::CreateInstance(&instance_desc);
    if (!instance)
        return web_check(false, "webgpu-instance", "no WebGPU in this browser (navigator.gpu is missing)");
    web_check(true, "webgpu-instance", "timed WaitAny");

    wgpu::Adapter adapter;
    wgpu::RequestAdapterOptions adapter_options{};
    adapter_options.powerPreference = wgpu::PowerPreference::HighPerformance;
    std::string adapter_message;
    wgpu::WaitStatus wait = instance.WaitAny(
        instance.RequestAdapter(&adapter_options, wgpu::CallbackMode::WaitAnyOnly,
                                [&](wgpu::RequestAdapterStatus status, wgpu::Adapter a, wgpu::StringView message) {
                                    if (status == wgpu::RequestAdapterStatus::Success)
                                        adapter = std::move(a);
                                    adapter_message = str(message);
                                }),
        UINT64_MAX);
    if (wait != wgpu::WaitStatus::Success || !adapter)
        return web_check(false, "webgpu-adapter", "no adapter (%s)", adapter_message.c_str());
    wgpu::AdapterInfo info{};
    adapter.GetInfo(&info);
    const bool dual_source = adapter.HasFeature(wgpu::FeatureName::DualSourceBlending);
    const bool bc = adapter.HasFeature(wgpu::FeatureName::TextureCompressionBC);
    web_check(true, "webgpu-adapter", "vendor \"%s\", architecture \"%s\", dual-source blending %s, BC textures %s",
              str(info.vendor).c_str(), str(info.architecture).c_str(), dual_source ? "yes" : "no",
              bc ? "yes" : "no");

    // Aurora requires dual-source blending where it exists (GX destination
    // alpha); ask for it the same way.
    wgpu::FeatureName features[2];
    size_t feature_count = 0;
    if (dual_source)
        features[feature_count++] = wgpu::FeatureName::DualSourceBlending;
    if (bc)
        features[feature_count++] = wgpu::FeatureName::TextureCompressionBC;
    wgpu::DeviceDescriptor device_desc{};
    device_desc.requiredFeatureCount = feature_count;
    device_desc.requiredFeatures = features;
    device_desc.SetUncapturedErrorCallback(
        [](const wgpu::Device&, wgpu::ErrorType type, wgpu::StringView message) {
            printf("[webgpu] error %d: %s\n", (int)type, str(message).c_str());
        });
    device_desc.SetDeviceLostCallback(
        wgpu::CallbackMode::AllowSpontaneous,
        [](const wgpu::Device&, wgpu::DeviceLostReason reason, wgpu::StringView message) {
            if (reason != wgpu::DeviceLostReason::Destroyed)
                printf("[webgpu] device lost (%d): %s\n", (int)reason, str(message).c_str());
        });
    wgpu::Device device;
    std::string device_message;
    wait = instance.WaitAny(
        adapter.RequestDevice(&device_desc, wgpu::CallbackMode::WaitAnyOnly,
                              [&](wgpu::RequestDeviceStatus status, wgpu::Device d, wgpu::StringView message) {
                                  if (status == wgpu::RequestDeviceStatus::Success)
                                      device = std::move(d);
                                  device_message = str(message);
                              }),
        UINT64_MAX);
    if (wait != wgpu::WaitStatus::Success || !device)
        return web_check(false, "webgpu-device", "no device (%s)", device_message.c_str());
    web_check(true, "webgpu-device", "%zu optional features", feature_count);

    wgpu::EmscriptenSurfaceSourceCanvasHTMLSelector canvas{};
    canvas.selector = "#canvas";
    wgpu::SurfaceDescriptor surface_desc{};
    surface_desc.nextInChain = &canvas;
    wgpu::Surface surface = instance.CreateSurface(&surface_desc);
    if (!surface)
        return web_check(false, "webgpu-surface", "cannot create a surface on #canvas from this thread");
    wgpu::SurfaceCapabilities caps{};
    surface.GetCapabilities(adapter, &caps);
    if (caps.formatCount == 0)
        return web_check(false, "webgpu-surface", "the canvas offers no format");
    int width = 0, height = 0;
    emscripten_get_canvas_element_size("#canvas", &width, &height);
    wgpu::SurfaceConfiguration config{};
    config.device = device;
    config.format = caps.formats[0];
    config.width = (uint32_t)width;
    config.height = (uint32_t)height;
    config.presentMode = wgpu::PresentMode::Fifo;
    config.alphaMode = wgpu::CompositeAlphaMode::Opaque;
    surface.Configure(&config);
    web_check(true, "webgpu-surface", "#canvas %dx%d, format %d, on the worker", width, height, (int)config.format);

    // Clear frames: the last one is BlueWake blue, rgb(26, 115, 204), which
    // the test reads back from a screenshot of the page.
    double start = emscripten_get_now();
    for (int frame = 0; frame < frames; ++frame) {
        wgpu::SurfaceTexture current{};
        surface.GetCurrentTexture(&current);
        if (current.status != wgpu::SurfaceGetCurrentTextureStatus::SuccessOptimal &&
            current.status != wgpu::SurfaceGetCurrentTextureStatus::SuccessSuboptimal)
            return web_check(false, "webgpu-frames", "frame %d: no surface texture (status %d)", frame,
                             (int)current.status);
        const bool last = frame == frames - 1;
        const double t = (double)frame / frames;
        wgpu::RenderPassColorAttachment color{};
        color.view = current.texture.CreateView();
        color.loadOp = wgpu::LoadOp::Clear;
        color.storeOp = wgpu::StoreOp::Store;
        color.clearValue = last ? wgpu::Color{26 / 255.0, 115 / 255.0, 204 / 255.0, 1.0} : wgpu::Color{t, 0.2, 1 - t, 1.0};
        wgpu::RenderPassDescriptor pass_desc{};
        pass_desc.colorAttachmentCount = 1;
        pass_desc.colorAttachments = &color;
        wgpu::CommandEncoder encoder = device.CreateCommandEncoder();
        encoder.BeginRenderPass(&pass_desc).End();
        wgpu::CommandBuffer commands = encoder.Finish();
        device.GetQueue().Submit(1, &commands);
        // Back to the worker's event loop, which shows the frame.
        emscripten_sleep(16);
    }
    bool done = false;
    instance.WaitAny(device.GetQueue().OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly,
                                                           [&](wgpu::QueueWorkDoneStatus, wgpu::StringView) {
                                                               done = true;
                                                           }),
                     UINT64_MAX);
    const double ms = emscripten_get_now() - start;
    web_check(done, "webgpu-frames", "%d frames in %.0f ms (%.1f ms a frame)", frames, ms, ms / frames);
    // Keep the device (and so the last frame on the canvas) alive. Leaked on
    // purpose: exit handlers run on the browser's main thread, which has no
    // WebGPU objects of this worker to release.
    new wgpu::Device(device);
    new wgpu::Surface(surface);
    new wgpu::Instance(instance);
    return done ? 0 : 1;
}

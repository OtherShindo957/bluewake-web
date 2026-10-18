# BlueWake for the browser (WebAssembly, Emscripten). Configured by
# web/build.sh with emcmake; docs/WEB_PORT.md describes the design.
#
#   bluewake_web_runtime  The browser runtime check (milestone 1): runs on a
#                         worker thread, mounts the origin-private file system,
#                         runs GXRuntime's CPU core and the host's instruction
#                         fallback on a PowerPC program, prepares the player's
#                         imported disc with the shared importer
#                         (apple/ios/src/disc_import.c), loads a side module
#                         with dlopen (as the host loads the game module) and
#                         draws with WebGPU on the page's canvas.
#   bluewake_web_site     Copies the page (web/shell) beside the wasm.
#
# The translated game itself is a separate side module built from the
# player's own disc (web/tools/translate.py, then cmake/composite); it is
# never part of this build's output.
cmake_minimum_required(VERSION 3.25)
project(bluewake_web LANGUAGES C CXX)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "web/ builds BlueWake for the browser only: configure it with emcmake (web/build.sh)")
endif()

get_filename_component(BLUEWAKE_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(BLUEWAKE_RECOMPCORE ${BLUEWAKE_REPO_ROOT}/ref/recompcore CACHE PATH "The RecompCore checkout to build with")
set(GXRUNTIME_DIR ${BLUEWAKE_RECOMPCORE}/GXRuntime)
set(BLUEWAKE_HOST_SRC ${BLUEWAKE_REPO_ROOT}/runtime/host/src)
set(BLUEWAKE_WEB_OUT ${CMAKE_BINARY_DIR}/site)

# Dynamic linking (the game is a side module) needs position-independent
# code on both sides; -pthread puts every object on shared memory.
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
add_compile_options("-ffile-prefix-map=${BLUEWAKE_REPO_ROOT}/=" -pthread -fPIC)

# Aurora, the renderer, on the browser's WebGPU (milestone 4, in progress):
# Dawn's webgpu.h comes from emdawnwebgpu and SDL3 from Emscripten's port,
# handed to Aurora's "system" providers as the targets it expects.
option(BLUEWAKE_WEB_AURORA "Build Aurora on WebGPU (work in progress)" OFF)
if(BLUEWAKE_WEB_AURORA)
    add_library(bluewake_web_emdawnwebgpu INTERFACE)
    target_compile_options(bluewake_web_emdawnwebgpu INTERFACE --use-port=emdawnwebgpu)
    target_link_options(bluewake_web_emdawnwebgpu INTERFACE --use-port=emdawnwebgpu)
    add_library(dawn::webgpu_dawn ALIAS bluewake_web_emdawnwebgpu)
    add_library(dawn::dawncpp_headers ALIAS bluewake_web_emdawnwebgpu)
    set(Dawn_FOUND TRUE)
    set(AURORA_DAWN_PROVIDER system CACHE STRING "" FORCE)
    add_library(bluewake_web_sdl3_port INTERFACE)
    target_compile_options(bluewake_web_sdl3_port INTERFACE --use-port=sdl3)
    target_link_options(bluewake_web_sdl3_port INTERFACE --use-port=sdl3)
    add_library(SDL3::SDL3-static ALIAS bluewake_web_sdl3_port)
    set(SDL3_FOUND TRUE)
    set(AURORA_SDL3_PROVIDER system CACHE STRING "" FORCE)
    set(AURORA_SDL3_LINKAGE static CACHE STRING "" FORCE)
    set(AURORA_CACHE_USE_ZSTD OFF CACHE BOOL "" FORCE)
    set(GXRUNTIME_ENABLE_AURORA ON CACHE BOOL "" FORCE)
    set(GXRUNTIME_ENABLE_AURORA_RECOMP ON CACHE BOOL "" FORCE)
else()
    set(GXRUNTIME_ENABLE_AURORA OFF CACHE BOOL "" FORCE)
    set(GXRUNTIME_ENABLE_AURORA_RECOMP OFF CACHE BOOL "" FORCE)
endif()
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
# GXRuntime caches where its Aurora is: always the tree configured here (the
# patched one web/build.sh prepares), never one cached by an earlier configure.
set(GXRUNTIME_AURORA_DIR "${GXRUNTIME_DIR}/graphics/aurora" CACHE PATH "" FORCE)
# Static libraries only: Aurora's dependencies build shared ones when this is
# undefined, and the game module is the only side module.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
add_subdirectory(${GXRUNTIME_DIR} gxruntime_build EXCLUDE_FROM_ALL)

# Link flags shared by the browser executables.
# - PROXY_TO_PTHREAD: main() runs on a worker, where it may block, as the
#   host's main loop does on the desktop.
# - JSPI: blocking calls that must wait for the browser (WebGPU's adapter and
#   device requests, yielding a frame) suspend the wasm stack instead of the
#   whole program being rewritten (Asyncify) - the game module is far too
#   large for that.
# - WASMFS + OPFS: real open/pread on the player's disc and saves. With the
#   whole JavaScript FS API (FORCE_FILESYSTEM): SDL3's port uses it (its
#   drag-and-drop folder) and fails without it.
# - MAIN_MODULE=2: the translated game is loaded with dlopen as a side module,
#   exactly as the desktop host loads gGZLE01_recomp.so. Only the symbols a
#   side module imports are exported (runtime/main_module_exports.txt, the C
#   library functions the game module calls); MAIN_MODULE=1 would export and
#   link every archive whole, which CMake's repeated archives make collide.
# - The 8 MiB stack is the desktop default; CPUState and the host keep large
#   structures on it.
set(BLUEWAKE_WEB_LINK_FLAGS
    -pthread -sPROXY_TO_PTHREAD -sJSPI
    -sWASMFS -sFORCE_FILESYSTEM -sMAIN_MODULE=2
    -sEXPORTED_FUNCTIONS=@${CMAKE_CURRENT_SOURCE_DIR}/runtime/main_module_exports.txt
    -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=128MB -sMAXIMUM_MEMORY=4GB
    -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB
    -sOFFSCREENCANVAS_SUPPORT -sOFFSCREENCANVASES_TO_PTHREAD=\#canvas
    -sENVIRONMENT=web,worker
    -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createBlueWake
    -sEXPORTED_RUNTIME_METHODS=callMain
    --use-port=emdawnwebgpu
    --js-library=${CMAKE_CURRENT_SOURCE_DIR}/runtime/dylink_sync.js)

add_executable(bluewake_web_runtime
    runtime/web_main.c
    runtime/web_gpu.cpp
    ${BLUEWAKE_HOST_SRC}/cold_fallback.c
    ${BLUEWAKE_REPO_ROOT}/apple/ios/src/disc_import.c)
target_include_directories(bluewake_web_runtime PRIVATE
    ${BLUEWAKE_HOST_SRC} ${BLUEWAKE_REPO_ROOT}/apple/ios/src)
target_compile_options(bluewake_web_runtime PRIVATE -Wall -Wno-unused-function --use-port=emdawnwebgpu)
target_compile_features(bluewake_web_runtime PRIVATE cxx_std_20)
target_link_libraries(bluewake_web_runtime PRIVATE gxruntime)
# The runtime stays alive after main() returns, and with it the worker that
# owns the canvas: Firefox blanks a canvas whose worker has ended.
target_link_options(bluewake_web_runtime PRIVATE ${BLUEWAKE_WEB_LINK_FLAGS} -sEXIT_RUNTIME=0)
set_property(TARGET bluewake_web_runtime APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/runtime/dylink_sync.js ${CMAKE_CURRENT_SOURCE_DIR}/runtime/main_module_exports.txt)
set_target_properties(bluewake_web_runtime PROPERTIES
    OUTPUT_NAME bluewake-runtime SUFFIX ".mjs"
    LINKER_LANGUAGE CXX
    RUNTIME_OUTPUT_DIRECTORY ${BLUEWAKE_WEB_OUT})

# A side module made from our own source (no game code): the runtime check
# loads it with dlopen to prove the loader the game module will use.
add_executable(bluewake_web_side_test runtime/web_side_test.c)
target_link_options(bluewake_web_side_test PRIVATE -pthread -sSIDE_MODULE=1)
set_target_properties(bluewake_web_side_test PROPERTIES
    OUTPUT_NAME side-test SUFFIX ".wasm"
    RUNTIME_OUTPUT_DIRECTORY ${BLUEWAKE_WEB_OUT})
add_dependencies(bluewake_web_runtime bluewake_web_side_test)

# The page, copied beside the wasm so build/web/site can be served as is
# (web/serve.py adds the cross-origin isolation headers). Its own target,
# run with every build, so page edits never wait for a relink.
file(GLOB BLUEWAKE_WEB_SHELL CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/shell/*)
add_custom_target(bluewake_web_site ALL
    COMMAND ${CMAKE_COMMAND} -E make_directory ${BLUEWAKE_WEB_OUT}
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${BLUEWAKE_WEB_SHELL} ${BLUEWAKE_WEB_OUT}
    COMMENT "Copying the web page into ${BLUEWAKE_WEB_OUT}")
add_dependencies(bluewake_web_runtime bluewake_web_site)

# --- The host (milestone 3) ----------------------------------------------
# The unchanged host (runtime/host/src) with the same sources as
# linux/CMakeLists.txt, except the settings and texture-pack menus (ImGui on
# Aurora) and the Wii U HD-texture importer (wwhd/), which come with the
# renderer. Its entry is web/runtime/web_host_main.c, the browser's
# linux_entry.c. Until Aurora runs on WebGPU here, the renderer API the host
# calls is answered by web/runtime/web_aurora_stub.c, so the host takes its
# own headless path, as it does natively without a window.
include(FetchContent)
# The same pins as Aurora's own fetches (GXRuntime/graphics/aurora/extern).
FetchContent_Declare(fmt
    URL https://github.com/fmtlib/fmt/archive/refs/tags/12.1.0.tar.gz
    URL_HASH SHA256=ea7de4299689e12b6dddd392f9896f08fb0777ac7168897a244a6d6085043fea
    DOWNLOAD_EXTRACT_TIMESTAMP FALSE EXCLUDE_FROM_ALL)
FetchContent_Declare(xxhash
    URL https://github.com/Cyan4973/xxHash/archive/refs/tags/v0.8.3.tar.gz
    URL_HASH SHA256=aae608dfe8213dfd05d909a57718ef82f30722c392344583d3f39050c7f29a80
    SOURCE_SUBDIR cmake_unofficial DOWNLOAD_EXTRACT_TIMESTAMP FALSE EXCLUDE_FROM_ALL)
set(XXHASH_BUILD_XXHSUM OFF CACHE INTERNAL "")
if(NOT TARGET fmt::fmt)
    FetchContent_MakeAvailable(fmt)
endif()
if(NOT TARGET xxhash)
    FetchContent_MakeAvailable(xxhash)
endif()

add_library(bluewake_web_zlib INTERFACE)
target_compile_options(bluewake_web_zlib INTERFACE -sUSE_ZLIB=1)
target_link_options(bluewake_web_zlib INTERFACE -sUSE_ZLIB=1)
add_library(bluewake_web_sdl3 INTERFACE)
target_compile_options(bluewake_web_sdl3 INTERFACE --use-port=sdl3)
target_link_options(bluewake_web_sdl3 INTERFACE --use-port=sdl3)

set(BLUEWAKE_WEB_HOST_SOURCES
    ${BLUEWAKE_HOST_SRC}/main.c
    ${BLUEWAKE_HOST_SRC}/aram_dma.c
    ${BLUEWAKE_HOST_SRC}/audio_capture.c
    ${BLUEWAKE_HOST_SRC}/audio_watch.c
    ${BLUEWAKE_HOST_SRC}/ipl_sram.c
    ${BLUEWAKE_HOST_SRC}/card_runtime.c
    ${BLUEWAKE_HOST_SRC}/callback_delivery.c
    ${BLUEWAKE_HOST_SRC}/cycle_domain.c
    ${BLUEWAKE_HOST_SRC}/delivery_digest.c
    ${BLUEWAKE_HOST_SRC}/edge_intercepts.c
    ${BLUEWAKE_HOST_SRC}/return_census.c
    ${BLUEWAKE_HOST_SRC}/interrupt_sources.c
    ${BLUEWAKE_HOST_SRC}/cold_fallback.c
    ${BLUEWAKE_HOST_SRC}/external_memory.c
    ${BLUEWAKE_HOST_SRC}/fpu_context.c
    ${BLUEWAKE_HOST_SRC}/pad_event_schedule.c
    ${BLUEWAKE_HOST_SRC}/pad_waypoint.c
    ${BLUEWAKE_HOST_SRC}/pad_wire.c
    ${BLUEWAKE_HOST_SRC}/rel_scratch_allocator.c
    ${BLUEWAKE_HOST_SRC}/scheduler_contract.c
    ${BLUEWAKE_HOST_SRC}/fast_load.c
    ${BLUEWAKE_HOST_SRC}/dpad_menus.c
    ${BLUEWAKE_HOST_SRC}/jump_button.c
    ${BLUEWAKE_HOST_SRC}/climb.c
    ${BLUEWAKE_HOST_SRC}/save_state.c
    ${BLUEWAKE_HOST_SRC}/sprint.c
    ${BLUEWAKE_HOST_SRC}/quick_doors.c
    ${BLUEWAKE_HOST_SRC}/haptics.c
    ${BLUEWAKE_HOST_SRC}/draw_tags.c
    ${BLUEWAKE_HOST_SRC}/forest_water.c
    ${BLUEWAKE_HOST_SRC}/hd_look.c
    ${BLUEWAKE_HOST_SRC}/fps_watch.c
    ${BLUEWAKE_HOST_SRC}/game_options.c
    ${BLUEWAKE_HOST_SRC}/mouse_camera.c)

add_executable(bluewake_web_host EXCLUDE_FROM_ALL
    runtime/web_host_main.c
    ${BLUEWAKE_WEB_HOST_SOURCES})
if(BLUEWAKE_WEB_AURORA)
    target_link_libraries(bluewake_web_host PRIVATE GXRuntime::aurora)
    target_compile_definitions(bluewake_web_host PRIVATE BLUEWAKE_WEB_AURORA=1)
else()
    target_sources(bluewake_web_host PRIVATE runtime/web_aurora_stub.c)
endif()
set_source_files_properties(${BLUEWAKE_HOST_SRC}/main.c PROPERTIES
    COMPILE_DEFINITIONS "main=bluewake_host_main")
target_include_directories(bluewake_web_host PRIVATE
    ${BLUEWAKE_HOST_SRC}
    ${BLUEWAKE_REPO_ROOT}/windows/src
    ${BLUEWAKE_REPO_ROOT}/apple/ios/src
    ${GXRUNTIME_DIR}/include
    ${GXRUNTIME_DIR}/graphics/aurora/include
    ${BLUEWAKE_RECOMPCORE}/Source/Core/Core/PowerPC/StaticRecomp)
target_compile_definitions(bluewake_web_host PRIVATE
    DOLRECOMP_CPU_HEADER="core/cpu.h"
    BLUEWAKE_ENABLE_DEVELOPER_TRACING=0
    BLUEWAKE_EDGE_CENSUS=0
    BLUEWAKE_WEB=1
    # What linking aurora::core gives its users (Aurora's dolphin/types.h).
    TARGET_PC=1)
target_compile_options(bluewake_web_host PRIVATE -Wno-unused-function)
# xxhash and zlib also come through the DSP donor.
target_link_libraries(bluewake_web_host PRIVATE gxruntime bluewake_web_sdl3)
target_link_options(bluewake_web_host PRIVATE ${BLUEWAKE_WEB_LINK_FLAGS} -sEXIT_RUNTIME=1
    -sEXPORTED_RUNTIME_METHODS=callMain,stringToNewUTF8)
set_property(TARGET bluewake_web_host APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/runtime/dylink_sync.js ${CMAKE_CURRENT_SOURCE_DIR}/runtime/main_module_exports.txt)
set_target_properties(bluewake_web_host PROPERTIES
    OUTPUT_NAME bluewake SUFFIX ".mjs"
    LINKER_LANGUAGE CXX
    RUNTIME_OUTPUT_DIRECTORY ${BLUEWAKE_WEB_OUT})
add_dependencies(bluewake_web_host bluewake_web_site)

# The donor DSP, as linux/CMakeLists.txt builds it.
set(_donor ${BLUEWAKE_RECOMPCORE})
set(_dsp ${_donor}/Source/Core/Core/DSP)
add_library(bluewake_web_dsp_donor STATIC EXCLUDE_FROM_ALL
    ${_dsp}/DSPAccelerator.cpp ${_dsp}/DSPAnalyzer.cpp ${_dsp}/DSPAssembler.cpp
    ${_dsp}/DSPCaptureLogger.cpp ${_dsp}/DSPCodeUtil.cpp ${_dsp}/DSPCore.cpp
    ${_dsp}/DSPDisassembler.cpp ${_dsp}/DSPHWInterface.cpp ${_dsp}/DSPMemoryMap.cpp
    ${_dsp}/DSPStacks.cpp ${_dsp}/DSPTables.cpp ${_dsp}/LabelMap.cpp
    ${_dsp}/Interpreter/DSPIntArithmetic.cpp ${_dsp}/Interpreter/DSPIntBranch.cpp
    ${_dsp}/Interpreter/DSPIntExtOps.cpp ${_dsp}/Interpreter/DSPIntLoadStore.cpp
    ${_dsp}/Interpreter/DSPIntMisc.cpp ${_dsp}/Interpreter/DSPIntMultiplier.cpp
    ${_dsp}/Interpreter/DSPIntTables.cpp ${_dsp}/Interpreter/DSPInterpreter.cpp
    ${_dsp}/Jit/DSPEmitterBase.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/DSPHLE.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/MailHandler.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/UCodes/AESnd.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/UCodes/ASnd.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/UCodes/AX.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/UCodes/AXWii.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/UCodes/CARD.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/UCodes/GBA.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/UCodes/INIT.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/UCodes/ROM.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/UCodes/UCodes.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/UCodes/Zelda.cpp
    ${_donor}/Source/Core/Core/HW/DSPHLE/UCodes/ZeldaUCodesTable.cpp
    ${BLUEWAKE_REPO_ROOT}/apple/ios/src/dsp_common_shim.cpp)
target_include_directories(bluewake_web_dsp_donor PUBLIC
    ${_donor}/Source/Core ${_donor}/Source ${_donor}/Externals
    ${BLUEWAKE_REPO_ROOT}/apple/ios/dsp_generated)
# 32-bit wasm: _ARCH_32, where the desktop builds say _ARCH_64.
target_compile_definitions(bluewake_web_dsp_donor PUBLIC
    _ARCH_32=1 FMT_EXCEPTIONS=0 __STDC_CONSTANT_MACROS __STDC_LIMIT_MACROS)
target_compile_features(bluewake_web_dsp_donor PUBLIC cxx_std_23)
target_compile_options(bluewake_web_dsp_donor PRIVATE -fno-strict-aliasing -w)
target_link_libraries(bluewake_web_dsp_donor PUBLIC fmt::fmt xxhash bluewake_web_zlib)

add_library(bluewake_web_dsp_adapter STATIC EXCLUDE_FROM_ALL
    ${BLUEWAKE_HOST_SRC}/dsp_adapter.cpp
    ${BLUEWAKE_HOST_SRC}/dsp_adapter_c.cpp
    ${BLUEWAKE_HOST_SRC}/dsp_adapter_donor_stubs.cpp
    ${BLUEWAKE_HOST_SRC}/dsp_hle_backend.cpp)
target_include_directories(bluewake_web_dsp_adapter PRIVATE ${GXRUNTIME_DIR}/include)
target_link_libraries(bluewake_web_dsp_adapter PUBLIC bluewake_web_dsp_donor)
target_compile_definitions(bluewake_web_host PRIVATE BLUEWAKE_HAS_DSP_ADAPTER=1)
target_link_libraries(bluewake_web_host PRIVATE bluewake_web_dsp_adapter)

# The renderer check (milestone 4, work in progress): Aurora's startup on the
# page's canvas, without a game.
if(BLUEWAKE_WEB_AURORA)
    add_executable(bluewake_web_aurora_check EXCLUDE_FROM_ALL runtime/web_aurora_check.c)
    target_link_libraries(bluewake_web_aurora_check PRIVATE GXRuntime::aurora)
    target_link_options(bluewake_web_aurora_check PRIVATE ${BLUEWAKE_WEB_LINK_FLAGS} -sEXIT_RUNTIME=0)
    set_target_properties(bluewake_web_aurora_check PROPERTIES
        OUTPUT_NAME bluewake-aurora-check SUFFIX ".mjs" LINKER_LANGUAGE CXX
        RUNTIME_OUTPUT_DIRECTORY ${BLUEWAKE_WEB_OUT})
    add_dependencies(bluewake_web_aurora_check bluewake_web_site)
endif()

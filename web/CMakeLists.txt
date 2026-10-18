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

# GXRuntime's portable core only, for now; Aurora (WebGPU through
# emdawnwebgpu) joins when the host does.
set(GXRUNTIME_ENABLE_AURORA OFF CACHE BOOL "" FORCE)
set(GXRUNTIME_ENABLE_AURORA_RECOMP OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
add_subdirectory(${GXRUNTIME_DIR} gxruntime_build EXCLUDE_FROM_ALL)

# Link flags shared by the browser executables.
# - PROXY_TO_PTHREAD: main() runs on a worker, where it may block, as the
#   host's main loop does on the desktop.
# - JSPI: blocking calls that must wait for the browser (WebGPU's adapter and
#   device requests, yielding a frame) suspend the wasm stack instead of the
#   whole program being rewritten (Asyncify) - the game module is far too
#   large for that.
# - WASMFS + OPFS: real open/pread on the player's disc and saves.
# - MAIN_MODULE: the translated game is loaded with dlopen as a side module,
#   exactly as the desktop host loads gGZLE01_recomp.so.
# - The 8 MiB stack is the desktop default; CPUState and the host keep large
#   structures on it.
set(BLUEWAKE_WEB_LINK_FLAGS
    -pthread -sPROXY_TO_PTHREAD -sJSPI
    -sWASMFS -sMAIN_MODULE=1
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
set_property(TARGET bluewake_web_runtime APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/runtime/dylink_sync.js)
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

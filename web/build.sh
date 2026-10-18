#!/usr/bin/env bash
# web/build.sh [TARGET...]
#
# Builds the browser version into build/web/ with Emscripten:
#   build/web/site/   index.html, app.js, bluewake-runtime.{mjs,wasm}
#                     (serve it with: python3 web/serve.py)
# TARGETs default to the runtime check and the page. The game module is built
# separately from your own disc (web/README.md, "Your game module").
#
# Finds Emscripten through EMSDK, emcc on PATH, or ~/dev/emsdk / ~/emsdk.
# JOBS=n limits parallel compiles. BUILD_TYPE (default RelWithDebInfo).
# AURORA=0 builds the host without the renderer (it then runs headless).
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD

if ! command -v emcmake >/dev/null 2>&1; then
  for env in "${EMSDK:-}/emsdk_env.sh" "$HOME/dev/emsdk/emsdk_env.sh" "$HOME/emsdk/emsdk_env.sh"; do
    if [[ -f "$env" ]]; then
      # shellcheck disable=SC1090
      source "$env" >/dev/null 2>&1
      break
    fi
  done
fi
command -v emcmake >/dev/null 2>&1 || {
  echo "Emscripten not found: install the emsdk (web/README.md, Toolchain) or set EMSDK." >&2
  exit 1
}
for tool in cmake git python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing $tool" >&2; exit 1; }
done
echo "emcc $(emcc --version | head -1 | sed 's/.*) //')"

# The pinned RecompCore and DolRecomp, fetched as every builder does
# (scripts/linux/build.py's dependency stage), into ref/recompcore.
python3 - <<'EOF'
import importlib.util, sys
from pathlib import Path
root = Path.cwd()
spec = importlib.util.spec_from_file_location("linux_build", root / "scripts/linux/build.py")
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
class Args: pass
args = Args(); args.out = root / "build/web"
builder = b.Builder(args); builder.logs = root / "build/web/logs"
try:
    builder.dependencies()
except b.BuildError as e:
    sys.exit(f"dependencies: {e}")
EOF

# Browser changes to RecompCore are patches (web/patches/recompcore), applied
# to a git worktree of the pinned commit in build/web/recompcore, so the
# checkout the native builders use stays exactly as pinned. Edit the worktree,
# then export with: git -C build/web/recompcore diff > web/patches/recompcore/NNNN-name.patch
rc=build/web/recompcore
pinned=$(git -C ref/recompcore rev-parse HEAD)
mkdir -p build/web
if [[ ! -e $rc/.git ]]; then
  git -C ref/recompcore worktree prune
  git -C ref/recompcore worktree add -q --detach "$root/$rc" "$pinned"
fi
stamp=$( (echo "$pinned"; cat web/patches/recompcore/*.patch 2>/dev/null || true) | sha256sum | cut -d' ' -f1)
if [[ "$(cat build/web/recompcore.stamp 2>/dev/null)" != "$stamp" ]]; then
  git -C $rc checkout -q --detach -f "$pinned"
  git -C $rc reset -q --hard
  git -C $rc clean -qfd
  for patch in web/patches/recompcore/*.patch; do
    [[ -e $patch ]] || continue
    echo "applying $patch"
    git -C $rc apply --whitespace=nowarn "$root/$patch"
  done
  echo "$stamp" > build/web/recompcore.stamp
fi

bdir=build/web
jobs=${JOBS:-$(nproc 2>/dev/null || echo 4)}
targets=("$@")
aurora=${AURORA:-1}
if (( ${#targets[@]} == 0 )); then
  targets=(bluewake_web_runtime bluewake_web_host bluewake_web_site)
  (( aurora )) && targets+=(bluewake_web_aurora_check)
fi

emcmake cmake -S web -B "$bdir" -DCMAKE_BUILD_TYPE="${BUILD_TYPE:-RelWithDebInfo}" \
  -DBLUEWAKE_RECOMPCORE="$root/$rc" -DBLUEWAKE_WEB_AURORA="$( ((aurora)) && echo ON || echo OFF)" >/dev/null
for t in "${targets[@]}"; do
  cmake --build "$bdir" --target "$t" --parallel "$jobs"
done
echo
echo "Built into $root/$bdir/site. Serve it with: python3 web/serve.py   (then open http://127.0.0.1:8080/)"

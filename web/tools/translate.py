#!/usr/bin/env python3
"""Translate your own disc into the game-module source the browser build compiles.

    python3 web/tools/translate.py DISC.iso [--out build/web-game] [--jobs N]

Runs the Linux builder's own stages (scripts/linux/build.py) up to and
including the verified composite source, and nothing after it:

  dependencies  the pinned RecompCore and DolRecomp (ref/recompcore)
  disc          GZLE01 revision 0 check
  extract       main.dol and the 415 RELs (apple/ios/src/disc_import.c)
  translate     DolRecomp, C backend, Gekko
  generate      the composite source, compared with the verified digest

It needs much less than a native build: a C compiler, CMake and git (no
clang, Ninja, Dawn or SDL), because it builds only the translator and the
two-file extractor. The output, OUT/composite-src, is code translated from
your disc: it stays on your machine, in an ignored folder, and is never
committed or deployed.
"""
import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

spec = importlib.util.spec_from_file_location("bluewake_linux_build", ROOT / "scripts/linux/build.py")
linux_build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(linux_build)


class SourceBuilder(linux_build.Builder):
    """The Linux builder's stages 2-6, with the host toolchain checks reduced
    to what those stages run."""

    def check_tools(self):
        for tool in ("git", "cmake"):
            if shutil.which(tool) is None:
                linux_build.die(f"missing {tool}")
        self.cc = os.environ.get("CC") or shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
        if self.cc is None:
            linux_build.die("missing a C compiler (cc, gcc or clang)")
        self.generator = ["-G", "Ninja"] if shutil.which("ninja") else ["-G", "Unix Makefiles"]
        print(f"cc {self.cc}; cmake {self.generator[1]}; {self.args.jobs} jobs")

    def build_dolrecomp(self):
        build = self.out / "dolrecomp"
        self.run("dolrecomp-configure", ["cmake", "-S", self.recompcore / "DolRecomp", "-B", build,
                                         *self.generator, "-DCMAKE_BUILD_TYPE=Release",
                                         "-DDOLRECOMP_WARNINGS_AS_ERRORS=OFF"])
        self.run("dolrecomp-build", ["cmake", "--build", build, "--target", "dolrecomp", "-j", self.args.jobs])
        return build / "dolrecomp"

    def extract(self, iso, game):
        tool = self.out / "tools/disc_extract"
        tool.parent.mkdir(parents=True, exist_ok=True)
        self.run("disc-extract-build", [self.cc, "-O2", "-I", ROOT / "apple/ios/src",
                                        ROOT / "scripts/ios/disc_extract.c", ROOT / "apple/ios/src/disc_import.c",
                                        "-o", tool])
        self.run("disc-extract", [tool, iso, game])
        rels = len(list((game / "rels").glob("*.rel")))
        if rels != 415:
            linux_build.die(f"expected 415 RELs in {game / 'rels'}, found {rels}")

    def build(self):
        self.mods = False
        self.mods_pending = False
        print(f"Translating The Wind Waker (GZLE01 rev 0) from {self.args.disc} for the browser build")
        linux_build.step("1/5 dependencies")
        self.check_tools()
        self.dependencies()
        linux_build.step("2/5 disc")
        self.disc()
        linux_build.step("3/5 extract")
        self.dolrecomp = self.build_dolrecomp()
        game = self.out / "game"
        if (game / "main.dol").exists() and len(list((game / "rels").glob("*.rel"))) == 415:
            print(f"reusing main.dol and the RELs in {game}")
        else:
            self.extract(self.iso, game)
        linux_build.step("4/5 translate")
        self.translate(game / "main.dol", self.out / "translated", game / "rels")
        chunks = len(list((self.out / "translated/dol/generated/chunks").glob("*.c")))
        print(f"translated: {chunks} DOL chunks and 415 RELs")
        linux_build.step("5/5 composite source")
        self.generate()
        print(f"\ncomposite source: {self.out / 'composite-src'} (translated from your disc: keep it to yourself)")


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("disc", type=Path, help="your GZLE01 revision 0 disc image (.iso or .gcm)")
    parser.add_argument("--out", type=Path, default=ROOT / "build/web-game")
    parser.add_argument("--jobs", type=int, default=None)
    parser.add_argument("--accept-new-composite", action="store_true",
                        help="continue if the generated source differs from the verified one")
    args = parser.parse_args()
    # The stages read these Linux builder options; translation uses none of
    # the module preparations.
    for name in linux_build.LINUX_DEFAULT_OPTIMIZATIONS + ("native_entries", "native_gx", "cache_ops"):
        setattr(args, name, False)
    args.jobs = args.jobs or linux_build.default_jobs()
    args.out = args.out.resolve()
    try:
        inside = args.out.relative_to(ROOT)
    except ValueError:
        inside = None
    if inside is not None and subprocess.run(["git", "check-ignore", "-q", str(args.out) + os.sep],
                                             cwd=ROOT).returncode != 0:
        parser.error("--out inside this checkout must be git-ignored; use build/web-game")
    args.out.mkdir(parents=True, exist_ok=True)
    try:
        SourceBuilder(args).build()
    except linux_build.BuildError as error:
        print(f"\ntranslate: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

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
  web source    the same translation partitioned for the browser
                (--partition-instructions, default 512) in OUT/composite-web

Why another partition: DolRecomp emits each partition of the program as one
C function. The desktop builds use 4,096 instructions; compiled to
WebAssembly that is a function of about 1.5 MB, and a browser's optimizing
compiler needs about 300 MB for each one it optimizes (several at once):
the tab ran out of memory seven seconds into the game. At 512 instructions
the same code is 28% smaller, compiles ten times faster and optimizes in
about 45 MB a function (docs/WEB_PORT.md). The verified 4,096 tree is still
produced and checked first, so the inputs (your disc's revision, the pinned
translator) are proven before the web tree is made from them.

It needs much less than a native build: a C compiler, CMake and git (no
clang, Ninja, Dawn or SDL), because it builds only the translator and the
two-file extractor. The output is code translated from your disc: it stays
on your machine, in an ignored folder, and is never committed or deployed.
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

    def translate_partitioned(self, dol, out, rels, partition):
        """build.py's translate(), with the browser's partition for the DOL
        and the RELs."""
        pending = out.with_name(out.name + ".new")
        shutil.rmtree(pending, ignore_errors=True)
        pending.mkdir(parents=True)
        common = [self.dolrecomp, "--gamecube", "--backend", "c", "--cpu", "gekko",
                  "--partition-instructions", str(partition)]
        self.run("translate-web-dol", [*common, dol, pending / "dol", "-j", self.args.jobs])
        self.run("translate-web-rels", [*common, "--rel-base", "0xC0400000", rels, pending / "rels",
                                        "-j", self.args.jobs])
        shutil.rmtree(out, ignore_errors=True)
        os.replace(pending, out)

    def build(self):
        self.mods = False
        self.mods_pending = False
        print(f"Translating The Wind Waker (GZLE01 rev 0) from {self.args.disc} for the browser build")
        linux_build.step("1/6 dependencies")
        self.check_tools()
        self.dependencies()
        linux_build.step("2/6 disc")
        self.disc()
        linux_build.step("3/6 extract")
        self.dolrecomp = self.build_dolrecomp()
        game = self.out / "game"
        if (game / "main.dol").exists() and len(list((game / "rels").glob("*.rel"))) == 415:
            print(f"reusing main.dol and the RELs in {game}")
        else:
            self.extract(self.iso, game)
        linux_build.step("4/6 translate")
        self.translate(game / "main.dol", self.out / "translated", game / "rels")
        chunks = len(list((self.out / "translated/dol/generated/chunks").glob("*.c")))
        print(f"translated: {chunks} DOL chunks and 415 RELs")
        linux_build.step("5/6 composite source")
        self.generate()
        partition = self.args.partition_instructions
        web = self.out / "composite-web"
        linux_build.step(f"6/6 the browser's source ({partition}-instruction partitions)")
        if partition == 4096:
            shutil.rmtree(web, ignore_errors=True)
            shutil.copytree(self.out / "composite-src", web)
        else:
            self.translate_partitioned(game / "main.dol", self.out / "translated-web", game / "rels", partition)
            new = self.out / "composite-web.new"
            self.composite(self.out / "translated-web/dol/generated", self.out / "translated-web/rels/generated/rels",
                           game / "rels", game / "main.dol", new, "composite-web-generate")
            shutil.rmtree(web, ignore_errors=True)
            os.replace(new, web)
        chunks = len(list(web.rglob("*.c")))
        digest = linux_build.tree_digest(web)
        (self.out / "composite-web.digest").write_text(f"{digest}\n")
        print(f"{chunks} C files, digest {digest}")
        print(f"\nthe browser's source: {web} (translated from your disc: keep it to yourself)")


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("disc", type=Path, help="your GZLE01 revision 0 disc image (.iso or .gcm)")
    parser.add_argument("--out", type=Path, default=ROOT / "build/web-game")
    parser.add_argument("--jobs", type=int, default=None)
    parser.add_argument("--partition-instructions", type=int, default=512,
                        help="instructions in each translated function for the browser (128-4096, default 512)")
    parser.add_argument("--accept-new-composite", action="store_true",
                        help="continue if the generated source differs from the verified one")
    args = parser.parse_args()
    # The stages read these Linux builder options; translation uses none of
    # the module preparations.
    for name in linux_build.LINUX_DEFAULT_OPTIMIZATIONS + ("native_entries", "native_gx", "cache_ops"):
        setattr(args, name, False)
    args.jobs = args.jobs or linux_build.default_jobs()
    if not 128 <= args.partition_instructions <= 4096:
        parser.error("--partition-instructions must be 128-4096 (DolRecomp's range)")
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

#!/usr/bin/env python3
"""List what a WebAssembly side module imports, and check the main module exports it.

    python3 web/tools/side_imports.py MODULE.so [--main build/web/site/bluewake.wasm]

The browser host is linked with -sMAIN_MODULE=2, so it exports only the symbols
named in web/runtime/main_module_exports.txt (plus what Emscripten's dynamic
linker always needs). A side module (the game module, gGZLE01_recomp.so) that
imports anything else fails in dlopen. This reads the side module's import
section (functions from "env", data addresses from "GOT.mem", function
addresses from "GOT.func") and the main module's export section, and reports
any import the main module does not export. Exit status 1 when one is missing.
"""
import argparse
import os
import sys

# Provided by the dynamic linker itself, not by exports.
LINKER_PROVIDED = {
    "memory", "__indirect_function_table", "__stack_pointer", "__memory_base",
    "__table_base", "__tls_base", "__stack_high", "__stack_low", "__heap_base",
}


def leb(data, at):
    value = shift = 0
    while True:
        byte = data[at]
        at += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return value, at


def name(data, at):
    length, at = leb(data, at)
    return data[at:at + length].decode("utf-8"), at + length


def sections(path):
    data = open(path, "rb").read()
    if data[:4] != b"\0asm":
        sys.exit(f"{path} is not a WebAssembly module")
    at = 8
    while at < len(data):
        section = data[at]
        size, at = leb(data, at + 1)
        yield section, data, at
        at += size


def exports(path):
    for section, data, at in sections(path):
        if section == 7:
            count, p = leb(data, at)
            names = set()
            for _ in range(count):
                field, p = name(data, p)
                p += 1
                _, p = leb(data, p)
                names.add(field)
            return names
    return set()


def imports(path):
    data = open(path, "rb").read()
    if data[:4] != b"\0asm":
        sys.exit(f"{path} is not a WebAssembly module")
    at = 8
    found = []
    while at < len(data):
        section = data[at]
        size, at = leb(data, at + 1)
        end = at + size
        if section == 2:
            count, p = leb(data, at)
            for _ in range(count):
                module, p = name(data, p)
                field, p = name(data, p)
                kind = data[p]
                p += 1
                if kind == 0:  # function: type index
                    _, p = leb(data, p)
                elif kind == 1:  # table: reftype, limits
                    p += 1
                    flags, p = leb(data, p)
                    _, p = leb(data, p)
                    if flags & 1:
                        _, p = leb(data, p)
                elif kind == 2:  # memory: limits
                    flags, p = leb(data, p)
                    _, p = leb(data, p)
                    if flags & 1:
                        _, p = leb(data, p)
                elif kind == 3:  # global: valtype, mutability
                    p += 2
                elif kind == 4:  # tag
                    p += 1
                    _, p = leb(data, p)
                found.append((module, field, kind))
            return found
        at = end
    return found


def main():
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("module")
    ap.add_argument("--main", default=os.path.join(root, "build/web/site/bluewake.wasm"))
    args = ap.parse_args()
    exported = exports(args.main)
    needed = sorted({field for module, field, kind in imports(args.module)
                     if module in ("env", "GOT.mem", "GOT.func") and field not in LINKER_PROVIDED})
    missing = [n for n in needed if n not in exported]
    print(f"{args.module}: imports {len(needed)} symbols from the main module: {' '.join(needed)}")
    if missing:
        print(f"not exported by {args.main}: {' '.join(missing)} (add them to web/runtime/main_module_exports.txt)")
        sys.exit(1)
    print("all exported by the main module")


if __name__ == "__main__":
    main()

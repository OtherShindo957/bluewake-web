#!/usr/bin/env python3
"""Expand a CISO GameCube image into a plain ISO, which BlueWake's builders read.

    python3 web/tools/ciso_to_iso.py IN.ciso OUT.iso

CISO stores a 0x8000-byte header ("CISO", the block size, then one byte per
block: 1 if the block is stored) followed by the stored blocks in order.
Blocks that are not stored read as zeros. The output is padded to the size of
a GameCube disc (1,459,978,240 bytes) when the used blocks end before it.
The browser's import does the same expansion (web/shell/import-worker.js).

Your disc image stays yours: write OUT somewhere outside the repository or in
an ignored folder (build/), never into git.
"""
import os
import struct
import sys

CISO_HEADER_SIZE = 0x8000
CISO_MAP_SIZE = CISO_HEADER_SIZE - 8
GC_DISC_SIZE = 1_459_978_240


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__.strip().splitlines()[2].strip())
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, "rb") as f:
        header = f.read(CISO_HEADER_SIZE)
        if len(header) != CISO_HEADER_SIZE or header[:4] != b"CISO":
            sys.exit(f"{src} is not a CISO image")
        block_size = struct.unpack_from("<I", header, 4)[0]
        if block_size == 0 or block_size % 0x8000 or block_size > 0x10000000:
            sys.exit(f"{src}: unsupported CISO block size {block_size}")
        used = header[8:8 + CISO_MAP_SIZE]
        last = max((i for i, b in enumerate(used) if b == 1), default=-1)
        stored = sum(1 for b in used if b == 1)
        expected = CISO_HEADER_SIZE + stored * block_size
        if os.path.getsize(src) < expected:
            sys.exit(f"{src} is truncated: {os.path.getsize(src)} bytes, {expected} expected")
        tmp = dst + ".part"
        zero = bytes(block_size)
        with open(tmp, "wb") as out:
            for i in range(last + 1):
                if used[i] == 1:
                    block = f.read(block_size)
                    if len(block) != block_size:
                        sys.exit(f"{src} ended inside block {i}")
                    out.write(block)
                else:
                    out.write(zero)
            size = out.tell()
            if size < GC_DISC_SIZE:
                out.truncate(GC_DISC_SIZE)
    os.replace(tmp, dst)
    print(f"{dst}: {max(size, GC_DISC_SIZE)} bytes ({stored} of {last + 1} blocks stored, block size {block_size})")


if __name__ == "__main__":
    main()

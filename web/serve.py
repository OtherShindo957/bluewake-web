#!/usr/bin/env python3
"""Serve the browser build locally with the headers WebAssembly threads need.

    python3 web/serve.py [SITE_DIR] [--port 8080] [--host 127.0.0.1]

SITE_DIR defaults to build/web/site. Every response carries
Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy:
require-corp, which make the page cross-origin isolated, so it may use
SharedArrayBuffer (Emscripten pthreads). .wasm is served as application/wasm
so browsers can compile it while it downloads.
"""
import argparse
import http.server
import os
import sys
from functools import partial


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get("BLUEWAKE_SERVE_QUIET") != "1":
            super().log_message(fmt, *args)


def main():
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("site", nargs="?", default=os.path.join(repo, "build", "web", "site"))
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    if not os.path.isdir(args.site):
        sys.exit(f"{args.site} does not exist: build first with web/build.sh")
    server = http.server.ThreadingHTTPServer(
        (args.host, args.port), partial(Handler, directory=args.site))
    print(f"Serving {args.site} at http://{args.host}:{server.server_address[1]}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

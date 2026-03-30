#!/usr/bin/env python3
"""Tiny local dev server for the static site.

This repo serves directly from the project root.

Usage:
  python3 serve.py

Optional:
  HOST=127.0.0.1 PORT=5173 python3 serve.py
"""

from __future__ import annotations

import os
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE_DIR = ROOT


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE_DIR), **kwargs)


def main() -> None:
    if not SITE_DIR.exists():
        raise SystemExit(f"Missing directory: {SITE_DIR}")

    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "127.0.0.1")

    server = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host}:{port}/"

    print(f"Serving: {SITE_DIR}")
    print(f"Open:    {url}")

    # Best-effort: open a browser tab.
    try:
        webbrowser.open(url)
    except Exception:
        pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")


if __name__ == "__main__":
    main()

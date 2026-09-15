"""Local preview server for web/ that forbids browser caching.

Python's plain `http.server` lets the browser reuse old copies of app.js and
styles.css, so a test can silently run yesterday's code. This sends
`Cache-Control: no-store` on every response so each reload gets the files on
disk.

    python3 scripts/dev_server.py            # http://127.0.0.1:8766
    python3 scripts/dev_server.py 9000
"""
import functools
import http.server
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"


class NoStoreHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    handler = functools.partial(NoStoreHandler, directory=str(WEB))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"Serving {WEB} at http://127.0.0.1:{port} (no-store)")
        server.serve_forever()


if __name__ == "__main__":
    main()

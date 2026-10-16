#!/usr/bin/env python3
"""Serves the browser build on this computer only (127.0.0.1), with the two headers a page
needs before a browser lets it use threads.

    tools/play-web/serve.py [--port 8973] [--site local/play-web-site]
    tools/play-web/serve.py --disc "/path/to/image.iso" --report local/play-web-out/report.jsonl

--disc, --report and --shots are for the developer's tests: the image is then readable
by range requests at /dev/disc.iso (so that a test needs no file dialog), what the page
POSTs to /report is appended to the file, one JSON object per line, and a picture of the
canvas that the page POSTs to /shot/NAME.png is written to the directory. A file
command.json beside the report file ({"goto": "/index.html?..."} or {"close": true}) is
handed to the page once: a run of tests then needs one browser tab. A player needs neither: the
page reads the image the player picks from the player's own computer, in place.
The server never listens on any address but 127.0.0.1.
"""
import argparse
import json
import os
import re
import sys
import time
from urllib.parse import unquote
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disc = None
    report = None
    shots = None
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript",
                      ".pnach": "text/plain", ".txt": "text/plain"}

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format, *args):
        pass

    def send_disc(self, head):
        size = os.path.getsize(self.disc)
        start, end = 0, size - 1
        match = re.match(r"bytes=(\d+)-(\d*)$", self.headers.get("Range", ""))
        if match:
            start = int(match.group(1))
            if match.group(2):
                end = min(int(match.group(2)), size - 1)
            if start > end:
                self.send_error(416)
                return
            self.send_response(206)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        else:
            self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        if head:
            return
        if not match:
            # the whole image is never sent: tests read ranges
            return
        with open(self.disc, "rb") as image:
            image.seek(start)
            left = end - start + 1
            while left > 0:
                piece = image.read(min(left, 1 << 20))
                if not piece:
                    break
                self.wfile.write(piece)
                left -= len(piece)

    def do_GET(self):
        if self.path.split("?")[0] == "/dev/disc.iso":
            if not self.disc:
                self.send_error(404)
                return
            self.send_disc(False)
            return
        if self.path == "/command":
            # developer tests: one command for the page (see rta-web.js), given once
            command = os.path.join(os.path.dirname(self.report), "command.json") if self.report else None
            body = b""
            if command and os.path.isfile(command):
                with open(command, "rb") as source:
                    body = source.read()
                os.remove(command)
            self.send_response(200 if body else 204)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_HEAD(self):
        if self.path.split("?")[0] == "/dev/disc.iso":
            if not self.disc:
                self.send_error(404)
                return
            self.send_disc(True)
            return
        super().do_HEAD()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        if self.path.startswith("/shot/") and self.shots:
            name = os.path.basename(unquote(self.path[6:]))
            if re.match(r"^[A-Za-z0-9._-]+\.png$", name) and body[:8] == b"\x89PNG\r\n\x1a\n":
                with open(os.path.join(self.shots, name), "wb") as out:
                    out.write(body)
        if self.path == "/report" and self.report:
            try:
                data = json.loads(body)
                if not isinstance(data, dict):
                    raise ValueError("a report must be a JSON object")
                data["at"] = round(time.time(), 2)
                # os.getloadavg() is unavailable on Windows; the diagnostic endpoint
                # must still accept browser reports without that optional field.
                try:
                    data["load"] = round(os.getloadavg()[0], 1)
                except (AttributeError, OSError):
                    pass
                with open(self.report, "a") as out:
                    out.write(json.dumps(data) + "\n")
            except (ValueError, OSError):
                pass
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8973)
    parser.add_argument("--site", default=os.path.join(ROOT, "local", "play-web-site"))
    parser.add_argument("--disc", help="developer tests only: a disc image to serve at /dev/disc.iso")
    parser.add_argument("--report", help="developer tests only: file that POSTs to /report are appended to")
    parser.add_argument("--shots", help="developer tests only: directory that pictures POSTed to /shot/NAME.png are written to (game output: keep it under local/)")
    args = parser.parse_args()
    # a build as build.sh leaves it, or one laid out for a web server (the build's files in a directory of their own)
    if not os.path.isfile(os.path.join(args.site, "Play.wasm")) and not os.path.isfile(os.path.join(args.site, "index.html")):
        sys.exit("serve.py: %s holds no build (run tools/play-web/build.sh first)" % args.site)
    Handler.disc = args.disc
    if args.report:
        args.report = os.path.abspath(args.report)
        os.makedirs(os.path.dirname(args.report), exist_ok=True)
    Handler.report = args.report
    if args.shots:
        args.shots = os.path.abspath(args.shots)
        os.makedirs(args.shots, exist_ok=True)
    Handler.shots = args.shots
    args.site = os.path.abspath(args.site)
    os.chdir(args.site)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print("serving %s at http://127.0.0.1:%d/ (this computer only)" % (args.site, args.port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

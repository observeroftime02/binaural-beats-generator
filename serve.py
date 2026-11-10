#!/usr/bin/env python3
"""
Binaural Lab - minimal static file server.

Serves this folder over HTTP so the page can be opened from other devices on
your network (a phone with headphones, for instance). Nothing is installed and
nothing is uploaded: this only reads files from the folder it sits in.

    python serve.py                  # http://0.0.0.0:7899  (all interfaces)
    python serve.py --port 8000      # different port
    python serve.py --local-only     # 127.0.0.1 only, invisible to the LAN
    python serve.py --no-browser     # do not open a browser window

Windows: just double-click serve.bat.

Standard library only - works with any Python 3.6+.
"""

import argparse
import http.server
import os
import socket
import socketserver
import sys
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 7899


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static handler that never caches, so edits show up on reload."""

    server_version = "BinauralLab/1.0"

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        http.server.SimpleHTTPRequestHandler.end_headers(self)

    def log_message(self, fmt, *args):
        # Compact single-line log, ASCII only (Windows consoles are cp1252).
        sys.stderr.write("  %-15s %s\n" % (self.client_address[0], fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def lan_address():
    """Best-effort local network IP. No packets are actually sent."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
        finally:
            sock.close()
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def banner(host, port, opened):
    line = "-" * 58
    print("")
    print(line)
    print("  BINAURAL LAB - static server")
    print(line)
    print("  folder  %s" % HERE)
    print("  listening on %s:%d" % (host, port))
    print("")
    print("  open    http://localhost:%d/" % port)
    if host == "0.0.0.0":
        ip = lan_address()
        if ip and not ip.startswith("127."):
            print("  phone   http://%s:%d/" % (ip, port))
        print("")
        print("  (reachable from other devices on this network;")
        print("   allow Python through the firewall if Windows asks)")
    print("")
    print("  stop    Ctrl+C")
    if opened:
        print("  (a browser window should have opened)")
    print(line)
    print("")
    # make sure the URLs are visible even when stdout is redirected to a file
    try:
        sys.stdout.flush()
    except Exception:
        pass


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Serve Binaural Lab on the local network.")
    parser.add_argument("--host", default=DEFAULT_HOST,
                        help="interface to bind (default: %s)" % DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help="port to listen on (default: %d)" % DEFAULT_PORT)
    parser.add_argument("--local-only", action="store_true",
                        help="bind 127.0.0.1 instead of 0.0.0.0")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open a browser window")
    args = parser.parse_args(argv)

    host = "127.0.0.1" if args.local_only else args.host

    if not os.path.isfile(os.path.join(HERE, "index.html")):
        print("  index.html not found next to serve.py - nothing to serve.")
        return 1

    os.chdir(HERE)  # SimpleHTTPRequestHandler serves the current directory

    try:
        httpd = Server((host, args.port), Handler)
    except OSError as exc:
        print("")
        print("  Could not listen on %s:%d" % (host, args.port))
        print("  %s" % exc)
        print("")
        print("  Something else may already be using that port.")
        print("  Try:  python serve.py --port 7900")
        return 1

    url = "http://localhost:%d/" % args.port
    opened = False
    if not args.no_browser:
        try:
            opened = webbrowser.open(url)
        except Exception:
            opened = False

    banner(host, args.port, opened)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

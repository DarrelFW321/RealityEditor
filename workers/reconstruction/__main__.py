"""
The reconstruction worker, as an HTTP service.

    python3 -m workers.reconstruction           # serve on :8788
    python3 -m workers.reconstruction --dump out/ --once request.json

Speaks exactly the contract `server/src/reconstruction/provider.ts` validates: one POST
carrying the calibration triple, the room and the keyframes; one JSON response carrying a
manifest and its assets. Fastify re-validates everything this returns and the store applies
the semantic cross-checks, so nothing here is trusted.

Deliberately stdlib-only for the transport. The heavy dependencies are numpy/cv2/torch,
which the pipeline needs anyway; adding a web framework to a single-route service would be
another thing to keep patched for no benefit.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from erase import erase  # noqa: E402
from pipeline import reconstruct  # noqa: E402

MAX_BODY = 96 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    dump_root: Path | None = None
    token: str = ""

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        sys.stderr.write(f"worker {fmt % args}\n")

    def do_POST(self) -> None:  # noqa: N802
        if self.token:
            provided = self.headers.get("Authorization", "")
            if provided != f"Bearer {self.token}":
                self._send(401, {"error": "unauthorized"})
                return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._send(413, {"error": "bad_length"})
            return
        try:
            request = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid_json"})
            return
        # TWO ROUTES NOW, AND STILL NO FRAMEWORK. `/erase` answers one frame at a time
        # for live hiding; everything else is the sweep. A path comparison is the whole
        # of the dispatch, which is cheaper to keep correct than a dependency.
        if self.path.rstrip("/") == "/erase":
            try:
                result = erase(request)
            except ValueError as error:
                self._send(400, {"error": str(error)})
                return
            except Exception as error:  # pragma: no cover - surfaced to the server log
                traceback.print_exc()
                self._send(500, {"error": type(error).__name__})
                return
            self.log_message("erase %s", json.dumps(result["stages"]))
            self._send(200, result)
            return
        try:
            result = reconstruct(request, self.dump_root)
        except Exception as error:  # pragma: no cover - surfaced to the server log
            traceback.print_exc()
            self._send(500, {"error": type(error).__name__})
            return
        self.log_message("stages %s", json.dumps(result.stages))
        self._send(200, {"manifest": result.manifest, "assets": result.assets})

    def _send(self, code: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description="Reality Editor reconstruction worker")
    parser.add_argument("--port", type=int, default=int(os.environ.get("WORKER_PORT", 8788)))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--dump", type=Path, help="write every stage's output here")
    parser.add_argument("--once", type=Path, help="process one request file and exit")
    args = parser.parse_args()

    if args.once:
        result = reconstruct(json.loads(args.once.read_text()), args.dump)
        print(json.dumps(result.stages, indent=2))
        print(f"{len(result.assets)} assets, {sum(len(a['dataBase64']) for a in result.assets)} base64 chars")
        return 0

    Handler.dump_root = args.dump
    Handler.token = os.environ.get("RECONSTRUCTION_WORKER_TOKEN", "")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"reconstruction worker on http://{args.host}:{args.port}", file=sys.stderr)
    print(
        f"  SAM_WEIGHTS={os.environ.get('SAM_WEIGHTS') or 'unset (geometric masks only)'}",
        file=sys.stderr,
    )
    print(
        f"  LAMA_WEIGHTS={os.environ.get('LAMA_WEIGHTS') or 'unset (jump-flood fill)'}",
        file=sys.stderr,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

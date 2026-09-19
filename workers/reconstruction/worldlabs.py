"""
World Labs depth-to-RGB client, with the spend controls M8.5-B requires.

NOT WIRED TO ANYTHING BY DEFAULT, AND IT CANNOT BE WIRED UP BY ACCIDENT.
Three independent gates stand between this file and a charge:

1. `APPEARANCE_PROVIDER=worldlabs` must be set.
2. `panorama.PROVIDER_CONVENTION_VERIFIED` must be True, which only a person can flip
   after running the provider's published depth example (M8.5-C.3).
3. `WORLDLABS_CEILING_CREDITS` must be set to a positive number. There is no default,
   because a default ceiling is a ceiling nobody chose.

The ledger reserves the maximum possible charge BEFORE a request leaves and releases the
difference on settlement. The milestone is explicit that a failed or locally cancelled
request is not automatically free, so a reservation is only released against a recorded
outcome, never optimistically.

Everything here stays backend-side: the key, the operation ids and the asset URLs never
appear in a manifest, a diagnostic, or anything the device can see.
"""

from __future__ import annotations

import io
import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

import numpy as np

from appearance import AppearanceCandidate, AppearanceRequest
from panorama import encode_depth_png

BASE_URL = os.environ.get("WORLDLABS_BASE_URL", "https://api.worldlabs.ai")
DEPTH_TO_RGB_PATH = "/marble/v1/pano:depth_to_rgb"
# 1,250 credits per USD on the reviewed pricing page. Depth-to-RGB is NOT separately
# priced there, so this is a placeholder the operator must replace with the confirmed
# figure; it is deliberately high so an unconfirmed price cannot under-reserve.
ASSUMED_MAX_CREDITS_PER_REQUEST = int(os.environ.get("WORLDLABS_MAX_CREDITS_PER_REQUEST", "1600"))
# Generation is documented at around five minutes and is not an SLA. The milestone
# proposes a ten-minute end-to-end refinement deadline; this is the generation share.
POLL_DEADLINE_S = float(os.environ.get("WORLDLABS_DEADLINE_S", "480"))
MAX_ASSET_BYTES = 64 * 1024 * 1024


class BudgetExceeded(RuntimeError):
    pass


@dataclass
class Ledger:
    """
    Admission control. Reserves the worst case, settles against the real charge.

    In memory on purpose: this is an evaluation harness, and a ledger that survives a
    restart would imply an accounting guarantee it cannot make. The operator reconciles
    against the provider's own billing, which is the only authoritative record.
    """

    ceiling: int
    reserved: int = 0
    settled: int = 0
    entries: list[dict] = field(default_factory=list)

    @property
    def committed(self) -> int:
        return self.reserved + self.settled

    def reserve(self, credits: int, note: str) -> None:
        if self.committed + credits > self.ceiling:
            raise BudgetExceeded(
                f"{note}: {credits} credits would take commitments to "
                f"{self.committed + credits} against a ceiling of {self.ceiling}"
            )
        self.reserved += credits
        self.entries.append({"event": "reserve", "credits": credits, "note": note})

    def settle(self, reserved: int, actual: int, note: str) -> None:
        self.reserved -= reserved
        self.settled += actual
        self.entries.append(
            {"event": "settle", "reserved": reserved, "actual": actual, "note": note}
        )

    def abandon(self, reserved: int, note: str) -> None:
        """
        An outcome we could not confirm. The reservation becomes a settled charge.

        Deliberately pessimistic: an ambiguously accepted POST may well have been
        billed, and treating it as free is how an evaluation quietly runs past its
        ceiling. Reconcile against the provider and correct the ledger by hand.
        """
        self.reserved -= reserved
        self.settled += reserved
        self.entries.append({"event": "abandon", "credits": reserved, "note": note})


class WorldLabsProvider:
    id = "worldlabs-depth-to-rgb"

    def __init__(self, ledger: Ledger | None = None) -> None:
        self.key = os.environ.get("WORLDLABS_API_KEY", "").strip()
        if not self.key:
            raise RuntimeError("WORLDLABS_API_KEY is not set")
        ceiling = os.environ.get("WORLDLABS_CEILING_CREDITS", "").strip()
        if not ceiling.isdigit() or int(ceiling) <= 0:
            raise RuntimeError(
                "WORLDLABS_CEILING_CREDITS must be set to a positive number of credits. "
                "There is no default: an approved spending ceiling is a decision, not a "
                "fallback (M8.5-B)."
            )
        # Recorded, not sent. The reviewed depth_to_rgb schema documents no model field,
        # so sending one would be guessing; the identifier is still captured so a run
        # ledger row says which configuration produced it.
        self.model = os.environ.get("WORLDLABS_MODEL", "depth_to_rgb/unspecified").strip()
        self.ledger = ledger or Ledger(ceiling=int(ceiling))
        # Surfaced in the run ledger; never swallowed.
        self.caveats: list[str] = []

    # -------------------------------------------------------------- transport

    def _request(self, method: str, url: str, body: dict | None = None) -> tuple[int, dict, dict]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.key}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read()
                return response.status, dict(response.headers), json.loads(payload or b"{}")
        except urllib.error.HTTPError as error:
            body_text = error.read()[:2048].decode("utf-8", "replace")
            return error.code, dict(error.headers or {}), {"error": body_text}

    def _download(self, url: str) -> bytes | None:
        """Bounded, and only over https. A provider URL is not a licence to stream."""
        if not url.lower().startswith("https://"):
            return None
        request = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(request, timeout=120) as response:
            buffer = io.BytesIO()
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                buffer.write(chunk)
                if buffer.tell() > MAX_ASSET_BYTES:
                    return None
            return buffer.getvalue()

    # -------------------------------------------------------------- provider

    def _depth_payload(self, request: AppearanceRequest) -> tuple[dict, dict] | None:
        """
        The depth panorama, as the documented schema wants it.

        EXR IS PREFERRED, AND NOT FOR PRECISION. The PNG path is "normalized [0, 1]"
        with `z_min`/`z_max`, and the reviewed contract documents no value meaning
        UNKNOWN — so a window, which has no depth, would have to be sent as some
        distance, and the milestone is explicit that inventing a depth encoding
        disqualifies the route. EXR carries float depth, so `inf` says "nothing here"
        honestly. PNG stays as a fallback and records the caveat rather than hiding it.
        """
        import base64

        import cv2

        depth = request.depth.depth.astype(np.float32).copy()
        unknown = ~request.depth.known
        # `haveImageWriter` RAISES when the codec is compiled out rather than returning
        # False, so it cannot be used as a predicate. OpenCV ships OpenEXR disabled by
        # default over a past CVE; enabling it is the operator's decision via
        # OPENCV_IO_ENABLE_OPENEXR=1 before this process starts, not something to switch
        # on from inside the worker.
        exr = False
        try:
            exr = bool(cv2.haveImageWriter(".exr"))
        except Exception:
            exr = False
        if exr:
            depth[unknown] = np.inf
            ok, buffer = cv2.imencode(".exr", depth)
            if ok:
                return (
                    {
                        "source": "data_base64",
                        "data_base64": base64.b64encode(buffer.tobytes()).decode("ascii"),
                        "extension": "exr",
                    },
                    {},
                )
        encoded, z_min, z_max = encode_depth_png(request.depth)
        ok, buffer = cv2.imencode(".png", encoded.astype(np.uint16))
        if not ok:
            return None
        self.caveats.append(
            "EXR unavailable; depth sent as normalised PNG, in which unknown rays "
            "through openings cannot be distinguished from real distance."
        )
        return (
            {
                "source": "data_base64",
                "data_base64": base64.b64encode(buffer.tobytes()).decode("ascii"),
                "extension": "png",
            },
            {"z_min": z_min, "z_max": z_max},
        )

    def generate(self, request: AppearanceRequest) -> AppearanceCandidate | None:
        payload = self._depth_payload(request)
        if payload is None:
            return None
        depth_field, bounds = payload

        reserved = ASSUMED_MAX_CREDITS_PER_REQUEST
        self.ledger.reserve(reserved, f"depth_to_rgb seed={request.seed}")
        operation: str | None = None
        try:
            # Field names are the documented ones: `text_prompt`, `depth_pano_image`
            # with a `source` discriminator, and z_min/z_max at the TOP level for PNG
            # only. An earlier draft of this client invented all four.
            status, _headers, body = self._request(
                "POST",
                f"{BASE_URL}{DEPTH_TO_RGB_PATH}",
                {
                    "text_prompt": request.prompt,
                    "seed": request.seed,
                    "depth_pano_image": depth_field,
                    **bounds,
                },
            )
            if status >= 400:
                # A 4xx before acceptance is the one case that is reliably unbilled.
                self.ledger.settle(reserved, 0, f"rejected {status}")
                return None
            operation = body.get("operation_id") or body.get("operation") or body.get("id")
            if not operation:
                self.ledger.abandon(reserved, "accepted with no operation id")
                return None

            result = self._await(operation)
            if result is None:
                # Accepted and then unresolved. Charged until proven otherwise.
                self.ledger.abandon(reserved, f"unresolved operation {operation}")
                return None
            url = result.get("pano_url") or result.get("url")
            image_bytes = self._download(url) if url else None
            if not image_bytes:
                self.ledger.abandon(reserved, f"undownloadable result {operation}")
                return None
            decoded = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
            if decoded is None:
                self.ledger.abandon(reserved, f"undecodable result {operation}")
                return None
            billed = int(result.get("credits_used", reserved))
            self.ledger.settle(reserved, billed, f"completed {operation}")
            return AppearanceCandidate(
                panorama=cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB),
                provider=self.id,
                model=str(result.get("model", self.model)),
                seed=request.seed,
                operation_id=operation,
                billed_credits=billed,
            )
        except Exception:
            self.ledger.abandon(reserved, f"exception with operation {operation!r}")
            raise

    def _await(self, operation: str) -> dict | None:
        """Bounded backoff that honours `Retry-After`. Never resubmits the POST."""
        deadline = time.monotonic() + POLL_DEADLINE_S
        wait = 5.0
        while time.monotonic() < deadline:
            status, headers, body = self._request("GET", f"{BASE_URL}/operations/{operation}")
            if status == 429 or status >= 500:
                retry_after = headers.get("Retry-After")
                wait = float(retry_after) if retry_after and str(retry_after).isdigit() else min(wait * 2, 60.0)
            elif status >= 400:
                return None
            elif body.get("done") is True:
                return body.get("response") or body
            else:
                wait = min(wait * 1.5, 30.0)
            time.sleep(min(wait, max(0.0, deadline - time.monotonic())))
        return None

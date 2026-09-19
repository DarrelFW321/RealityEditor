"""
The reconstruction chain, end to end, through the real HTTP path.

Not part of `npm run gate`: that suite is hermetic and this needs two live services.
It exists because every piece was individually green while the chain as a whole was
dead — the server had no worker configured, so `provider_not_configured` refused every
job and no shell was ever produced. Nothing hermetic could have caught that.

    python3 -m workers.reconstruction --port 8788      # terminal 1
    npm run server                                     # terminal 2
    npm run e2e:reconstruction                         # terminal 3

Uses the worker self-test's synthetic room and rendered keyframes, so it needs no
capture and no device. Cleans up the calibration it creates.
"""
import base64, json, sys, time, urllib.request, urllib.error
sys.path.insert(0, 'workers/reconstruction')
import selftest

import os
API = os.environ.get("E2E_API", "http://localhost:8787")

def call(method, path, body=None, token=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"{API}{path}", data=data, method=method)
    if data: r.add_header("Content-Type", "application/json")
    if token: r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            payload = resp.read()
            return resp.status, (payload if raw else json.loads(payload or b"{}")), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), {}

obstacle = {"id": "obj-bed", "center": [-0.9, 0.0, 0.6], "size": [1.4, 0.6, 2.0], "yaw": 0.0}
req = selftest.build_request(obstacle)
room, keyframes = req["room"], req["keyframes"]

print("1. create calibration")
code, body, _ = call("POST", "/calibrations", {"revision": 0, "frameId": req["frameId"], "room": room})
print(f"   HTTP {code} id={body.get('id','')[:8]}…")
assert code == 201, body
cal, token = body["id"], body["token"]

print(f"2. upload {len(keyframes)} keyframes")
for i, kf in enumerate(keyframes):
    code, body, _ = call("POST", f"/calibrations/{cal}/frames", kf, token)
    assert code == 201, (i, code, body)
print(f"   all {len(keyframes)} accepted")

print("3. reconstruct")
code, job, _ = call("POST", f"/calibrations/{cal}/reconstruct", {"revision": 0, "frameId": req["frameId"]}, token)
print(f"   HTTP {code} job={job.get('id','')[:8]}… status={job.get('status')}")
assert code == 202, job

print("4. poll")
started = time.time()
while time.time() - started < 180:
    time.sleep(1.5)
    code, job, _ = call("GET", f"/jobs/{job['id']}", None, token)
    print(f"   {time.time()-started:5.1f}s  {job['status']}/{job['stage']}")
    if job["status"] not in ("queued", "running"): break
assert job["status"] == "completed", job

manifest = job["result"]
print(f"   artifacts: {[(a['key'], a['role'], a['inferred']) for a in manifest['artifacts']]}")
print(f"   removedObjectIds: {manifest['removedObjectIds']}")

print("5. fetch assets")
for art in manifest["artifacts"]:
    code, blob, headers = call("GET", f"/calibrations/{cal}/assets/{art['key']}", None, token, raw=True)
    print(f"   {art['key']:12} HTTP {code}  {len(blob):>8} bytes  {headers.get('Content-Type')}")
    assert code == 200
    if art["key"].endswith(".json"):
        shell = json.loads(blob)
        print(f"     shell: space={shell['space']} completion={shell['completion']} surfaces={len(shell['surfaces'])}")
        for s in shell["surfaces"]:
            print(f"       {s['id']:8} observed={s['observedFraction']:.0%} inferred={s['inferred']} verts={len(s['positions'])}")
    else:
        import numpy as np, cv2
        img = cv2.imdecode(np.frombuffer(blob, np.uint8), cv2.IMREAD_COLOR)
        print(f"     atlas: {img.shape[1]}x{img.shape[0]} stddev={img.std():.1f}")

print("6. cleanup")
code, _, _ = call("DELETE", f"/calibrations/{cal}", None, token)
print(f"   HTTP {code}")
print("\nEND TO END OK")

"""
Video rooms WITH participants, so Twilio produces real recordings.

Why this is not in gen/core.py: a recording only exists when a participant
publishes audio/video, which needs a real WebRTC client. This module drives
headless Chromium (Playwright, fake camera/mic) with twilio-video.js. It is
the only place in the repo that needs a third-party package, so it is never
imported by gen/core.py and never ends up in a standalone script.

Flow: (temporary) API key -> per room: create it with
RecordParticipantsOnConnect -> participants join concurrently, hold, leave ->
complete the room -> wait for its recordings to reach `completed`.

Progress lines parsed by desktop/lib/progress.js (keep the format):
  [plan] video_recordings=N        N = participants
  [video_rec i/n] room=... identity=... hold=Ns err=...
  [plan] video_compositions=N      N = rooms with completed recordings (--video-compose)
  [video_comp i/n] room=... composition=... status=... err=...
"""
import os
import json
import time
import hmac
import glob
import random
import base64
import hashlib
import asyncio
import urllib.error
import urllib.parse
import urllib.request
import signal

from . import core

TWILIO_VIDEO_JS = "https://unpkg.com/twilio-video@2.36.1/dist/twilio-video.min.js"
PAGE_ORIGIN = "https://telefono.local"
RECORDING_WAIT_SECONDS = 90
COMPOSITION_WAIT_SECONDS = 300

# Stage/dev hosts resolve to private addresses (VPN); Chrome would otherwise block
# a "public" page from opening the signaling websocket to them.
CHROME_ARGS = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,"
    "PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests",
]

JOIN_JS = """async ([token, name, holdMs, env]) => {
  const tracks = await Twilio.Video.createLocalTracks({audio: true, video: {width: 320, height: 240}});
  const room = await Twilio.Video.connect(token, {name, tracks, environment: env});
  const sid = room.localParticipant.sid;
  await new Promise(r => setTimeout(r, holdMs));
  room.disconnect(); tracks.forEach(t => t.stop && t.stop());
  return sid;
}"""


def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def make_token(account_sid, key_sid, secret, identity, room_name, ttl=900):
    header = _b64(json.dumps({"alg": "HS256", "typ": "JWT", "cty": "twilio-fpa;v=1"}).encode())
    now = int(time.time())
    payload = _b64(json.dumps({
        "jti": f"{key_sid}-{now}", "iss": key_sid, "sub": account_sid, "iat": now, "exp": now + ttl,
        "grants": {"identity": identity, "video": {"room": room_name}},
    }).encode())
    sig = _b64(hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"


def _api(host, auth, method, path, data=None):
    req = urllib.request.Request(f"https://{host}{path}", method=method,
                                 data=urllib.parse.urlencode(data).encode() if data else None)
    req.add_header("Authorization", auth)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        return {"error": True, "status": e.code, "body": e.read().decode()[:300]}
    except Exception as e:
        return {"error": True, "status": None, "body": str(e)}


def video_environment(api_host):
    """api.stage.twilio.com -> 'stage', api.dev.twilio.com -> 'dev'."""
    parts = api_host.split(".")
    return parts[1] if len(parts) == 4 and parts[1] in ("stage", "dev") else "prod"


def distribute(participants, rooms):
    """Participants per room, as even as possible (every room gets at least 1)."""
    base, extra = divmod(participants, rooms)
    return [base + (1 if i < extra else 0) for i in range(rooms)]


def _find_cached_chromium():
    """Playwright's own browser may not match this Playwright version; fall back to any
    Chromium already in its cache so no download is needed."""
    pattern = os.path.expanduser(
        "~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
    found = sorted(glob.glob(pattern))
    return found[-1] if found else None


async def _launch(pw):
    try:
        return await pw.chromium.launch(headless=True, args=CHROME_ARGS)
    except Exception as first:
        cached = _find_cached_chromium()
        if cached:
            return await pw.chromium.launch(executable_path=cached, headless=True, args=CHROME_ARGS)
        raise RuntimeError(f"Chromium is not available ({str(first).splitlines()[0]}). "
                           "Run: python3 -m playwright install chromium")


async def _participant(ctx, browser, tok, room_name, identity, hold, env):
    page = await ctx.new_page()
    try:
        await page.route(f"{PAGE_ORIGIN}/**", lambda route: route.fulfill(
            body=f'<html><body><script src="{TWILIO_VIDEO_JS}"></script></body></html>', content_type="text/html"))
        await page.goto(f"{PAGE_ORIGIN}/")
        await page.wait_for_function("window.Twilio && window.Twilio.Video", timeout=30000)
        return await page.evaluate(JOIN_JS, [tok, room_name, hold * 1000, env])
    finally:
        await page.close()


def _wait_for_recordings(video_host, auth, room_sid):
    deadline = time.time() + RECORDING_WAIT_SECONDS
    recs = []
    while time.time() < deadline:
        r = core.video_request(video_host, auth, "GET", f"/Rooms/{room_sid}/Recordings")
        recs = r.get("recordings", []) if not r.get("error") else []
        if recs and all(x.get("status") == "completed" for x in recs):
            break
        time.sleep(4)
    return [{"type": x.get("type"), "status": x.get("status")} for x in recs]


async def _run(cfg, plan, n_rooms, per_room, holds_spec):
    from playwright.async_api import async_playwright

    video_host, auth = cfg["video_host"], cfg["auth_header"]
    env = video_environment(cfg["host"])
    prefix = plan.get("video_room_prefix") or "telefono"
    stamp = format(int(time.time()), "x")
    total = sum(per_room)
    entries, rooms_out = [], []
    counter = {"n": 0}

    def report(entry):
        counter["n"] += 1
        entry["index"] = counter["n"] - 1
        entries.append(entry)
        print(f"[video_rec {counter['n']}/{total}] room={entry['room_name']} identity={entry['identity']} "
              f"hold={entry['hold_seconds']}s joined={entry['joined']} err={entry['error']}", flush=True)

    async with async_playwright() as pw:
        try:
            browser = await _launch(pw)
        except Exception as e:
            for r, count in enumerate(per_room):
                for p in range(count):
                    report({"room_name": f"{prefix}-rec-{stamp}-{r + 1}", "room_sid": None,
                            "identity": f"p{p + 1}", "hold_seconds": 0, "joined": False, "error": str(e)})
            return entries, rooms_out
        try:
            for r, count in enumerate(per_room):
                name = f"{prefix}-rec-{stamp}-{r + 1}"
                room = core.video_request(video_host, auth, "POST", "/Rooms", {
                    "UniqueName": name, "AudioOnly": "false", "RecordParticipantsOnConnect": "true"})
                room_sid = room.get("sid")
                if not room_sid:
                    for p in range(count):
                        report({"room_name": name, "room_sid": None, "identity": f"p{p + 1}", "hold_seconds": 0,
                                "joined": False, "error": f"room not created: {room.get('body')}"})
                    continue
                ctx = await browser.new_context()
                await ctx.grant_permissions(["camera", "microphone"], origin=PAGE_ORIGIN)

                async def one(p, name=name, room_sid=room_sid, ctx=ctx):
                    identity = f"p{p + 1}"
                    hold = core.parse_duration_range_spec(holds_spec) or 5
                    tok = make_token(cfg["account_sid"], cfg["key_sid"], cfg["key_secret"], identity, name)
                    entry = {"room_name": name, "room_sid": room_sid, "identity": identity,
                             "hold_seconds": hold, "joined": False, "error": None}
                    try:
                        await _participant(ctx, browser, tok, name, identity, hold, env)
                        entry["joined"] = True
                    except Exception as e:
                        entry["error"] = str(e).splitlines()[0][:300]
                    report(entry)

                try:
                    await asyncio.gather(*[one(p) for p in range(count)])
                finally:
                    await ctx.close()
                    core.video_request(video_host, auth, "POST", f"/Rooms/{room_sid}", {"Status": "completed"})
                loop = asyncio.get_event_loop()
                recs = await loop.run_in_executor(None, _wait_for_recordings, video_host, auth, room_sid)
                rooms_out.append({"room_name": name, "room_sid": room_sid, "participants": count, "recordings": recs})
        finally:
            await browser.close()
    return entries, rooms_out


def compose_rooms(cfg, rooms):
    """One composition (grid, mp4, 640x480, every audio source) per room whose recordings completed.
    Rooms are submitted first, then polled together, so the waits overlap instead of adding up."""
    video_host, auth = cfg["video_host"], cfg["auth_header"]
    todo = [r for r in rooms if r["recordings"] and all(x["status"] == "completed" for x in r["recordings"])]
    print(f"[plan] video_compositions={len(todo)}", flush=True)  # parsed by desktop/lib/progress.js, keep the format
    out, pending = [], []
    for room in todo:
        comp = core.video_request(video_host, auth, "POST", "/Compositions", {
            "RoomSid": room["room_sid"], "AudioSources": "*", "VideoLayout": json.dumps({"grid": {"video_sources": ["*"]}}),
            "Resolution": "640x480", "Format": "mp4"})
        entry = {"room_name": room["room_name"], "room_sid": room["room_sid"], "composition_sid": comp.get("sid"),
                 "status": comp.get("status"), "error": None if comp.get("sid") else f"composition not created: {comp.get('body')}"}
        out.append(entry)
        (pending if comp.get("sid") else []).append(entry)

    done = 0

    def report(entry):
        nonlocal done
        done += 1
        print(f"[video_comp {done}/{len(todo)}] room={entry['room_name']} composition={entry['composition_sid']} "
              f"status={entry['status']} err={entry['error']}", flush=True)

    for entry in out:
        if entry["error"]:
            report(entry)
    deadline = time.time() + COMPOSITION_WAIT_SECONDS
    while pending and time.time() < deadline:
        time.sleep(5)
        for entry in list(pending):
            c = core.video_request(video_host, auth, "GET", f"/Compositions/{entry['composition_sid']}")
            if c.get("error"):
                continue
            entry["status"] = c.get("status")
            if entry["status"] in ("completed", "failed", "deleted"):
                if entry["status"] != "completed":
                    entry["error"] = f"composition {entry['status']}"
                pending.remove(entry)
                report(entry)
    for entry in pending:
        entry["error"] = f"composition still {entry['status']} after {COMPOSITION_WAIT_SECONDS}s"
        report(entry)
    return out


def _raise_stopped(*_):
    raise SystemExit("stopped")


def run_video_recordings(cfg, plan):
    """cfg: host, video_host, account_sid, auth_header, results_path, key_env/secret_env (names or None).
    Returns {"video_recordings": [...participants], "video_recording_rooms": [...]}."""
    n_rooms = max(1, core.parse_count_spec(plan.get("video_rec_rooms") or "1"))
    participants = max(n_rooms, core.parse_count_spec(plan["video_recordings"]))
    per_room = distribute(participants, n_rooms)
    holds_spec = plan.get("video_hold") or "5-15"
    print(f"[plan] video_recordings={participants}", flush=True)  # parsed by desktop/lib/progress.js, keep the format

    try:
        import playwright  # noqa: F401
    except ImportError:
        msg = "Playwright is not installed for this Python. Run: pip3 install playwright"
        print(f"ERROR: {msg}", flush=True)
        return {"video_recordings": [{"index": i, "room_name": None, "room_sid": None, "identity": f"p{i + 1}",
                                      "hold_seconds": 0, "joined": False, "error": msg} for i in range(participants)],
                "video_recording_rooms": []}

    # a stopped run (SIGTERM from the desktop app) must still delete its temporary API key, so turn it into a normal exit
    signal.signal(signal.SIGTERM, _raise_stopped)
    temp_key = None
    if plan.get("video_key_env"):
        cfg = dict(cfg, key_sid=os.environ.get(plan["video_key_env"], ""), key_secret=os.environ.get(plan["video_secret_env"], ""))
        if not cfg["key_sid"] or not cfg["key_secret"]:
            raise SystemExit("The API key env vars named by --video-key-env/--video-secret-env are empty.")
    else:
        key = _api(cfg["host"], cfg["auth_header"], "POST",
                   f"/2010-04-01/Accounts/{cfg['account_sid']}/Keys.json", {"FriendlyName": "telefono-temp"})
        if not key.get("sid"):
            msg = f"could not create a temporary API key: {key.get('body')}"
            print(f"ERROR: {msg}", flush=True)
            return {"video_recordings": [{"index": i, "room_name": None, "room_sid": None, "identity": f"p{i + 1}",
                                          "hold_seconds": 0, "joined": False, "error": msg} for i in range(participants)],
                    "video_recording_rooms": []}
        temp_key = key["sid"]
        cfg = dict(cfg, key_sid=key["sid"], key_secret=key["secret"])
    try:
        entries, rooms = asyncio.run(_run(cfg, plan, n_rooms, per_room, holds_spec))
    finally:
        if temp_key:
            res = _api(cfg["host"], cfg["auth_header"], "DELETE",
                       f"/2010-04-01/Accounts/{cfg['account_sid']}/Keys/{temp_key}.json")
            print("Temporary API key removed." if not res.get("error") else f"WARNING: could not delete temporary API key {temp_key}: {res.get('body')}", flush=True)
    out = {"video_recordings": entries, "video_recording_rooms": rooms}
    if plan.get("video_compose"):
        out["video_compositions"] = compose_rooms(cfg, rooms)
    return out


def print_summary(out):
    rooms = out.get("video_recording_rooms", [])
    recs = [r for room in rooms for r in room["recordings"]]
    done = sum(1 for r in recs if r["status"] == "completed")
    joined = sum(1 for e in out.get("video_recordings", []) if e["joined"])
    print(f"Video recordings: {joined} participant(s) joined, {done}/{len(recs)} recording(s) completed")
    comps = out.get("video_compositions")
    if comps is not None:
        print(f"Video compositions: {sum(1 for c in comps if c['status'] == 'completed')}/{len(comps)} completed")

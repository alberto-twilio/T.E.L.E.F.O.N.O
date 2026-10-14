#!/usr/bin/env python3
"""
Core Voice test-data generation logic: calls, recordings+transcriptions,
and conferences (with optional region), against a Twilio account's own
numbers. Never dials a real external number.

Stdlib only, on purpose: this file is designed to be read verbatim and
concatenated into a standalone, shareable script (see wizard.py's
`render_standalone`). Do not add third-party imports here.

Credentials are never embedded in this file. Callers (wizard.py, or the
CONFIG block prepended when this is emitted standalone) pass an Account
SID + Auth Token read from the environment.
"""
import os
import json
import time
import random
import base64
import datetime
import urllib.request
import urllib.parse
import urllib.error
from collections import Counter

# ---------------------------------------------------------------- HTTP ----

def build_auth_header(account_sid, auth_token):
    return "Basic " + base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode()

def request(host, account_sid, auth_header, method, path, data=None):
    url = f"https://{host}/2010-04-01/Accounts/{account_sid}{path}"
    body = urllib.parse.urlencode(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", auth_header)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": True, "status": e.code, "body": e.read().decode()[:400]}
    except Exception as e:
        return {"error": True, "status": None, "body": str(e)}

def twimlet(twiml):
    return "https://twimlets.com/echo?Twiml=" + urllib.parse.quote(twiml)

# --------------------------------------------------------------- specs ----
# Every plan value below is a SPEC (a string like "10-60" or "0"), never a
# pre-rolled number. Resolving a spec (random.randint) must only happen
# inside the run_* functions, at actual execution time. This is what makes
# a saved standalone script re-roll fresh every time it's run, instead of
# baking in whatever number happened to be rolled when it was generated.

def parse_count_spec(raw):
    """raw: '0', 'N', or 'min-max'. Returns a freshly-rolled int."""
    raw = str(raw).strip()
    if raw in ("0", ""):
        return 0
    if "-" in raw:
        lo, hi = raw.split("-", 1)
        return random.randint(int(lo), int(hi))
    return int(raw)

def parse_duration_token(token):
    """'30s' -> 30, '3m' -> 180, '90' -> 90 (bare seconds)."""
    token = str(token).strip().lower()
    if token.endswith("m"):
        return int(round(float(token[:-1]) * 60))
    if token.endswith("s"):
        return int(round(float(token[:-1])))
    return int(round(float(token)))

def parse_duration_range_spec(raw):
    """raw: '0'/''/None (disabled) or 'min-max' e.g. '1s-3m', '30s-90s',
    or bare seconds '10-60'. Returns a freshly-rolled duration in seconds,
    or None if disabled."""
    if not raw:
        return None
    raw = str(raw).strip()
    if raw in ("0", ""):
        return None
    lo_raw, hi_raw = raw.split("-", 1)
    lo, hi = parse_duration_token(lo_raw), parse_duration_token(hi_raw)
    if hi < lo:
        lo, hi = hi, lo
    return random.randint(lo, hi)

def spec_enabled(spec):
    return spec not in (None, "", "0", 0)

# ------------------------------------------------------------- content ----

PASSAGES = [
    "Call me Ishmael. Some years ago, never mind how long precisely, having little or no "
    "money in my purse, and nothing particular to interest me on shore, I thought I would "
    "sail about a little and see the watery part of the world. It is a way I have of driving "
    "off the spleen, and regulating the circulation.",

    "It was the best of times, it was the worst of times, it was the age of wisdom, it was "
    "the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, it "
    "was the season of Light, it was the season of Darkness, it was the spring of hope, it "
    "was the winter of despair.",

    "It is a truth universally acknowledged, that a single man in possession of a good "
    "fortune, must be in want of a wife. However little known the feelings or views of such "
    "a man may be on his first entering a neighbourhood, this truth is so well fixed in the "
    "minds of the surrounding families.",

    "In a village of La Mancha, the name of which I have no desire to call to mind, there "
    "lived not long since one of those gentlemen that keep a lance in the lance rack, an old "
    "buckler, a lean hack, and a greyhound for coursing.",
]

SHORT_TEXTS = [
    "This is a test call.",
    "Quick completed call test.",
    "Verifying call logging for today's batch.",
    "Routine test call, please disregard.",
]

# --------------------------------------------------------- number pairing --

def make_pairs(numbers):
    """numbers: list of {"phone": str, "sid": str}. Returns list of (from, to) pairs
    cycling through every number as both caller and callee."""
    n = len(numbers)
    return [(numbers[i], numbers[(i + 1) % n]) for i in range(n)]

def pick_conference_players(numbers, i):
    """Pick two participants and two caller-ID numbers for conference leg i.
    Degrades gracefully down to 2 numbers (participants double as each
    other's caller ID, per the manual guide's 2-number fallback)."""
    n = len(numbers)
    p1 = numbers[i % n]
    p2 = numbers[(i + 1) % n]
    caller1 = numbers[(i + 2) % n] if n >= 3 else p2
    caller2 = numbers[(i + 3) % n] if n >= 4 else p1
    return p1, p2, caller1, caller2

def region_for(i, regions):
    if not regions:
        return None
    return regions[i % len(regions)]

# ------------------------------------------------------------ generators --

def set_voice_url(ctx, pn_sid, twiml):
    return request(ctx["host"], ctx["account_sid"], ctx["auth_header"],
                   "POST", f"/IncomingPhoneNumbers/{pn_sid}.json", {"VoiceUrl": twimlet(twiml)})

def create_call(ctx, from_num, to_num, twiml):
    return request(ctx["host"], ctx["account_sid"], ctx["auth_header"],
                   "POST", "/Calls.json",
                   {"From": from_num, "To": to_num, "Url": twimlet(twiml)})

def run_calls(ctx, n_spec, weights=(0.55, 0.25, 0.20), duration_spec=None):
    n = parse_count_spec(n_spec)
    print(f"[plan] calls={n}", flush=True)  # parsed by desktop/lib/progress.js, keep the format
    numbers = ctx["numbers"]
    pairs = make_pairs(numbers)
    call_types = random.choices(["completed", "failed", "canceled"], weights=list(weights), k=n)
    out = []
    for i, ctype in enumerate(call_types):
        frm, to = pairs[i % len(pairs)]
        entry = {"index": i, "type": ctype}
        if ctype == "completed":
            # Each completed call rolls its own target duration independently,
            # a fresh random.randint every call, not just every run.
            target_seconds = parse_duration_range_spec(duration_spec)
            if target_seconds is not None:
                text = random.choice(SHORT_TEXTS)
                # Callee's pause is the exact target; caller's is a few
                # seconds longer, so the shorter (callee) side governs when
                # the call actually ends, per the precise-duration recipe.
                set_voice_url(ctx, to["sid"],
                              f'<Response><Say>{text}</Say><Pause length="{target_seconds}"/><Hangup/></Response>')
                r = create_call(ctx, frm["phone"], to["phone"],
                                 f'<Response><Say>Caller side.</Say><Pause length="{target_seconds + 5}"/><Hangup/></Response>')
                entry["target_duration_seconds"] = target_seconds
            else:
                long_form = random.random() < 0.15
                text = random.choice(PASSAGES) if long_form else random.choice(SHORT_TEXTS)
                set_voice_url(ctx, to["sid"], f"<Response><Say>{text}</Say><Hangup/></Response>")
                r = create_call(ctx, frm["phone"], to["phone"], "<Response><Say>Caller side.</Say><Hangup/></Response>")
                entry["long_form"] = long_form
        elif ctype == "failed":
            r = create_call(ctx, frm["phone"], "+19999999999", "<Response><Hangup/></Response>")
        else:  # canceled
            r = create_call(ctx, frm["phone"], to["phone"], '<Response><Pause length="10"/></Response>')
            if r.get("sid"):
                request(ctx["host"], ctx["account_sid"], ctx["auth_header"],
                        "POST", f"/Calls/{r['sid']}.json", {"Status": "canceled"})
        entry["sid"] = r.get("sid")
        entry["error"] = r.get("body") if r.get("error") else None
        out.append(entry)
        duration_note = f" target_duration={entry['target_duration_seconds']}s" if "target_duration_seconds" in entry else ""
        print(f"[call {i+1}/{n}] {ctype} sid={entry['sid']}{duration_note} err={entry['error']}", flush=True)
        time.sleep(1.3)
    return out

def run_recordings_transcriptions(ctx, n_spec):
    n = parse_count_spec(n_spec)
    print(f"[plan] rec_trans={n}", flush=True)  # parsed by desktop/lib/progress.js, keep the format
    numbers = ctx["numbers"]
    pairs = make_pairs(numbers)
    out = []
    for i in range(n):
        frm, to = pairs[i % len(pairs)]
        long_form = random.random() < 0.2
        passage = random.choice(PASSAGES) if long_form else (
            "This content is being recorded for testing purposes, please transcribe accurately."
        )
        set_voice_url(ctx, to["sid"], f'<Response><Say>{passage}</Say><Pause length="2"/><Hangup/></Response>')
        max_len = 200 if long_form else 30
        r = create_call(ctx, frm["phone"], to["phone"],
                         f'<Response><Say>Hi</Say><Record transcribe="true" maxLength="{max_len}"/></Response>')
        entry = {"index": i, "call_sid": r.get("sid"), "long_form": long_form,
                 "error": r.get("body") if r.get("error") else None}
        out.append(entry)
        print(f"[rec/trans {i+1}/{n}] call_sid={entry['call_sid']} long={long_form} err={entry['error']}", flush=True)
        time.sleep(1.3)
    return out

def run_conferences(ctx, n_spec, regions=None):
    n = parse_count_spec(n_spec)
    print(f"[plan] conf={n}", flush=True)  # parsed by desktop/lib/progress.js, keep the format
    numbers = ctx["numbers"]
    tag = datetime.date.today().strftime("%Y%m%d")
    out = []
    for i in range(n):
        p1, p2, caller1, caller2 = pick_conference_players(numbers, i)
        region = region_for(i, regions)
        region_attr = f' region="{region}"' if region else ""
        room = f"batch-{tag}-{i}" + (f"-{region}" if region else "")
        conf_twiml = f"<Response><Dial><Conference{region_attr}>{room}</Conference></Dial></Response>"

        set_voice_url(ctx, p1["sid"], conf_twiml)
        set_voice_url(ctx, p2["sid"], conf_twiml)
        r1 = create_call(ctx, caller1["phone"], p1["phone"], conf_twiml)
        time.sleep(1.5)
        r2 = create_call(ctx, caller2["phone"], p2["phone"], conf_twiml)
        time.sleep(4)

        conf_sid = None
        for _ in range(2):
            lookup = request(ctx["host"], ctx["account_sid"], ctx["auth_header"],
                              "GET", f"/Conferences.json?FriendlyName={room}")
            confs = lookup.get("conferences", [])
            if confs:
                conf_sid = confs[0]["sid"]
                break
            time.sleep(3)
        ended = False
        if conf_sid:
            end = request(ctx["host"], ctx["account_sid"], ctx["auth_header"],
                           "POST", f"/Conferences/{conf_sid}.json", {"Status": "completed"})
            ended = not end.get("error", False)

        entry = {"index": i, "room": room, "region": region,
                  "leg1_sid": r1.get("sid"), "leg2_sid": r2.get("sid"),
                  "conference_sid": conf_sid, "ended": ended}
        out.append(entry)
        print(f"[conf {i+1}/{n}] room={room} region={region} conf_sid={conf_sid} ended={ended}", flush=True)
    return out

def run_batch(ctx, plan):
    """plan holds SPECS, not pre-rolled numbers, e.g.
    {"calls": "10-60", "recordings_transcriptions": "0", "conferences": "5",
     "conference_regions": [str,...] or None, "call_duration": "1s-3m" or None}.
    Every spec is resolved fresh inside the corresponding run_* function,
    at actual execution time. Run this function twice and you get two
    independent random outcomes, that's deliberate: it's what makes a
    saved standalone script re-roll on every run instead of reproducing
    whatever was rolled when it was generated.
    "0"/0/absent/None = skip category."""
    results = {"planned": plan}
    if spec_enabled(plan.get("calls")):
        results["calls"] = run_calls(ctx, plan["calls"], duration_spec=plan.get("call_duration"))
    else:
        results["calls"] = []
    if spec_enabled(plan.get("recordings_transcriptions")):
        results["recordings_transcriptions"] = run_recordings_transcriptions(ctx, plan["recordings_transcriptions"])
    else:
        results["recordings_transcriptions"] = []
    if spec_enabled(plan.get("conferences")):
        results["conferences"] = run_conferences(ctx, plan["conferences"], plan.get("conference_regions"))
    else:
        results["conferences"] = []
    return results

# ------------------------------------------------------------- reporting --

def poll_results(ctx, results):
    call_status = Counter()
    for c in results.get("calls", []):
        if not c.get("sid"):
            call_status["no_sid"] += 1
            continue
        r = request(ctx["host"], ctx["account_sid"], ctx["auth_header"], "GET", f"/Calls/{c['sid']}.json")
        call_status[r.get("status", "unknown")] += 1
        # Mutates the entry in place so the actual duration lands in the
        # saved results JSON too, next to whatever target was set at fire
        # time, no separate lookup needed to compare the two later.
        c["actual_duration_seconds"] = int(r.get("duration") or 0)

    rec_status = Counter()
    trans_status = Counter()
    for rt in results.get("recordings_transcriptions", []):
        sid = rt.get("call_sid")
        if not sid:
            continue
        recs = request(ctx["host"], ctx["account_sid"], ctx["auth_header"],
                        "GET", f"/Calls/{sid}/Recordings.json").get("recordings", [])
        if not recs:
            rec_status["none_yet"] += 1
            continue
        rec = recs[0]
        rec_status[rec.get("status", "unknown")] += 1
        trans = request(ctx["host"], ctx["account_sid"], ctx["auth_header"],
                         "GET", f"/Recordings/{rec['sid']}/Transcriptions.json").get("transcriptions", [])
        trans_status[trans[0].get("status", "unknown") if trans else "none_yet"] += 1

    conf_status = Counter()
    for cf in results.get("conferences", []):
        sid = cf.get("conference_sid")
        if not sid:
            conf_status["not_found"] += 1
            continue
        r = request(ctx["host"], ctx["account_sid"], ctx["auth_header"], "GET", f"/Conferences/{sid}.json")
        conf_status[r.get("status", "unknown")] += 1

    return {
        "calls": dict(call_status),
        "recordings": dict(rec_status),
        "transcriptions": dict(trans_status),
        "conferences": dict(conf_status),
    }

def print_report(tally, planned, results):
    print("\n--- Final tally ---")
    print(f"Calls:          {tally['calls']}  (spec {planned.get('calls', 0)}, rolled {len(results['calls'])})")

    with_target = [c for c in results.get("calls", []) if "target_duration_seconds" in c]
    if with_target:
        print("  Completed call durations (target -> actual):")
        for c in with_target:
            actual = c.get("actual_duration_seconds", "?")
            print(f"    {c['sid']}: {c['target_duration_seconds']}s -> {actual}s")

    print(f"Recordings:     {tally['recordings']}")
    print(f"Transcriptions: {tally['transcriptions']}")
    print(f"Conferences:    {tally['conferences']}  (spec {planned.get('conferences', 0)}, rolled {len(results['conferences'])})")

# --------------------------------------------------------- standalone run --

def run(config):
    """Entry point used both by wizard.py (constructs config in-process) and
    by the standalone emitted script (config is the prepended CONFIG dict)."""
    account_sid = os.environ[config["sid_env"]]
    auth_token = os.environ[config["token_env"]]
    ctx = {
        "host": config["host"],
        "account_sid": account_sid,
        "auth_header": build_auth_header(account_sid, auth_token),
        "numbers": config["numbers"],
    }
    results_path = config.get("results_path", "voice_batch_results.json")
    results = run_batch(ctx, config["plan"])
    with open(results_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nDone generating. Results written to {results_path}")

    if config.get("poll_after", True):
        tally = poll_results(ctx, results)
        with open(results_path, "w") as f:
            json.dump(results, f, indent=2)  # re-save: poll_results adds actual_duration_seconds in place
        print_report(tally, config["plan"], results)

def main():
    run(CONFIG)  # noqa: F821 -- CONFIG is prepended above this file's source
                 # when emitted as a standalone script by wizard.py

if __name__ == "__main__":
    main()

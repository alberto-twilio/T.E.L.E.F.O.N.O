"""
Deliberate, explicit calling of a REAL external phone number.

This is the one intentional carve-out from the owned-numbers-only
guarantee the rest of this tool makes. Only ever invoked directly by name
via `real_call_burst.py`, never reachable from wizard.py's normal
random-batch flow, and never embedded into any standalone script that
flow emits.
"""
import time
from collections import Counter
from .core import build_auth_header, request, twimlet, PASSAGES

# Default: a real public-domain passage, not a one-liner. A short "Test
# call." ends almost instantly, giving you no window to actually pick up,
# hold, or let it ring out. The Pause after it extends that window further.
DEFAULT_MESSAGE = PASSAGES[0]
DEFAULT_PAUSE_SECONDS = 30


def call_burst(host, account_sid, auth_token, from_number, to_number, count, interval_seconds,
                message=None, pause_seconds=None):
    auth_header = build_auth_header(account_sid, auth_token)
    say = message or DEFAULT_MESSAGE
    pause = DEFAULT_PAUSE_SECONDS if pause_seconds is None else pause_seconds
    url = twimlet(f'<Response><Say>{say}</Say><Pause length="{pause}"/><Hangup/></Response>')
    results = []
    for i in range(count):
        r = request(host, account_sid, auth_header, "POST", "/Calls.json",
                    {"From": from_number, "To": to_number, "Url": url})
        entry = {"index": i, "sid": r.get("sid"), "error": r.get("body") if r.get("error") else None}
        results.append(entry)
        print(f"[call {i+1}/{count}] sid={entry['sid']} err={entry['error']}", flush=True)
        if i < count - 1:
            time.sleep(interval_seconds)
    return results


def poll_burst(host, account_sid, auth_token, results):
    auth_header = build_auth_header(account_sid, auth_token)
    status_counts = Counter()
    for r in results:
        if not r.get("sid"):
            status_counts["no_sid"] += 1
            continue
        c = request(host, account_sid, auth_header, "GET", f"/Calls/{r['sid']}.json")
        status_counts[c.get("status", "unknown")] += 1
    return dict(status_counts)

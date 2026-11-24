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

# --record: the callee's side is recorded with <Record transcribe="true">, the same
# verb the generator's recordings use, so a real call leaves a recording and a
# transcription. Only what the person on the phone says is recorded, and
# transcription needs a few seconds of actual speech.
RECORD_PROMPT = ("This call is being recorded and transcribed for testing. "
                 "Please speak after the beep, then stay silent for a few seconds to finish.")
DEFAULT_RECORD_MAX_SECONDS = 120
RECORD_SILENCE_TIMEOUT_SECONDS = 5
FINAL_CALL_STATUSES = {"completed", "busy", "no-answer", "failed", "canceled"}


def burst_twiml(message=None, pause_seconds=None, record=False, record_max_seconds=None):
    if record:
        max_len = record_max_seconds or DEFAULT_RECORD_MAX_SECONDS
        # Without an action, <Record> requests the same document again when it ends, so the
        # prompt and the recording would repeat until the callee hangs up (seen: a second 4s
        # recording). The action points at a document that only hangs up.
        hangup = twimlet("<Response><Hangup/></Response>")
        return (f'<Response><Say>{message or RECORD_PROMPT}</Say>'
                f'<Record transcribe="true" maxLength="{max_len}" timeout="{RECORD_SILENCE_TIMEOUT_SECONDS}" '
                f'action="{hangup}" method="GET"/>'
                f'<Hangup/></Response>')
    pause = DEFAULT_PAUSE_SECONDS if pause_seconds is None else pause_seconds
    return f'<Response><Say>{message or DEFAULT_MESSAGE}</Say><Pause length="{pause}"/><Hangup/></Response>'


def call_burst(host, account_sid, auth_token, from_number, to_number, count, interval_seconds,
                message=None, pause_seconds=None, record=False, record_max_seconds=None):
    auth_header = build_auth_header(account_sid, auth_token)
    url = twimlet(burst_twiml(message, pause_seconds, record, record_max_seconds))
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


def poll_recordings(host, account_sid, auth_token, results, max_wait_seconds):
    """For --record: waits (bounded) for the calls to end, then for their
    transcriptions to leave in-progress, and returns counts plus the SIDs."""
    auth_header = build_auth_header(account_sid, auth_token)
    sids = [r["sid"] for r in results if r.get("sid")]
    deadline = time.time() + max_wait_seconds
    while sids and time.time() < deadline:
        statuses = [request(host, account_sid, auth_header, "GET", f"/Calls/{s}.json").get("status") for s in sids]
        if all(st in FINAL_CALL_STATUSES for st in statuses):
            break
        time.sleep(5)

    found = []
    for s in sids:
        for rec in request(host, account_sid, auth_header, "GET", f"/Calls/{s}/Recordings.json").get("recordings", []):
            found.append({"call_sid": s, "recording_sid": rec["sid"], "status": rec.get("status"),
                          "duration": rec.get("duration"), "transcription": None})

    trans_deadline = time.time() + 90
    while found:
        for f in found:
            trans = request(host, account_sid, auth_header, "GET",
                             f"/Recordings/{f['recording_sid']}/Transcriptions.json").get("transcriptions", [])
            f["transcription"] = trans[0].get("status") if trans else "none_yet"
        if all(f["transcription"] not in ("in-progress", "none_yet") for f in found) or time.time() > trans_deadline:
            break
        time.sleep(10)

    return {
        "calls_with_recording": len({f["call_sid"] for f in found}),
        "calls_without_recording": len(sids) - len({f["call_sid"] for f in found}),
        "recordings": dict(Counter(f["status"] for f in found)),
        "transcriptions": dict(Counter(f["transcription"] for f in found)),
        "items": found,
    }

"""
Preflight discovery: which environment do these credentials belong to,
does the account already have voice-capable numbers, and (if not) can it
even purchase one (Trust Hub compliance profile approved)?

Only used by the interactive wizard, never embedded in the standalone
emitted script (that script gets numbers baked in at generation time).
"""
from .core import request, build_auth_header

HOSTS = ["api.twilio.com", "api.stage.twilio.com", "api.dev.twilio.com"]
TIER_BY_HOST = {
    "api.twilio.com": "prod",
    "api.stage.twilio.com": "stage",
    "api.dev.twilio.com": "dev",
}

def detect_environment(account_sid, auth_token):
    """Try each known host; the one that authenticates is the account's
    real home (wrong host reliably 401s, per hard-won experience).
    Returns (host, tier, account_info) or (None, None, None)."""
    auth_header = build_auth_header(account_sid, auth_token)
    for host in HOSTS:
        info = request(host, account_sid, auth_header, "GET", ".json")
        if not info.get("error"):
            return host, TIER_BY_HOST[host], info
    return None, None, None

def list_voice_numbers(host, account_sid, auth_token):
    auth_header = build_auth_header(account_sid, auth_token)
    resp = request(host, account_sid, auth_header, "GET", "/IncomingPhoneNumbers.json?PageSize=50")
    numbers = resp.get("incoming_phone_numbers", [])
    return [
        {"phone": n["phone_number"], "sid": n["sid"]}
        for n in numbers
        if n.get("capabilities", {}).get("voice")
    ]

def search_available_numbers(host, account_sid, auth_token, country="US", count=5):
    auth_header = build_auth_header(account_sid, auth_token)
    resp = request(host, account_sid, auth_header, "GET",
                    f"/AvailablePhoneNumbers/{country}/Local.json?VoiceEnabled=true&PageSize={count}")
    return [c["phone_number"] for c in resp.get("available_phone_numbers", [])]

def purchase_number(host, account_sid, auth_token, phone_number):
    auth_header = build_auth_header(account_sid, auth_token)
    r = request(host, account_sid, auth_header, "POST", "/IncomingPhoneNumbers.json",
                {"PhoneNumber": phone_number})
    if r.get("error"):
        return None, r.get("body")
    return {"phone": r["phone_number"], "sid": r["sid"]}, None

def check_compliance_profile(host, account_sid, auth_token):
    """Best-effort probe of Trust Hub's CustomerProfiles resource, so a
    missing/unapproved compliance profile can be surfaced BEFORE attempting
    a purchase, instead of discovering it reactively via a 400 mid-purchase
    (which is what happened the first time we hit this).

    NOTE: this endpoint's exact shape hasn't been exercised end-to-end in
    this codebase yet -- verify against a real fresh account on first use.
    On any error this degrades to "unknown" rather than hard-blocking, so
    a working purchase flow is never blocked by a broken check.
    """
    auth_header = build_auth_header(account_sid, auth_token)
    url_host = "trusthub.twilio.com"
    import json as _json
    import urllib.request as _req
    import urllib.error as _err
    try:
        r = _req.Request(f"https://{url_host}/v1/CustomerProfiles", method="GET")
        r.add_header("Authorization", auth_header)
        with _req.urlopen(r, timeout=20) as resp:
            data = _json.loads(resp.read())
        profiles = data.get("results", [])
        if not profiles:
            return "no_profile"
        statuses = [p.get("status") for p in profiles]
        if any(s == "twilio-approved" for s in statuses):
            return "approved"
        return f"not_approved ({statuses})"
    except _err.HTTPError as e:
        return f"unknown (HTTP {e.code})"
    except Exception as e:
        return f"unknown ({e})"

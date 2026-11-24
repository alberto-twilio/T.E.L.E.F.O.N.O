"""
Preflight discovery: confirming the environment these credentials belong
to, whether the account already has voice-capable numbers, and (if not)
whether it can even purchase one (Trust Hub compliance profile approved).

Only used by the interactive wizard, never embedded in the standalone
emitted script (that script gets numbers baked in at generation time).
"""
import os
from .core import request, build_auth_header

HOST_BY_TIER = {
    "prod": "api.twilio.com",
    "stage": "api.stage.twilio.com",
    "dev": "api.dev.twilio.com",
}
TIERS = list(HOST_BY_TIER)

# Twilio Regions: the region in the API hostname decides where a request is
# processed and where its data (call/recording/conference logs) is stored.
# Explicit table, not a pattern: prod uses api.<edge>.<region>.twilio.com but
# stage/dev use api.<tier>-<region>.twilio.com (their certificates only cover
# *.stage-au1.twilio.com etc.). Every host below answered with Twilio's own
# 401 "No credentials provided" from the VPN (Nov 2026); hosts that resolve but
# fail TLS (api.sydney.au1.stage.twilio.com) are deliberately left out.
# Answering is not proof every Voice feature works there: try small counts first.
# Credentials are region-specific: a us1 Auth Token 401s against ie1.
DEFAULT_REGION = "us1"
REGION_HOSTS = {
    "prod": {"us1": "api.twilio.com", "ie1": "api.dublin.ie1.twilio.com", "au1": "api.sydney.au1.twilio.com"},
    # stage has au1 only besides us1 (api.stage-ie1.twilio.com answers, but stage has no IE1 region)
    "stage": {"us1": "api.stage.twilio.com", "au1": "api.stage-au1.twilio.com"},
    "dev": {"us1": "api.dev.twilio.com", "us2": "api.dev-us2.twilio.com"},
}
REGIONS_BY_TIER = {tier: list(hosts) for tier, hosts in REGION_HOSTS.items()}
DATA_REGIONS = ["us1", "ie1", "au1", "us2"]
DATAGEN_REGION_VAR = "DATAGEN_REGION"


def host_for(tier, region=DEFAULT_REGION):
    """API host for a tier + data region. Raises ValueError on a combination
    that has no host, so a typo can never silently fall back to us1."""
    if region not in REGION_HOSTS.get(tier, {}):
        raise ValueError(f"Region {region} is not available on {tier}. "
                         f"Available: {', '.join(REGIONS_BY_TIER.get(tier, []))}.")
    return REGION_HOSTS[tier][region]


def resolve_from_datagen_env():
    """Well-known env var convenience: if DATAGEN_ACCOUNT_SID,
    DATAGEN_ACCOUNT_TOKEN, and DATAGEN_ENVIRONMENT (one of TIERS) are all
    set, use them and skip asking. Returns (account_sid, auth_token, tier)
    or None if any are missing or the tier value isn't recognized."""
    sid = os.environ.get(DATAGEN_SID_VAR)
    token = os.environ.get(DATAGEN_TOKEN_VAR)
    tier = os.environ.get(DATAGEN_TIER_VAR)
    if sid and token and tier and tier in TIERS:
        return sid, token, tier
    return None


def datagen_region():
    """Optional DATAGEN_REGION next to the three vars above; us1 when unset."""
    return os.environ.get(DATAGEN_REGION_VAR) or DEFAULT_REGION


def print_datagen_env_template():
    """Three lines, ready to paste into any env file, keys only."""
    print(f"export {DATAGEN_SID_VAR}=")
    print(f"export {DATAGEN_TOKEN_VAR}=")
    print(f"export {DATAGEN_TIER_VAR}=")

def confirm_environment(account_sid, auth_token, tier, region=DEFAULT_REGION):
    """The caller states which environment these credentials belong to
    (never guessed). This does exactly one GET, against that tier's host,
    to confirm the account actually exists/authenticates there. A wrong
    host reliably 401s, per hard-won experience, so a failure here means
    either the credentials or the chosen tier is wrong, not necessarily
    which one.
    The same goes for the region: the token must be the one created for it.
    Returns (host, tier, account_info), or (None, tier, error) where error is
    the failed request ({"status": 401 or None, "body": ...}) for the message."""
    host = host_for(tier, region)
    auth_header = build_auth_header(account_sid, auth_token)
    info = request(host, account_sid, auth_header, "GET", ".json")
    if info.get("error"):
        return None, tier, info
    return host, tier, info

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
    # Same tier as the API host: api.dev.twilio.com -> trusthub.dev.twilio.com.
    # Hitting prod Trust Hub with dev/stage credentials 401s ("unknown"), which
    # used to let the run continue until the purchase itself failed.
    url_host = ("trusthub." + host[len("api."):]) if host.startswith("api.") else "trusthub.twilio.com"
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
        try:
            detail = e.read().decode()[:300]
        except Exception:
            detail = ""
        return f"unknown (HTTP {e.code} from {url_host}) {detail}".strip()
    except Exception as e:
        return f"unknown ({e})"

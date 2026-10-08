"""
Guardrails that must never depend on a human (or an agent) remembering
anything across a session boundary. If the detected host is prod, these
are enforced unconditionally, not behind a flag someone could forget.
"""
from .core import parse_duration_token

PROD_HOST = "api.twilio.com"
PROD_MAX_PER_CATEGORY = 30
PROD_MAX_CALL_DURATION_SECONDS = 5 * 60

def is_prod(host):
    return host == PROD_HOST

def confirm_prod(account_info):
    name = account_info.get("friendly_name", "<unknown>")
    print(f"\n*** This account is PRODUCTION ({name}) ***")
    print("Real calls, real numbers, real cost, real visibility.")
    print(f"Limit: {PROD_MAX_PER_CATEGORY} per category (calls, recordings/transcriptions, conferences) "
          f"and {PROD_MAX_CALL_DURATION_SECONDS}s per call, unless --no-prod-cap was passed.")
    ans = input("Type PROD in capitals to continue, anything else cancels: ")
    return ans.strip() == "PROD"

def _cap_spec(spec, max_n, parse_token=int):
    """Clamp a spec ('0', 'N', or 'lo-hi') so it can never resolve above
    max_n. Specs are resolved fresh every run (see gen/core.py), so
    capping the one resolved value for THIS run isn't enough, a saved
    standalone script re-executed later (e.g. from cron) would re-roll
    inside the original, uncapped range. The spec itself has to be capped.
    parse_token handles duration tokens ('1s', '3m') when capping
    call_duration, plain int otherwise."""
    spec = str(spec).strip()
    if spec in ("0", ""):
        return spec, False
    if "-" in spec:
        lo, hi = (parse_token(x) for x in spec.split("-", 1))
        if hi <= max_n:
            return spec, False
        new_hi = max_n
        new_lo = min(lo, new_hi)
        return f"{new_lo}-{new_hi}", True
    n = parse_token(spec)
    if n <= max_n:
        return spec, False
    return str(max_n), True

def cap_plan_for_tier(host, plan, skip_cap=False):
    """Hard-caps any category's spec on prod, so it can never resolve above
    the limit, now or on any future re-roll of the same saved config. Never
    silently drops a category, just clamps the spec and reports what
    changed. skip_cap (--no-prod-cap) lifts both the count and the
    call_duration caps; the PROD confirmation still applies."""
    if not is_prod(host):
        return plan, []
    if skip_cap:
        return plan, [f"prod caps ({PROD_MAX_PER_CATEGORY} per category, "
                      f"{PROD_MAX_CALL_DURATION_SECONDS}s per call) skipped (--no-prod-cap)"]
    capped = dict(plan)
    notes = []
    for key in ("calls", "recordings_transcriptions", "conferences"):
        spec = capped.get(key, "0")
        new_spec, changed = _cap_spec(spec, PROD_MAX_PER_CATEGORY)
        if changed:
            notes.append(f"{key}: requested {spec}, capped to {new_spec} "
                         "(prod limit, applies to every future run of this config too)")
            capped[key] = new_spec

    duration_spec = capped.get("call_duration")
    if duration_spec and duration_spec not in ("0", ""):
        new_duration, changed = _cap_spec(duration_spec, PROD_MAX_CALL_DURATION_SECONDS, parse_token=parse_duration_token)
        if changed:
            notes.append(f"call_duration: requested {duration_spec}, capped to {new_duration} "
                         "(prod limit, applies to every future run of this config too)")
            capped["call_duration"] = new_duration

    return capped, notes

def confirm_purchase(numbers):
    print("\nAbout to purchase:")
    for n in numbers:
        print(f"  - {n}")
    ans = input("Type YES to confirm this real, billable purchase: ")
    return ans.strip() == "YES"

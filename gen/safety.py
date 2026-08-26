"""
Guardrails that must never depend on a human (or an agent) remembering
anything across a session boundary. If the detected host is prod, these
are enforced unconditionally, not behind a flag someone could forget.
"""

PROD_HOST = "api.twilio.com"
PROD_MAX_PER_CATEGORY = 5

def is_prod(host):
    return host == PROD_HOST

def confirm_prod(account_info):
    name = account_info.get("friendly_name", "<unknown>")
    print(f"\n*** This account is PRODUCTION ({name}) ***")
    print("Real calls, real numbers, real cost, real visibility.")
    ans = input("Type PROD in capitals to continue, anything else cancels: ")
    return ans.strip() == "PROD"

def cap_plan_for_tier(host, plan):
    """Hard-caps any category's count on prod, regardless of what was
    requested or rolled randomly. Never silently drops a category, just
    clamps the volume and reports what changed."""
    if not is_prod(host):
        return plan, []
    capped = dict(plan)
    notes = []
    for key in ("calls", "recordings_transcriptions", "conferences"):
        val = capped.get(key, 0)
        if val and val > PROD_MAX_PER_CATEGORY:
            notes.append(f"{key}: requested {val}, capped to {PROD_MAX_PER_CATEGORY} (prod limit)")
            capped[key] = PROD_MAX_PER_CATEGORY
    return capped, notes

def confirm_purchase(numbers):
    print("\nAbout to purchase:")
    for n in numbers:
        print(f"  - {n}")
    ans = input("Type YES to confirm this real, billable purchase: ")
    return ans.strip() == "YES"

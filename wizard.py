#!/usr/bin/env python3
"""
Front-end for generating Twilio Voice test data (calls, recordings,
transcriptions, conferences) against any account/subaccount, in any
environment (prod/stage/dev), with regions.

Two modes, same code path:

  Interactive (default, no flags):
      python3 wizard.py

  Unattended (for cron/launchd, no prompts at all):
      python3 wizard.py --sid-env VOICEGEN_SID_STAGE --token-env VOICEGEN_TOKEN_STAGE \\
          --categories calls,recordings_transcriptions,conferences \\
          --calls 10-60 --recordings-transcriptions 10-60 --conferences 10-60 \\
          --regions us1,au1 --mode run

  Unattended mode is enabled by passing --sid-env (the credential VALUES
  still come from the environment, never from a CLI arg, so they never
  show up in process listings or shell history). Every interactive run
  prints the exact unattended command that would reproduce it, at the end.

Requires: Python 3, stdlib only. No pip install needed.
"""
import os
import sys
import json
import random
import getpass
import argparse
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gen import core, discovery, safety

REGIONS = ["us1", "us2", "au1", "br1", "ie1", "jp1", "sg1", "de1", "in1"]
ALL_CATEGORIES = ["calls", "recordings_transcriptions", "conferences"]


def mask(value):
    if len(value) <= 6:
        return "*" * len(value)
    return value[:2] + "…" + value[-4:]


def ask(prompt, default=None):
    suffix = f" [{default}]" if default is not None else ""
    val = input(f"{prompt}{suffix}: ").strip()
    return val or default


def parse_count_spec(raw):
    """raw: '0', 'N', or 'min-max'. Returns the rolled int count."""
    raw = str(raw).strip()
    if raw in ("0", ""):
        return 0
    if "-" in raw:
        lo, hi = raw.split("-", 1)
        return random.randint(int(lo), int(hi))
    return int(raw)


def ask_count_spec(label, default_range=(10, 60)):
    raw = ask(f"{label} count: fixed number, a 'min-max' range, or 0 to skip",
              default=f"{default_range[0]}-{default_range[1]}")
    return raw, parse_count_spec(raw)


def select_multi(label, options):
    print(f"\n{label}")
    for i, opt in enumerate(options, 1):
        print(f"  {i}. {opt}")
    raw = ask("Select (comma-separated numbers, or 'all')", default="all")
    if raw.lower() == "all":
        return list(options)
    idxs = [int(x.strip()) for x in raw.split(",") if x.strip()]
    return [options[i - 1] for i in idxs]


def build_arg_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sid-env", help="Env var name holding the Account SID. Passing this enables unattended mode.")
    p.add_argument("--token-env", help="Env var name holding the Auth Token.")
    p.add_argument("--categories", help="Comma list of: " + ",".join(ALL_CATEGORIES) + " (default: all)")
    p.add_argument("--calls", default="10-60", help="Fixed N, 'min-max', or 0 to skip. Default 10-60.")
    p.add_argument("--recordings-transcriptions", dest="recordings_transcriptions", default="10-60")
    p.add_argument("--conferences", default="10-60")
    p.add_argument("--regions", default="", help="Comma list of conference regions, e.g. us1,au1,ie1")
    p.add_argument("--mode", choices=["run", "save", "both"], default="run")
    p.add_argument("--out", help="Output path for standalone script (save/both mode)")
    p.add_argument("--confirm-prod", action="store_true",
                    help="Required if the detected account is production. No interactive prompt exists in unattended mode.")
    p.add_argument("--allow-purchase", action="store_true",
                    help="Required if fewer than 2 usable numbers exist and a purchase would be needed.")
    return p


def resolve_credentials(args):
    """Returns (account_sid, auth_token, unattended: bool)."""
    if args.sid_env:
        if not args.token_env:
            sys.exit("--token-env is required when --sid-env is passed.")
        try:
            return os.environ[args.sid_env], os.environ[args.token_env], True
        except KeyError as e:
            sys.exit(f"Env var {e} is not set.")
    print("=== Twilio Voice test-data wizard ===\n")
    account_sid = ask("Account SID")
    auth_token = getpass.getpass("Auth Token (input hidden): ")
    return account_sid, auth_token, False


def handle_numbers(host, account_sid, auth_token, unattended, allow_purchase):
    print("\nChecking for voice-capable numbers...")
    numbers = discovery.list_voice_numbers(host, account_sid, auth_token)
    print(f"Found {len(numbers)} voice-capable number(s).")
    purchased_any = False

    if len(numbers) >= 2:
        return numbers, purchased_any

    print("\nFewer than 2 usable numbers. Checking whether this account can even purchase one...")
    status = discovery.check_compliance_profile(host, account_sid, auth_token)
    print(f"Compliance profile status: {status}")
    if status == "no_profile" or status.startswith("not_approved"):
        sys.exit(
            "\nBLOCKED: this account's Trust Hub compliance profile isn't approved.\n"
            "Numbers can't be purchased until that's approved manually (not something\n"
            "this tool, or any script, can resolve on its own). Get it approved, or\n"
            "point this at an account that already has numbers."
        )

    needed = 2 - len(numbers)
    candidates = discovery.search_available_numbers(host, account_sid, auth_token, count=needed + 2)
    if len(candidates) < needed:
        sys.exit("Not enough available numbers found to buy. Aborting.")
    to_buy = candidates[:needed]

    if unattended:
        if not allow_purchase:
            sys.exit(
                f"\nBLOCKED: this account needs {needed} more number(s) purchased "
                f"({', '.join(to_buy)}), but this is unattended mode and --allow-purchase "
                "wasn't passed. Run once interactively first, or pass --allow-purchase "
                "if you really want an unattended run to spend money."
            )
    else:
        if not safety.confirm_purchase(to_buy):
            sys.exit("Cancelled.")

    for phone in to_buy:
        bought, err = discovery.purchase_number(host, account_sid, auth_token, phone)
        if err:
            sys.exit(f"Failed to purchase {phone}: {err}")
        numbers.append(bought)
        purchased_any = True
        print(f"Purchased {bought['phone']} ({bought['sid']})")

    return numbers, purchased_any


def build_plan(args, unattended):
    if unattended:
        categories = args.categories.split(",") if args.categories else ALL_CATEGORIES
        specs = {
            "calls": args.calls,
            "recordings_transcriptions": args.recordings_transcriptions,
            "conferences": args.conferences,
        }
        regions_raw = args.regions
        chosen_regions = [r for r in regions_raw.split(",") if r] if regions_raw else []
    else:
        categories = select_multi("Categories", ALL_CATEGORIES)
        specs = {"calls": "0", "recordings_transcriptions": "0", "conferences": "0"}
        if "calls" in categories:
            specs["calls"], _ = ask_count_spec("Calls")
        if "recordings_transcriptions" in categories:
            specs["recordings_transcriptions"], _ = ask_count_spec("Recordings/Transcriptions")
        chosen_regions = []
        if "conferences" in categories:
            specs["conferences"], _ = ask_count_spec("Conferences")
            picked = select_multi("Conference regions (optional)", REGIONS + ["(none)"])
            chosen_regions = [r for r in picked if r != "(none)"]

    plan = {
        "calls": parse_count_spec(specs["calls"]) if "calls" in categories else 0,
        "recordings_transcriptions": parse_count_spec(specs["recordings_transcriptions"]) if "recordings_transcriptions" in categories else 0,
        "conferences": parse_count_spec(specs["conferences"]) if "conferences" in categories else 0,
        "conference_regions": chosen_regions or None,
    }
    specs_used = {
        "categories": categories,
        "calls": specs["calls"] if "calls" in categories else "0",
        "recordings_transcriptions": specs["recordings_transcriptions"] if "recordings_transcriptions" in categories else "0",
        "conferences": specs["conferences"] if "conferences" in categories else "0",
        "regions": chosen_regions,
    }
    return plan, specs_used


def print_repro_command(args, sid_env, token_env, tier, specs_used, purchased_any, out_path, mode):
    parts = [
        "python3 wizard.py",
        f"--sid-env {sid_env} --token-env {token_env}",
        f"--categories {','.join(specs_used['categories'])}",
        f"--calls {specs_used['calls']}",
        f"--recordings-transcriptions {specs_used['recordings_transcriptions']}",
        f"--conferences {specs_used['conferences']}",
    ]
    if specs_used["regions"]:
        parts.append(f"--regions {','.join(specs_used['regions'])}")
    parts.append(f"--mode {mode}")
    if mode in ("save", "both") and out_path:
        parts.append(f"--out {out_path}")
    if tier == "prod":
        parts.append("--confirm-prod")
    if purchased_any:
        parts.append("--allow-purchase  # only needed again if numbers drop below 2")

    print("\n--- Run this unattended next time (e.g. from cron/launchd) ---")
    print(f"export {sid_env}=<Account SID>")
    print(f"export {token_env}=<Auth Token>")
    print(" \\\n  ".join(parts))


def render_standalone(config, out_path):
    core_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gen", "core.py")
    with open(core_path) as f:
        core_source = f.read()
    header = (
        "#!/usr/bin/env python3\n"
        "# Auto-generated standalone Voice test-data script.\n"
        f"# Generated {datetime.datetime.now():%Y-%m-%d %H:%M} by wizard.py\n"
        "# Stdlib only. Credentials read from env vars named below, never embedded.\n\n"
    )
    config_block = "CONFIG = " + json.dumps(config, indent=2) + "\n\n"
    with open(out_path, "w") as f:
        f.write(header)
        f.write(config_block)
        f.write(core_source)
    os.chmod(out_path, 0o700)


def main():
    args = build_arg_parser().parse_args()
    account_sid, auth_token, unattended = resolve_credentials(args)

    if not unattended:
        print(f"\nCredentials: {mask(account_sid)}. Detecting environment...")
    host, tier, info = discovery.detect_environment(account_sid, auth_token)
    if not host:
        sys.exit("Could not authenticate against prod, stage, or dev. Check the credentials.")
    print(f"Detected: {info.get('friendly_name')}  tier={tier}  host={host}")

    if safety.is_prod(host):
        if unattended:
            if not args.confirm_prod:
                sys.exit(
                    "\nBLOCKED: this is a PRODUCTION account and this is unattended mode.\n"
                    "Pass --confirm-prod explicitly if that's really intended. There is no\n"
                    "interactive prompt to fall back on here on purpose."
                )
        else:
            if not safety.confirm_prod(info):
                sys.exit("Cancelled.")

    numbers, purchased_any = handle_numbers(host, account_sid, auth_token, unattended, args.allow_purchase)
    print(f"\nUsing {len(numbers)} number(s): {', '.join(n['phone'] for n in numbers)}")

    plan, specs_used = build_plan(args, unattended)
    plan, notes = safety.cap_plan_for_tier(host, plan)
    for n in notes:
        print(f"NOTE: {n}")
    print("\nPlan:", json.dumps(plan, indent=2))

    if unattended:
        mode = args.mode
    else:
        mode = ask("Run now, save as standalone script, or both? (run/save/both)", default="run")

    sid_env = args.sid_env or f"VOICEGEN_SID_{tier.upper()}"
    token_env = args.token_env or f"VOICEGEN_TOKEN_{tier.upper()}"
    if not unattended:
        os.environ[sid_env] = account_sid
        os.environ[token_env] = auth_token

    config = {
        "host": host,
        "sid_env": sid_env,
        "token_env": token_env,
        "numbers": numbers,
        "plan": plan,
        "results_path": f"voice_batch_{tier}_{datetime.date.today():%Y%m%d}.json",
        "poll_after": True,
    }

    out_path = args.out or f"voice_batch_{tier}_{datetime.date.today():%Y%m%d}.py"

    if mode in ("run", "both"):
        print("\nRunning...\n")
        core.run(config)

    if mode in ("save", "both"):
        if not unattended:
            out_path = ask("Output path for standalone script", default=out_path)
        render_standalone(config, out_path)
        print(f"\nSaved standalone script to {out_path}")
        print(f"It reads credentials from env vars {sid_env} / {token_env} (not embedded).")

    if not unattended:
        print_repro_command(args, sid_env, token_env, tier, specs_used, purchased_any, out_path, mode)


if __name__ == "__main__":
    main()

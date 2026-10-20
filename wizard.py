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
          --tier stage \\
          --categories calls,recordings_transcriptions,conferences \\
          --calls 10-30 --call-duration 1s-3m \\
          --recordings-transcriptions 5-10 --conferences 5-10 \\
          --regions us1,au1 --mode run

  The environment (prod/stage/dev) is always stated, never guessed: you
  pick it (interactively, or via --tier), and the script does exactly
  one request to confirm the account actually exists there.

  Unattended mode is enabled by passing --sid-env (the credential VALUES
  still come from the environment, never from a CLI arg, so they never
  show up in process listings or shell history). Every interactive run
  prints the exact unattended command that would reproduce it, at the end.

Requires: Python 3, stdlib only. No pip install needed.
"""
import os
import re
import sys
import json
import pprint
import getpass
import argparse
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gen import core, discovery, safety

REGIONS = ["us1", "us2", "au1", "br1", "ie1", "jp1", "sg1", "de1", "in1"]
VOICE_CATEGORIES = ["calls", "recordings_transcriptions", "conferences"]
# video_rooms / video_recordings are opt-in (never part of the default selection); on prod they go through the same PROD confirmation and caps as everything else
ALL_CATEGORIES = VOICE_CATEGORIES + ["video_rooms", "video_recordings"]
# video_recordings drives a headless browser (Playwright, see gen/video_recordings.py): unattended/--categories only
INTERACTIVE_CATEGORIES = VOICE_CATEGORIES + ["video_rooms"]


def mask(value):
    if len(value) <= 6:
        return "*" * len(value)
    return value[:2] + "…" + value[-4:]


def ask(prompt, default=None):
    suffix = f" [{default}]" if default is not None else ""
    val = input(f"{prompt}{suffix}: ").strip()
    return val or default


def ask_count_spec(label, default_range=(10, 30)):
    """Returns the raw spec string, unresolved. Rolling happens once, at
    actual execution time, inside gen/core.py, not here, so the same spec
    re-rolls fresh on every run instead of freezing one number forever."""
    return ask(f"{label} count: fixed number, a 'min-max' range, or 0 to skip",
               default=f"{default_range[0]}-{default_range[1]}")


def select_multi(label, options):
    """Accepts either the numbered index or the option's literal text
    (case-insensitive), comma-separated, or 'all'. Typing the value you
    can see ("us1") is at least as natural as typing its index, and a
    typo shouldn't crash with a raw traceback."""
    print(f"\n{label}")
    for i, opt in enumerate(options, 1):
        print(f"  {i}. {opt}")
    raw = ask("Select (comma-separated numbers or names, or 'all')", default="all")
    if raw.lower() == "all":
        return list(options)

    lower_options = [o.lower() for o in options]
    chosen, invalid = [], []
    for token in (t.strip() for t in raw.split(",") if t.strip()):
        if token.isdigit() and 1 <= int(token) <= len(options):
            chosen.append(options[int(token) - 1])
        elif token.lower() in lower_options:
            chosen.append(options[lower_options.index(token.lower())])
        else:
            invalid.append(token)

    if invalid:
        sys.exit(f"Invalid selection: {', '.join(invalid)}. "
                  f"Use a number (1-{len(options)}) or one of: {', '.join(options)}.")
    return chosen


def ask_tier():
    print("\nEnvironment (never guessed, state it explicitly)")
    for i, t in enumerate(discovery.TIERS, 1):
        note = (f"  (max {safety.PROD_MAX_PER_CATEGORY} per category, "
                f"{safety.PROD_MAX_CALL_DURATION_SECONDS}s per call, unless --no-prod-cap)") if t == "prod" else ""
        print(f"  {i}. {t}{note}")
    raw = ask("Select", default=str(discovery.TIERS.index("stage") + 1))
    return discovery.TIERS[int(raw) - 1]


def build_arg_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sid-env", help="Env var name holding the Account SID. Passing this enables unattended mode.")
    p.add_argument("--token-env", help="Env var name holding the Auth Token.")
    p.add_argument("--tier", choices=discovery.TIERS,
                    help="Which environment these credentials belong to. Required in unattended mode, "
                         "asked interactively otherwise. Never guessed.")
    p.add_argument("--categories", help="Comma list of: " + ",".join(ALL_CATEGORIES) + " (default: the Voice ones; the Video ones are opt-in)")
    p.add_argument("--calls", default="10-30", help="Fixed N, 'min-max', or 0 to skip. Default 10-30.")
    p.add_argument("--call-duration", dest="call_duration", default="1s-3m",
                    help="Target duration range for completed calls, e.g. '1s-3m', '30s-90s', "
                         "or a bare-seconds range like '10-60'. 0 disables (old passage-based "
                         "variety instead). Default 1s-3m. Each call rolls its own duration.")
    p.add_argument("--recordings-transcriptions", dest="recordings_transcriptions", default="5-10")
    p.add_argument("--conferences", default="5-10")
    p.add_argument("--video-rooms", dest="video_rooms", default="5-10",
                   help="Video rooms (REST only, no participants): fixed N, 'min-max', or 0. Default 5-10. "
                        "Needs video_rooms in --categories.")
    p.add_argument("--video-room-types", dest="video_room_types", default="",
                   help="Comma list of room types to cycle: group,group-small,peer-to-peer (default: all three)")
    p.add_argument("--video-room-prefix", dest="video_room_prefix", default="telefono",
                   help="Room name prefix: letters, digits, - and _ (default telefono)")
    p.add_argument("--video-recordings", dest="video_recordings", default="2-6",
                   help="Participants that join recorded Video rooms (Playwright needed): N, 'min-max' or 0. "
                        "Default 2-6. Needs video_recordings in --categories.")
    p.add_argument("--video-rec-rooms", dest="video_rec_rooms", default="2-3",
                   help="Rooms those participants are spread over. Default 2-3.")
    p.add_argument("--video-hold", dest="video_hold", default="5-15",
                   help="How long each participant stays connected, e.g. 5-15 (seconds) or 5s-1m. Default 5-15.")
    p.add_argument("--video-key-env", dest="video_key_env",
                   help="Env var NAME holding an API Key SID for Video access tokens. Without it a temporary "
                        "key is created for the run and deleted after.")
    p.add_argument("--video-secret-env", dest="video_secret_env", help="Env var NAME holding that API Key's secret.")
    p.add_argument("--regions", default="", help="Comma list of conference regions, e.g. us1,au1,ie1")
    p.add_argument("--describe-account", dest="describe_account", action="store_true",
                   help="Read-only: confirm the account on --tier, print one JSON line "
                        "(kind main/sub/unknown, status, friendly_name) and exit. Generates nothing.")
    p.add_argument("--mode", choices=["run", "save", "both"], default="run")
    p.add_argument("--out", help="Output path for standalone script (save/both mode)")
    p.add_argument("--results-path", dest="results_path",
                    help="Where to write the results JSON. Default: voice_batch_<tier>_<date>.json in the "
                         "current directory, which a second run on the same day overwrites.")
    p.add_argument("--confirm-prod", action="store_true",
                    help="Required if the detected account is production. No interactive prompt exists in unattended mode.")
    p.add_argument("--no-prod-cap", dest="no_prod_cap", action="store_true",
                    help=f"Skip the prod caps ({safety.PROD_MAX_PER_CATEGORY} per category, "
                         f"{safety.PROD_MAX_CALL_DURATION_SECONDS}s per call). "
                         "The PROD confirmation (or --confirm-prod) is still required.")
    p.add_argument("--allow-purchase", action="store_true",
                    help="Required if fewer than 2 usable numbers exist and a purchase would be needed.")
    return p


def resolve_credentials(args):
    """Returns (account_sid, auth_token, unattended: bool, tier_or_None)."""
    if args.sid_env:
        if not args.token_env:
            sys.exit("--token-env is required when --sid-env is passed.")
        try:
            return os.environ[args.sid_env], os.environ[args.token_env], True, None
        except KeyError as e:
            sys.exit(f"Env var {e} is not set.")

    print("=== Twilio Voice test-data wizard ===\n")

    from_env = discovery.resolve_from_datagen_env()
    if from_env:
        sid, token, tier = from_env
        print(f"Using {discovery.DATAGEN_SID_VAR} / {discovery.DATAGEN_TOKEN_VAR} / "
              f"{discovery.DATAGEN_TIER_VAR} from the environment (tier={tier}).")
        return sid, token, False, tier

    print(f"{discovery.DATAGEN_SID_VAR} / {discovery.DATAGEN_TOKEN_VAR} / "
          f"{discovery.DATAGEN_TIER_VAR} are not set.\n")
    print("Ready to paste into any env file (fill in the values):")
    discovery.print_datagen_env_template()
    print()
    account_sid = ask("Account SID")
    auth_token = getpass.getpass("Auth Token (input hidden): ")
    return account_sid, auth_token, False, None


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
    """Returns a plan of SPECS (strings), never pre-rolled numbers, see
    gen/core.py for why: rolling must happen at actual execution time so
    the same plan re-rolls fresh on every run, including a saved
    standalone script run again later."""
    if unattended:
        categories = args.categories.split(",") if args.categories else VOICE_CATEGORIES
        unknown = [c for c in categories if c not in ALL_CATEGORIES]
        if unknown:
            sys.exit(f"Unknown category: {', '.join(unknown)}. Valid: {', '.join(ALL_CATEGORIES)}.")
        plan = {
            "calls": args.calls if "calls" in categories else "0",
            "call_duration": args.call_duration if "calls" in categories else None,
            "recordings_transcriptions": args.recordings_transcriptions if "recordings_transcriptions" in categories else "0",
            "conferences": args.conferences if "conferences" in categories else "0",
        }
        regions_raw = args.regions
        chosen_regions = [r for r in regions_raw.split(",") if r] if regions_raw else []
        plan["conference_regions"] = chosen_regions or None
        plan["video_rooms"] = args.video_rooms if "video_rooms" in categories else "0"
        plan["video_recordings"] = args.video_recordings if "video_recordings" in categories else "0"
    else:
        categories = select_multi("Categories", INTERACTIVE_CATEGORIES)
        plan = {"calls": "0", "call_duration": None, "recordings_transcriptions": "0",
                 "conferences": "0", "conference_regions": None, "video_rooms": "0", "video_recordings": "0"}
        if "calls" in categories:
            plan["calls"] = ask_count_spec("Calls")
            plan["call_duration"] = ask(
                "Call duration range for completed calls (e.g. 1s-3m), or 0 to disable",
                default="1s-3m")
        if "recordings_transcriptions" in categories:
            plan["recordings_transcriptions"] = ask_count_spec("Recordings/Transcriptions", default_range=(5, 10))
        if "conferences" in categories:
            plan["conferences"] = ask_count_spec("Conferences", default_range=(5, 10))
            picked = select_multi("Conference regions (optional)", REGIONS + ["(none)"])
            chosen_regions = [r for r in picked if r != "(none)"]
            plan["conference_regions"] = chosen_regions or None
        if "video_rooms" in categories:
            plan["video_rooms"] = ask_count_spec("Video rooms", default_range=(5, 10))

    if plan["video_recordings"] not in (None, "0", 0):
        try:
            core.parse_duration_range_spec(args.video_hold)
            core.parse_count_spec(args.video_rec_rooms)
        except ValueError:
            sys.exit("--video-hold must look like 5-15 (seconds) and --video-rec-rooms like 2-3.")
        if bool(args.video_key_env) != bool(args.video_secret_env):
            sys.exit("--video-key-env and --video-secret-env go together.")
        plan["video_rec_rooms"] = args.video_rec_rooms
        plan["video_hold"] = args.video_hold
        plan["video_key_env"] = args.video_key_env
        plan["video_secret_env"] = args.video_secret_env

    if plan["video_rooms"] not in (None, "0", 0) or plan["video_recordings"] not in (None, "0", 0):
        room_types = [t for t in (args.video_room_types or "").split(",") if t]
        bad = [t for t in room_types if t not in core.VIDEO_ROOM_TYPES]
        if bad:
            sys.exit(f"Unknown video room type: {', '.join(bad)}. Valid: {', '.join(core.VIDEO_ROOM_TYPES)}.")
        prefix = args.video_room_prefix
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", prefix):
            sys.exit("--video-room-prefix: letters, digits, - and _ only (max 40).")
        plan["video_room_types"] = room_types or None
        plan["video_room_prefix"] = prefix

    return plan


def print_repro_command(sid_env, token_env, tier, plan, purchased_any, out_path, mode, no_prod_cap=False):
    categories = [c for c in ALL_CATEGORIES if plan.get(c, "0") not in (None, "0", 0)]
    parts = [
        "python3 wizard.py",
        f"--sid-env {sid_env} --token-env {token_env}",
        f"--tier {tier}",
        f"--categories {','.join(categories)}",
        f"--calls {plan.get('calls', '0')}",
        f"--recordings-transcriptions {plan.get('recordings_transcriptions', '0')}",
        f"--conferences {plan.get('conferences', '0')}",
    ]
    if plan.get("video_rooms") not in (None, "0", 0):
        parts.append(f"--video-rooms {plan['video_rooms']}")
        if plan.get("video_room_types"):
            parts.append(f"--video-room-types {','.join(plan['video_room_types'])}")
        parts.append(f"--video-room-prefix {plan.get('video_room_prefix', 'telefono')}")
    if plan.get("video_recordings") not in (None, "0", 0):
        parts.append(f"--video-recordings {plan['video_recordings']} --video-rec-rooms {plan.get('video_rec_rooms', '2-3')} "
                     f"--video-hold {plan.get('video_hold', '5-15')}")
        if plan.get("video_key_env"):
            parts.append(f"--video-key-env {plan['video_key_env']} --video-secret-env {plan['video_secret_env']}")
    if plan.get("call_duration"):
        parts.append(f"--call-duration {plan['call_duration']}")
    if plan.get("conference_regions"):
        parts.append(f"--regions {','.join(plan['conference_regions'])}")
    parts.append(f"--mode {mode}")
    if mode in ("save", "both") and out_path:
        parts.append(f"--out {out_path}")
    if tier == "prod":
        parts.append("--confirm-prod")
        if no_prod_cap:
            parts.append("--no-prod-cap")
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
    # pformat, not json.dumps: JSON true/false/null are not valid Python literals.
    config_block = "CONFIG = " + pprint.pformat(config, indent=2, sort_dicts=False) + "\n\n"
    with open(out_path, "w") as f:
        f.write(header)
        f.write(config_block)
        f.write(core_source)
    os.chmod(out_path, 0o700)


def describe_account(account_sid, info):
    """Whether this SID is a main (parent) account or a subaccount. An account
    resource carries owner_account_sid: equal to its own SID for a main
    account, the parent's SID for a subaccount. Missing => 'unknown'."""
    owner = (info.get("owner_account_sid") or "").lower()
    if not owner:
        kind = "unknown"
    elif owner == account_sid.lower():
        kind = "main"
    else:
        kind = "sub"
    return {"kind": kind, "status": info.get("status"), "friendly_name": info.get("friendly_name")}


def run_video_recordings_step(config, account_sid, auth_token):
    """Video recordings need Playwright, so they live outside gen/core.py and are merged into the same results JSON."""
    from gen import video_recordings
    cfg = {"host": config["host"], "video_host": core.video_host_for(config["host"]), "account_sid": account_sid,
           "auth_header": core.build_auth_header(account_sid, auth_token)}
    out = video_recordings.run_video_recordings(cfg, config["plan"])
    path = config["results_path"]
    try:
        with open(path) as f:
            results = json.load(f)
    except (OSError, ValueError):
        results = {}
    results.update(out)
    with open(path, "w") as f:
        json.dump(results, f, indent=2)
    video_recordings.print_summary(out)


def main():
    args = build_arg_parser().parse_args()
    account_sid, auth_token, unattended, pre_tier = resolve_credentials(args)

    if unattended:
        if not args.tier:
            sys.exit("--tier is required in unattended mode (prod/stage/dev). Never guessed.")
        tier = args.tier
    elif pre_tier:
        tier = pre_tier
        print(f"\nCredentials: {mask(account_sid)}.")
    else:
        print(f"\nCredentials: {mask(account_sid)}.")
        tier = args.tier or ask_tier()

    host, tier, info = discovery.confirm_environment(account_sid, auth_token, tier)
    if not host:
        sys.exit(f"Could not authenticate against {tier} ({discovery.HOST_BY_TIER[tier]}). "
                  "Check the credentials, or that this is really the right tier.")
    if args.describe_account:
        # read-only lookup for the desktop app; exits before any numbers/prod/generation logic
        print(json.dumps(describe_account(account_sid, info)))
        sys.exit(0)
    print(f"Confirmed: {info.get('friendly_name')}  tier={tier}  host={host}")

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

    plan = build_plan(args, unattended)
    plan, notes = safety.cap_plan_for_tier(host, plan, skip_cap=args.no_prod_cap)
    for n in notes:
        print(f"NOTE: {n}")

    # numbers are only needed (and only fetched/purchased) when a Voice category will run
    if any(plan.get(c, "0") not in (None, "0", 0) for c in VOICE_CATEGORIES):
        numbers, purchased_any = handle_numbers(host, account_sid, auth_token, unattended, args.allow_purchase)
        print(f"\nUsing {len(numbers)} number(s): {', '.join(n['phone'] for n in numbers)}")
    else:
        numbers, purchased_any = [], False
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
        "results_path": args.results_path or f"voice_batch_{tier}_{datetime.date.today():%Y%m%d}.json",
        "poll_after": True,
    }

    out_path = args.out or f"voice_batch_{tier}_{datetime.date.today():%Y%m%d}.py"

    if mode in ("save", "both") and plan.get("video_recordings") not in (None, "0", 0):
        sys.exit("video_recordings needs a headless browser and cannot be saved as a standalone script. Use --mode run.")

    if mode in ("run", "both"):
        print("\nRunning...\n")
        core.run(config)
        if plan.get("video_recordings") not in (None, "0", 0):
            run_video_recordings_step(config, account_sid, auth_token)

    if mode in ("save", "both"):
        if not unattended:
            out_path = ask("Output path for standalone script", default=out_path)
        render_standalone(config, out_path)
        print(f"\nSaved standalone script to {out_path}")
        print(f"It reads credentials from env vars {sid_env} / {token_env} (not embedded).")

    if not unattended:
        print_repro_command(sid_env, token_env, tier, plan, purchased_any, out_path, mode,
                            no_prod_cap=args.no_prod_cap)


if __name__ == "__main__":
    main()

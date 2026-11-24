#!/usr/bin/env python3
"""
Deliberate real-external-number call burst. NOT part of the normal
random-batch flow (wizard.py), this is a separate, explicitly-named tool
for the one thing owned numbers can't produce: busy, no-answer, and
device-unreachable statuses, which need a real phone on the other end.

Interactive:
    python3 real_call_burst.py

Unattended:
    python3 real_call_burst.py --sid-env X --token-env Y --tier stage \\
        --to +34XXXXXXXXX --count 10 --interval 1.5 --confirm-real-number

The environment (prod/stage/dev) is always stated, never guessed: you
pick it (interactively, or via --tier), and the script does exactly one
request to confirm the account actually exists there.

--region (default us1) picks the Twilio Region the calls are placed and
logged in, same as wizard.py's --region. The Auth Token must be that
region's.

Every path, interactive or unattended, requires an explicit,
un-skippable confirmation naming the real number before anything is
dialed. There is no default/quiet mode.
"""
import os
import sys
import json
import time
import getpass
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gen import discovery, safety, real_number


def ask(prompt, default=None):
    suffix = f" [{default}]" if default is not None else ""
    val = input(f"{prompt}{suffix}: ").strip()
    return val or default


def ask_tier():
    print("\nEnvironment (never guessed, state it explicitly)")
    for i, t in enumerate(discovery.TIERS, 1):
        print(f"  {i}. {t}")
    raw = ask("Select", default=str(discovery.TIERS.index("stage") + 1))
    return discovery.TIERS[int(raw) - 1]


def ask_region(tier):
    options = discovery.REGIONS_BY_TIER[tier]
    if len(options) == 1:
        return options[0]
    print(f"\nData region on {tier} (where the logs are stored; the Auth Token must be this region's)")
    for i, r in enumerate(options, 1):
        print(f"  {i}. {r}")
    raw = ask("Select (number or name)", default="1")
    if raw.isdigit() and 1 <= int(raw) <= len(options):
        return options[int(raw) - 1]
    if raw.lower() in options:
        return raw.lower()
    sys.exit(f"Invalid region: {raw}. Use one of: {', '.join(options)}.")


def build_arg_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sid-env", help="Env var name holding the Account SID. Passing this enables unattended mode.")
    p.add_argument("--token-env", help="Env var name holding the Auth Token.")
    p.add_argument("--tier", choices=discovery.TIERS,
                    help="Which environment these credentials belong to. Required in unattended mode, "
                         "asked interactively otherwise. Never guessed.")
    p.add_argument("--region", choices=discovery.DATA_REGIONS,
                    help="Twilio Region the calls are placed and logged in (default us1). "
                         "The credentials must be that region's. Available per tier: "
                         + "; ".join(f"{t}: {','.join(r)}" for t, r in discovery.REGIONS_BY_TIER.items()) + ".")
    p.add_argument("--to", help="Real destination phone number, E.164, e.g. +34XXXXXXXXX")
    p.add_argument("--count", type=int, default=5, help="How many calls to place. Default 5.")
    p.add_argument("--interval", type=float, default=1.5, help="Seconds between calls. Default 1.5.")
    p.add_argument("--from-number", help="Owned number to call from. Default: first voice-capable number found.")
    p.add_argument("--message", help="Text to speak. Default: a long public-domain passage, "
                                      "so the call doesn't end almost instantly.")
    p.add_argument("--pause", type=int, default=None,
                    help="Seconds to hold the line after speaking, before hanging up. Default 30.")
    p.add_argument("--record", action="store_true",
                    help="Record what the callee says (<Record transcribe=\"true\">) and transcribe it, "
                         "instead of the passage + pause. Answer and speak for a few seconds.")
    p.add_argument("--record-max", type=int, default=None,
                    help=f"With --record: longest recording in seconds. Default {real_number.DEFAULT_RECORD_MAX_SECONDS}.")
    p.add_argument("--confirm-real-number", action="store_true",
                    help="Required in unattended mode, no interactive prompt exists there.")
    p.add_argument("--confirm-prod", action="store_true",
                    help="Required if the detected account is production.")
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

    print("=== Real-number call burst ===\n")

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


def main():
    args = build_arg_parser().parse_args()
    account_sid, auth_token, unattended, pre_tier = resolve_credentials(args)

    if unattended:
        if not args.tier:
            sys.exit("--tier is required in unattended mode (prod/stage/dev). Never guessed.")
        tier = args.tier
        region = args.region or discovery.DEFAULT_REGION
    elif pre_tier:
        tier = pre_tier
        region = args.region or discovery.datagen_region()
    else:
        tier = args.tier or ask_tier()
        region = args.region or ask_region(tier)

    try:
        api_host = discovery.host_for(tier, region)
    except ValueError as e:
        sys.exit(str(e))
    host, tier, info = discovery.confirm_environment(account_sid, auth_token, tier, region)
    if not host:
        if info and info.get("status"):
            sys.exit(f"Could not authenticate against {tier}/{region} ({api_host}): HTTP {info['status']}. "
                     "Check the credentials (Auth Tokens are per region), or that this is really the right tier and region.")
        sys.exit(f"No answer from {api_host}. Check the VPN; this is a connection problem, not the credentials.")
    print(f"Confirmed: {info.get('friendly_name')}  tier={tier}  region={region}  host={host}")

    rs = "" if region == discovery.DEFAULT_REGION else f"_{region}"
    sid_env = args.sid_env or f"VOICEGEN_SID_{tier.upper()}{rs.upper()}"
    token_env = args.token_env or f"VOICEGEN_TOKEN_{tier.upper()}{rs.upper()}"
    if not unattended:
        os.environ[sid_env] = account_sid
        os.environ[token_env] = auth_token

    if safety.is_prod(host):
        if unattended:
            if not args.confirm_prod:
                sys.exit("BLOCKED: production account in unattended mode, pass --confirm-prod.")
        else:
            if not safety.confirm_prod(info):
                sys.exit("Cancelled.")

    to_number = args.to if unattended else ask("Real destination phone number (E.164)")
    if not to_number:
        sys.exit("A destination number is required.")
    count = args.count if unattended else int(ask("Number of calls", default="5"))
    interval = args.interval if unattended else float(ask("Seconds between calls", default="1.5"))

    numbers = discovery.list_voice_numbers(host, account_sid, auth_token)
    if not numbers:
        sys.exit("No voice-capable numbers on this account to call from.")
    from_number = args.from_number or numbers[0]["phone"]

    print(f"\nThis will call {to_number} {count} time(s), {interval}s apart, from {from_number}.")
    if args.record:
        print("Each answered call is RECORDED and transcribed: speak after the beep, then stay silent to finish.")

    if unattended:
        if not args.confirm_real_number:
            sys.exit("BLOCKED: unattended mode requires --confirm-real-number to dial a real number.")
    else:
        ans = ask(f"Type the destination number back to confirm ({to_number})")
        if ans != to_number:
            sys.exit("Confirmation didn't match. Cancelled.")

    results = real_number.call_burst(host, account_sid, auth_token, from_number, to_number, count, interval,
                                      message=args.message, pause_seconds=args.pause,
                                      record=args.record, record_max_seconds=args.record_max)

    print("\nWaiting a few seconds before polling final statuses...")
    time.sleep(5)
    tally = real_number.poll_burst(host, account_sid, auth_token, results)
    print("\n--- Final tally ---")
    print(json.dumps(tally, indent=2))

    if args.record:
        max_len = args.record_max or real_number.DEFAULT_RECORD_MAX_SECONDS
        print("\nWaiting for the call(s) to end and the transcription(s) to finish...")
        rec = real_number.poll_recordings(host, account_sid, auth_token, results,
                                          max_wait_seconds=max_len + 90)
        print("\n--- Recordings ---")
        print(json.dumps(rec, indent=2))

    if not unattended:
        print_repro_command(sid_env, token_env, tier, to_number, count, interval,
                             from_number, args.message, args.pause, region, args.record, args.record_max)


def print_repro_command(sid_env, token_env, tier, to_number, count, interval,
                         from_number, message, pause, region=discovery.DEFAULT_REGION,
                         record=False, record_max=None):
    parts = [
        "python3 real_call_burst.py",
        f"--sid-env {sid_env} --token-env {token_env}",
        f"--tier {tier}",
    ]
    if region != discovery.DEFAULT_REGION:
        parts.append(f"--region {region}")
    parts += [
        f"--to {to_number}",
        f"--count {count}",
        f"--interval {interval}",
        f"--from-number {from_number}",
    ]
    if message:
        parts.append(f"--message {json.dumps(message)}")
    if pause is not None:
        parts.append(f"--pause {pause}")
    if record:
        parts.append("--record")
        if record_max:
            parts.append(f"--record-max {record_max}")
    if tier == "prod":
        parts.append("--confirm-prod")
    parts.append("--confirm-real-number")

    print("\n--- Run this unattended next time (e.g. from cron/launchd) ---")
    print(f"export {sid_env}=<Account SID>")
    print(f"export {token_env}=<Auth Token>")
    print(" \\\n  ".join(parts))


if __name__ == "__main__":
    main()

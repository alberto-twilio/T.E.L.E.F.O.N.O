#!/usr/bin/env python3
"""
Deliberate real-external-number call burst. NOT part of the normal
random-batch flow (wizard.py), this is a separate, explicitly-named tool
for the one thing owned numbers can't produce: busy, no-answer, and
device-unreachable statuses, which need a real phone on the other end.

Interactive:
    python3 real_call_burst.py

Unattended:
    python3 real_call_burst.py --sid-env X --token-env Y \\
        --to +34663053910 --count 10 --interval 1.5 --confirm-real-number

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


def build_arg_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sid-env", help="Env var name holding the Account SID. Passing this enables unattended mode.")
    p.add_argument("--token-env", help="Env var name holding the Auth Token.")
    p.add_argument("--to", help="Real destination phone number, E.164, e.g. +34663053910")
    p.add_argument("--count", type=int, default=5, help="How many calls to place. Default 5.")
    p.add_argument("--interval", type=float, default=1.5, help="Seconds between calls. Default 1.5.")
    p.add_argument("--from-number", help="Owned number to call from. Default: first voice-capable number found.")
    p.add_argument("--message", help="Text to speak. Default: a long public-domain passage, "
                                      "so the call doesn't end almost instantly.")
    p.add_argument("--pause", type=int, default=None,
                    help="Seconds to hold the line after speaking, before hanging up. Default 30.")
    p.add_argument("--confirm-real-number", action="store_true",
                    help="Required in unattended mode, no interactive prompt exists there.")
    p.add_argument("--confirm-prod", action="store_true",
                    help="Required if the detected account is production.")
    return p


def main():
    args = build_arg_parser().parse_args()

    if args.sid_env:
        if not args.token_env:
            sys.exit("--token-env is required when --sid-env is passed.")
        try:
            account_sid, auth_token = os.environ[args.sid_env], os.environ[args.token_env]
        except KeyError as e:
            sys.exit(f"Env var {e} is not set.")
        unattended = True
    else:
        print("=== Real-number call burst ===\n")
        account_sid = ask("Account SID")
        auth_token = getpass.getpass("Auth Token (input hidden): ")
        unattended = False

    host, tier, info = discovery.detect_environment(account_sid, auth_token)
    if not host:
        sys.exit("Could not authenticate against prod, stage, or dev. Check the credentials.")
    print(f"Detected: {info.get('friendly_name')}  tier={tier}  host={host}")

    sid_env = args.sid_env or f"VOICEGEN_SID_{tier.upper()}"
    token_env = args.token_env or f"VOICEGEN_TOKEN_{tier.upper()}"
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

    if unattended:
        if not args.confirm_real_number:
            sys.exit("BLOCKED: unattended mode requires --confirm-real-number to dial a real number.")
    else:
        ans = ask(f"Type the destination number back to confirm ({to_number})")
        if ans != to_number:
            sys.exit("Confirmation didn't match. Cancelled.")

    results = real_number.call_burst(host, account_sid, auth_token, from_number, to_number, count, interval,
                                      message=args.message, pause_seconds=args.pause)

    print("\nWaiting a few seconds before polling final statuses...")
    time.sleep(5)
    tally = real_number.poll_burst(host, account_sid, auth_token, results)
    print("\n--- Final tally ---")
    print(json.dumps(tally, indent=2))

    if not unattended:
        print_repro_command(sid_env, token_env, tier, to_number, count, interval,
                             from_number, args.message, args.pause)


def print_repro_command(sid_env, token_env, tier, to_number, count, interval,
                         from_number, message, pause):
    parts = [
        "python3 real_call_burst.py",
        f"--sid-env {sid_env} --token-env {token_env}",
        f"--to {to_number}",
        f"--count {count}",
        f"--interval {interval}",
        f"--from-number {from_number}",
    ]
    if message:
        parts.append(f"--message {json.dumps(message)}")
    if pause is not None:
        parts.append(f"--pause {pause}")
    if tier == "prod":
        parts.append("--confirm-prod")
    parts.append("--confirm-real-number")

    print("\n--- Run this unattended next time (e.g. from cron/launchd) ---")
    print(f"export {sid_env}=<Account SID>")
    print(f"export {token_env}=<Auth Token>")
    print(" \\\n  ".join(parts))


if __name__ == "__main__":
    main()

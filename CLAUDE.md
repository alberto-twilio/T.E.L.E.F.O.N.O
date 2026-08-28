# voice-test-data-gen

## What this is

A standalone, local, script-based tool that generates realistic Twilio
Voice test data (calls, recordings, transcriptions, conferences) against
any account/subaccount in prod/stage/dev. Built to replace an ad-hoc
process that used to live entirely inside a long-running Claude Code
session, see `README.md` for the user-facing usage doc.

Read `README.md` first. This file is for an agent working *on* the tool,
not for someone running it.

## Non-negotiable design constraints

- **`gen/core.py` is stdlib-only, no exceptions.** It gets read verbatim
  and concatenated into every standalone script `wizard.py` emits. A
  third-party import here breaks portability for every generated script,
  not just this repo.
- **Never embed a literal Account SID or Auth Token in any file this
  tool writes**, including generated standalone scripts. Only ever write
  environment variable *names* (see `wizard.py`'s `render_standalone`).
  If you're tempted to "just hardcode it for testing," write it to an env
  var and source that instead.
- **Prod guardrails live in `gen/safety.py` and must be unconditional.**
  `is_prod()` / `confirm_prod()` / `cap_plan_for_tier()` should never be
  bypassable by a flag, a config value, or an agent deciding the check
  is unnecessary this one time. If you add a new entry point (e.g. a
  future non-interactive/cron mode), route it through `safety.py` too,
  don't reimplement the check inline.
- **Real external numbers only ever get dialed from `real_call_burst.py` /
  `gen/real_number.py`, never from `wizard.py` or `gen/core.py`.** That
  separation is the whole safety model for real numbers: it's opt-in by
  which script you run, not a flag inside the normal flow. Don't add a
  "use a real number for this batch" option to the random-batch path,
  and don't let `gen/core.py` import from `gen/real_number.py` or vice
  versa in a way that blurs which one is doing the dialing.
- **One implementation of "how to generate a call/recording/conference"
  anywhere in this repo.** `wizard.py` imports `gen/core.py` directly;
  the standalone script gets its exact source text. Don't add a second
  copy of the generation logic for "the simple case."

## Why the design looks the way it does

- **Environment is auto-detected, never asked.** A wrong API host
  (`api.twilio.com` vs `.stage.` vs `.dev.`) produces a misleading 401
  that looks like a bad credential, not a routing problem. Trying all
  three hosts and using whichever authenticates removes an entire class
  of confusing failures. See `gen/discovery.py:detect_environment`.
- **No scheduler is built in.** `api.stage.twilio.com` / `api.dev.twilio.com`
  resolve to internal addresses reachable only from the corporate VPN, so
  a cloud-hosted scheduler (GitHub Actions, Lambda, etc.) can't reach them
  anyway. Portability is the unit of design instead: `wizard.py` itself
  runs fully unattended via `--sid-env`/`--token-env` + flags (see
  README), and/or a standalone script can be saved and run with zero
  dependency on this repo. Either way, run it from wherever already has
  network access, on whatever cron/launchd that machine already has.
- **`--confirm-prod` and `--allow-purchase` are not conveniences, they're
  the unattended-mode replacement for the interactive prompts.** Interactive
  mode asks a human; unattended mode has no human to ask, so these flags
  are the only way that consent can exist at all in that path. Don't add
  a way to default them to true, don't infer them from another flag, and
  don't let `--mode` or anything else imply them.
- **The Trust Hub compliance-profile check exists because we hit this
  blind once.** A dev account's purchase attempts failed with an opaque
  "Primary compliance profile is not approved" error, discovered only
  after building a whole batch around it. `check_compliance_profile` in
  `gen/discovery.py` tries to surface that up front. It's explicitly
  marked best-effort in that function's docstring, because its exact
  Trust Hub API shape hasn't been verified against a real unapproved
  account, only against the reactive purchase-time error message. If you
  get a chance to verify it for real, update the docstring, don't just
  delete the caveat.
- **Conferences never rely on auto-hangup.** A `<Dial><Conference>`
  script with no timeout stays open indefinitely. `run_conferences`
  always looks up the conference by `FriendlyName` and explicitly ends it
  (`Status=completed`) after both legs join. Don't remove that step to
  "simplify" the loop, it'll leave real conferences running.
- **Recordings need genuinely long content to transcribe.** A recording
  under a few seconds tends to fail transcription. `PASSAGES` in
  `gen/core.py` holds real public-domain text (Moby-Dick, A Tale of Two
  Cities, Pride and Prejudice, Don Quixote opening lines) for exactly
  this reason, don't replace them with short placeholder strings.
- **`twimlets.com/echo` is the only TwiML hosting used.** There's no
  hosted TwiML endpoint of our own. Keep individual `<Say>` blocks to a
  few hundred characters, longer inline TwiML risks URL-length truncation.

## Numbers, pairing, and regions

- `make_pairs(numbers)` cycles every number as both caller and callee,
  works for any `len(numbers) >= 2`.
- `pick_conference_players(numbers, i)` degrades gracefully: with only 2
  numbers, they act as each other's caller ID (the manual guide's
  2-number fallback); with 4+, dedicated caller-ID numbers are used.
- `region_for(i, regions)` just cycles the requested region list onto
  the conference's `<Conference region="...">` attribute. It's a TwiML
  parameter, not an account setting, no other plumbing needed to add a
  new region.

## Testing changes

There's no test framework here on purpose (small tool, stdlib only). To
validate a change:

```bash
python3 -m py_compile gen/core.py gen/discovery.py gen/safety.py wizard.py
```

For anything touching pairing/region logic, exercise the pure functions
directly with fake number dicts (no network needed), see the session
history for the exact snippets used when this was first built. For
anything touching the actual API calls, run `wizard.py` against a known
*stage* subaccount with a small manual count first (2-5 per category),
never validate a change against prod.

## Things to never do here

- Don't add a `requirements.txt` dependency to `gen/core.py` or anything
  it imports.
- Don't relax the `PROD` confirmation string or the purchase confirmation
  to make testing more convenient, temporarily or otherwise.
- Don't write a "quick mode" that skips the compliance-profile check.
- Don't assume this repo's own scratchpad/working directory is durable,
  it's not committed to git (there's no `.git` here yet), so anything
  meant to persist across sessions belongs in a file this README/CLAUDE.md
  points at explicitly, not in an untracked working file.

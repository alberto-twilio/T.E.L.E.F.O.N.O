# T.E.L.E.F.O.N.O. (formerly voice-test-data-gen)

Telephony Emulation Logging Event Fabrication Orchestration for Network Operations.
The repo and app were renamed; the Keychain service (`voice-test-data-gen`), the
userData folder (`voice-test-data-gen-desktop`), the npm package name and the
`appId` keep the old name on purpose, see the desktop notes below. Never "finish
the rename" on those.

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
- **Prod guardrails live in `gen/safety.py`.** `is_prod()` /
  `confirm_prod()` must be unconditional, never bypassable by a flag, a
  config value, or an agent deciding the check is unnecessary this one
  time. The one deliberate exception is the caps in `cap_plan_for_tier()`
  (`PROD_MAX_PER_CATEGORY`, 30, and `PROD_MAX_CALL_DURATION_SECONDS`,
  5m): the user chose to make them skippable via the explicit
  `--no-prod-cap` flag. That flag only lifts the caps, it never skips
  the `PROD` confirmation / `--confirm-prod`,
  and it must never be defaulted on or implied by another flag. Don't add
  any other bypass. If you add a new entry point (e.g. a future
  non-interactive/cron mode), route it through `safety.py` too, don't
  reimplement the check inline.
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
- **A `plan` value is a SPEC (a string), never a pre-rolled number.**
  `parse_count_spec()`/`parse_duration_range_spec()` in `gen/core.py`
  resolve a spec at actual execution time, inside `run_calls`/
  `run_recordings_transcriptions`/`run_conferences`, not before. Don't
  add code anywhere (`wizard.py`, a future entry point) that calls
  `random.randint` on a range and stores the *result* in a plan/config,
  that's exactly the bug this was built to avoid: it would freeze one
  number into a saved standalone script forever instead of re-rolling
  fresh every time that script runs. If you need to show a human what a
  plan will do before running it, print the spec, not a preview roll.
- **`desktop/` is a front-end over `wizard.py`, never a second generator.**
  The app is named TELEFONO (Telephony Emulation Logging Event Fabrication
  Orchestration for Network Operations). The name is cosmetic: the Keychain
  service and the userData folder keep the old `voice-test-data-gen` names on
  purpose, renaming them would orphan saved credentials and history.
  It builds wizard.py's *unattended* command (`desktop/lib/args.js`) and
  spawns it; it must not import or reimplement anything from `gen/`.
  Credentials go in the macOS Keychain (`lib/keychain.js`) and reach the child
  only as env vars named by `--sid-env/--token-env`, never in argv, a profile
  file, or a run log. `--confirm-prod` is passed only when the user typed
  `PROD` in the run dialog for *that run*; never store it on a profile, never
  infer it from `noProdCap`. **Run all** is one dialog that names every profile and,
  if any is prod, needs `PROD` typed once for that click; never skip or default it. `--allow-purchase` is deliberately not exposed.
  Profiles hold specs, not rolled numbers (same rule as `plan`).
  Account type (parent/subaccount) is read once, when credentials are saved, via
  `wizard.py --describe-account` (`desktop/lib/describe.js`): one read-only GET,
  prints a JSON line, exits before any generation or PROD logic. The app never
  talks to Twilio itself. A profile's Account SID is read-only once stored.
  Run progress is read from wizard.py's stdout (`desktop/lib/progress.js`):
  the `[plan] calls=N` lines and `[call i/n]`-style item lines printed by
  `gen/core.py`. Don't change those formats without updating that parser and
  its tests. Every item weighs the same; categories roll their count only
  when they start, so the total is an estimate until each has announced it.

## Why the design looks the way it does

- **`gen/safety.py`'s prod cap clamps the spec itself, not a resolved
  value.** `_cap_spec()` rewrites e.g. `"10-60"` down to `"10-30"` (or
  `"1-300"` for a `call_duration` of `1s-10m`), it doesn't just cap whatever number this
  one run happened to roll. This is a direct consequence of specs being
  resolved at execution time: `gen/core.py` has no dependency on
  `gen/safety.py` (a standalone script never imports it), so if the cap
  only touched a resolved value, a saved standalone script targeting prod
  would re-roll inside the *original, uncapped* range on every future
  run, silently defeating the cap. If you touch `_cap_spec`, keep it
  operating on the spec string, not a rolled number. With
  `--no-prod-cap`, the uncapped spec is what gets saved, deliberately.
- **Environment is stated by the user, never guessed.** This used to
  auto-detect by trying all three hosts and using whichever authenticated
  (`detect_environment`). Deliberately changed: the caller now says which
  tier the credentials belong to (a menu interactively, `--tier`
  unattended), and `confirm_environment` does exactly one request to
  verify the account actually exists there. A wrong API host
  (`api.twilio.com` vs `.stage.` vs `.dev.`) still produces the same
  misleading 401 a bad credential would, that hasn't changed, only who
  decides which host gets tried has. Don't reintroduce the try-all-three
  loop, if a new entry point needs environment info, it should ask (or
  take `--tier`), not guess.
- **`DATAGEN_ACCOUNT_SID`/`DATAGEN_ACCOUNT_TOKEN`/`DATAGEN_ENVIRONMENT`
  are a convenience layer, not a third mode.** `resolve_from_datagen_env()`
  in `gen/discovery.py` only changes *how* credentials/tier get obtained
  (skip the prompts if all three are already set), it doesn't change
  interactive vs. unattended behavior elsewhere (categories/counts in
  `wizard.py`, the real-number confirmation in `real_call_burst.py` all
  still happen exactly as before). If you add a new entry point, wire
  this in the same narrow way, don't let it grow into a second unattended
  mode competing with `--sid-env`/`--token-env`.
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
- **Call duration is a spec too (`call_duration`), resolved per-call, not
  per-batch.** `run_calls` calls `parse_duration_range_spec(duration_spec)`
  independently for every completed call, so a 10-call batch with
  `1s-3m` produces 10 different durations, not one duration reused 10
  times. It targets the duration via the precise-duration `<Pause>`
  recipe (callee's pause is the exact target, caller's is 5s longer so
  the callee's shorter pause governs when the call actually ends). When
  `call_duration` is unset/`0`, calls fall back to the older
  passage-based variety instead, that fallback path must keep working,
  don't delete it.
- **Target and actual duration are both logged, on purpose.** The target
  is known at fire time and printed immediately
  (`target_duration_seconds` on the entry); `poll_results` mutates the
  same entry in place to add `actual_duration_seconds` once Twilio
  reports it, and `gen/core.py:run()` re-saves the results JSON after
  polling specifically so the actual duration lands on disk too, not
  just target. `print_report` shows target -> actual per call. If you
  add a new per-call attribute that's only known after polling, follow
  this same mutate-in-place-then-resave pattern rather than inventing a
  parallel results structure.

## Defaults

Default count ranges (interactive prompt defaults, `--calls`/
`--recordings-transcriptions`/`--conferences` CLI defaults, all three
kept in sync in `wizard.py`): calls `10-30`, recordings/transcriptions
`5-10`, conferences `5-10`. Recordings/conferences are cheaper defaults
than calls on purpose, each one does more polling/setup work per unit
(a recording needs a transcription to also complete; a conference needs
two legs plus an explicit end-call), so a "10-30"-sized batch of those
would take noticeably longer for comparable insight. `call_duration`
defaults to `1s-3m`. If you change one of these, update the CLI default,
the interactive prompt default, and both example commands in `README.md`
together, they've drifted out of sync before.

## `select_multi` accepts names, not just indices

`select_multi` (used for both category and conference-region selection)
accepts a comma-separated mix of index numbers *and* the option's literal
text, case-insensitively (e.g. `us1` or `1` both select the same thing).
This exists because typing the value you can already see on screen is at
least as natural as typing its position, and a typo used to crash with a
raw Python traceback (`ValueError` from `int()`) instead of a clear
message. If you touch this function, keep both entry forms working, and
keep failing on a genuinely invalid token as a clean `sys.exit` with the
valid options listed, not an unhandled exception.

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
python3 -m py_compile gen/core.py gen/discovery.py gen/safety.py gen/real_number.py wizard.py real_call_burst.py
```

For the desktop app: `cd desktop && npm test` (no network; the runner tests use
a fake python). Never validate UI changes by running a profile against prod.

For anything touching pairing/region logic, exercise the pure functions
directly with fake number dicts (no network needed), see the session
history for the exact snippets used when this was first built. For
anything touching the actual API calls, run `wizard.py` against a known
*stage* subaccount with a small manual count first (2-5 per category),
never validate a change against prod.

## Things to never do here

- Don't delete Keychain items by service name (`security delete-generic-password
  -s voice-test-data-gen` with no `-a`). That service holds the user's real
  profile credentials, not test leftovers. When testing the desktop app, use a
  throwaway `--user-data-dir` and delete only the exact account (`-a <id>`) you
  created.

- Don't add a `requirements.txt` dependency to `gen/core.py` or anything
  it imports.
- Don't relax the `PROD` confirmation string or the purchase confirmation
  to make testing more convenient, temporarily or otherwise.
- Don't write a "quick mode" that skips the compliance-profile check.
- Don't assume this repo's own scratchpad/working directory is durable,
  uncommitted or unpushed state has genuinely been lost here before
  (across a session rewind, mid-development). Commit and push anything
  meant to persist, don't rely on an untracked working file.

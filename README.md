# T.E.L.E.F.O.N.O.

*Telephony Emulation Logging Event Fabrication Orchestration for Network Operations.* (Formerly `voice-test-data-gen`; the repo was renamed. Some
internal identifiers keep the old name on purpose, see the desktop app notes below.)

Generates realistic Twilio Voice test data (calls, recordings, transcriptions,
conferences) against any account or subaccount, in any environment
(prod/stage/dev), with optional conference regions. Runs locally, no
Claude session or external service required.

## Requirements

Python 3, stdlib only. No `pip install` needed anywhere in this tool or in
the scripts it produces.

## Usage

### Interactive

```bash
python3 wizard.py
```

Both `wizard.py` and `real_call_burst.py` first check for three
well-known env vars: `DATAGEN_ACCOUNT_SID`, `DATAGEN_ACCOUNT_TOKEN`,
`DATAGEN_ENVIRONMENT` (one of `prod`/`stage`/`dev`). If all three are
set, they're used silently, no prompts at all for credentials/tier. If
any are missing, you're told they're not set and given three ready-to-
paste template lines (keys only) for any env file, then asked normally.

Either way, you end up providing **Account SID**, **Auth Token**, and
**which environment** (prod/stage/dev) these credentials belong to,
never guessed. The wizard then does exactly one request to confirm the
account actually exists on that environment's host, and reports the
`friendly_name` before doing anything else. Everything past that is
discovered automatically:
- **Prod is gated hard**: if the detected tier is `prod`, you must type
  `PROD` in capitals to continue. This isn't a flag that can be forgotten,
  it's enforced in code (`gen/safety.py`).
- **Prod is capped at 30 per category** (calls,
  recordings/transcriptions, conferences, video rooms, video participants) **and 5m (300s) per call**
  (`--call-duration`). The spec itself is clamped (e.g. `10-60` becomes
  `10-30`, `1s-10m` becomes `1-300`), so a saved standalone script stays
  capped on every future run too, and each change is reported as a
  `NOTE:` before the plan is printed. The limits are shown in the
  environment menu and in the `PROD` confirmation banner. Pass
  `--no-prod-cap` to skip both, e.g. `python3 wizard.py --no-prod-cap`.
  It only lifts the caps; the `PROD` confirmation (or `--confirm-prod`)
  is still required.
- **Numbers**: lists existing voice-capable numbers. If there are fewer
  than 2, it checks whether the account's Trust Hub compliance profile is
  approved *before* attempting a purchase (a profile that isn't approved
  is a hard, manual-only blocker, not something any script can fix, so we
  surface it up front instead of failing confusingly mid-purchase).
- **Purchases** always get their own explicit `YES` confirmation, shown
  with the exact numbers about to be bought.

Then you pick categories, counts (fixed or a random range), a call
duration range for completed calls (e.g. `1s-3m`, more realistic
duration variety for Insights charts than the old fixed-ish durations),
and, for conferences, optional regions, all via short numbered menus,
not a wall of CLI flags.

**Every random value, counts and call duration alike, is a spec, not a
pre-rolled number.** `"10-60"` is stored as-is and only resolved
(`random.randint`) at the moment a batch actually runs, inside
`gen/core.py`. This matters most for a saved standalone script: run it
five times and you get five independent random outcomes, not the same
number forever because that's what happened to get rolled when it was
generated.

At the end you choose to run the batch now, save it as a standalone
script, or both. Every interactive run finishes by printing the exact
unattended command that would reproduce it, copy-paste it into a cron
entry or launchd job whenever you're ready to schedule this.

### Unattended (no prompts at all)

Pass `--sid-env`/`--token-env` (naming environment variables that must
already hold the real credential values) and the run becomes fully
non-interactive:

```bash
export VOICEGEN_SID_STAGE=...
export VOICEGEN_TOKEN_STAGE=...
python3 wizard.py \
  --sid-env VOICEGEN_SID_STAGE --token-env VOICEGEN_TOKEN_STAGE \
  --tier stage \
  --categories calls,recordings_transcriptions,conferences \
  --calls 10-30 --call-duration 1s-3m \
  --recordings-transcriptions 5-10 --conferences 5-10 \
  --regions us1,au1 \
  --mode run
```

`--call-duration` only affects completed calls (the others have no
meaningful duration to control), accepts `s`/`m` suffixes or bare
seconds, and `0` disables it in favor of the old passage-based variety.
Each completed call rolls its own duration independently, not one value
for the whole batch.

## Video rooms

`video_rooms` is an opt-in category (never in the default set). It creates
empty Video rooms through the REST API (`POST /v1/Rooms`) and completes each
one right away. No participants and no recordings yet.

```bash
python3 wizard.py ... --categories video_rooms \
  --video-rooms 5-10 --video-room-types group,group-small,peer-to-peer \
  --video-room-prefix telefono
```

Group rooms are created with `AudioOnly=false` explicitly (stage's account
default is audio-only, rejected with 53127). Only `group` is used by default: accounts that started using Video after
2024-10-21 can't create the legacy types (errors 53126/53127). Types cycle
through the list you give; a type the account rejects is recorded as an error and the run goes on. Video is
subject to the same prod rules as everything else on prod: `PROD` confirmation and the per-category cap (rooms, participants and recorded rooms count; `--no-prod-cap` lifts it). A Video-only run never touches voice
numbers (they are only fetched when a Voice category runs).

## Video recordings (needs Playwright)

`video_recordings` makes participants join real rooms so Twilio produces
recordings (one video + one audio each). It drives headless Chromium with a
fake camera/mic and twilio-video.js, so it is the one part that needs a
package: `pip3 install playwright` (it reuses a Chromium already in
`~/Library/Caches/ms-playwright`, or run `python3 -m playwright install chromium`).
Unattended only (`--categories video_recordings`) and never as a standalone script.

```bash
python3 wizard.py ... --categories video_recordings \
  --video-recordings 2-6 --video-rec-rooms 2-3 --video-hold 5-15
```

`--video-compose` (desktop: "Compose each recorded room") then creates one Video Composition per recorded room once its recordings are `completed` (grid layout, mp4, 640x480, all audio sources) and waits up to 5 min for each to finish. Compositions are REST only, billed by Twilio, and follow the same prod rules as the rest of Video (rooms are capped via `--video-rec-rooms`). Needs `video_recordings`; never saved to a standalone script.

Participants are spread over the rooms and hold for a random time in
`--video-hold`. Access tokens need an API Key: by default a temporary one is
created for the run and deleted after (also on failure); or pass your own with
`--video-key-env` / `--video-secret-env` (env var NAMES, never values).

`--tier` is required in unattended mode, same reasoning as everywhere
else: there's no interactive menu to fall back on, so it must be stated
explicitly. A wrong tier fails cleanly (wrong host for these credentials
authenticates the same way a wrong password would), it never silently
tries the other two.

Two things are never bypassed by a flag alone:

- **Production**: if the stated tier is prod, `--confirm-prod` is
  required or the run aborts. There's deliberately no way to skip this
  by accident, since there's no interactive prompt to fall back on here.
  The prod caps (30 per category, 5m per call) also apply here; add `--no-prod-cap`
  alongside `--confirm-prod` to skip it. The printed repro command
  includes `--no-prod-cap` when the interactive run used it.
- **Purchasing**: if fewer than 2 usable numbers exist, `--allow-purchase`
  is required or the run aborts with a clear message. The recommended
  path is to run once interactively to provision numbers, then schedule
  the unattended command (which won't need it again).

## Desktop app (`desktop/`)

**TELEFONO** (*Telephony Emulation Logging Event Fabrication Orchestration for
Network Operations*, T.E.L.E.F.O.N.O.) is an Electron front-end for the
repeat-it-every-day case. The terminal tools above
keep working exactly as before; the app is an addition, not a replacement.

```bash
cd desktop
npm install
npm start            # run from source
npm run dist         # builds "dist/mac-arm64/TELEFONO.app" (unsigned)
npm test             # arg-building, validation and runner tests (no network)
```

- **Profiles** store an environment, credentials and a plan (categories,
  count/duration *specs*, conference regions). Create one once, then hit
  **Run** on it, from the sidebar or the profile page. Duplicate/Edit to vary it.
- **Account type:** when you save credentials the app asks `wizard.py
  --describe-account` (one read-only call, which also verifies the credentials
  on that environment) and shows a **Parent** or **Subaccount** pill. A
  profile's Account SID is read-only afterwards; to use another account, create
  a new profile. Profiles saved before this show no account pill until you
  save a new Auth Token on them.
- **Credentials live in the macOS Keychain**, one item per profile (service
  `voice-test-data-gen`). They are never written to a file, never put on a
  command line the app launches, and the child process gets them as env vars
  only. Editing a profile with the credential fields blank keeps what's stored.
- **Specs stay specs.** `10-30` is stored as-is and re-rolled by `gen/core.py`
  on every run, so four runs a day give four different outcomes.
- **Every run is `wizard.py` in unattended mode.** The app builds the same
  `--sid-env/--token-env/--tier/--calls/...` command documented above, so the
  prod caps, number discovery and generation logic are the single existing
  implementation. The app adds one flag, `--results-path`, so each run's
  results JSON lands in its own file instead of overwriting the day's file.
- **Progress**: a running profile shows a percentage (inside its Run button, in the
  history row, and as a bar on the run's log page). Each call, recording/transcription and
  conference counts as one item. Counts are rolled when each category starts,
  so until then the total is estimated from the spec's midpoint (the run page
  labels it "estimated total"); it becomes exact once all categories have rolled. It holds at 99% while
  the wizard does its final status polling, and reads 100% only when the run ends.
- **Run history** (status, duration, counts, full log) is kept per profile, and
  click a row to re-read its log. Runs can overlap (several profiles, or
  the same one twice); a spinner in the sidebar and on the profile page shows
  how many are in flight, and **Stop** kills just that run. A run still marked
  running when the app starts is relabeled `interrupted`.
- **Run all / Run selected** (bottom of the sidebar): tick profiles with their
  checkboxes and the button becomes `Run selected (n)`; with nothing ticked it
  is `Run all`. Either way it starts those profiles that have credentials, in
  parallel, after one confirmation listing them. Ticks are remembered.
  If any is prod you type `PROD` once for that click; profiles with no
  credentials are skipped.
- **Prod**: every run on a prod profile opens a dialog where you type `PROD`;
  that is what passes `--confirm-prod`, and it is asked every time, never
  remembered. A profile's "lift the prod caps" checkbox maps to `--no-prod-cap`
  and does not skip the dialog.
- **Purchasing numbers is not available in the app.** If an account has fewer
  than 2 voice numbers the run fails with wizard.py's `BLOCKED` message; run
  `python3 wizard.py` once interactively to provision them.
- Needs `python3` (found via a login shell, then Homebrew/system paths). Data
  is stored in `~/Library/Application Support/voice-test-data-gen-desktop/`
  (the old name is kept so existing profiles and history survive the rename).
  The packaged app bundles a *copy* of `wizard.py` and `gen/`, so rebuild after
  changing Python code.

## Real-number call burst (`real_call_burst.py`)

Everything above only ever touches numbers the account owns. Some
statuses genuinely can't be produced that way, a `voice_url`-backed
number auto-answers instantly, so there's no ring window for `no-answer`,
no way to occupy the line for `busy`, and no device to go
unreachable/airplane-mode. This is a **separate, explicitly-named tool**
for exactly that gap, it is never reachable from `wizard.py`'s normal
flow and never embedded into any standalone script that flow emits.

```bash
python3 real_call_burst.py
```

or unattended:

```bash
python3 real_call_burst.py \
  --sid-env VOICEGEN_SID_STAGE --token-env VOICEGEN_TOKEN_STAGE --tier stage \
  --to +34663053910 --count 10 --interval 1.5 --confirm-real-number
```

Every path requires an explicit, un-skippable confirmation naming the
real number before anything is dialed, typing the number back
interactively, or `--confirm-real-number` unattended. There is no default
or quiet mode. Verified in practice: a burst of calls a couple seconds
apart against a real phone reliably produces a natural mix of
`completed`, `busy` (whenever the line's already occupied by a previous
call in the burst), and `no-answer`.

## The standalone script

Saving produces a single, self-contained `.py` file with:

- The chosen account's numbers and plan baked in as data.
- The exact same generation logic as `gen/core.py`, copied in verbatim
  (single source of truth, no reimplementation, no drift).
- **No embedded credentials.** It reads the Account SID/Auth Token from
  two environment variable *names* that are baked in (their values are
  never written to the file). Run it later with:

  ```bash
  export VOICEGEN_SID_STAGE=... VOICEGEN_TOKEN_STAGE=...
  python3 voice_batch_stage_20260826.py
  ```

Because it's stdlib-only and has no dependency on this repo, it can be
copied anywhere, shared with a teammate, or dropped into cron/launchd on
any machine that has network access to the target environment (stage/dev
require the corporate VPN; prod does not, but prod also isn't something
you'd want to schedule unattended, that's why the confirmation gate above
exists in the wizard and the standalone script itself has no bypass for
it, running it against prod still requires `VOICEGEN_SID_PROD` style env
vars to have been set deliberately).

## Layout

```
wizard.py            interactive front-end, also renders standalone scripts
gen/
  core.py             all generation logic + reporting (stdlib only, portable)
  discovery.py        environment confirmation (given, not guessed), number listing/purchase, compliance check
  safety.py           prod guardrails (30 per category / 5m per call caps, confirmations)
desktop/              Electron app: profiles, one-click runs, history (shells out to wizard.py)
```

`gen/core.py` is the single source of truth. The wizard imports it
directly; the standalone script gets its exact source text concatenated
in. There's only one implementation of "how to generate a call" anywhere
in this tool.

## Known limitations

- Generated data is always timestamped "now", there's no way to backfill
  data for a past day (a Twilio platform constraint, not a tool
  limitation).
- The compliance-profile check (`gen/discovery.py`) is best-effort and
  hasn't been exercised against a real unapproved account in this repo's
  test history yet, if it ever reports "unknown", treat that as "we don't
  know", not "it's fine".
- No scheduling is built in on purpose (see the network-reachability note
  above), the standalone script is designed to be cron'd/launchd'd by
  whatever already has access to the target environment.

## Quick test (desktop)

On a profile page, pick a kind next to **Quick test** (call, recording + transcription, conference, video room, video recording, video recording + composition) to generate a single item without running the whole profile. It goes through the same path as a normal run, including the `PROD` confirmation and caps, and leaves the profile unchanged. The CLI equivalent for calls is `--call-mix completed`.

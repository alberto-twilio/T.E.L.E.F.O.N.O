# voice-test-data-gen

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

`--tier` is required in unattended mode, same reasoning as everywhere
else: there's no interactive menu to fall back on, so it must be stated
explicitly. A wrong tier fails cleanly (wrong host for these credentials
authenticates the same way a wrong password would), it never silently
tries the other two.

Two things are never bypassed by a flag alone:

- **Production**: if the stated tier is prod, `--confirm-prod` is
  required or the run aborts. There's deliberately no way to skip this
  by accident, since there's no interactive prompt to fall back on here.
- **Purchasing**: if fewer than 2 usable numbers exist, `--allow-purchase`
  is required or the run aborts with a clear message. The recommended
  path is to run once interactively to provision numbers, then schedule
  the unattended command (which won't need it again).

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
  safety.py           prod guardrails (hard caps, confirmations)
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

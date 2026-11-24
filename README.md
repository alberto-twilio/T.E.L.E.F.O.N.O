# T.E.L.E.F.O.N.O.

*Telephony Emulation Logging Event Fabrication Orchestration for Network Operations.*

Generates Twilio Voice test data (calls, recordings, transcriptions,
conferences, and optionally Video rooms) in any account or subaccount on
prod, stage or dev, in us1, ie1 or au1. It has two command-line tools and a
desktop app on top of the first one:

| | What it does |
|---|---|
| `wizard.py` | Generates the test data between the account's own numbers. |
| `real_call_burst.py` | Calls a real phone (yours) to get statuses the wizard can't produce: `busy`, `no-answer`, recorded calls. |
| `desktop/` (TELEFONO app) | Saves profiles and runs `wizard.py` with one click. |

The full reference (every flag, prod rules, Video, standalone scripts) is in
[docs/USAGE.md](docs/USAGE.md).

## Requirements

- Python 3. The command-line tools need nothing else (no `pip install`).
- For the app: macOS and Node.js with npm.
- Stage and dev need the corporate VPN.

## Build the app

```bash
cd desktop
npm install
npm test
npm run dist
```

`npm run dist` builds `desktop/dist/mac-arm64/TELEFONO.app` (unsigned). Open it
from there, or copy it to `/Applications`:

```bash
open desktop/dist/mac-arm64/TELEFONO.app
```

```bash
ditto desktop/dist/mac-arm64/TELEFONO.app /Applications/TELEFONO.app
```

To run it from source without building, use `npm start` in `desktop/`.

The app bundles a copy of `wizard.py` and `gen/`, so rebuild it after changing
the Python code. Credentials are stored in the macOS Keychain, and profiles and
run history in `~/Library/Application Support/voice-test-data-gen-desktop/`, so
rebuilding or replacing the app keeps them.

## `wizard.py`

Interactive: it asks for the credentials, environment, region, what to
generate and how many.

```bash
python3 wizard.py
```

Unattended: the credentials go in environment variables, and you pass their
*names*, never the values.

```bash
export VOICEGEN_SID_STAGE=ACxxxxxxxx
export VOICEGEN_TOKEN_STAGE=xxxxxxxx
python3 wizard.py --sid-env VOICEGEN_SID_STAGE --token-env VOICEGEN_TOKEN_STAGE \
  --tier stage --categories calls,recordings_transcriptions,conferences \
  --calls 2-5 --recordings-transcriptions 2 --conferences 2 --mode run
```

Prod, AU1, routing the numbers to au1 first (see below). Prod always needs
`--confirm-prod` and is capped at 30 per category:

```bash
export VOICEGEN_SID_PROD_AU1=ACxxxxxxxx
export VOICEGEN_TOKEN_PROD_AU1=xxxxxxxx   # the account's au1 Auth Token
python3 wizard.py --sid-env VOICEGEN_SID_PROD_AU1 --token-env VOICEGEN_TOKEN_PROD_AU1 \
  --tier prod --region au1 --route-numbers \
  --categories calls,recordings_transcriptions,conferences \
  --calls 5 --recordings-transcriptions 3 --conferences 3 \
  --mode run --confirm-prod
```

Every interactive run ends by printing the unattended command that repeats it.

## `real_call_burst.py`

Calls a real number you own. It asks you to confirm that number before
dialing.

Interactive:

```bash
python3 real_call_burst.py
```

A burst of 10 calls, a mix of `completed`, `busy` and `no-answer`:

```bash
python3 real_call_burst.py \
  --sid-env VOICEGEN_SID_STAGE --token-env VOICEGEN_TOKEN_STAGE --tier stage \
  --to +34XXXXXXXXX --count 10 --interval 1.5 --confirm-real-number
```

One recorded call in prod AU1. Answer it, speak after the beep, then stay
silent. The script prints the recording and its transcription:

```bash
python3 real_call_burst.py \
  --sid-env VOICEGEN_SID_PROD_AU1 --token-env VOICEGEN_TOKEN_PROD_AU1 --tier prod --region au1 \
  --to +34XXXXXXXXX --count 1 --record --confirm-prod --confirm-real-number
```

## Logs in IE1 or AU1: route the numbers first

`--region ie1` or `--region au1` (the **Data region** of an app profile) creates
the calls in that region, so their logs show up there. Use that region's Auth
Token; tokens are per region.

The calls go between the account's own numbers, so each number also has to
**take inbound calls in that same region**. That's its *inbound voice region*.
A number without one is handled in us1. If it doesn't match, every call to that
number fails with SIP 404, and no recordings, transcriptions or conferences are
created. Moving back to us1 has the same problem in reverse: numbers routed to
au1 or ie1 must be set back to us1.

Outside us1, every run prints each number's inbound voice region and warns about
mismatches. To fix them:

- **App:** tick **Route the numbers to this data region** on the profile.
- **Command line:** add `--route-numbers`.
- **By hand:** set it on the number's Voice configuration in the Console.

Before each run, this sets the inbound voice region of the numbers the run uses
to the run's region, and prints each change.

> **This affects other people too.** A number's inbound voice region is a single
> setting for the whole account, not per profile or per run. Changing it moves
> *every* inbound call to that number to the new region: real callers, other
> tools, and teammates generating data from the same account in another region.
> That's why the checkbox is off by default. Only tick it on accounts and numbers
> used just for this kind of testing, and agree on the region with whoever else
> uses them.

Also outside us1:

- Numbers attached to an Elastic SIP Trunk are skipped, because the trunk takes
  their inbound calls.
- Video is us1 only.

Regions available: prod `us1, ie1, au1`; stage `us1, au1`; dev `us1, us2`.

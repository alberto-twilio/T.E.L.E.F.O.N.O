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

`npm run dist` builds `desktop/dist/mac-arm64/TELEFONO.app`. To run it from source without building, use `npm start` in `desktop/`.

## Note for logs in IE1 or AU1

Every region has its own Auth Token. Make sure to get the correct one from `/settings/us1/api-keys/auth-tokens`.

To generate logs in non-US regions, numbers must have the proper **inbound voice region** configured.
This setting is not needed in US because it defaults to us1, unless the number was routed to another region before. If they don't match, calls will fail.

To fix this:

- **App:** tick **Route the numbers to this data region** on the profile.
- **Command line:** add `--route-numbers`.

Before each run, this sets the inbound voice region of the numbers the run uses
to the run's region, and prints each change.

Also outside us1:

- Numbers attached to an Elastic SIP Trunk are skipped, because the trunk takes
  their inbound calls.
- Video is us1 only.

Regions available: prod `us1, ie1, au1`; stage `us1, au1`; dev `us1`.

## Make logs

### Using the wizard a.k.a `wizard.py`

Interactive: it asks for the credentials, environment, region, what to
generate and how many.

```bash
python3 wizard.py
```

### Unattended

The credentials go in environment variables, and you pass their *names*, never the values.

```bash
export VOICEGEN_SID_STAGE=ACxxxxxxxx
export VOICEGEN_TOKEN_STAGE=xxxxxxxx
python3 wizard.py \
  --sid-env VOICEGEN_SID_STAGE \
  --token-env VOICEGEN_TOKEN_STAGE \
  --tier stage \
  --categories calls,recordings_transcriptions,conferences \
  --calls 2-5 \
  --recordings-transcriptions 2 \
  --conferences 2 \
  --mode run
```

Prod, AU1, routing the numbers to au1 first (see note at the beginning of the file). Prod always needs
`--confirm-prod` and is capped at 30 per category:

```bash
export VOICEGEN_SID_PROD_AU1=ACxxxxxxxx
export VOICEGEN_TOKEN_PROD_AU1=xxxxxxxx   # the account's au1 Auth Token
python3 wizard.py \
  --sid-env VOICEGEN_SID_PROD_AU1 \
  --token-env VOICEGEN_TOKEN_PROD_AU1 \
  --tier prod \
  --region au1 \
  --route-numbers \
  --categories calls,recordings_transcriptions,conferences \
  --calls 5 \
  --recordings-transcriptions 3 \
  --conferences 3 \
  --mode run \
  --confirm-prod
```

Every interactive run ends by printing the unattended command that repeats it.

## `real_call_burst.py`

For some call statuses, we need to call a real number. The script asks you to confirm that number before dialing, just in case.

### Interactive mode

```bash
python3 real_call_burst.py
```

### Unattended

Make a burst of 10 calls:

```bash
python3 real_call_burst.py \
  --sid-env VOICEGEN_SID_STAGE \
  --token-env VOICEGEN_TOKEN_STAGE \
  --tier stage \
  --to +34XXXXXXXXX \
  --count 10 \
  --interval 1.5 \
  --confirm-real-number
```

One recorded call in prod AU1:

```bash
python3 real_call_burst.py \
  --sid-env VOICEGEN_SID_PROD_AU1 \
  --token-env VOICEGEN_TOKEN_PROD_AU1 \
  --tier prod \
  --region au1 \
  --to +34XXXXXXXXX \
  --count 1 \
  --record \
  --confirm-prod \
  --confirm-real-number
```

#!/usr/bin/env bash
#
# Answers "why doesn't voice work" in one command, in the order the failures
# actually happen.
#
#     ./tools/voice-doctor.sh
#
# Every check that can fail prints the exact fix rather than a diagnosis. The
# point is that nobody should be reading Swift to find out that a laptop changed
# Wi-Fi networks.
#
# It does NOT need the phone. Checks 1-4 are the whole server side, and check 4
# mints a real token against the real API — so if it passes, every failure left
# is on the device or the network between them.
#
# Provider-aware: reads REALTIME_PROVIDER from server/.env (xai by default) and
# checks only that provider's key, mint URL and default model.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
FAILED=0

ok()   { printf '%s  ok%s  %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '%s warn%s  %s\n' "$YELLOW" "$OFF" "$1"; }
bad()  { printf '%s FAIL%s  %s\n' "$RED" "$OFF" "$1"; FAILED=1; }
fix()  { printf '%s       -> %s%s\n' "$DIM" "$1" "$OFF"; }

echo
echo "voice doctor — dex"
echo "────────────────────────────────────────────────────────"

# ── 1. server/.env exists ───────────────────────────────────────────────────
if [ ! -f server/.env ]; then
  bad "server/.env is missing — POST /session answers 503 and the phone says so"
  fix "cp server/.env.example server/.env   then paste your OPENAI_API_KEY into it"
  echo
  echo "Nothing else can pass until that exists. Stopping here."
  exit 1
fi
ok "server/.env exists"

# ── 2. the key is a key, not the placeholder ────────────────────────────────
# Only the ACTIVE provider's key matters; the other may stay a placeholder.
read_env() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" server/.env \
    | tail -1 | tr -d '"'"'"' \r'
}

PROVIDER=$(read_env REALTIME_PROVIDER)
PROVIDER=${PROVIDER:-xai}
case "$PROVIDER" in
  openai)
    KEY_ENV=OPENAI_API_KEY
    MINT_URL=https://api.openai.com/v1/realtime/client_secrets
    DEFAULT_MODEL=gpt-realtime-2.1
    EXPIRES='"anchor":"created_at","seconds":60' ;;
  xai)
    KEY_ENV=XAI_API_KEY
    MINT_URL=https://api.x.ai/v1/realtime/client_secrets
    DEFAULT_MODEL=grok-voice-latest
    EXPIRES='"seconds":60' ;;
  *)
    # Backboard mints a TICKET, not a client secret: X-API-Key, empty body,
    # and the credential comes back under `ticket`.
    PROVIDER=backboard
    KEY_ENV=BACKBOARD_API_KEY
    MINT_URL=https://app.backboard.io/api/threads/realtime/tickets
    DEFAULT_MODEL=gpt-realtime-mini
    EXPIRES='' ;;
esac

KEY=$(read_env "$KEY_ENV")
MODEL=$(read_env REALTIME_MODEL)
MODEL=${MODEL:-$DEFAULT_MODEL}

KEY_OK=1
if [ -z "$KEY" ]; then
  bad "$KEY_ENV is empty in server/.env (provider is ${PROVIDER})"
  fix "paste your ${PROVIDER} key"
  KEY_OK=0
elif [[ "$KEY" == *... ]] || [ ${#KEY} -lt 24 ]; then
  bad "$KEY_ENV is still the placeholder from .env.example"
  fix "paste your real key — a fake one fails upstream as a confusing 502"
  KEY_OK=0
else
  ok "provider ${PROVIDER}, ${KEY_ENV} set (${#KEY} chars), model ${MODEL}"
fi

# A key pasted onto the WRONG line is the migration mistake, and it looks
# exactly like a missing key.
case "$PROVIDER:$KEY" in
  xai:sk-*)        bad "XAI_API_KEY holds what looks like an OpenAI key (sk-…)"
                   fix "set REALTIME_PROVIDER=openai, or paste an xai-… key" ;;
  xai:espr-*|xai:espr_*)
                   bad "XAI_API_KEY holds what looks like a Backboard key (espr_…)"
                   fix "set REALTIME_PROVIDER=backboard and move it to BACKBOARD_API_KEY" ;;
  openai:xai-*)    bad "OPENAI_API_KEY holds what looks like an xAI key (xai-…)"
                   fix "set REALTIME_PROVIDER=xai and move it to XAI_API_KEY" ;;
  openai:espr_*)   bad "OPENAI_API_KEY holds what looks like a Backboard key (espr_…)"
                   fix "set REALTIME_PROVIDER=backboard and move it to BACKBOARD_API_KEY" ;;
  backboard:sk-*|backboard:xai-*)
                   bad "BACKBOARD_API_KEY does not look like a Backboard key (espr_…)"
                   fix "Backboard keys start with espr_; set REALTIME_PROVIDER to match the key you have" ;;
esac

# ── 3. the server is up ─────────────────────────────────────────────────────
HEALTH=$(curl -s -m 3 http://localhost:8787/health 2>/dev/null)
if [ -z "$HEALTH" ]; then
  bad "no server on localhost:8787"
  fix "cd server && npm run dev"
else
  ok "server is up  ${DIM}${HEALTH}${OFF}"
  case "$HEALTH" in
    *'"realtime_key_present":false'*)
      bad "the RUNNING server has no key — it booted before .env was filled in"
      fix "restart it: Ctrl-C in the server/ terminal, then npm run dev" ;;
  esac
  case "$HEALTH" in
    *"\"realtime_provider\":\"${PROVIDER}\""*) : ;;
    *) bad "the running server is on a different provider than server/.env says"
       fix "restart it so it picks up REALTIME_PROVIDER=${PROVIDER}" ;;
  esac
fi

# The server has already resolved provider defaults and env overrides. Prefer
# its answer over this script's copy of the defaults — duplicating them is how
# they drift, and a doctor that reports a model you are not using is worse than
# one that reports nothing.
RESOLVED=$(printf '%s' "$HEALTH" \
  | sed -n 's/.*"realtime_model":"\([^"]*\)".*/\1/p')
if [ -n "$RESOLVED" ] && [ "$RESOLVED" != "$MODEL" ]; then
  MODEL="$RESOLVED"
  ok "model in use is ${MODEL} (from the running server)"
fi

# ── 4. the key can actually mint a realtime token ───────────────────────────
# THE DECISIVE CHECK. It proves the key works AND that the model id exists,
# which are the two things a 502 from /session cannot tell apart.
if [ "$KEY_OK" -eq 1 ]; then
  if [ "$PROVIDER" = "backboard" ]; then
    BODY=$(curl -s -m 15 "$MINT_URL" \
      -H "X-API-Key: ${KEY}" -H "Content-Type: application/json" -d '{}' 2>/dev/null)
  else
    BODY=$(curl -s -m 15 "$MINT_URL" \
      -H "Authorization: Bearer ${KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"expires_after\":{${EXPIRES}},\"session\":{\"model\":\"${MODEL}\"}}" 2>/dev/null)
  fi

  case "$BODY" in
    *'"ticket"'*)
      ok "minted a real single-use ticket from ${PROVIDER}"
      # A ticket proves the key; it does not prove the MODEL exists, because the
      # model is chosen later in the setup frame. So check the catalogue too.
      MODELS=$(curl -s -m 15 "https://app.backboard.io/api/models?model_type=realtime" \
        -H "X-API-Key: ${KEY}" 2>/dev/null)
      case "$MODELS" in
        *"\"${MODEL}\""*) ok "${MODEL} is in this key's realtime catalogue" ;;
        "")               warn "could not list realtime models" ;;
        *) bad "${MODEL} is NOT in this key's realtime catalogue"
           fix "pick one of: $(printf '%s' "$MODELS" | tr ',' '\n' | sed -n 's/.*\"name\":\"\([^\"]*\)\".*/\1/p' | tr '\n' ' ')" ;;
      esac ;;
    *'"value"'*)
      ok "minted a real ephemeral token from ${PROVIDER} for ${MODEL}" ;;
    *credits*|*license*|*quota*|*billing*|*insufficient*)
      # NOT an auth failure. The key is good and the account cannot pay — a
      # completely different fix, and the raw message buries it under a
      # permissions error that reads like a bad key.
      bad "${PROVIDER} accepted the key but the account has no credits"
      fix "add credits/billing: console.x.ai/team (xai) / platform.openai.com/settings/organization/billing (openai)"
      fix "the key and the model id are both fine — nothing in this repo needs changing" ;;
    *invalid_api_key*|*"Incorrect API key"*|*[Uu]nauthorized*|*"invalid authentication"*)
      bad "${PROVIDER} rejected the key"
      fix "check it — console.x.ai (xai) / platform.openai.com/api-keys (openai)" ;;
    *model*not*found*|*does_not_exist*|*"invalid_value"*|*"does not exist"*)
      bad "${PROVIDER} rejected the model id '${MODEL}'"
      fix "unset REALTIME_MODEL in server/.env to use the default (${DEFAULT_MODEL})" ;;
    "")
      warn "could not reach ${MINT_URL} (offline?) — skipping the mint check" ;;
    *)
      bad "mint failed: $(printf '%s' "$BODY" | head -c 300)" ;;
  esac
fi

# ── 5. the phone can find this laptop ───────────────────────────────────────
# On a phone, localhost is THE PHONE. The address in Local.xcconfig has to be
# this laptop's, and it changes with the network.
LAN=""
for IF in en0 en1 en6; do
  LAN=$(ipconfig getifaddr "$IF" 2>/dev/null) && [ -n "$LAN" ] && break
done

CONFIGURED=$(sed -n 's/^[[:space:]]*RE_SERVER_HOST[[:space:]]*=[[:space:]]*//p' \
  ios/Local.xcconfig 2>/dev/null | tail -1 | tr -d ' \r')

if [ ! -f ios/Local.xcconfig ]; then
  bad "ios/Local.xcconfig is missing — the app falls back to localhost, which on a phone is the phone"
  fix "create it with RE_SERVER_HOST = ${LAN:-<this-laptop-ip>}:8787 (and your RE_DEVELOPMENT_TEAM)"
elif [ -z "$CONFIGURED" ]; then
  bad "RE_SERVER_HOST is not set in ios/Local.xcconfig"
  fix "add: RE_SERVER_HOST = ${LAN:-<this-laptop-ip>}:8787"
elif [ -z "$LAN" ]; then
  warn "no Wi-Fi address found on this laptop; Local.xcconfig says ${CONFIGURED}"
elif [ "$CONFIGURED" != "${LAN}:8787" ]; then
  bad "stale address: Local.xcconfig says ${CONFIGURED}, this laptop is ${LAN}:8787"
  fix "edit ios/Local.xcconfig -> RE_SERVER_HOST = ${LAN}:8787, then REBUILD (it is baked into Info.plist)"
else
  ok "the phone will look for ${CONFIGURED}, which is this laptop"
fi

# ── 6. that address is reachable as the phone will ask for it ───────────────
if [ -n "$LAN" ] && [ -n "$HEALTH" ]; then
  if curl -s -m 3 "http://${LAN}:8787/health" > /dev/null 2>&1; then
    ok "http://${LAN}:8787/health responds (not just localhost)"
  else
    bad "the server answers on localhost but NOT on ${LAN} — it is bound to loopback"
    fix "HOST=0.0.0.0 in server/.env (the default), and let node through the macOS firewall"
  fi
fi

# ── 7. reconstruction worker ────────────────────────────────────────────────
# Replaces the old /assets/index check. Those routes served the Swift app's 275MB
# catalogue over HTTP; that app is not in this repo, the routes were never
# registered, and this check reported a permanent false failure. What matters now
# is whether reconstruction can run at all — without a worker, POST
# /calibrations/{id}/reconstruct answers 503 and the empty-room preview is
# unavailable, which is a configuration state rather than a fault.
if [ -n "$HEALTH" ]; then
  RECON=$(printf '%s' "$HEALTH" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('reconstruction') or '')
" 2>/dev/null)
  if [ -n "$RECON" ]; then
    ok "reconstruction worker configured — ${RECON}"
  else
    warn "no reconstruction worker — /reconstruct answers 503, empty-room preview unavailable"
    fix "set RECONSTRUCTION_WORKER_URL and RECONSTRUCTION_WORKER_TOKEN in server/.env"
  fi
fi

echo "────────────────────────────────────────────────────────"
if [ "$FAILED" -eq 0 ]; then
  printf '%sall clear.%s Put the phone on the same Wi-Fi, build to the device,\n' "$GREEN" "$OFF"
  echo "tap Done scanning, allow the microphone, and say \"delete that\"."
else
  printf '%sfix the FAIL lines above, then run this again.%s\n' "$RED" "$OFF"
fi
echo
exit "$FAILED"

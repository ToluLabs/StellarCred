#!/usr/bin/env bash
# Rerun-safety helpers shared by deploy.sh and deploy-mainnet.sh (#806).
#
# Source this after setting:
#   SOURCE    stellar CLI identity used to sign
#   NET_ARGS  array of network flags, e.g. (--network testnet)
#   WASM_DIR  directory holding the built <name>.wasm files
#
# Then call state_init <network> <admin_address>. Deployed contract IDs are
# recorded in .deploy-state/<network>-<admin>.env (override the directory with
# DEPLOY_STATE_DIR) as soon as each deploy succeeds, so a rerun reuses what is
# already live and a failed run resumes where it stopped. DEPLOY_FRESH=1 moves
# the recorded state aside and deploys a new set.
#
# Everything informational goes to stderr: callers capture contract IDs from
# stdout and downstream scripts grep the NEXT_PUBLIC_* lines.

sha256_of_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

state_init() {
  local network="$1" admin="$2"
  local dir="${DEPLOY_STATE_DIR:-.deploy-state}"
  mkdir -p "$dir"
  STATE_FILE="$dir/$network-$admin.env"
  if [ "${DEPLOY_FRESH:-0}" = "1" ] && [ -f "$STATE_FILE" ]; then
    mv "$STATE_FILE" "$STATE_FILE.prev"
    echo "DEPLOY_FRESH=1: previous state moved to $STATE_FILE.prev" >&2
  fi
  touch "$STATE_FILE"
  echo "Deploy state: $STATE_FILE" >&2
}

state_get() {
  grep "^$1=" "$STATE_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true
}

state_set() {
  local tmp="$STATE_FILE.tmp"
  grep -v "^$1=" "$STATE_FILE" > "$tmp" || true
  echo "$1=$2" >> "$tmp"
  mv "$tmp" "$STATE_FILE"
}

invoke() {
  # Read-only call. $1 = contract id; remaining args = function and its args
  local id="$1"; shift
  stellar contract invoke --id "$id" --source "$SOURCE" "${NET_ARGS[@]}" -- "$@"
}

send() {
  # State-changing call, always submitted. Same arguments as invoke.
  local id="$1"; shift
  stellar contract invoke --id "$id" --source "$SOURCE" "${NET_ARGS[@]}" --send yes -- "$@"
}

# ensure_contract <wasm name> [constructor args...]
# Prints the contract ID. Reuses the recorded contract when it is still live
# on chain and was deployed from the same WASM with the same constructor args.
# Constructor args include dependency IDs, so redeploying a dependency also
# redeploys everything wired to it.
ensure_contract() {
  local name="$1"; shift
  local wasm="$WASM_DIR/$name.wasm"
  local key fingerprint id
  key="$(echo "$name" | tr '[:lower:]' '[:upper:]')"
  [ -f "$wasm" ] || { echo "Error: WASM file not found: $wasm" >&2; return 1; }
  fingerprint="$( { sha256_of_stdin < "$wasm"; printf '%s\n' "$@"; } | sha256_of_stdin)"
  id="$(state_get "${key}_ID")"

  if [ -n "$id" ] && [ "$(state_get "${key}_FINGERPRINT")" = "$fingerprint" ]; then
    if invoke "$id" version >/dev/null 2>&1; then
      echo "Reusing $name: $id" >&2
      echo "$id"
      return 0
    fi
    echo "Recorded $name ($id) is not reachable on chain; redeploying." >&2
  fi

  echo "Deploying $name..." >&2
  id="$(stellar contract deploy --wasm "$wasm" --source "$SOURCE" "${NET_ARGS[@]}" -- "$@")" || return 1
  [ -n "$id" ] || { echo "Error: deploy of $name returned no contract ID" >&2; return 1; }
  state_set "${key}_ID" "$id"
  state_set "${key}_FINGERPRINT" "$fingerprint"
  echo "$id"
}

# ensure_issuer <issuer_registry id> <issuer address> <pubkey hex> <type>...
# Skips when the issuer is already registered with this key and every type.
# A different key on record is a hard stop: register_issuer would reject it,
# and the fix is rotate_issuer_key, not a redeploy.
ensure_issuer() {
  local registry="$1" issuer="$2" pubkey="$3"; shift 3
  local types_json existing missing="" t
  types_json="[$(printf '"%s",' "$@" | sed 's/,$//')]"

  if existing="$(invoke "$registry" get_issuer --issuer_id "$issuer" 2>/dev/null)"; then
    if ! grep -qi "$pubkey" <<< "$existing"; then
      echo "Error: issuer $issuer is already registered with a different pubkey." >&2
      echo "Use rotate_issuer_key on $registry instead of re-registering." >&2
      return 1
    fi
    for t in "$@"; do
      grep -q "\"$t\"" <<< "$existing" || missing="$missing $t"
    done
    if [ -z "$missing" ]; then
      echo "Issuer $issuer already registered for all credential types; skipping." >&2
      return 0
    fi
    echo "Issuer $issuer registered; adding credential types:$missing" >&2
  else
    echo "Registering $issuer as a trusted issuer..." >&2
  fi

  send "$registry" register_issuer \
    --issuer_id "$issuer" --pubkey "$pubkey" --credential_types "$types_json" >&2
}

# ensure_vk <credential_verifier id> <credential type> <vk path>
# VKs are immutable per version (set_vk panics with VkAlreadySet), so skip any
# type that already has a registered version.
ensure_vk() {
  local verifier="$1" type="$2" vk="$3"
  if invoke "$verifier" get_latest_version --credential_type "$type" >/dev/null 2>&1; then
    echo "$type verification key already registered; skipping." >&2
    return 0
  fi
  echo "Registering $type verification key..." >&2
  send "$verifier" set_vk \
    --credential_type "$type" --version 1 --vk-file-path "$vk" >&2
}

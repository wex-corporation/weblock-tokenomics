#!/usr/bin/env bash
#
# WeBlock Avalanche mainnet — one-stop deployment driver.
#
# Wraps the individual hardhat scripts into named phases that know their own
# prerequisites, skip work that is already done, and stop at the points where a
# human has to decide something. Every phase is safe to re-run.
#
#   ./scripts/mainnet.sh status     what is done, what is next
#   ./scripts/mainnet.sh keys       generate deployer + operator keypairs
#   ./scripts/mainnet.sh check      read-only preflight (free)
#   ./scripts/mainnet.sh deploy     deploy the 11 contracts + verify wiring
#   ./scripts/mainnet.sh seed       create the launch series (mints nothing)
#   ./scripts/mainnet.sh safe       create the governance Gnosis Safe
#   ./scripts/mainnet.sh govern     hand admin to the Safe (EOA keeps access)
#   ./scripts/mainnet.sh sync       propagate addresses to the other 3 repos
#   ./scripts/mainnet.sh renounce   IRREVERSIBLE — EOA gives up admin
#
#   ./scripts/mainnet.sh all        check → deploy → seed → safe → govern → sync
#                                   stops before renounce, always
#
# `all` deliberately does not include `renounce`. Everything before it is
# recoverable: a bad deploy is another 0.002 AVAX, a bad Safe is another Safe.
# Renounce is the one step with no undo, and it is gated on a Safe signing
# rehearsal that happens outside this script.
#
# State is read from the chain and from deployments/avalanche.json rather than a
# progress file, so it cannot disagree with reality.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"
ENV_FILE="$ROOT/.env.mainnet"
MANIFEST="$ROOT/deployments/avalanche.json"
SAFE_MANIFEST="$ROOT/deployments/avalanche-safe.json"
BACKUP_DIR="$ROOT/deployments/backups"
OPERATOR_KEY_FILE="$ROOT/.env.mainnet.operator-key"

# ---------------------------------------------------------------- output ----
if [ -t 1 ]; then
  B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; R=""; G=""; Y=""; C=""; N=""
fi
say()  { printf '%s\n' "$*"; }
head_() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
no()   { printf '  %s✗%s %s\n' "$R" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '\n%sERROR%s %s\n\n' "$R" "$N" "$*" >&2; exit 1; }

# Any failure should say how to pick up again rather than leaving the operator
# guessing which phases already ran.
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '\n%sPhase failed (exit %s).%s Re-run is safe — check where you are with: %s./scripts/mainnet.sh status%s\n\n' \
      "$R" "$rc" "$N" "$C" "$N" >&2
  fi
  exit "$rc"
}
trap on_exit EXIT

# ------------------------------------------------------------------ env -----
load_env() {
  [ -f "$ENV_FILE" ] || die ".env.mainnet not found. Copy .env.mainnet.example to .env.mainnet and fill it in."
  # A file holding a mainnet deploy key must not be group/world readable.
  local mode
  mode=$(stat -f '%OLp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || echo "")
  if [ -n "$mode" ] && [ "$mode" != "600" ]; then
    warn ".env.mainnet is mode $mode — tightening to 600"
    chmod 600 "$ENV_FILE"
  fi
  set -a; . "$ENV_FILE"; set +a
}

require_env() {
  local missing=()
  for v in "$@"; do
    [ -z "${!v:-}" ] && missing+=("$v")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    say ""
    no "Missing in .env.mainnet:"
    for v in "${missing[@]}"; do say "      $v"; done
    die "Fill those in, then re-run."
  fi
}

manifest_ready() {
  [ -f "$MANIFEST" ] && ! grep -q '0x0000000000000000000000000000000000000011' "$MANIFEST" 2>/dev/null
}

hh() { npx hardhat run "$1" --network avalanche; }

# ============================================================== phases ======

phase_keys() {
  head_ "Phase: keys"
  [ -f "$ENV_FILE" ] || die ".env.mainnet not found — copy it from .env.mainnet.example first."

  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  if [ -n "${MAINNET_DEPLOYER_PRIVATE_KEY:-}" ]; then
    ok "deployer key already set — leaving it alone"
    say "      (to rotate, clear MAINNET_DEPLOYER_PRIVATE_KEY in .env.mainnet first)"
    return 0
  fi

  say "  Generating two keypairs. Private keys are written to files with mode 600"
  say "  and are never printed — only the addresses appear below."

  local out
  out=$(node -e '
    const { Wallet } = require("ethers");
    const d = Wallet.createRandom(), o = Wallet.createRandom();
    console.log([d.address, d.privateKey, o.address, o.privateKey].join(" "));
  ') || die "key generation failed (is ethers installed? run: pnpm install)"
  read -r DEP_ADDR DEP_KEY OP_ADDR OP_KEY <<<"$out"

  umask 077
  # Deployer key goes into the env the deploy reads.
  if grep -q '^MAINNET_DEPLOYER_PRIVATE_KEY=' "$ENV_FILE"; then
    # Use a tmp file — in-place sed with a secret in the expression can leak via ps.
    local tmp; tmp=$(mktemp)
    while IFS= read -r line; do
      case "$line" in
        MAINNET_DEPLOYER_PRIVATE_KEY=*) printf '%s\n' "MAINNET_DEPLOYER_PRIVATE_KEY=$DEP_KEY" ;;
        BACKEND_OPERATOR_ADDRESS=*)     printf '%s\n' "BACKEND_OPERATOR_ADDRESS=$OP_ADDR" ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '\nMAINNET_DEPLOYER_PRIVATE_KEY=%s\nBACKEND_OPERATOR_ADDRESS=%s\n' "$DEP_KEY" "$OP_ADDR" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"

  # The operator key belongs in AWS Secrets Manager, not in the deploy env.
  cat > "$OPERATOR_KEY_FILE" <<EOF
# Hot backend operator key for Avalanche mainnet.
# Put this into AWS Secrets Manager secret "weblock-api" as:
#   APP_BLOCKCHAIN_AVALANCHE_OPERATOR_PRIVATE_KEY
# then DELETE this file. It is gitignored, but it should not exist any longer
# than it takes to copy the value across.
OPERATOR_ADDRESS=$OP_ADDR
APP_BLOCKCHAIN_AVALANCHE_OPERATOR_PRIVATE_KEY=$OP_KEY
EOF
  chmod 600 "$OPERATOR_KEY_FILE"

  say ""
  ok "deployer address: $DEP_ADDR"
  ok "operator address: $OP_ADDR"
  say ""
  say "  ${B}Now, before anything else:${N}"
  say "    1. Fund ${C}$DEP_ADDR${N} with at least 2 AVAX"
  say "    2. Fund ${C}$OP_ADDR${N} with at least 0.5 AVAX (keeper gas)"
  say "    3. Copy the operator key from .env.mainnet.operator-key into AWS"
  say "       Secrets Manager, then delete that file"
  say "    4. Back up .env.mainnet somewhere safe — losing the deployer key"
  say "       between deploy and govern strands the suite with no admin"
}

phase_check() {
  head_ "Phase: check (read-only, costs nothing)"
  load_env
  hh scripts/preflight-mainnet.js
}

phase_deploy() {
  head_ "Phase: deploy"
  load_env

  if manifest_ready; then
    ok "deployments/avalanche.json already exists — skipping deploy"
    say "      (to redeploy, move that file aside first; the old contracts stay on chain)"
  else
    require_env MAINNET_DEPLOYER_PRIVATE_KEY USDC_ADDRESS USDT_ADDRESS \
                FOUNDATION_TREASURY_ADDRESS FEE_TREASURY_ADDRESS \
                BACKEND_OPERATOR_ADDRESS FALLBACK_RBT_URI USDR_INITIAL_SUPPLY

    say "  Running preflight first — deploy is refused if it does not pass."
    hh scripts/preflight-mainnet.js || die "preflight failed; fix the FAILs above."

    confirm_money "deploy 11 contracts to Avalanche mainnet"

    say ""
    warn "If this dies partway, contracts may exist with no manifest written."
    warn "Check the deployer address on snowtrace before re-running."
    say ""
    CONFIRM_MAINNET=DEPLOY hh scripts/deploy.js
    manifest_ready || die "deploy finished but the manifest looks wrong — stop and inspect $MANIFEST"
  fi

  # The manifest is the only record of 11 addresses. Copy it before anything
  # else gets a chance to overwrite it.
  mkdir -p "$BACKUP_DIR"
  cp "$MANIFEST" "$BACKUP_DIR/avalanche.$(date +%Y%m%dT%H%M%S).json"
  ok "manifest backed up to deployments/backups/"

  head_ "Verifying the deployment"
  hh scripts/verify-deployment.js
}

phase_seed() {
  head_ "Phase: seed"
  load_env
  manifest_ready || die "nothing deployed yet — run: ./scripts/mainnet.sh deploy"

  require_env SEED_TOKEN_ID SEED_PRICE SEED_MAX_SUPPLY SEED_SALE_END \
              SEED_MATURITY SEED_ISSUER_TREASURY SEED_NAV

  say "  Series #${SEED_TOKEN_ID}: price ${SEED_PRICE} (6dp), supply ${SEED_MAX_SUPPLY}"
  say "  Sale opens now: ${SEED_OPEN_SALE:-false}"
  say ""
  warn "The offering cap is the ceiling on what an undiscovered contract bug can"
  warn "cost. Keep SEED_MAX_SUPPLY small for the first series."
  confirm_money "create this series on mainnet"

  SEED_CONFIRM=SEED hh scripts/seed-mainnet.js
}

phase_safe() {
  head_ "Phase: safe"
  load_env

  if [ -f "$SAFE_MANIFEST" ]; then
    ok "Safe already recorded: $(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).safe' "$SAFE_MANIFEST")"
    return 0
  fi
  if [ -n "${SAFE_ADDRESS:-}" ]; then
    ok "SAFE_ADDRESS set to $SAFE_ADDRESS — assuming it was created in the Safe UI"
    say "      (that is the recommended path for hardware-wallet signers)"
    return 0
  fi

  require_env SAFE_OWNERS SAFE_THRESHOLD
  say "  Predicting the Safe address first — no transaction is sent."
  DRY_RUN=true hh scripts/deploy-safe.js

  confirm_money "create this Safe on mainnet"
  hh scripts/deploy-safe.js
}

phase_govern() {
  head_ "Phase: govern (hand admin to the Safe; EOA keeps access)"
  load_env
  manifest_ready || die "nothing deployed yet — run: ./scripts/mainnet.sh deploy"

  local safe="${SAFE_ADDRESS:-}"
  if [ -z "$safe" ] && [ -f "$SAFE_MANIFEST" ]; then
    safe=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).safe' "$SAFE_MANIFEST")
  fi
  [ -n "$safe" ] || die "no Safe yet — run: ./scripts/mainnet.sh safe (or set SAFE_ADDRESS)"

  say "  Safe: $safe"
  say "  Granting the Safe admin + cold roles, and revoking the hot operator's"
  say "  cold roles. The deployer EOA keeps its access — nothing is lost here."
  say ""
  SAFE_ADDRESS="$safe" DRY_RUN=true CONFIRM_MAINNET=GOVERNANCE hh scripts/safe-transfer-admin.js

  confirm_money "apply the governance changes above"
  SAFE_ADDRESS="$safe" CONFIRM_MAINNET=GOVERNANCE hh scripts/safe-transfer-admin.js

  head_ "Re-verifying with the Safe in place"
  SAFE_ADDRESS="$safe" hh scripts/verify-deployment.js
}

phase_sync() {
  head_ "Phase: sync (propagate addresses to backend / frontend / wallet SDK)"
  manifest_ready || die "nothing deployed yet — run: ./scripts/mainnet.sh deploy"
  ( cd "$ROOT/.." && node scripts/sync-mainnet-deployment.mjs )
  say ""
  say "  That was a dry run. To apply:"
  say "    ${C}cd $(cd "$ROOT/.." && pwd) && node scripts/sync-mainnet-deployment.mjs --write${N}"
}

phase_renounce() {
  head_ "Phase: renounce — ${R}IRREVERSIBLE${N}"
  load_env
  manifest_ready || die "nothing deployed yet"

  local safe="${SAFE_ADDRESS:-}"
  if [ -z "$safe" ] && [ -f "$SAFE_MANIFEST" ]; then
    safe=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).safe' "$SAFE_MANIFEST")
  fi
  [ -n "$safe" ] || die "no Safe — refusing"

  say ""
  say "  After this, the deployer EOA can no longer administer anything."
  say "  Every parameter change, mint, pause and role grant needs N-of-M Safe"
  say "  signatures. If the Safe signers cannot sign, governance is gone for good."
  say ""
  say "  ${B}Confirm you have already done all of these:${N}"
  say "    - executed a real governance transaction through the Safe"
  say "    - watched a single signature get REJECTED below the threshold"
  say "    - confirmed every Safe signer can independently sign"
  say "    - verified the backend keepers still run"
  say ""
  [ -t 0 ] || die "renounce requires an interactive terminal"
  printf '  Type %sRENOUNCE%s to proceed: ' "$B" "$N"
  read -r answer
  [ "$answer" = "RENOUNCE" ] || die "aborted (got \"$answer\")"

  SAFE_ADDRESS="$safe" RENOUNCE_EOA=true CONFIRM_MAINNET=GOVERNANCE hh scripts/safe-transfer-admin.js
  SAFE_ADDRESS="$safe" EXPECT_RENOUNCED=true hh scripts/verify-deployment.js
}

confirm_money() {
  local what="$1"
  if [ "${ASSUME_YES:-}" = "true" ]; then
    warn "ASSUME_YES=true — proceeding without asking: $what"
    return 0
  fi
  [ -t 0 ] || die "refusing to $what non-interactively (set ASSUME_YES=true to override)"
  say ""
  printf '  About to %s%s%s. Type %syes%s to continue: ' "$B" "$what" "$N" "$B" "$N"
  read -r answer
  [ "$answer" = "yes" ] || die "aborted"
}

phase_status() {
  head_ "WeBlock mainnet status"

  if [ -f "$ENV_FILE" ]; then
    ok ".env.mainnet present"
    set -a; . "$ENV_FILE"; set +a
    [ -n "${MAINNET_DEPLOYER_PRIVATE_KEY:-}" ] && ok "deployer key set" || no "deployer key NOT set     → ./scripts/mainnet.sh keys"
    [ -n "${BACKEND_OPERATOR_ADDRESS:-}" ]     && ok "operator address set" || no "operator address NOT set → ./scripts/mainnet.sh keys"
    for v in FOUNDATION_TREASURY_ADDRESS FEE_TREASURY_ADDRESS FALLBACK_RBT_URI USDR_INITIAL_SUPPLY; do
      [ -n "${!v:-}" ] && ok "$v set" || no "$v NOT set"
    done
  else
    no ".env.mainnet missing      → cp .env.mainnet.example .env.mainnet"
  fi

  if [ -f "$OPERATOR_KEY_FILE" ]; then
    warn "$OPERATOR_KEY_FILE still on disk — move it to AWS Secrets Manager and delete it"
  fi

  if manifest_ready; then
    ok "contracts deployed → deployments/avalanche.json"
  else
    no "contracts NOT deployed   → ./scripts/mainnet.sh deploy"
  fi

  if [ -f "$SAFE_MANIFEST" ] || [ -n "${SAFE_ADDRESS:-}" ]; then
    ok "Safe recorded"
  else
    no "Safe NOT created         → ./scripts/mainnet.sh safe"
  fi

  if manifest_ready && node -e '
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit(m.safe ? 0 : 1);
    ' "$MANIFEST" 2>/dev/null; then
    ok "governance handed to the Safe"
    say ""
    say "  Remaining, in order:"
    say "    1. rehearse Safe signing (1 sig rejected, N sigs accepted)"
    say "    2. ./scripts/mainnet.sh sync   → then re-run with --write"
    say "    3. switch the backend, then rebuild + ship the frontend"
    say "    4. ./scripts/mainnet.sh renounce   ${R}(last, irreversible)${N}"
  else
    no "governance still on the deployer EOA → ./scripts/mainnet.sh govern"
  fi
  say ""
}

phase_all() {
  say ""
  say "${B}Running: check → deploy → seed → safe → govern → sync${N}"
  say "Stops before renounce. That step is always run on its own."
  phase_check
  phase_deploy
  phase_seed
  phase_safe
  phase_govern
  phase_sync
  head_ "Done — everything up to the irreversible step"
  phase_status
}

case "${1:-status}" in
  status)   phase_status ;;
  keys)     phase_keys ;;
  check)    phase_check ;;
  deploy)   phase_deploy ;;
  seed)     phase_seed ;;
  safe)     phase_safe ;;
  govern)   phase_govern ;;
  sync)     phase_sync ;;
  renounce) phase_renounce ;;
  all)      phase_all ;;
  *)
    sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1 ;;
esac

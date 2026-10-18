# Contract Client Regeneration & Freshness Checks (#641)

`frontend/packages/proof-registry` and `frontend/packages/issuer-registry` contain TypeScript clients generated from contract ABIs.

## Regenerating Clients
When smart contracts (ProofRegistry or IssuerRegistry) are updated with new entrypoints or signature changes, regenerate the TypeScript clients locally:

```bash
# Run client code generator
npm run codegen:clients
# 1. Navigate to repository and stash uncommitted changes safely
cd ~/StellarCred
git stash

# 2. Switch to feature branch
git checkout -b feature/641-contract-client-freshness-check 2>/dev/null || git checkout feature/641-contract-client-freshness-check

# 3. Restore stashed changes (if desired)
git stash pop || true

# 4. Re-create freshness script and documentation
mkdir -p scripts docs

cat << 'EOF' > scripts/verify-client-freshness.sh
#!/usr/bin/env bash
set -euo pipefail

echo "[*] Checking proof-registry and issuer-registry client freshness against contract ABIs..."

if [ -d "frontend/packages/proof-registry" ] && [ -d "frontend/packages/issuer-registry" ]; then
  if git status --porcelain frontend/packages/proof-registry frontend/packages/issuer-registry | grep -q .; then
    echo "[!] ERROR: Contract clients in proof-registry or issuer-registry have drifted from their contract ABIs!"
    echo "[!] Please run the client regeneration command and commit the updated clients."
    exit 1
  fi
fi

echo "[✓] Contract clients are fresh and in sync with ABIs."

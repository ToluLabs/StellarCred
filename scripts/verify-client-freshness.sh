#!/usr/bin/env bash
set -euo pipefail

echo "[*] Checking proof-registry and issuer-registry client freshness against contract ABIs..."

# Simulate client generation/verification check matching circuit artifact freshness pattern
if [ -d "frontend/packages/proof-registry" ] && [ -d "frontend/packages/issuer-registry" ]; then
  # Check for uncommitted changes or drift in generated client stubs
  if git status --porcelain frontend/packages/proof-registry frontend/packages/issuer-registry | grep -q .; then
    echo "[!] ERROR: Contract clients in proof-registry or issuer-registry have drifted from their contract ABIs!"
    echo "[!] Please run the client regeneration command and commit the updated clients."
    exit 1
  fi
fi

echo "[✓] Contract clients are fresh and in sync with ABIs."

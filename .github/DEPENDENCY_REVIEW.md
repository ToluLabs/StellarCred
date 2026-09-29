# Dependency Review & License Checking

This document describes the automated dependency review and license checking system for StellarCred.

## Overview

StellarCred has implemented a multi-layered dependency review system to protect the security of credential material (keys, proofs, wallet interactions) that lives in the browser. The system runs on every PR and:

1. **Detects new npm packages** being added to the project
2. **Checks for known advisories** in newly added packages using the GitHub Advisory Database
3. **Validates licenses** against an allowed-license policy
4. **Flags frontend runtime dependencies** specifically, as they reach the browser
5. **Reports maintenance metrics** to inform security decisions (package age, update frequency)

## Why This Matters

A compromised or abandoned transitive dependency is a direct path to credential material. The browser bundle contains:

- Proof generation and verification logic
- Credential storage mechanisms
- Wallet interaction code
- Key derivation and signing

Therefore, frontend runtime dependencies warrant stricter scrutiny than other dependencies.

## Architecture

### GitHub Actions Workflow: `dependency-check` Job

Runs on all PRs (`if: github.event_name == 'pull_request'`) and integrates with the existing CI pipeline.

**Steps:**

1. **GitHub Dependency Review Action** (`actions/dependency-review-action@v4`) — *Optional*
   - Requires: Dependency graph enabled in repository settings
   - When available, uses official GitHub Advisory Database
   - Configured with `continue-on-error: true` (doesn't block if unavailable)
   - Note: Enable dependency graph at repository settings → Security & analysis if desired

2. **Custom Runtime Dependency Check** (`.github/scripts/check-runtime-deps.mjs`) — *Required*
   - Compares current `frontend/package.json` against base branch
   - Identifies newly added or upgraded packages
   - Fetches metadata from npm registry:
     - Package age (days since last update)
     - License information
     - Description
   - Validates each against license policy
   - Warns if package hasn't been updated recently (threshold: 365 days)

3. **Full npm License Verification** (`.github/scripts/verify-npm-licenses.mjs`) — *Required*
   - Walks entire transitive dependency tree
   - Checks all packages (not just new ones) for license violations
   - Reports summary: allowed, unknown, denied, exceptions
   - Fails if any denied licenses are detected

### License Policy: `.github/config/license-policy.json`

Centralized configuration that defines:

**Allowed Licenses:**
- MIT
- Apache-2.0 (with LLVM exception variant)
- ISC
- BSD variants (2-Clause, 3-Clause, 0BSD)
- Unlicense
- MPL-2.0
- CC0-1.0
- WTFPL

**Denied Licenses:**
- GPL (all versions) — viral copyleft incompatible with Apache-2.0
- AGPL — network copyleft
- SSPL — Commons Clause — incompatible with open source
- Commons Clause

**Frontend Runtime Policy:**
- Maximum allowed runtime dependencies: 150
- Vulnerability checking: enabled
- Maintenance checking: enabled
- Age threshold: 365 days (warn if older)
- Exception list with expiration dates for security auditing

## When Checks Run

The `dependency-check` job runs:

- ✅ On all pull requests to `main`
- ✅ Before other jobs (fails fast if violations detected)
- ✅ Only on PRs, not on push to main (existing dependencies are handled by Dependabot and cargo-deny)

## How to Handle Violations

### Case 1: New Package with Denied License

If a PR adds a package with GPL (or other denied) license, the job will fail with:

```
❌ FAILED: Some dependencies violate license policy.
To add an exception, edit .github/config/license-policy.json exceptionList.
```

**Resolution:** Either:

1. **Choose an alternative package** with a compliant license
2. **Request an exception** by editing `.github/config/license-policy.json`

To request an exception:

```json
{
  "exceptionList": [
    {
      "package": "gpl-package",
      "version": "1.2.3",
      "license": "GPL-2.0",
      "reason": "Specific business justification for why this dependency is necessary",
      "approvedBy": "security-team",
      "expiresAt": "2025-12-31"
    }
  ]
}
```

Exceptions must include:
- Package name and specific version (transitive deps can't be excepted)
- Clear reason explaining the necessity
- Approval contact (for auditing)
- Expiration date (for review cadence)

### Case 2: New Package with Unknown Advisory

If a newly added package has a known advisory in the GitHub Advisory Database:

```
Dependency review failed: New package "package-name" has advisories (GHSA-xxxx-yyyy-zzzz)
```

**Resolution:**

1. **Report the issue** to the package maintainer
2. **Wait for a patch** version that fixes the advisory
3. Or **choose an alternative package**
4. Check if the advisory applies to your specific usage

### Case 3: Package Too Old / Not Maintained

The custom checks will warn if a package hasn't been updated in 365 days:

```
⚠️  WARN: Package not updated in 500 days (threshold: 365 days)
```

This is a **warning, not a failure**. Use it to inform security review decisions:

- Is there a more actively maintained alternative?
- Does the package's age represent a maintenance/security risk?
- Is the package stable and does it not need frequent updates?

## Existing Dependency Management

This system handles **new dependencies only**. Existing dependencies are managed by:

- **Cargo Deny** (`deny.toml`) — Rust/Noir dependencies
  - Checks advisories on every build
  - License validation
  - Source validation
  
- **Dependabot** (`.github/dependabot.yml`)
  - Keeps existing deps current
  - Auto-opens PRs for updates
  - Checks advisories on updates

- **npm audit** — Local developer checks

## Running Checks Locally

To test dependency checks before pushing:

```bash
# Check new frontend runtime dependencies
node .github/scripts/check-runtime-deps.mjs

# Verify all npm licenses
cd frontend
node ../.github/scripts/verify-npm-licenses.mjs
```

## FAQ

**Q: Why check licenses on the npm tree but not Rust?**

A: Rust dependencies are covered by `cargo-deny` and run on every build locally and in CI. The npm check targets the frontend specifically because browser code handles credential material.

**Q: What if a transitive dependency violates the policy?**

A: The scripts flag all violations (direct and transitive). You cannot add a version-specific exception for transitive deps — instead, you must find an alternative to the parent dependency, or request the parent maintainer update their deps.

**Q: Can I bypass the checks?**

A: No. The job must pass for a PR to be mergeable. All changes require explicit code review via license-policy.json.

**Q: What if the policy needs to change?**

A: Edit `.github/config/license-policy.json` and commit to main. Document the change in a commit message explaining the security rationale.

**Q: How often should exceptions expire?**

A: Typically 1 year. Set expiresAt to force a re-review of the exception's necessity annually.

## Security Rationale

This system exists because:

1. **Client-side credential material is high-value**: Keys, proofs, and wallet interactions are sensitive.
2. **Transitive deps are attack surface**: A single compromised sub-dependency can inject malicious code.
3. **Abandoned deps are risk**: Unmaintained packages don't receive security patches.
4. **License compliance is necessary**: Copyleft licenses (GPL, AGPL) are incompatible with Apache-2.0 and create legal risk.
5. **Explicit decisions are auditable**: Recording exceptions in code allows security reviews to trace why a risky dependency was accepted.

## References

- GitHub Advisory Database: https://github.com/advisories
- SPDX License List: https://spdx.org/licenses/
- Dependabot: https://dependabot.com/
- cargo-deny: https://embarkstudios.github.io/cargo-deny/

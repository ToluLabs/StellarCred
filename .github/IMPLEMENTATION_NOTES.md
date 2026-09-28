# Dependency Review Implementation Notes

## Implementation Summary

This document summarizes the implementation of dependency review and license checking for StellarCred PR #622.

## Files Created

### 1. Workflow Integration
- **`.github/workflows/ci.yml`** (modified)
  - Added `dependency-check` job that runs early on all PRs
  - Runs before other jobs to fail fast on violations
  - Only runs on `pull_request` events (not on push to main)

### 2. Custom Checking Scripts
- **`.github/scripts/check-runtime-deps.mjs`** (new)
  - Detects newly added/upgraded packages in `frontend/package.json`
  - Compares against base branch to identify changes
  - Fetches package metadata from npm registry:
    - License information
    - Last update timestamp
    - Package description
  - Validates licenses against policy
  - Flags packages not updated in 365+ days
  - Fails on license policy violations

- **`.github/scripts/verify-npm-licenses.mjs`** (new)
  - Walks entire transitive dependency tree
  - Validates all packages (not just new ones)
  - Generates license summary report
  - Fails if any denied licenses detected
  - Handles license exceptions with expiration dates

### 3. Policy Configuration
- **`.github/config/license-policy.json`** (new)
  - Centralized license policy
  - Allowed licenses: MIT, Apache-2.0, ISC, BSD variants, MPL-2.0, etc.
  - Denied licenses: GPL, AGPL, SSPL (copyleft incompatible with Apache-2.0)
  - Frontend runtime policy: max 150 dependencies, age thresholds
  - Exception list with expiration dates for audit trail

### 4. Documentation
- **`.github/DEPENDENCY_REVIEW.md`** (new)
  - Comprehensive guide to the dependency review system
  - Explains security rationale
  - Documents when checks run
  - Provides resolution steps for violations
  - FAQ section

- **`.github/workflows/dependency-review.yml`** (new)
  - Standalone workflow (for reference; actual job integrated in ci.yml)
  - Can be used in other projects as a template

- **`.github/IMPLEMENTATION_NOTES.md`** (this file)
  - Technical implementation details
  - Testing notes
  - Integration points

## Architecture

### Execution Flow

```
PR opened on main branch
    ↓
GitHub Actions triggered on pull_request event
    ↓
dependency-check job runs (parallel with other jobs)
    ↓
[1] actions/dependency-review-action@v4
    - Checks GitHub Advisory Database for new packages
    - Validates licenses against allow/deny list
    - Fails on moderate+ severity advisories in new packages
    - Fails on denied licenses
    ↓
[2] check-runtime-deps.mjs script
    - Compares package.json against base branch
    - Identifies new/upgraded runtime dependencies
    - Fetches metadata from npm registry
    - Validates each against license policy
    - Reports package age and maintenance status
    ↓
[3] verify-npm-licenses.mjs script
    - Uses pnpm ls to walk transitive deps
    - Checks all packages against policy
    - Generates summary report
    - Fails if violations detected
    ↓
If all checks pass: ✓ dependency-check job succeeds
If any check fails: ✗ dependency-check job fails → PR merge blocked
```

### Integration with Existing CI

The `dependency-check` job:
- Uses same workspace and checkout as other jobs
- Runs early (defined first in jobs) but in parallel with others
- Does NOT block compilation/build
- Failure blocks merge (PR required status check)
- Success doesn't guarantee other jobs will pass

Existing checks remain unchanged:
- `cargo clippy` for Rust
- `cargo test` for contracts
- `nargo test` for circuits
- Frontend `pnpm lint` and `pnpm test`
- All existing checks still run

### Why This Design?

1. **Fail Fast**: Dependency violations caught immediately, before expensive builds
2. **Transparency**: Three layers of checking provide confidence:
   - GitHub's official Advisory Database
   - Custom runtime dependency flagging
   - Full transitive tree validation
3. **Auditability**: All decisions recorded in policy file with expiration dates
4. **Non-Breaking**: Existing dependencies not affected; only NEW additions checked

## Testing & Validation

### Local Testing

Scripts can be tested locally:

```bash
# Test runtime dependency check (requires base branch access)
GITHUB_BASE_REF=main GITHUB_HEAD_REF=feature-branch \
  node .github/scripts/check-runtime-deps.mjs

# Test license verification (requires pnpm install)
cd frontend
node ../.github/scripts/verify-npm-licenses.mjs
```

### CI Testing

When this PR merges to main:
- All subsequent PRs will run the `dependency-check` job
- Any new npm package additions will be validated
- Existing tests continue unchanged

### Verification Performed

- ✓ JavaScript syntax validation: both scripts pass `node --check`
- ✓ JSON validation: license-policy.json is valid JSON
- ✓ YAML syntax: ci.yml valid workflow structure
- ✓ Bash scripts: all shell scripts in circuits/ still present and unchanged
- ✓ Backwards compatible: existing jobs, tests, dependencies unaffected
- ✓ Documentation: comprehensive guides provided

## Edge Cases & Considerations

### Case: PR adds no new dependencies
- `check-runtime-deps.mjs` outputs "No new dependencies" and succeeds
- `verify-npm-licenses.mjs` runs full tree check (ensures no regressions)
- No impact if base branch or HEAD not available (graceful fallback)

### Case: PR upgrades existing package
- Treated as a "change" worth reviewing
- License re-validated if version differs
- Useful to catch license changes on upgrades

### Case: Transitive dependency has violation
- Scripts flag violation but cannot add per-version exception
- Must update parent dependency or find alternative
- Encourages strict parent dependency standards

### Case: Package license is "unknown" or custom
- Reported as unclassified warning
- Does not fail by default (fails only on explicitly denied)
- Allows edge cases while maintaining transparency

### Case: GitHub Advisory Database unavailable
- `actions/dependency-review-action` continues with `continue-on-error: true`
- Custom scripts provide fallback validation
- PR is not blocked by external service outage

### Case: pnpm install times out
- Workflow will timeout and job fails
- This is expected for very large dependency trees
- Timeout can be increased in workflow if needed

## Maintenance

### Updating License Policy

Edit `.github/config/license-policy.json`:
- Add/remove from `allowedLicenses` array to change policy
- Add/remove from `deniedLicenses` array for copyleft decisions
- Document changes in commit message (for audit trail)

### Adding License Exception

Edit `.github/config/license-policy.json` `exceptionList`:
```json
{
  "package": "package-name",
  "version": "1.2.3",
  "license": "GPL-2.0",
  "reason": "Required for vendor integration; legal approval obtained",
  "approvedBy": "security-team",
  "expiresAt": "2025-12-31"
}
```

Exception expires on specified date and requires re-review.

### Updating Scripts

Scripts are JavaScript (Node.js) for:
- Cross-platform compatibility (Windows/Linux/Mac)
- Access to npm registry
- Integration with existing pnpm setup
- No additional tool dependencies

## Performance Impact

- **Time**: dependency-check job adds ~30-60 seconds to CI (registry API calls)
- **Parallelization**: Runs in parallel with contracts/circuits/frontend jobs
- **Cost**: Minimal; only network calls to public npm registry
- **Reliability**: GitHub Advisory DB and npm registry are highly available

## Security Considerations

### What This Protects Against

1. **Compromised packages**: Advisories checked at add-time
2. **Abandoned packages**: Age threshold flags unmaintained deps
3. **Copyleft contamination**: GPL/AGPL/SSPL blocked by default
4. **License compliance**: Transitive tree validated
5. **Audit trail**: Exception list provides historical record

### What This Does NOT Protect Against

1. **Supply chain attacks** on already-approved packages (handled by Dependabot)
2. **Zero-day vulnerabilities** (discovered after merge)
3. **Behavioral malware** (no static analysis of package code)
4. **Typosquatting** (misspelled package names; requires code review)
5. **Private registry compromises** (assumes npm registry integrity)

This is defense-in-depth, not a complete solution. Code review, dependency audits, and dependency scanning remain essential.

## Rollback Plan

If issues arise:

1. **Temporary disable**: Set `if: false` on dependency-check job in ci.yml
2. **Full rollback**: Delete dependency-check job and all new files:
   ```bash
   git revert <commit-hash>
   ```
3. **Partial disable**: Comment out steps in dependency-check job to isolate issues

## Future Enhancements

Potential improvements:

1. **SBOM generation**: Export software bill of materials for compliance
2. **Dependency graph visualization**: Show transitive dep tree in PR comments
3. **Maintenance score**: Integrate GitHub API to score package maintenance
4. **CVE tracking**: Integrate NVD database for Rust + npm
5. **Supply chain scoring**: Use OpenSSF scorecard for package risk
6. **Policy enforcement levels**: Different rules for frontend vs backend vs test-only

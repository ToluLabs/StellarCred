#!/usr/bin/env node
/**
 * Dependency Update Threshold & Safety Evaluator
 *
 * Evaluates dependency update PRs to verify whether they qualify for safe auto-merge:
 * - PR must have the configured label (default: 'deps' or 'dependencies').
 * - Prohibits major version bumps (e.g. 1.2.0 -> 2.0.0 or 0.1.0 -> 0.2.0).
 * - Allows minor and patch version bumps (e.g. 1.2.0 -> 1.3.0, 1.2.1 -> 1.2.2).
 * - Enforces that only dependency manifests/lockfiles were modified.
 */

export const DEFAULT_AUTOMERGE_LABEL = "deps";
export const ALLOWED_DEP_LABELS = new Set(["deps", "dependencies"]);
export const BLOCKED_LABELS = new Set([
  "major",
  "breaking",
  "semver-major",
  "dependencies-major",
  "do-not-merge",
]);

export const MANIFEST_PATTERNS = [
  /^package\.json$/,
  /^frontend\/package\.json$/,
  /^frontend\/pnpm-lock\.yaml$/,
  /^services\/[^/]+\/package\.json$/,
  /^services\/[^/]+\/package-lock\.json$/,
  /^sdk\/package\.json$/,
  /^Cargo\.toml$/,
  /^Cargo\.lock$/,
  /^contracts\/[^/]+\/Cargo\.toml$/,
  /^\.github\/workflows\/[^/]+\.yml$/,
];

/**
 * Parses semver version string into major, minor, patch numbers.
 * @param {string} versionStr
 * @returns {{ major: number; minor: number; patch: number; raw: string } | null}
 */
export function parseSemver(versionStr) {
  if (!versionStr || typeof versionStr !== "string") return null;
  const cleaned = versionStr.trim().replace(/^v/, "").split(/[-+]/)[0];
  const parts = cleaned.split(".").map((p) => parseInt(p, 10));
  if (parts.length === 0 || isNaN(parts[0])) return null;

  return {
    major: parts[0],
    minor: parts.length > 1 && !isNaN(parts[1]) ? parts[1] : 0,
    patch: parts.length > 2 && !isNaN(parts[2]) ? parts[2] : 0,
    raw: versionStr.trim(),
  };
}

/**
 * Extracts dependency bump information from PR title and body.
 * @param {string} title
 * @param {string} [body]
 * @returns {{ package: string; from: string; to: string } | null}
 */
export function parseVersionBump(title, body = "") {
  if (!title) return null;

  // Pattern 1: bump <pkg> from <from> to <to>
  // Handles prefixes like "npm(deps): bump foo from 1.0.0 to 1.1.0" or "bump bar from 2.1 to 2.2"
  const bumpMatch = title.match(
    /(?:bump|update)\s+([@a-zA-Z0-9_\-\/\.]+)\s+from\s+v?([0-9][^\s]*)\s+to\s+v?([0-9][^\s]*)/i,
  );
  if (bumpMatch) {
    return {
      package: bumpMatch[1],
      from: bumpMatch[2],
      to: bumpMatch[3],
    };
  }

  // Pattern 2: Inspect body for Dependabot table or updates
  if (body) {
    const bodyMatch = body.match(
      /Bumps\s+\[([@a-zA-Z0-9_\-\/\.]+)\]\([^)]+\)\s+from\s+v?([0-9][^\s]*)\s+to\s+v?([0-9][^\s]*)/i,
    );
    if (bodyMatch) {
      return {
        package: bodyMatch[1],
        from: bodyMatch[2],
        to: bodyMatch[3],
      };
    }
  }

  return null;
}

/**
 * Checks whether modified files are exclusively dependency manifests and lockfiles.
 * @param {string[]} changedFiles
 * @returns {boolean}
 */
export function areFilesManifestOnly(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  return changedFiles.every((file) =>
    MANIFEST_PATTERNS.some((pattern) => pattern.test(file.replace(/\\/g, "/"))),
  );
}

/**
 * Evaluates whether a PR meets all safety threshold rules for auto-merging.
 *
 * @param {{
 *   title: string;
 *   body?: string;
 *   labels?: string[];
 *   changedFiles?: string[];
 *   configuredLabel?: string;
 *   author?: string;
 * }} pr
 * @returns {{
 *   eligible: boolean;
 *   bumpType: "patch" | "minor" | "major" | "unknown";
 *   reason: string;
 *   details?: Record<string, unknown>;
 * }}
 */
export function evaluateDepBumpSafety(pr) {
  const labels = Array.isArray(pr.labels) ? pr.labels.map((l) => l.toLowerCase()) : [];
  const configuredLabel = (pr.configuredLabel || DEFAULT_AUTOMERGE_LABEL).toLowerCase();

  // 1. Verify required label is present
  const hasRequiredLabel =
    labels.includes(configuredLabel) ||
    (configuredLabel === "deps" && labels.includes("dependencies"));

  if (!hasRequiredLabel) {
    return {
      eligible: false,
      bumpType: "unknown",
      reason: `PR does not have required auto-merge label '${configuredLabel}'.`,
    };
  }

  // 2. Reject blocked / major labels
  for (const label of labels) {
    if (BLOCKED_LABELS.has(label)) {
      return {
        eligible: false,
        bumpType: "major",
        reason: `PR contains blocked label '${label}', indicating a major or breaking change.`,
      };
    }
  }

  // 3. If file list is provided, verify only manifests/lockfiles changed
  if (pr.changedFiles && !areFilesManifestOnly(pr.changedFiles)) {
    return {
      eligible: false,
      bumpType: "unknown",
      reason:
        "PR modifies files outside dependency manifests/lockfiles. Manual review required.",
    };
  }

  // 4. Parse version bump
  const bump = parseVersionBump(pr.title, pr.body);
  if (!bump) {
    // If we cannot parse a version bump, check if it explicitly says patch or minor in title
    if (/\b(?:patch|minor)\b/i.test(pr.title) && !/\b(?:major|breaking)\b/i.test(pr.title)) {
      return {
        eligible: true,
        bumpType: /\bminor\b/i.test(pr.title) ? "minor" : "patch",
        reason: "PR title indicates safe non-major dependency bump.",
      };
    }

    return {
      eligible: false,
      bumpType: "unknown",
      reason: "Could not safely parse version bump numbers from PR title or description.",
    };
  }

  const fromSemver = parseSemver(bump.from);
  const toSemver = parseSemver(bump.to);

  if (!fromSemver || !toSemver) {
    return {
      eligible: false,
      bumpType: "unknown",
      reason: `Failed to parse semver from '${bump.from}' or '${bump.to}'.`,
    };
  }

  // Check 1: Standard Major Bump (X.y.z -> (X+1).a.b)
  if (toSemver.major > fromSemver.major) {
    return {
      eligible: false,
      bumpType: "major",
      reason: `Blocked major version bump from ${fromSemver.raw} to ${toSemver.raw} for package '${bump.package}'. Major upgrades require manual review.`,
      details: { package: bump.package, from: fromSemver.raw, to: toSemver.raw },
    };
  }

  // Check 2: 0.x Breaking Bump (0.X.a -> 0.(X+1).b)
  // In semver 0.y.z, minor updates are breaking per spec.
  if (fromSemver.major === 0 && toSemver.major === 0 && toSemver.minor > fromSemver.minor) {
    return {
      eligible: false,
      bumpType: "major",
      reason: `Blocked 0.x breaking minor bump from ${fromSemver.raw} to ${toSemver.raw} for package '${bump.package}'. Initial-development 0.x minor updates can break APIs.`,
      details: { package: bump.package, from: fromSemver.raw, to: toSemver.raw },
    };
  }

  // Minor bump: same major, newer minor
  if (toSemver.major === fromSemver.major && toSemver.minor > fromSemver.minor) {
    return {
      eligible: true,
      bumpType: "minor",
      reason: `Safe minor update from ${fromSemver.raw} to ${toSemver.raw} for package '${bump.package}'.`,
      details: { package: bump.package, from: fromSemver.raw, to: toSemver.raw },
    };
  }

  // Patch bump: same major, same minor
  if (toSemver.major === fromSemver.major && toSemver.minor === fromSemver.minor) {
    return {
      eligible: true,
      bumpType: "patch",
      reason: `Safe patch update from ${fromSemver.raw} to ${toSemver.raw} for package '${bump.package}'.`,
      details: { package: bump.package, from: fromSemver.raw, to: toSemver.raw },
    };
  }

  return {
    eligible: false,
    bumpType: "unknown",
    reason: `Unrecognized version transition from ${fromSemver.raw} to ${toSemver.raw}.`,
  };
}

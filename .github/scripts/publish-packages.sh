#!/usr/bin/env bash
# Publish (or dry-run publish) every npm package released by release.yml.
#
#   bash .github/scripts/publish-packages.sh <dry-run|publish> [dist-tag]
#
# The same code path serves the PR check (`dry-run`, no credentials) and the release
# (`publish`), so a problem the release would hit shows up on the PR first.
#
# - Lifecycle scripts are disabled (`--ignore-scripts`): packages are built explicitly
#   beforehand, and no package script may run while NPM_TOKEN is in the environment.
# - A version that is already on the registry is skipped in both modes. For `publish`
#   this lets a release that failed half-way (e.g. SDK published, issuer not) be
#   re-run to completion instead of failing on the version that already went out; npm
#   versions are immutable. For `dry-run` it is necessary: npm refuses to dry-run a
#   version the registry has.
# - Provenance is not requested here. The release step sets NPM_CONFIG_PROVENANCE=true
#   because it needs the OIDC token of the publishing job; a dry run has none.
#
# Keep the package list in sync with PACKAGES in validate-release-packages.mjs.

set -euo pipefail

mode="${1:-}"
dist_tag="${2:-latest}"

case "$mode" in
  dry-run | publish) ;;
  *)
    echo "usage: $0 <dry-run|publish> [dist-tag]" >&2
    exit 2
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
packages=(frontend/packages/sdk frontend/packages/issuer)

for dir in "${packages[@]}"; do
  cd "$root/$dir"
  name="$(node -p "require('./package.json').name")"
  version="$(node -p "require('./package.json').version")"

  echo "::group::$mode $name@$version (dist-tag: $dist_tag)"
  # `npm publish --dry-run` also refuses a version the registry already has, so a PR
  # that does not bump the version (the common case) would be red forever. Such a
  # version is skipped in both modes; the tarball check in
  # validate-release-packages.mjs still inspects it.
  if npm view "$name@$version" version > /dev/null 2>&1; then
    echo "$name@$version is already on the registry — skipping"
  elif [ "$mode" = "dry-run" ]; then
    pnpm publish --dry-run --no-git-checks --ignore-scripts --access public --tag "$dist_tag"
  else
    pnpm publish --no-git-checks --ignore-scripts --access public --tag "$dist_tag"
  fi
  echo "::endgroup::"
done

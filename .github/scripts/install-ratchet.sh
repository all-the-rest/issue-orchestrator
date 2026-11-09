#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

version="${RATCHET_VERSION:-}"
[[ "$version" == v0.6.3 ]] || fail "unsupported Ratchet version '${version:-}' (expected v0.6.3)"
version="${version#v}"

case "${RUNNER_OS:-}" in
  Linux) os=linux ;;
  macOS) os=macos ;;
  *) fail "unsupported runner OS '${RUNNER_OS:-}'" ;;
esac
case "${RUNNER_ARCH:-}" in
  X64) arch=x86_64 ;;
  ARM64) arch=aarch64 ;;
  *) fail "unsupported runner architecture '${RUNNER_ARCH:-}'" ;;
esac

asset="ratchet-${version}-${os}-${arch}"
release_tag="v${version}"
api_base="https://api.github.com/repos/all-the-rest/ratchet-cli/releases"
work="$(mktemp -d)" || fail "cannot create a temporary directory"
trap 'rm -rf "$work"' EXIT

gh_api() {
  local attempt
  for attempt in 1 2 3; do
    if gh api --header 'X-GitHub-Api-Version: 2022-11-28' "$@"; then
      return 0
    fi
    if [[ "$attempt" -lt 3 ]]; then sleep "$((attempt * 2))"; fi
  done
  return 1
}

gh_api "$api_base/tags/$release_tag" > "$work/release.json" ||
  fail "could not read Ratchet release metadata through the GitHub API"

find_asset_id() {
  RATCHET_ASSET_NAME="$1" RATCHET_EXPECTED_TAG="$release_tag" node -e '
    const release = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (release.tag_name !== process.env.RATCHET_EXPECTED_TAG ||
        release.draft || release.prerelease) process.exit(1);
    const matches = release.assets.filter((asset) => asset.name === process.env.RATCHET_ASSET_NAME);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id)) process.exit(1);
    process.stdout.write(String(matches[0].id));
  ' < "$work/release.json"
}

checksum_id="$(find_asset_id checksums.txt)" || fail "Ratchet release has no unique checksum asset"
asset_id="$(find_asset_id "$asset")" || fail "Ratchet release has no unique $asset asset"
[[ -n "$checksum_id" && -n "$asset_id" ]] || fail "Ratchet release is missing the binary or checksum asset"

gh_api --header 'Accept: application/octet-stream' "$api_base/assets/$checksum_id" > "$work/checksums.txt" ||
  fail "could not download Ratchet checksums through the GitHub API"
gh_api --header 'Accept: application/octet-stream' "$api_base/assets/$asset_id" > "$work/$asset" ||
  fail "could not download Ratchet $asset through the GitHub API"

expected="$(awk -v name="$asset" '
  NF == 2 {
    file = $2
    sub(/^\*/, "", file)
    if (file == name) {
      if (length($1) != 64 || $1 ~ /[^A-Fa-f0-9]/ || ++matches > 1) exit 2
      hash = $1
    }
  }
  END { if (matches != 1) exit 1; print hash }
' "$work/checksums.txt")" || fail "release checksums do not contain exactly one valid hash for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$work/$asset" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$work/$asset" | cut -d' ' -f1)"
else
  fail "neither sha256sum nor shasum is available"
fi
expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
actual="$(printf '%s' "$actual" | tr 'A-F' 'a-f')"
[[ "$actual" == "$expected" ]] || fail "SHA-256 mismatch for $asset"

install_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ratchet"
mkdir -p "$install_dir" || fail "cannot create Ratchet install directory"
cp "$work/$asset" "$install_dir/ratchet" || fail "cannot install Ratchet binary"
chmod 0755 "$install_dir/ratchet" || fail "cannot make Ratchet executable"
[[ -n "${GITHUB_PATH:-}" ]] || fail "GITHUB_PATH is not set"
printf '%s\n' "$install_dir" >> "$GITHUB_PATH" || fail "cannot add Ratchet to PATH"
echo "ratchet $version installed from the GitHub API and checksum-verified"

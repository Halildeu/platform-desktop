#!/bin/bash

set -Eeuo pipefail

release_dir=${1:?release directory is required}
dmg_result_path=${2:?DMG notary result path is required}
pkg_result_path=${3:?PKG notary result path is required}

for name in APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
  if test -z "${!name:-}"; then
    echo "::error::Missing required notarization environment: $name"
    exit 1
  fi
done

if ! test -f "$APPLE_API_KEY"; then
  echo '::error::APPLE_API_KEY must point to a temporary App Store Connect API key file'
  exit 1
fi

shopt -s nullglob
dmgs=("$release_dir"/*.dmg)
pkgs=("$release_dir"/*.pkg)
if test "${#dmgs[@]}" -ne 1 || test "${#pkgs[@]}" -ne 1; then
  echo "::error::Expected exactly one DMG and one PKG; found ${#dmgs[@]} DMG and ${#pkgs[@]} PKG"
  exit 1
fi

submit_and_staple() {
  local artifact=$1
  local result_path=$2

  xcrun notarytool submit "$artifact" \
    --key "$APPLE_API_KEY" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" \
    --wait \
    --output-format json \
    > "$result_path"

  jq -e '.status == "Accepted" and (.id | type == "string" and length > 0)' \
    "$result_path" >/dev/null
  xcrun stapler staple --verbose "$artifact"
  xcrun stapler validate --verbose "$artifact"
}

# electron-builder notarizes the app bundle before producing targets; the
# outer DMG and PKG are separate notarization submissions and tickets.
submit_and_staple "${dmgs[0]}" "$dmg_result_path"
submit_and_staple "${pkgs[0]}" "$pkg_result_path"

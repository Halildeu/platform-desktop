#!/bin/bash

set -Eeuo pipefail

release_dir=${1:?release directory is required}
version=${2:?package version is required}
expected_team_id=${3:?expected Apple Team ID is required}
expected_app_id=${4:?expected application bundle ID is required}

if test "$(uname -s)" != Darwin; then
  echo '::error::macOS release verification must run on macOS'
  exit 1
fi
if [[ ! "$expected_team_id" =~ ^[A-Z0-9]{10}$ ]]; then
  echo '::error::Expected Apple Team ID is invalid'
  exit 1
fi

shopt -s nullglob
dmgs=("$release_dir"/*.dmg)
pkgs=("$release_dir"/*.pkg)
zips=("$release_dir"/*.zip)
if test "${#dmgs[@]}" -ne 1 || test "${#pkgs[@]}" -ne 1 || test "${#zips[@]}" -ne 1; then
  echo '::error::Expected exactly one DMG, one PKG, and one update ZIP'
  exit 1
fi
for artifact in "${dmgs[0]}" "${pkgs[0]}" "${zips[0]}"; do
  if [[ "$(basename "$artifact")" != *"$version"* ]]; then
    echo "::error::Artifact is not bound to version $version: $(basename "$artifact")"
    exit 1
  fi
done

work_dir=$(mktemp -d)
mount_dir="$work_dir/dmg"
mounted=false
cleanup() {
  if test "$mounted" = true; then
    hdiutil detach "$mount_dir" -quiet || true
  fi
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

verify_app() {
  local app_path=$1
  local label=$2
  local details="$work_dir/$label-codesign.txt"
  local entitlements="$work_dir/$label-entitlements.plist"
  local info_plist="$app_path/Contents/Info.plist"
  local executable
  local architectures

  codesign --verify --deep --strict --verbose=4 "$app_path"
  codesign --display --verbose=4 "$app_path" > /dev/null 2> "$details"
  grep -Eq '^Authority=Developer ID Application:' "$details"
  grep -Fxq "TeamIdentifier=$expected_team_id" "$details"
  grep -Fxq "Identifier=$expected_app_id" "$details"
  grep -Eq '^CodeDirectory .*flags=.*\(runtime\)' "$details"

  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist")" = "$expected_app_id"
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist")" = "$version"
  executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$info_plist")
  architectures=$(lipo -archs "$app_path/Contents/MacOS/$executable")
  grep -qw arm64 <<< "$architectures"
  grep -qw x86_64 <<< "$architectures"

  codesign --display --entitlements :- "$app_path" > "$entitlements" 2>/dev/null
  plutil -lint "$entitlements" >/dev/null
  test "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.cs.allow-jit' "$entitlements")" = true
  test "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.device.audio-input' "$entitlements")" = true
  test -n "$(/usr/libexec/PlistBuddy -c 'Print :NSMicrophoneUsageDescription' "$info_plist")"
  test -n "$(/usr/libexec/PlistBuddy -c 'Print :NSScreenCaptureUsageDescription' "$info_plist")"
  if /usr/libexec/PlistBuddy \
    -c 'Print :com.apple.security.cs.allow-dyld-environment-variables' \
    "$entitlements" >/dev/null 2>&1; then
    echo '::error::DYLD environment entitlement must not be present'
    exit 1
  fi
  if /usr/libexec/PlistBuddy \
    -c 'Print :com.apple.security.screen-recording' \
    "$entitlements" >/dev/null 2>&1; then
    echo '::error::Unsupported screen-recording entitlement must not be present'
    exit 1
  fi

  xcrun stapler validate --verbose "$app_path"
  spctl --assess --type execute --verbose=4 "$app_path"
}

xcrun stapler validate --verbose "${dmgs[0]}"
spctl --assess --type open --context context:primary-signature --verbose=4 "${dmgs[0]}"
mkdir -p "$mount_dir"
hdiutil attach "${dmgs[0]}" -readonly -nobrowse -mountpoint "$mount_dir" -quiet
mounted=true
dmg_apps=("$mount_dir"/*.app)
if test "${#dmg_apps[@]}" -ne 1; then
  echo "::error::Expected exactly one app in DMG; found ${#dmg_apps[@]}"
  exit 1
fi
verify_app "${dmg_apps[0]}" dmg
hdiutil detach "$mount_dir" -quiet
mounted=false

zip_dir="$work_dir/zip"
mkdir -p "$zip_dir"
ditto -x -k "${zips[0]}" "$zip_dir"
zip_apps=("$zip_dir"/*.app)
if test "${#zip_apps[@]}" -ne 1; then
  echo "::error::Expected exactly one app in update ZIP; found ${#zip_apps[@]}"
  exit 1
fi
verify_app "${zip_apps[0]}" zip

pkg_signature="$work_dir/pkg-signature.txt"
pkgutil --check-signature "${pkgs[0]}" | tee "$pkg_signature"
grep -Eq "Developer ID Installer: .* \($expected_team_id\)" "$pkg_signature"
xcrun stapler validate --verbose "${pkgs[0]}"
spctl --assess --type install --verbose=4 "${pkgs[0]}"

echo 'macOS Developer ID, hardened runtime, notarization, stapling, and Gatekeeper checks passed'

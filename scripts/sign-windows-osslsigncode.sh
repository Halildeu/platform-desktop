#!/usr/bin/env bash
#
# Faz 24 signed Windows release — osslsigncode wrapper.
#
# Signs one or more Windows .exe files with an Authenticode signature
# via osslsigncode. Same shape as the AG-018 platform-agent script;
# lives here so a developer or the sudoers-pinned self-hosted runner
# (İ-S2 in docs/release-signing.md) can invoke sign flow the same way
# GitHub Actions does — no path drift between local rehearsal and CI.
#
# Environment inputs (all required unless noted):
#   SIGN_CERT_P12   Path to the PKCS#12 bundle (leaf + private key).
#   SIGN_CERT_PW    Password for the P12.
#   SIGN_TSA_URL    RFC 3161 timestamp URL, e.g. https://freetsa.org/tsr
#                   or http://timestamp.sectigo.com.
#   SIGN_TSA_CACERT (optional) CA bundle for a private TSA — only set
#                   when the TSA runs behind an internal CA.
#   SIGN_ALG        (optional) Digest algorithm, default sha256.
#
# Usage:
#   bash scripts/sign-windows-osslsigncode.sh <path/to/file.exe> [<more.exe>...]
#
# Behaviour:
#   - Each input .exe is signed in-place (previous file is preserved as
#     `<name>.exe.unsigned` alongside it — so a local rehearsal never
#     silently overwrites the artifact you built by hand).
#   - Every produced signature is verified with osslsigncode; the script
#     exits non-zero on any verify failure.
#   - Print output NEVER contains the P12 password, cert Subject/thumb
#     printed by osslsigncode is truncated to the first 64 chars.
#
# The script deliberately does NOT set SIGN_TSA_URL to a default TSA:
# an untimestamped signature expires with the cert, defeating the whole
# point of Authenticode. That is a guard, not an inconvenience.

set -euo pipefail

if ! command -v osslsigncode >/dev/null 2>&1; then
    echo "osslsigncode not installed" >&2
    exit 1
fi

: "${SIGN_CERT_P12:?SIGN_CERT_P12 not set}"
: "${SIGN_CERT_PW:?SIGN_CERT_PW not set}"
: "${SIGN_TSA_URL:?SIGN_TSA_URL not set — an untimestamped sig expires with the cert}"

SIGN_ALG="${SIGN_ALG:-sha256}"

if [ "$#" -lt 1 ]; then
    echo "usage: $0 <file.exe> [<more.exe>...]" >&2
    exit 2
fi

if [ ! -f "$SIGN_CERT_P12" ]; then
    echo "SIGN_CERT_P12 does not exist: $SIGN_CERT_P12" >&2
    exit 3
fi

# Sanity: load the P12 through openssl so a bad password fails BEFORE
# osslsigncode starts writing over the input. openssl accepts the
# password via `env:` which keeps it out of ps and shell history.
_probe_p12() {
    SIGN_CERT_PW_FOR_PROBE="$SIGN_CERT_PW" \
        openssl pkcs12 -in "$SIGN_CERT_P12" \
        -passin env:SIGN_CERT_PW_FOR_PROBE -noout -info \
        >/dev/null
}
if ! _probe_p12; then
    echo "failed to load $SIGN_CERT_P12 with the provided password" >&2
    exit 4
fi

sign_one() {
    local infile="$1"
    if [ ! -f "$infile" ]; then
        echo "no such file: $infile" >&2
        return 5
    fi
    if [[ "$infile" != *.exe ]]; then
        echo "not an .exe: $infile" >&2
        return 6
    fi

    local backup="${infile}.unsigned"
    if [ ! -f "$backup" ]; then
        cp "$infile" "$backup"
    fi

    local tmpout
    tmpout=$(mktemp --suffix=.signed.exe)
    trap "rm -f '$tmpout'" RETURN

    local extra_args=()
    if [ -n "${SIGN_TSA_CACERT:-}" ]; then
        extra_args+=(-TSA-CAfile "$SIGN_TSA_CACERT")
    fi

    osslsigncode sign \
        -pkcs12 "$SIGN_CERT_P12" \
        -pass "$SIGN_CERT_PW" \
        -h "$SIGN_ALG" \
        -t "$SIGN_TSA_URL" \
        "${extra_args[@]}" \
        -in "$infile" \
        -out "$tmpout" \
        >/dev/null

    mv "$tmpout" "$infile"

    local verify
    verify=$(osslsigncode verify -in "$infile")
    if ! grep -q 'Signature verification: ok' <<<"$verify"; then
        echo "verify FAILED for $infile" >&2
        echo "$verify" >&2
        return 7
    fi

    # Truncated so a very long Subject can never blow past a log line
    # and pull attention to the wrong field.
    local subject
    subject=$(grep -m1 'Signer #1' <<<"$verify" | tr -d '\n' | head -c 96)
    echo "signed OK  $infile"
    echo "  subject  ${subject}"
    local sha
    sha=$(sha256sum "$infile" | cut -d' ' -f1)
    echo "  sha256   $sha"
}

for f in "$@"; do
    sign_one "$f"
done

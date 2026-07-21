#!/usr/bin/env bash
#
# Faz 24 signed Windows release — internal CA + code-signing leaf helper.
#
# Generates an internal CA and a code-signing leaf so a developer can
# rehearse the full sign flow (via sign-windows-osslsigncode.sh) without
# owner Authenticode cert access. NOT a substitute for a real EV cert on
# a production release track — an internal-CA-issued .exe is only
# trusted on machines that have imported the CA root, exactly like our
# internal mTLS chain.
#
# NEVER commit any output. The default output directory is
# `.local/code-signing/` and .local/ is in .gitignore for this reason.
#
# Usage:
#   bash scripts/generate-internal-code-signing-ca.sh
#   bash scripts/generate-internal-code-signing-ca.sh out=/some/dir cn='Test Signer'
#
# Options (KEY=VALUE):
#   out=<dir>   Output directory (default `.local/code-signing`).
#   cn=<str>    CN on the leaf cert (default 'Meeting Intelligence Dev Signer').
#   days=<N>    Cert validity in days (default 365).
#
# The leaf cert carries the Code Signing EKU (1.3.6.1.5.5.7.3.3) so
# osslsigncode will accept it. Without that EKU osslsigncode refuses to
# produce a signature ("no Code Signing EKU").

set -euo pipefail

OUT=".local/code-signing"
CN="Meeting Intelligence Dev Signer"
DAYS=365

for arg in "$@"; do
    case "$arg" in
        out=*)  OUT="${arg#out=}" ;;
        cn=*)   CN="${arg#cn=}" ;;
        days=*) DAYS="${arg#days=}" ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

command -v openssl >/dev/null 2>&1 || { echo "openssl not installed" >&2; exit 1; }

mkdir -p "$OUT"
umask 077

echo "generating internal CA in $OUT"
openssl req -x509 -newkey rsa:4096 -sha256 -days "$DAYS" -nodes \
    -keyout "$OUT/ca.key" \
    -out "$OUT/ca.crt" \
    -subj "/CN=Meeting Intelligence Dev Internal CA" \
    >/dev/null 2>&1

CONF="$OUT/leaf.cnf"
{
    echo "[req]"
    echo "distinguished_name = dn"
    echo "req_extensions = v3_ext"
    echo "prompt = no"
    echo ""
    echo "[dn]"
    echo "CN = $CN"
    echo ""
    echo "[v3_ext]"
    echo "keyUsage = critical, digitalSignature"
    echo "extendedKeyUsage = critical, codeSigning"
    echo "basicConstraints = critical, CA:FALSE"
} > "$CONF"

openssl req -newkey rsa:3072 -sha256 -nodes \
    -keyout "$OUT/codesign.key" \
    -out "$OUT/codesign.csr" \
    -config "$CONF" \
    >/dev/null 2>&1

openssl x509 -req -sha256 -days "$DAYS" \
    -in "$OUT/codesign.csr" \
    -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" -CAcreateserial \
    -extensions v3_ext -extfile "$CONF" \
    -out "$OUT/codesign.crt" \
    >/dev/null 2>&1

openssl rand -base64 24 > "$OUT/codesign.p12.pass"

openssl pkcs12 -export \
    -in "$OUT/codesign.crt" \
    -inkey "$OUT/codesign.key" \
    -passout "file:$OUT/codesign.p12.pass" \
    -name "$CN" \
    -out "$OUT/codesign.p12" \
    >/dev/null 2>&1

rm -f "$OUT/codesign.csr" "$OUT/leaf.cnf" "$OUT/ca.srl"

echo "done. next:"
echo "  export SIGN_CERT_P12=$OUT/codesign.p12"
echo "  export SIGN_CERT_PW=\$(cat $OUT/codesign.p12.pass)"
echo "  export SIGN_TSA_URL=https://freetsa.org/tsr"
echo "  bash scripts/sign-windows-osslsigncode.sh path/to/build.exe"
echo
echo "to trust the resulting .exe on a Windows test box, import $OUT/ca.crt"
echo "into 'Trusted Root Certification Authorities'. NEVER on a customer box."

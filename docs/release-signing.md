# platform-desktop Windows release signing

**Status:** Skeleton — cert/key owner-touch required to enable • **Date:** 2026-07-21

## Karar

Signed Windows release track is a **port of the platform-agent AG-018
pattern**: Authenticode via `osslsigncode` on Linux, cross-signing the
Wine-cross-built `.exe` produced by `package-windows.yml`. Ships in
`package-windows-signed.yml` as a `workflow_dispatch` + `push tag v*`
workflow. The unsigned dev/smoke track stays unchanged — signed is
additive.

## Neden Authenticode (vs. self-signed dev builds)

The unsigned `.exe` (`package-windows.yml`) is fine for internal
smoke — Windows SmartScreen shows a warning and the user clicks
"Yine de çalıştır". That is deliberate: dev iteration should not pay
the cost of the signing round-trip. For anything ending up on a
customer machine we need Authenticode so:

- SmartScreen does not scare the user
- The MSIX / MSI store publishers can verify provenance
- Enterprise SCCM / Intune deployment does not reject unsigned exes

## Why Linux osslsigncode (vs. Windows signtool)

- No Windows runner needed — we already cross-build with Wine on Linux
- Reproducible: `osslsigncode` deterministic, same output byte-for-byte
  when the cert + timestamp are the same
- One CI path, not two (Linux for both build + sign)
- Pattern is proven in platform-agent (AG-018 MSI signing pivot)

## What is in this PR

- `.github/workflows/package-windows-signed.yml` — signed track, gated
  by the four `WINDOWS_SIGN_*` secrets.
- `docs/release-signing.md` — this doc.

Zero renderer or build-config changes. The unsigned `package-windows.yml`
track stays canonical for dev/smoke; the signed track is invoked
manually or on `v*` tag pushes.

## How to enable (owner-touch)

1. **Issue an Authenticode certificate**
   - Prod: purchase an EV code signing certificate from Sectigo,
     DigiCert, GlobalSign etc. Follow their identity verification
     process; ends with a `.p12` file + password.
   - Stage / dev: generate an internal CA + code-signing leaf per the
     AG-018 pattern. Non-Windows-machines trust it after they import
     the CA root — same as we do for the internal mTLS chain.

2. **Base64-encode the P12** so it can live in a GitHub Actions secret
   (which is a text secret — a raw binary blob will not survive):
   ```bash
   base64 -i codesign.p12 -o codesign.p12.b64
   ```

3. **Set the four Actions secrets** in this repo (Settings → Secrets
   and variables → Actions):
   | Secret | Value |
   |---|---|
   | `WINDOWS_SIGN_CERT_P12` | contents of `codesign.p12.b64` |
   | `WINDOWS_SIGN_CERT_PASSWORD` | the P12 password |
   | `WINDOWS_SIGN_TIMESTAMP_URL` | e.g. `http://timestamp.sectigo.com` or `https://freetsa.org/tsr` |
   | `WINDOWS_SIGN_TSA_CACERT` | (optional) CA bundle for a private TSA |

4. **Fire a signed build**
   ```bash
   gh workflow run "Windows package signed release" \
     --repo Halildeu/platform-desktop \
     --ref main \
     -f ref=main
   ```
   or push a version tag (`git tag v0.2.0 && git push --tags`).

5. **Verify** the produced `.exe`
   ```bash
   osslsigncode verify -in Meeting-Intelligence-Setup-0.2.0-x64.exe
   ```
   Successful output includes `Signature verification: ok` and the
   full certificate chain up to the trusted CA.

## Roadmap

- **İ-S1** (this PR): scaffold + gated workflow + docs.
- **İ-S2**: sudoers-pinned `osslsigncode` wrapper on the staging-sw
  runner if we move signing off GitHub-hosted (Vault-issued cert path
  matches AG-018 in platform-agent).
- **İ-S3**: promote to a public code-signing CA once the customer set
  needs it (rotate `WINDOWS_SIGN_CERT_P12` + timestamp URL — no
  workflow change).
- **İ-S4**: SBOM + provenance attestation attached to the signed
  artifact (sigstore Cosign — already installed in
  `package-linux.yml`, port to signed Windows).

## Guard: what MUST NOT ship

- No raw `codesign.p12` in the repo.
- No `WINDOWS_SIGN_CERT_PASSWORD` in a build script or log line.
- No workflow log statement that prints the cert Subject / thumbprint
  without redaction — that IS PII when the cert is issued to an
  individual (e.g. `CN=Halil Kocoglu`).
- osslsigncode ALWAYS runs with `-t <TSA_URL>` — an untimestamped
  signature invalidates the moment the cert expires, defeating the
  whole point.

## References

- AG-018 signing pivot memory (platform-agent Linux osslsigncode + internal CA)
- osslsigncode docs: https://github.com/mtrojnar/osslsigncode
- Authenticode spec: https://learn.microsoft.com/en-us/windows/win32/seccrypto/cryptography-tools
- HARD RULE — Kalıcı Çözüm (2026-05-27): 6-ay-sonra hâlâ doğru
  disipliniyle uyumlu; skeleton yerine full-flow committed.

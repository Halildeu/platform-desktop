# macOS Signed Release Candidate Contract

Issue: [platform-desktop #7](https://github.com/Halildeu/platform-desktop/issues/7)

Bu hat, `main` üzerindeki tek bir Git SHA'dan universal macOS release candidate üretir. DMG,
PKG ve updater ZIP dağıtım çıktıları yalnız Developer ID kimlikleriyle imzalandıktan, Apple
notarization kabulünden ve yerel doğrulama kapılarından sonra workflow artifact'i olabilir.

## İki Ayrı Yol

- Pull request yolu secretsizdir. Universal `.app` dizini üretip config ve paketleme sanity
  kontrolü yapar. DMG/PKG üretmez, upload etmez ve release acceptance kanıtı değildir.
- Release yolu yalnız `workflow_dispatch`, `main` ve GitHub Environment
  `macos-production-release` üzerinden çalışır. Protected environment reviewer kapısı agent
  tarafından taklit edilmez.
- Credential, signing identity, notarization veya doğrulama eksikliği job'u başarısız yapar.
  Ad-hoc signing ve Gatekeeper bypass yoktur.

## Protected Environment Sözleşmesi

`macos-production-release` aşağıdaki secret'lara sahip olmalıdır:

- `MACOS_APPLICATION_CERTIFICATE_P12_BASE64`
- `MACOS_APPLICATION_CERTIFICATE_PASSWORD`
- `MACOS_INSTALLER_CERTIFICATE_P12_BASE64`
- `MACOS_INSTALLER_CERTIFICATE_PASSWORD`
- `APPLE_API_KEY_P8_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Environment variable:

- `APPLE_TEAM_ID`: Developer ID Application ve Developer ID Installer sertifikalarının beklenen
  10 karakterli Team ID'si.

Application ve Installer sertifikaları ayrı geçici P12 dosyalarına, App Store Connect API key ise
geçici P8 dosyasına açılır. Raw secret değerleri komut argümanlarına veya release kanıtına yazılmaz.

## Fail-Closed Sıra

1. Checkout SHA, `main`, package/lock version eşleşmesi ve `v0.1.3`'ten farklı patch sürümü
   doğrulanır.
2. Electron app Developer ID Application ile hardened runtime altında imzalanır. PKG Developer ID
   Installer ile imzalanır.
3. Electron Builder app bundle'ı notarize edip ticket'ı staple eder. Üretilen DMG ve PKG ayrı
   `notarytool submit --wait` çağrılarıyla notarize edilir ve her birine kendi ticket'ı staple edilir.
4. DMG ve updater ZIP içindeki `.app` için `codesign --deep --strict`, Developer ID authority,
   Team ID, bundle ID, hardened runtime, entitlements, `stapler validate` ve Gatekeeper execute
   assessment çalışır.
5. PKG için `pkgutil --check-signature`, Developer ID Installer Team ID, `stapler validate` ve
   Gatekeeper install assessment çalışır. DMG için primary-signature Gatekeeper assessment zorunludur.
6. `latest-mac.yml`, updater ZIP'in exact SHA-512, byte size, filename ve package version değerleriyle
   karşılaştırılır. DMG stapling sırasında değiştiği için updater metadata'sına alınmaz;
   `dmg.writeUpdateInfo=false` stale DMG hash'i üretimini önler.
7. DMG, PKG, ZIP, ZIP blockmap ve `latest-mac.yml` SHA-256 değerleri exact source
   SHA/version/workflow/run bilgisiyle `macos-release-provenance.json` ve `SHA256SUMS-macos.txt` içine
   yazılır. Tüm artifact ve manifestler GitHub OIDC ile Sigstore bundle'a bağlanır ve aynı job içinde
   exact workflow/ref/SHA ile doğrulanır.

## Updater ve Sparkle Ayrımı

Repo'da gerçek `electron-updater` dependency'si, GitHub publish config'i, packaged-build updater
başlatma kodu ve `latest-mac.yml` sözleşmesi vardır. Bu nedenle release hattı imzalı/notarize updater
ZIP'ini ve hash metadata'sını kanıta dahil eder.

Doğrudan Sparkle SDK dependency/config'i yoktur; bu change sahte bir Sparkle entegrasyonu eklemez.
Uygulama içi update davranışı ve rollout politikası ayrı auto-updater işi (#11 / PR-desktop-10)
kapsamındadır. Bu hattın kanıtladığı sınır, macOS update payload'ının Developer ID imzalı olması ve
metadata'nın exact payload'a bağlanmasıdır.

## İnsan Kapıları

- Aktif Apple Developer Program üyeliği ve geçerli Developer ID Application/Installer sertifikaları
- App Store Connect notarization API key sahibi/onayı
- GitHub protected environment reviewer onayı ve production secret owner yönetimi
- Gerçek cihazda ilk çalıştırma, mikrofon/screen-recording TCC attended consent ve gerçek audio smoke

Kaynak/CI hattı bu insan ve cihaz kapılarını ikame etmez. Üretilmiş eski unsigned paketler acceptance
kanıtı olarak kullanılmaz.

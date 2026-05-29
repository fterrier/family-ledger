# Mobile Client

This client is a Flutter app for iOS and Android that provides mobile-friendly journeys for
the family-ledger system.

It is designed for on-the-go operations:

- add a cash transaction quickly from anywhere
- (future) import a bank statement shared from your banking app
- (future) view recent transactions and spending

The app is a client of the API. It is not the source of truth.

## Requirements

- A running `family-ledger` API reachable from your phone
- An API token configured on the server
- iOS 12+ or Android 5.0+ (API 21+)

Recommended remote access setup:

- run `family-ledger` on-prem with Docker Compose
- connect your phone via [Tailscale](https://tailscale.com/) — free for personal use
- use the Tailscale IP as the API URL in the app settings

## Getting Started (local development)

**Install Flutter:**

```bash
brew install --cask flutter
flutter doctor
```

**Run the app:**

```bash
cd clients/mobile
flutter pub get
flutter run        # requires a connected device or simulator
```

## First-time Setup

1. On first launch the app opens the Settings screen
2. Enter your API URL (e.g. `http://100.64.x.x:8000`)
3. Enter your API token
4. Tap **Test Connection** to verify
5. Tap **Save** — the app loads your account list and opens the main screen

## Adding a Cash Transaction

1. Enter the amount and select the currency (default: CHF)
2. Tap the date to change it (defaults to today)
3. Tap **From** to select your cash/wallet account
4. Tap **To** to select the expense category
5. Optionally enter a payee
6. Tap **Add Transaction**

The app remembers your last-used **From** account across sessions.

## Running Tests

```bash
flutter test
```

## Distribution

### iOS — Web Distribution (EU, iOS 17.4+)

Uses the EU Digital Markets Act alternative distribution path: family members install
directly from a Safari link, no App Store or TestFlight app required.

To release a new build, trigger the **Mobile Release** GitHub Actions workflow with a build
number. The workflow builds and notarizes the IPA, then publishes an install page to GitHub
Pages at `https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO/`. Share that URL with family.

Before the first release, complete the one-time setup:

1. In your Apple Developer account, request the **Web Distribution** capability (under
   Account → Certificates, Identifiers & Profiles → Identifiers → your App ID → Capabilities)
2. Create an **Alternative Distribution** provisioning profile (not App Store)
3. Generate an App Store Connect API key (used for notarization) and add secrets:
   - `APPLE_API_KEY_BASE64` — the `.p8` key file, base64-encoded
   - `APPLE_API_KEY_ID` — the key ID
   - `APPLE_API_ISSUER_ID` — the issuer ID
4. Export your distribution certificate and add secrets:
   - `APPLE_CERTIFICATE_BASE64` — the `.p12` file, base64-encoded
   - `APPLE_CERTIFICATE_PASSWORD` — the `.p12` export password
5. Export your provisioning profile and add secret:
   - `APPLE_PROVISIONING_PROFILE_BASE64` — the `.mobileprovision` file, base64-encoded
6. Add your Apple Developer Team ID as `APPLE_TEAM_ID` GitHub secret
7. Enable GitHub Pages on the repo (Settings → Pages → source: Deploy from branch `gh-pages`)

### Android — GitHub Release

The **Mobile Release** workflow builds a signed APK and attaches it to a GitHub Release.
Family members download and install the APK directly (enable "Install unknown apps" once).

Before the first release, generate a keystore and add it as GitHub secrets:

```bash
keytool -genkey -v -keystore upload-keystore.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias upload
```

Then add: `ANDROID_KEYSTORE_BASE64` (base64 of the `.jks` file),
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_STORE_PASSWORD`.

## See Also

- [docs/specs/mobile-client.md](../../docs/specs/mobile-client.md) — canonical spec
- [docs/guides/deployment.md](../../docs/guides/deployment.md) — server deployment and Tailscale setup

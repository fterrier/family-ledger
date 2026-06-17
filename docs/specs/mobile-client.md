# Mobile Client

## Purpose

The mobile client is a Flutter app (iOS and Android) for family members to interact with
the family-ledger system from their phones. It connects to the self-hosted API over Tailscale.

The app is a client of the API. It is not the source of truth. All writes go through the API.

## Journeys

### Journey 1: Add Cash Transaction (MVP)

The primary use case. A family member records a cash expense on the spot.

**User flow:**

1. Open the app — the Add Transaction screen is the home screen.
2. Enter an amount and select currency (default: CHF).
3. Optionally change the date (defaults to today).
4. Tap **From** to select a source account (typically a cash or wallet account).
   The picker searches all active accounts with fuzzy ordered-character matching.
   The last-used From account is pre-selected.
5. Tap **To** to select a destination account (typically an expense category).
6. Optionally enter a payee.
7. Tap **Add Transaction**.

**API call:**

```
POST /transactions
{
  "transaction": {
    "transaction_date": "YYYY-MM-DD",
    "payee": "…",
    "postings": [
      { "account": "accounts/acc_…", "units": { "amount": "-42.50", "symbol": "CHF" } },
      { "account": "accounts/acc_…", "units": { "amount":  "42.50", "symbol": "CHF" } }
    ]
  }
}
```

The app builds two balanced postings: a credit on the From account (negative amount) and
a debit on the To account (positive amount).

### Journey 2: Import Statement

A family member shares a bank statement file (e.g. MT940 `.sta`) from their banking app
directly to the family-ledger app via the OS share sheet (iOS) or share intent (Android).
The import screen can also be opened via the upload icon in the AppBar, where a file picker
allows choosing a file directly.

The app shows the available importers (`GET /importers`), the user selects one, and the
file is uploaded (`POST /importers/{name}:import`). The result shows entity counts (created,
duplicate, errors with examples) and any warnings.

### Journey 3: Transaction List (future)

A basic read-only view of recent transactions (`GET /transactions?from_date=…&to_date=…`)
with simple filtering by account. Intended for quick balance checks and reviewing recent
entries.

## Screen Inventory

| Screen | Route | Description |
|---|---|---|
| Settings | `/settings` | API URL + token configuration, connection test |
| Home / Add Transaction | `/` | Main cash transaction form |
| Account Picker | modal push | Full-screen searchable list of active accounts |
| Import Statement | `/import` | Importer selection + file upload + results |
| (future) Transaction List | `/transactions` | Paginated recent transactions |

## API Surface

| Endpoint | Used by |
|---|---|
| `GET /healthz` | Settings — connection test |
| `GET /accounts?page_size=200` | Account picker — loads all pages, cached in-session |
| `POST /transactions` | Add Transaction — creates a two-posting cash transaction |
| `GET /importers` | Import Statement |
| `POST /importers/{name}:import` | Import Statement |
| `GET /transactions` | (future) Transaction List |

## Auth Model

All requests include `Authorization: Bearer {token}`. The token is stored in the OS secure
storage (iOS Keychain, Android Keystore) via `flutter_secure_storage`. It is never stored
in plain text or `SharedPreferences`.

The base URL is also stored in secure storage. Both are configured on first launch via the
Settings screen.

## Platform Requirements

| | iOS | Android |
|---|---|---|
| Minimum version | iOS 12 | API 21 (Android 5.0) |
| Secure storage | Keychain (requires `keychain-access-groups` entitlement) | Android Keystore |
| Share target | Share Extension + `CFBundleDocumentTypes` in `Info.plist` (requires Xcode App Group setup for `receive_sharing_intent`) | `ACTION_SEND` intent filter in `AndroidManifest.xml` |

## Account Picker Search

The account picker uses an ordered-character fuzzy match: every character in the query must
appear in the candidate in order, but not necessarily consecutively. This matches the same
algorithm used in the Google Sheets client (`isOrderedCharacterMatch_`).

Examples:
- `"efr"` matches `Expenses · Food · Restaurant`
- `"aw"` matches `Assets · Cash · Wallet`
- `"chf"` does not match `Assets · Cash · Wallet` (h not in order)

## Last-used From Account

The account name of the last successfully submitted transaction's From account is stored in
`SharedPreferences` (key: `last_from_account_name`). It is pre-selected in the account
picker on next open. This is not sensitive data; it does not require secure storage.

## Out of Scope

- Multi-posting transactions (splits, FX, investments) — use the Google Sheets client
- Account creation or editing
- Balance assertion creation
- Importer configuration — use the Google Sheets client
- Offline mode — the app requires a reachable API
- Push notifications

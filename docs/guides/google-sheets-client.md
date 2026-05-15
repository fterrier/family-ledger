# Google Sheets Client Guide

## Purpose

Use this guide when changing the Apps Script client.

## Keep These Boundaries Intact

- the spreadsheet is not canonical state
- hot paths should avoid whole-sheet rewrites when a targeted row update is enough
- spreadsheet-local preferences belong in document properties
- persistent importer settings belong on the server

## When To Update Docs

- menu or dialog flow changes: update `docs/specs/google-sheets-client.md` and `clients/google-sheets/README.md`
- sheet schema changes: update `docs/specs/google-sheets-client.md`
- Apps Script scope changes: update `clients/google-sheets/docs/permissions.md`
- performance-sensitive flow changes: update `clients/google-sheets/docs/performance.md`

## Files To Review For Common Changes

- `App.js`: menu wiring
- `LedgerSync.js`: sync path
- `TransactionEdits.js` and `TransactionSave.js`: save lifecycle
- `QuickAddTransaction.js` and `SheetSettings.js`: quick-add workflow
- `ImporterDialogs.js`: importer settings and import flow
- `Constants.js`: managed sheet layout and column metadata

## Verification

- run `npm run check`
- run `npm test`
- manually sanity-check menu names and dialog labels when UI text changes

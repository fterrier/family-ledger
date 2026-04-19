# Family Accounting Platform Requirements v0.1

## Goal
Build a self-hosted, API-first family accounting system with Beancount-like accounting semantics, transactional multi-user support, and deterministic export to Beancount syntax for read-only Beancount tools such as Fava.

The system replaces the single-file Beancount workflow as the operational source of truth while preserving the accounting behavior already used in the current ledger.

## Product Positioning
- Self-hosted
- Multi-user
- API-first
- Database-backed
- Beancount-compatible through export, not through native file storage
- Open source and hosted on GitHub

Not a:
- collaborative editor for a `.beancount` file
- budgeting-only app
- general ERP
- tax engine

## Core Principles
- Keep the ledger model close to Beancount: transactions, postings, accounts, commodities, prices.
- Use a database as the source of truth.
- Export Beancount deterministically for tooling compatibility.
- Keep the first version simple; avoid unnecessary domain objects.

## Governance
- The project must be released under an open source license.
- The canonical project home is GitHub.
- Any external work, tool, or idea that materially influences the design should be explicitly linked and quoted in the docs.
- Documentation should follow the standard expected of a well-established open source project.

## Minimal Domain Model
The core model should stay Beancount-like and small:
- user / actor
- account
- commodity
- price
- transaction
- posting
- balance assertion
- import job
- import item
- attachment
- audit log

This is enough to support the current use cases without introducing special financial event types.

## Simple Plan Summary
For a fresh agent, the safest mental model is:
- store the ledger in a database
- model accounting with transactions and postings
- keep investment events as normal ledger entries, not special objects
- deduplicate imports during ingestion
- export deterministic Beancount for read-only Fava
- use Google Sheets only as a controlled API client for category edits

The main design goal is to preserve Beancount semantics without inheriting the single-file concurrency problem.

## Current Baseline
This project is not greenfield.

The current workflow already relies on:
- a large Beancount ledger file as the operational source of truth
- Fava and other Beancount read-only tools
- import scripts for bank/broker statements and PDFs/CSVs/MT940 files
- custom Beancount plugins and helper scripts

The new system should replace that workflow while preserving the same accounting semantics and import/export utility.

See `docs/roadmap-v0.1.md` for the implementation order, with deployment scaffolding intentionally moved early so tests can run before the full API exists.

## First Iteration Scope
There should be no dedicated UI in v1. See `docs/roadmap-v0.1.md` for the implementation order.

## Core Requirements

### Ledger Model
- Double-entry accounting
- Account hierarchy compatible with Beancount-style naming
- Assets, liabilities, equity, income, and expenses
- Transactions composed of postings
- Multi-currency support
- Arbitrary commodities and symbols
- Stocks and pension-specific commodities
- Per-posting quantity and commodity support
- Lot/cost tracking where needed
- Price history
- Strict transaction balancing
- Balance assertions with project-level configurable precision/tolerance

### Multi-User
- At least two users can concurrently add, import, categorize, and review transactions
- Database transactions must protect against concurrent corruption
- Every change must be attributable to a user or system actor

### Imports
- File-based imports from phone or computer
- Bank, broker, PDF, CSV, and manual imports
- Import lineage must be preserved
- Deduplication must be part of import processing
- Native source IDs should be used when available
- Fingerprints should be used when native IDs are unavailable
- Imported data must be reviewable before posting
- Import tracking should stay simple in v1: `import_jobs` for one run, `import_items` for the parsed records inside it

### Categorization
- Easy categorization for non-technical users
- Rule-based categorization support
- Bulk edits for imported transactions
- Spreadsheet-like editing may exist, but only through safe API-controlled fields

### API-First
- All major operations available via API
- Frontends consume the same API
- API must support reads, writes, imports, categorization, balances, prices, and exports

### Beancount Export
- Deterministic machine-generated Beancount export
- Export should be syntax-equivalent to valid Beancount output
- Export is the interoperability layer for Fava and other read-only Beancount tools
- Export style should be machine-friendly and stable, not hand-authored-looking

## Investment Requirements
The system only needs to support the investment use cases present in the current ledger.

Keep the investment model simple:
- dividends, withholding tax, gains, commissions, and vesting should all just be normal postings inside transactions
- do not create separate special-case financial event models unless they are required later
- account and lot tracking is the important part, not a richer event hierarchy

### Must Support
- Broker cash in multiple currencies
- Security purchases and sales with lot/cost basis
- Dividends as normal transactions
- Withholding tax as normal transactions
- Realized gains/losses as normal postings
- Commissions and fees as normal postings
- Employer stock vesting
- Share sales after vesting
- Broker-to-broker and broker-to-bank transfers
- Price history for securities and FX
- Custom pension commodities such as `P2CHF` and `P3CHF`
- Pension deposits, distributions, and balance checks

### Not Required in v1
- Options
- Margin
- Short selling
- Complex corporate actions
- Tax optimization
- Full brokerage analytics

## Validation Requirements
- Every transaction must balance
- Balance assertions must be strict
- Decimal precision tolerance must be configurable at the project level, similar to Beancount
- Account open/close constraints must be enforced
- Commodity constraints must be enforced where configured
- Lot/cost integrity must be enforced
- Balance assertions are not the same thing as reconciliation; reconciliation can stay lightweight or be deferred

## Change Management
- Draft entries may be edited freely
- Posted entries may be edited, with audit history retained
- All changes must store actor metadata and timestamps
- Assertions may be imported or authored; both are stored uniformly with origin metadata
- Explicit adjustment transactions are supported
- `pad`-style auto-adjustments are not required
- Keep control rules minimal in v1; prefer straightforward edits plus audit history over heavy approval workflows

## Imports Data Model
For v1, keep import tracking simple:
- `import_jobs`: one upload or import run
- `import_items`: one parsed record within a job

Suggested meaning:
- `import_jobs` captures who imported what, when, and from which source type
- `import_items` captures one parsed line/event/statement fact, its dedupe fingerprint or native ID, and the outcome

Recommended fields:
- `source_type`
- `created_by`
- `created_at`
- `status`
- `native_id`
- `fingerprint`
- `raw_data`
- `parsed_data`
- `dedupe_match_type`
- `resulting_transaction_id`

This is enough for auditability without over-modeling imports.

## Sheets Integration
- Google Sheets may be used as a staging and categorization surface
- Sheets must not be the source of truth
- Sheets edits must go through the API
- Only safe fields should be editable from Sheets

## Reconciliation
In v1, reconciliation is not a major subsystem.

The system should support:
- balance assertions
- statement/document attachments
- import lineage
- optional account verification metadata

Reconciliation here means the human workflow of checking the ledger against a bank/broker statement. It is distinct from balance assertions and distinct from import deduplication.

For v1, keep it lightweight and do not build a large dedicated reconciliation engine.

## Non-Goals for v1
- Native mobile apps
- Broad bank aggregation platform
- Period locking
- Full reconciliation workflow
- Automatic `pad` generation
- Advanced AI assistant features

## Open Questions
- Should posted-entry edits be unrestricted or field-limited?
- Should the export support only full-ledger output in v1, or also filtered exports?
- Which import sources are needed first: bank statements, broker statements, PDFs, CSVs, or Sheets?
- Should the first UI prioritize import review or manual transaction entry?

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
- Keep stable API resource identity separate from mutable ledger-facing names where needed.
- Account renames and hierarchy changes must not require rewriting historical postings.
- Export Beancount deterministically for tooling compatibility.
- Keep the first version simple; avoid unnecessary domain objects.

## Governance
- The project must be released under an open source license.
- The canonical project home is GitHub.
- Any external work, tool, or idea that materially influences the design should be explicitly linked and quoted in the docs.
- Documentation should follow the standard expected of a well-established open source project.

## Minimal Domain Model
The core model should stay Beancount-like and small:
- account
- commodity
- price
- transaction
- posting
- balance assertion
- attachment

This is enough to support the current use cases without introducing special financial event types.

## Simple Plan Summary
For a fresh agent, the safest mental model is:
- store the ledger in a database
- model accounting with transactions and postings
- keep investment events as normal ledger entries, not special objects
- deduplicate imports during ingestion
- export deterministic Beancount for read-only Fava
- use Google Sheets as one possible API client for category edits

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
- Canonical stored transactions use explicit postings only
- Multi-currency support
- Arbitrary commodities and symbols
- Stocks and pension-specific commodities
- Per-posting quantity and commodity support
- Lot/cost tracking where needed
- Price history
- Double-entry balancing as the target accounting rule
- Balance assertions with project-level configurable precision/tolerance

### Multi-User
- At least two users can concurrently add, import, categorize, and review transactions
- Database transactions must protect against concurrent corruption
- v1 focuses on correctness under concurrent use, not on audit-grade attribution

### Imports
- File-based imports from phone or computer
- Bank, broker, PDF, CSV, and manual imports
- Import lineage must be preserved
- Deduplication must be part of import processing
- Native source IDs should be used when available
- Fingerprints should be used when native IDs are unavailable
- Transactions should carry enough metadata for idempotent import deduplication
- Imports should be create-or-skip in v1 and must not overwrite existing matching transactions
- Fingerprints act as duplicate hints and matching aids; they must not assume global uniqueness across all transactions

### Categorization
- Easy categorization for non-technical users
- Rule-based categorization support
- Bulk edits for imported transactions
- Categorization means assigning expense accounts to uncategorized imported bank transactions, including split categorization across multiple expense accounts

### API-First
- All major operations available via API
- Frontends consume the same API
- API must support reads, writes, imports, categorization, balances, prices, and exports

### Beancount Export
- Deterministic machine-generated Beancount export
- Export should be syntax-equivalent to valid Beancount output
- Export is the interoperability layer for Fava and other read-only Beancount tools
- Export style should be machine-friendly and stable, not hand-authored-looking
- v1 only requires full-ledger export

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
- Transactions with storable explicit postings may still be stored when unbalanced, but ledger diagnostics must surface them as derived issues
- Balance assertions must be strict
- Decimal precision tolerance must be configurable at the project level, with one required global default and optional per-symbol overrides
- Account open/close constraints must be enforced through account effective dates
- Commodity constraints must be enforced where configured
- Lot/cost integrity must be enforced through derived ledger diagnostics; v1 lot-booking diagnostics use FIFO only, with room for richer Beancount-like booking methods later
- Balance assertions are not the same thing as reconciliation; reconciliation can stay lightweight or be deferred

## Change Management
- Transactions may be edited freely in v1
- Assertions may be imported or authored; both are stored uniformly
- Explicit adjustment transactions are supported
- `pad`-style auto-adjustments are not required
- Keep control rules minimal in v1; defer locking and audit history beyond v1

## Sheets Integration
- Google Sheets may be used as a staging and categorization surface
- Sheets must not be the source of truth
- Sheets edits must go through the API
- Sheets may expose narrower workflows than the API, but v1 does not require server-enforced field restrictions

## Reconciliation
In v1, reconciliation is not a major subsystem.

The system should support:
- balance assertions
- statement/document attachments
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
- Which import sources are needed first: bank statements, broker statements, PDFs, CSVs, or Sheets?

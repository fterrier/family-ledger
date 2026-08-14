# ADR 0006: Transaction Normalization Boundary

## Status

Accepted

## Context

Some client workflows and some ledger syntaxes allow transaction input with an omitted posting amount that can be inferred from the other postings.

Canonical stored transactions in this project should remain explicit and stable. If incomplete postings were stored directly, their meaning would depend on hidden inference rules and could change implicitly when sibling postings change.

At the same time, forcing every client to reimplement interpolation would duplicate logic and increase the risk of inconsistent normalization behavior.

## Decision

Canonical stored transactions must contain only explicit postings.

Normalization and persistence are separate concerns, but they share one normalization-and-validation boundary:
- canonical persistence stores only explicit postings
- a normalization endpoint may accept narrowly defined incomplete postings and return the explicit result without persisting it
- transaction creation may accept the same narrowly defined incomplete form and must run the same normalization and validation logic before persistence
- normalization and creation must not drift into separate rule sets

In v1, the intended normalization scope is narrow:
- at most one posting may omit `units`
- at most one posting may provide `units.amount` with a missing `units.symbol`
- missing `cost` is not part of the supported normalization contract
- missing `price.amount` may be normalized when unambiguous within a balancing symbol group
- normalization must be unambiguous
- normalization follows Beancount balancing-weight semantics rather than a simplistic transaction-currency rule

In particular:
- if a posting has only units, balancing uses the units amount and symbol
- if a posting has a price and no cost, balancing uses the price symbol/value
- if a posting has a cost, balancing uses the cost symbol/value
- if a posting has both cost and price, cost wins for balancing
- if a posting has zero balancing weight, it does not create ambiguity

The current supported scope remains intentionally narrow:
- at most one posting may omit `units`
- at most one posting may omit `units.symbol`
- the missing posting may normalize into one or more explicit postings, one per resulting balancing weight
- multi-weight normalization is supported when the balancing weights are explicit and unambiguous
- at most one posting per balancing symbol group may omit `price.amount`

The persisted transaction and the returned normalized transaction must both be explicit.

This follows Beancount's own model of posting weight and amount interpolation. Relevant references include:
- Beancount language syntax: "Balancing Rule - The weight of postings"
- Beancount language syntax: "Amount Interpolation"
- Beancount "How Prices are Used"

**Interaction with accountless postings (ADR 0012, added later)**: interpolation sums every posting's weight, including accountless ones — it is pure Decimal math to make a payload add up to zero and has no reason to be aware of categorization status. This is deliberately different from the accounted-only exclusion ADR 0012 uses for its "still needs categorizing" checks (doctor's unbalanced check, and the persist-time decision to add a balancing filler posting) — those are categorization questions, not arithmetic ones. Conflating the two (reusing the accounted-only sum for interpolation) was a real bug, in two places that share the same balancing-weight dict: a transaction whose only other postings were all accountless had nothing to interpolate a missing-units posting against (a loud `ambiguous_interpolation_symbol` error); more seriously, the missing-`price.amount` inference case (this ADR's own "missing price.amount may be normalized when unambiguous" bullet above) *silently* fell back to a balancing weight of zero for the same reason — no error, just a wrong inferred price.

## Consequences

Positive:
- canonical stored ledger state remains explicit and stable
- clients can reuse one server-side normalization path instead of reimplementing interpolation logic independently
- normalization and creation stay aligned because they share the same rule path
- the boundary between convenience behavior and canonical persistence stays clear

Negative:
- the API surface gains an additional normalization endpoint/concept
- the service layer must keep normalization and persistence preparation cleanly separated
- interpolation rules must be specified carefully and tested separately from persistence

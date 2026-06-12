from __future__ import annotations

import argparse
import sys

from sqlalchemy.engine import Engine

from family_ledger import db
from family_ledger.models import Base

# Maps CLI entity names to their SQLAlchemy table objects.
# Posting is excluded: it cascades from transaction.
_ENTITY_TABLES = {
    name: table
    for name, table in {
        "account": Base.metadata.tables["accounts"],
        "commodity": Base.metadata.tables["commodities"],
        "transaction": Base.metadata.tables["transactions"],
        "price": Base.metadata.tables["prices"],
        "balance_assertion": Base.metadata.tables["balance_assertions"],
        "attachment": Base.metadata.tables["attachments"],
    }.items()
}
VALID_ENTITIES = set(_ENTITY_TABLES)


def wipe_database(engine: Engine | None = None) -> None:
    _engine = engine or db.engine
    with _engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            conn.execute(table.delete())


def wipe_entities(entities: list[str], engine: Engine | None = None) -> None:
    _engine = engine or db.engine
    with _engine.begin() as conn:
        for entity in entities:
            conn.execute(_ENTITY_TABLES[entity].delete())


def main() -> None:
    parser = argparse.ArgumentParser(description="Delete all rows from all database tables.")
    parser.add_argument("--yes", action="store_true", help="Skip confirmation prompt")
    parser.add_argument(
        "--entity",
        metavar="NAME[,NAME...]",
        help=(
            f"Comma-separated list of entities to wipe. Valid values: "
            f"{', '.join(sorted(VALID_ENTITIES))}. "
            f"If omitted, all tables are wiped."
        ),
    )
    args = parser.parse_args()

    entities: list[str] | None = None
    if args.entity:
        entities = [e.strip() for e in args.entity.split(",") if e.strip()]
        invalid = [e for e in entities if e not in VALID_ENTITIES]
        if invalid:
            parser.error(
                f"Unknown entities: {', '.join(invalid)}. "
                f"Valid values: {', '.join(sorted(VALID_ENTITIES))}"
            )

    if entities:
        description = f"entities: {', '.join(entities)}"
    else:
        description = "all data"

    if not args.yes:
        confirm = input(f"This will permanently delete {description}. Type 'yes' to confirm: ")
        if confirm.strip().lower() != "yes":
            print("Aborted.")
            sys.exit(1)

    if entities:
        wipe_entities(entities)
    else:
        wipe_database()
    print(f"Wiped {description}.")


if __name__ == "__main__":
    main()

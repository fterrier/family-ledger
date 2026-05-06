from __future__ import annotations

import argparse
import sys

from sqlalchemy.engine import Engine

from family_ledger import db
from family_ledger.models import Base


def wipe_database(engine: Engine | None = None) -> None:
    _engine = engine or db.engine
    with _engine.begin() as conn:
        Base.metadata.drop_all(conn)


def recreate_all_tables(engine: Engine | None = None) -> None:
    _engine = engine or db.engine
    with _engine.begin() as conn:
        Base.metadata.create_all(conn)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Wipe all database tables and recreate them empty."
    )
    parser.add_argument("--yes", action="store_true", help="Skip confirmation prompt")
    args = parser.parse_args()

    if not args.yes:
        confirm = input("This will permanently delete all data. Type 'yes' to confirm: ")
        if confirm.strip().lower() != "yes":
            print("Aborted.")
            sys.exit(1)

    wipe_database()
    print("All tables dropped.")

    recreate_all_tables()
    print("All tables recreated.")

    print("Database wipe complete.")


if __name__ == "__main__":
    main()

# Modular Import System Implementation Plan v0.1

## Goal

Create a modular system to import transactions and related ledger data from external file
formats. Importers are Python classes living in a separate installable package that can be
split out later. The system exposes API endpoints to manage persistent importer configuration
and trigger imports. The Beancount importer will be migrated to this system once it is made
idempotent.

## Design Decisions

### 1. Monolithic Python Importers

Importers inherit from `BaseImporter` and live in `importers/src/family_ledger_importers/`.
The integration boundary (`BaseImporter`, `ImportResult`, registry) lives in
`src/family_ledger/importers/`. There is no network hop, no external process.

An earlier webhook-based architecture was considered and is preserved as a reference idea
at `docs/future_ideas/modular-import-system-v0.1.md`.

### 2. One-Step Execute

There is no separate parse/import split. Each importer implements a single
`execute(session, file_data, config) -> ImportResult` method that both parses input and
writes to the database. This gives each importer full control over which entity types it
creates without requiring a rich intermediate data structure to express the full entity
graph.

### 3. Idempotency Contract

Imports do not use a single atomic commit. Instead, each import must be idempotent:
re-running it produces the same result without creating duplicates. Importers must handle
`ConflictError` from service calls and count those as duplicates. Partial failures leave
whatever was already written; a re-run will skip those and continue. This matches the
create-or-skip contract from ADR 0004.

### 4. Importer Discovery via Entry Points

Importer classes are discovered at startup using the standard Python entry points mechanism
(`importlib.metadata`). Each installable importer package declares its importers under the
`family_ledger.importers` entry point group. No uv workspace constructs are required;
standard `pip install ./importers` works anywhere.

### 5. Auto-Bootstrap (1:1 Mapping)

On startup, the registry scans discovered importers and creates one `Importer` DB row per
importer if none exists. This is a create-only operation; it never removes rows for importers
that are no longer installed. The 1:1 mapping is enforced via a unique constraint on
`plugin_name`. A 1:N model can be added later by exposing `POST /importers`.

### 6. `display_name` is Code-Authoritative

`display_name` is defined on the importer class and is not stored in the database.
`GET /importers` injects it from the in-memory registry at query time. Only `config` is
persisted.

### 7. AIP-Compliant Endpoints

Endpoints follow AIP-122 resource naming (`importers/imp_XXXX`) using the existing
`generate_resource_name` helper with an `imp` prefix. Standard methods follow AIP-132
(List), AIP-134 (Update), and AIP-136 (custom method `:import`).

---

## Architecture

### BaseImporter Interface

```python
# src/family_ledger/importers/base.py

class BaseImporter(ABC):
    name: str          # class-level, e.g. "beancount"
    display_name: str  # class-level, e.g. "Beancount"

    def get_schema(self) -> dict[str, Any]:
        return {}  # default: no configuration required

    @abstractmethod
    def execute(
        self,
        session: Session,
        file_data: bytes,
        config: dict[str, Any],
    ) -> ImportResult: ...
```

### ImportResult

```python
# src/family_ledger/importers/base.py

class EntityErrors(BaseModel):
    count: int = 0
    examples: list[str] = Field(default_factory=list)  # capped at MAX_SKIPPED_EXAMPLES_PER_REASON

class EntityCounts(BaseModel):
    created: int = 0
    duplicate: int = 0   # already existed (ConflictError idempotency skip)
    errors: EntityErrors = Field(default_factory=EntityErrors)

class ImportResult(BaseModel):
    entities: dict[str, EntityCounts] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
```

`entities` is keyed by entity type name (e.g. `"account"`, `"transaction"`). The dict is
sparse: keys are only present if the importer touched that entity type. Transaction-centric
importers only populate `entities["transaction"]`; full-ledger importers like Beancount
populate all five types.

Example response:
```json
{
  "entities": {
    "account":           {"created": 3, "duplicate": 0, "errors": {"count": 0, "examples": []}},
    "transaction":       {"created": 10, "duplicate": 1, "errors": {"count": 2, "examples": ["2026-04-01 Migros Groceries: Unsupported amount..."]}},
    "commodity":         {"created": 1, "duplicate": 0, "errors": {"count": 0, "examples": []}},
    "price":             {"created": 5, "duplicate": 0, "errors": {"count": 0, "examples": []}},
    "balance_assertion": {"created": 2, "duplicate": 0, "errors": {"count": 0, "examples": []}}
  },
  "warnings": ["Unrecognized entry type: Custom (2 occurrences)"]
}
```

### Registry

```python
# src/family_ledger/importers/registry.py

_importers: dict[str, type[BaseImporter]] | None = None

def get_importers() -> dict[str, type[BaseImporter]]:
    global _importers
    if _importers is None:
        _importers = {ep.name: ep.load() for ep in entry_points(group="family_ledger.importers")}
    return _importers

def get_importer(plugin_name: str) -> type[BaseImporter] | None:
    return get_importers().get(plugin_name)

def bootstrap_importers(session: Session) -> None:
    for plugin_name in get_importers():
        existing = session.scalar(select(Importer).where(Importer.plugin_name == plugin_name))
        if existing is None:
            session.add(Importer(
                name=generate_resource_name("importers", "imp"),
                plugin_name=plugin_name,
                config={},
            ))
    session.commit()
```

`get_importers()` loads entry points once and caches the result for the process lifetime.
`get_importer()` is the lookup used by the service layer per request.

If no importers are installed, `get_importers()` returns empty and startup succeeds normally
with zero importers available. Startup must not fail when the importers package is absent.

### DB Model

```python
# src/family_ledger/models/importer.py

class Importer(Base):
    __tablename__ = "importers"

    id: Mapped[int] = mapped_column(id_type, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, unique=True)
    plugin_name: Mapped[str] = mapped_column(Text, unique=True)
    config: Mapped[dict[str, Any]] = mapped_column(json_type, default=dict)
```

`display_name` is intentionally absent; it comes from the importer class at query time.

### Service Layer Responsibilities

`services/importer.py` orchestrates the following for `execute_import`:

1. Fetch the `Importer` DB row.
2. Look up the importer class using `get_importer(importer.plugin_name)`. Return 404 if the
   importer is no longer installed.
3. Merge `importer.config` with `config_override` (override wins on key conflicts).
4. Validate the merged config against `importer.get_schema()` using `jsonschema.validate()`.
   If invalid, clear `importer.config` to `{}` in the DB (self-heal from schema drift),
   re-merge `{}` with `config_override`, and re-validate. Return 400 if still invalid.
5. Instantiate the importer and call `importer.execute(session, file_data, merged_config)`.
6. Return `ImportResult`.

`PATCH /importers/{importer}` uses the same `jsonschema.validate()` call on the incoming
config before persisting it; returns 400 immediately without the self-heal step.

Config validation must happen before `execute()` is called. Importers must not re-validate
their own config.

---

## Module Structure

```
src/family_ledger/
  importers/
    __init__.py
    base.py         # BaseImporter, ImportResult, EntityCounts, EntityErrors
    registry.py     # get_importers(), get_importer(), bootstrap_importers()
  models/
    importer.py     # Importer SQLAlchemy model
  services/
    importer.py     # list, patch config, execute_import
  api/
    importer.py     # FastAPI router

importers/
  pyproject.toml    # standalone package; declares entry points
  src/
    family_ledger_importers/
      __init__.py
      beancount.py  # BeancountImporter(BaseImporter)
```

### importers/pyproject.toml (key excerpt)

```toml
[project]
name = "family-ledger-importers"
dependencies = [
    "family-ledger",
    "beancount>=3.2.0",
]

[project.entry-points."family_ledger.importers"]
beancount = "family_ledger_importers.beancount:BeancountImporter"
```

### Dockerfile install order

```dockerfile
COPY . .
RUN pip install .
RUN pip install ./importers
```

`family-ledger` must be installed before `family-ledger-importers` because the importer
package imports `BaseImporter` from it.

---

## API Endpoints

### `GET /importers`

Returns all `Importer` DB rows, each enriched with `display_name` and `schema` from the
corresponding in-memory importer class. If an importer is no longer installed, the DB row
is still returned but `display_name` falls back to `plugin_name` and `schema` is empty
rather than failing the request.

### `PATCH /importers/{importer}`

Updates the persistent `config` of an importer. Validates the new config against
`importer.get_schema()` before persisting. Request body follows AIP-134:

```json
{
  "importer": {
    "name": "importers/imp_01jv3m0r7x8c",
    "config": {
      "bank_account": "accounts/acc_01jv3m0r7x8c"
    }
  },
  "update_mask": "config"
}
```

### `POST /importers/{importer}:import`

Accepts `multipart/form-data` with:
- `file`: binary file data
- `config_override`: optional JSON string merged on top of the persistent config

Executes the import synchronously and returns `ImportResult`.

---

## Detailed Workflows

### Bootstrap on Startup

1. `main.py` calls `bootstrap_importers(session)` inside `create_app()`, after
   `ping_database()`, using a short-lived `SessionLocal` session:
   ```python
   with SessionLocal() as session:
       bootstrap_importers(session)
   ```
2. For each discovered importer, create an `Importer` row if one with that `plugin_name`
   does not already exist.

### Executing an Import

1. `POST /importers/imp_01jv3m0r7x8c:import` is received.
2. Service fetches the `Importer` row and looks up the importer class.
3. Merges `importer.config` with `config_override`.
4. Validates merged config against `importer.get_schema()`.
5. Calls `importer.execute(session, file_data, merged_config)`.
6. Importer writes entities to the DB, counting created/duplicate/errors per entity type,
   and catching `ConflictError` per entity as a duplicate.
7. Returns serialized `ImportResult`.

---

## Implementation Files

| Action | File                                                          |
|--------|---------------------------------------------------------------|
| NEW    | `src/family_ledger/importers/__init__.py`                     |
| NEW    | `src/family_ledger/importers/base.py`                         |
| NEW    | `src/family_ledger/importers/registry.py`                     |
| NEW    | `src/family_ledger/models/importer.py`                        |
| MODIFY | `src/family_ledger/models/__init__.py`                        |
| NEW    | `alembic/versions/xxx_add_importer_table.py`                  |
| NEW    | `src/family_ledger/services/importer.py`                      |
| NEW    | `src/family_ledger/api/importer.py`                           |
| MODIFY | `src/family_ledger/main.py`                                   |
| NEW    | `importers/pyproject.toml`                                    |
| NEW    | `importers/src/family_ledger_importers/__init__.py`           |
| NEW    | `importers/src/family_ledger_importers/beancount.py`          |
| MODIFY | `pyproject.toml` (add `jsonschema>=4.0,<5.0` dependency)      |
| ARCHIVE | `docs/future_ideas/modular-import-system-v0.1.md` (webhook  |
|        | architecture; kept as a reference idea, not the active plan)  |

---

## BeancountImporter Scope

`BeancountImporter` is implemented by migrating the logic from the former
`scripts/import_beancount.py` (now removed) into a `BaseImporter` subclass. It retains
the existing `database_is_empty()` guard: the import returns an error if the database
already contains ledger data. It is **not** idempotent in v1.

Making `BeancountImporter` idempotent (removing the `database_is_empty()` guard, adding
skip-on-conflict for accounts and commodities) is a separate future task.

---

## Verification Plan

### Automated Tests

1. `tests/test_importers_registry.py`: entry point discovery and bootstrap behavior,
   including the zero-importers-installed case.
2. `importers/tests/test_beancount.py`: import logic on a sample Beancount file;
   verify correct entity counts and that re-running on a non-empty DB returns an error.
3. `tests/test_api_importer.py`: bootstrap, `GET /importers`, `PATCH /importers/{importer}`,
   file upload via `:import`, config override merging, schema validation rejection, and
   schema drift self-healing (stale persistent config is cleared and import proceeds).

### Manual Verification

1. Start the stack locally.
2. Confirm `GET /importers` lists the Beancount importer with its schema.
3. `PATCH` the importer with a valid config; verify it is persisted.
4. Run a Beancount import on an empty DB via `POST /importers/{importer}:import`.
5. Verify accounts, commodities, transactions, prices, and balance assertions are created.
6. Attempt to re-run the same import on the now-populated DB.
7. Verify the import fails with a clear error indicating the database is not empty.

---

## Known Gaps

- **Orphaned DB rows**: if an importer class is removed from code, its `Importer` DB row
  remains. Bootstrap is create-only. This is intentional in v1 to avoid surprising data
  loss; operators must clean up orphaned rows manually.
- **Schema drift**: if `get_schema()` changes between deployments, the stale persistent
  `config` may fail validation at import time. The service self-heals by clearing the
  persistent config to `{}` and retrying with just the `config_override`. Operators must
  re-`PATCH` any desired persistent config after a schema-breaking update.
- **Beancount not yet idempotent**: `BeancountImporter` retains the `database_is_empty()`
  guard. It can only run on an empty database. Idempotency work is a separate future task.
- **No 1:N importer profiles**: one importer maps to exactly one DB row in v1. Multiple
  profiles for the same importer require a future `POST /importers` endpoint.

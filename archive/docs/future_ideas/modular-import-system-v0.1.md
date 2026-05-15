# Modular Import System Implementation Plan

This document outlines the design and implementation plan for the new modular import system in `family-ledger`.

## Goal Description

Create a modular system to import transactions into the ledger. The system will support adding new import parsers (plugins) without rebuilding the main application container, allow persistent and per-run configurations for these plugins, and provide new API endpoints to manage and execute imports. The Beancount importer will be migrated to this new system as the first supported plugin.

## Finalized Design Decisions

> [!IMPORTANT]
> **1. Architecture: Webhook / Microservice**
> Because plugins often require their own complex dependencies (e.g., PDF parsers), we will use a **Webhook Architecture**. The Ledger will not run plugin code itself. Instead, importers will be separate standalone services. The Ledger will register their URL and send them files via HTTP, receiving parsed transactions back.
>
> **2. Streaming Import Execution**
> To avoid locking the main ledger and handle large files efficiently, the external Importer service will stream the normalized transactions back to the Ledger using **JSON Lines (NDJSON)**. The Ledger will read this stream line-by-line and write to the database continuously.
>
> **3. Push-Based Registration Protocol**
> When an Importer Service starts, it will register itself by calling `POST /import-plugins` on the main Ledger, sending its `plugin_name`, `webhook_url`, and its expected `schema`. The Ledger will save this Plugin registration and automatically ensure a default `Importer` is available for it (allowing `GET /importers` to expose it immediately). The frontend can then update this Importer's configuration.
>
> **4. Authentication**
> Securing the webhook and registration endpoints will be deferred to a later stage. For now, the internal network will be trusted.

## Decisions Made
- **Config Persistence**: The system will use two database tables to ensure decoupling: `ImportPlugin` (stores the webhook and schema of the parser) and `Importer` (stores the user's saved configuration for a specific plugin). Configs will use foreign keys where appropriate.
- **Import Behavior**: The `POST /importers/{importer}:import` endpoint will directly create the parsed transactions in the database.
- **Project Structure**: The core import system logic and user documentation will live within the main `family-ledger` application and docs. The `importers/` sub-folder will exclusively contain the actual plugins (e.g., `beancount`) and developer documentation on how to write new importers.

## Proposed Architecture

1. **Entities**:
   - **Import Plugin**: The registered definition of the external service (stored in DB or memory), containing the `plugin_name`, `webhook_url`, and `schema`.
   - **Importer**: A user-defined DB entity that binds a `config` (JSON) to an `Import Plugin`. An empty default one is created upon first plugin registration.
   - **Importer Service**: A standalone microservice (e.g., `beancount-importer`). It exposes a `POST /parse` endpoint that accepts a file and streams NDJSON transactions.

2. **Core API Endpoints (Ledger)**:
   - `POST /importPlugins`: Used by external services on startup to register themselves (Create/Update) and push their JSON Schema (Compliant with AIP-133 Create / AIP-134 Update). *Note: This automatically creates the default `Importer`.*
   - `GET /importers`: List available importers (AIP-132). Merges the Plugin's schema with the Importer's static config to provide UI overrides schema. The response will include an `is_available` boolean indicating if the external plugin service is currently running.
   - `PATCH /importers/{importerId}`: Update an importer's configuration (AIP-134).
   - `POST /importers/{importerId}:import`: Execute an import. Custom method (AIP-136). Accepts a file and an optional JSON config override. The Ledger forwards the file and merged config to the Plugin's service URL, and reads the NDJSON stream.

---

## Detailed Workflows

### 1. Plugin Registration & Schema Definition
When an Importer Service (e.g., `payslip-importer`) starts, it sends a `POST /importPlugins` to the Ledger.
**Payload Example:**
```json
{
  "plugin_name": "payslip",
  "service_url": "http://payslip-importer:8000/parse",
  "schema": {
    "type": "object",
    "properties": {
      "bank_account": {
        "type": "string",
        "title": "Bank Account for Payouts",
        "x-resource-type": "account"
      },
      "income_accounts": {
        "type": "object",
        "title": "Known Income Accounts Mapping",
        "description": "Keys are known ahead of time",
        "properties": {
          "Bonus": {"type": "string", "x-resource-type": "account"},
          "Healthcare": {"type": "string", "x-resource-type": "account"}
        }
      },
      "dynamic_securities": {
        "type": "object",
        "title": "Dynamic Securities Mapping (IB Example)",
        "description": "Keys are unknown until runtime",
        "additionalProperties": {
          "type": "string",
          "x-resource-type": "account"
        }
      }
    },
    "required": ["bank_account"]
  }
}
```
*Note 1: `x-resource-type: "account"` is a custom extension telling the UI that the field expects a valid Ledger Account ID/Name rather than a plain string.*
*Note 2: `properties` guarantees exact, pre-defined keys (e.g. "Bonus", "Healthcare"). `additionalProperties` means "any key is allowed, but the values must follow this schema" - it's used for dynamic mappings where keys (like IB tickers) are unknown until the user runs an import.*

When the Ledger receives this, it creates/updates the `ImportPlugin` record and ensures an empty `Importer` configuration exists.

### 2. Plugin Registration Lifecycle & Health
Since the Ledger and the Importer Plugins are separate services, they can start or stop independently.
- **Plugin Startup**: When a plugin starts, it attempts to call `POST /importPlugins`. If the main Ledger is not up yet, the plugin will use an exponential backoff retry loop (e.g., using the `tenacity` library) until it successfully registers.
- **Availability State**: The DB stores the fact that the plugin exists, but it might go offline. When the UI calls `GET /importers`, the Ledger will concurrently send a quick HTTP GET request to a `/healthz` endpoint on each registered plugin's `service_url`.
- **Response**: If the plugin responds 200 OK, the Ledger sets `is_available: true` in the API response. If it times out or the connection is refused, it sets `is_available: false`. This ensures the UI always accurately reflects which importers are actually running at that exact moment without needing complex state synchronization.

### 3. Client (UI) Discovers Importers
The user opens the "Import" tab in the UI. The UI calls `GET /importers`.
**Response Example:**
```json
{
  "importers": [
    {
      "name": "importers/12345",
      "display_name": "Monthly Payslip",
      "plugin_name": "payslip",
      "is_available": true,
      "config": {},
      "schema": { ... } // The JSON schema provided during registration
    }
  ]
}
```
The UI parses the `schema`. Seeing `x-resource-type: "account"`, it knows to render an autocomplete Account Selector dropdown instead of a text input. For `income_accounts`, it renders a dynamic list of Key-Value pairs where the Key is a text input and the Value is the Account Selector.

### 4. Client Overrides Default Config
The user wants to set a persistent configuration so they don't have to select the `bank_account` every month. The UI sends a `PATCH /importers/12345`.
**Payload:**
```json
{
  "config": {
    "bank_account": "Assets:Bank:Checking",
    "income_accounts": {
      "Bonus": "Income:Salary:Bonus"
    }
  }
}
```
The Ledger validates this config against the plugin's JSON Schema. If valid, it saves it in the DB.

### 5. Executing an Import with Overrides
The user uploads their monthly PDF. They also want to specify a one-off override for an expense account just for this run. The UI sends `POST /importers/12345:import` using `multipart/form-data`.
**Payload:**
- `file`: (binary PDF data)
- `config_override`: `{"dynamic_securities": {"AAPL": "Assets:Stocks:AAPL"}}`

**Execution Flow:**
1. The Ledger merges the DB config with the `config_override`:
   ```json
   {
     "bank_account": "Assets:Bank:Checking",
     "income_accounts": {"Bonus": "Income:Salary:Bonus"},
     "dynamic_securities": {"AAPL": "Assets:Stocks:AAPL"}
   }
   ```
2. The Ledger validates the merged config against the schema.
3. The Ledger streams the file and the merged config to `http://payslip-importer:8000/parse` (the `service_url`).
4. The Importer Service reads the PDF, uses the config to map strings to ledger accounts, and yields `TransactionNormalizeData` as NDJSON.
5. The Ledger reads the NDJSON stream and saves transactions into the database.

---

## Proposed Changes

### Database Schema & Models

#### [NEW] [models/importer.py](file:///Users/francoisterrier/projects/family-ledger/src/family_ledger/models/importer.py)
Create SQLAlchemy models compatible with the current architecture (`id` as integer PK, `name` as string resource name):
1. `ImportPlugin`:
   - `id` (BigInteger, PK, autoincrement)
   - `name` (Text, unique) -> e.g. `"importPlugins/payslip"`
   - `plugin_name` (Text, unique) -> e.g. `"payslip"` (used for internal reference)
   - `service_url` (Text)
   - `schema` (JSONB)
2. `Importer`:
   - `id` (BigInteger, PK, autoincrement)
   - `name` (Text, unique) -> e.g. `"importers/12345"`
   - `display_name` (Text) -> e.g. `"My Payslip Importer"` (User-friendly mutable name)
   - `plugin_id` (FK to ImportPlugin.id)
   - `config` (JSONB, stores the static configuration)

#### [MODIFY] [alembic/env.py](file:///Users/francoisterrier/projects/family-ledger/alembic/env.py) or `models/__init__.py`
Register the new model.

#### [NEW] [alembic/versions/xxx_add_importer_model.py](file:///Users/francoisterrier/projects/family-ledger/alembic/versions/)
Autogenerated migration.

---

### Core Import System (Main Project)

#### [NEW] [src/family_ledger/services/importer.py](file:///Users/francoisterrier/projects/family-ledger/src/family_ledger/services/importer.py)
Business logic for managing importers and triggering imports. This will contain the `PluginRegistry` logic (how plugins are loaded depends on your choice in the alternatives above).

#### [NEW] [src/family_ledger/api/schemas/importer.py](file:///Users/francoisterrier/projects/family-ledger/src/family_ledger/api/schemas/importer.py)
Pydantic schemas for importers and plugin responses.

#### [NEW] [src/family_ledger/api/importer.py](file:///Users/francoisterrier/projects/family-ledger/src/family_ledger/api/importer.py)
FastAPI router containing the endpoints.

#### [MODIFY] [src/family_ledger/main.py](file:///Users/francoisterrier/projects/family-ledger/src/family_ledger/main.py)
Include the new `importer` router and initialize the plugin system.

---

### Importers Sub-Project (Standalone Services & Dev Docs)

#### [NEW] [importers/beancount/](file:///Users/francoisterrier/projects/family-ledger/importers/beancount/)
A new standalone FastAPI service for parsing Beancount files.
- `main.py`: Startup event calls `POST /import-plugins` on the Ledger. Exposes `POST /parse` (streams NDJSON).
- `parser.py`: Logic migrated from `scripts/import_beancount.py`.
- `requirements.txt`: Specific dependencies (`beancount`).

#### [NEW] [importers/README.md](file:///Users/francoisterrier/projects/family-ledger/importers/README.md)
Developer documentation on how to build and register a new external importer service.

## Verification Plan

### Automated Tests
- API tests in `tests/api/test_importer.py` to verify importer creation and triggering imports via the `:import` endpoint (using mocked NDJSON streaming responses).
- Standalone unit tests for the Beancount parser service.

### Manual Verification
- Start the application using Docker Compose.
- Verify `GET /import-plugins` lists the configured plugins.
- Create an importer profile via `POST /importers` linking to a database account.
- Use `curl` to upload a sample file to `POST /importers/...:import` and verify transactions appear in the ledger.

# AI Agents Guide

This file is intended to optimize the context window for AI agents assisting with the `family-ledger` repository. It provides a quick overview of the repository structure, architectural patterns, and where to look to make specific types of changes.

## Project Overview
`family-ledger` is a DB-backed, API-first family accounting platform with Beancount-compatible export capabilities. It uses a modern Python stack: **FastAPI**, **Pydantic**, **SQLAlchemy 2.0**, and **PostgreSQL**.

Dependency management is standard Python, but **local development should be done using Docker**.

*(Note for AI Agents: If a file named `AGENTS_local.md` exists in the repository root, read it for local workspace overrides.)*

## Repository Structure

If you need to make a change, start by identifying the relevant domain below. You rarely need to read all files; follow these pointers:

- **`src/family_ledger/`**: Main application code.
  - **`api/`**: FastAPI routers, endpoints, and Pydantic schemas (`schemas.py`).
  - **`models/`**: SQLAlchemy ORM models (`ledger.py`).
  - **`services/`**: Core business logic and operations (e.g., `ledger.py`, `validation.py`, `balancing.py`).
  - **`config.py`**: Configuration loading and validation.
  - **`db.py`**: Database connection and session management.
- **`alembic/`**: Database migrations. `alembic/versions/` contains the migration scripts.
- **`tests/`**: Pytest suite. Mirrored structure to `src/family_ledger/`.
- **`config/`**: Default application configuration files (e.g., `ledger.yaml`).
- **`scripts/`**: Utility scripts (e.g., `bootstrap_demo.py`, `import_beancount.py`).
- **`docker/`**: Docker deployment configurations (`docker/compose/`).
- **`docs/`**: Extensive documentation (architecture, requirements, ADRs, etc.).
- **`clients/`**: Front-end clients, such as the Google Sheets client.

## Agentic Workflow & Vibe Coding Standards

To ensure smooth "vibe coding" and high-quality contributions, follow these rules:

1. **Read Before Writing**: Do not guess internal APIs or database schemas. Always use your tools to read `src/family_ledger/models/` or `src/family_ledger/api/schemas.py` before modifying logic.
2. **Consult Core Docs First**: Before proposing architectural changes or large refactors, read the relevant files in `docs/` (especially `domain-model-v0.1.md` and `developer-guidelines-v0.1.md`).
3. **Strict Typing**: This project enforces strict type checking (`basedpyright`). Use explicit type hints everywhere.
4. **Test-Driven / Verified Changes**: Never assume your code works. After making changes, write tests and actively run `pytest` to verify them before telling the user the task is complete.
5. **Small, Focused Edits**: Make targeted changes. Do not rewrite entire files unnecessarily or remove unrelated comments.

## Making Common Changes

### 1. Adding or Modifying an API Endpoint
- **Where to look**: `src/family_ledger/api/`
- **Steps**:
  1. Define the input/output models in `schemas.py`.
  2. Implement the endpoint logic in `ledger.py` or the relevant router.
  3. Ensure business logic is delegated to `src/family_ledger/services/`.
  4. Write/update tests in `tests/api/`.

### 2. Modifying the Database Schema
- **Where to look**: `src/family_ledger/models/` and `alembic/`
- **Steps**:
  1. Update the SQLAlchemy models in `src/family_ledger/models/`.
  2. Generate a new Alembic migration: run `alembic revision --autogenerate -m "description"` inside the docker container.
  3. Review the generated migration script in `alembic/versions/`.

### 3. Updating Business Logic (Validation, Ledger Rules)
- **Where to look**: `src/family_ledger/services/`
- **Steps**:
  1. Modify the relevant service (e.g., `validation.py`, `balancing.py`).
  2. Ensure the changes reflect in the overarching ledger service (`ledger.py`).
  3. Write/update unit tests in `tests/services/`.

### 4. Running Tools & Tests
- **Running the Project**: Prefer using local Docker via `docker compose`.
- **Testing**: Run `pytest`.
- **Linting & Formatting**: Run `ruff check` and `ruff format`.
- **Type Checking**: Run `basedpyright`.
- **Local Dev Server**: Handled via `uvicorn` (check `main.py`).

## Key Constraints & Conventions
- **Authentication**: All ledger API routes except `GET /healthz` require Bearer token authentication (`Authorization: Bearer <token>`).
- **Data Integrity**: The core principle is double-entry accounting. Pay special attention to changes in `balancing.py` and `validation.py` to ensure transactions remain balanced.
- **Tooling**: Avoid modifying requirements files directly; update `pyproject.toml` and lock dependencies appropriately.

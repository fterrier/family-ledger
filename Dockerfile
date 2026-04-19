FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY src ./src
COPY scripts ./scripts
COPY alembic.ini ./
COPY alembic ./alembic
COPY config ./config

RUN pip install --no-cache-dir .[dev]

EXPOSE 8000

CMD ["uvicorn", "family_ledger.main:app", "--host", "0.0.0.0", "--port", "8000"]

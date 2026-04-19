# Synology Deployment Guide

This guide covers deploying family-ledger on a Synology NAS using Docker.

## Prerequisites

- Synology NAS with Docker package installed
- SSH access to the Synology (optional, can use Terminal via DSM)
- At least 2GB of storage for PostgreSQL data

## Installation

### 1. Create the deployment folder

SSH into your Synology and create a folder:

```bash
mkdir -p /volume1/docker/family-ledger
cd /volume1/docker/family-ledger
```

Or use the Synology File Station to create the folder.

### 2. Download the compose files

Download the following files from this repository's `docker/compose/` folder:

- `docker-compose.yml`
- `docker-compose.env`
- `.env.example`

You can use `wget` or `curl` to download directly:

```bash
cd /volume1/docker/family-ledger

# Download docker-compose.yml
curl -L -o docker-compose.yml \
  https://raw.githubusercontent.com/fterrier/family-ledger/main/docker/compose/docker-compose.yml

# Download docker-compose.env
curl -L -o docker-compose.env \
  https://raw.githubusercontent.com/fterrier/family-ledger/main/docker/compose/docker-compose.env

# Download .env.example
curl -L -o .env.example \
  https://raw.githubusercontent.com/fterrier/family-ledger/main/docker/compose/.env.example
```

Or clone the repository and copy the files:

```bash
cd /volume1/docker
git clone https://github.com/fterrier/family-ledger.git
cp -r family-ledger/docker/compose/* family-ledger/
```

### 3. Configure environment

Copy `.env.example` to `.env` and set a secure password:

```bash
cp .env.example .env
nano .env
```

Change `POSTGRES_PASSWORD` to a secure password:

```bash
POSTGRES_PASSWORD=your-secure-password-here
```

### 4. Create a config folder (optional)

Create a local folder for the ledger configuration:

```bash
mkdir -p /volume1/docker/family-ledger/config
```

Copy your `ledger.yaml` file there (from the `config/ledger.yaml` in the repository).

Update the path in `docker-compose.yml` if using a custom location:

```yaml
volumes:
  - ./config/ledger.yaml:/app/config/ledger.yaml:ro
```

### 5. Pull and start

```bash
docker compose pull
docker compose up -d
```

### 6. Run migrations

```bash
docker compose exec api alembic upgrade head
```

### 7. Verify

Check the health endpoint:

```bash
curl http://localhost:8000/healthz
```

If running on a different machine, replace `localhost` with your Synology's IP address.

## Configuration

### Ports

The API listens on port 8000 by default. To use a different port, modify the `ports` section in `docker-compose.yml`:

```yaml
ports:
  - "9000:8000"
```

### Data Persistence

PostgreSQL data is stored in a Docker volume. To backup:

```bash
docker compose down
# Backup the volume
docker run --rm -v family-ledger_postgres_data:/data -v $(pwd)/backup:/backup alpine tar czf /backup/postgres_backup.tar.gz /data
docker compose up -d
```

To restore:

```bash
docker compose down
docker run --rm -v family-ledger_postgres_data:/data -v $(pwd)/backup:/backup alpine tar xzf /backup/postgres_backup.tar.gz
docker compose up -d
```

## Updating

```bash
docker compose pull
docker compose up -d
docker compose exec api alembic upgrade head
```

## Troubleshooting

### Check logs

```bash
docker compose logs
```

### Check container status

```bash
docker compose ps
```

### Restart the service

```bash
docker compose restart
```

### Stop and remove

```bash
docker compose down
```

To remove all data:

```bash
docker compose down -v
```

## Security Notes

- Change the default `POSTGRES_PASSWORD` before deploying
- Consider using a reverse proxy with SSL/TLS for external access
- Review the Synology Docker package settings for automatic startup

#!/usr/bin/env bash
# Dump the Harvestlink Postgres database to a timestamped SQL file under backups/.
# Usage: from backend/, npm run db:backup  (or ./scripts/backup-db.sh)
#
# Prefers local `pg_dump`. If it is not on PATH (common on Windows), falls back to
# `docker exec` against the harvestlink-postgres Compose service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKUP_DIR="${BACKEND_DIR}/backups"

# Load DATABASE_URL from backend/.env when not already exported.
if [[ -z "${DATABASE_URL:-}" && -f "${BACKEND_DIR}/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      DATABASE_URL=*)
        val="${line#DATABASE_URL=}"
        val="${val%\"}"
        val="${val#\"}"
        val="${val%\'}"
        val="${val#\'}"
        export DATABASE_URL="$val"
        ;;
    esac
  done < "${BACKEND_DIR}/.env"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL is not set and was not found in ${BACKEND_DIR}/.env" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
outfile="${BACKUP_DIR}/harvestlink_${stamp}.sql"

echo "Backing up database to ${outfile}"

run_pg_dump() {
  if command -v pg_dump >/dev/null 2>&1; then
    pg_dump --no-owner --no-acl --format=plain --file="${outfile}" "${DATABASE_URL}"
    return 0
  fi

  # Docker Compose fallback (Harvestlink local stack).
  if command -v docker >/dev/null 2>&1 \
    && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'harvestlink-postgres'; then
    echo "note: local pg_dump not found — using docker exec harvestlink-postgres"
    # Parse postgresql://user:pass@host:port/db
    local rest user pass db
    rest="${DATABASE_URL#postgresql://}"
    rest="${rest#postgres://}"
    user="${rest%%:*}"
    pass_host="${rest#*:}"
    pass="${pass_host%%@*}"
    after_at="${pass_host#*@}"
    db_part="${after_at##*/}"
    db="${db_part%%\?*}"
    docker exec -e "PGPASSWORD=${pass}" harvestlink-postgres \
      pg_dump -U "${user}" --no-owner --no-acl --format=plain "${db}" \
      > "${outfile}"
    return 0
  fi

  echo "error: pg_dump not found on PATH, and harvestlink-postgres container is not running" >&2
  exit 1
}

run_pg_dump

bytes="$(wc -c < "${outfile}" | tr -d ' ')"
if [[ "${bytes}" -lt 100 ]]; then
  echo "error: backup file looks empty (${bytes} bytes)" >&2
  exit 1
fi

echo "Backup complete: ${outfile} (${bytes} bytes)"

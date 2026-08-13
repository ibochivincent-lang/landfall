#!/usr/bin/env bash
#
# Apply every migration in packages/db/migrations, in filename order.
#
#   ./scripts/migrate.sh
#   MIGRATE_DATABASE_URL=postgresql://... ./scripts/migrate.sh
#
# On Supabase, migrations want the DIRECT connection (port 5432). The
# transaction pooler on 6543 does not hold a session across statements, so a
# multi-statement migration can end up half applied.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/packages/db/migrations"
URL="${MIGRATE_DATABASE_URL:-${DATABASE_URL:-}}"

if [ -z "$URL" ]; then
  echo "No connection string. Set MIGRATE_DATABASE_URL or DATABASE_URL." >&2
  exit 1
fi

command -v psql >/dev/null 2>&1 || { echo "psql is not on PATH." >&2; exit 1; }

case "$URL" in
  *:6543/*)
    echo "WARNING: port 6543 is the Supabase transaction pooler."
    echo "Migrations should use the direct connection on 5432. Continuing in 3s."
    sleep 3 ;;
esac

# Redact before printing.
echo
echo "Target: $(printf '%s' "$URL" | sed -E 's#(://[^:]+:)[^@]+(@)#\1********\2#')"
echo

shopt -s nullglob
for f in "$DIR"/*.sql; do
  echo "  -> $(basename "$f")"
  # ON_ERROR_STOP, or psql prints the error and still exits 0.
  psql "$URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo
psql "$URL" -c "SELECT version, applied_at FROM schema_version ORDER BY version;"
echo "Done."

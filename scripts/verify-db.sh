#!/usr/bin/env bash
# Applies the SQL migrations to an EMPTY database and runs the invariant checks.
# Uses standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) or a URL as $1.
#   PGDATABASE=reelqueue_verify ./scripts/verify-db.sh
#   ./scripts/verify-db.sh postgres://user:pass@localhost:5432/scratch
# DESTRUCTIVE to the target database's `public` schema: it is dropped and recreated. Use a scratch DB.
set -euo pipefail

TARGET="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_DIR="$HERE/apps/api/migrations-sql"
PSQL=(psql -v ON_ERROR_STOP=1 -q)
[ -n "$TARGET" ] && PSQL+=("$TARGET")

"${PSQL[@]}" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
for f in "$SQL_DIR"/[0-9][0-9][0-9][0-9]_*.sql; do
  echo "applying $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
for f in "$SQL_DIR"/verify/[0-9][0-9][0-9][0-9]_*.sql; do
  echo "verifying $(basename "$f")"
  # NOTICE lines carry the per-check results; any violated invariant raises and aborts (ON_ERROR_STOP)
  if ! out="$("${PSQL[@]}" -f "$f" 2>&1)"; then
    echo "$out" >&2
    echo "DB verification FAILED" >&2
    exit 1
  fi
  echo "$out" | sed -n 's/.*NOTICE:  //p'
done
echo "DB verification passed"

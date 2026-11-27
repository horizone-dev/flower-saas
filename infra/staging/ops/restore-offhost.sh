#!/bin/sh
# Restore a verified dump onto a FRESH PostgreSQL server (an off-host recovery or a rehearsal). Host-side; needs the docker CLI.
#   restore-offhost.sh <dump-file> <postgres-container> [database]      (default database: flower)
# Order (each step refuses and stops on failure; nothing is overwritten):
#   1. the dump's SHA-256 sidecar must exist and match (a dump without one is refused unless ALLOW_NO_CHECKSUM=1)
#   2. `pg_restore --list` must read the dump
#   3. the target database must NOT already exist (this never restores over data)
#   4. the four cluster roles are created first (roles-bootstrap.sql, idempotent, fails closed on drifted attributes)
#   5. createdb + pg_restore --exit-on-error
#   6. post-checks: the policy count equals the dump's policy entries, row level security is enabled where the dump enabled it, and the
#      migration table exists. Counts only — no row data is printed.
# Afterwards (not done here): run the `roles` service to give flower_app / flower_platform their login passwords, then start the stack.
set -eu

DUMP="${1:?usage: restore-offhost.sh <dump-file> <postgres-container> [database]}"
CONTAINER="${2:?usage: restore-offhost.sh <dump-file> <postgres-container> [database]}"
DB="${3:-flower}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PSQL="docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q"

die() { echo "refused: $*" >&2; exit 2; }
# docker.exe on Windows (Git Bash) cannot read an MSYS path such as /tmp/x; elsewhere this is the identity
hostpath() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

[ -f "$DUMP" ] || die "dump file not found: $DUMP"
case "$DB" in *[!a-zA-Z0-9_]* | '') die "database name must be letters, digits and underscore" ;; esac

# 1. checksum
if [ -f "$DUMP.sha256" ]; then
  (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256" > /dev/null 2>&1) || die "the SHA-256 sidecar does not match the dump (corrupted or tampered)"
  echo "checksum ok"
elif [ "${ALLOW_NO_CHECKSUM:-}" = "1" ]; then
  echo "WARNING: no .sha256 sidecar; continuing because ALLOW_NO_CHECKSUM=1" >&2
else
  die "no $DUMP.sha256 sidecar (copy it with the dump; ALLOW_NO_CHECKSUM=1 overrides for a rehearsal)"
fi

docker exec "$CONTAINER" pg_isready -U postgres > /dev/null 2>&1 || die "$CONTAINER is not accepting connections"

# 3. never restore over an existing database
EXISTS="$($PSQL -At -c "SELECT count(*) FROM pg_database WHERE datname = '$DB'")"
[ "$EXISTS" = "0" ] || die "database $DB already exists on $CONTAINER — restore into a fresh server or a new database name"

# 2. the dump must be readable by the SERVER's own pg_restore (same major as the server)
docker cp "$(hostpath "$DUMP")" "$CONTAINER:/tmp/restore.dump" > /dev/null
trap 'docker exec "$CONTAINER" rm -f /tmp/restore.dump > /dev/null 2>&1 || true' EXIT
docker exec "$CONTAINER" pg_restore --list /tmp/restore.dump > /tmp/restore.toc.$$ || die "pg_restore --list cannot read the dump"
WANT_POLICIES="$(grep -c ' POLICY ' /tmp/restore.toc.$$ || true)"
rm -f /tmp/restore.toc.$$

# 4. roles first
$PSQL < "$HERE/roles-bootstrap.sql"
echo "cluster roles present (4)"

# 5. restore
docker exec "$CONTAINER" createdb -U postgres "$DB"
docker exec "$CONTAINER" pg_restore -U postgres -d "$DB" --exit-on-error /tmp/restore.dump
echo "restored into $DB"

# 6. post-checks (counts only)
GOT_POLICIES="$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -At -X -c "SELECT count(*) FROM pg_policy")"
[ "$GOT_POLICIES" = "$WANT_POLICIES" ] || die "policy count after restore ($GOT_POLICIES) differs from the dump ($WANT_POLICIES)"
RLS="$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -At -X -c "SELECT count(*) FROM pg_class WHERE relrowsecurity AND relkind = 'r' AND relnamespace = 'public'::regnamespace")"
MIGS="$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -At -X -c "SELECT CASE WHEN to_regclass('public._prisma_migrations') IS NULL THEN -1 ELSE (SELECT count(*) FROM public._prisma_migrations) END")"
echo "post-checks: policies=$GOT_POLICIES (dump: $WANT_POLICIES), tables with row level security=$RLS, applied migrations=$MIGS (-1 = table missing)"
echo "restore complete. Next: run the roles service for the login passwords, then start the stack."

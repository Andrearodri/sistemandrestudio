#!/bin/sh
set -eu

test_database="${POSTGRES_TEST_DB:-sistemandrestudio_test}"
app_user="${POSTGRES_APP_USER:-sistemandrestudio_app}"
app_password="${POSTGRES_APP_PASSWORD:-local-app-only}"

case "$test_database" in
  *_test) ;;
  *)
    echo "Test database name must end with _test." >&2
    exit 1
    ;;
esac

case "$app_user" in
  *[!a-zA-Z0-9_]* | "")
    echo "Application database user contains invalid characters." >&2
    exit 1
    ;;
esac

psql \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  --set=ON_ERROR_STOP=1 \
  --set=app_user="$app_user" \
  --set=app_password="$app_password" \
  --set=development_database="$POSTGRES_DB" \
  --set=test_database="$test_database" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'app_user',
  :'app_password'
)
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_roles
  WHERE rolname = :'app_user'
)
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'development_database', :'app_user')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'test_database', :'app_user')
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_database
  WHERE datname = :'test_database'
)
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'test_database', :'app_user')
\gexec
SQL

for database in "$POSTGRES_DB" "$test_database"; do
  psql \
    --username "$POSTGRES_USER" \
    --dbname "$database" \
    --set=ON_ERROR_STOP=1 \
    --set=bootstrap_user="$POSTGRES_USER" \
    --set=app_user="$app_user" <<'SQL'
SELECT format('ALTER SCHEMA public OWNER TO %I', :'app_user')
\gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'app_user')
\gexec
SELECT format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO %I', :'app_user')
\gexec
SELECT format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_user')
\gexec
SELECT format('GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO %I', :'app_user')
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO %I',
  :'bootstrap_user',
  :'app_user'
)
\gexec
SQL
done

psql \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  --set=ON_ERROR_STOP=1 \
  --set=app_user="$app_user" \
  --set=development_database="$POSTGRES_DB" \
  --set=test_database="$test_database" <<'SQL'
REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC;
SELECT format(
  'GRANT CONNECT ON DATABASE %I, %I TO %I',
  :'development_database',
  :'test_database',
  :'app_user'
)
\gexec
SQL

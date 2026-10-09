#!/bin/sh
# Deploy schema + seed data only on first boot (DB file absent).
# On subsequent restarts the file exists, so data is preserved.

DB=/app/data/massbalance.db

if [ ! -f "$DB" ]; then
  echo "[start.sh] First boot — deploying schema and seed data to $DB"
  node ./node_modules/@sap/cds-dk/bin/cds.js deploy --to "sqlite:$DB"
  echo "[start.sh] Deploy complete."
else
  echo "[start.sh] DB found at $DB — skipping deploy, keeping existing data."
fi

exec node ./node_modules/.bin/cds-serve

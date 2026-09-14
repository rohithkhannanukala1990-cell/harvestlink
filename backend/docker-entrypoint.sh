#!/bin/sh
# Runtime entrypoint for the Harvestlink API container.
# Applies pending Prisma migrations, then starts the compiled Express server.
# Failures here stop the container so a bad schema never serves traffic silently.
set -e

echo "Running prisma migrate deploy..."
npx prisma migrate deploy

echo "Starting Harvestlink API..."
exec node dist/index.js

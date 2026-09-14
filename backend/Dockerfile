# Harvestlink backend — multi-stage production image.
#
# Stage "build": install ALL dependencies (including TypeScript/Prisma CLI), compile
# TypeScript to dist/, and generate the Prisma client. DevDependencies belong here only.
#
# Stage "runtime": copy compiled JS + Prisma client + production node_modules only.
# Why exclude devDependencies from runtime: they are tools (tsc, eslint, tsx), not needed
# to serve HTTP. Leaving them out shrinks the image, reduces attack surface, and avoids
# shipping compilers/linters into production.

# ---------- build stage ----------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# OpenSSL is required by Prisma engines on Debian-based images.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Full install so tsc + prisma CLI are available for compile / generate / migrate tooling.
RUN npm ci

COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src

# Generate Prisma Client against the schema (does not need a live DB).
RUN npx prisma generate

# Compile TypeScript → dist/ (JavaScript only in the runtime image).
RUN npm run build

# Drop devDependencies so the node_modules we copy to runtime stays lean.
# Keep `prisma` available for `migrate deploy` in the entrypoint — it is listed under
# dependencies (not only as a CLI for local migrate dev).
RUN npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 1001 harvestlink

# Production node_modules (no eslint/tsx/typescript) + compiled app + Prisma schema/migrations.
COPY --from=build --chown=harvestlink:harvestlink /app/node_modules ./node_modules
COPY --from=build --chown=harvestlink:harvestlink /app/package.json ./package.json
COPY --from=build --chown=harvestlink:harvestlink /app/dist ./dist
COPY --from=build --chown=harvestlink:harvestlink /app/prisma ./prisma

COPY --chown=harvestlink:harvestlink docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER harvestlink

EXPOSE 3001

# Entrypoint runs `prisma migrate deploy` then starts the API.
ENTRYPOINT ["./docker-entrypoint.sh"]

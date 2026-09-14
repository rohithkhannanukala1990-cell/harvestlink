# Harvestlink deployment guide

This document covers production environment variables, database migrations on release, local Docker, and recommended hosts.

## Architecture reminder

- **Backend** (Express + Prisma) owns the API, auth, Stripe webhooks, and Postgres.
- **Frontend** (Vite/React) is a static SPA; `VITE_API_URL` is compiled in at **build** time.
- **Stripe** card funds settle to the **co-op** Stripe account. Operator payables stay on the internal `/settlement` ledger (not Stripe Connect payouts to operators).

## Environment variables (production)

### Backend

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_URL` | Yes | Postgres connection string for Prisma |
| `JWT_SECRET` | Yes | Long random secret for signing JWTs |
| `PORT` | No | Defaults to `3001` |
| `STRIPE_SECRET_KEY` | Yes (for card sales) | `sk_live_…` in production |
| `STRIPE_WEBHOOK_SECRET` | Yes (for webhooks) | From Stripe Dashboard → Webhooks |
| `STRIPE_CURRENCY` | No | Defaults to `usd` |
| `FRONTEND_URL` | Yes | Public SPA origin (Checkout success/cancel URLs) |
| `SEED_*` | No | Dev seed only — do **not** rely on these in production |

Point Stripe webhooks at:

`https://<your-api-host>/webhooks/stripe`

Events: `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`.

### Frontend (build-time)

| Variable | Required | Notes |
|----------|----------|--------|
| `VITE_API_URL` | Yes | Public API base URL, e.g. `https://api.yourdomain.com` |

Rebuild the frontend whenever the API URL changes — Vite inlines `import.meta.env.VITE_*` at build time.

## Database migrations on release

Always apply migrations **before** (or as the first step of) starting a new API version that expects the new schema:

```bash
cd backend
npx prisma migrate deploy
```

- Use **`migrate deploy`** in production (applies already-committed migrations).
- Do **not** run `prisma migrate dev` in production (that is for local schema iteration).

### With the backend Docker image

The image entrypoint runs `prisma migrate deploy` then `node dist/index.js`. That is convenient for single-service deploys. On platforms with a dedicated **release command**, you can instead:

1. Release command: `npx prisma migrate deploy`
2. Start command: `node dist/index.js`

…and remove migrate from the entrypoint if you prefer migrations only once per release.

### Local Docker stack

```bash
# From repo root — Postgres + API + UI
docker compose up --build
```

- UI: http://localhost:5173  
- API: http://localhost:3001  
- Postgres: `localhost:5432` (user/password/db `harvestlink`)

Optional Stripe keys can be passed via a root `.env` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`).

To seed demo users after the API is up (dev only):

```bash
cd backend
cp .env.example .env   # if needed; point DATABASE_URL at localhost:5432
npm run prisma:seed
```

## Recommended hosts

### Backend + Postgres

**Railway** or **Render** work well for the API and a managed Postgres addon:

1. Create a Postgres database; copy its `DATABASE_URL`.
2. Deploy the `backend/` service from this repo (Dockerfile in `backend/`).
3. Set the backend env vars above.
4. Configure the release/start command to run `prisma migrate deploy` (or rely on the Docker entrypoint).
5. Confirm `/health` returns `{ "status": "ok" }`.

Alternatives: Fly.io, Google Cloud Run + Cloud SQL, AWS ECS/Fargate + RDS.

### Frontend

**Vercel** or **Netlify** for the static SPA:

1. Root directory: `frontend/`
2. Build command: `npm run build`
3. Output directory: `dist`
4. Set `VITE_API_URL` to your public API URL in the host’s env settings.
5. Add SPA redirects so all routes serve `index.html` (Vercel/Netlify static SPA presets usually handle this).

You can also serve the frontend from the `frontend/Dockerfile` (nginx) on the same platform as the API if you prefer one vendor.

### Checklist before going live

- [ ] Strong unique `JWT_SECRET`
- [ ] Production `DATABASE_URL` and successful `prisma migrate deploy`
- [ ] Stripe live keys + webhook endpoint verified
- [ ] `FRONTEND_URL` and `VITE_API_URL` match your real domains (HTTPS)
- [ ] CORS: API already uses `cors()`; restrict origins if you harden later
- [ ] Do not commit `.env` files or seed production with demo passwords

## Image design (why multi-stage)

See comments in `backend/Dockerfile` and `frontend/Dockerfile`:

- **Build stage** — compilers, Vite, Prisma generate, TypeScript.
- **Runtime stage** — only what serves traffic (Node + `dist` + prod `node_modules`, or nginx + static files).

Keeping devDependencies out of runtime reduces image size and attack surface.

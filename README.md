# Harvestlink

Retail co-op management platform for multi-store operations: inventory, point of sale (POS), membership, and settlement.

## Sales & settlement model

- **100% of each sale** settles to the co-op account (the co-op receives the full sale proceeds).
- **Store operators** earn a **fixed percentage of their store’s sales**. That operator share is tracked separately and paid out as an operator payout—not deducted from the co-op settlement of the sale itself.

In other words: the co-op books the full sale; operator commission is calculated from store sales and paid on its own schedule.

## Monorepo layout

| Path | Role |
|------|------|
| `backend/` | Node.js + Express + TypeScript API, Prisma, PostgreSQL |
| `frontend/` | React + Vite + TypeScript UI (Tailwind CSS) |
| `database/` | Pointer docs — Prisma schema & migrations live in `backend/prisma/` |

## Prerequisites

- Node.js 20+
- Docker (for local PostgreSQL via `docker-compose.yml`)

## Database (local)

```bash
docker compose up -d
```

This starts Postgres on port `5432` with user/password/db `harvestlink` (matches `backend/.env.example`).

For the full local stack (Postgres + API + UI images), see [`DEPLOY.md`](DEPLOY.md):

```bash
docker compose up --build
```

## Backend (local)

```bash
cd backend
cp .env.example .env
# Edit .env if needed (JWT_SECRET, PORT)
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

API defaults to [http://localhost:3001](http://localhost:3001). Health check: `GET /health`.

Auth:

- `POST /auth/login` — `{ "email", "password" }` → JWT
- `POST /auth/register` — COOP_ADMIN only; creates users for a store/role

Sales payments (Stripe):

- `POST /sales` — body includes `paymentMethod`: `CHECKOUT` or `TERMINAL`; creates **PENDING** sale (stock not decremented yet)
- `POST /webhooks/stripe` — finalizes **PAID** + decrements stock on success
- `POST /sales/:id/confirm-payment` — client-side confirm after Terminal/Checkout
- `POST /sales/:id/refund` — Stripe refund + restock + **REFUNDED**
- `POST /sales/terminal/connection-token` — Terminal reader SDK token

Card funds settle to the **co-op** Stripe account. Operator payables are the internal `/settlement` ledger (not Stripe payouts to operators).

After seeding, default local logins are:

| Role | Email | Password |
|------|-------|----------|
| COOP_ADMIN | `admin@harvestlink.local` | `ChangeMeAdmin123!` |
| STORE_ADMIN | `storeadmin@harvestlink.local` | `ChangeMeStore123!` |
| CASHIER | `cashier@harvestlink.local` | `ChangeMeCashier123!` |

Override via `SEED_*` vars in `backend/.env` (see `.env.example`).

Useful scripts:

- `npm run lint` — ESLint
- `npm run format` — Prettier
- `npm run prisma:studio` — browse the database
- `npm run prisma:seed` — bootstrap demo store + users

## Frontend (local)

```bash
cd frontend
npm install
npm run dev
```

UI defaults to [http://localhost:5173](http://localhost:5173).

## Environment variables (backend)

See [`backend/.env.example`](backend/.env.example):

- `DATABASE_URL` — PostgreSQL connection string for Prisma
- `JWT_SECRET` — secret for signing JWTs
- `PORT` — Express listen port (default `3001`)
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_CURRENCY` — Stripe (co-op account)
- `FRONTEND_URL` — Checkout success/cancel base URL

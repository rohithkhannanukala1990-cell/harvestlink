<!--
  Documents where Harvestlink database artifacts live in this monorepo.
  Prisma owns the schema and migrations; this folder is the pointer for that layout.
-->

# Database

Prisma is the source of truth for Harvestlink’s PostgreSQL schema.

- **Schema:** [`../backend/prisma/schema.prisma`](../backend/prisma/schema.prisma)
- **Migrations:** [`../backend/prisma/migrations`](../backend/prisma/migrations)

Use the backend scripts to work with the database:

```bash
cd backend
cp .env.example .env   # set DATABASE_URL
npm run prisma:migrate
npm run prisma:studio
```

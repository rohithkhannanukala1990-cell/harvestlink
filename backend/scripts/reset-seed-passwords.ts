/**
 * Dev helper: reset seed account passwords to documented defaults.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = 12;

const resets = [
  { email: "admin@harvestlink.local", password: "ChangeMeAdmin123!" },
  { email: "storeadmin@harvestlink.local", password: "ChangeMeStore123!" },
  { email: "cashier@harvestlink.local", password: "ChangeMeCashier123!" },
];

async function main() {
  for (const row of resets) {
    const passwordHash = await bcrypt.hash(row.password, BCRYPT_ROUNDS);
    const updated = await prisma.user.updateMany({
      where: { email: row.email },
      data: {
        passwordHash,
        mustChangePassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    console.log(
      updated.count
        ? `Reset ${row.email} → ${row.password} (mustChangePassword=true)`
        : `Missing ${row.email}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

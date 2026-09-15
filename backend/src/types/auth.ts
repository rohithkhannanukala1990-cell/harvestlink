/**
 * Shared auth identity types for Harvestlink.
 * Carries the JWT subject fields used by middleware and route handlers to enforce
 * store scope (CASHIER/STORE_ADMIN) vs co-op-wide access (COOP_ADMIN).
 */
import type { Role } from "@prisma/client";

export type AuthUser = {
  id: string;
  storeId: string | null;
  role: Role;
  /** When true, only POST /auth/change-password is allowed until cleared. */
  mustChangePassword: boolean;
};

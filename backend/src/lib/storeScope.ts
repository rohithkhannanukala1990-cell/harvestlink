/**
 * Resolves which store a Harvestlink request may act on.
 * Cashiers and store admins are locked to their JWT storeId; COOP_ADMIN must pass an
 * explicit storeId so co-op-wide users never accidentally touch the wrong store.
 */
import { Role } from "@prisma/client";
import { AppError } from "./errors.js";
import type { AuthUser } from "../types/auth.js";

export function resolveStoreScope(actor: AuthUser, requestedStoreId?: string | null): string {
  if (actor.role === Role.COOP_ADMIN) {
    if (!requestedStoreId) {
      throw new AppError(400, "storeId query/body parameter is required for COOP_ADMIN");
    }
    return requestedStoreId;
  }

  if (!actor.storeId) {
    throw new AppError(403, "User is not assigned to a store");
  }

  if (requestedStoreId && requestedStoreId !== actor.storeId) {
    throw new AppError(403, "Cannot access another store's data");
  }

  return actor.storeId;
}

/**
 * Express Request augmentation for Harvestlink auth.
 * After auth.middleware runs, handlers can read the verified JWT subject (id, storeId, role)
 * so store-scoped routes know which store a CASHIER/STORE_ADMIN belongs to, and co-op routes
 * know when a COOP_ADMIN is acting without a store binding.
 */
import type { AuthUser } from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};

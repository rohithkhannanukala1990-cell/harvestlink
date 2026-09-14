/**
 * Inventory / product catalog business logic for Harvestlink.
 *
 * Store scope: cashiers and store admins may only touch products for req.user.storeId.
 * COOP_ADMIN may target any store via an explicit storeId argument (from query/body).
 *
 * Manual stock adjustments always require a logged reason — shrink, damage, and recount
 * deltas must be auditable so settlement and shrinkage reports stay trustworthy.
 */
import { Prisma, type Product } from "@prisma/client";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { resolveStoreScope } from "../lib/storeScope.js";
import type { AuthUser } from "../types/auth.js";

export { resolveStoreScope };

export type ProductWithLowStock = Product & { lowStock: boolean };

export type CreateProductInput = {
  sku: string;
  name: string;
  category: string;
  price: number;
  cost: number;
  stock: number;
  reorderAt: number;
};

export type UpdateProductInput = Partial<{
  sku: string;
  name: string;
  category: string;
  price: number;
  cost: number;
  reorderAt: number;
}>;

export type AdjustStockInput = {
  /** Absolute on-hand quantity to set after the adjustment. */
  newStock: number;
  /** Required audit explanation (shrinkage, cycle count, receiving fix, etc.). */
  reason: string;
};

function toProductView(product: Product): ProductWithLowStock {
  return {
    ...product,
    lowStock: product.stock <= product.reorderAt,
  };
}

/**
 * Lists products for one store and flags low stock (stock <= reorderAt).
 * Low-stock flags drive reorder alerts without changing on-hand quantities.
 */
export async function listProducts(storeId: string): Promise<ProductWithLowStock[]> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new AppError(404, "Store not found");
  }

  const products = await prisma.product.findMany({
    where: { storeId },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  return products.map(toProductView);
}

/**
 * Creates a catalog product for a store. SKU must be unique within that store only.
 */
export async function createProduct(
  storeId: string,
  input: CreateProductInput,
): Promise<ProductWithLowStock> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store || !store.isActive) {
    throw new AppError(400, "Store not found or inactive");
  }

  try {
    const product = await prisma.product.create({
      data: {
        storeId,
        sku: input.sku,
        name: input.name,
        category: input.category,
        price: new Prisma.Decimal(input.price),
        cost: new Prisma.Decimal(input.cost),
        stock: input.stock,
        reorderAt: input.reorderAt,
      },
    });
    return toProductView(product);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "SKU already exists for this store");
    }
    throw error;
  }
}

/**
 * Ensures the product belongs to the resolved store scope before mutation/read-by-id.
 */
async function getScopedProduct(productId: string, storeId: string): Promise<Product> {
  const product = await prisma.product.findFirst({
    where: { id: productId, storeId },
  });

  if (!product) {
    throw new AppError(404, "Product not found for this store");
  }

  return product;
}

/**
 * Updates catalog fields (not stock). Stock changes go through adjustStock so every
 * quantity change outside of POS sales is explicitly reasoned and audited.
 */
export async function updateProduct(
  productId: string,
  storeId: string,
  input: UpdateProductInput,
): Promise<ProductWithLowStock> {
  await getScopedProduct(productId, storeId);

  try {
    const product = await prisma.product.update({
      where: { id: productId },
      data: {
        ...(input.sku !== undefined ? { sku: input.sku } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.price !== undefined ? { price: new Prisma.Decimal(input.price) } : {}),
        ...(input.cost !== undefined ? { cost: new Prisma.Decimal(input.cost) } : {}),
        ...(input.reorderAt !== undefined ? { reorderAt: input.reorderAt } : {}),
      },
    });
    return toProductView(product);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "SKU already exists for this store");
    }
    throw error;
  }
}

/**
 * Soft-removes a product from the catalog by deleting the row when no sale history
 * blocks it. Callers should prefer deactivating via future flags if sales reference it.
 */
export async function deleteProduct(productId: string, storeId: string): Promise<void> {
  await getScopedProduct(productId, storeId);

  try {
    await prisma.product.delete({ where: { id: productId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      throw new AppError(
        409,
        "Product cannot be deleted because it is referenced by existing sales",
      );
    }
    throw error;
  }
}

/**
 * Applies a manual stock adjustment to an absolute newStock value and writes an audit row.
 *
 * Why a reason is required and logged:
 * - POS sales already explain inventory going down (tied to a Sale/SaleItem).
 * - Manual changes (shrinkage, damage, cycle-count recounts, receiving corrections) are
 *   otherwise invisible — without a reason, co-op settlement and shrinkage reports cannot
 *   distinguish theft/spoilage from a data-entry fix.
 * - The StockAdjustment row freezes previousStock, newStock, delta, actor, and reason so
 *   historical audits remain accurate even if the product is later renamed or restocked.
 *
 * Stock is updated in the same transaction as the audit insert so a failed write never
 * leaves quantity changed without a logged reason (or vice versa).
 */
export async function adjustStock(
  productId: string,
  storeId: string,
  actor: AuthUser,
  input: AdjustStockInput,
): Promise<{ product: ProductWithLowStock; adjustment: { id: string; delta: number; reason: string } }> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError(400, "A non-empty reason is required for manual stock adjustments");
  }

  if (!Number.isInteger(input.newStock) || input.newStock < 0) {
    throw new AppError(400, "newStock must be a non-negative integer");
  }

  const result = await prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId, storeId },
    });

    if (!product) {
      throw new AppError(404, "Product not found for this store");
    }

    const previousStock = product.stock;
    const newStock = input.newStock;
    const delta = newStock - previousStock;

    if (delta === 0) {
      throw new AppError(400, "newStock matches current stock; no adjustment needed");
    }

    const updated = await tx.product.update({
      where: { id: productId },
      data: { stock: newStock },
    });

    const adjustment = await tx.stockAdjustment.create({
      data: {
        productId,
        storeId,
        adjustedById: actor.id,
        previousStock,
        newStock,
        delta,
        reason,
      },
    });

    return { product: updated, adjustment };
  });

  return {
    product: toProductView(result.product),
    adjustment: {
      id: result.adjustment.id,
      delta: result.adjustment.delta,
      reason: result.adjustment.reason,
    },
  };
}

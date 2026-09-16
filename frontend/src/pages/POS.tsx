/**
 * POS checkout page — online Stripe + offline-capable CASH queue.
 *
 * Offline behaviour (physical stores cannot stop selling when the WAN drops):
 * - Product catalog is cached in IndexedDB whenever a live fetch succeeds.
 * - When offline: only CASH is allowed; sales are queued locally with an idempotencyKey.
 * - On reconnect: syncQueuedSales POSTs each queued sale with that same key + offlineSync.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest, money } from "../api/client";
import type { Member, PaymentMethod, Product, Sale } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";
import { adjustCachedStock, cacheProductCatalog, readCachedCatalog } from "../offline/catalogCache";
import {
  countQueuedSales,
  enqueueOfflineSale,
  newIdempotencyKey,
} from "../offline/salesQueue";
import { syncQueuedSales } from "../offline/sync";
import { useOnlineStatus } from "../offline/useOnlineStatus";

type CartLine = {
  product: Product;
  quantity: number;
  manualDiscount: string;
  discountReason: string;
};

export function POSPage() {
  const { activeStoreId, isRole } = useAuth();
  const canManualDiscount = isRole("STORE_ADMIN", "COOP_ADMIN");
  const online = useOnlineStatus();
  const qc = useQueryClient();
  const q = storeQuery(activeStoreId);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [memberNumber, setMemberNumber] = useState("");
  const [member, setMember] = useState<Member | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CHECKOUT");
  const [message, setMessage] = useState<string | null>(null);
  const [pendingSync, setPendingSync] = useState(0);
  const [cachedProducts, setCachedProducts] = useState<Product[] | null>(null);
  const [catalogSource, setCatalogSource] = useState<"live" | "cache" | null>(null);

  const productsQuery = useQuery({
    queryKey: ["products", activeStoreId],
    enabled: !!activeStoreId && online,
    queryFn: () => apiRequest<{ products: Product[] }>(`/products${q ? `?${q}` : ""}`),
    retry: 1,
  });

  // Refresh IndexedDB catalog while online; fall back to cache when offline / fetch fails.
  useEffect(() => {
    if (!activeStoreId) return;
    if (productsQuery.data?.products) {
      void cacheProductCatalog(activeStoreId, productsQuery.data.products);
      setCachedProducts(productsQuery.data.products);
      setCatalogSource("live");
      return;
    }
    if (!online || productsQuery.isError) {
      void readCachedCatalog(activeStoreId).then((cached) => {
        if (cached) {
          setCachedProducts(cached.products);
          setCatalogSource("cache");
        }
      });
    }
  }, [activeStoreId, online, productsQuery.data, productsQuery.isError]);

  // Force CASH when offline — card rails need the network.
  useEffect(() => {
    if (!online) {
      setPaymentMethod("CASH");
    }
  }, [online]);

  async function refreshPendingCount() {
    if (!activeStoreId) {
      setPendingSync(0);
      return;
    }
    setPendingSync(await countQueuedSales(activeStoreId));
  }

  useEffect(() => {
    void refreshPendingCount();
  }, [activeStoreId]);

  // Replay queued cash sales whenever connectivity returns.
  useEffect(() => {
    if (!online || !activeStoreId) return;

    let cancelled = false;
    void (async () => {
      const result = await syncQueuedSales(activeStoreId);
      if (cancelled) return;
      await refreshPendingCount();
      if (result.synced > 0) {
        void qc.invalidateQueries({ queryKey: ["products"] });
        void qc.invalidateQueries({ queryKey: ["sales"] });
        void qc.invalidateQueries({ queryKey: ["settlement"] });
        void qc.invalidateQueries({ queryKey: ["drawer"] });
        let msg = `Synced ${result.synced} offline sale${result.synced === 1 ? "" : "s"}`;
        if (result.reconciliationWarnings > 0) {
          msg += ` — ${result.reconciliationWarnings} need stock reconciliation (accepted with negative stock)`;
        }
        setMessage(msg);
      } else if (result.failed > 0) {
        setMessage(`Offline sync paused: ${result.errors[0] ?? "error"}`);
      }
    })();

    const onVisible = () => {
      if (document.visibilityState === "visible" && navigator.onLine && activeStoreId) {
        void syncQueuedSales(activeStoreId).then(() => refreshPendingCount());
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [online, activeStoreId, qc]);

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      if (!cart.length) throw new ApiError(400, "Cart is empty");
      if (!activeStoreId) throw new ApiError(400, "Select a store");

      // OFFLINE PATH: queue CASH only — never invent a card charge without Stripe.
      if (!online) {
        if (paymentMethod !== "CASH") {
          throw new ApiError(400, "Only cash sales are available offline");
        }
        const idempotencyKey = newIdempotencyKey();
        await enqueueOfflineSale({
          idempotencyKey,
          storeId: activeStoreId,
          memberId: member?.id ?? null,
          paymentMethod: "CASH",
          queuedAt: new Date().toISOString(),
          items: cart.map((line) => ({
            productId: line.product.id,
            quantity: line.quantity,
            nameSnapshot: line.product.name,
            skuSnapshot: line.product.sku,
            priceSnapshot: Number(line.product.price),
            ...(canManualDiscount && Number(line.manualDiscount || 0) > 0
              ? {
                  manualDiscount: Number(line.manualDiscount),
                  discountReason: line.discountReason.trim() || "Manual discount",
                }
              : {}),
          })),
        });
        // Optimistic local stock so the grid stops offering units already sold offline.
        await adjustCachedStock(
          activeStoreId,
          cart.map((line) => ({ productId: line.product.id, quantityDelta: -line.quantity })),
        );
        const cached = await readCachedCatalog(activeStoreId);
        if (cached) setCachedProducts(cached.products);
        await refreshPendingCount();
        return {
          offlineQueued: true as const,
          idempotencyKey,
        };
      }

      return apiRequest<{
        sale: Sale;
        checkout?: { url: string; sessionId: string };
        terminal?: { clientSecret: string; paymentIntentId: string };
        offlineQueued?: false;
      }>("/sales", {
        method: "POST",
        body: {
          storeId: activeStoreId,
          memberId: member?.id ?? null,
          paymentMethod,
          // Online cash also gets a key so a flaky connection retry stays safe.
          idempotencyKey: newIdempotencyKey(),
          items: cart.map((line) => {
            const manual = Number(line.manualDiscount || 0);
            return {
              productId: line.product.id,
              quantity: line.quantity,
              ...(canManualDiscount && manual > 0
                ? {
                    manualDiscount: manual,
                    discountReason: line.discountReason.trim() || "Manual discount",
                  }
                : {}),
            };
          }),
        },
      });
    },
    onSuccess: (result) => {
      setCart([]);
      setMember(null);
      setMemberNumber("");
      if ("offlineQueued" in result && result.offlineQueued) {
        setMessage(
          `Offline cash sale queued (${result.idempotencyKey.slice(0, 8)}…) — will sync when online`,
        );
        return;
      }
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["sales"] });
      void qc.invalidateQueries({ queryKey: ["settlement"] });
      void qc.invalidateQueries({ queryKey: ["drawer"] });
      if (result.checkout?.url) {
        setMessage(`Sale ${result.sale.id} pending — opening Stripe Checkout…`);
        window.open(result.checkout.url, "_blank", "noopener,noreferrer");
      } else if (result.terminal) {
        setMessage(
          `Sale ${result.sale.id} pending Terminal PaymentIntent ${result.terminal.paymentIntentId}`,
        );
      } else {
        setMessage(
          `Sale ${result.sale.id} ${result.sale.paymentStatus} — reprint from Sales history`,
        );
      }
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Checkout failed";
      if (/quarantined or recalled/i.test(msg)) {
        setMessage(
          "BLOCKED — this product’s remaining stock is quarantined or recalled and cannot be sold. Remove it from the cart and choose another item.",
        );
      } else if (/insufficient stock/i.test(msg)) {
        setMessage(`Insufficient stock — ${msg}`);
      } else {
        setMessage(msg);
      }
    },
  });

  const subtotal = useMemo(
    () =>
      cart.reduce((sum, line) => {
        const gross = Number(line.product.price) * line.quantity;
        const disc = canManualDiscount ? Number(line.manualDiscount || 0) : 0;
        return sum + Math.max(0, gross - disc);
      }, 0),
    [cart, canManualDiscount],
  );

  function addToCart(product: Product) {
    setCart((prev) => {
      const existing = prev.find((l) => l.product.id === product.id);
      if (existing) {
        return prev.map((l) =>
          l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      return [
        ...prev,
        { product, quantity: 1, manualDiscount: "", discountReason: "" },
      ];
    });
  }

  async function lookupMember() {
    if (!online) {
      setMessage("Member lookup requires connectivity");
      return;
    }
    setMessage(null);
    try {
      const data = await apiRequest<{ member: Member }>(
        `/members/${encodeURIComponent(memberNumber.trim())}`,
      );
      setMember(data.member);
    } catch (err) {
      setMember(null);
      setMessage(err instanceof ApiError ? err.message : "Member lookup failed");
    }
  }

  if (!activeStoreId) {
    return <p className="text-stone-600">Select a store to use POS.</p>;
  }

  const products =
    (online && productsQuery.data?.products) || cachedProducts || [];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <section>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Point of sale</h1>
          {!online ? (
            <span className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
              Offline — cash only
            </span>
          ) : (
            <span className="rounded bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-900">
              Online
            </span>
          )}
          {pendingSync > 0 && (
            <span className="rounded bg-stone-800 px-2 py-1 text-xs font-medium text-white">
              {pendingSync} pending sync
            </span>
          )}
          {catalogSource === "cache" && (
            <span className="text-xs text-stone-500">Catalog from device cache</span>
          )}
        </div>
        {online && productsQuery.isLoading && !cachedProducts && <p>Loading products…</p>}
        {!products.length && (
          <p className="text-sm text-stone-600">
            No products available. Connect once to cache the catalog for offline use.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {products.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => addToCart(p)}
              disabled={(p.available ?? p.stock) <= 0}
              className="rounded-lg border border-stone-200 bg-white p-3 text-left hover:border-stone-400 disabled:opacity-40"
            >
              <div className="font-medium">{p.name}</div>
              <div className="text-sm text-stone-500">{p.sku}</div>
              <div className="mt-2 flex justify-between text-sm">
                <span>{money(p.price)}</span>
                <span className={p.lowStock ? "text-amber-700" : "text-stone-500"}>
                  qty {p.available ?? p.stock}
                </span>
              </div>
              {p.taxExempt ? (
                <div className="mt-1 text-xs text-stone-400">Tax exempt</div>
              ) : null}
            </button>
          ))}
        </div>
      </section>

      <aside className="space-y-4 rounded-lg border border-stone-200 bg-white p-4">
        <h2 className="font-medium">Cart</h2>
        {cart.length === 0 ? (
          <p className="text-sm text-stone-500">Tap products to add</p>
        ) : (
          <ul className="space-y-3 text-sm">
            {cart.map((line) => (
              <li key={line.product.id} className="space-y-1 border-b border-stone-100 pb-2">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    {line.product.name} × {line.quantity}
                  </span>
                  <span>
                    {money(
                      Math.max(
                        0,
                        Number(line.product.price) * line.quantity -
                          (canManualDiscount ? Number(line.manualDiscount || 0) : 0),
                      ),
                    )}
                  </span>
                </div>
                {canManualDiscount && (
                  <div className="grid grid-cols-2 gap-1">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="Discount $"
                      className="rounded border border-stone-300 px-2 py-1 text-xs"
                      value={line.manualDiscount}
                      onChange={(e) =>
                        setCart((prev) =>
                          prev.map((l) =>
                            l.product.id === line.product.id
                              ? { ...l, manualDiscount: e.target.value }
                              : l,
                          ),
                        )
                      }
                    />
                    <input
                      placeholder="Reason (audited)"
                      className="rounded border border-stone-300 px-2 py-1 text-xs"
                      value={line.discountReason}
                      onChange={(e) =>
                        setCart((prev) =>
                          prev.map((l) =>
                            l.product.id === line.product.id
                              ? { ...l, discountReason: e.target.value }
                              : l,
                          ),
                        )
                      }
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-lg font-semibold">Subtotal {money(subtotal)}</p>
        {member && (
          <p className="text-xs text-stone-500">
            Member {member.memberNumber} · {member.status} (memberships never expire)
          </p>
        )}

        <div className="space-y-2 border-t border-stone-100 pt-3">
          <label className="block text-sm">
            Member number
            <div className="mt-1 flex gap-2">
              <input
                className="w-full rounded border border-stone-300 px-2 py-1 disabled:bg-stone-100"
                value={memberNumber}
                onChange={(e) => setMemberNumber(e.target.value)}
                placeholder="HL-…"
                disabled={!online}
              />
              <button
                type="button"
                onClick={() => void lookupMember()}
                disabled={!online}
                className="rounded border border-stone-300 px-2 py-1 text-sm disabled:opacity-40"
              >
                Find
              </button>
            </div>
          </label>
          {member && (
            <p className="text-sm text-stone-600">
              {member.name} · {member.status}
            </p>
          )}
        </div>

        <label className="block text-sm">
          Payment
          <select
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1 disabled:bg-stone-100"
            value={paymentMethod}
            disabled={!online}
            onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
          >
            <option value="CHECKOUT">Stripe Checkout</option>
            <option value="TERMINAL">Stripe Terminal</option>
            <option value="CASH">Cash</option>
          </select>
        </label>
        {!online && (
          <p className="text-xs text-amber-800">
            Offline mode: cash only. Sale is saved on this device and synced with an
            idempotency key when the connection returns.
          </p>
        )}

        <button
          type="button"
          disabled={!cart.length || checkoutMutation.isPending}
          onClick={() => checkoutMutation.mutate()}
          className="w-full rounded bg-stone-900 px-4 py-2 text-white hover:bg-stone-800 disabled:opacity-50"
        >
          {checkoutMutation.isPending
            ? "Processing…"
            : online
              ? "Checkout"
              : "Queue cash sale"}
        </button>
        {message && (
          <p
            className={
              message.startsWith("BLOCKED")
                ? "rounded-lg border-2 border-red-700 bg-red-50 px-3 py-2 text-sm font-medium text-red-950"
                : "text-sm text-stone-600"
            }
            role={message.startsWith("BLOCKED") ? "alert" : undefined}
          >
            {message}
          </p>
        )}
      </aside>
    </div>
  );
}

/**
 * POS checkout page.
 *
 * APIs:
 * - GET /products — product grid (CASHIER, STORE_ADMIN, COOP_ADMIN)
 * - GET /members/:memberNumber — optional member lookup at checkout (same roles)
 * - POST /sales — create PENDING sale with paymentMethod CHECKOUT or TERMINAL
 *   (same roles). On CHECKOUT, opens Stripe URL; stock finalizes after payment webhook.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest, money } from "../api/client";
import type { Member, PaymentMethod, Product, Sale } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";

type CartLine = { product: Product; quantity: number };

export function POSPage() {
  const { activeStoreId } = useAuth();
  const qc = useQueryClient();
  const q = storeQuery(activeStoreId);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [memberNumber, setMemberNumber] = useState("");
  const [member, setMember] = useState<Member | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CHECKOUT");
  const [message, setMessage] = useState<string | null>(null);

  const productsQuery = useQuery({
    queryKey: ["products", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () => apiRequest<{ products: Product[] }>(`/products${q ? `?${q}` : ""}`),
  });

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      if (!cart.length) throw new ApiError(400, "Cart is empty");
      return apiRequest<{
        sale: Sale;
        checkout?: { url: string; sessionId: string };
        terminal?: { clientSecret: string; paymentIntentId: string };
      }>("/sales", {
        method: "POST",
        body: {
          ...(activeStoreId ? { storeId: activeStoreId } : {}),
          memberId: member?.id ?? null,
          paymentMethod,
          items: cart.map((line) => ({
            productId: line.product.id,
            quantity: line.quantity,
          })),
        },
      });
    },
    onSuccess: (result) => {
      setCart([]);
      setMember(null);
      setMemberNumber("");
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["sales"] });
      void qc.invalidateQueries({ queryKey: ["settlement"] });
      if (result.checkout?.url) {
        setMessage(`Sale ${result.sale.id} pending — opening Stripe Checkout…`);
        window.open(result.checkout.url, "_blank", "noopener,noreferrer");
      } else if (result.terminal) {
        setMessage(
          `Sale ${result.sale.id} pending Terminal PaymentIntent ${result.terminal.paymentIntentId}`,
        );
      } else {
        setMessage(`Sale ${result.sale.id} created (${result.sale.paymentStatus})`);
      }
    },
    onError: (err) => {
      setMessage(err instanceof ApiError ? err.message : "Checkout failed");
    },
  });

  const subtotal = useMemo(
    () => cart.reduce((sum, line) => sum + Number(line.product.price) * line.quantity, 0),
    [cart],
  );

  function addToCart(product: Product) {
    setCart((prev) => {
      const existing = prev.find((l) => l.product.id === product.id);
      if (existing) {
        return prev.map((l) =>
          l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      return [...prev, { product, quantity: 1 }];
    });
  }

  async function lookupMember() {
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

  const products = productsQuery.data?.products ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <section>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Point of sale</h1>
        {productsQuery.isLoading && <p>Loading products…</p>}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {products.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => addToCart(p)}
              disabled={p.stock <= 0}
              className="rounded-lg border border-stone-200 bg-white p-3 text-left hover:border-stone-400 disabled:opacity-40"
            >
              <div className="font-medium">{p.name}</div>
              <div className="text-sm text-stone-500">{p.sku}</div>
              <div className="mt-2 flex justify-between text-sm">
                <span>{money(p.price)}</span>
                <span className={p.lowStock ? "text-amber-700" : "text-stone-500"}>
                  qty {p.stock}
                </span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <aside className="space-y-4 rounded-lg border border-stone-200 bg-white p-4">
        <h2 className="font-medium">Cart</h2>
        {cart.length === 0 ? (
          <p className="text-sm text-stone-500">Tap products to add</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {cart.map((line) => (
              <li key={line.product.id} className="flex items-center justify-between gap-2">
                <span>
                  {line.product.name} × {line.quantity}
                </span>
                <span>{money(Number(line.product.price) * line.quantity)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-lg font-semibold">Subtotal {money(subtotal)}</p>

        <div className="space-y-2 border-t border-stone-100 pt-3">
          <label className="block text-sm">
            Member number
            <div className="mt-1 flex gap-2">
              <input
                className="w-full rounded border border-stone-300 px-2 py-1"
                value={memberNumber}
                onChange={(e) => setMemberNumber(e.target.value)}
                placeholder="HL-…"
              />
              <button
                type="button"
                onClick={() => void lookupMember()}
                className="rounded border border-stone-300 px-2 py-1 text-sm"
              >
                Find
              </button>
            </div>
          </label>
          {member && (
            <p className="text-sm text-stone-600">
              {member.name} · {member.tier}
            </p>
          )}
        </div>

        <label className="block text-sm">
          Payment
          <select
            className="mt-1 w-full rounded border border-stone-300 px-2 py-1"
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
          >
            <option value="CHECKOUT">Stripe Checkout</option>
            <option value="TERMINAL">Stripe Terminal</option>
          </select>
        </label>

        <button
          type="button"
          disabled={!cart.length || checkoutMutation.isPending}
          onClick={() => checkoutMutation.mutate()}
          className="w-full rounded bg-stone-900 px-4 py-2 text-white hover:bg-stone-800 disabled:opacity-50"
        >
          {checkoutMutation.isPending ? "Processing…" : "Checkout"}
        </button>
        {message && <p className="text-sm text-stone-600">{message}</p>}
      </aside>
    </div>
  );
}

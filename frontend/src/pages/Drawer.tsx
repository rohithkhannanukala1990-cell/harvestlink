/**
 * Cash drawer open / close / current status.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest, money } from "../api/client";
import type { CashDrawer } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";

export function DrawerPage() {
  const { activeStoreId, isRole } = useAuth();
  const q = storeQuery(activeStoreId);
  const qc = useQueryClient();
  const [floatAmt, setFloatAmt] = useState("100");
  const [counted, setCounted] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const drawerQuery = useQuery({
    queryKey: ["drawer", activeStoreId],
    enabled: !!activeStoreId,
    queryFn: () =>
      apiRequest<{ drawer: CashDrawer | null }>(`/drawer/current${q ? `?${q}` : ""}`),
  });

  const openMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ drawer: CashDrawer }>("/drawer/open", {
        method: "POST",
        body: {
          openingFloat: Number(floatAmt),
          ...(activeStoreId ? { storeId: activeStoreId } : {}),
        },
      }),
    onSuccess: () => {
      setMessage("Drawer opened");
      void qc.invalidateQueries({ queryKey: ["drawer"] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : "Open failed"),
  });

  const closeMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ drawer: CashDrawer }>("/drawer/close", {
        method: "POST",
        body: {
          countedCash: Number(counted),
          ...(activeStoreId ? { storeId: activeStoreId } : {}),
        },
      }),
    onSuccess: (data) => {
      setMessage(`Drawer closed — variance ${money(data.drawer.variance ?? 0)}`);
      setCounted("");
      void qc.invalidateQueries({ queryKey: ["drawer"] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : "Close failed"),
  });

  if (!activeStoreId) {
    return <p className="text-stone-600">Select a store.</p>;
  }

  const drawer = drawerQuery.data?.drawer;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Cash drawer</h1>
      {message && <p className="text-sm text-stone-600">{message}</p>}

      {drawer ? (
        <div className="space-y-3 rounded-lg border border-stone-200 bg-white p-4">
          <p className="text-sm text-stone-600">Open since {new Date(drawer.openedAt).toLocaleString()}</p>
          <p>
            Opening float: <strong>{money(drawer.openingFloat)}</strong>
          </p>
          {isRole("STORE_ADMIN", "COOP_ADMIN") && (
            <form
              className="space-y-3 border-t pt-3"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                closeMutation.mutate();
              }}
            >
              <label className="block text-sm">
                Counted cash
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
                  value={counted}
                  onChange={(e) => setCounted(e.target.value)}
                  required
                />
              </label>
              <button
                type="submit"
                className="rounded bg-stone-900 px-4 py-2 text-white"
                disabled={closeMutation.isPending}
              >
                Close drawer
              </button>
            </form>
          )}
        </div>
      ) : (
        <form
          className="space-y-3 rounded-lg border border-stone-200 bg-white p-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            openMutation.mutate();
          }}
        >
          <p className="text-sm text-stone-600">No drawer is open. Open one before taking cash.</p>
          <label className="block text-sm">
            Opening float
            <input
              type="number"
              step="0.01"
              min="0"
              className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
              value={floatAmt}
              onChange={(e) => setFloatAmt(e.target.value)}
              required
            />
          </label>
          <button type="submit" className="rounded bg-stone-900 px-4 py-2 text-white">
            Open drawer
          </button>
        </form>
      )}
    </div>
  );
}

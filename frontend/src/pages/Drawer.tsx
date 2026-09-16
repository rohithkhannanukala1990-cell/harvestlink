/**
 * Cash drawer open / close / current status.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { CashDrawer } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { storeQuery } from "../auth/storeQuery";
import { Button, Card, Field, Money, PageHeader, formatMoney } from "../components/ui";

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
      setMessage(`Drawer closed — variance ${formatMoney(data.drawer.variance ?? 0)}`);
      setCounted("");
      void qc.invalidateQueries({ queryKey: ["drawer"] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : "Close failed"),
  });

  if (!activeStoreId) {
    return <p className="text-ink-muted">Select a store.</p>;
  }

  const drawer = drawerQuery.data?.drawer;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PageHeader title="Cash drawer" />
      {message && <p className="text-sm text-ink-muted">{message}</p>}

      {drawer ? (
        <Card title="Open drawer">
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">
              Open since {new Date(drawer.openedAt).toLocaleString()}
            </p>
            <p className="text-ink">
              Opening float:{" "}
              <strong>
                <Money value={drawer.openingFloat} />
              </strong>
            </p>
            {isRole("STORE_ADMIN", "COOP_ADMIN") && (
              <form
                className="space-y-3 border-t border-border-hairline pt-3"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  closeMutation.mutate();
                }}
              >
                <Field
                  label="Counted cash"
                  type="number"
                  step="0.01"
                  min="0"
                  value={counted}
                  onChange={(e) => setCounted(e.target.value)}
                  required
                />
                <Button type="submit" loading={closeMutation.isPending}>
                  Close drawer
                </Button>
              </form>
            )}
          </div>
        </Card>
      ) : (
        <Card title="Open drawer">
          <form
            className="space-y-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              openMutation.mutate();
            }}
          >
            <p className="text-sm text-ink-muted">
              No drawer is open. Open one before taking cash.
            </p>
            <Field
              label="Opening float"
              type="number"
              step="0.01"
              min="0"
              value={floatAmt}
              onChange={(e) => setFloatAmt(e.target.value)}
              required
            />
            <Button type="submit" loading={openMutation.isPending}>
              Open drawer
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}

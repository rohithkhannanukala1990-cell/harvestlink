/**
 * Back-door receiving UI — large touch targets, SKU scan/type, quantity keypad.
 * Over/short receipts require explicit acknowledgement checkboxes before submit.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { PurchaseOrder, PurchaseOrderLine } from "../api/types";
import {
  Button,
  Card,
  Field,
  Keypad,
  Money,
  PageHeader,
  StatusBadge,
} from "../components/ui";

type LineDraft = {
  poLineId: string;
  quantityReceived: string;
  quantityRejected: string;
  rejectionReason: string;
  unitCostActual: string;
  lotNumber: string;
  expiryDate: string;
  countryOfOrigin: string;
  acknowledgeOverReceipt: boolean;
  closeShort: boolean;
  acknowledgeShortReceipt: boolean;
};

export function ReceiveGoodsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [skuInput, setSkuInput] = useState("");
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});

  const poQuery = useQuery({
    queryKey: ["purchase-order", id],
    enabled: !!id,
    queryFn: async () => {
      const data = await apiRequest<{ purchaseOrder: PurchaseOrder }>(
        `/purchasing/purchase-orders/${id}`,
      );
      const map: Record<string, LineDraft> = {};
      for (const line of data.purchaseOrder.lines) {
        if (line.shortClosed || line.receivedQty >= line.orderedQty) continue;
        map[line.id] = {
          poLineId: line.id,
          quantityReceived: "",
          quantityRejected: "0",
          rejectionReason: "",
          unitCostActual: String(line.unitCost),
          lotNumber: "",
          expiryDate: "",
          countryOfOrigin: "",
          acknowledgeOverReceipt: false,
          closeShort: false,
          acknowledgeShortReceipt: false,
        };
      }
      setDrafts(map);
      const first = Object.keys(map)[0];
      if (first) setActiveLineId(first);
      return data;
    },
  });

  const po = poQuery.data?.purchaseOrder;
  const openLines = useMemo(
    () =>
      (po?.lines ?? []).filter(
        (l) => !l.shortClosed && l.receivedQty < l.orderedQty,
      ),
    [po],
  );

  const activeLine = openLines.find((l) => l.id === activeLineId) ?? openLines[0];
  const activeDraft = activeLine ? drafts[activeLine.id] : null;

  function setActiveQty(next: string) {
    if (!activeLine) return;
    setDrafts((prev) => ({
      ...prev,
      [activeLine.id]: { ...prev[activeLine.id]!, quantityReceived: next },
    }));
  }

  function keypad(digit: string) {
    if (!activeDraft) return;
    if (digit === "C") {
      setActiveQty("");
      return;
    }
    if (digit === "⌫") {
      setActiveQty(activeDraft.quantityReceived.slice(0, -1));
      return;
    }
    setActiveQty(`${activeDraft.quantityReceived}${digit}`.replace(/^0+(?=\d)/, ""));
  }

  function findBySku() {
    const sku = skuInput.trim().toLowerCase();
    if (!sku || !po) return;
    const match = openLines.find((l) => l.product?.sku.toLowerCase() === sku);
    if (!match) {
      setMessage(`No open PO line for SKU ${skuInput}`);
      return;
    }
    setActiveLineId(match.id);
    setMessage(`Selected ${match.product?.name}`);
    setSkuInput("");
  }

  const remaining = (line: PurchaseOrderLine) =>
    Math.max(0, line.orderedQty - line.receivedQty);

  const receiveMutation = useMutation({
    mutationFn: () => {
      const lines = Object.values(drafts)
        .filter(
          (d) =>
            Number(d.quantityReceived) > 0 ||
            Number(d.quantityRejected) > 0 ||
            d.closeShort,
        )
        .map((d) => ({
          poLineId: d.poLineId,
          quantityReceived: Number(d.quantityReceived) || 0,
          quantityRejected: Number(d.quantityRejected) || 0,
          rejectionReason: d.rejectionReason || undefined,
          unitCostActual: Number(d.unitCostActual),
          lotNumber: d.lotNumber.trim() || undefined,
          expiryDate: d.expiryDate || undefined,
          countryOfOrigin: d.countryOfOrigin.trim() || undefined,
          acknowledgeOverReceipt: d.acknowledgeOverReceipt || undefined,
          closeShort: d.closeShort || undefined,
          acknowledgeShortReceipt: d.acknowledgeShortReceipt || undefined,
        }));
      if (!lines.length) throw new ApiError(400, "Enter quantities on at least one line");
      return apiRequest(`/purchasing/purchase-orders/${id}/receive`, {
        method: "POST",
        body: { invoiceNumber: invoiceNumber || null, notes: notes || null, lines },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["purchase-order", id] });
      void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
      setMessage("Receipt recorded");
      navigate(`/purchase-orders/${id}`);
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : "Receive failed"),
  });

  if (!po) {
    return <p className="text-ink-muted">Loading PO…</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 pb-8">
      <PageHeader
        title="Receive"
        description={
          <>
            <Link
              to={`/purchase-orders/${id}`}
              className="font-semibold text-brand-terracotta-ink underline"
            >
              ← {po.poNumber}
            </Link>
            <span className="text-ink-muted">
              {" "}
              · {po.supplier?.name} · {po.status}
            </span>
          </>
        }
      />
      {message && (
        <p className="rounded-lg bg-state-warning/15 px-3 py-2 text-sm text-state-warning">
          {message}
        </p>
      )}

      <div className="flex gap-2">
        <Field
          label="Scan or type SKU"
          className="flex-1"
          size="lg"
          autoFocus
          value={skuInput}
          onChange={(e) => setSkuInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              findBySku();
            }
          }}
          placeholder="SKU"
        />
        <div className="flex items-end">
          <Button type="button" size="lg" onClick={findBySku}>
            Find
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {openLines.map((line) => {
          const selected = line.id === (activeLine?.id ?? "");
          const draft = drafts[line.id];
          return (
            <button
              key={line.id}
              type="button"
              onClick={() => setActiveLineId(line.id)}
              className={`w-full rounded-lg border-2 p-4 text-left ${
                selected
                  ? "border-brand-green bg-surface-sunken"
                  : "border-border-hairline bg-surface-raised"
              }`}
            >
              <div className="text-lg font-semibold text-ink">
                {line.product?.name ?? line.productId}
              </div>
              <div className="text-sm text-ink-muted">
                {line.product?.sku} · need{" "}
                <span className="tabular">{remaining(line)}</span> of{" "}
                <span className="tabular">{line.orderedQty}</span> · PO{" "}
                <Money value={line.unitCost} />
              </div>
              {draft?.quantityReceived && (
                <div className="mt-1 text-base font-medium text-ink">
                  Receiving <span className="tabular">{draft.quantityReceived}</span>
                  {draft.lotNumber ? (
                    <span className="ml-2 font-mono text-sm text-ink-muted">
                      lot {draft.lotNumber}
                    </span>
                  ) : null}
                </div>
              )}
            </button>
          );
        })}
        {!openLines.length && (
          <p className="text-sm text-ink-muted">Nothing left to receive on this PO.</p>
        )}
      </div>

      {activeLine && activeDraft && (
        <Card title="Quantity accepted">
          <div className="space-y-3">
            <div className="text-center">
              <div className="tabular text-5xl font-bold tracking-tight text-ink">
                {activeDraft.quantityReceived || "0"}
              </div>
              <div className="text-sm text-ink-muted">
                Outstanding on PO:{" "}
                <span className="tabular">{remaining(activeLine)}</span>
              </div>
            </div>

            <Keypad onKey={keypad} />

            <div className="space-y-3 border-t border-border-hairline pt-3">
              <p className="text-sm font-semibold text-ink">Lot on the box</p>
              <Field
                label="Lot / batch number"
                size="lg"
                value={activeDraft.lotNumber}
                onChange={(e) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [activeLine.id]: {
                      ...prev[activeLine.id]!,
                      lotNumber: e.target.value,
                    },
                  }))
                }
                placeholder="Scan or type lot #"
                autoComplete="off"
                className="font-mono"
              />
              <Field
                label="Expiry / use-by date"
                type="date"
                size="lg"
                value={activeDraft.expiryDate}
                onChange={(e) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [activeLine.id]: {
                      ...prev[activeLine.id]!,
                      expiryDate: e.target.value,
                    },
                  }))
                }
              />
              <Field
                label="Country of origin"
                size="lg"
                value={activeDraft.countryOfOrigin}
                onChange={(e) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [activeLine.id]: {
                      ...prev[activeLine.id]!,
                      countryOfOrigin: e.target.value,
                    },
                  }))
                }
                placeholder="e.g. US"
                maxLength={3}
              />
            </div>

            <Field
              label="Actual unit cost (invoice)"
              size="lg"
              value={activeDraft.unitCostActual}
              onChange={(e) =>
                setDrafts((prev) => ({
                  ...prev,
                  [activeLine.id]: {
                    ...prev[activeLine.id]!,
                    unitCostActual: e.target.value,
                  },
                }))
              }
            />

            <Field
              label="Rejected qty"
              size="lg"
              value={activeDraft.quantityRejected}
              onChange={(e) =>
                setDrafts((prev) => ({
                  ...prev,
                  [activeLine.id]: {
                    ...prev[activeLine.id]!,
                    quantityRejected: e.target.value,
                  },
                }))
              }
            />
            {Number(activeDraft.quantityRejected) > 0 && (
              <Field
                label="Rejection reason"
                size="lg"
                value={activeDraft.rejectionReason}
                onChange={(e) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [activeLine.id]: {
                      ...prev[activeLine.id]!,
                      rejectionReason: e.target.value,
                    },
                  }))
                }
                placeholder="Required when rejecting"
              />
            )}

            {Number(activeDraft.quantityReceived) > remaining(activeLine) && (
              <label className="flex items-start gap-3 rounded-lg bg-state-warning/15 p-3 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5"
                  checked={activeDraft.acknowledgeOverReceipt}
                  onChange={(e) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [activeLine.id]: {
                        ...prev[activeLine.id]!,
                        acknowledgeOverReceipt: e.target.checked,
                      },
                    }))
                  }
                />
                <span>
                  Over-receipt: accepting more than ordered. I acknowledge this mismatch.
                </span>
              </label>
            )}

            <label className="flex items-start gap-3 rounded-lg border border-border-hairline p-3 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-1 h-5 w-5"
                checked={activeDraft.closeShort}
                onChange={(e) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [activeLine.id]: {
                      ...prev[activeLine.id]!,
                      closeShort: e.target.checked,
                      acknowledgeShortReceipt: e.target.checked
                        ? prev[activeLine.id]!.acknowledgeShortReceipt
                        : false,
                    },
                  }))
                }
              />
              <span>Close this line short (supplier will not ship the rest)</span>
            </label>
            {activeDraft.closeShort && (
              <label className="flex items-start gap-3 rounded-lg bg-state-warning/15 p-3 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5"
                  checked={activeDraft.acknowledgeShortReceipt}
                  onChange={(e) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [activeLine.id]: {
                        ...prev[activeLine.id]!,
                        acknowledgeShortReceipt: e.target.checked,
                      },
                    }))
                  }
                />
                <span>
                  Short-receipt acknowledged — line will not stay open for more units.
                </span>
              </label>
            )}
          </div>
        </Card>
      )}

      <Field
        label="Invoice #"
        size="lg"
        value={invoiceNumber}
        onChange={(e) => setInvoiceNumber(e.target.value)}
      />
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold text-ink">Notes</span>
        <textarea
          className="w-full rounded-lg border-2 border-border-strong bg-surface-raised px-4 py-3 text-lg text-ink"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>

      <Button
        type="button"
        size="lg"
        className="w-full"
        disabled={!openLines.length}
        loading={receiveMutation.isPending}
        onClick={() => receiveMutation.mutate()}
      >
        Confirm receipt
      </Button>
      {!openLines.length && <StatusBadge label="Closed" tone="neutral" />}
    </div>
  );
}

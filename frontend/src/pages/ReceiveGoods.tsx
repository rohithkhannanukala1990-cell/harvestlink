/**
 * Back-door receiving UI — large touch targets, SKU scan/type, quantity keypad.
 * Over/short receipts require explicit acknowledgement checkboxes before submit.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest, money } from "../api/client";
import type { PurchaseOrder, PurchaseOrderLine } from "../api/types";

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
    return <p className="text-stone-600">Loading PO…</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 pb-8">
      <div className="flex items-center gap-3">
        <Link to={`/purchase-orders/${id}`} className="text-sm underline">
          ← {po.poNumber}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Receive</h1>
      </div>
      <p className="text-sm text-stone-600">
        {po.supplier?.name} · {po.status}
      </p>
      {message && (
        <p className="rounded bg-amber-100 px-3 py-2 text-sm text-amber-950">{message}</p>
      )}

      <label className="block text-sm font-medium">
        Scan or type SKU
        <div className="mt-1 flex gap-2">
          <input
            autoFocus
            className="min-h-14 flex-1 rounded-xl border-2 border-stone-400 px-4 text-xl"
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
          <button
            type="button"
            className="min-h-14 rounded-xl bg-stone-900 px-5 text-lg text-white"
            onClick={findBySku}
          >
            Find
          </button>
        </div>
      </label>

      <div className="space-y-2">
        {openLines.map((line) => {
          const selected = line.id === (activeLine?.id ?? "");
          const draft = drafts[line.id];
          return (
            <button
              key={line.id}
              type="button"
              onClick={() => setActiveLineId(line.id)}
              className={`w-full rounded-xl border-2 p-4 text-left ${
                selected ? "border-stone-900 bg-stone-100" : "border-stone-200 bg-white"
              }`}
            >
              <div className="text-lg font-semibold">{line.product?.name ?? line.productId}</div>
              <div className="text-sm text-stone-600">
                {line.product?.sku} · need {remaining(line)} of {line.orderedQty} · PO{" "}
                {money(line.unitCost)}
              </div>
              {draft?.quantityReceived && (
                <div className="mt-1 text-base font-medium">
                  Receiving {draft.quantityReceived}
                  {draft.lotNumber ? (
                    <span className="ml-2 font-mono text-sm text-stone-600">
                      lot {draft.lotNumber}
                    </span>
                  ) : null}
                </div>
              )}
            </button>
          );
        })}
        {!openLines.length && (
          <p className="text-sm text-stone-600">Nothing left to receive on this PO.</p>
        )}
      </div>

      {activeLine && activeDraft && (
        <section className="space-y-3 rounded-xl border-2 border-stone-300 bg-white p-4">
          <div className="text-center">
            <div className="text-sm text-stone-500">Quantity accepted</div>
            <div className="font-mono text-5xl font-semibold tracking-tight">
              {activeDraft.quantityReceived || "0"}
            </div>
            <div className="text-sm text-stone-500">
              Outstanding on PO: {remaining(activeLine)}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"].map((key) => (
              <button
                key={key}
                type="button"
                className="min-h-16 rounded-xl bg-stone-800 text-2xl font-medium text-white active:bg-stone-600"
                onClick={() => keypad(key)}
              >
                {key}
              </button>
            ))}
          </div>

          <div className="space-y-3 border-t border-stone-200 pt-3">
            <p className="text-sm font-medium text-stone-700">Lot on the box</p>
            <label className="block text-sm">
              Lot / batch number
              <input
                className="mt-1 min-h-14 w-full rounded-xl border-2 border-stone-400 px-4 text-xl font-mono"
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
              />
            </label>
            <label className="block text-sm">
              Expiry / use-by date
              <input
                type="date"
                className="mt-1 min-h-14 w-full rounded-xl border-2 border-stone-400 px-4 text-xl"
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
            </label>
            <label className="block text-sm">
              Country of origin
              <input
                className="mt-1 min-h-14 w-full rounded-xl border-2 border-stone-400 px-4 text-xl uppercase"
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
            </label>
          </div>

          <label className="block text-sm">
            Actual unit cost (invoice)
            <input
              className="mt-1 min-h-12 w-full rounded-xl border border-stone-300 px-3 text-lg"
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
          </label>

          <label className="block text-sm">
            Rejected qty
            <input
              className="mt-1 min-h-12 w-full rounded-xl border border-stone-300 px-3 text-lg"
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
          </label>
          {Number(activeDraft.quantityRejected) > 0 && (
            <input
              className="min-h-12 w-full rounded-xl border border-stone-300 px-3"
              placeholder="Rejection reason (required)"
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
            />
          )}

          {Number(activeDraft.quantityReceived) > remaining(activeLine) && (
            <label className="flex items-start gap-3 rounded-xl bg-amber-100 p-3 text-sm">
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

          <label className="flex items-start gap-3 rounded-xl border border-stone-200 p-3 text-sm">
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
            <label className="flex items-start gap-3 rounded-xl bg-amber-100 p-3 text-sm">
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
              <span>Short-receipt acknowledged — line will not stay open for more units.</span>
            </label>
          )}
        </section>
      )}

      <label className="block text-sm">
        Invoice #
        <input
          className="mt-1 min-h-12 w-full rounded-xl border border-stone-300 px-3 text-lg"
          value={invoiceNumber}
          onChange={(e) => setInvoiceNumber(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Notes
        <textarea
          className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>

      <button
        type="button"
        disabled={receiveMutation.isPending || !openLines.length}
        onClick={() => receiveMutation.mutate()}
        className="min-h-16 w-full rounded-xl bg-emerald-800 text-xl font-semibold text-white disabled:opacity-40"
      >
        {receiveMutation.isPending ? "Saving…" : "Confirm receipt"}
      </button>
    </div>
  );
}

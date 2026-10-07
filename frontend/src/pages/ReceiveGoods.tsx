/**
 * Back-door receiving UI — large touch targets, barcode scan, quantity keypad.
 * Over/short receipts require explicit acknowledgement checkboxes before submit.
 *
 * Scanning (keyboard-wedge, see scanner/useScanner):
 * - With focus on the lot number or lot label field, a scan fills that field.
 * - Anywhere else, a scan selects the PO line for the product (manufacturer barcode, our SKU, or the
 *   GTIN inside a GS1-128 case label). A GS1 label also fills lot number and expiry when they are
 *   still empty on that line.
 */
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { PurchaseOrder, PurchaseOrderLine } from "../api/types";
import { normalizeBarcode, parseGs1 } from "../scanner/barcode";
import { lookupBarcode } from "../scanner/lookup";
import { useScanner } from "../scanner/useScanner";
import {
  Button,
  Card,
  Field,
  Keypad,
  Money,
  PageHeader,
  StatusBadge,
} from "../components/ui";

type ScanTarget = "lotNumber" | "lotBarcode";

function focusedScanTarget(): ScanTarget | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  const target = el.dataset.scanTarget;
  return target === "lotNumber" || target === "lotBarcode" ? target : null;
}

type LineDraft = {
  poLineId: string;
  quantityReceived: string;
  quantityRejected: string;
  rejectionReason: string;
  unitCostActual: string;
  lotNumber: string;
  lotBarcode: string;
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
          lotBarcode: "",
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

  const patchDraft = useCallback((lineId: string, patch: Partial<LineDraft>) => {
    setDrafts((prev) => (prev[lineId] ? { ...prev, [lineId]: { ...prev[lineId], ...patch } } : prev));
  }, []);

  /** Select the open PO line for a scanned or typed product code; fill lot details from GS1. */
  const selectByCode = useCallback(
    async (raw: string) => {
      if (!po || !raw.trim()) return;
      const typed = raw.trim().toLowerCase();
      const gs1 = parseGs1(raw);
      let line = openLines.find((l) => l.product?.sku.toLowerCase() === typed);
      if (!line) {
        try {
          const storeId = po.storeId ?? openLines[0]?.product?.storeId ?? null;
          const result = await lookupBarcode(storeId, raw);
          const lotLabel = result.matches.find((m) => m.matchedBy === "LOT_BARCODE");
          if (lotLabel) {
            setMessage(
              `${result.code} is already the label of lot ${lotLabel.lot?.lotNumber} (${lotLabel.product.name}). Scan the product barcode instead.`,
            );
            return;
          }
          const productIds = new Set(result.matches.map((m) => m.product.id));
          line = openLines.find((l) => productIds.has(l.productId));
        } catch (err) {
          setMessage(err instanceof ApiError ? err.message : "Barcode lookup failed — try the SKU");
          return;
        }
      }
      if (!line) {
        setMessage(`Nothing on this PO matches ${normalizeBarcode(raw).code}`);
        return;
      }
      setActiveLineId(line.id);
      const current = drafts[line.id];
      const fill: Partial<LineDraft> = {};
      if (gs1?.lot && !current?.lotNumber) fill.lotNumber = gs1.lot;
      const expiry = gs1?.expiry ?? gs1?.bestBefore;
      if (expiry && !current?.expiryDate) fill.expiryDate = expiry;
      patchDraft(line.id, fill);
      const filled = [fill.lotNumber && `lot ${fill.lotNumber}`, fill.expiryDate && `expiry ${fill.expiryDate}`]
        .filter(Boolean)
        .join(", ");
      setMessage(`Selected ${line.product?.name}${filled ? ` — ${filled} from the label` : ""}`);
      setSkuInput("");
    },
    [po, openLines, drafts, patchDraft],
  );

  const handleScan = useCallback(
    (raw: string) => {
      const target = focusedScanTarget();
      if (target && activeLine) {
        if (target === "lotBarcode") {
          patchDraft(activeLine.id, { lotBarcode: normalizeBarcode(raw).code });
        } else {
          const gs1 = parseGs1(raw);
          patchDraft(activeLine.id, { lotNumber: gs1?.lot ?? raw.trim() });
        }
        return;
      }
      void selectByCode(raw);
    },
    [activeLine, patchDraft, selectByCode],
  );

  useScanner(handleScan, { enabled: openLines.length > 0 });

  function findBySku() {
    void selectByCode(skuInput);
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
          lotBarcode: d.lotBarcode.trim() || undefined,
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
          label="Scan a product or type its SKU"
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
          placeholder="Barcode or SKU"
          autoComplete="off"
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
                data-scan-target="lotNumber"
              />
              <Field
                label="Lot label barcode (optional)"
                hint="If the case carries its own lot barcode, scan it here so counts and lookups find this lot directly."
                size="lg"
                value={activeDraft.lotBarcode}
                onChange={(e) => patchDraft(activeLine.id, { lotBarcode: e.target.value })}
                placeholder="Scan the lot label"
                autoComplete="off"
                className="font-mono"
                data-scan-target="lotBarcode"
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

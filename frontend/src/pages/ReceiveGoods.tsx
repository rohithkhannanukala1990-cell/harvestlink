/**
 * Back-door receiving UI — large touch targets, barcode scan, quantity keypad.
 * Over/short receipts require explicit acknowledgement checkboxes before submit.
 * Shipment POs: read-only landed add-on / landed cost from server; FPO/exporter origin;
 * compliance warnings (terracotta) with acknowledgement.
 *
 * Scanning (keyboard-wedge, see scanner/useScanner):
 * - With focus on the lot number or lot label field, a scan fills that field.
 * - Anywhere else, a scan selects the PO line for the product.
 */
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { OrganicStatus, PurchaseOrder, PurchaseOrderLine } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { normalizeBarcode, parseGs1 } from "../scanner/barcode";
import { lookupBarcode } from "../scanner/lookup";
import { useScanner } from "../scanner/useScanner";
import {
  Button,
  Card,
  Field,
  Keypad,
  PageHeader,
  SelectField,
  StatusBadge,
  UnitCost,
} from "../components/ui";

type ScanTarget = "lotNumber" | "lotBarcode";

function focusedScanTarget(): ScanTarget | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  const target = el.dataset.scanTarget;
  return target === "lotNumber" || target === "lotBarcode" ? target : null;
}

type OriginDraft = {
  state: string;
  district: string;
  village: string;
  crop: string;
  variety: string;
  harvestSeason: string;
  contributingFarmerCount: string;
  organicStatus: OrganicStatus;
  fpoSupplierId: string;
};

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
  origin: OriginDraft;
};

const emptyOrigin = (): OriginDraft => ({
  state: "",
  district: "",
  village: "",
  crop: "",
  variety: "",
  harvestSeason: "",
  contributingFarmerCount: "",
  organicStatus: "CONVENTIONAL",
  fpoSupplierId: "",
});

function landedUnit(
  invoice: string,
  addOn: string | undefined,
): string | null {
  const inv = Number(invoice);
  const add = addOn != null ? Number(addOn) : 0;
  if (!Number.isFinite(inv)) return null;
  return (inv + (Number.isFinite(add) ? add : 0)).toFixed(4);
}

export function ReceiveGoodsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { isRole } = useAuth();
  const [skuInput, setSkuInput] = useState("");
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  const [acknowledgeComplianceGaps, setAcknowledgeComplianceGaps] = useState(false);
  const [acknowledgeNoLandedCost, setAcknowledgeNoLandedCost] = useState(false);

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
          origin: emptyOrigin(),
        };
      }
      setDrafts(map);
      const first = Object.keys(map)[0];
      if (first) setActiveLineId(first);
      return data;
    },
  });

  const po = poQuery.data?.purchaseOrder;
  const supplierType = po?.supplier?.supplierType;
  const needsOrigin = supplierType === "FPO" || supplierType === "EXPORTER";
  const isExporter = supplierType === "EXPORTER";
  const shipment = po?.importShipment ?? null;
  const landedByLine = po?.landedPreviewByPoLineId ?? {};
  const complianceGaps = po?.complianceGaps ?? [];
  const requiresLandedCostAck = Boolean(po?.requiresLandedCostAck);

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
        .map((d) => {
          const originPayload =
            needsOrigin &&
            (Number(d.quantityReceived) > 0 || Number(d.quantityRejected) > 0)
              ? {
                  state: d.origin.state.trim(),
                  district: d.origin.district.trim(),
                  village: d.origin.village.trim() || undefined,
                  crop: d.origin.crop.trim(),
                  variety: d.origin.variety.trim() || undefined,
                  harvestSeason: d.origin.harvestSeason.trim() || undefined,
                  contributingFarmerCount: d.origin.contributingFarmerCount
                    ? Number(d.origin.contributingFarmerCount)
                    : undefined,
                  organicStatus: d.origin.organicStatus,
                  ...(isExporter && d.origin.fpoSupplierId
                    ? { fpoSupplierId: d.origin.fpoSupplierId }
                    : {}),
                }
              : undefined;
          return {
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
            origin: originPayload,
          };
        });
      if (!lines.length) throw new ApiError(400, "Enter quantities on at least one line");
      return apiRequest(`/purchasing/purchase-orders/${id}/receive`, {
        method: "POST",
        body: {
          invoiceNumber: invoiceNumber || null,
          notes: notes || null,
          lines,
          ...(isRole("COOP_ADMIN") && acknowledgeComplianceGaps
            ? { acknowledgeComplianceGaps: true }
            : {}),
          ...(isRole("COOP_ADMIN") && acknowledgeNoLandedCost
            ? { acknowledgeNoLandedCost: true }
            : {}),
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["purchase-order", id] });
      void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
      setMessage("Receipt recorded");
      navigate(`/purchase-orders/${id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && err.details) {
        const gaps = (err.details as { gaps?: Array<{ message: string }> }).gaps;
        if (gaps?.length) {
          setMessage(
            `Compliance gaps: ${gaps.map((g) => g.message).join("; ")}. COOP_ADMIN may acknowledge to proceed.`,
          );
          return;
        }
      }
      setMessage(err instanceof ApiError ? err.message : "Receive failed");
    },
  });

  if (!po) {
    return <p className="text-ink-muted">Loading PO…</p>;
  }

  const activeAddOn = activeLine
    ? landedByLine[activeLine.id]?.landedAddOnPerUnit
    : undefined;
  const activeLanded =
    activeDraft && activeAddOn != null
      ? landedUnit(activeDraft.unitCostActual, activeAddOn)
      : activeDraft && shipment
        ? landedUnit(activeDraft.unitCostActual, "0")
        : null;

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
      {shipment && (
        <p className="rounded-lg border border-brand-terracotta/30 bg-brand-terracotta/10 px-3 py-2 text-sm text-brand-terracotta-ink">
          Import shipment{" "}
          <Link
            to={`/shipments/${shipment.id}`}
            className="font-semibold underline"
          >
            {shipment.shipmentNumber}
          </Link>
          {" · "}
          {shipment.status.replace(/_/g, " ")}
          {shipment.containerNumber ? ` · ${shipment.containerNumber}` : ""}
        </p>
      )}
      {complianceGaps.length > 0 && (
        <div
          className="rounded-lg border border-brand-terracotta/40 bg-brand-terracotta/10 px-3 py-2 text-sm text-brand-terracotta-ink"
          role="status"
        >
          <p className="font-semibold">Compliance warnings</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {complianceGaps.map((g) => (
              <li key={g.code}>{g.message}</li>
            ))}
          </ul>
          {isRole("COOP_ADMIN") && (
            <label className="mt-3 flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 h-5 w-5"
                checked={acknowledgeComplianceGaps}
                onChange={(e) => setAcknowledgeComplianceGaps(e.target.checked)}
              />
              <span>I acknowledge these compliance gaps and will receive anyway.</span>
            </label>
          )}
        </div>
      )}
      {requiresLandedCostAck && isRole("COOP_ADMIN") && (
        <label className="flex items-start gap-3 rounded-lg border border-brand-terracotta/40 bg-brand-terracotta/10 p-3 text-sm text-brand-terracotta-ink">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5"
            checked={acknowledgeNoLandedCost}
            onChange={(e) => setAcknowledgeNoLandedCost(e.target.checked)}
          />
          <span>
            This shipment has no landed costs yet. Acknowledge receiving with $0 add-on.
          </span>
        </label>
      )}
      {message && (
        <p className="rounded-lg bg-brand-terracotta/15 px-3 py-2 text-sm text-brand-terracotta-ink">
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
          const addOn = landedByLine[line.id]?.landedAddOnPerUnit;
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
                <span className="tabular">{line.orderedQty}</span> · invoice{" "}
                <UnitCost value={draft?.unitCostActual ?? line.unitCost} />
                {addOn != null && (
                  <>
                    {" "}
                    · add-on <UnitCost value={addOn} /> · landed{" "}
                    <UnitCost
                      value={
                        landedUnit(draft?.unitCostActual ?? String(line.unitCost), addOn) ??
                        addOn
                      }
                    />
                  </>
                )}
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
                  patchDraft(activeLine.id, { lotNumber: e.target.value })
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
                  patchDraft(activeLine.id, { expiryDate: e.target.value })
                }
              />
              <Field
                label="Country of origin"
                size="lg"
                value={activeDraft.countryOfOrigin}
                onChange={(e) =>
                  patchDraft(activeLine.id, { countryOfOrigin: e.target.value })
                }
                placeholder="e.g. US"
                maxLength={3}
              />
            </div>

            <Field
              label="Invoice unit cost"
              size="lg"
              value={activeDraft.unitCostActual}
              onChange={(e) =>
                patchDraft(activeLine.id, { unitCostActual: e.target.value })
              }
            />
            {shipment && (
              <div className="grid grid-cols-2 gap-3 rounded-lg border border-border-hairline bg-surface-sunken p-3 text-sm">
                <div>
                  <p className="font-semibold text-ink-muted">Landed add-on</p>
                  <p className="tabular text-lg text-ink">
                    <UnitCost value={activeAddOn ?? "0"} />
                  </p>
                  <p className="text-xs text-ink-muted">From shipment allocation</p>
                </div>
                <div>
                  <p className="font-semibold text-ink-muted">Landed unit cost</p>
                  <p className="tabular text-lg text-ink">
                    <UnitCost value={activeLanded ?? activeDraft.unitCostActual} />
                  </p>
                  <p className="text-xs text-ink-muted">Invoice + add-on</p>
                </div>
              </div>
            )}

            {needsOrigin && (
              <div className="space-y-3 rounded-lg border border-brand-terracotta/30 bg-brand-terracotta/5 p-3">
                <p className="text-sm font-semibold text-brand-terracotta-ink">
                  Sourcing origin (required for {supplierType})
                </p>
                {isExporter && (
                  <Field
                    label="FPO supplier id"
                    size="lg"
                    value={activeDraft.origin.fpoSupplierId}
                    onChange={(e) =>
                      patchDraft(activeLine.id, {
                        origin: {
                          ...activeDraft.origin,
                          fpoSupplierId: e.target.value,
                        },
                      })
                    }
                    placeholder="Growing FPO supplier id"
                  />
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="State"
                    size="lg"
                    value={activeDraft.origin.state}
                    onChange={(e) =>
                      patchDraft(activeLine.id, {
                        origin: { ...activeDraft.origin, state: e.target.value },
                      })
                    }
                    required
                  />
                  <Field
                    label="District"
                    size="lg"
                    value={activeDraft.origin.district}
                    onChange={(e) =>
                      patchDraft(activeLine.id, {
                        origin: { ...activeDraft.origin, district: e.target.value },
                      })
                    }
                    required
                  />
                  <Field
                    label="Village"
                    size="lg"
                    value={activeDraft.origin.village}
                    onChange={(e) =>
                      patchDraft(activeLine.id, {
                        origin: { ...activeDraft.origin, village: e.target.value },
                      })
                    }
                  />
                  <Field
                    label="Crop"
                    size="lg"
                    value={activeDraft.origin.crop}
                    onChange={(e) =>
                      patchDraft(activeLine.id, {
                        origin: { ...activeDraft.origin, crop: e.target.value },
                      })
                    }
                    required
                  />
                  <Field
                    label="Season"
                    size="lg"
                    value={activeDraft.origin.harvestSeason}
                    onChange={(e) =>
                      patchDraft(activeLine.id, {
                        origin: {
                          ...activeDraft.origin,
                          harvestSeason: e.target.value,
                        },
                      })
                    }
                    placeholder="e.g. Rabi 2026"
                  />
                  <Field
                    label="Farmer count"
                    size="lg"
                    value={activeDraft.origin.contributingFarmerCount}
                    onChange={(e) =>
                      patchDraft(activeLine.id, {
                        origin: {
                          ...activeDraft.origin,
                          contributingFarmerCount: e.target.value,
                        },
                      })
                    }
                  />
                </div>
                <SelectField
                  label="Organic status"
                  value={activeDraft.origin.organicStatus}
                  onChange={(e) =>
                    patchDraft(activeLine.id, {
                      origin: {
                        ...activeDraft.origin,
                        organicStatus: e.target.value as OrganicStatus,
                      },
                    })
                  }
                >
                  <option value="CONVENTIONAL">Conventional</option>
                  <option value="IN_CONVERSION">In conversion</option>
                  <option value="CERTIFIED_ORGANIC">Certified organic</option>
                </SelectField>
              </div>
            )}

            <Field
              label="Rejected qty"
              size="lg"
              value={activeDraft.quantityRejected}
              onChange={(e) =>
                patchDraft(activeLine.id, { quantityRejected: e.target.value })
              }
            />
            {Number(activeDraft.quantityRejected) > 0 && (
              <Field
                label="Rejection reason"
                size="lg"
                value={activeDraft.rejectionReason}
                onChange={(e) =>
                  patchDraft(activeLine.id, { rejectionReason: e.target.value })
                }
                placeholder="Required when rejecting"
              />
            )}

            {Number(activeDraft.quantityReceived) > remaining(activeLine) && (
              <label className="flex items-start gap-3 rounded-lg bg-brand-terracotta/15 p-3 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5"
                  checked={activeDraft.acknowledgeOverReceipt}
                  onChange={(e) =>
                    patchDraft(activeLine.id, {
                      acknowledgeOverReceipt: e.target.checked,
                    })
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
                  patchDraft(activeLine.id, {
                    closeShort: e.target.checked,
                    acknowledgeShortReceipt: e.target.checked
                      ? activeDraft.acknowledgeShortReceipt
                      : false,
                  })
                }
              />
              <span>Close this line short (supplier will not ship the rest)</span>
            </label>
            {activeDraft.closeShort && (
              <label className="flex items-start gap-3 rounded-lg bg-brand-terracotta/15 p-3 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5"
                  checked={activeDraft.acknowledgeShortReceipt}
                  onChange={(e) =>
                    patchDraft(activeLine.id, {
                      acknowledgeShortReceipt: e.target.checked,
                    })
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

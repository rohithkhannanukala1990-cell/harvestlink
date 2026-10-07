/**
 * Scan-first counting screen: scan a barcode, type a quantity, press Enter, move on.
 *
 * Built for one hand on an RF gun or a tablet with a ring scanner — every action has a key:
 *   scan            open the lot (or the lot picker when a product has several lots on the count)
 *   scan same item  +1 (count unit by unit)
 *   digits, +       quantity; "12+6" adds stock found in two places
 *   Enter           save           Esc   cancel
 *   1–9             pick a lot from the picker
 * Touch: big keypad, big buttons, tap a line in the list to open it without a barcode.
 *
 * BLIND: the sheet from GET /stock-counts/:id never contains expected quantities, and nothing
 * here derives one. The only figures shown are what this counter has typed.
 *
 * OFFLINE: every saved quantity goes into the IndexedDB queue first and is sent from there
 * (offline/countSync), so the screen behaves the same with or without signal. The sheet is cached
 * so the screen opens and resolves scans offline (resolveCountScan, no server lookup).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../api/client";
import type { StockCountSheet, StockCountSheetLine } from "../api/types";
import {
  cacheCountSheet,
  enqueueCountEntry,
  listQueuedCountEntries,
  newIdempotencyKey,
  readCachedCountSheet,
  removeCountEntry,
  type QueuedCountEntry,
} from "../offline/countQueue";
import { syncQueuedCounts } from "../offline/countSync";
import { useOnlineStatus } from "../offline/useOnlineStatus";
import { parseQuantityEntry } from "../scanner/quantityEntry";
import { resolveCountScan } from "../scanner/resolveCountScan";
import { useScanner } from "../scanner/useScanner";
import { Button, Card, Field, Keypad, PageHeader, StatusBadge } from "../components/ui";
import { DEFAULT_SCAN_OPTIONS } from "../scanner/scanDetector";

type LocalStatus = "TO_COUNT" | "RECOUNT" | "QUEUED" | "DONE";

type Selection =
  | { kind: "line"; line: StockCountSheetLine }
  | { kind: "choose"; lines: StockCountSheetLine[] }
  | null;

type Notice = { tone: "success" | "warning" | "danger"; text: string } | null;

const STATUS_LABEL: Record<LocalStatus, { label: string; tone: "neutral" | "warning" | "gold" | "success" }> = {
  TO_COUNT: { label: "To count", tone: "neutral" },
  RECOUNT: { label: "Recount", tone: "warning" },
  QUEUED: { label: "Saved on device", tone: "gold" },
  DONE: { label: "Counted", tone: "success" },
};

const NOTICE_CLASS: Record<NonNullable<Notice>["tone"], string> = {
  success: "bg-state-success/15 text-state-success",
  warning: "bg-state-warning/15 text-state-warning",
  danger: "bg-state-danger/15 text-state-danger",
};

function lineLabel(line: StockCountSheetLine): string {
  return `${line.productName}${line.lotNumber ? ` · lot ${line.lotNumber}` : ""}`;
}

function formatExpiry(date: string | null): string | null {
  return date ? new Date(date).toLocaleDateString() : null;
}

export function CountScanPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const online = useOnlineStatus();

  const [cached, setCached] = useState<{ sheet: StockCountSheet; cachedAt: string } | null>(null);
  const [queue, setQueue] = useState<QueuedCountEntry[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [qty, setQty] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [manualCode, setManualCode] = useState("");
  const qtyRef = useRef<HTMLInputElement>(null);

  const sheetQuery = useQuery({
    queryKey: ["stock-count-sheet", id],
    enabled: !!id && online,
    queryFn: async () => {
      const sheet = await apiRequest<StockCountSheet>(`/stock-counts/${id}`);
      await cacheCountSheet(sheet);
      return sheet;
    },
  });

  useEffect(() => {
    void readCachedCountSheet(id).then(setCached);
  }, [id, sheetQuery.dataUpdatedAt]);

  const sheet = (online && sheetQuery.data) || cached?.sheet || null;

  const refreshQueue = useCallback(async () => {
    setQueue(await listQueuedCountEntries(id));
  }, [id]);

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  const runSync = useCallback(async () => {
    if (!navigator.onLine) return;
    const result = await syncQueuedCounts(id);
    await refreshQueue();
    if (result.synced > 0) await qc.invalidateQueries({ queryKey: ["stock-count-sheet", id] });
    const recounts = Object.values(result.statuses).filter((s) => s === "RECOUNT_REQUIRED").length;
    if (result.rejected > 0) {
      setNotice({ tone: "danger", text: `${result.rejected} saved count(s) were not accepted — see below.` });
    } else if (recounts > 0) {
      setNotice({
        tone: "warning",
        text: `${recounts} line(s) need a recount, ideally by someone else.`,
      });
    }
  }, [id, qc, refreshQueue]);

  // Same triggers as the POS sale queue: coming back online, returning to the tab, and a steady
  // retry while anything is waiting.
  useEffect(() => {
    if (online) void runSync();
  }, [online, runSync]);
  const waiting = queue.some((e) => !e.rejected);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void runSync();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = waiting && online ? window.setInterval(() => void runSync(), 30_000) : undefined;
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [runSync, waiting, online]);

  const queuedLines = useMemo(
    () => new Set(queue.filter((e) => !e.rejected).map((e) => e.lineId)),
    [queue],
  );

  const statusOf = useCallback(
    (line: StockCountSheetLine): LocalStatus => {
      if (queuedLines.has(line.id)) return "QUEUED";
      if (line.status === "PENDING") return "TO_COUNT";
      if (line.status === "RECOUNT_REQUIRED") return "RECOUNT";
      return "DONE";
    },
    [queuedLines],
  );

  const counting = sheet?.status === "IN_PROGRESS";

  const openLine = useCallback(
    (line: StockCountSheetLine) => {
      const status = statusOf(line);
      if (status === "QUEUED") {
        setNotice({ tone: "warning", text: `${lineLabel(line)} is already counted on this device (waiting to send).` });
        setSelection(null);
        return;
      }
      if (status === "DONE") {
        setNotice({ tone: "warning", text: `${lineLabel(line)} is already counted.` });
        setSelection(null);
        return;
      }
      setNotice(
        status === "RECOUNT" && line.recountByAnotherPerson
          ? { tone: "warning", text: "You did the first count here — ask a colleague to recount it if anyone is free." }
          : null,
      );
      setSelection({ kind: "line", line });
      setQty("");
    },
    [statusOf],
  );

  const handleScan = useCallback(
    (code: string) => {
      if (!sheet || !counting) return;
      const resolution = resolveCountScan(sheet, code);
      const open = selection?.kind === "line" ? selection.line : null;
      // From the DOM, not state: see useScanner on leaked characters.
      const typed = qtyRef.current?.value ?? "";

      if (open && resolution.kind === "line" && resolution.line.id === open.id) {
        // Same item again: count unit by unit. The scan that opened the line was the first unit.
        setQty(String((parseQuantityEntry(typed) ?? 1) + 1));
        return;
      }
      if (open && typed.trim() !== "") {
        setNotice({
          tone: "warning",
          text: `Press Enter to save ${typed} for ${lineLabel(open)} first, or Esc to discard it.`,
        });
        return;
      }
      if (resolution.kind === "not-on-count") {
        setNotice({ tone: "warning", text: `${resolution.code} is not on this count.` });
        setSelection(null);
        return;
      }
      if (resolution.kind === "choose-lot") {
        setNotice(null);
        setSelection({ kind: "choose", lines: resolution.lines });
        return;
      }
      openLine(resolution.line);
    },
    [sheet, counting, selection, openLine],
  );

  const scanner = useScanner(handleScan, { enabled: counting });

  useEffect(() => {
    if (selection?.kind === "line") qtyRef.current?.focus();
  }, [selection]);

  // Lot picker keys 1–9. A barcode's leading digits reach this listener before the scanner is
  // recognized, so a digit acts only after the scan detector has gone quiet: a lone keypress has,
  // a scan is still open (or has been delivered, which changes the selection and cancels this).
  useEffect(() => {
    if (selection?.kind !== "choose") return;
    const lines = selection.lines;
    let timer: number | undefined;
    const onKey = (e: KeyboardEvent) => {
      window.clearTimeout(timer);
      if (e.key === "Escape") {
        setSelection(null);
        return;
      }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > Math.min(9, lines.length)) return;
      timer = window.setTimeout(() => {
        if (!scanner.isReceiving()) openLine(lines[n - 1]!);
      }, DEFAULT_SCAN_OPTIONS.endTimeoutMs + 20);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
    };
  }, [selection, openLine, scanner]);

  async function save() {
    if (selection?.kind !== "line" || !sheet) return;
    const line = selection.line;
    const quantity = parseQuantityEntry(qty);
    if (quantity === null) {
      setNotice({ tone: "danger", text: "Enter a whole number (use + to add stock from several places)." });
      return;
    }
    await enqueueCountEntry({
      idempotencyKey: newIdempotencyKey(),
      countId: sheet.id,
      storeId: sheet.storeId,
      lineId: line.id,
      countedQuantity: quantity,
      recount: line.status === "RECOUNT_REQUIRED",
      countedAt: new Date().toISOString(),
      productName: line.productName,
      sku: line.sku,
      lotNumber: line.lotNumber,
    });
    await refreshQueue();
    setSelection(null);
    setQty("");
    qtyRef.current?.blur();
    setNotice({
      tone: "success",
      text: `Saved ${quantity} × ${lineLabel(line)}${navigator.onLine ? "" : " — on this device until signal returns"}.`,
    });
    void runSync();
  }

  function keypad(key: string) {
    if (key === "C") setQty("");
    else if (key === "⌫") setQty((q) => q.slice(0, -1));
    else setQty((q) => `${q}${key}`.replace(/^0+(?=\d)/, ""));
  }

  const completeMutation = useMutation({
    mutationFn: () => apiRequest(`/stock-counts/${id}/complete`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["stock-counts"] });
      navigate("/counts");
    },
    onError: (err) =>
      setNotice({ tone: "danger", text: err instanceof ApiError ? err.message : "Could not finish the count" }),
  });

  if (!sheet) {
    return (
      <p className="text-ink-muted">
        {online ? "Loading count…" : "Offline, and this count has not been opened on this device before."}
      </p>
    );
  }

  const lines = sheet.lines;
  const byStatus = (s: LocalStatus) => lines.filter((l) => statusOf(l) === s);
  const toCount = byStatus("TO_COUNT");
  const recount = byStatus("RECOUNT");
  const done = lines.length - toCount.length - recount.length;
  const rejected = queue.filter((e) => e.rejected);
  const canFinish = online && counting && toCount.length === 0 && recount.length === 0 && !waiting;
  const selectedLine = selection?.kind === "line" ? selection.line : null;
  const parsedQty = parseQuantityEntry(qty);

  return (
    <div className="mx-auto max-w-lg space-y-4 pb-10">
      <PageHeader
        title="Count"
        description={
          <>
            <Link to="/counts" className="font-semibold text-brand-terracotta-ink underline">
              ← Counts
            </Link>
            <span className="text-ink-muted">
              {" "}
              · {sheet.type} · <span className="tabular">{done}</span> of{" "}
              <span className="tabular">{lines.length}</span> done
            </span>
          </>
        }
        actions={
          online ? (
            waiting ? (
              <StatusBadge label="Sending…" tone="gold" />
            ) : (
              <StatusBadge label="Online" tone="success" />
            )
          ) : (
            <StatusBadge label="Offline — saving on device" tone="warning" />
          )
        }
      />

      {!counting && (
        <p className="rounded-lg bg-surface-sunken px-3 py-2 text-sm text-ink">
          This count is {sheet.status.replace("_", " ").toLowerCase()} — counting is closed.
        </p>
      )}

      {notice && (
        <p className={`rounded-lg px-3 py-3 text-base font-medium ${NOTICE_CLASS[notice.tone]}`} role="status">
          {notice.text}
        </p>
      )}

      {counting && selectedLine && (
        <Card>
          <div className="space-y-3">
            <div>
              <p className="text-2xl font-bold leading-tight text-ink">{selectedLine.productName}</p>
              <p className="text-base text-ink-muted">
                <span className="font-mono">{selectedLine.sku}</span>
                {selectedLine.lotNumber && (
                  <>
                    {" "}
                    · lot <span className="font-mono">{selectedLine.lotNumber}</span>
                  </>
                )}
                {formatExpiry(selectedLine.expiryDate) && <> · exp {formatExpiry(selectedLine.expiryDate)}</>}
              </p>
              {selectedLine.status === "RECOUNT_REQUIRED" && (
                <span className="mt-1 inline-block">
                  <StatusBadge label="Recount" tone="warning" />
                </span>
              )}
            </div>

            <label className="block">
              <span className="text-sm font-semibold text-ink">How many are there?</span>
              <input
                ref={qtyRef}
                value={qty}
                onChange={(e) => setQty(e.target.value.replace(/[^\d+\s]/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void save();
                  } else if (e.key === "Escape") {
                    setSelection(null);
                    setQty("");
                  }
                }}
                inputMode="numeric"
                autoComplete="off"
                aria-describedby="qty-hint"
                className="tabular mt-1 h-20 w-full rounded-lg border-2 border-border-strong bg-surface-raised px-4 text-center text-5xl font-bold text-ink"
              />
              <span id="qty-hint" className="mt-1 block text-sm text-ink-muted">
                {qty.includes("+") && parsedQty !== null ? (
                  <>
                    = <span className="tabular font-semibold text-ink">{parsedQty}</span> ·{" "}
                  </>
                ) : null}
                Enter saves · Esc cancels · scan again to count one by one · + adds places
              </span>
            </label>

            <Keypad onKey={keypad} />
            <div className="grid grid-cols-3 gap-2">
              <Button type="button" variant="quiet" size="lg" className="h-16 text-2xl" onClick={() => setQty((q) => (q && !q.endsWith("+") ? `${q}+` : q))}>
                +
              </Button>
              <Button
                type="button"
                size="lg"
                className="col-span-2 h-16 text-xl"
                disabled={parsedQty === null}
                onClick={() => void save()}
              >
                Save
              </Button>
            </div>
            <Button
              type="button"
              variant="quiet"
              size="lg"
              className="w-full"
              onClick={() => {
                setSelection(null);
                setQty("");
              }}
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {counting && selection?.kind === "choose" && (
        <Card title="Which lot? Press 1–9, tap, or scan the lot label">
          <div className="space-y-2">
            {selection.lines.map((line, i) => {
              const status = statusOf(line);
              return (
                <button
                  key={line.id}
                  type="button"
                  onClick={() => openLine(line)}
                  className="flex min-h-16 w-full items-center gap-4 rounded-lg border-2 border-border-strong bg-surface-raised px-4 py-3 text-left"
                >
                  <span className="tabular flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-canopy text-xl font-bold text-ink-inverse">
                    {i + 1}
                  </span>
                  <span className="flex-1">
                    <span className="block text-lg font-semibold text-ink">lot {line.lotNumber ?? "—"}</span>
                    <span className="block text-sm text-ink-muted">
                      {formatExpiry(line.expiryDate) ? `exp ${formatExpiry(line.expiryDate)}` : "no expiry"}
                    </span>
                  </span>
                  <StatusBadge label={STATUS_LABEL[status].label} tone={STATUS_LABEL[status].tone} />
                </button>
              );
            })}
            <Button type="button" variant="quiet" size="lg" className="w-full" onClick={() => setSelection(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {counting && !selection && (
        <div className="rounded-lg border-2 border-dashed border-border-strong bg-surface-raised px-4 py-8 text-center">
          <p className="text-3xl font-bold text-ink">Scan a barcode</p>
          <p className="mt-1 text-sm text-ink-muted">Product, case, or lot label</p>
        </div>
      )}

      {counting && (
        <form
          data-scanner="off"
          onSubmit={(e) => {
            e.preventDefault();
            const code = manualCode.trim();
            if (!code) return;
            setManualCode("");
            handleScan(code);
          }}
          className="flex items-end gap-2"
        >
          <Field
            label="No barcode? Type it, the SKU, or the lot number"
            size="lg"
            className="flex-1"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            autoComplete="off"
          />
          <Button type="submit" size="lg" variant="quiet">
            Find
          </Button>
        </form>
      )}

      {rejected.length > 0 && (
        <Card title="Not accepted">
          <ul className="space-y-2">
            {rejected.map((e) => (
              <li key={e.idempotencyKey} className="flex items-start justify-between gap-3 text-sm">
                <span>
                  <span className="font-semibold text-ink">
                    {e.productName}
                    {e.lotNumber ? ` · lot ${e.lotNumber}` : ""}
                  </span>
                  <span className="block text-state-danger">{e.lastError}</span>
                </span>
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() => void removeCountEntry(e.idempotencyKey).then(refreshQueue)}
                >
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={`Lots on this count (${lines.length})`}>
        <ul className="divide-y divide-border-hairline">
          {[...recount, ...toCount, ...lines.filter((l) => !recount.includes(l) && !toCount.includes(l))].map((line) => {
            const status = statusOf(line);
            return (
              <li key={line.id}>
                <button
                  type="button"
                  disabled={!counting}
                  onClick={() => openLine(line)}
                  className="flex min-h-14 w-full items-center justify-between gap-3 py-2 text-left"
                >
                  <span>
                    <span className="block font-semibold text-ink">{line.productName}</span>
                    <span className="block text-sm text-ink-muted">
                      <span className="font-mono">{line.sku}</span>
                      {line.lotNumber ? ` · lot ${line.lotNumber}` : ""}
                    </span>
                  </span>
                  <StatusBadge label={STATUS_LABEL[status].label} tone={STATUS_LABEL[status].tone} />
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      {counting && (
        <Button
          type="button"
          size="lg"
          className="w-full"
          disabled={!canFinish}
          loading={completeMutation.isPending}
          onClick={() => completeMutation.mutate()}
        >
          Finish count
        </Button>
      )}
      {counting && !canFinish && (
        <p className="text-center text-sm text-ink-muted">
          {!online
            ? "Finishing needs a connection."
            : waiting
              ? "Waiting for saved counts to send."
              : "Every lot must be counted, and every recount done, before finishing."}
        </p>
      )}
      {!online && cached && (
        <p className="text-center text-xs text-ink-muted">
          Using the copy of this count saved {new Date(cached.cachedAt).toLocaleString()}.
        </p>
      )}
    </div>
  );
}

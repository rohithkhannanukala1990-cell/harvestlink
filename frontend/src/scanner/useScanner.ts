/**
 * Listens for keyboard-wedge scanner input anywhere on the page and hands each scan to `onScan`.
 *
 * Generic on purpose: counting, receiving and lot lookup all use it. Detection lives in
 * ScanDetector (read its header before changing thresholds); this hook only connects it to the DOM:
 *
 * - Listens on window in the CAPTURE phase, so it sees keys before React handlers and before the
 *   focused input does, and can stop a scan's Enter from submitting a form.
 * - When a run starts while an input or textarea has focus, snapshots that field. If the run turns
 *   out to be a scan, the characters that leaked in before recognition are removed by restoring
 *   the snapshot through the native value setter plus an `input` event, which React's onChange
 *   sees — a controlled input's state is restored too.
 * - Inside an element marked `data-scanner="off"` the hook steps aside entirely: that field takes
 *   scanner output as ordinary typing (a "type or scan a barcode" box handles its own Enter).
 *
 * Page handlers see the first characters of every scan before it is recognized (they cannot be
 * held back). Two consequences for callers:
 * - Inside onScan, read field values from the DOM, not from React state captured in the closure:
 *   the closure may have been rendered with the leaked characters; the DOM has been restored.
 * - A page acting on single keys (e.g. "press 2 to pick") should delay the action and skip it while
 *   isReceiving() is true — otherwise the leading digit of a barcode triggers it.
 */
import { useEffect, useMemo, useRef } from "react";
import { ScanDetector, type ScanDetectorOptions } from "./scanDetector";

export type UseScannerOptions = Partial<ScanDetectorOptions> & {
  enabled?: boolean;
};

export type ScannerHandle = {
  /** True while a keystroke run is open — it may still turn out to be a scan. */
  isReceiving: () => boolean;
};

type Snapshot = { el: HTMLInputElement | HTMLTextAreaElement; value: string };

function editableTarget(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement) return target;
  return null;
}

function restore(snapshot: Snapshot): void {
  const { el, value } = snapshot;
  if (el.value === value) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function useScanner(onScan: (code: string) => void, options: UseScannerOptions = {}): ScannerHandle {
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);
  const detectorRef = useRef<ScanDetector | null>(null);

  const { enabled = true, minLength, maxInterKeyMs, maxAvgInterKeyMs, endTimeoutMs } = options;

  useEffect(() => {
    if (!enabled) return;
    const detector = new ScanDetector({
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxInterKeyMs !== undefined ? { maxInterKeyMs } : {}),
      ...(maxAvgInterKeyMs !== undefined ? { maxAvgInterKeyMs } : {}),
      ...(endTimeoutMs !== undefined ? { endTimeoutMs } : {}),
    });
    detectorRef.current = detector;
    let snapshot: Snapshot | null = null;
    let timer: number | undefined;

    const deliver = (code: string) => {
      if (snapshot) restore(snapshot);
      snapshot = null;
      onScanRef.current(code);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-scanner="off"]')) {
        detector.reset();
        return;
      }
      const step = detector.feed({
        key: e.key,
        time: e.timeStamp,
        repeat: e.repeat,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        isComposing: e.isComposing,
      });
      if (step.scan) deliver(step.scan);
      if (step.runStarted) {
        const el = editableTarget(e.target);
        snapshot = el ? { el, value: el.value } : null;
      }
      if (step.swallow) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }

      window.clearTimeout(timer);
      if (detector.pending) {
        timer = window.setTimeout(() => {
          const scan = detector.end();
          if (scan) deliver(scan);
          else snapshot = null;
        }, detector.endTimeoutMs);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.clearTimeout(timer);
      detectorRef.current = null;
    };
  }, [enabled, minLength, maxInterKeyMs, maxAvgInterKeyMs, endTimeoutMs]);

  return useMemo(() => ({ isReceiving: () => detectorRef.current?.pending ?? false }), []);
}

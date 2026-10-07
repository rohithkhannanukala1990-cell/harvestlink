import { describe, expect, it } from "vitest";
import { ScanDetector, type ScanKey, type ScanStep } from "./scanDetector";

/** Feeds `text` one key every `gapMs` starting at `start`; returns every step. */
function type(d: ScanDetector, text: string, gapMs: number, start = 0, extra: Partial<ScanKey> = {}): ScanStep[] {
  return [...text].map((key, i) => d.feed({ key, time: start + i * gapMs, ...extra }));
}

function scansOf(steps: ScanStep[]): string[] {
  return steps.flatMap((s) => (s.scan ? [s.scan] : []));
}

describe("ScanDetector", () => {
  it("recognizes a USB scanner burst ending in Enter, and swallows only what follows recognition", () => {
    const d = new ScanDetector();
    const steps = type(d, "036000291452", 8);
    // The first three keys arrive before the run can be recognized and reach the focused input.
    expect(steps.map((s) => s.swallow)).toEqual([false, false, false, ...Array(9).fill(true)]);
    expect(steps[0]!.runStarted).toBe(true);
    const enter = d.feed({ key: "Enter", time: 12 * 8 });
    expect(enter).toEqual({ swallow: true, scan: "036000291452", runStarted: false });
  });

  it("never treats human typing as a scan, nor swallows its keys or Enter", () => {
    const d = new ScanDetector();
    const steps = type(d, "12345678", 140);
    expect(steps.every((s) => !s.swallow && s.scan === null)).toBe(true);
    expect(d.feed({ key: "Enter", time: 8 * 140 })).toMatchObject({ swallow: false, scan: null });
  });

  it("does not mistake a fast typist's quick bigram or a two-key roll for a scan", () => {
    const d = new ScanDetector();
    // "12" rolled together, then normal pace.
    const keys: ScanKey[] = [
      { key: "1", time: 0 },
      { key: "2", time: 9 },
      { key: "3", time: 70 },
      { key: "4", time: 120 },
      { key: "Enter", time: 190 },
    ];
    expect(keys.map((k) => d.feed(k)).every((s) => !s.swallow && s.scan === null)).toBe(true);
  });

  it("rejects a run whose average is too slow even if every gap is under the limit", () => {
    const d = new ScanDetector();
    type(d, "123456", 55);
    expect(d.feed({ key: "Enter", time: 6 * 55 })).toMatchObject({ scan: null, swallow: false });
  });

  it("tolerates one Bluetooth jitter spike inside an otherwise steady burst", () => {
    const d = new ScanDetector();
    const times = [0, 20, 40, 95, 115, 135, 155, 175];
    for (const [i, t] of times.entries()) d.feed({ key: String(i), time: t });
    expect(d.feed({ key: "Enter", time: 195 }).scan).toBe("01234567");
  });

  it("treats a held-down key's auto-repeat as typing, not a scan of 1111", () => {
    const d = new ScanDetector();
    const steps = type(d, "11111111", 30, 0, { repeat: true });
    expect(steps.every((s) => !s.swallow)).toBe(true);
    expect(d.feed({ key: "Enter", time: 300 }).scan).toBeNull();
  });

  it("ignores Shift between capitals without breaking the run", () => {
    const d = new ScanDetector();
    let t = 0;
    for (const ch of "LOT-AB12") {
      if (/[A-Z]/.test(ch)) d.feed({ key: "Shift", time: (t += 3) });
      d.feed({ key: ch, time: (t += 6) });
    }
    expect(d.feed({ key: "Enter", time: t + 6 }).scan).toBe("LOT-AB12");
  });

  it("delivers suffix-less scans after silence, via flush or the next key", () => {
    const d = new ScanDetector();
    type(d, "SHELF77", 10);
    expect(d.flush(60 + 50)).toBeNull(); // not silent long enough yet
    expect(d.flush(60 + 100)).toBe("SHELF77");

    const d2 = new ScanDetector();
    type(d2, "SHELF77", 10);
    // The timer has not fired, but a person's next key shows the scan ended.
    const next = d2.feed({ key: "5", time: 500 });
    expect(next).toMatchObject({ scan: "SHELF77", swallow: false, runStarted: true });
  });

  it("accepts an Enter suffix that lags slightly behind the burst", () => {
    const d = new ScanDetector();
    type(d, "96385074", 10);
    expect(d.feed({ key: "Enter", time: 70 + 80 }).scan).toBe("96385074");
  });

  it("drops runs below minLength and resets on chords and editing keys", () => {
    const d = new ScanDetector();
    type(d, "123", 5);
    expect(d.feed({ key: "Enter", time: 20 }).scan).toBeNull();

    type(d, "1234", 5, 100);
    d.feed({ key: "c", time: 121, ctrlKey: true });
    expect(d.pending).toBe(false);

    type(d, "1234", 5, 200);
    d.feed({ key: "Backspace", time: 221 });
    expect(d.pending).toBe(false);
  });

  it("separates two scans in quick succession", () => {
    const d = new ScanDetector();
    const first = type(d, "1111AAAA", 5);
    expect(d.feed({ key: "Enter", time: 40 }).scan).toBe("1111AAAA");
    const second = type(d, "2222BBBB", 5, 300);
    expect(d.feed({ key: "Enter", time: 340 }).scan).toBe("2222BBBB");
    expect(scansOf([...first, ...second])).toEqual([]);
  });
});

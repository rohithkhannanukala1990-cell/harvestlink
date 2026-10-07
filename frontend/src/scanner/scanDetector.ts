/**
 * Tells a keyboard-wedge barcode scanner apart from a person typing, by keystroke timing alone.
 *
 * Most retail scanners and RF guns present themselves as a USB/Bluetooth keyboard and "type" the
 * code. There is no flag on the key events saying a scanner sent them, so this is a heuristic, and
 * it is the part of the scanning layer most likely to misbehave. Pure logic with an injected clock
 * so it can be tested key by key; useScanner wires it to the DOM.
 *
 * THE SIGNAL
 * A scanner emits a whole code in a burst: typically 2–15 ms between characters over USB, 15–40 ms
 * over Bluetooth / RF with occasional jitter spikes. People type at 80–250 ms between keys; even a
 * fast typist's quickest bigrams sit around 50–80 ms, and nobody sustains < 35 ms over four or more
 * characters. So a run is a scan when ALL of:
 *   1. it is at least `minLength` characters (default 4) — short bursts happen when a person
 *      rolls two keys together, and are never treated as a scan;
 *   2. no single gap exceeds `maxInterKeyMs` (default 60) — tolerates one Bluetooth hiccup without
 *      letting a person's typing qualify; a longer gap starts a new run;
 *   3. the average gap is at most `maxAvgInterKeyMs` (default 35) — the steady burst is the real
 *      fingerprint; one fast bigram cannot pass this.
 * The run ends on Enter or Tab (most scanners are configured to send one as a suffix) or, for
 * scanners with no suffix, after `endTimeoutMs` of silence (the caller calls flush()).
 *
 * WHAT MAKES IT MISBEHAVE, AND WHAT IS DONE ABOUT IT
 * - Held-down keys auto-repeat at ~30 ms, which looks exactly like a scan of "1111". Events with
 *   `repeat` set reset the run.
 * - Shift arrives as its own keydown before each capital letter a scanner sends. Modifier-only
 *   keys are ignored without touching the timing, so "ABC" is not split into runs by Shift.
 * - Ctrl/Alt/Meta chords are shortcuts, not data: they reset the run. IME composition likewise.
 * - The first characters of a scan cannot be recognized until enough have arrived, so they reach
 *   whatever input has focus. Once a run qualifies, the rest of it is swallowed (`swallow: true`)
 *   and the caller restores the focused input to its value from before the run began. Characters
 *   are never swallowed before the run qualifies — a person's keystroke is never eaten.
 * - The Enter suffix is swallowed only when it ends a qualifying run, so a person pressing Enter
 *   to save a quantity is never intercepted, and a scan's Enter never submits that form.
 * - Too slow a scanner (some RF guns in batch mode, remote desktop sessions) will not qualify and
 *   is read as typing. Raise the thresholds per page if needed; every scan screen also has a typed
 *   entry field as a fallback.
 * - Codes shorter than `minLength` are not detected. Lower it only on pages that need it.
 * - Android soft keyboards report key "Unidentified" for most keys; devices with built-in
 *   scanners should be configured for keystroke output (e.g. Zebra DataWedge "keystroke"), which
 *   sends real key events.
 */

export type ScanDetectorOptions = {
  minLength: number;
  maxInterKeyMs: number;
  maxAvgInterKeyMs: number;
  /** Silence after which a suffix-less run is evaluated. Must exceed maxInterKeyMs. */
  endTimeoutMs: number;
};

export const DEFAULT_SCAN_OPTIONS: ScanDetectorOptions = {
  minLength: 4,
  maxInterKeyMs: 60,
  maxAvgInterKeyMs: 35,
  endTimeoutMs: 100,
};

export type ScanKey = {
  key: string;
  /** Milliseconds, any monotonic clock (event.timeStamp). */
  time: number;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
};

export type ScanStep = {
  /** preventDefault + stop propagation for this key: it belongs to a scan already recognized. */
  swallow: boolean;
  /** A completed scan, if this key finished one (or showed the previous run had ended). */
  scan: string | null;
  /** True when this key started a new run — the caller snapshots the focused input now. */
  runStarted: boolean;
};

const MODIFIER_KEYS = new Set(["Shift", "CapsLock", "Control", "Alt", "AltGraph", "Meta", "OS", "Fn"]);
const TERMINATORS = new Set(["Enter", "Tab"]);

const NOTHING: ScanStep = { swallow: false, scan: null, runStarted: false };

export class ScanDetector {
  private readonly opts: ScanDetectorOptions;
  private chars: string[] = [];
  private firstTime = 0;
  private lastTime = 0;
  private maxGap = 0;

  constructor(options: Partial<ScanDetectorOptions> = {}) {
    this.opts = { ...DEFAULT_SCAN_OPTIONS, ...options };
    if (this.opts.endTimeoutMs <= this.opts.maxInterKeyMs) {
      throw new Error("endTimeoutMs must be longer than maxInterKeyMs");
    }
  }

  /** True once the current run looks like a scanner, so its remaining keys should be swallowed. */
  get recognized(): boolean {
    const n = this.chars.length;
    if (n < this.opts.minLength) return false;
    const avg = (this.lastTime - this.firstTime) / (n - 1);
    return this.maxGap <= this.opts.maxInterKeyMs && avg <= this.opts.maxAvgInterKeyMs;
  }

  get pending(): boolean {
    return this.chars.length > 0;
  }

  reset(): void {
    this.chars = [];
    this.maxGap = 0;
  }

  /** Ends the current run and returns it if it was a scan. */
  private finish(): string | null {
    const scan = this.recognized ? this.chars.join("") : null;
    this.reset();
    return scan;
  }

  feed(k: ScanKey): ScanStep {
    if (MODIFIER_KEYS.has(k.key)) return NOTHING;
    if (k.repeat || k.ctrlKey || k.altKey || k.metaKey || k.isComposing) {
      this.reset();
      return NOTHING;
    }

    if (TERMINATORS.has(k.key)) {
      // A suffix that arrives before the silence timeout belongs to the run (a jitter spike right
      // before it is common); a later one is a person pressing Enter.
      if (!this.pending || k.time - this.lastTime >= this.opts.endTimeoutMs) {
        this.reset();
        return NOTHING;
      }
      const scan = this.finish();
      return { swallow: scan !== null, scan, runStarted: false };
    }

    if (k.key.length !== 1) {
      // Backspace, arrows, F-keys: a person editing.
      this.reset();
      return NOTHING;
    }

    let previous: string | null = null;
    if (this.pending && k.time - this.lastTime > this.opts.maxInterKeyMs) {
      // Too long a pause: whatever came before has ended (a suffix-less scan whose flush timer has
      // not fired yet is still delivered here).
      previous = this.finish();
    }

    const runStarted = !this.pending;
    if (runStarted) {
      this.firstTime = k.time;
    } else {
      this.maxGap = Math.max(this.maxGap, k.time - this.lastTime);
    }
    this.chars.push(k.key);
    this.lastTime = k.time;

    return { swallow: this.recognized, scan: previous, runStarted };
  }

  /** Call after endTimeoutMs of silence; returns the run if it was a scan. */
  flush(now: number): string | null {
    if (!this.pending || now - this.lastTime < this.opts.endTimeoutMs) return null;
    return this.finish();
  }

  /**
   * Ends the run now. For a timer that is restarted on every key: when it fires, the silence has
   * happened, even if the timer ran a millisecond early.
   */
  end(): string | null {
    return this.pending ? this.finish() : null;
  }

  get endTimeoutMs(): number {
    return this.opts.endTimeoutMs;
  }
}

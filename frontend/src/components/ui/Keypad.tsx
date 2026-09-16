import type { ButtonHTMLAttributes } from "react";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"] as const;

export type KeypadProps = {
  onKey: (key: string) => void;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "type" | "children">;

/**
 * Large numeric pad for standing receiving / POS quantity entry.
 * Keys are lg touch targets on surface-canopy.
 */
export function Keypad({ onKey, className = "", ...rest }: KeypadProps) {
  return (
    <div className={`grid grid-cols-3 gap-2 ${className}`.trim()}>
      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          className="flex h-16 items-center justify-center rounded-lg bg-surface-canopy text-2xl font-semibold text-ink-inverse active:opacity-80"
          onClick={() => onKey(key)}
          {...rest}
        >
          {key}
        </button>
      ))}
    </div>
  );
}

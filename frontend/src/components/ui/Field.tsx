import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

const controlClass =
  "w-full min-h-[44px] rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink placeholder:text-ink-muted disabled:bg-surface-sunken disabled:opacity-50";

const controlClassLg =
  "w-full min-h-12 rounded-lg border-2 border-border-strong bg-surface-raised px-4 py-3 text-lg text-ink placeholder:text-ink-muted disabled:bg-surface-sunken disabled:opacity-50";

export type FieldProps = {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  /** lg = standing POS / receiving touch targets. */
  size?: "md" | "lg";
} & Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "size">;

/**
 * Labeled text input with optional hint / error. Uses border-strong outlines;
 * focus ring comes from the global interactive :focus-visible rule.
 */
export function Field({
  label,
  hint,
  error,
  className = "",
  id,
  size = "md",
  ...inputProps
}: FieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`.trim()}>
      <label htmlFor={fieldId} className="text-sm font-semibold text-ink">
        {label}
      </label>
      <input
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={size === "lg" ? controlClassLg : controlClass}
        {...inputProps}
      />
      {error ? (
        <p id={errorId} className="text-sm text-state-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type SelectFieldProps = {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  size?: "md" | "lg";
  children: ReactNode;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "children" | "size">;

/** Same Field chrome for native selects. */
export function SelectField({
  label,
  hint,
  error,
  className = "",
  id,
  size = "md",
  children,
  ...selectProps
}: SelectFieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`.trim()}>
      <label htmlFor={fieldId} className="text-sm font-semibold text-ink">
        {label}
      </label>
      <select
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={size === "lg" ? controlClassLg : controlClass}
        {...selectProps}
      >
        {children}
      </select>
      {error ? (
        <p id={errorId} className="text-sm text-state-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

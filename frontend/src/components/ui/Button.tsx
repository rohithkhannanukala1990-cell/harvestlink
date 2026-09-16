import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "accent" | "quiet" | "destructive";
type ButtonSize = "md" | "lg";

export type ButtonProps = {
  /** Verb labels only — "Save", "Quarantine", "Join", not nouns. */
  children: ReactNode;
  variant?: ButtonVariant;
  /** md = 40px desk work; lg = 48px standing POS / receiving. */
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  loading?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

const variantClass: Record<ButtonVariant, string> = {
  // Default commit action — brand-green fill, ink-inverse label.
  primary:
    "bg-brand-green text-ink-inverse hover:opacity-90 disabled:opacity-50",
  // Member-facing moments (join, invest) only — never a second primary on staff screens.
  accent:
    "bg-brand-terracotta text-ink-inverse hover:opacity-90 disabled:opacity-50",
  quiet:
    "bg-surface-raised text-ink border border-border-strong hover:bg-surface-sunken disabled:opacity-50",
  // Recalls, quarantines, refunds — never the default focus of a dialog.
  destructive:
    "bg-surface-raised text-state-danger border border-state-danger hover:bg-state-danger/10 disabled:opacity-50",
};

const sizeClass: Record<ButtonSize, string> = {
  /** 44px floor — desk and coordinator screens. */
  md: "min-h-[44px] h-11 px-4 text-sm",
  /** 48px — standing POS / receiving. */
  lg: "min-h-12 h-12 px-5 text-base",
};

/**
 * Action control for forms and toolbars. Labels must be verbs.
 * Use primary for the main commit; accent only for member join/invest;
 * quiet for secondary; destructive for recalls/quarantines/refunds.
 */
export function Button({
  children,
  variant = "primary",
  size = "md",
  leadingIcon,
  loading = false,
  disabled,
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-opacity ${variantClass[variant]} ${sizeClass[size]} ${className}`.trim()}
      {...rest}
    >
      {loading ? (
        <span
          className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent"
          aria-hidden
        />
      ) : (
        leadingIcon
      )}
      {children}
    </button>
  );
}

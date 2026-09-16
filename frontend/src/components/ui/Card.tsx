import type { ReactNode } from "react";

export type CardProps = {
  children: ReactNode;
  /** Optional section title shown in the header row. */
  title?: ReactNode;
  /** Right-side slot for buttons or filters beside the title. */
  actions?: ReactNode;
  className?: string;
};

/**
 * Raised panel for grouping related content. Structure comes from the hairline
 * border and radius — not from heavy lift. Prefer over ad-hoc bordered boxes.
 */
export function Card({ children, title, actions, className = "" }: CardProps) {
  const hasHeader = title != null || actions != null;

  return (
    <section
      className={`rounded-lg border border-border-hairline bg-surface-raised shadow-card ${className}`.trim()}
    >
      {hasHeader && (
        <div className="flex items-start justify-between gap-3 border-b border-border-hairline px-4 py-3">
          {title != null ? (
            <h2 className="text-base font-semibold text-ink">{title}</h2>
          ) : (
            <span />
          )}
          {actions != null && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

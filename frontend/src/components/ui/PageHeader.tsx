import type { ReactNode } from "react";

export type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  /** Right-side slot for primary page actions. */
  actions?: ReactNode;
  className?: string;
};

/**
 * Top-of-page title block. Use once per route for the page name, optional
 * supporting sentence, and the primary action group.
 */
export function PageHeader({
  title,
  description,
  actions,
  className = "",
}: PageHeaderProps) {
  return (
    <header
      className={`flex flex-wrap items-start justify-between gap-4 ${className}`.trim()}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {description != null && (
          <p className="max-w-2xl text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {actions != null && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

import { Fragment, type ReactNode } from "react";

export type DataTableAlign = "left" | "right" | "center";

export type DataTableColumn<T> = {
  id: string;
  header: string;
  /** Columns declare their own alignment; numeric defaults to right. */
  align?: DataTableAlign;
  /** Right-aligns and applies .tabular for quantities / money. */
  numeric?: boolean;
  cell: (row: T) => ReactNode;
};

export type DataTableExpandable<T> = {
  isExpanded: (row: T) => boolean;
  onToggle: (row: T) => void;
  render: (row: T) => ReactNode;
};

export type DataTableProps<T> = {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** md = space-3 desk density; lg = space-4 touch / standing screens. */
  density?: "md" | "lg";
  emptyMessage?: string;
  className?: string;
  /** Optional expand row (e.g. product → lots). */
  expandable?: DataTableExpandable<T>;
};

const alignClass: Record<DataTableAlign, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

const densityPad: Record<"md" | "lg", string> = {
  md: "px-3 py-3",
  lg: "px-4 py-4",
};

/**
 * Operational table: sunken uppercase headers, hairline row separators, no zebra.
 * Numeric columns must set numeric (or align="right") and use .tabular figures.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  density = "md",
  emptyMessage = "No rows",
  className = "",
  expandable,
}: DataTableProps<T>) {
  const pad = densityPad[density];
  const colCount = columns.length + (expandable ? 1 : 0);

  return (
    <div
      className={`overflow-x-auto rounded-lg border border-border-hairline bg-surface-raised ${className}`.trim()}
    >
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-surface-sunken">
            {expandable && (
              <th scope="col" className={`${pad} w-10 text-xs font-semibold uppercase tracking-wide text-ink-muted`}>
                <span className="sr-only">Expand</span>
              </th>
            )}
            {columns.map((col) => {
              const align = col.align ?? (col.numeric ? "right" : "left");
              return (
                <th
                  key={col.id}
                  scope="col"
                  className={`${pad} text-xs font-semibold uppercase tracking-wide text-ink-muted ${alignClass[align]}`}
                >
                  {col.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={colCount} className={`${pad} text-ink-muted`}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const open = expandable?.isExpanded(row) ?? false;
              const key = rowKey(row);
              return (
                <Fragment key={key}>
                  <tr className="border-t border-border-hairline">
                    {expandable && (
                      <td className={pad}>
                        <button
                          type="button"
                          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center font-mono text-ink-muted"
                          aria-expanded={open}
                          onClick={() => expandable.onToggle(row)}
                        >
                          {open ? "▾" : "▸"}
                        </button>
                      </td>
                    )}
                    {columns.map((col) => {
                      const align = col.align ?? (col.numeric ? "right" : "left");
                      return (
                        <td
                          key={col.id}
                          className={`${pad} text-ink ${alignClass[align]} ${col.numeric ? "tabular" : ""}`.trim()}
                        >
                          {col.cell(row)}
                        </td>
                      );
                    })}
                  </tr>
                  {expandable && open ? (
                    <tr className="border-t border-border-hairline bg-surface-sunken">
                      <td colSpan={colCount} className="p-0">
                        {expandable.render(row)}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

import type { ReactNode } from "react";

export type RowGroupHeaderProps<TData> = {
  groupKey: string;
  rows: TData[];
  expanded: boolean;
  onToggle: () => void;
  selection?: {
    checked: boolean;
    indeterminate: boolean;
    onChange: (checked: boolean) => void;
  };
};

export type TableRowGrouping<TData> = {
  getKey: (row: TData) => string | null | undefined;
  renderHeader: (props: RowGroupHeaderProps<TData>) => ReactNode;
};

/** Group only loaded rows, at each group's first position in the sorted page. */
export function groupTableRows<T>(
  rows: T[],
  getKey?: (row: T) => string | null | undefined,
): { groupKey: string | null; rows: T[] }[] {
  const sections: { groupKey: string | null; rows: T[] }[] = [];
  const groups = new Map<string, T[]>();

  for (const row of rows) {
    const key = getKey?.(row) || null;
    if (key) {
      const existing = groups.get(key);
      if (existing) existing.push(row);
      else {
        const members = [row];
        groups.set(key, members);
        sections.push({ groupKey: key, rows: members });
      }
    } else {
      const previous = sections[sections.length - 1];
      if (previous?.groupKey === null) previous.rows.push(row);
      else sections.push({ groupKey: null, rows: [row] });
    }
  }

  return sections;
}

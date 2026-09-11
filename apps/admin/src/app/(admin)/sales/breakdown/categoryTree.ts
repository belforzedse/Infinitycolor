/**
 * Turns the sales-breakdown API's flat row array into a foldable category tree.
 *
 * The rows arrive sorted by net descending, NOT in tree order — that ordering is
 * what the ranked chart above the table reads. Hierarchy travels separately, on
 * each row's `parentKey`, and is reassembled here.
 *
 * Two properties the callers depend on:
 *  - A row whose `parentKey` names a category that isn't in the result set (its
 *    parent was truncated away, or never had sales) is promoted to a root. No row
 *    can be dropped by being unreachable.
 *  - Sibling order follows the source array, so children stay net-descending
 *    within their parent without a second sort.
 *
 * Parent rows already CONTAIN their descendants' totals (the rollup happens in
 * SQL, where the distinct order count can be computed correctly at every depth),
 * so nothing here sums anything.
 */
import type { SalesBreakdownRow } from "@/services/super-admin/reports/salesBreakdown";

export interface CategoryTreeNode {
  row: SalesBreakdownRow;
  children: CategoryTreeNode[];
}

/** A row plus the presentation facts the table cell needs to render its disclosure. */
export interface FlatCategoryRow extends SalesBreakdownRow {
  treeDepth: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

export function buildCategoryTree(rows: SalesBreakdownRow[]): CategoryTreeNode[] {
  const nodes = new Map<string, CategoryTreeNode>();
  for (const row of rows) nodes.set(row.key, { row, children: [] });

  const roots: CategoryTreeNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.key)!;
    const parent = row.parentKey ? nodes.get(row.parentKey) : undefined;
    // Self-parenting would silently drop the row from every list; treat it as a root.
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** True when any row declares a parent that resolves — i.e. there is a tree to fold. */
export function hasHierarchy(rows: SalesBreakdownRow[]): boolean {
  const keys = new Set(rows.map((r) => r.key));
  return rows.some((r) => r.parentKey && r.parentKey !== r.key && keys.has(r.parentKey));
}

/**
 * Depth-first walk emitting only the rows currently visible: every root, plus the
 * children of each expanded node.
 */
export function flattenVisible(
  tree: CategoryTreeNode[],
  expanded: ReadonlySet<string>,
): FlatCategoryRow[] {
  const out: FlatCategoryRow[] = [];
  const walk = (nodes: CategoryTreeNode[], depth: number) => {
    for (const node of nodes) {
      const isExpanded = expanded.has(node.row.key);
      out.push({
        ...node.row,
        treeDepth: depth,
        hasChildren: node.children.length > 0,
        isExpanded,
      });
      if (isExpanded && node.children.length) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

/** Every key that owns children — the set "expand all" switches on. */
export function expandableKeys(tree: CategoryTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: CategoryTreeNode[]) => {
    for (const node of nodes) {
      if (node.children.length) {
        out.push(node.row.key);
        walk(node.children);
      }
    }
  };
  walk(tree);
  return out;
}

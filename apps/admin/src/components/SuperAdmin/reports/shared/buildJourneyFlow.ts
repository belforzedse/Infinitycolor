/**
 * Turns Umami's top-N user journeys (`{e1,e2,e3,e4,count}`, each row a whole
 * recorded 1-4 step path) into a node-link graph for a Sankey flow diagram.
 *
 * Node identity is `${depth}|${label}`, never the raw event value: the same
 * label (e.g. "بازپرداخت" for both `refund` and `refund_irr`) can legitimately
 * collapse multiple raw values into one node, and the same label can also
 * legitimately appear at two different depths as two *different* nodes (a
 * product view that happens at step 1 in one journey and step 3 in another
 * is not the same visual node). Keying by depth also means every link only
 * ever goes from depth `d` to depth `d + 1`, so recharts' Sankey DAG-depth
 * invariant holds by construction — no separate cycle handling is needed.
 */

export type JourneyRow = {
  e1?: unknown;
  e2?: unknown;
  e3?: unknown;
  e4?: unknown;
  count?: unknown;
};

export type JourneyNode = {
  id: string;
  depth: number;
  label: string;
  rawValues: string[];
  isTerminal: boolean;
  isOverflow: boolean;
};

export type JourneyLink = {
  source: number;
  target: number;
  value: number;
};

export type JourneyFlowResult = {
  nodes: JourneyNode[];
  links: JourneyLink[];
  totalPaths: number;
  /** True when at least one row used all 4 recorded steps — the diagram then
   * can't show what happened after step 4 (right-censored by the backend's
   * `steps: 4` cap on the Umami journey report), which the caller should
   * disclose rather than implying full session coverage. */
  truncatedAtCap: boolean;
};

const TERMINAL_LABEL = "پایان مسیر";
const OVERFLOW_LABEL = "سایر";
const MAX_STEPS = 4;
const DEFAULT_TOP_N_PER_NODE = 6;

type BuildingNode = {
  depth: number;
  label: string;
  rawValues: Set<string>;
  isTerminal: boolean;
  isOverflow: boolean;
};

function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function stepValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  return raw ? raw : null;
}

export function buildJourneyFlow(
  rows: JourneyRow[],
  options: { label: (raw: unknown) => string; topNPerNode?: number },
): JourneyFlowResult {
  const topNPerNode = options.topNPerNode ?? DEFAULT_TOP_N_PER_NODE;
  const nodesByKey = new Map<string, BuildingNode>();
  const linkWeights = new Map<string, number>();
  let totalPaths = 0;
  let truncatedAtCap = false;

  function ensureNode(
    depth: number,
    rawValue: string,
    isTerminal = false,
    isOverflow = false,
  ): string {
    const label = isTerminal ? TERMINAL_LABEL : isOverflow ? OVERFLOW_LABEL : options.label(rawValue);
    const key = `${depth}|${label}`;
    let node = nodesByKey.get(key);
    if (!node) {
      node = { depth, label, rawValues: new Set(), isTerminal, isOverflow };
      nodesByKey.set(key, node);
    }
    if (!isTerminal && !isOverflow) node.rawValues.add(rawValue);
    return key;
  }

  function addLink(sourceKey: string, targetKey: string, value: number) {
    if (value <= 0) return;
    const linkKey = `${sourceKey}>>${targetKey}`;
    linkWeights.set(linkKey, (linkWeights.get(linkKey) ?? 0) + value);
  }

  for (const row of rows) {
    const steps = [row.e1, row.e2, row.e3, row.e4].map(stepValue);
    const firstEmpty = steps.findIndex((step) => step === null);
    const stepCount = firstEmpty === -1 ? MAX_STEPS : firstEmpty;
    if (stepCount === 0) continue;

    const count = toCount(row.count);
    totalPaths += count;
    if (count <= 0) continue;

    const nodeKeys: string[] = [];
    for (let depth = 0; depth < stepCount; depth += 1) {
      nodeKeys.push(ensureNode(depth, steps[depth] as string));
    }
    for (let depth = 0; depth < stepCount - 1; depth += 1) {
      addLink(nodeKeys[depth], nodeKeys[depth + 1], count);
    }

    if (stepCount < MAX_STEPS) {
      const terminalKey = ensureNode(stepCount, "", true);
      addLink(nodeKeys[stepCount - 1], terminalKey, count);
    } else {
      truncatedAtCap = true;
    }
  }

  // Top-N + "سایر" bucketing, per source node. Terminal links are always
  // excluded from bucketing so an abandonment edge never silently disappears
  // into an unrelated "سایر" bucket — keeping exits visible is a hard
  // requirement, not a nice-to-have.
  const outgoingBySource = new Map<string, { targetKey: string; value: number }[]>();
  for (const [linkKey, value] of linkWeights) {
    const [sourceKey, targetKey] = linkKey.split(">>");
    const list = outgoingBySource.get(sourceKey) ?? [];
    list.push({ targetKey, value });
    outgoingBySource.set(sourceKey, list);
  }

  const bucketedLinks = new Map<string, number>();
  for (const [sourceKey, targets] of outgoingBySource) {
    const terminalTargets = targets.filter((t) => nodesByKey.get(t.targetKey)?.isTerminal);
    const regularTargets = targets.filter((t) => !nodesByKey.get(t.targetKey)?.isTerminal);
    for (const t of terminalTargets) {
      bucketedLinks.set(`${sourceKey}>>${t.targetKey}`, (bucketedLinks.get(`${sourceKey}>>${t.targetKey}`) ?? 0) + t.value);
    }

    const sorted = [...regularTargets].sort((a, b) => b.value - a.value);
    const overflowCount = sorted.length - topNPerNode;
    if (overflowCount <= 1) {
      for (const t of sorted) {
        bucketedLinks.set(`${sourceKey}>>${t.targetKey}`, (bucketedLinks.get(`${sourceKey}>>${t.targetKey}`) ?? 0) + t.value);
      }
      continue;
    }

    const kept = sorted.slice(0, topNPerNode);
    const overflow = sorted.slice(topNPerNode);
    for (const t of kept) {
      bucketedLinks.set(`${sourceKey}>>${t.targetKey}`, (bucketedLinks.get(`${sourceKey}>>${t.targetKey}`) ?? 0) + t.value);
    }
    const sourceDepth = nodesByKey.get(sourceKey)?.depth ?? 0;
    const overflowKey = ensureNode(sourceDepth + 1, "", false, true);
    const overflowValue = overflow.reduce((sum, t) => sum + t.value, 0);
    bucketedLinks.set(
      `${sourceKey}>>${overflowKey}`,
      (bucketedLinks.get(`${sourceKey}>>${overflowKey}`) ?? 0) + overflowValue,
    );
  }

  // Bucketing can orphan a node whose entire incoming volume got folded into
  // a "سایر" bucket elsewhere while it still has outgoing links of its own
  // (from a different, unrelated source relationship). Prune iteratively so
  // no node with outgoing-but-no-incoming links (other than genuine depth-0
  // roots) reaches recharts, which assumes every non-root node is reachable.
  let changed = true;
  while (changed) {
    changed = false;
    const incomingByTarget = new Set<string>();
    for (const linkKey of bucketedLinks.keys()) {
      incomingByTarget.add(linkKey.split(">>")[1]);
    }
    for (const [key, node] of nodesByKey) {
      if (node.depth === 0) continue;
      if (incomingByTarget.has(key)) continue;
      nodesByKey.delete(key);
      for (const linkKey of [...bucketedLinks.keys()]) {
        if (linkKey.startsWith(`${key}>>`)) {
          bucketedLinks.delete(linkKey);
          changed = true;
        }
      }
    }
  }

  function nodeFlowValue(key: string): number {
    let incoming = 0;
    let outgoing = 0;
    for (const [linkKey, value] of bucketedLinks) {
      const [sourceKey, targetKey] = linkKey.split(">>");
      if (sourceKey === key) outgoing += value;
      if (targetKey === key) incoming += value;
    }
    return Math.max(incoming, outgoing);
  }

  const orderedKeys = [...nodesByKey.keys()].sort((a, b) => {
    const nodeA = nodesByKey.get(a)!;
    const nodeB = nodesByKey.get(b)!;
    if (nodeA.depth !== nodeB.depth) return nodeA.depth - nodeB.depth;
    const valueDiff = nodeFlowValue(b) - nodeFlowValue(a);
    if (valueDiff !== 0) return valueDiff;
    return nodeA.label.localeCompare(nodeB.label, "fa");
  });

  const indexByKey = new Map(orderedKeys.map((key, index) => [key, index]));
  const nodes: JourneyNode[] = orderedKeys.map((key) => {
    const node = nodesByKey.get(key)!;
    return {
      id: key,
      depth: node.depth,
      label: node.label,
      rawValues: [...node.rawValues],
      isTerminal: node.isTerminal,
      isOverflow: node.isOverflow,
    };
  });

  const links: JourneyLink[] = [...bucketedLinks.entries()].map(([linkKey, value]) => {
    const [sourceKey, targetKey] = linkKey.split(">>");
    return { source: indexByKey.get(sourceKey)!, target: indexByKey.get(targetKey)!, value };
  });

  return { nodes, links, totalPaths, truncatedAtCap };
}

/**
 * Remembered node positions, so the graph comes back the way you left it.
 *
 * The force simulation settles into a different arrangement every run, so a
 * reload used to rearrange a graph the reader had already learned the shape of,
 * and made them wait through the settling to do it. Seeding the simulation with
 * the last settled positions removes both.
 *
 * WHAT IS AND IS NOT CACHED. Positions only — ids and two numbers. The graph
 * itself is always refetched: caching nodes and edges in the browser would mean
 * a stale answer after a write, and worse, one tenant's graph surviving in
 * storage into another tenant's session. Coordinates are meaningless without
 * the nodes they belong to, so the cache can only ever make the fetch look
 * instant, never substitute for it.
 *
 * Even so it is keyed by owner (and by whoever is being viewed, which is a
 * different graph again) and dropped when that changes, because a layout is
 * still a shape of someone's data.
 */

const KEY = "trove:graph-layout:v1";
/** A month of not opening the graph and the layout is not worth restoring. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Well inside a 5 MB localStorage budget: ~1,500 nodes cost about 60 KB. */
const MAX_NODES = 20_000;

export type LayoutPositions = Map<string, { x: number; y: number }>;

type StoredLayout = {
  owner: string;
  savedAt: number;
  /** [id, x, y] triples — a third of the bytes of an array of objects. */
  nodes: Array<[string, number, number]>;
};

/**
 * Who this layout belongs to. Impersonation is part of it: viewing as someone
 * else is a different graph, and must not inherit your arrangement or leave
 * yours behind when you switch back.
 */
export function layoutOwnerKey(
  identity: { userId?: string; clerkUserId?: string } | null,
  impersonating: { clerkUserId?: string } | null,
): string | null {
  const self = identity?.userId ?? identity?.clerkUserId;
  if (!self) return null;
  return impersonating?.clerkUserId ? `${self}~as~${impersonating.clerkUserId}` : self;
}

function read(): StoredLayout | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredLayout;
    if (!Array.isArray(parsed.nodes) || typeof parsed.owner !== "string") return null;
    return parsed;
  } catch {
    // Private mode, cleared storage, a half-written value: no layout, no error.
    return null;
  }
}

/** The saved positions for this owner, or null if there is nothing usable. */
export function loadLayout(owner: string | null): LayoutPositions | null {
  if (!owner) return null;
  const stored = read();
  if (!stored || stored.owner !== owner) return null;
  if (Date.now() - stored.savedAt > MAX_AGE_MS) return null;
  const positions: LayoutPositions = new Map();
  for (const [id, x, y] of stored.nodes) {
    if (typeof id === "string" && Number.isFinite(x) && Number.isFinite(y)) {
      positions.set(id, { x, y });
    }
  }
  return positions.size > 0 ? positions : null;
}

/**
 * Save where the simulation settled. Rounded to whole pixels: the graph is
 * drawn on a canvas at these coordinates and nobody can see a fraction of one,
 * so the precision is pure bytes.
 */
export function saveLayout(
  owner: string | null,
  nodes: Array<{ id: string; x?: number; y?: number }>,
): void {
  if (!owner || nodes.length === 0 || nodes.length > MAX_NODES) return;
  const placed: StoredLayout["nodes"] = [];
  for (const node of nodes) {
    if (Number.isFinite(node.x) && Number.isFinite(node.y)) {
      placed.push([node.id, Math.round(node.x as number), Math.round(node.y as number)]);
    }
  }
  if (placed.length === 0) return;
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ owner, savedAt: Date.now(), nodes: placed } satisfies StoredLayout),
    );
  } catch {
    // Over quota or storage disabled. A missing layout costs one settling pass.
  }
}

/** Forget the layout — on sign-out, or when the account being viewed changes. */
export function clearLayout(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: the read path already tolerates a missing value.
  }
}

export interface GraphReferenceIndex {
  readonly targets: ReadonlySet<object>;
  readonly references: ReadonlyMap<object, object>;
  readonly postorder: readonly object[];
  readonly canRefine: boolean;
}

type Signature = (value: unknown) => number;
type Signatures = readonly [actual: Signature, expected: Signature];

const REFINEMENT_ROUNDS = 4;

export function isArrayIndex(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffff_ffff && String(index) === key;
}

/**
 * Signatures only eliminate impossible candidates. In particular, numeric
 * tolerance and unordered array indices are deliberately coarser than the
 * final pair comparison.
 */
export function refineGraphSignatures(
  actual: GraphReferenceIndex,
  expected: GraphReferenceIndex,
  includeKey: (key: string) => boolean,
  floatTolerance: boolean
): Signatures {
  const unclassified = () => 0;
  // Existing array comparison skips holes on the actual side.
  if (!actual.canRefine || !expected.canRefine) return [unclassified, unclassified];

  const interned = new Map<string, number>();
  function intern(key: string): number {
    const existing = interned.get(key);
    if (existing !== undefined) return existing;
    const id = interned.size + 2;
    interned.set(key, id);
    return id;
  }

  function leaf(value: unknown): number {
    if (value == null) return intern('nullish');
    const type = typeof value;
    const payload =
      type === 'symbol' || type === 'function' || (type === 'number' && floatTolerance)
        ? ''
        : String(value);
    return intern(JSON.stringify([type, payload]));
  }

  function refine(graph: GraphReferenceIndex): Signature {
    let previous = new Map<object, number>();
    for (let round = 0; round < REFINEMENT_ROUNDS; round++) {
      const current = new Map<object, number>();
      const childSignature = (value: unknown): number => {
        if (value === null || typeof value !== 'object') return leaf(value);
        const node = graph.references.get(value) ?? value;
        // Inline definitions and references advance one round at the same edge.
        return graph.targets.has(node) ? previous.get(node) ?? 1 : current.get(node)!;
      };
      for (const node of graph.postorder) {
        if (graph.references.has(node)) continue;
        const record = node as Record<string, unknown>;
        const edges: Array<[string, number]> = [];
        for (const key of Object.keys(record)) {
          if (!includeKey(key)) continue;
          // Array-like records can match arrays under the existing exact rule.
          edges.push([isArrayIndex(key) ? '' : key, childSignature(record[key])]);
        }
        edges.sort(([leftKey, leftColor], [rightKey, rightColor]) =>
          leftKey === rightKey ? leftColor - rightColor : leftKey < rightKey ? -1 : 1
        );
        current.set(node, intern(JSON.stringify([graph.targets.has(node), edges])));
      }
      previous = current;
    }
    return (value) => value === null || typeof value !== 'object'
      ? leaf(value)
      : previous.get(graph.references.get(value) ?? value)!;
  }

  return [refine(actual), refine(expected)];
}

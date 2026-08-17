/** The shared shape of a state machine this site declares in code.
 *
 * An atlas machine is derived, never hand-drawn: each module builds its states
 * with the real production constructors and discovers its edges by running the
 * real transition functions (a transition that throws is not an option). The
 * `/admin/schema` page folds over these, so the map updates itself whenever
 * the code changes. */

export type AtlasActor = "owner" | "provider" | "system";

export type AtlasEdge = {
  readonly actor: AtlasActor;
  readonly labelKey: string;
  readonly to: string;
};

/** One code-truth fact shown beside a state (a function name, a route). */
export type AtlasFact = {
  readonly labelKey: string;
  readonly value: string;
};

export type AtlasState = {
  readonly detailKey: string;
  readonly edges: readonly AtlasEdge[];
  readonly facts: readonly AtlasFact[];
  readonly id: string;
  readonly labelKey: string;
  readonly layout: { readonly x: number; readonly y: number };
  /** The state a fresh record starts in. */
  readonly start?: true;
};

export type AtlasMachine = {
  readonly id: string;
  readonly introKey: string;
  readonly states: readonly AtlasState[];
  readonly titleKey: string;
};

/** One named transition of a machine: apply it to a state, get the state it
 * produces. A transition refuses an option by throwing. */
export type AtlasTrigger<State> = {
  readonly actor: AtlasActor;
  readonly labelKey: string;
  readonly run: (state: State) => State;
};

/** Run one real transition, treating its documented refusal (it throws) as
 * "this is not an option from here". */
export const attemptTransition = <State>(
  run: (state: State) => State,
  from: State,
): State | null => {
  try {
    return run(from);
  } catch {
    return null;
  }
};

/** The distinct edges of one state: a transition tried against several
 * representative states (keyed and keyless, say) can produce the same target
 * twice — collapse those to one edge per label. */
export const dedupeEdges = (edges: readonly AtlasEdge[]): AtlasEdge[] => {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.labelKey}->${edge.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The edges out of one node: try every trigger against every representative
 * state behind it; each success is one way the record can move. */
export const edgesFromTriggers = <State>(
  triggers: readonly AtlasTrigger<State>[],
  nodeIdOf: (state: State) => string,
  states: readonly State[],
): AtlasEdge[] =>
  dedupeEdges(
    triggers.flatMap((trigger) =>
      states.flatMap((from) => {
        const to = attemptTransition(trigger.run, from);
        return to === null
          ? []
          : [
              {
                actor: trigger.actor,
                labelKey: trigger.labelKey,
                to: nodeIdOf(to),
              },
            ];
      }),
    ),
  );

/** One declared node, with its label and detail keys derived from the
 * machine's own key prefix (`schema.<machine>.state.<id>`). */
export const atlasState = (
  stateKeyPrefix: string,
  id: string,
  layout: AtlasState["layout"],
  edges: readonly AtlasEdge[],
  extra: {
    facts?: readonly AtlasFact[];
    start?: true;
  } = {},
): AtlasState => ({
  detailKey: `${stateKeyPrefix}.${id}.detail`,
  edges,
  facts: extra.facts ?? [],
  id,
  labelKey: `${stateKeyPrefix}.${id}`,
  layout,
  ...(extra.start === true ? { start: extra.start } : {}),
});

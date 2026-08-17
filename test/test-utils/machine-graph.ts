/**
 * Walk helpers over one declared machine table — find a node or event by
 * id, list one-step successors, and collect every reachable node. Shared by
 * the per-machine graph suites so the walks cannot drift apart.
 */

export interface MachineGraphConfig<
  Node extends { readonly id: NodeId },
  Event extends { readonly id: EventId },
  NodeId extends string,
  EventId extends string,
> {
  readonly events: readonly Event[];
  readonly label: string;
  readonly nodes: readonly Node[];
  readonly targets: (from: NodeId, event: EventId) => readonly NodeId[];
}

export interface MachineGraph<
  Node extends { readonly id: NodeId },
  Event extends { readonly id: EventId },
  NodeId extends string,
  EventId extends string,
> {
  readonly eventById: (id: EventId) => Event;
  readonly nodeById: (id: NodeId) => Node;
  readonly reachableFrom: (
    start: NodeId,
    keep?: (event: Event) => boolean,
  ) => Set<NodeId>;
  readonly successors: (
    from: NodeId,
    keep?: (event: Event) => boolean,
  ) => readonly NodeId[];
}

const keepAll = (): boolean => true;

export const machineGraph = <
  Node extends { readonly id: NodeId },
  Event extends { readonly id: EventId },
  NodeId extends string,
  EventId extends string,
>(
  config: MachineGraphConfig<Node, Event, NodeId, EventId>,
): MachineGraph<Node, Event, NodeId, EventId> => {
  const finderFor =
    <Item extends { readonly id: string }>(
      list: readonly Item[],
      kind: string,
    ) =>
    (id: string): Item => {
      const item = list.find((candidate) => candidate.id === id);
      if (item === undefined) {
        throw new Error(`Unknown ${config.label} ${kind} ${id}`);
      }
      return item;
    };
  const successors = (
    from: NodeId,
    keep: (event: Event) => boolean = keepAll,
  ): readonly NodeId[] =>
    config.events
      .filter(keep)
      .flatMap((event) => config.targets(from, event.id));
  const reachableFrom = (
    start: NodeId,
    keep: (event: Event) => boolean = keepAll,
  ): Set<NodeId> => {
    const seen = new Set<NodeId>([start]);
    const queue: NodeId[] = [start];
    for (let index = 0; index < queue.length; index++) {
      for (const next of successors(queue[index]!, keep)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };
  return {
    eventById: finderFor(config.events, "event"),
    nodeById: finderFor(config.nodes, "node"),
    reachableFrom,
    successors,
  };
};

/* jscpd:ignore-start -- imports */
import type { TlaAtom } from "#scripts/verify-models/data.ts";
import type {
  MachineEvent,
  MachineMovesReader,
  MachineNode,
  MachineRepresentative,
} from "#shared/schema-atlas/machine-spec.ts";
import { attemptTransition } from "#shared/schema-atlas/types.ts";

/* jscpd:ignore-end */

/** A required move must throw on failure. Only declared refusals can return null. */
const runDeclaredMove = <State, Node extends string, Event extends string>(
  moves: MachineMovesReader<Node, Event>,
  node: Node,
  representative: MachineRepresentative<State>,
  event: MachineEvent<State, Event>,
): State | null => {
  const input = structuredClone(representative.state);
  return moves.expected(node, event.id, representative.tag) === "refused"
    ? attemptTransition(event.run, input)
    : event.run(input);
};

/** Project every representative and event. Each attempt gets its own input. */
export const collectMachineFacts = <
  State,
  NodeId extends string,
  EventId extends string,
  Details extends readonly TlaAtom[],
  AttemptFact,
>(
  nodes: readonly MachineNode<State, NodeId>[],
  events: readonly MachineEvent<State, EventId>[],
  moves: MachineMovesReader<NodeId, EventId>,
  representativeDetails: (state: State) => Details,
  attemptFact: (
    representative: MachineRepresentative<State>,
    event: MachineEvent<State, EventId>,
    target: State | null,
  ) => AttemptFact | null,
): {
  representatives: (readonly [NodeId, string, ...Details])[];
  attempts: AttemptFact[];
} => {
  const representatives: (readonly [NodeId, string, ...Details])[] = [];
  const attempts: AttemptFact[] = [];
  for (const node of nodes) {
    for (const representative of node.reps) {
      representatives.push([
        node.id,
        representative.tag,
        ...representativeDetails(representative.state),
      ]);
      for (const event of events) {
        const target = runDeclaredMove(moves, node.id, representative, event);
        const fact = attemptFact(representative, event, target);
        if (fact !== null) attempts.push(fact);
      }
    }
  }
  return { attempts, representatives };
};

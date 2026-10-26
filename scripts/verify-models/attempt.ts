/* jscpd:ignore-start -- imports */
import type { TlaRecord } from "#scripts/verify-models/data.ts";
import type {
  MachineEvent,
  MachineMovesReader,
  MachineNode,
  MachineRepresentative,
} from "#shared/schema-atlas/machine-spec.ts";
import { attemptTransition } from "#shared/schema-atlas/types.ts";

/* jscpd:ignore-end */

export const representativeFields = {
  declaredState: "Str",
  sampleTag: "Str",
} as const;

type RepresentativeFact<Node extends string, Details> = Details & {
  readonly declaredState: Node;
  readonly sampleTag: string;
};

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
  Details extends TlaRecord,
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
  representatives: RepresentativeFact<NodeId, Details>[];
  attempts: AttemptFact[];
} => {
  const representatives: RepresentativeFact<NodeId, Details>[] = [];
  const attempts: AttemptFact[] = [];
  for (const node of nodes) {
    for (const representative of node.reps) {
      representatives.push({
        ...representativeDetails(representative.state),
        declaredState: node.id,
        sampleTag: representative.tag,
      });
      for (const event of events) {
        const target = runDeclaredMove(moves, node.id, representative, event);
        const fact = attemptFact(representative, event, target);
        if (fact !== null) attempts.push(fact);
      }
    }
  }
  return { attempts, representatives };
};

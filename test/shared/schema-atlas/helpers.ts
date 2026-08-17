/** Shared lookups for exact-edge assertions over one derived machine. */

import type { AtlasMachine } from "#shared/schema-atlas/types.ts";

export type MachineIndex = {
  readonly byId: Map<string, AtlasMachine["states"][number]>;
  /** Each edge of one state, as `label=>target` for exact-set asserts. */
  readonly edgeIds: (id: string) => string[];
  readonly machine: AtlasMachine;
};

export const indexMachine = (machine: AtlasMachine): MachineIndex => {
  const byId = new Map(machine.states.map((state) => [state.id, state]));
  return {
    byId,
    edgeIds: (id: string): string[] =>
      byId
        .get(id)!
        .edges.map((edge) => `${edge.labelKey.split(".").pop()}=>${edge.to}`),
    machine,
  };
};

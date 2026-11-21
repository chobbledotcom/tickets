import {
  type CheckPhase,
  dataFrom,
  type ModelControl,
  type VerificationModule,
} from "#scripts/verify-models/spec.ts";

const modal = dataFrom(
  () => import("#scripts/verify-models/modal-lifecycle.ts"),
);

/** The producer export that supplies each control's data. */
type ControlData =
  | "duplicateRankModalData"
  | "twoBrightWindowsModalData"
  | "forgottenPositionModalData"
  | "stuckWindowFocusModalData"
  | "reversedSurvivorsModalData";

type ControlDefinition = readonly [
  name: string,
  phase: CheckPhase,
  data: ControlData,
];
/* jscpd:ignore-start -- static data, not code */
const controlDefinitions = [
  ["two windows sharing one stack rank", "initial", "duplicateRankModalData"],
  ["two windows that are both bright", "initial", "twoBrightWindowsModalData"],
  [
    "minimise forgetting the expanded position",
    "step",
    "forgottenPositionModalData",
  ],
  [
    "a press on the page leaving the focus in the window",
    "step",
    "stuckWindowFocusModalData",
  ],
  [
    "close reversing the two surviving windows",
    "step",
    "reversedSurvivorsModalData",
  ],
] as const satisfies readonly [ControlDefinition, ...ControlDefinition[]];
/* jscpd:ignore-end */

const controls = controlDefinitions.map(([name, phase, data]) => ({
  data: modal((m) => m[data]),
  name,
  phase,
})) as [ModelControl, ...ModelControl[]];

/** Register source evidence and controls without eagerly loading the producer. */
export const modalLifecycleVerification = {
  context: [
    "verification/ModelRules.tla",
    "scripts/verify-models/modal-lifecycle.ts",
    "scripts/verify-models/modal-lifecycle-matrix.ts",
    "scripts/verify-models/modal-lifecycle-registration.ts",
    "src/ui/client/admin/modal-focus.ts",
    "src/ui/client/admin/modal-state.ts",
    "src/ui/client/admin/modal-position.ts",
    "src/ui/client/admin/modal.ts",
  ],
  controls,
  data: modal((m) => m.modalLifecycleModelData),
  kind: "model",
  module: "ModalLifecycle",
} as const satisfies VerificationModule;

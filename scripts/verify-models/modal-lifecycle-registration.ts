import type { ModelDataSource } from "#scripts/verify-models/data.ts";
import type * as ModalProducer from "#scripts/verify-models/modal-lifecycle.ts";
import {
  type CheckPhase,
  dataFrom,
  type ModelControl,
  type VerificationModule,
} from "#scripts/verify-models/spec.ts";

const modal = dataFrom(
  () => import("#scripts/verify-models/modal-lifecycle.ts"),
);

type ControlDefinition = readonly [
  name: string,
  phase: CheckPhase,
  select: (producer: typeof ModalProducer) => ModelDataSource,
];
const controlDefinitions = [
  [
    "two windows sharing one stack rank",
    "initial",
    (m) => m.duplicateRankModalData,
  ],
  [
    "two windows that are both bright",
    "initial",
    (m) => m.twoBrightWindowsModalData,
  ],
  [
    "minimise forgetting the expanded position",
    "step",
    (m) => m.forgottenPositionModalData,
  ],
  [
    "a press on the page leaving the focus in the window",
    "step",
    (m) => m.stuckWindowFocusModalData,
  ],
  [
    "close reversing the two surviving windows",
    "step",
    (m) => m.reversedSurvivorsModalData,
  ],
] as const satisfies readonly [ControlDefinition, ...ControlDefinition[]];

const controls = controlDefinitions.map(([name, phase, select]) => ({
  data: modal(select),
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

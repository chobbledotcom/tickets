/** Check the live machine models with the pinned Apalache package from devenv. */
import { join } from "node:path";
import { projectRoot } from "#scripts/project-root.ts";
import { makeScratchDir } from "#scripts/scratch.ts";
import {
  deletedRowRefundData,
  duplicateBookingData,
} from "#scripts/verify-models/booking.ts";
import { counterexampleData } from "#scripts/verify-models/counterexample.ts";
import { MODELS } from "#scripts/verify-models/registry.ts";
import {
  dateLessSoldOutPairData,
  overfillCapacityData,
} from "#scripts/verify-models/shared-group-capacity.ts";

const checks = [
  { init: "Init", length: 0, name: "initial state" },
  {
    init: "InductionStart",
    length: 1,
    name: "every legal state and next edge",
  },
];
const work = await makeScratchDir("machine-proofs-");
await Deno.copyFile(
  join(projectRoot, "verification/ModelRules.tla"),
  join(work, "ModelRules.tla"),
);
const runCheck = (module: string, init: string, length: number) =>
  new Deno.Command("apalache-mc", {
    args: [
      "check",
      `--init=${init}`,
      "--next=Next",
      "--inv=Safety",
      `--length=${length}`,
      `${module}.tla`,
    ],
    cwd: work,
    stderr: "inherit",
    stdout: "inherit",
  }).output();
for (const model of MODELS) {
  await Deno.copyFile(
    join(projectRoot, `verification/${model.module}.tla`),
    join(work, `${model.module}.tla`),
  );
  await Deno.writeTextFile(
    join(work, `${model.module}Data.tla`),
    await model.data(),
  );
  for (const check of checks) {
    console.log(`Check ${model.module}: ${check.name}.`);
    const result = await runCheck(model.module, check.init, check.length);
    if (!result.success) {
      throw new Error(
        `${model.module} proof failed. Read the counterexample in ${work}`,
      );
    }
  }
}

// The checker must reject corrupt data. A pass here would make the clean
// verdicts worthless.
console.log("Check JointState: corrupted edge counterexample.");
await Deno.copyFile(
  join(projectRoot, "verification/JointState.tla"),
  join(work, "JointState.tla"),
);
await Deno.writeTextFile(
  join(work, "JointStateData.tla"),
  await counterexampleData(),
);
const corrupted = await runCheck("JointState", "InductionStart", 1);
if (corrupted.success) {
  throw new Error(
    "The checker accepted a corrupted edge. The safety verdict is not trusted.",
  );
}

// The BookingReplay proof must reject both failure modes it rules out: a
// duplicate booking and a refund that returns after the temporary row is
// deleted. A pass on either would make the clean verdict worthless.
const checkRejected = async (
  module: string,
  label: string,
  data: () => Promise<string>,
  init: string,
  length: number,
): Promise<void> => {
  await Deno.copyFile(
    join(projectRoot, `verification/${module}.tla`),
    join(work, `${module}.tla`),
  );
  await Deno.writeTextFile(join(work, `${module}Data.tla`), await data());
  const result = await runCheck(module, init, length);
  if (result.success) {
    throw new Error(
      `The checker accepted a ${label}. The safety verdict is not trusted.`,
    );
  }
};
console.log("Check BookingReplay: duplicate booking counterexample.");
await checkRejected(
  "BookingReplay",
  "duplicate booking",
  duplicateBookingData,
  "InductionStart",
  1,
);
console.log("Check BookingReplay: deleted-row refund counterexample.");
await checkRejected(
  "BookingReplay",
  "refund after the temporary row was deleted",
  deletedRowRefundData,
  "InductionStart",
  1,
);

// The SharedGroupCapacity proof must reject both failure modes it rules out:
// a fit ceiling that overreports the whole orders a real pool holds, and an
// allow gate that passes a sold-out date-less pair. A pass on either would
// make the clean verdict worthless.
console.log("Check SharedGroupCapacity: overfill counterexample.");
await checkRejected(
  "SharedGroupCapacity",
  "group overfill",
  overfillCapacityData,
  "Init",
  0,
);
console.log(
  "Check SharedGroupCapacity: date-less sold-out pair counterexample.",
);
await checkRejected(
  "SharedGroupCapacity",
  "date-less sold-out pair",
  dateLessSoldOutPairData,
  "Init",
  0,
);
await Deno.remove(work, { recursive: true });
console.log(
  "All machine safety checks passed the initial state and inductive step.",
  "The checker rejected the corrupted edge.",
);

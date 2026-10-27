/** Check the live machine models with the pinned Apalache package from devenv. */
import { join } from "node:path";
import { projectRoot } from "#scripts/project-root.ts";
import { makeScratchDir } from "#scripts/scratch.ts";
import { counterexampleData } from "#scripts/verify-models/counterexample.ts";
import { modelData, paymentModel } from "#scripts/verify-models/model.ts";
import { reviewModelData } from "#scripts/verify-models/review.ts";
import { squareModelData } from "#scripts/verify-models/square.ts";
import { sumupModelData } from "#scripts/verify-models/sumup.ts";
import { twoWorkersModelData } from "#scripts/verify-models/two-workers.ts";
import { vatModelData } from "#scripts/verify-models/vat.ts";

const models = [
  { data: vatModelData, module: "VatLedger" },
  { data: squareModelData, module: "SquareLinkEnd" },
  { data: sumupModelData, module: "SumupRecovery" },
  { data: reviewModelData, module: "PaymentReview" },
  { data: async () => modelData(await paymentModel()), module: "JointState" },
  { data: twoWorkersModelData, module: "TwoWorkers" },
];
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
for (const model of models) {
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
await Deno.remove(work, { recursive: true });
console.log(
  "All machine safety checks passed the initial state and inductive step.",
  "The checker rejected the corrupted edge.",
);

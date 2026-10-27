/** Check the live machine models with the pinned Apalache package from devenv. */
import { join } from "node:path";
import { projectRoot } from "#scripts/project-root.ts";
import { makeScratchDir } from "#scripts/scratch.ts";
import { modelData, paymentModel } from "#scripts/verify-models/model.ts";
import { reviewModelData } from "#scripts/verify-models/review.ts";
import { squareModelData } from "#scripts/verify-models/square.ts";
import { sumupModelData } from "#scripts/verify-models/sumup.ts";

const models = [
  { data: squareModelData, module: "SquareLinkEnd" },
  { data: sumupModelData, module: "SumupRecovery" },
  { data: reviewModelData, module: "PaymentReview" },
  { data: async () => modelData(await paymentModel()), module: "JointState" },
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
    const result = await new Deno.Command("apalache-mc", {
      args: [
        "check",
        `--init=${check.init}`,
        "--next=Next",
        "--inv=Safety",
        `--length=${check.length}`,
        `${model.module}.tla`,
      ],
      cwd: work,
      stderr: "inherit",
      stdout: "inherit",
    }).output();
    if (!result.success) {
      throw new Error(
        `${model.module} proof failed. Read the counterexample in ${work}`,
      );
    }
  }
}
await Deno.remove(work, { recursive: true });
console.log(
  "All machine safety checks passed the initial state and inductive step.",
);

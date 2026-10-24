/** Check the payment model with the pinned Apalache executable from devenv. */
import { join } from "node:path";
import { projectRoot } from "#scripts/project-root.ts";
import { modelData, paymentModel } from "#scripts/verify-models/model.ts";

const scratch = join(projectRoot, ".scratch");
await Deno.mkdir(scratch, { recursive: true });
const work = await Deno.makeTempDir({ dir: scratch, prefix: "payment-proof-" });
await Deno.copyFile(
  join(projectRoot, "verification/JointState.tla"),
  join(work, "JointState.tla"),
);
await Deno.writeTextFile(
  join(work, "JointStateData.tla"),
  modelData(await paymentModel()),
);

const checks = [
  { init: "Init", length: 0, name: "initial state" },
  {
    init: "InductionStart",
    length: 1,
    name: "every legal state and next edge",
  },
];
for (const check of checks) {
  console.log(`Check payment safety: ${check.name}.`);
  const result = await new Deno.Command(
    join(projectRoot, ".devenv/profile/bin/apalache-mc"),
    {
      args: [
        "check",
        `--init=${check.init}`,
        "--next=Next",
        "--inv=Safety",
        `--length=${check.length}`,
        "JointState.tla",
      ],
      cwd: work,
      stderr: "inherit",
      stdout: "inherit",
    },
  ).output();
  if (!result.success) {
    throw new Error(`Payment proof failed. Read the counterexample in ${work}`);
  }
}
await Deno.remove(work, { recursive: true });
console.log(
  "Payment safety holds by induction under the declared admission and send guards.",
);

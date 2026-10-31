/** Check the live machine models with the pinned Apalache package from devenv. */
import { join } from "node:path";
import { projectRoot } from "#scripts/project-root.ts";
import { makeScratchDir } from "#scripts/scratch.ts";
import {
  overfillInsertData,
  partialCommitData,
} from "#scripts/verify-models/attendee-capacity.ts";
import {
  deletedRowRefundData,
  duplicateBookingData,
} from "#scripts/verify-models/booking.ts";
import {
  compoundingDiscountData,
  overshootDiscountData,
  staleFeeData,
} from "#scripts/verify-models/composition-corruptions.ts";
import { counterexampleData } from "#scripts/verify-models/counterexample.ts";
import {
  corruptDoorScanData,
  refundedAdmissionDoorScanData,
  takeBackDoorScanData,
} from "#scripts/verify-models/door-scan.ts";
import { corruptSplitData } from "#scripts/verify-models/largest-remainder-split.ts";
import {
  corruptClaimWithoutCaptureData,
  corruptRestoreColourData,
} from "#scripts/verify-models/notification-flag-lease.ts";
import {
  doubleRecordData,
  nonInverseLegData,
  operatorMoneyReversalData,
  unpairedLegData,
} from "#scripts/verify-models/refund-reversal.ts";

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
const decoder = new TextDecoder();
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
    stderr: "piped",
    stdout: "piped",
  })
    .output()
    .then((result) => ({
      output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
      success: result.success,
    }));
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
        `${model.module} proof failed. Read the counterexample in ${work}\n${result.output}`,
      );
    }
  }
}

// Every negative control must reject its corrupted data with a real
// counterexample, not with a checker crash. A crash rejects nothing.
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
  if (
    !/violated/.test(result.output) ||
    !/Check the trace in:/.test(result.output)
  ) {
    throw new Error(
      `The checker reported no violated invariant and no trace for a corrupted ${label}. The run failed for another reason, and its verdict is not trusted.\n${result.output}`,
    );
  }
};

// The checker must reject corrupt data. A pass here would make the clean
// verdicts worthless.
console.log("Check JointState: corrupted edge counterexample.");
await checkRejected(
  "JointState",
  "corrupted edge",
  counterexampleData,
  "InductionStart",
  1,
);
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
// The AttendeeCapacity proof must reject both failure modes it rules out:
// an insert past the slot's quantity and a partial commit that leaves an
// earlier line when a later line is refused. A pass on either would make
// the clean verdict worthless.
console.log("Check AttendeeCapacity: overfill insert counterexample.");
await checkRejected(
  "AttendeeCapacity",
  "an insert past the slot's quantity",
  overfillInsertData,
  "Init",
  0,
);
console.log("Check AttendeeCapacity: partial commit counterexample.");
await checkRejected(
  "AttendeeCapacity",
  "an earlier line surviving a later refused line",
  partialCommitData,
  "Init",
  0,
);
// The LargestRemainderSplit proof must reject both failure modes it guards:
// an award past a part's cap and accounting that strands an owed unit. A pass
// on either would make the clean verdict worthless.
console.log("Check LargestRemainderSplit: over-cap award counterexample.");
await checkRejected(
  "LargestRemainderSplit",
  "an award past a part's cap",
  () => corruptSplitData("cap guard"),
  "InductionStart",
  1,
);
console.log("Check LargestRemainderSplit: stranded owed unit counterexample.");
await checkRejected(
  "LargestRemainderSplit",
  "accounting that strands an owed unit",
  () => corruptSplitData("unconserved accounting"),
  "InductionStart",
  1,
);

// The CheckoutComposition proof must reject the three failure modes it
// rules out: a modifier that compounds on an earlier pass, a discount that
// removes more than the units hold, and a booking fee charged on a stale
// subtotal. A pass on any one would make the clean verdicts worthless.
console.log("Check CheckoutComposition: compounding modifier counterexample.");
await checkRejected(
  "CheckoutComposition",
  "a modifier that compounds on an earlier pass",
  compoundingDiscountData,
  "InductionStart",
  1,
);
console.log("Check CheckoutComposition: overshooting discount counterexample.");
await checkRejected(
  "CheckoutComposition",
  "a discount that removes more than the units hold",
  overshootDiscountData,
  "InductionStart",
  1,
);
console.log("Check CheckoutComposition: stale-subtotal fee counterexample.");
await checkRejected(
  "CheckoutComposition",
  "a booking fee charged on a stale subtotal",
  staleFeeData,
  "InductionStart",
  1,
);

// The DoorScan proof must reject an admission past the listing's quantity.
// A pass would make the no-over-admission verdict worthless.
console.log("Check DoorScan: over-admission counterexample.");
await checkRejected(
  "DoorScan",
  "an admission past the listing's quantity",
  corruptDoorScanData,
  "InductionStart",
  1,
);
// The DoorScan proof must reject a scan that takes a place back.
console.log("Check DoorScan: take-back counterexample.");
await checkRejected(
  "DoorScan",
  "a scan that takes a place back",
  takeBackDoorScanData,
  "InductionStart",
  1,
);
// The NotificationFlagLease proof must reject a claim that zeroes a flag
// without capturing its value, and a restore that invents a colour. A pass
// on either would make the clean verdicts worthless.
console.log(
  "Check NotificationFlagLease: claim-without-capture counterexample.",
);
await checkRejected(
  "NotificationFlagLease",
  "a claim that zeroes a flag without capturing it",
  corruptClaimWithoutCaptureData,
  "InductionStart",
  1,
);
console.log(
  "Check NotificationFlagLease: invented restore colour counterexample.",
);
await checkRejected(
  "NotificationFlagLease",
  "a restore that invents a colour different from the captured one",
  corruptRestoreColourData,
  "InductionStart",
  1,
);
// The DoorScan proof must reject the admission of a refunded row.
console.log("Check DoorScan: refunded-row admission counterexample.");
await checkRejected(
  "DoorScan",
  "an admitted refunded row",
  refundedAdmissionDoorScanData,
  "InductionStart",
  1,
);
// The RefundReversal proof must reject an operator-money group that reverses.
// A pass would make the reversal-eligibility verdict worthless.
console.log("Check RefundReversal: operator-money reversal counterexample.");
await checkRejected(
  "RefundReversal",
  "a reversal of a group that carries operator money",
  operatorMoneyReversalData,
  "InductionStart",
  1,
);
// The RefundReversal proof must reject a posted leg that is not the exact
// inverse of a recorded leg. A pass would make the leg-inverse verdict
// worthless.
console.log("Check RefundReversal: non-inverse leg counterexample.");
await checkRejected(
  "RefundReversal",
  "a posted leg that is not the exact inverse of a recorded leg",
  nonInverseLegData,
  "InductionStart",
  1,
);
// The RefundReversal proof must reject a posted leg that pairs with no leg
// the ledger records. A pass would make the leg-pairing verdict worthless.
console.log("Check RefundReversal: unpaired leg counterexample.");
await checkRejected(
  "RefundReversal",
  "a posted leg that pairs with no recorded original",
  unpairedLegData,
  "InductionStart",
  1,
);
// The RefundReversal proof must reject a second identical refund that credits
// again. A pass would make the no-double-record verdict worthless.
console.log("Check RefundReversal: double-record counterexample.");
await checkRejected(
  "RefundReversal",
  "a double record that credits twice",
  doubleRecordData,
  "InductionStart",
  1,
);
await Deno.remove(work, { recursive: true });
console.log(
  "All machine safety checks passed the initial state and inductive step.",
  "The checker rejected the corrupted edge.",
);

import * as v from "valibot";
import { integerAtLeast } from "#shared/validation/number.ts";
import { isInstant } from "#shared/validation/timestamp.ts";
import { PRECOMMIT_STEP_NAMES } from "./steps.ts";

export const PRECOMMIT_STATUS_DIR = ".diagnostics/precommit";

const UuidSchema = v.pipe(v.string(), v.uuid());
export const PrecommitStatusFilenameSchema = v.pipe(
  v.string(),
  v.endsWith(".json"),
  v.check((name) => v.is(UuidSchema, name.slice(0, -5))),
);

const TimestampSchema = v.pipe(v.string(), v.check(isInstant));
const StepSchema = v.picklist(PRECOMMIT_STEP_NAMES);
const statusSchema = <
  const State extends string,
  const Fields extends v.ObjectEntries,
>(
  state: State,
  fields: Fields,
) =>
  v.strictObject({
    ...fields,
    createdAt: TimestampSchema,
    pid: integerAtLeast(1),
    state: v.literal(state),
    updatedAt: TimestampSchema,
  });
const terminalFields = {
  step: v.nullable(StepSchema),
  stepCompletedAt: v.nullable(TimestampSchema),
};

export const PrecommitStatusSchema = v.pipe(
  v.variant("state", [
    statusSchema("waiting", {
      exitCode: v.null(),
      step: v.null(),
      stepCompletedAt: v.null(),
    }),
    statusSchema("running", {
      exitCode: v.null(),
      step: StepSchema,
      stepCompletedAt: v.nullable(TimestampSchema),
    }),
    statusSchema("passed", {
      ...terminalFields,
      exitCode: v.literal(0),
    }),
    statusSchema("failed", {
      ...terminalFields,
      exitCode: v.pipe(v.number(), v.integer(), v.notValue(0)),
    }),
  ]),
  v.check((record) => record.step !== null || record.stepCompletedAt === null),
);

export type PrecommitStatus = v.InferOutput<typeof PrecommitStatusSchema>;

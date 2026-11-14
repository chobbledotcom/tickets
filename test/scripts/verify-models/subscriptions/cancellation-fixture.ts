import type { TlaRecord } from "#scripts/verify-models/data.ts";
import type { ModelControl } from "#scripts/verify-models/spec.ts";
import { records } from "#test-utils/tla-data.ts";

/** Exercise exactly the emitted input that the checker receives. */
export const decodedCancellationData = async (control: ModelControl) => {
  const data = await control.data();
  return {
    checkouts: records(data, "Checkouts"),
    owners: records(data, "Owners"),
    writes: records(data, "Writes"),
  };
};

/** Keep every selected input in the comparison, including duplicate outcomes. */
export const activeOverEnded = (writes: readonly TlaRecord[]) =>
  writes
    .filter(
      (fact) =>
        fact.snapshot === "active" &&
        fact.before === "canceled" &&
        fact.target === "active",
    )
    .map(({ affected, after, before, snapshot, target }) => ({
      affected,
      after,
      before,
      snapshot,
      target,
    }));

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { vatModel, vatModelData } from "#scripts/verify-models/vat.ts";
import {
  TAX_EVENTS,
  type TaxEventId,
  type TaxMachineEvent,
  type TaxMachineState,
} from "#shared/tax/machine-spec.ts";
import { records } from "#test-utils/tla-data.ts";

type Corruption = {
  name: string;
  eventId: TaxEventId;
  run: (
    input: TaxMachineState,
    actual: TaxMachineEvent["run"],
  ) => TaxMachineState;
};
const corruptions: readonly Corruption[] = [
  {
    eventId: "setting_add",
    name: "historical",
    run: (input, actual) => {
      const output = actual(input);
      output.booking.assessment.total += 1;
      return output;
    },
  },
  { eventId: "save_stale", name: "stale", run: (input) => input },
  {
    eventId: "save",
    name: "basis",
    run: (input, actual) => {
      const output = actual(input);
      output.booking.assessment.basis.lines[0]!.gross += 1;
      return output;
    },
  },
  {
    eventId: "save",
    name: "terminal",
    run: (input, actual) => {
      const output = actual(input);
      output.booking.kind = "active";
      return output;
    },
  },
  {
    eventId: "save",
    name: "replay",
    run: (input, actual) => {
      const output = actual(input);
      output.booking.revision += 1;
      return output;
    },
  },
  {
    eventId: "save",
    name: "rounding",
    run: (input, actual) => {
      const output = actual(input);
      output.booking.assessment.total += 1;
      return output;
    },
  },
];

describe("VAT production-derived proof data", () => {
  it("covers every attempted event, including stale refusals and independent settings", async () => {
    const model = vatModel();
    const attempts = records(await vatModelData(model), "VatAttempts");
    expect(
      attempts.some(
        (attempt) => attempt.eventId === "save_stale" && !attempt.accepted,
      ),
    ).toBe(true);
    expect(model.attempts.every((attempt) => attempt.safe)).toBe(true);
    expect(attempts.every((attempt) => attempt.safe)).toBe(true);
    for (const event of TAX_EVENTS)
      expect(attempts.some((attempt) => attempt.eventId === event.id)).toBe(
        true,
      );
  });

  for (const corruption of corruptions) {
    it(`retains unsafe ${corruption.name} results in emitted facts`, async () => {
      const event = TAX_EVENTS.find(
        (candidate) => candidate.id === corruption.eventId,
      );
      if (!event) throw new Error("Missing event");
      const actual = event.run;
      using _run = stub(event, "run", (input) => corruption.run(input, actual));
      const model = vatModel();
      expect(model.attempts.some((attempt) => !attempt.safe)).toBe(true);
      expect(
        records(await vatModelData(model), "VatAttempts").some(
          (attempt) => !attempt.safe,
        ),
      ).toBe(true);
    });
  }
});

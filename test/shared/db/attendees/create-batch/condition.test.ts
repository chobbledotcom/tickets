import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { bookingBatchCondition } from "#db/attendees/create-batch.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  buildPlan,
  pricedLine,
  surcharge,
} from "#test-utils/db-helpers/attendee-creation.ts";

describeWithEnv(
  "db > attendees > booking batch condition",
  { db: true },
  () => {
    test("binds modifier stock and ledger replay facts once", async () => {
      const { plan } = await buildPlan({
        eventId: "batch-condition",
        fullSubtotal: 600,
        lines: [pricedLine(17, 500, 1)],
        total: 600,
        usages: [surcharge(23, 100)],
      });

      const statement = numberedStatement(bookingBatchCondition(plan));

      expect(statement.args).toEqual([
        23,
        1,
        plan.legs[0]!.eventGroup,
        ...plan.legs.map((leg) => leg.reference),
      ]);
      expect(statement.sql).toContain("id = ?1");
      expect(statement.sql).toContain("modifier_id = ?1");
      expect(statement.sql).toContain("event_group = ?3");
    });

    test("uses two true conditions for a plan without stock or ledger work", () => {
      const statement = numberedStatement(
        bookingBatchCondition({ legs: [], usages: [] }),
      );

      expect(statement).toEqual({
        args: [],
        sql: "(1 = 1) AND (1 = 1)",
      });
    });
  },
);

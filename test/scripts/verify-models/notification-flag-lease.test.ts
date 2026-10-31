/** The notification flag lease checker data: the production flag functions
 *  supply every fact, and the negative controls keep the safety verdicts
 *  honest. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  clearPendingFlagStatement,
  PENDING_NOTIFICATION,
  restorePendingFlagStatement,
} from "#db/attendees/notification-flags.ts";
import {
  claimFacts,
  clearFacts,
  corruptClaimWithoutCapture,
  corruptClaimWithoutCaptureData,
  corruptRestoreColour,
  corruptRestoreColourData,
  notificationFlagLeaseModelData,
  REPRESENTATIVE,
  restoreFacts,
} from "#scripts/verify-models/notification-flag-lease.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

type DataRecord = Record<string, string | boolean | number>;

const claimOf = (
  beforeEmail: number,
  beforeWebhooks: number,
  claimsEmail: boolean,
  claimsWebhooks: boolean,
  worker: "w1" | "w2",
): DataRecord => ({
  beforeEmail,
  beforeWebhooks,
  claimsEmail,
  claimsWebhooks,
  worker,
});

describe("notification flag lease checker data", () => {
  test("records the claim facts both recoveries meet", () => {
    expect(claimFacts()).toEqual([
      claimOf(0, 0, false, false, "w1"),
      claimOf(0, 1, false, true, "w1"),
      claimOf(2, 0, true, false, "w1"),
      claimOf(2, 1, true, true, "w1"),
      claimOf(0, 0, false, false, "w2"),
      claimOf(0, 1, false, true, "w2"),
      claimOf(2, 0, true, false, "w2"),
      claimOf(2, 1, true, true, "w2"),
    ]);
  });

  test("a claim captures exactly the outstanding sides", () => {
    for (const fact of claimFacts()) {
      expect(fact.claimsEmail).toBe(fact.beforeEmail > 0);
      expect(fact.claimsWebhooks).toBe(fact.beforeWebhooks > 0);
    }
  });

  test("the claim captures the representative's own colours", () => {
    for (const fact of claimFacts()) {
      if (fact.claimsEmail) {
        expect(fact.beforeEmail).toBe(REPRESENTATIVE.email);
      }
      if (fact.claimsWebhooks) {
        expect(fact.beforeWebhooks).toBe(REPRESENTATIVE.webhooks);
      }
    }
  });

  test("the restore facts name each side subset at its own captured colour", () => {
    expect(restoreFacts()).toEqual([
      {
        emailValue: PENDING_NOTIFICATION.admin,
        returnsEmail: true,
        returnsWebhooks: false,
        webhooksValue: PENDING_NOTIFICATION.none,
      },
      {
        emailValue: PENDING_NOTIFICATION.none,
        returnsEmail: false,
        returnsWebhooks: true,
        webhooksValue: PENDING_NOTIFICATION.online,
      },
      {
        emailValue: PENDING_NOTIFICATION.admin,
        returnsEmail: true,
        returnsWebhooks: true,
        webhooksValue: PENDING_NOTIFICATION.online,
      },
    ]);
  });

  test("the clear facts name both sides", () => {
    expect(clearFacts()).toEqual([{ side: "email" }, { side: "webhooks" }]);
  });

  test("the production restore writes the captured colour back", () => {
    for (const side of ["email", "webhooks"] as const) {
      expect(
        restorePendingFlagStatement(side, [1], REPRESENTATIVE[side]).args[0],
      ).toBe(REPRESENTATIVE[side]);
      expect(restorePendingFlagStatement(side, [1], 0).sql).toContain(
        `${side}_pending = ?`,
      );
    }
  });

  test("the production clear statement zeroes an up flag", () => {
    for (const side of ["email", "webhooks"] as const) {
      const sql = clearPendingFlagStatement(side, [1]).sql;
      expect(sql).toContain(`${side}_pending = 0`);
      expect(sql).toContain(`${side}_pending > 0`);
    }
  });

  test("names the data module and the fact sets the proof reads", async () => {
    const data = await notificationFlagLeaseModelData();
    expect(data).toContain("MODULE NotificationFlagLeaseData");
    expect(data).toContain("ClaimFacts ==");
    expect(data).toContain("RestoreFacts ==");
    expect(data).toContain("ClearFacts ==");
  });

  test("the corrupted claim zeroes an up email flag without capturing it", async () => {
    const corrupted = corruptClaimWithoutCapture();
    const unsafe = corrupted.filter(
      (fact) => fact.beforeEmail > 0 && !fact.claimsEmail,
    );
    expect(unsafe).toEqual([
      claimOf(
        REPRESENTATIVE.email,
        PENDING_NOTIFICATION.none,
        false,
        false,
        "w1",
      ),
    ]);
    const data = await corruptClaimWithoutCaptureData();
    expect(records(data, "ClaimFacts")).toContainEqual(
      claimOf(
        REPRESENTATIVE.email,
        PENDING_NOTIFICATION.none,
        false,
        false,
        "w1",
      ),
    );
  });

  test("a corruption that matches no claim fact refuses to corrupt", () => {
    expect(() => corruptClaimWithoutCapture([])).toThrow(
      "The claim-without-capture control matches no claim fact.",
    );
  });

  test("the corrupted restore returns a colour the claim never captured", async () => {
    const invented = corruptRestoreColour().filter(
      (fact) => fact.returnsEmail && fact.emailValue !== REPRESENTATIVE.email,
    );
    expect(invented).toHaveLength(1);
    expect(invented[0]?.emailValue).toBe(PENDING_NOTIFICATION.online);
    const data = await corruptRestoreColourData();
    expect(records(data, "RestoreFacts")).toContainEqual({
      emailValue: PENDING_NOTIFICATION.online,
      returnsEmail: true,
      returnsWebhooks: true,
      webhooksValue: REPRESENTATIVE.webhooks,
    });
  });
});

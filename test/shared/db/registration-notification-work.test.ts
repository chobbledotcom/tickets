import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";

import { hmacHash } from "#crypto/hashing.ts";
import { execute } from "#db/client.ts";
import {
  claimRegistrationWork,
  claimRegistrationWorkOrNull,
  markRegistrationWorkDelivered,
  registrationWorkStatements,
  releaseRegistrationWork,
} from "#db/registration-notification-work.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** A work row born beside a booking, the way the creation batch writes it:
 * no claim yet, its payload sealed. */
const seedWorkRow = async (
  sessionId: string,
  ticketToken: string,
): Promise<void> => {
  for (const statement of await registrationWorkStatements(sessionId, {
    ticketToken,
  })) {
    await execute(statement.sql, statement.args);
  }
};

describeWithEnv("db > registration notification work", { db: true }, () => {
  test("claims a born row once and reads its sealed payload back", async () => {
    await seedWorkRow("cs_claim_once", "tok_claim");
    const claim = await claimRegistrationWork("cs_claim_once");
    expect(claim).toEqual({
      kind: "claimed",
      payload: { ticketToken: "tok_claim" },
    });
    // The lease is held: a second claimant within the lease window does not
    // win, and the row reads back as owned.
    expect(await claimRegistrationWorkOrNull("cs_claim_once")).toEqual({
      kind: "owned",
    });
  });

  test("returns null when the session has no work row", async () => {
    expect(await claimRegistrationWorkOrNull("cs_claim_absent")).toBe(null);
  });

  test("throws on a missing row for a booking that was born with one", async () => {
    await expect(claimRegistrationWork("cs_claim_absent")).rejects.toThrow(
      "has no registration notification work row",
    );
  });

  test("reads a delivered row back as delivered", async () => {
    await seedWorkRow("cs_claim_delivered", "tok_delivered");
    await claimRegistrationWork("cs_claim_delivered");
    await markRegistrationWorkDelivered("cs_claim_delivered");
    expect(await claimRegistrationWorkOrNull("cs_claim_delivered")).toEqual({
      kind: "delivered",
    });
  });

  test("releases a failed claim so the next delivery can win it", async () => {
    await seedWorkRow("cs_claim_released", "tok_released");
    await claimRegistrationWork("cs_claim_released");
    await releaseRegistrationWork("cs_claim_released");
    expect(await claimRegistrationWorkOrNull("cs_claim_released")).toEqual({
      kind: "claimed",
      payload: { ticketToken: "tok_released" },
    });
    // The released row never delivered, so its delivered stamp is absent.
    const row = await execute(
      "SELECT delivered_at FROM registration_notification_work WHERE session_index = ?",
      [await hmacHash("cs_claim_released")],
    );
    expect(row.rows[0]?.delivered_at).toBe(null);
  });
});

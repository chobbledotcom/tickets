import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";

import { encrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { execute } from "#db/client.ts";
import {
  claimOrInsertRegistrationWork,
  claimRegistrationWork,
  claimRegistrationWorkOrNull,
  markRegistrationWorkDelivered,
  prepareRegistrationWork,
  registrationWorkStatements,
  releaseRegistrationWork,
} from "#db/registration-notification-work.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** A work row born beside a booking, the way the creation batch writes it:
 * no claim yet, its payload sealed, its attendee resolved from the booking
 * batch's token (absent in this seed, where no attendee row exists). */
const seedWorkRow = async (
  sessionId: string,
  ticketToken: string,
): Promise<void> => {
  const prepared = await prepareRegistrationWork(sessionId, { ticketToken });
  for (const { sql, args } of registrationWorkStatements(
    prepared,
    "tok_seed",
  )) {
    await execute(sql, args);
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

  test("reads a held lease for a losing claim-or-create", async () => {
    await seedWorkRow("cs_claim_insert_win", "tok_winner");
    // The winner holds the lease; a competing claim-or-create for the same
    // session reads the actual row instead of assuming a claim.
    await claimRegistrationWork("cs_claim_insert_win");
    expect(
      await claimOrInsertRegistrationWork("cs_claim_insert_win", {
        ticketToken: "tok_loser",
      }),
    ).toEqual({
      kind: "owned",
    });
  });

  test("claims the row a winning claim-or-create made", async () => {
    // The fallback's insert wins on a session with no row: it creates the
    // row claimed, and that ownership is the only thing that separates the
    // notifying delivery from its competitor.
    expect(
      await claimOrInsertRegistrationWork("cs_claim_insert_fresh", {
        ticketToken: "tok_first",
      }),
    ).toEqual({
      kind: "claimed",
      payload: { ticketToken: "tok_first" },
    });
    // The created row is claimed, so a competing delivery reads a held
    // lease instead of claiming the same notification.
    expect(
      await claimOrInsertRegistrationWork("cs_claim_insert_fresh", {
        ticketToken: "tok_second",
      }),
    ).toEqual({ kind: "owned" });
  });

  test("names the work item when its payload cannot be read", async () => {
    await seedWorkRow("cs_claim_corrupt", "tok_corrupt");
    // Ciphertext that decrypts but is not a work payload: the failure is the
    // work item's own schema, so its name is what the error names.
    await execute(
      "UPDATE registration_notification_work SET sealed = ? WHERE session_index = ?",
      [
        await encrypt('{"unexpected":"shape"}'),
        await hmacHash("cs_claim_corrupt"),
      ],
    );
    await expect(claimRegistrationWork("cs_claim_corrupt")).rejects.toThrow(
      "registration notification work",
    );
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

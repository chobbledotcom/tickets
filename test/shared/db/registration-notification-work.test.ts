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
    if (claim.kind !== "claimed") throw new Error(`claim was ${claim.kind}`);
    expect(claim.payload).toEqual({ ticketToken: "tok_claim" });
    // The claim stamped a lease token: the fence every release and delivery
    // carries, so a late cleanup cannot clear a newer owner's lease.
    expect(claim.lease.leaseToken).toBeTruthy();
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
    const claim = await claimRegistrationWork("cs_claim_delivered");
    if (claim.kind !== "claimed") throw new Error(`claim was ${claim.kind}`);
    await markRegistrationWorkDelivered(claim.lease);
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
      await claimOrInsertRegistrationWork(
        "cs_claim_insert_win",
        { ticketToken: "tok_loser" },
        1,
      ),
    ).toEqual({
      kind: "owned",
    });
  });

  test("claims the row a winning claim-or-create made", async () => {
    // The fallback's insert wins on a session with no row: the final claim
    // leases the row this delivery just created, and that ownership is the
    // only thing that separates the notifying delivery from its competitor.
    const claim = await claimOrInsertRegistrationWork(
      "cs_claim_insert_fresh",
      { ticketToken: "tok_first" },
      7,
    );
    if (claim.kind !== "claimed") throw new Error(`claim was ${claim.kind}`);
    expect(claim.payload).toEqual({ ticketToken: "tok_first" });
    // The created row keeps the booking's attendee id, so the attendee
    // delete retires it with the booking it served.
    const row = await execute(
      "SELECT attendee_id FROM registration_notification_work WHERE session_index = ?",
      [await hmacHash("cs_claim_insert_fresh")],
    );
    expect(row.rows[0]?.attendee_id).toBe(7);
    // The created row is claimed, so a competing delivery reads a held
    // lease instead of claiming the same notification.
    expect(
      await claimOrInsertRegistrationWork(
        "cs_claim_insert_fresh",
        { ticketToken: "tok_second" },
        7,
      ),
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
    const claim = await claimRegistrationWork("cs_claim_released");
    if (claim.kind !== "claimed") throw new Error(`claim was ${claim.kind}`);
    await releaseRegistrationWork(claim.lease);
    const released = await claimRegistrationWorkOrNull("cs_claim_released");
    if (released?.kind !== "claimed") {
      throw new Error(`the freed row read ${released?.kind ?? "null"}`);
    }
    expect(released.payload).toEqual({ ticketToken: "tok_released" });
    // The released row never delivered, so its delivered stamp is absent.
    const row = await execute(
      "SELECT delivered_at FROM registration_notification_work WHERE session_index = ?",
      [await hmacHash("cs_claim_released")],
    );
    expect(row.rows[0]?.delivered_at).toBe(null);
  });

  test("fences release and delivery with the claim's lease token", async () => {
    await seedWorkRow("cs_claim_fence", "tok_fenced");
    const first = await claimRegistrationWork("cs_claim_fence");
    if (first.kind !== "claimed") throw new Error(`claim was ${first.kind}`);
    await releaseRegistrationWork(first.lease);

    // A new delivery claims the freed row. The first delivery's cleanup now
    // runs late — its release and its delivered stamp name the dead claim's
    // token, so neither may touch the new owner's lease.
    const second = await claimRegistrationWork("cs_claim_fence");
    if (second.kind !== "claimed") throw new Error(`claim was ${second.kind}`);
    expect(second.lease.leaseToken).not.toBe(first.lease.leaseToken);
    await releaseRegistrationWork(first.lease);
    await markRegistrationWorkDelivered(first.lease);

    const row = await execute(
      "SELECT claimed_at, lease_token, delivered_at FROM registration_notification_work WHERE session_index = ?",
      [await hmacHash("cs_claim_fence")],
    );
    expect(String(row.rows[0]?.claimed_at)).toBeTruthy();
    expect(String(row.rows[0]?.lease_token)).toBe(second.lease.leaseToken);
    expect(row.rows[0]?.delivered_at).toBe(null);

    // The owner's own delivery commits the marker; a stale token cannot.
    await markRegistrationWorkDelivered(second.lease);
    await releaseRegistrationWork(second.lease);
    const delivered = await execute(
      "SELECT delivered_at, lease_token FROM registration_notification_work WHERE session_index = ?",
      [await hmacHash("cs_claim_fence")],
    );
    expect(delivered.rows[0]?.delivered_at).not.toBe(null);
  });
});

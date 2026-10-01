/** The queue of Square link ends: staged sealed at creation, claimed by one
 * worker at a time, moved on by what Square's answer proved, and taken away
 * by the completion when a payment lands. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import {
  applySquareLinkEndEvent,
  claimSquareLinkEnd,
  type DueSquareLinkEnd,
  forgetSquareLinkEnd,
  getDueSquareLinkEnds,
  stageSquareLinkEnd,
} from "#db/square-link-ends.ts";
import {
  backdateAttempt,
  expectBackToQueue,
  PAST,
  stageDue,
  storedRow,
  WINDOW_END,
} from "#test/shared/square/link-end-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/* jscpd:ignore-end */

describeWithEnv("square link ends", { db: true }, () => {
  test("stages the handle sealed, keyed by the session hash, first due at the window", async () => {
    await stageSquareLinkEnd("sq_stage", "link_sq_stage", WINDOW_END);

    const row = await storedRow("sq_stage");
    expect(row?.state).toBe("pending");
    expect(row?.next_attempt_at).toBe(WINDOW_END);
    expect(await decrypt(row?.sealed_handle as EnvKeyEncrypted)).toBe(
      "link_sq_stage",
    );
    // The session id itself never rests in the row, only its one-way hash.
    expect(row?.sealed_handle).not.toContain("sq_stage");
  });

  test("claims one due row at a time and holds it inside a lease", async () => {
    await stageDue("sq_claim");

    const [due] = await getDueSquareLinkEnds();
    expect(due?.sessionIndex).toBe(await hmacHash("sq_claim"));
    const lease = await claimSquareLinkEnd(due!);
    expect(lease).not.toBeNull();
    expect(new Date(lease!).getTime()).toBeGreaterThan(Date.now());

    // A second claim on the same read loses: the first holds the row.
    expect(await claimSquareLinkEnd(due!)).toBeNull();

    const stored = await storedRow("sq_claim");
    expect(stored?.state).toBe("ending");
    expect(stored?.next_attempt_at).toBe(lease);
  });

  test("a delete that proved cancellation takes the row away", async () => {
    await stageDue("sq_cancelled");
    const [due] = await getDueSquareLinkEnds();
    const lease = await claimSquareLinkEnd(due!);

    const wrote = await applySquareLinkEndEvent(
      { ...due!, claimedAt: lease!, state: "ending" },
      "delete_answered_cancelled",
    );

    expect(wrote).toBe(true);
    expect(await storedRow("sq_cancelled")).toBeNull();
  });

  test("an answer that proved nothing waits out the failure retry", async () => {
    await stageDue("sq_inconclusive");
    const [due] = await getDueSquareLinkEnds();
    const lease = await claimSquareLinkEnd(due!);

    const wrote = await applySquareLinkEndEvent(
      { ...due!, claimedAt: lease!, state: "ending" },
      "delete_inconclusive",
    );

    expect(wrote).toBe(true);
    const stored = await storedRow("sq_inconclusive");
    expect(stored?.state).toBe("pending");
    expect(new Date(stored!.next_attempt_at).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  test("an expired lease returns the row to the front of the queue", async () => {
    await stageDue("sq_lease");
    const [due] = await getDueSquareLinkEnds();
    await claimSquareLinkEnd(due!);

    // The lease passes without an answer.
    await backdateAttempt("sq_lease");
    const [expired] = await getDueSquareLinkEnds();
    expect(expired?.state).toBe("ending");

    const wrote = await applySquareLinkEndEvent(expired!, "lease_expired");

    expect(wrote).toBe(true);
    // The row returns due now, so the next run claims it afresh.
    await expectBackToQueue("sq_lease");
  });

  test("an apply fenced on a read the row has left loses", async () => {
    await stageDue("sq_stale");
    const [due] = await getDueSquareLinkEnds();
    const lease = await claimSquareLinkEnd(due!);

    const first = await applySquareLinkEndEvent(
      { ...due!, claimedAt: lease!, state: "ending" },
      "delete_inconclusive",
    );
    expect(first).toBe(true);

    // The row already moved on past this read, so the same answer again
    // finds no row: one runner's outcome stands.
    const second = await applySquareLinkEndEvent(
      { ...due!, claimedAt: lease!, state: "ending" },
      "delete_inconclusive",
    );
    expect(second).toBe(false);
  });

  test("an end fenced on a lease the row no longer holds loses", async () => {
    await stageDue("sq_stale_lease");
    const [due] = await getDueSquareLinkEnds();
    const firstLease = await claimSquareLinkEnd(due!);

    // The first lease expires, the row returns to the queue, and another
    // runner claims it under a fresh lease.
    await applySquareLinkEndEvent(
      { ...due!, claimedAt: firstLease!, state: "ending" },
      "lease_expired",
    );
    const [requeued] = await getDueSquareLinkEnds();
    const secondLease = await claimSquareLinkEnd(requeued!);

    // The first runner's refusal names a paid order on its own, now stale,
    // lease: the fence is the attempt time, not the state alone.
    const stale = {
      ...requeued!,
      claimedAt: PAST,
      state: "ending" as const,
    };
    expect(await applySquareLinkEndEvent(stale, "delete_refused_paid")).toBe(
      false,
    );
    const stored = await storedRow("sq_stale_lease");
    expect(stored?.state).toBe("ending");
    expect(stored?.next_attempt_at).toBe(secondLease);
    expect(secondLease).not.toBe(PAST);
  });

  test("the completion takes only a row still pending", async () => {
    await stageDue("sq_paid");
    const [due] = await getDueSquareLinkEnds();
    await claimSquareLinkEnd(due!);

    // The task already claimed this row, so the completion leaves it: the
    // task's own delete refusal will name the paid order.
    await forgetSquareLinkEnd("sq_paid");
    expect((await storedRow("sq_paid"))?.state).toBe("ending");

    // A row nobody claimed goes the moment the payment lands.
    await stageDue("sq_paid_free");
    await forgetSquareLinkEnd("sq_paid_free");
    expect(await storedRow("sq_paid_free")).toBeNull();
  });

  test("a row whose window has not closed is not due", async () => {
    await stageSquareLinkEnd("sq_future", "link_future", WINDOW_END);
    const futureIndex = await hmacHash("sq_future");

    const due: DueSquareLinkEnd[] = await getDueSquareLinkEnds();
    expect(due.some((row) => row.sessionIndex === futureIndex)).toBe(false);
  });
});

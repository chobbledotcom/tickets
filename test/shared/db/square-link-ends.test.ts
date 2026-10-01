/** The queue of Square link ends: staged sealed at creation, claimed by one
 * worker at a time, moved on by what Square's answer proved, and taken away
 * by the completion when a payment lands. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { decrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { execute, queryOne } from "#db/client.ts";
import {
  applySquareLinkEndEvent,
  claimSquareLinkEnd,
  type DueSquareLinkEnd,
  forgetSquareLinkEnd,
  getDueSquareLinkEnds,
  stageSquareLinkEnd,
} from "#db/square-link-ends.ts";
import type { FetchResult } from "#shared/fetch.ts";
import { SQUARE_LINK_EXPIRY_BATCH } from "#shared/limits.ts";
import { nowIso } from "#shared/now.ts";
import { squareApi } from "#shared/square/api.ts";
import { runSquareLinkExpiry } from "#shared/square/link-expiry-run.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/* jscpd:ignore-end */

const PAST = "2020-01-01T00:00:00Z";
const WINDOW_END = "2999-01-01T13:00:00Z";

interface StoredRow {
  readonly next_attempt_at: string;
  readonly sealed_handle: string;
  readonly state: string;
}

const storedRow = async (sessionId: string): Promise<StoredRow | null> =>
  queryOne<StoredRow>(
    "SELECT state, sealed_handle, next_attempt_at FROM square_link_ends WHERE session_index = ?",
    [await hmacHash(sessionId)],
  );

/** Stage a row and make it due now. */
const stageDue = async (
  sessionId: string,
  linkId = `link_${sessionId}`,
): Promise<void> => {
  await stageSquareLinkEnd(sessionId, linkId, WINDOW_END);
  await execute(
    "UPDATE square_link_ends SET next_attempt_at = ? WHERE session_index = ?",
    [PAST, await hmacHash(sessionId)],
  );
};

const theAnswer = (status: number, body: string): FetchResult => ({
  headers: new Headers(),
  ok: status >= 200 && status < 300,
  status,
  text: body,
});

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
    await execute(
      "UPDATE square_link_ends SET next_attempt_at = ? WHERE session_index = ?",
      [PAST, await hmacHash("sq_lease")],
    );
    const [expired] = await getDueSquareLinkEnds();
    expect(expired?.state).toBe("ending");

    const wrote = await applySquareLinkEndEvent(expired!, "lease_expired");

    expect(wrote).toBe(true);
    const stored = await storedRow("sq_lease");
    expect(stored?.state).toBe("pending");
    // The row returns due now, so the next run claims it afresh.
    expect(new Date(stored!.next_attempt_at).getTime()).toBeLessThanOrEqual(
      Date.parse(nowIso()),
    );
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

  test("a run ends due links by what Square answered", async () => {
    await stageDue("sq_run_end", "link_run_end");
    const read = stub(squareApi, "endLink", () =>
      Promise.resolve(
        theAnswer(
          200,
          `{"id":"link_run_end","cancelled_order_id":"order_run_end"}`,
        ),
      ),
    );
    try {
      expect(await runSquareLinkExpiry()).toBe(false);
    } finally {
      read.restore();
    }
    // The stub saw the sealed row's own link id, decrypted only at the send.
    expect(read.calls[0]?.args[0]).toBe("link_run_end");
    expect(await storedRow("sq_run_end")).toBeNull();
  });

  test("a failed send waits out the failure retry and stays loud", async () => {
    await stageDue("sq_run_fail");
    const read = stub(squareApi, "endLink", () => {
      throw new Error("Square could not be reached");
    });
    try {
      await runSquareLinkExpiry();
    } finally {
      read.restore();
    }
    const stored = await storedRow("sq_run_fail");
    expect(stored?.state).toBe("pending");
    expect(new Date(stored!.next_attempt_at).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  test("a full batch asks for a follow-up run", async () => {
    for (let index = 0; index < SQUARE_LINK_EXPIRY_BATCH; index++) {
      await stageDue(`sq_full_${index}`);
    }
    const read = stub(squareApi, "endLink", () =>
      Promise.resolve(theAnswer(404, `{"errors":[]}`)),
    );
    try {
      expect(await runSquareLinkExpiry()).toBe(true);
    } finally {
      read.restore();
    }
    for (let index = 0; index < SQUARE_LINK_EXPIRY_BATCH; index++) {
      expect(await storedRow(`sq_full_${index}`)).toBeNull();
    }
  });

  test("a row whose window has not closed is not due", async () => {
    await stageSquareLinkEnd("sq_future", "link_future", WINDOW_END);
    const futureIndex = await hmacHash("sq_future");

    const due: DueSquareLinkEnd[] = await getDueSquareLinkEnds();
    expect(due.some((row) => row.sessionIndex === futureIndex)).toBe(false);
  });

  test("a run returns an expired lease to the queue without asking Square", async () => {
    await stageDue("sq_run_lease");
    const [due] = await getDueSquareLinkEnds();
    await claimSquareLinkEnd(due!);
    // The lease passes without an answer.
    await execute(
      "UPDATE square_link_ends SET next_attempt_at = ? WHERE session_index = ?",
      [PAST, await hmacHash("sq_run_lease")],
    );

    const read = stub(squareApi, "endLink", () => {
      throw new Error("an expired lease must not reach Square");
    });
    try {
      await runSquareLinkExpiry();
    } finally {
      read.restore();
    }
    expect(read.calls).toHaveLength(0);
    const stored = await storedRow("sq_run_lease");
    expect(stored?.state).toBe("pending");
    expect(new Date(stored!.next_attempt_at).getTime()).toBeLessThanOrEqual(
      Date.parse(nowIso()),
    );
  });

  test("a run leaves a row another runner claims mid-batch", async () => {
    await stageDue("sq_run_first");
    await stageDue("sq_run_stolen");

    let stolen = false;
    const read = stub(squareApi, "endLink", async () => {
      if (!stolen) {
        stolen = true;
        // While this row is being asked, another runner claims every other
        // due row, so this run's own claim on them loses.
        for (const due of await getDueSquareLinkEnds()) {
          if (due.state === "pending") await claimSquareLinkEnd(due);
        }
      }
      return theAnswer(404, `{"errors":[]}`);
    });
    try {
      await runSquareLinkExpiry();
    } finally {
      read.restore();
    }

    // The asked row ended on its 404; the stolen row stays with its runner.
    expect(await storedRow("sq_run_first")).toBeNull();
    expect((await storedRow("sq_run_stolen"))?.state).toBe("ending");
  });
});

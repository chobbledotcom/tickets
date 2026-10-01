/** One expiry run: claim due link ends, ask Square, and move each row by
 * what the answer proved. The queue's own moves live beside the database
 * module; this file owns the run's orchestration around them. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { claimSquareLinkEnd } from "#db/square-link-ends.ts";
import { squareApi } from "#shared/square/api.ts";
import { SQUARE_LINK_EXPIRY_BATCH } from "#shared/square/limits.ts";
import { runSquareLinkExpiry } from "#shared/square/link-expiry-run.ts";
import {
  backdateAttempt,
  dueRows,
  expectBackToQueue,
  stageDue,
  storedRow,
  theAnswer,
} from "#test/shared/square/link-end-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/* jscpd:ignore-end */

describeWithEnv("square link expiry run", { db: true }, () => {
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

  test("a run returns an expired lease to the queue without asking Square", async () => {
    await stageDue("sq_run_lease");
    const [due] = await dueRows();
    await claimSquareLinkEnd(due!);
    // The lease passes without an answer.
    await backdateAttempt("sq_run_lease");

    const read = stub(squareApi, "endLink", () => {
      throw new Error("an expired lease must not reach Square");
    });
    try {
      await runSquareLinkExpiry();
    } finally {
      read.restore();
    }
    expect(read.calls).toHaveLength(0);
    await expectBackToQueue("sq_run_lease");
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
        for (const due of await dueRows()) {
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

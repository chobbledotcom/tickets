/** The durable registration email queue: one row per recipient, claimed with
 * a lease, completed once, retried with the message still sealed. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#db/client.ts";
import {
  claimRegistrationEmail,
  finishRegistrationEmail,
  type PreparedRegistrationEmail,
  queueRegistrationEmails,
} from "#db/registration-email-work.ts";
import type { EmailMessage } from "#shared/email.ts";
import { parseEmail } from "#shared/validation/email.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const message = (to: string): EmailMessage => {
  const parsed = parseEmail(to);
  if (!parsed) throw new Error(`Test address is not valid: ${to}`);
  return {
    html: "<p>Confirmed</p>",
    subject: "Your tickets",
    text: "Confirmed",
    to: parsed,
  };
};

const prepared = (to: string): PreparedRegistrationEmail => ({
  message: message(to),
  recipient: "buyer",
});

const workRow = (id: number) =>
  queryOne<{
    recipient: string;
    state: string;
    sealed: string;
    attempts: number;
  }>(
    "SELECT recipient, state, sealed, attempts FROM registration_email_work WHERE id = ?",
    [id],
  );

describeWithEnv("registration email work", { db: true }, () => {
  test("queues one row per recipient, keyed by the session", async () => {
    const first: PreparedRegistrationEmail[] = [
      prepared("buyer@example.com"),
      { ...prepared("business@example.com"), recipient: "business" },
    ];
    await queueRegistrationEmails("cs_queue", 910_007, first);
    await queueRegistrationEmails("cs_queue", 910_007, first);

    const rows = await queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM registration_email_work WHERE attendee_id = ?",
      [910_007],
    );
    expect(rows?.count).toBe(2);
  });

  test("marks a session with no recipients complete", async () => {
    await queueRegistrationEmails("cs_no_recipients", 910_009, []);

    const row = await queryOne<{ state: string; recipient: string }>(
      "SELECT state, recipient FROM registration_email_work WHERE attendee_id = ?",
      [910_009],
    );
    expect(row).toEqual({ recipient: "none", state: "complete" });
  });
  test("claims a due row and releases nothing else", async () => {
    await queueRegistrationEmails("cs_claim", 910_011, [
      prepared("buyer@example.com"),
    ]);

    const work = await claimRegistrationEmail();
    expect(work?.message.subject).toBe("Your tickets");
    // The lease owns the row: a second claim finds nothing due.
    expect(await claimRegistrationEmail()).toBeNull();
  });

  test("a delivered row drops its message but keeps the marker", async () => {
    await queueRegistrationEmails("cs_delivered", 12, [
      prepared("buyer@example.com"),
    ]);
    const work = await claimRegistrationEmail();

    await finishRegistrationEmail(work!, true);

    const row = await workRow(work!.id);
    expect(row).toEqual({
      attempts: 1,
      recipient: "buyer",
      sealed: "",
      state: "complete",
    });
    // A completed row is never claimed again.
    expect(await claimRegistrationEmail()).toBeNull();
  });

  test("a failed row keeps its sealed message and stays due", async () => {
    await queueRegistrationEmails("cs_retry", 13, [
      prepared("buyer@example.com"),
    ]);
    const work = await claimRegistrationEmail();

    await finishRegistrationEmail(work!, false);

    const row = await workRow(work!.id);
    expect(row?.state).toBe("due");
    expect(row?.sealed).not.toBe("");
    // The retry waits for its backoff; the claim is gone either way.
    expect(
      await queryOne<{ claim_token: string }>(
        "SELECT claim_token FROM registration_email_work WHERE id = ?",
        [work!.id],
      ),
    ).toEqual({ claim_token: "" });
  });

  test("refuses a stored message that decrypts to a bad shape", async () => {
    await queueRegistrationEmails("cs_corrupt", 910_014, [
      prepared("buyer@example.com"),
    ]);
    await execute(
      "UPDATE registration_email_work SET sealed = 'enc:1:bad', wrapped_key = 'wk:1:bad' WHERE attendee_id = ?",
      [910_014],
    );

    await expect(claimRegistrationEmail()).rejects.toThrow();
  });
  test("spends one database call to claim a row", async () => {
    await queueRegistrationEmails("cs_budget", 15, [
      prepared("buyer@example.com"),
    ]);

    const calls = await countDatabaseCalls(1, () => claimRegistrationEmail());

    expect(calls).toBe(1);
  });
});

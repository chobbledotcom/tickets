/** The due-registration-email drain: one claim owns one provider call, an
 * erased attendee receives nothing, and a failed send stays due. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#db/client.ts";
import {
  type PreparedRegistrationEmail,
  queueRegistrationEmails,
} from "#db/registration-email-work.ts";
import { deliverDueRegistrationEmails } from "#shared/email/registration-work.ts";
import type { EmailMessage } from "#shared/email.ts";
import { parseEmail } from "#shared/validation/email.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { useFetchStub } from "#test-utils/mocks.ts";

const message = (to: string): EmailMessage => ({
  html: "<p>Confirmed</p>",
  subject: "Your tickets",
  text: "Confirmed",
  to: parseEmail(to)!,
});

const prepared = (to: string): PreparedRegistrationEmail => ({
  message: message(to),
  recipient: "buyer",
});

describeWithEnv("registration email delivery", { db: true }, () => {
  const fetch = useFetchStub();

  test("delivers a due message through the provider", async () => {
    await configureTestEmail();
    await queueRegistrationEmails("cs_drain_deliver", 910_101, [
      prepared("buyer@example.com"),
    ]);

    const result = await deliverDueRegistrationEmails();

    expect(result).toEqual({ failed: false, more: false });
    expect(fetch.getFetchJsonBody().subject).toBe("Your tickets");
  });

  test("completes a claimed row for an erased attendee without sending", async () => {
    await configureTestEmail();
    await queueRegistrationEmails("cs_drain_erased", 910_102, [
      prepared("buyer@example.com"),
    ]);
    await execute("DELETE FROM attendees WHERE id = 910_102", []);

    const result = await deliverDueRegistrationEmails();

    expect(result).toEqual({ failed: false, more: false });
    // No provider call was made: the erased booking sends no mail.
    expect(fetch.callCount()).toBe(0);
  });

  test("keeps a failed message due and reports the failure", async () => {
    await configureTestEmail();
    await queueRegistrationEmails("cs_drain_fail", 910_103, [
      prepared("buyer@example.com"),
    ]);
    // The provider rejects the send.
    fetch.restubFetch(() => new Response("boom", { status: 500 }));

    const result = await deliverDueRegistrationEmails();

    expect(result.failed).toBe(true);
    // The row stays due with its message, waiting for its retry.
    const row = await queryOne<{ state: string; sealed: string }>(
      "SELECT state, sealed FROM registration_email_work WHERE attendee_id = ?",
      [910_103],
    );
    expect(row?.state).toBe("due");
    expect(row?.sealed).not.toBe("");
  });

  test("claims nothing when no row is due", async () => {
    await configureTestEmail();

    const result = await deliverDueRegistrationEmails();

    expect(result).toEqual({ failed: false, more: false });
    expect(fetch.callCount()).toBe(0);
  });
});

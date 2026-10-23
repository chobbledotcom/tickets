import { assertExists, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#db/client.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { questionsTable } from "#db/questions/tables.ts";
import {
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import { logAndNotifyRegistration } from "#shared/webhook/delivery.ts";
import {
  expectOneError,
  stubWebhookFetch,
  withErrorSpy,
} from "#test/shared/webhook/helpers.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendeeWithFlags } from "#test-utils/db-helpers/attendees.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

describeWithEnv("registration delivery flags", { db: true }, () => {
  const fetchSpy = stubWebhookFetch();

  /** Reads one attendee's pending flags and the delivery-failure activity
   * lines back, and asserts both. */
  const expectFlagsAndActivity = async (
    attendeeId: number,
    flags: { email_pending: number; webhooks_pending: number },
    failureLines: number,
  ): Promise<void> => {
    const row = await queryOne<{
      email_pending: number;
      webhooks_pending: number;
    }>("SELECT email_pending, webhooks_pending FROM attendees WHERE id = ?", [
      attendeeId,
    ]);
    expect(row).toEqual(flags);
    expect(
      (await activityMessages()).filter(
        (message) => message === "Registration notification delivery failed.",
      ),
    ).toHaveLength(failureLines);
  };

  /** Runs one owning send inside the error spy, and asserts its one
   * delivery error and the attendee's raised flags with no activity. */
  const expectSendLeavesFlags = async (
    attendeeId: number,
    send: () => Promise<void>,
  ): Promise<void> => {
    const logs = await withErrorSpy(async (errorSpy) => {
      await send();
      return errorSpy.calls.map(({ args }) => String(args[0]));
    });
    expectOneError(logs, "E_REGISTRATION_DELIVERY");
    await expectFlagsAndActivity(
      attendeeId,
      { email_pending: 1, webhooks_pending: 1 },
      0,
    );
  };

  test("logs a failed pending-flag settle batch locally", async () => {
    // The accepted send earned a flag clear, but the batch died one database
    // call. Starving the budget one call short makes the batch fail: the
    // failure reaches the log, and the accepted send's report is not
    // masked.
    await configureTestEmail();
    const { attendee } = await bookTestAttendeeWithFlags("Starved Buyer", 1, 1);
    const entries = [
      makeEntry(
        { id: attendee.listing_id, webhook_url: "" },
        {
          email: attendee.email,
          id: attendee.id,
        },
      ),
    ];
    const send = () =>
      withRequestContext(() =>
        logAndNotifyRegistration(entries, {
          clearPendingFlagsFor: [attendee.id],
          source: "public",
        }),
      );
    const calls = await countDatabaseCalls(50, send);
    // The measuring run cleared the email flag; raise it again so the
    // starved rerun shows a failed clear leaving the flag up.
    await execute("UPDATE attendees SET email_pending = 1 WHERE id = ?", [
      attendee.id,
    ]);
    const logs = await withErrorSpy(async (errorSpy) => {
      await runWithSubrequestBudget(() =>
        withSubrequestAllowance(
          { database: calls - 1, external: 20, total: 40 },
          send,
        ),
      );
      return errorSpy.calls.map(({ args }) => String(args[0]));
    });

    const message = expectOneError(logs, "E_DB_QUERY");
    assertExists(message);
    assertStringIncludes(message, "The pending-flag settle batch failed");
    // The failed settle batch leaves both flags up, and no failure activity
    // is written for a failure the raised flags represent.
    await expectFlagsAndActivity(
      attendee.id,
      { email_pending: 1, webhooks_pending: 1 },
      0,
    );
  });

  test("a rejected send with owned flags reports but writes no failure line", async () => {
    // The booking's sends own the attendee's pending flags. The webhook is
    // refused, so the flag must stay up for the admin, the unexpected
    // rejection must still reach the log and alert, and no failure activity
    // line is written — the flags carry the failure instead.
    await configureTestEmail();
    const { attendee } = await bookTestAttendeeWithFlags("Flagged Buyer", 1, 1);
    fetchSpy.reply(() => Promise.reject(new Error("private failure detail")));

    await expectSendLeavesFlags(attendee.id, () =>
      withRequestContext(() =>
        logAndNotifyRegistration(
          [
            makeEntry(
              { webhook_url: "https://refused-hook.example.com" },
              { email: attendee.email, id: attendee.id },
            ),
          ],
          { clearPendingFlagsFor: [attendee.id], source: "public" },
        ),
      ),
    );
  });

  test("a send that dies before its deliveries keeps both flags up", async () => {
    // The email send's answer-lines read dies before any delivery was
    // attempted: no side's outcome is known. Both flags stay up for the
    // admin, the error reports, and no failure activity is written.
    await configureTestEmail();
    const { attendee, listing } = await bookTestAttendeeWithFlags(
      "Early Death Buyer",
      1,
      1,
    );
    // The listing carries a question, so the answer-lines read is a real
    // database call the budget can starve.
    const question = await questionsTable.insert({
      displayType: "radio",
      text: "Meal?",
    });
    await listingQuestions.setIds(listing.id, [question.id]);

    await expectSendLeavesFlags(attendee.id, () =>
      runWithSubrequestBudget(() =>
        withSubrequestAllowance(
          // One database call for the registration activity line; the send's
          // answer-lines read is the call that dies.
          { database: 1, external: 20, total: 20 },
          () =>
            withRequestContext(() =>
              logAndNotifyRegistration(
                [
                  makeEntry(
                    { webhook_url: "" },
                    { email: attendee.email, id: attendee.id },
                  ),
                ],
                { clearPendingFlagsFor: [attendee.id], source: "public" },
              ),
            ),
        ),
      ),
    );
  });

  test("an owner-only copy never clears the buyer's email flag", async () => {
    // The attendee carries no address, so the send delivers the owner's
    // admin copy alone. The owner's copy is accepted, but it is not the
    // buyer's confirmation: the flag that says the buyer's confirmation is
    // owed stays up, so adding the missing address later restores the
    // warning. The webhook send was attempted and accepted, so its flag
    // clears.
    await configureTestEmail({ businessEmail: "owner@example.com" });
    const { attendee } = await bookTestAttendeeWithFlags(
      "No Address Buyer",
      1,
      1,
    );
    fetchSpy.reply(() => new Response("{}"));

    await withRequestContext(() =>
      logAndNotifyRegistration(
        [
          makeEntry(
            { webhook_url: "https://owner-only-hook.example.com" },
            { email: "", id: attendee.id },
          ),
        ],
        { clearPendingFlagsFor: [attendee.id], source: "public" },
      ),
    );

    await expectFlagsAndActivity(
      attendee.id,
      { email_pending: 1, webhooks_pending: 0 },
      0,
    );
  });
});

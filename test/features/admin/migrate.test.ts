import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch } from "#db/client.ts";
import { countLegacyPaymentReferences } from "#db/payment-reference-rebuild.ts";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import {
  assertAdminHtml,
  expectFlashRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookLegacyPaidAttendee } from "#test-utils/historical-payment-references.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

const REBUILD_PATH = "/admin/migrate/rebuild-payment-references";

const postRebuild = async (fields: Record<string, string>): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      REBUILD_PATH,
      { csrf_token: await testCsrfToken(), ...fields },
      await testCookie(),
    ),
  );

/** Rebuildable rows cloned into a same-shape batch, so a run over one page
 * size leaves work behind. */
const cloneRebuildableRows = async (
  fromSessionId: string,
  clones: number,
): Promise<void> => {
  const sessionIds = Array.from(
    { length: clones },
    (_, index) => `sess_clone_${index + 1}`,
  );
  await executeBatch(
    sessionIds.map((sessionId) => ({
      args: [sessionId, fromSessionId],
      sql: `INSERT INTO processed_payments
              (payment_session_id, attendee_id, processed_at,
               payment_reference, payment_reference_index)
            SELECT ?, attendee_id, processed_at,
                   payment_reference, payment_reference_index
              FROM processed_payments
             WHERE payment_session_id = ?`,
    })),
  );
};

describeWithEnv("server (admin migrate rebuild)", { db: true }, () => {
  testRequiresAuth(REBUILD_PATH);

  test("the page names the waiting records and offers the rebuild", async () => {
    await bookLegacyPaidAttendee("sess_route_waiting", "pi_route_waiting");
    await assertAdminHtml(
      REBUILD_PATH,
      "There is 1 payment record to rebuild.",
      "Which provider took these payments?",
      'action="/admin/migrate/rebuild-payment-references"',
      "Rebuild payment records",
    );
  });

  test("the page offers no form when nothing waits", async () => {
    await assertAdminHtml(
      REBUILD_PATH,
      "There are no payment records to rebuild.",
      "Payments this page cannot rebuild still exist.",
    );
  });

  test("a submit without a provider is refused", async () => {
    await bookLegacyPaidAttendee("sess_route_noprov", "pi_route_noprov");
    await expectFlashRedirect(
      REBUILD_PATH,
      t("migrate.rebuild.error_provider"),
      false,
    )(await postRebuild({ confirm_identifier: "Stripe" }));
  });

  test("a confirmation that does not name the provider is refused", async () => {
    await bookLegacyPaidAttendee("sess_route_mismatch", "pi_route_mismatch");
    await expectFlashRedirect(
      REBUILD_PATH,
      "Provider does not match. Please type the exact provider to confirm.",
      false,
    )(
      await postRebuild({
        confirm_identifier: "square",
        provider: "stripe",
      }),
    );
  });

  test("a rebuild within one page reports the finished run", async () => {
    await bookLegacyPaidAttendee("sess_route_done", "pi_route_done");
    await expectFlashRedirect(
      REBUILD_PATH,
      t("migrate.rebuild.flash_done", { count: 1 }),
    )(
      await postRebuild({
        confirm_identifier: "Stripe",
        provider: "stripe",
      }),
    );
    expect(await countLegacyPaymentReferences()).toBe(0);
  });

  test("a rebuild longer than one page asks to be run again", async () => {
    await bookLegacyPaidAttendee("sess_route_progress", "pi_route_progress");
    await cloneRebuildableRows("sess_route_progress", 51);

    await expectFlashRedirect(
      REBUILD_PATH,
      t("migrate.rebuild.flash_progress", { rebuilt: 50, remaining: 2 }),
    )(
      await postRebuild({
        confirm_identifier: "Stripe",
        provider: "stripe",
      }),
    );
    expect(await countLegacyPaymentReferences()).toBe(2);

    await expectFlashRedirect(
      REBUILD_PATH,
      t("migrate.rebuild.flash_done", { count: 2 }),
    )(
      await postRebuild({
        confirm_identifier: "Stripe",
        provider: "stripe",
      }),
    );
    expect(await countLegacyPaymentReferences()).toBe(0);
  });
});

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, executeBatch } from "#db/client.ts";
import {
  countLegacyPaymentReferences,
  legacyPaymentReferencePage,
} from "#db/payment-reference-rebuild.ts";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import {
  assertAdminHtml,
  expectFlashRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { bookLegacyPaidAttendee } from "#test-utils/historical-payment-references.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
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

/** The form a run over the current page would post: a stated provider and the
 * matching count, read from the page itself so the test does not restate the
 * order the run happens to take. */
const runFields = async (
  providers: Readonly<Record<string, string>> = {},
): Promise<Record<string, string>> => {
  const page = await legacyPaymentReferencePage(await getTestPrivateKey());
  const untagged = page.filter((row) => !row.alreadyTagged);
  return {
    confirm_identifier: String(untagged.length),
    ...Object.fromEntries(
      untagged.map((row) => [
        `provider_${row.paymentSessionId}`,
        providers[row.reference] ?? "stripe",
      ]),
    ),
  };
};

describeWithEnv("server (admin migrate rebuild)", { db: true }, () => {
  testRequiresAuth(REBUILD_PATH);

  test("the page lists the waiting records and asks for a provider each", async () => {
    await bookLegacyPaidAttendee("sess_route_waiting", "pi_route_waiting");
    await assertAdminHtml(
      REBUILD_PATH,
      "There is 1 payment record to rebuild.",
      "pi_route_waiting",
      'name="provider_sess_route_waiting"',
      "Type 1 to confirm how many records this run will rebuild:",
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

  test("a submit without a provider for a listed record is refused", async () => {
    await bookLegacyPaidAttendee("sess_route_noprov", "pi_route_noprov");
    await expectFlashRedirect(
      REBUILD_PATH,
      t("migrate.rebuild.error_provider"),
      false,
    )(
      await postRebuild({
        ...(await runFields()),
        provider_sess_route_noprov: "",
      }),
    );
  });

  test("a confirmation that does not count the records is refused", async () => {
    await bookLegacyPaidAttendee("sess_route_mismatch", "pi_route_mismatch");
    await expectFlashRedirect(
      REBUILD_PATH,
      "Record count does not match. Please type the exact record count to confirm.",
      false,
    )(
      await postRebuild({
        confirm_identifier: "7",
        provider_sess_route_mismatch: "stripe",
      }),
    );
  });

  test("a rebuild within one page reports the finished run", async () => {
    await bookLegacyPaidAttendee("sess_route_done", "pi_route_done");
    await expectFlashRedirect(
      REBUILD_PATH,
      t("migrate.rebuild.flash_done", { count: 1, unqualifiedAttendees: 0 }),
    )(await postRebuild(await runFields()));
    expect(await countLegacyPaymentReferences()).toBe(0);
  });

  test("each listed record takes the provider the owner chose", async () => {
    await bookLegacyPaidAttendee("sess_route_stripe", "pi_route_stripe");
    await bookLegacyPaidAttendee("sess_route_square", "pi_route_square");
    await expectFlashRedirect(
      REBUILD_PATH,
      t("migrate.rebuild.flash_done", { count: 2, unqualifiedAttendees: 0 }),
    )(await postRebuild(await runFields({ pi_route_square: "square" })));
    expect(await countLegacyPaymentReferences()).toBe(0);
  });

  test("a record that already names its provider needs no choice", async () => {
    const listing = await createTestListing();
    const tagged = bookedAttendee(
      await bookAttendee(listing, {
        email: "route-kept-tag@example.com",
        name: "Route Kept Tag",
        paymentId: "pi_route_kept_tag",
      }),
    );
    await finalizeProcessedPayment("sess_route_kept_tag", tagged.id, "", {
      kind: "tagged",
      provider: "square",
      reference: "pi_route_kept_tag",
    });
    await execute(
      "UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ?",
      ["sess_route_kept_tag"],
    );
    await assertAdminHtml(
      REBUILD_PATH,
      t("migrate.rebuild.already_tagged"),
      "Type 0 to confirm how many records this run will rebuild:",
    );

    await expectFlashRedirect(
      REBUILD_PATH,
      t("migrate.rebuild.flash_done", { count: 1, unqualifiedAttendees: 0 }),
    )(await postRebuild({ ...(await runFields()), confirm_identifier: "0" }));
    expect(await countLegacyPaymentReferences()).toBe(0);
  });

  test("a rebuild longer than one page asks to be run again", async () => {
    await bookLegacyPaidAttendee("sess_route_progress", "pi_route_progress");
    await cloneRebuildableRows("sess_route_progress", 51);

    await expectFlashRedirect(
      REBUILD_PATH,
      t("migrate.rebuild.flash_progress", {
        rebuilt: 50,
        remaining: 2,
        unqualifiedAttendees: 0,
      }),
    )(await postRebuild(await runFields()));
    expect(await countLegacyPaymentReferences()).toBe(2);

    await expectFlashRedirect(
      REBUILD_PATH,
      t("migrate.rebuild.flash_done", { count: 2, unqualifiedAttendees: 0 }),
    )(await postRebuild(await runFields()));
    expect(await countLegacyPaymentReferences()).toBe(0);
  });
});

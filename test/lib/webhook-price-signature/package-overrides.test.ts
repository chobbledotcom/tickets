import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import { groupsTable, setGroupPackageMembers } from "#shared/db/groups.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { isSessionProcessed } from "#shared/db/processed-payments.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  assertJson,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  setupStripe,
  signMeta,
  webhookMeta,
} from "#test-utils";
import {
  expectPackageRefund,
  expectProcessed,
  expectStoredRefund,
  packageMetadata,
  runFailedRefund,
  runWebhook,
  setupPackage,
  setupWithListing,
  webhookRequest,
} from "./helpers.ts";

describeWithEnv(
  "webhook signed price oracle — mismatch & package overrides",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("a mismatch whose refund reports failure but already settled is acknowledged", async () => {
      const listing = await setupWithListing();
      // The refund call returns null (e.g. the provider rejected a second full
      // refund), but the payment IS already fully refunded. That is success, not a
      // 503 retry loop: acknowledge and record the terminal outcome.
      await runFailedRefund(
        "cs_already_refunded",
        true,
        listing.id,
        async (refund) => {
          await assertJson(webhookRequest(), 200, (json) => {
            expect(json.processed).toBe(false);
          });
          expect(refund.calls.length).toBe(1);
          // Recorded as a terminal failure (refund settled), so a later delivery
          // replays it instead of retrying.
          const record = await isSessionProcessed("cs_already_refunded");
          expect(record?.failure_data).not.toBe("");
        },
      );
    });

    // ---- package pricing revalidation -----------------------------------------

    test("a package booking is priced against the override, not the base price", async () => {
      const { group, listing } = await setupPackage();
      // Signed at the override (1500), not the 5000 base — only the package path
      // makes this validate; the base-price check would refund it.
      await runWebhook(
        {
          amount_total: 1500,
          id: "cs_pkg_ok",
          metadata: packageMetadata(group.id, listing.id, 1500),
        },
        () => expectProcessed(listing.id),
      );
    });

    test("an explicit-free package member (override 0) completes at £0", async () => {
      const { group, listing } = await setupPackage();
      // Override the member to free (0) — distinct from "no override", which would
      // re-price at the 5000 base and refund a £0 booking. The signed £0 line must
      // be honoured.
      await setGroupPackageMembers(group.id, [
        { listingId: listing.id, price: 0 },
      ]);
      await runWebhook(
        {
          amount_total: 0,
          id: "cs_pkg_free_ov",
          metadata: packageMetadata(group.id, listing.id, 0),
        },
        () => expectProcessed(listing.id),
      );
    });

    test("a no-override package member refunds a £0 booking (charges its base)", async () => {
      const { group, listing } = await setupPackage();
      // No override (null) → the member keeps its 5000 base, so a signed £0 line
      // no longer matches and must take the price_changed refund path.
      await setGroupPackageMembers(group.id, [
        { listingId: listing.id, price: null },
      ]);
      await expectPackageRefund(
        "cs_pkg_no_ov",
        listing.id,
        packageMetadata(group.id, listing.id, 0),
      );
    });

    test("a package booking refunds when the override changed after checkout", async () => {
      const { group, listing } = await setupPackage();
      const metadata = packageMetadata(group.id, listing.id, 1500);
      // Operator raises the override after the buyer signed at 1500.
      await setGroupPackageMembers(group.id, [
        { listingId: listing.id, price: 2000 },
      ]);
      await expectPackageRefund("cs_pkg_changed", listing.id, metadata);
    });

    /** A customisable one-member package: the member's own day prices are
     * 1:700/2:1200 with a per-day PACKAGE override of 1000 for the 2-day span. */
    const setupCustomisablePackage = async () => {
      await setupStripe();
      const group = await createTestGroup({
        isPackage: true,
        name: "Flex Pkg",
        slug: "flex-pkg",
      });
      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 700, 2: 1200 },
        durationDays: 2,
        groupId: group.id,
        listingType: "daily",
        maxAttendees: 50,
        minimumDaysBefore: 0,
        unitPrice: 700,
      });
      await setGroupPackageMembers(group.id, [
        { dayPrices: { 2: 1000 }, listingId: listing.id, price: null },
      ]);
      return { group, listing };
    };

    /** Signed metadata for a 2-day customisable package line at `price`. */
    const customisableMetadata = async (
      groupId: number,
      listingId: number,
      price: number,
    ) => {
      const { addDays } = await import("#shared/dates.ts");
      const { todayInTz } = await import("#shared/timezone.ts");
      return signMeta(
        webhookMeta({
          date: addDays(todayInTz("UTC"), 2),
          day_count: "2",
          email: "buyer@example.com",
          items: JSON.stringify([
            { e: listingId, k: "p", p: price, q: 1, r: groupId },
          ]),
          name: "Buyer",
        }),
        price,
      );
    };

    test("a customisable package's webhook accepts the signed per-day override price", async () => {
      // The webhook is the authoritative money path (the buyer may never hit the
      // redirect), so day-count revalidation must run here too: the 2-day span is
      // package-overridden to 1000, and a session signed at 1000 books.
      const { group, listing } = await setupCustomisablePackage();
      await runWebhook(
        {
          amount_total: 1000,
          id: "cs_pkg_flex_wh_ok",
          metadata: await customisableMetadata(group.id, listing.id, 1000),
        },
        () => expectProcessed(listing.id),
      );
    });

    test("a customisable package's webhook refunds when the per-day override changed after checkout", async () => {
      const { group, listing } = await setupCustomisablePackage();
      const metadata = await customisableMetadata(group.id, listing.id, 1000);
      // Operator reprices the 2-day span after the buyer signed at 1000.
      await setGroupPackageMembers(group.id, [
        { dayPrices: { 2: 1600 }, listingId: listing.id, price: null },
      ]);
      await runWebhook(
        { amount_total: 1000, id: "cs_pkg_flex_wh_drift", metadata },
        async (refund) => {
          await expectStoredRefund(listing.id);
          expect(refund.calls.length).toBe(1);
        },
      );
    });

    test("a package booking refunds when the group is no longer a package", async () => {
      const { group, listing } = await setupPackage();
      const metadata = packageMetadata(group.id, listing.id, 1500);
      // The package flag is cleared, so the member revalidates at its 5000 base
      // price and the 1500 the buyer signed no longer matches.
      await groupsTable.update(group.id, { isPackage: false });
      await expectPackageRefund("cs_pkg_unflagged", listing.id, metadata);
    });

    test("a package booking refunds when a member was added after checkout", async () => {
      const { group, listing } = await setupPackage();
      const metadata = packageMetadata(group.id, listing.id, 1500);
      // A second member joins the bundle after the buyer signed a one-line order,
      // so the signed lines no longer represent the whole package.
      const added = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        unitPrice: 1000,
      });
      await setGroupPackageMembers(group.id, [
        { listingId: listing.id, price: 1500 },
        { listingId: added.id, price: 1000 },
      ]);
      await expectPackageRefund("cs_pkg_member_added", listing.id, metadata);
    });

    test("a package booking refunds when a free member's override turns paid mid-payment", async () => {
      await setupStripe();
      const group = await createTestGroup({
        isPackage: true,
        name: "FreePkg",
        slug: "free-pkg",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        unitPrice: 0,
      });
      // The member is free at checkout (override 0), so its signed line price is 0.
      await setGroupPackageMembers(group.id, [
        { listingId: listing.id, price: 0 },
      ]);
      // An opt-in add-on keeps the order PAID even though every package line is
      // free — this is the case the old `hasPaidItems` guard skipped.
      const addOn = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 500,
        direction: "charge",
        name: "Add-on",
      });
      await execute("UPDATE modifiers SET trigger = ? WHERE id = ?", [
        "optional",
        addOn.id,
      ]);
      const metadata = signMeta(
        webhookMeta({
          email: "buyer@example.com",
          items: JSON.stringify([
            { e: listing.id, k: "p", p: 0, q: 1, r: group.id },
          ]),
          modifiers: JSON.stringify([{ i: addOn.id, q: 1 }]),
          name: "Buyer",
        }),
        500,
      );
      // Operator raises the override from 0 to a positive value while the payment
      // is in flight; the signed zero line must no longer be honoured.
      await setGroupPackageMembers(group.id, [
        { listingId: listing.id, price: 1500 },
      ]);
      await runWebhook(
        { amount_total: 500, id: "cs_pkg_free_drift", metadata },
        async (refund) => {
          await expectStoredRefund(listing.id);
          expect(refund.calls.length).toBe(1);
        },
      );
    });
  },
);

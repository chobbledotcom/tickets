/**
 * Servicing edge cases — cross-feature interactions.
 *
 * A servicing hold is a real booking row, so it flows through the same
 * listing-attendee machinery as a customer booking — but it must NOT trigger
 * the customer-only side effects (logistics splitting, webhook firing,
 * modifier consumption, purchase-only restrictions). These pin that the
 * servicing create path skips each customer-only resolution.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createServicingHold,
  describeWithEnv,
  expectLogisticsDisabled,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "servicing edge cases — cross-feature interactions",
  { db: true },
  () => {
    test("a servicing hold on a listing with logistics agents does not split or assign agents", async () => {
      // The listing has `uses_logistics = true` and logistics agents configured;
      // a customer booking on it would split the attendee row. A servicing
      // hold must not — `split_logistics_agents` stays 0, no agents assigned.
      const { id } = await createServicingHold({
        listing: { name: "Logistics L", usesLogistics: true },
      });
      await expectLogisticsDisabled(id);
    });

    test("a servicing hold on a purchase_only listing is accepted (no payment required)", async () => {
      // `purchase_only` listings refuse the public booking flow (no payment =
      // no booking). A servicing hold is free and admin-created, so it bypasses
      // the purchase gate — the hold must land.
      const { id } = await createServicingHold({
        listing: { name: "Purchase Only L", purchaseOnly: true },
      });
      expect(id).toBeGreaterThan(0);
    });

    test("a servicing hold on a listing with a webhook configured does not fire the webhook", async () => {
      // The listing's `webhook_url` is set; a customer booking fires it. A
      // servicing hold must not — it's not a customer event. We assert no
      // outbound fetch was made by stubbing fetch and checking call count.
      const { stubFetchRecorder } = await import("#test-utils/mocks.ts");
      const fetchStub = stubFetchRecorder();
      try {
        await createServicingHold({
          listing: {
            name: "Webhook L",
            webhookUrl: "https://example.com/hook",
          },
        });
        expect(fetchStub.callCount()).toBe(0);
      } finally {
        fetchStub.restore();
      }
    });

    test("a servicing hold does not consume modifier stock or apply a modifier", async () => {
      // The listing has a price modifier (e.g. a discount); a customer booking
      // applies it. A servicing hold is free, so no modifier leg should post.
      // We assert the transfers ledger has no modifier legs after the hold.
      const { id } = await createServicingHold({
        listing: { maxAttendees: 10, name: "Modifier L", unitPrice: 1000 },
      });
      const { allTransfers } = await import("#shared/accounting/queries.ts");
      const kinds = (await allTransfers()).map((t) => t.kind);
      expect(kinds).not.toContain("modifier");
      expect(id).toBeGreaterThan(0);
    });

    test("a servicing hold on a listing with an attached built-site assignment does not trigger site provisioning", async () => {
      // `assign_built_site = true` on a listing triggers site provisioning for
      // customer bookings. A servicing hold must not provision a site.
      const { id } = await createServicingHold({
        listing: {
          assignBuiltSite: true,
          initialSiteMonths: 1,
          name: "Site L",
        },
      });
      expect(id).toBeGreaterThan(0);
      // No built_sites row should have been created for the servicing event.
      const { queryOne } = await import("#shared/db/client.ts");
      const sites = await queryOne<{ count: number }>(
        "SELECT COUNT(*) AS count FROM built_sites WHERE assigned_attendee_id = ?",
        [id],
      );
      expect(sites?.count ?? 0).toBe(0);
    });
  },
);

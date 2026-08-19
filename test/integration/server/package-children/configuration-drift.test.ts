import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { listingChildren } from "#db/listing-parents.ts";
import { handleRequest } from "#routes";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signMeta } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";
import {
  bookingRows,
  packageChildSession,
  packageWithChild,
} from "./helpers.ts";

describeWithEnv("package child configuration drift", { db: true }, () => {
  test("a child edge removed mid-checkout refunds instead of booking a stale bundle", async () => {
    await setupStripe();
    const { child, group, other, parent } = await packageWithChild(
      "Drift Kit",
      "drift-kit-pkg",
    );
    using mockRefund = stubRefundPayment("re_drift", 1800);
    using _retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve(
        packageChildSession(
          {
            child: child.id,
            group: group.id,
            other: other.id,
            parent: parent.id,
          },
          "cs_pkg_child_drift",
          "pi_pkg_child_drift",
        ),
      ),
    );

    await listingChildren.setIds(parent.id, []);
    const response = await handleRequest(
      mockRequest("/payment/success?session_id=cs_pkg_child_drift"),
    );
    await response.body?.cancel();
    expect(mockRefund.calls.length).toBe(1);
    expect(await bookingRows(child.id)).toHaveLength(0);
    expect(await bookingRows(parent.id)).toHaveLength(0);
  });

  test("a child edge added mid-checkout refunds instead of booking without the add-on", async () => {
    await setupStripe();
    const group = await createTestGroup({ isPackage: true, name: "Grown Kit" });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "Grown Member",
      unitPrice: 1000,
    });
    const addon = await createTestListing({
      maxAttendees: 10,
      name: "Grown Addon",
      unitPrice: 300,
    });
    using mockRefund = stubRefundPayment("re_grown", 1000);
    using _retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        currency: "gbp",
        id: "cs_pkg_grown",
        metadata: signMeta(
          {
            email: "grown@example.com",
            items: JSON.stringify([
              { e: member.id, k: "p", p: 1000, q: 1, r: group.id },
            ]),
            name: "Grown Buyer",
          },
          1000,
        ),
        payment_intent: "pi_pkg_grown",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    await listingChildren.setIds(member.id, [addon.id]);
    const response = await handleRequest(
      mockRequest("/payment/success?session_id=cs_pkg_grown"),
    );
    await response.body?.cancel();
    expect(mockRefund.calls.length).toBe(1);
    expect(await bookingRows(member.id)).toHaveLength(0);
    expect(await bookingRows(addon.id)).toHaveLength(0);
  });
});

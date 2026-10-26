import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groups } from "#db/groups.ts";
import {
  apiBookPackage,
  describePackageBooking,
  fixedPackage,
  twoChildAddons,
} from "#test/features/api/packages/helpers.ts";

describePackageBooking(() => {
  test("POST creates a paid checkout carrying the package id; a hidden package's items keep its name", async () => {
    const { setupStripe } = await import("#test-utils/settings.ts");
    const { stub } = await import("@std/testing/mock");
    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    await setupStripe();

    const { group } = await fixedPackage("Paid Kit", "paid-kit");
    const hidden = await fixedPackage("Secret Kit", "secret-kit");
    const { child } = await twoChildAddons(hidden.a, "Secret Kit");
    await groups.table.update(hidden.group.id, { hidePackageListings: true });

    const intents: import("#shared/payments.ts").CheckoutIntent[] = [];
    const mockCreate = stub(
      stripePaymentProvider,
      "createCheckoutSession",
      (intent: import("#shared/payments.ts").CheckoutIntent) => {
        intents.push(intent);
        return Promise.resolve({
          checkoutUrl: "https://stripe.test/checkout",
          sessionId: `cs_pkg_${intents.length}`,
        });
      },
    );

    try {
      const visible = await apiBookPackage(group.slug, { quantity: 1 });
      expect(visible.response.status).toBe(200);
      assertStringIncludes(
        visible.body.booking!.checkoutUrl ?? "",
        "stripe.test",
      );
      // The package id rides per line now: every member item carries it.
      expect(intents[0]!.items.map((i) => i.packageGroupId)).toEqual([
        group.id,
        group.id,
      ]);
      expect(intents[0]!.items.map((i) => i.name)).toEqual([
        "Paid Kit A",
        "Paid Kit B",
      ]);

      const concealed = await apiBookPackage(hidden.group.slug, {
        children: [{ parent: hidden.a.slug, quantity: 2, slug: child.slug }],
        quantity: 1,
      });
      expect(concealed.response.status).toBe(200);
      // A hidden package's hosted checkout must never name its members.
      expect(intents[1]!.items.map((i) => i.name)).toEqual([
        "Secret Kit",
        "Secret Kit",
        "Secret Kit",
      ]);
    } finally {
      mockCreate.restore();
    }
  });
});

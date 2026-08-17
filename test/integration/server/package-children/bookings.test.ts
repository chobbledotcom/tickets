import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { stripeApi } from "#shared/stripe.ts";
import { expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  expectPackageBookingAccepted,
  submitPackageBooking,
} from "#test-utils/packages.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  bookingRows,
  expectChildBookedUnder,
  makePackageFree,
  packageChildSession,
  packageWithChild,
} from "./helpers.ts";

describeWithEnv("package child bookings", { db: true }, () => {
  test("a free package booking folds the chosen child under its member", async () => {
    const { child, group, other, parent } = await packageWithChild(
      "Free Kit",
      "free-kit-pkg",
    );
    await makePackageFree(group.id, [parent.id, other.id], [child.id]);

    const submit = await submitPackageBooking(group.slug, {
      [`child_qty_${parent.id}_${child.id}`]: "1",
      email: "kids@test.com",
      name: "Kit Buyer",
      [`package_quantity_${group.id}`]: "1",
    });
    await expectPackageBookingAccepted(submit);

    for (const member of [parent, other]) {
      const rows = await bookingRows(member.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.quantity).toBe(1);
      expect(Number(rows[0]!.package_group_id)).toBe(group.id);
    }
    await expectChildBookedUnder(child.id, parent.id);
  });

  test("a paid package books the folded child on the signed allocation", async () => {
    await setupStripe();
    const { child, group, other, parent } = await packageWithChild(
      "Paid Kit",
      "paid-kit-pkg",
    );
    using _retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve(
        packageChildSession(
          {
            child: child.id,
            group: group.id,
            other: other.id,
            parent: parent.id,
          },
          "cs_pkg_child_paid",
          "pi_pkg_child_paid",
        ),
      ),
    );

    const redirectResponse = await handleRequest(
      mockRequest("/payment/success?session_id=cs_pkg_child_paid"),
    );
    expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);
    await expectChildBookedUnder(child.id, parent.id);
  });
});

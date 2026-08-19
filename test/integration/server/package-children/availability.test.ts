import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  expectPackageBookingAccepted,
  submitPackageBooking,
} from "#test-utils/packages.ts";
import {
  bookingRows,
  capAddonsAtThree,
  makePackageFree,
  packageWithChild,
} from "./helpers.ts";

describeWithEnv("package child availability", { db: true }, () => {
  test("the package page renders the member's child selectors", async () => {
    const { child, childB, group, parent } = await packageWithChild(
      "Kit",
      "kit-child-pkg",
    );
    const body = await (
      await handleRequest(mockRequest(`/ticket/${group.slug}`))
    ).text();
    expect(body).toContain(`name="child_qty_${parent.id}_${child.id}"`);
    expect(body).toContain(`name="child_qty_${parent.id}_${childB.id}"`);
    expect(body).toContain("Kit Addon");
    expect(body).toContain(`name="package_quantity_${group.id}"`);
    expect(body).toContain(`data-parent-id="${parent.id}"`);
    expect(body).toMatch(
      new RegExp(`data-package-members="[^"]*${parent.id}:1`),
    );
  });

  test("the package selector is capped by a member's child capacity", async () => {
    const { child, childB, group } = await packageWithChild(
      "Capped",
      "capped-child-pkg",
    );
    await capAddonsAtThree(child.id, childB.id);

    const body = await (
      await handleRequest(mockRequest(`/ticket/${group.slug}`))
    ).text();
    expect(body).toContain('<option value="3">3</option>');
    expect(body).not.toContain('<option value="4">4</option>');
  });

  test("a crafted POST is clamped to the child-capped bundle ceiling", async () => {
    const { child, childB, group, other, parent } = await packageWithChild(
      "Clamp",
      "clamp-pkg",
    );
    await capAddonsAtThree(child.id, childB.id);
    await makePackageFree(
      group.id,
      [parent.id, other.id],
      [child.id, childB.id],
    );

    const submit = await submitPackageBooking(group.slug, {
      [`child_qty_${parent.id}_${child.id}`]: "2",
      [`child_qty_${parent.id}_${childB.id}`]: "1",
      email: "clamp@test.com",
      name: "Clamp Buyer",
      [`package_quantity_${group.id}`]: "9",
    });
    await expectPackageBookingAccepted(submit);
    expect((await bookingRows(parent.id))[0]!.quantity).toBe(3);
    expect((await bookingRows(other.id))[0]!.quantity).toBe(3);
  });

  test("a package whose required add-ons are exhausted is gated off entirely", async () => {
    const { child, childB, group } = await packageWithChild(
      "Gone Addons",
      "gone-addons-pkg",
    );
    const { listingsTable } = await import("#db/listings/records.ts");
    const { attendeesApi } = await import("#db/attendees/api.ts");
    for (const childListing of [child, childB]) {
      await listingsTable.update(childListing.id, {
        maxAttendees: 1,
        maxQuantity: 1,
      });
      const fill = await attendeesApi.createAttendeeAtomic({
        bookings: [
          {
            date: null,
            listingId: childListing.id,
            quantity: 1,
          },
        ],
        email: "filler@test.com",
        name: "Filler",
      });
      if (!fill.success) throw new Error("fill booking failed");
    }

    const page = await handleRequest(mockRequest(`/ticket/${group.slug}`));
    await page.body?.cancel();
    expect(page.status).toBe(404);
  });

  test("/calculate prices member lines × package count and the child mix exactly once", async () => {
    const { postCalculate } = await import("#test-utils/parents.ts");
    const { child, childB, group, parent } = await packageWithChild(
      "Priced Kit",
      "priced-kit-pkg",
    );
    const fragment = await postCalculate(group.slug, {
      [`child_qty_${parent.id}_${child.id}`]: "1",
      [`child_qty_${parent.id}_${childB.id}`]: "1",
      [`package_quantity_${group.id}`]: "2",
    });
    expect(fragment).toContain("£37");
  });
});

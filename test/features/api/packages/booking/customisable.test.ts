import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  apiBookPackage,
  bookingRows,
  customisablePackage,
  describePackageBooking,
} from "#test/features/api/packages/helpers.ts";
import { apiGet } from "#test-utils/parents.ts";

describePackageBooking(() => {
  test("POST requires a valid date for a dated bundle and a day count for a customisable one", async () => {
    const { group } = await customisablePackage("Gate Kit", "gate-kit");
    const noDate = await apiBookPackage(group.slug, {
      dayCount: 2,
      quantity: 1,
    });
    expect(noDate.response.status).toBe(400);
    assertStringIncludes(noDate.body.error ?? "", "valid date");

    const { package: pkg } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    const date = pkg.availableDates[0];
    const noDays = await apiBookPackage(group.slug, {
      date,
      quantity: 1,
    });
    expect(noDays.response.status).toBe(400);
    assertStringIncludes(noDays.body.error ?? "", "days");
  });

  test("POST books a customisable bundle at the chosen span's package prices", async () => {
    const { boat, group, hut } = await customisablePackage(
      "Span Kit",
      "span-kit",
    );
    const { package: pkg } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    const date = pkg.availableDates[0];
    const { body, response } = await apiBookPackage(group.slug, {
      date,
      dayCount: 2,
      quantity: 1,
    });
    expect(response.status).toBe(200);
    // The boat's per-day override (1500) + the hut's own 2-day price (900).
    expect(body.booking!.amountOwed).toBe(2400);
    expect((await bookingRows(boat.id))[0]!.quantity).toBe(1);
    expect((await bookingRows(hut.id))[0]!.quantity).toBe(1);
  });
});

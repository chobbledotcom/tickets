import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  apiBookPackage,
  bookingRows,
  describePackageBooking,
  fixedPackage,
} from "../helpers.ts";

describePackageBooking(() => {
  test("POST books whole bundles at the cap and refuses more, stamping the group", async () => {
    const { a, b, group } = await fixedPackage("Book Kit", "book-kit");
    // Member A's 10 spots ÷ 2 per package cap the bundle at 5.
    const { body, response } = await apiBookPackage(group.slug, {
      quantity: 2,
    });
    expect(response.status).toBe(200);
    expect(body.booking!.ticketToken).toBeDefined();
    // Provider-less paid booking owes the full value: 2500 × 2 bundles.
    expect(body.booking!.amountOwed).toBe(5_000);
    const aRow = (await bookingRows(a.id))[0]!;
    const bRow = (await bookingRows(b.id))[0]!;
    expect(aRow.quantity).toBe(4);
    expect(bRow.quantity).toBe(2);
    expect(Number(aRow.package_group_id)).toBe(group.id);
    expect(Number(bRow.package_group_id)).toBe(group.id);

    // The form's select never offers a count above the cap, so only a
    // crafted POST can send one. It reads a refusal naming the live cap
    // (5 minus the 2 bundles just booked), not fewer bundles.
    const refused = await apiBookPackage(group.slug, { quantity: 99 });
    expect(refused.response.status).toBe(400);
    expect(refused.body.error).toBe("Quantity must be at most 3.");
    expect((await bookingRows(a.id)).length).toBe(1);
  });
});

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { tryRefund } from "#routes/api/payment-processing/refunds.ts";

/**
 * The refund path is where the live callbacks reject a blank provider resource
 * id — consistently, whatever the provider, because every refund goes through
 * `tryRefund`. A blank or whitespace-only id names no charge to refund, so the
 * refund is refused before any provider call. (A captured charge is still kept
 * and surfaced — see storeRefundedBooking — only the refund is refused.)
 */
describe("tryRefund resource id", () => {
  it("refuses an empty provider resource id", async () => {
    expect(await tryRefund("")).toBe(false);
  });

  it("refuses a whitespace-only provider resource id", async () => {
    expect(await tryRefund("   ")).toBe(false);
    expect(await tryRefund("\t\n")).toBe(false);
  });
});

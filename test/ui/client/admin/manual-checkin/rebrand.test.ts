import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { REBRANDED_FORM, useManualCheckinPage } from "./fixture.ts";

describe("manual check-in under the ticket-to-booking rebrand", () => {
  const { setup, stubScans } = useManualCheckinPage(REBRANDED_FORM);

  test("asks how many bookings at the quantity ask", async () => {
    stubScans([
      { max: 2, name: "Ada", status: "select_quantity" },
      {
        listingName: "Tour",
        name: "Ada",
        quantity: 1,
        remaining: 0,
        status: "checked_in",
        total: 1,
      },
    ]);
    const page = setup();
    page.attendeeIdInput.value = "11";
    const event = new page.window.Event("submit", { cancelable: true });
    page.form.dispatchEvent(event as unknown as Event);

    const overlay = document.getElementById("scanner-quantity")!;
    for (
      let turn = 0;
      turn < 1000 && overlay.classList.contains("hidden");
      turn++
    ) {
      await Promise.resolve();
    }
    expect(
      document.getElementById("scanner-quantity-message")!.textContent,
    ).toBe("How many bookings for Ada?");
  });
});

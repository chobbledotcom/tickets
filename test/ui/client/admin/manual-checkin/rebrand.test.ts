import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  REBRANDED_FORM,
  useManualCheckinPage,
  waitUntilSettled,
} from "./fixture.ts";

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
    await waitUntilSettled(
      () => !overlay.classList.contains("hidden"),
      "the quantity ask",
    );
    expect(
      document.getElementById("scanner-quantity-message")!.textContent,
    ).toBe("How many bookings for Ada?");

    // Cancel the ask so its page turn resolves: a pending turn would keep
    // the next quantity test in this isolate from opening its overlay.
    document.getElementById("scanner-quantity-cancel")!.click();
    await waitUntilSettled(
      () => !page.submitButton.disabled,
      "the cancelled check-in",
    );
  });
});

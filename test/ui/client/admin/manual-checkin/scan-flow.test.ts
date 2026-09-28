import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { useManualCheckinPage } from "./fixture.ts";

describe("manual check-in scan answers", () => {
  const { setup, stubScans } = useManualCheckinPage();

  /** Send the form without waiting for its handler: an ask on the way holds
   * the handler open until the overlay answers, so the caller must interact
   * with the overlay before the submit settles. Returns the page. */
  const startSubmitFor = (token: string) => {
    const page = setup();
    page.tokenInput.value = token;
    const event = new page.window.Event("submit", { cancelable: true });
    page.form.dispatchEvent(event as unknown as Event);
    return page;
  };

  /** Let the stubbed fetch answer and the ask appear. */
  const awaitOverlay = async (): Promise<void> => {
    const overlay = document.getElementById("scanner-quantity")!;
    while (overlay.classList.contains("hidden")) await Promise.resolve();
  };

  /** Wait for the submit handler to finish (the button re-enables). */
  const settle = async (page: {
    submitButton: HTMLButtonElement;
  }): Promise<void> => {
    while (page.submitButton.disabled) await Promise.resolve();
  };

  test("asks how many when the line owes more than one, then admits the pick", async () => {
    const sent = stubScans([
      { max: 2, name: "Ada", status: "select_quantity" },
      {
        listingName: "Tour",
        name: "Ada",
        quantity: 2,
        remaining: 0,
        status: "checked_in",
        total: 3,
      },
    ]);
    const page = startSubmitFor("ada");
    await awaitOverlay();

    // The overlay is up with the person's name in it and 1 to the whole
    // line offered, the whole line selected.
    const message = document.getElementById("scanner-quantity-message")!;
    const select = document.getElementById(
      "scanner-quantity-select",
    ) as HTMLSelectElement;
    expect(message.textContent).toBe("How many tickets for Ada?");
    expect(select.options.length).toBe(2);
    expect(select.value).toBe("2");

    select.value = "2";
    document.getElementById("scanner-quantity-confirm")!.click();
    await settle(page);

    // The pick re-posts with the chosen count...
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ quantity: 2, token: "ada" });
    // ...and a part answer names its count against the line's total.
    expect(page.status.textContent).toBe(
      "Ada checked in for Tour (2 of 3 tickets)",
    );
    expect(page.status.className).toContain("checkin-status-success");
  });

  test("a full answer keeps the plain ticket count", async () => {
    stubScans([
      {
        listingName: "Tour",
        name: "Bea",
        quantity: 1,
        remaining: 0,
        status: "checked_in",
        total: 1,
      },
    ]);

    const page = startSubmitFor("bea");
    await settle(page);
    expect(page.status.textContent).toBe("Bea checked in for Tour (1 pass)");
  });

  test("cancelling the ask skips the person without checking them in", async () => {
    const sent = stubScans([
      { max: 2, name: "Ada", status: "select_quantity" },
    ]);

    const page = startSubmitFor("ada");
    await awaitOverlay();
    document.getElementById("scanner-quantity-cancel")!.click();
    await settle(page);

    // No second POST landed, and the door said the person was skipped.
    expect(sent).toHaveLength(1);
    expect(page.status.textContent).toBe("Skipped Ada");
    expect(page.status.className).toContain("checkin-status-warning");
  });
});

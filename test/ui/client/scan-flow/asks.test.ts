import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkedIn,
  useManualCheckinPage,
} from "#test/ui/client/admin/manual-checkin/fixture.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { fireEvent, waitUntilSettled } from "#test-utils/happy-dom.ts";

describe("manual check-in scan answers", () => {
  const { pickedPage, stubScans } = useManualCheckinPage();

  /** Send the form without waiting for its handler: an ask on the way holds
   * the handler open until the overlay answers, so the caller must interact
   * with the overlay before the submit settles. Returns the page. */
  const startSubmitFor = async (attendeeId: string) => {
    const page = await pickedPage(attendeeId);
    const event = new page.window.Event("submit", { cancelable: true });
    fireEvent(page.form, event);
    return page;
  };

  /** Let the stubbed fetch answer and the ask appear. */
  const awaitOverlay = (): Promise<void> =>
    waitUntilSettled(
      () =>
        !document
          .getElementById("scanner-quantity")!
          .classList.contains("hidden"),
      "the quantity ask",
    );

  /** Wait for the submit handler to finish (the button re-enables). */
  const settle = (page: { submitButton: HTMLButtonElement }): Promise<void> =>
    waitUntilSettled(() => !page.submitButton.disabled, "the check-in");

  const COUNT_ASK = { max: 2, name: "Ada", status: "select_quantity" };

  /** Pick Ada, whose line owes two places, and wait for the count ask. The
   * scan route answers `afterCount` once the door picks. */
  const askCountThen = async (afterCount: Record<string, unknown>) => {
    const sent = stubScans([COUNT_ASK, afterCount]);
    const page = await startSubmitFor("11");
    await awaitOverlay();
    return { page, sent };
  };

  test("asks how many when the line owes more than one, then admits the pick", async () => {
    const { page, sent } = await askCountThen(
      checkedIn({ listingName: "Tour", total: 3 }),
    );

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
    expect(sent[1]).toMatchObject({ attendee_id: 11, quantity: 2 });
    // ...and a part answer names its count against the line's total.
    expect(page.status.textContent).toBe(
      "Ada checked in for Tour (2 of 3 tickets)",
    );
    assertStringIncludes(page.status.className, "checkin-status-success");
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

    const page = await startSubmitFor("12");
    await settle(page);
    expect(page.status.textContent).toBe("Bea checked in for Tour (1 pass)");
  });

  test("cancelling the ask skips the person without checking them in", async () => {
    const sent = stubScans([
      { max: 2, name: "Ada", status: "select_quantity" },
    ]);

    const page = await startSubmitFor("11");
    await awaitOverlay();
    document.getElementById("scanner-quantity-cancel")!.click();
    await settle(page);

    // No second POST landed, and the door said the person was skipped.
    expect(sent).toHaveLength(1);
    expect(page.status.textContent).toBe("Skipped Ada");
    assertStringIncludes(page.status.className, "checkin-status-warning");
  });

  test("a count ask that comes back after the door picked shows the error", async () => {
    const { page, sent } = await askCountThen(COUNT_ASK);
    document.getElementById("scanner-quantity-confirm")!.click();
    await settle(page);

    expect(sent).toEqual([
      { attendee_id: 11 },
      { attendee_id: 11, quantity: 2 },
    ]);
    expect(page.status.textContent).toBe("Check-in failed");
    assertStringIncludes(page.status.className, "checkin-status-error");
  });

  test("shows the door error when the answer names another listing", async () => {
    const sent = stubScans([
      { listingName: "Tour", name: "Ada", status: "wrong_listing" },
    ]);
    const page = await startSubmitFor("11");
    await settle(page);

    // The pick asks only the questions its route answers, so a
    // wrong-listing answer is final: the door reads the error words, the
    // pick stays for another try, and nothing re-posts.
    expect(sent).toEqual([{ attendee_id: 11 }]);
    expect(page.status.textContent).toBe(
      "This ticket has no door to check in at.",
    );
    assertStringIncludes(page.status.className, "checkin-status-error");
    expect(page.buttonLabel()).toBe("Check In");
  });

  test("posts each scan to the door's route as JSON under the page's token", async () => {
    const page = await pickedPage("11");
    using fetchStub = stubFetch(Response.json(checkedIn()));

    await page.submit();

    expect(fetchStub.calls.map((call) => call.args)).toEqual([
      [
        "/admin/listing/7/scan",
        {
          body: JSON.stringify({ attendee_id: 11 }),
          headers: {
            "content-type": "application/json",
            "x-csrf-token": "csrf",
          },
          method: "POST",
        },
      ],
    ]);
  });
});

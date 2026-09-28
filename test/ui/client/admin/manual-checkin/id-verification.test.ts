import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { type ManualCheckinPage, useManualCheckinPage } from "./fixture.ts";

/** The first POST answers verify_id, so the confirm overlay appears; wait
 *  for it, then answer through its buttons. */
const waitForConfirm = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    const overlay = document.getElementById("scanner-confirm")!;
    if (!overlay.classList.contains("hidden")) return;
    await Promise.resolve();
  }
  throw new Error("the confirm overlay never appeared");
};

describe("manual check-in ID verification", () => {
  const { setup } = useManualCheckinPage();

  /** Submit a pick whose first answer is verify_id, then dismiss the prompt
   *  the way the organiser would. Any dismissal must skip the person: one
   *  POST, no verified resubmit, "Skipped Bea", and both inputs cleared. */
  const dismissedPromptSkips = async (
    dismiss: (page: ManualCheckinPage) => void,
  ): Promise<void> => {
    const page = setup();
    page.attendeeIdInput.value = "12";
    const bodies: unknown[] = [];
    using _fetch = stubFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ name: "Bea", status: "verify_id" });
    });

    const submitting = page.submit();
    await waitForConfirm();
    dismiss(page);
    await submitting;

    expect(bodies).toEqual([{ attendee_id: 12 }]);
    expect(page.status.textContent).toBe("Skipped Bea");
    expect(page.status.className).toBe("checkin-status checkin-status-warning");
    expect(page.attendeeIdInput.value).toBe("");
    expect(page.input.value).toBe("");
    // The early return must leave the form usable for the next pick.
    expect(page.submitButton.disabled).toBe(false);
  };

  test("ID verification resubmits before showing success", async () => {
    const page = setup();
    page.attendeeIdInput.value = "12";
    const bodies: unknown[] = [];
    const reply = (_url: string, init?: RequestInit): Response => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ status: "verify_id" });
    };
    using _fetch = stubFetch(reply, (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        listingName: "Ceilidh",
        name: "Bea",
        quantity: 1,
        remaining: 0,
        status: "checked_in",
      });
    });

    const submitting = page.submit();
    await waitForConfirm();
    document.querySelector<HTMLButtonElement>("#scanner-confirm-yes")!.click();
    await submitting;

    expect(bodies).toEqual([
      { attendee_id: 12 },
      { attendee_id: 12, id_verified: true },
    ]);
    expect(page.status.textContent).toBe(
      "Bea checked in for Ceilidh (1 pass) - check ID",
    );
  });

  test("a declined ID verification skips the person and sends nothing more", async () => {
    await dismissedPromptSkips(() =>
      document.querySelector<HTMLButtonElement>("#scanner-confirm-no")!.click(),
    );
  });

  test("closing the ID prompt declines it", async () => {
    await dismissedPromptSkips(() =>
      document
        .querySelector<HTMLButtonElement>("#scanner-confirm-close")!
        .click(),
    );
  });

  test("escape closes the ID prompt and declines it", async () => {
    await dismissedPromptSkips((page) =>
      // The dialog listens on the installed window's document, so the event
      // must come from that window's own KeyboardEvent.
      document.dispatchEvent(
        new page.window.KeyboardEvent("keydown", {
          key: "Escape",
        }) as unknown as Event,
      ),
    );
  });

  test("ID verification uses its fallback note when no message is configured", async () => {
    const page = setup();
    delete page.form.dataset.messageVerifyIdNote;
    page.attendeeIdInput.value = "12";
    using _fetch = stubFetch(
      Response.json({ status: "verify_id" }),
      Response.json({
        listingName: "Ceilidh",
        name: "Bea",
        quantity: 1,
        remaining: 0,
        status: "checked_in",
      }),
    );

    const submitting = page.submit();
    await waitForConfirm();
    document.querySelector<HTMLButtonElement>("#scanner-confirm-yes")!.click();
    await submitting;

    expect(page.status.textContent).toBe(
      "Bea checked in for Ceilidh (1 pass) \u2014 verify their ID",
    );
  });
});

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkedIn,
  type ManualCheckinPage,
  useManualCheckinPage,
} from "#test/ui/client/admin/manual-checkin/fixture.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { fireEvent, waitUntilSettled } from "#test-utils/happy-dom.ts";

/** The first POST answers verify_id, so the confirm overlay appears; wait
 *  for it, then answer through its buttons. */
const waitForConfirm = (): Promise<void> =>
  waitUntilSettled(
    () =>
      !document.getElementById("scanner-confirm")!.classList.contains("hidden"),
    "the confirm overlay",
  );

describe("manual check-in ID verification", () => {
  const { pickedPage } = useManualCheckinPage();

  test("the bounded wait fails loudly when the page never settles", async () => {
    await expect(
      waitUntilSettled(() => false, "the door answer"),
    ).rejects.toThrow("the door answer never settled");
  });

  /** What a dismissed prompt leaves: one POST with no verified resubmit, the
   *  prompt's own question, "ID does not match Bea", the pick and the input cleared,
   *  and a form ready for the next pick. */
  const SKIPPED = {
    bodies: [{ attendee_id: 12 }] as unknown[],
    button: "Search",
    disabled: false,
    input: "",
    prompt: 'Does their ID match "Bea"?',
    status: "ID does not match Bea",
    statusClass: "checkin-status checkin-status-error",
  };

  /** Submit a pick whose first answer is verify_id, then dismiss the prompt
   *  the way the organiser would, and answer what the page shows after. */
  const dismissPrompt = async (
    dismiss: (page: ManualCheckinPage) => void,
  ): Promise<typeof SKIPPED> => {
    const page = await pickedPage("12");
    page.input.value = "Bea (1 ticket)";
    const bodies: unknown[] = [];
    using _fetch = stubFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ name: "Bea", status: "verify_id" });
    });

    const submitting = page.submit();
    await waitForConfirm();
    const prompt = document.getElementById(
      "scanner-confirm-message",
    )!.textContent;
    dismiss(page);
    await submitting;

    return {
      bodies,
      button: page.buttonLabel(),
      // The early return must leave the form usable for the next pick.
      disabled: page.submitButton.disabled,
      input: page.input.value,
      prompt: String(prompt),
      status: String(page.status.textContent),
      statusClass: page.status.className,
    };
  };

  /** Bea's check-in as the door sees it once her listing needs an ID
   * check: the scan route answers verify_id, then `afterId` once the door
   * confirms the ID. Answers the bodies the page sent. */
  const BEA_IN = checkedIn({ name: "Bea", quantity: 1, total: 1 });
  const confirmIdThen = async (
    page: ManualCheckinPage,
    afterId: Record<string, unknown>,
  ): Promise<unknown[]> => {
    const bodies: unknown[] = [];
    using _fetch = stubFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(
        bodies.length === 1 ? { name: "Bea", status: "verify_id" } : afterId,
      );
    });
    const submitting = page.submit();
    await waitForConfirm();
    document.querySelector<HTMLButtonElement>("#scanner-confirm-yes")!.click();
    await submitting;
    return bodies;
  };

  test("ID verification resubmits before showing success", async () => {
    const page = await pickedPage("12");

    expect(await confirmIdThen(page, BEA_IN)).toEqual([
      { attendee_id: 12 },
      { attendee_id: 12, id_verified: true },
    ]);
    expect(page.status.textContent).toBe("Bea checked in for Ceilidh (1 pass)");
  });

  test("a declined ID verification skips the person and sends nothing more", async () => {
    expect(
      await dismissPrompt(() =>
        document
          .querySelector<HTMLButtonElement>("#scanner-confirm-no")!
          .click(),
      ),
    ).toEqual(SKIPPED);
  });

  test("closing the ID prompt declines it", async () => {
    expect(
      await dismissPrompt(() =>
        document
          .querySelector<HTMLButtonElement>("#scanner-confirm-close")!
          .click(),
      ),
    ).toEqual(SKIPPED);
  });

  test("escape closes the ID prompt and declines it", async () => {
    expect(
      await dismissPrompt((page) =>
        // The dialog listens on the installed window's document, so the
        // event must come from that window's own KeyboardEvent.
        fireEvent(
          document,
          new page.window.KeyboardEvent("keydown", {
            key: "Escape",
          }),
        ),
      ),
    ).toEqual(SKIPPED);
  });

  test("an ask that comes back after the door answered it shows the error", async () => {
    const page = await pickedPage("12");

    expect(
      await confirmIdThen(page, { name: "Bea", status: "verify_id" }),
    ).toEqual([{ attendee_id: 12 }, { attendee_id: 12, id_verified: true }]);
    expect(page.status.textContent).toBe("Check-in failed");
    expect(page.buttonLabel()).toBe("Check In");
  });
});

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { showConfirm } from "#src/ui/client/confirm-dialog.ts";
import { showQuantitySelect } from "#src/ui/client/quantity-select.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

describe("the quantity ask the door gets", () => {
  const dom = createDomInstaller(["KeyboardEvent"]);
  afterEach(() => dom.cleanup());

  /** The overlay markup the scanner page renders. */
  const overlay = `
    <div class="scanner-overlay hidden" id="scanner-quantity">
      <div class="scanner-overlay-backdrop"></div>
      <div class="scanner-overlay-box">
        <p id="scanner-quantity-message"></p>
        <select id="scanner-quantity-select"></select>
        <button id="scanner-quantity-confirm" type="button">Check In</button>
        <button id="scanner-quantity-cancel" type="button">Cancel</button>
      </div>
    </div>`;
  /** Wait for the ask to take its turn in the door's question queue. */
  const opened = async (): Promise<void> => {
    const overlayEl = element("scanner-quantity");
    for (
      let hops = 0;
      hops < 100 && overlayEl.classList.contains("hidden");
      hops++
    ) {
      await Promise.resolve();
    }
    expect(overlayEl.classList.contains("hidden")).toBe(false);
  };
  /** The overlay's element, once installed. */
  const element = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`No element #${id}`);
    return found;
  };

  test("offers one option per place, whole line selected, and reveals itself", async () => {
    dom.installDom(overlay);
    const overlayEl = element("scanner-quantity");
    const prompt = showQuantitySelect(
      3,
      "How many tickets for Bea?",
      (count) => `${count} tickets`,
    );
    await opened();

    expect(overlayEl.classList.contains("hidden")).toBe(false);
    const message = element("scanner-quantity-message");
    expect(message.textContent).toBe("How many tickets for Bea?");
    const select = element("scanner-quantity-select") as HTMLSelectElement;
    expect(select.options.length).toBe(3);
    expect(select.options[0]!.textContent).toBe("1 tickets");
    expect(select.options[2]!.textContent).toBe("3 tickets");
    // The whole party is the common case, so it starts selected.
    expect(select.value).toBe("3");
    // The select takes focus, so the door can pick with the keyboard.
    expect(document.activeElement).toBe(select);

    select.value = "2";
    element("scanner-quantity-confirm").click();
    expect(await prompt).toBe(2);
    expect(overlayEl.classList.contains("hidden")).toBe(true);
  });

  test("cancel answers null and hides the overlay", async () => {
    dom.installDom(overlay);
    const overlayEl = element("scanner-quantity");
    const prompt = showQuantitySelect(2, "How many tickets?", String);
    await opened();

    element("scanner-quantity-cancel").click();
    expect(await prompt).toBeNull();
    expect(overlayEl.classList.contains("hidden")).toBe(true);
  });

  test("escape answers null too", async () => {
    dom.installDom(overlay);
    const prompt = showQuantitySelect(2, "How many tickets?", String);
    await opened();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await prompt).toBeNull();
  });

  test("waits behind an open confirm, so one click answers one prompt", async () => {
    dom.installDom(`${overlay}
      <div class="hidden" id="scanner-confirm">
        <p id="scanner-confirm-message"></p>
        <button id="scanner-confirm-yes" type="button">Yes</button>
        <button id="scanner-confirm-no" type="button">No</button>
        <button id="scanner-confirm-close" type="button">Close</button>
      </div>`);
    const confirmed = showConfirm("Check their ID?");
    const picked = showQuantitySelect(2, "How many tickets?", String);
    for (let hops = 0; hops < 5; hops++) await Promise.resolve();

    // The confirm the operator sees is open; the count ask waits for it.
    expect(element("scanner-confirm").classList.contains("hidden")).toBe(false);
    expect(element("scanner-quantity").classList.contains("hidden")).toBe(true);
    element("scanner-confirm-yes").click();
    expect(await confirmed).toBe(true);
    await opened();
    element("scanner-quantity-confirm").click();
    expect(await picked).toBe(2);
  });
});

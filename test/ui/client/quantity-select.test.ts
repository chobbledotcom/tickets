import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
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

    expect(overlayEl.classList.contains("hidden")).toBe(false);
    const message = element("scanner-quantity-message");
    expect(message.textContent).toBe("How many tickets for Bea?");
    const select = element("scanner-quantity-select") as HTMLSelectElement;
    expect(select.options.length).toBe(3);
    expect(select.options[0]!.textContent).toBe("1 tickets");
    expect(select.options[2]!.textContent).toBe("3 tickets");
    // The whole party is the common case, so it starts selected.
    expect(select.value).toBe("3");

    select.value = "2";
    element("scanner-quantity-confirm").click();
    expect(await prompt).toBe(2);
    expect(overlayEl.classList.contains("hidden")).toBe(true);
  });

  test("cancel answers null and hides the overlay", async () => {
    dom.installDom(overlay);
    const overlayEl = element("scanner-quantity");
    const prompt = showQuantitySelect(2, "How many tickets?", String);

    element("scanner-quantity-cancel").click();
    expect(await prompt).toBeNull();
    expect(overlayEl.classList.contains("hidden")).toBe(true);
  });

  test("escape answers null too", async () => {
    dom.installDom(overlay);
    const prompt = showQuantitySelect(2, "How many tickets?", String);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await prompt).toBeNull();
  });
});

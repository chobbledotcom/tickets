import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { showConfirm } from "#src/ui/client/confirm-dialog.ts";
import {
  createDomInstaller,
  type DomInstaller,
} from "#test-utils/happy-dom.ts";

const CONFIRM_OVERLAY = `
  <div class="hidden" id="scanner-confirm">
    <span id="scanner-confirm-message"></span>
    <button id="scanner-confirm-yes" type="button">Yes</button>
    <button id="scanner-confirm-no" type="button">No</button>
    <button id="scanner-confirm-close" type="button">×</button>
  </div>
`;

describe("the door scan's confirm dialog", () => {
  const dom: DomInstaller = createDomInstaller();
  afterEach(() => dom.cleanup());

  const setup = (): {
    overlay: HTMLElement;
    press: (key: string) => void;
    whenOpen: (text: string) => Promise<void>;
    window: Window;
  } => {
    const window = dom.installDom(CONFIRM_OVERLAY);
    const message = document.getElementById("scanner-confirm-message")!;
    return {
      overlay: document.getElementById("scanner-confirm")!,
      press: (key: string): void => {
        document.dispatchEvent(
          new window.KeyboardEvent("keydown", { key }) as unknown as Event,
        );
      },
      // The dialog opens on the promise hop after showConfirm, so the tests
      // await the question they asked for. The bound turns a dialog that
      // never opens into a failed assertion rather than a hung test.
      whenOpen: async (text: string): Promise<void> => {
        for (let hops = 0; hops < 100 && message.textContent !== text; hops++) {
          await Promise.resolve();
        }
        expect(message.textContent).toBe(text);
      },
      window,
    };
  };

  test("answers only through its buttons and the Escape key", async () => {
    const page = setup();

    const admitted = showConfirm("Check in anyway?");
    await page.whenOpen("Check in anyway?");
    expect(page.overlay.classList.contains("hidden")).toBe(false);
    document.getElementById("scanner-confirm-yes")!.click();
    expect(await admitted).toBe(true);
    expect(page.overlay.classList.contains("hidden")).toBe(true);

    const refused = showConfirm("Check their ID?");
    await page.whenOpen("Check their ID?");
    document.getElementById("scanner-confirm-no")!.click();
    expect(await refused).toBe(false);

    const closed = showConfirm("Check their ID?");
    await page.whenOpen("Check their ID?");
    document.getElementById("scanner-confirm-close")!.click();
    expect(await closed).toBe(false);

    const escaped = showConfirm("Check their ID?");
    await page.whenOpen("Check their ID?");
    page.press("Escape");
    expect(await escaped).toBe(false);
    // A key that is not the Escape key never answers a question.
    const kept = showConfirm("Check their ID?");
    await page.whenOpen("Check their ID?");
    page.press("Enter");
    expect(page.overlay.classList.contains("hidden")).toBe(false);
    document.getElementById("scanner-confirm-yes")!.click();
    expect(await kept).toBe(true);
  });

  test("queues questions, so one click answers one prompt", async () => {
    const page = setup();

    const first = showConfirm("Check in anyway?");
    const second = showConfirm("Check their ID?");

    // Only the question the operator sees is open; the second waits behind
    // it, and the first prompt's buttons cannot answer it.
    await page.whenOpen("Check in anyway?");
    document.getElementById("scanner-confirm-yes")!.click();
    expect(await first).toBe(true);
    await page.whenOpen("Check their ID?");
    document.getElementById("scanner-confirm-no")!.click();
    expect(await second).toBe(false);
    expect(page.overlay.classList.contains("hidden")).toBe(true);
  });
});

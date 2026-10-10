import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { initShareButtons } from "#src/ui/client/admin/share-button.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

describe("share buttons", () => {
  const dom = createDomInstaller();

  afterEach(async () => {
    // Awaited: happy-dom's window close starts a settle timer of its own, and
    // an un-awaited close can land it after the test, which the leak detector
    // flags.
    await dom.cleanup();
    // The stubbed navigator capabilities are Deno globals; take them back off
    // so no neighbour reads a test's stub.
    for (const name of ["share", "clipboard"]) {
      delete (navigator as unknown as Record<string, unknown>)[name];
    }
  });

  /** One public URL row installed onto the DOM, the script wired, and the
   *  button handed back. The link shows the full URL, so a manual selection
   *  carries the whole address. */
  const setup = () => {
    const window = dom.installDom(`
      <span class="public-url-row">
        <a data-share-link href="https://fair.example/ticket/sunday">
          https://fair.example/ticket/sunday
        </a>
        <span class="public-url-actions">
          <button data-copied-label="Copied" data-share-url="https://fair.example/ticket/sunday"
                  type="button">Share</button>
        </span>
      </span>
    `);
    initShareButtons();
    const button = window.document.querySelector(
      "button[data-share-url]",
    ) as unknown as HTMLButtonElement;
    return { button, window };
  };

  /** Stub one navigator capability, or remove it when the stub is null. */
  const stubNavigator = (name: "share" | "clipboard", value: unknown) => {
    if (value === null) {
      delete (navigator as unknown as Record<string, unknown>)[name];
      return;
    }
    Object.defineProperty(navigator, name, {
      configurable: true,
      value,
    });
  };

  /** Stub the clipboard with a recording write and hand the copies back. */
  const clipboardCopies = (): string[] => {
    const written: string[] = [];
    stubNavigator("clipboard", {
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    return written;
  };

  /** Answer every selection call, and hold the text the last one selected. */
  const captureSelection = (window: { getSelection: unknown }): string[] => {
    const selected: string[] = [];
    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: () => ({
        removeAllRanges: () => {},
        selectAllChildren: (node: Node) =>
          selected.push(node.textContent?.trim() ?? ""),
        toString: () => selected.at(-1) ?? "",
      }),
    });
    return selected;
  };

  /** Click the wired button and let its handler chain run to the clipboard
   *  write or the selection in microtasks; the two-second revert timer stays
   *  pending until the test ticks it. */
  const clickAndSettle = async (
    time: FakeTime,
    button: HTMLButtonElement,
  ): Promise<void> => {
    button.click();
    await time.tickAsync(0);
  };

  test("a browser share sheet takes the URL and no copy runs", async () => {
    using time = new FakeTime();
    const { button } = setup();
    const shared: string[] = [];
    stubNavigator("share", (data: { url: string }) => {
      shared.push(data.url);
      return Promise.resolve();
    });
    const written = clipboardCopies();

    await clickAndSettle(time, button);

    expect(shared).toEqual(["https://fair.example/ticket/sunday"]);
    expect(written).toEqual([]);
    expect(button.textContent).toBe("Share");
  });

  /** The share sheet is absent (or refused), so the copy takes over: the
   *  copied label flashes, then the original label returns. `bare` swaps the
   *  full row for a button with no link beside it and no copied label of its
   *  own. */
  const fallsBackToCopy = async (
    bare: boolean,
    shareStub: unknown = null,
  ): Promise<void> => {
    using time = new FakeTime();
    const { button } = bare ? setupBareButton() : setup();
    stubNavigator("share", shareStub);
    const written = clipboardCopies();

    await clickAndSettle(time, button);

    expect(written).toEqual(["https://fair.example/ticket/sunday"]);
    expect(button.textContent).toBe("Copied");

    time.tick(2000);
    expect(button.textContent).toBe("Share");
  };

  test("without a share sheet the URL is copied and the button says Copied", async () => {
    await fallsBackToCopy(false);
  });

  test("a failed share falls back to the clipboard", async () => {
    await fallsBackToCopy(false, () =>
      Promise.reject(new Error("unsupported")),
    );
  });

  test("a cancelled share sheet copies nothing and keeps the label", async () => {
    using time = new FakeTime();
    const { button } = setup();
    const cancelled = new DOMException(
      "The user aborted a request.",
      "AbortError",
    );
    stubNavigator("share", () => Promise.reject(cancelled));
    const written = clipboardCopies();

    await clickAndSettle(time, button);

    expect(written).toEqual([]);
    expect(button.textContent).toBe("Share");
  });

  test("a copy during the flash still restores the original label", async () => {
    using time = new FakeTime();
    const { button } = setup();
    stubNavigator("clipboard", {
      writeText: () => Promise.resolve(),
    });

    await clickAndSettle(time, button);
    expect(button.textContent).toBe("Copied");

    await clickAndSettle(time, button);
    expect(button.textContent).toBe("Copied");

    time.tick(2000);
    expect(button.textContent).toBe("Share");
  });

  test("a refused clipboard copy selects the full link URL instead", async () => {
    using time = new FakeTime();
    const { button, window } = setup();
    stubNavigator("clipboard", {
      writeText: () => Promise.reject(new Error("denied")),
    });
    const selected = captureSelection(window);

    await clickAndSettle(time, button);

    expect(selected).toEqual(["https://fair.example/ticket/sunday"]);
    expect(button.textContent).toBe("Share");
  });

  test("no share sheet and no clipboard selects the full link URL", async () => {
    using time = new FakeTime();
    const { button, window } = setup();
    stubNavigator("share", null);
    stubNavigator("clipboard", null);
    const selected = captureSelection(window);

    await clickAndSettle(time, button);

    expect(selected).toEqual(["https://fair.example/ticket/sunday"]);
    expect(button.textContent).toBe("Share");
  });

  /** A bare share button on the DOM (no link beside it), wired, and handed
   *  back with its window. */
  const setupBareButton = () => {
    const window = dom.installDom(
      '<button data-share-url="https://fair.example/ticket/sunday" type="button">Share</button>',
    );
    initShareButtons();
    const button = window.document.querySelector(
      "button[data-share-url]",
    ) as unknown as HTMLButtonElement;
    return { button, window };
  };

  test("a share button with no link in its row selects nothing", async () => {
    using time = new FakeTime();
    const { button, window } = setupBareButton();
    stubNavigator("share", null);
    stubNavigator("clipboard", null);
    const selected = captureSelection(window);

    await clickAndSettle(time, button);

    expect(selected).toEqual([]);
  });

  test("a click on the wired button runs the chain and flashes Copied", async () => {
    // The bare row carries no data-copied-label, so the module's default
    // label shows.
    await fallsBackToCopy(true);
  });

  test("a browser without a selection API selects nothing", async () => {
    using time = new FakeTime();
    const { button, window } = setup();
    stubNavigator("share", null);
    stubNavigator("clipboard", null);
    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: () => null,
    });

    await clickAndSettle(time, button);

    expect(button.textContent).toBe("Share");
  });
});

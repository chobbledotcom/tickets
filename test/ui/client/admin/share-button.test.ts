import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  initShareButtons,
  shareOrCopy,
} from "#src/ui/client/admin/share-button.ts";
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

  /** One share row installed onto the DOM, the script wired, and the button
   *  handed back. */
  const setup = () => {
    const window = dom.installDom(`
      <span class="share-row">
        <a data-share-link href="https://fair.example/ticket/sunday">
          fair.example/ticket/sunday
        </a>
        <span class="share-actions">
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

  test("a browser share sheet takes the URL and no copy runs", async () => {
    const { button } = setup();
    const shared: string[] = [];
    stubNavigator("share", (data: { url: string }) => {
      shared.push(data.url);
      return Promise.resolve();
    });
    let copied = false;
    stubNavigator("clipboard", {
      writeText: () => {
        copied = true;
        return Promise.resolve();
      },
    });

    await shareOrCopy(button);

    expect(shared).toEqual(["https://fair.example/ticket/sunday"]);
    expect(copied).toBe(false);
    expect(button.textContent).toBe("Share");
  });

  /** When the share sheet is absent or refuses, the copy takes over: the
   *  copied label flashes, then the original label returns. */
  const fallsBackToCopy = async (shareStub: unknown): Promise<void> => {
    using time = new FakeTime();
    const { button } = setup();
    stubNavigator("share", shareStub);
    const written = clipboardCopies();

    await shareOrCopy(button);

    expect(written).toEqual(["https://fair.example/ticket/sunday"]);
    expect(button.textContent).toBe("Copied");

    time.tick(2000);
    expect(button.textContent).toBe("Share");
  };

  test("without a share sheet the URL is copied and the button says Copied", async () => {
    await fallsBackToCopy(null);
  });

  test("a failed share falls back to the clipboard", async () => {
    await fallsBackToCopy(() => Promise.reject(new Error("unsupported")));
  });

  test("a copy during the flash still restores the original label", async () => {
    using time = new FakeTime();
    const { button } = setup();
    stubNavigator("clipboard", {
      writeText: () => Promise.resolve(),
    });

    await shareOrCopy(button);
    expect(button.textContent).toBe("Copied");

    await shareOrCopy(button);
    expect(button.textContent).toBe("Copied");

    time.tick(2000);
    expect(button.textContent).toBe("Share");
  });

  test("a refused clipboard copy selects the link text instead", async () => {
    const { button, window } = setup();
    stubNavigator("clipboard", {
      writeText: () => Promise.reject(new Error("denied")),
    });
    const selected = captureSelection(window);

    await shareOrCopy(button);

    expect(selected).toEqual(["fair.example/ticket/sunday"]);
  });

  test("no share sheet and no clipboard selects the link text", async () => {
    const { button, window } = setup();
    stubNavigator("share", null);
    stubNavigator("clipboard", null);
    const selected = captureSelection(window);

    await shareOrCopy(button);

    expect(selected).toEqual(["fair.example/ticket/sunday"]);
    expect(button.textContent).toBe("Share");
  });

  test("a share button with no link in its row selects nothing", async () => {
    const window = dom.installDom(
      '<button data-share-url="https://fair.example/ticket/sunday" type="button">Share</button>',
    );
    initShareButtons();
    const button = window.document.querySelector(
      "button[data-share-url]",
    ) as unknown as HTMLButtonElement;
    stubNavigator("share", null);
    stubNavigator("clipboard", null);
    const selected = captureSelection(window);

    await shareOrCopy(button);

    expect(selected).toEqual([]);
  });

  test("a button with no share URL does nothing", async () => {
    const window = dom.installDom('<button type="button">Share</button>');
    const button = window.document.querySelector(
      "button",
    ) as unknown as HTMLButtonElement;
    stubNavigator("share", null);
    const written = clipboardCopies();

    await shareOrCopy(button);

    expect(written).toEqual([]);
    expect(button.textContent).toBe("Share");
  });

  test("a click on the wired button runs the chain and flashes Copied", async () => {
    using time = new FakeTime();
    const window = dom.installDom(
      '<button data-share-url="https://fair.example/ticket/sunday" type="button">Share</button>',
    );
    initShareButtons();
    const button = window.document.querySelector(
      "button[data-share-url]",
    ) as unknown as HTMLButtonElement;
    stubNavigator("share", null);
    const written = clipboardCopies();

    button.click();
    // One fake-tick flush: the click's handler chain runs to the clipboard
    // write in microtasks, and the two-second revert timer stays pending.
    await time.tickAsync(0);

    expect(written).toEqual(["https://fair.example/ticket/sunday"]);
    // No data-copied-label on this row, so the module's default shows.
    expect(button.textContent).toBe("Copied");

    time.tick(2000);
    expect(button.textContent).toBe("Share");
  });

  test("a browser without a selection API selects nothing", async () => {
    const { button, window } = setup();
    stubNavigator("share", null);
    stubNavigator("clipboard", null);
    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: () => null,
    });

    await shareOrCopy(button);

    expect(button.textContent).toBe("Share");
  });
});

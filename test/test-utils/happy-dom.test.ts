import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  createDomInstaller,
  fireEvent,
  requireElement,
} from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller(["Event"]);

afterEach(async () => {
  await cleanup();
});

describe("happy-dom helpers", () => {
  test("requireElement returns the one element the selector names", () => {
    installDom('<p id="greeting">Hello</p>');
    const p = requireElement<HTMLParagraphElement>(document, "#greeting");
    expect(p.textContent).toBe("Hello");
  });

  test("requireElement throws naming the selector when the page lacks it", () => {
    installDom("<p></p>");
    try {
      requireElement(document, "#missing");
      throw new Error("expected requireElement to throw");
    } catch (error) {
      expect((error as Error).message).toBe("The page carries no #missing");
    }
  });

  test("an injected iframe never opens a child page", () => {
    installDom('<iframe src="https://fair.example/ticket/sunday"></iframe>');
    const iframe = requireElement<HTMLIFrameElement>(document, "iframe");
    // Opening the child page starts a real navigation with its own timer,
    // which the window close can race and leak. The page must stay inert.
    expect(iframe.contentWindow).toBeNull();
  });

  test("an iframe the test appends never opens a child page", () => {
    installDom("");
    const iframe = document.createElement("iframe");
    iframe.src = "https://fair.example/ticket/sunday";
    document.body.append(iframe);
    // The embed loader creates and appends its iframe after install. This
    // path must stay inert too.
    expect(iframe.contentWindow).toBeNull();
  });

  test("fireEvent dispatches the event at the target", () => {
    const window = installDom("<button></button>");
    const button = requireElement<HTMLButtonElement>(document, "button");
    let heard = 0;
    button.addEventListener("click", () => {
      heard += 1;
    });
    fireEvent(button, new window.MouseEvent("click"));
    expect(heard).toBe(1);
  });
});

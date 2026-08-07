import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { addScreenshotStyle } from "#scripts/screenshots/layers.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

type LinkEvent = "error" | "load";

interface FakeLink {
  addEventListener: (event: LinkEvent, listener: () => void) => void;
  dataset: Record<string, string>;
  href: string;
  rel: string;
  remove: () => void;
  removed: boolean;
  send: (event: LinkEvent) => void;
}

interface FakeRoot {
  appendChild: (link: FakeLink) => void;
  links: FakeLink[];
  querySelectorAll: (selector: string) => unknown[];
}

const makeLink = (): FakeLink => {
  const listeners = new Map<LinkEvent, () => void>();
  const link: FakeLink = {
    addEventListener: (event, listener) => listeners.set(event, listener),
    dataset: {},
    href: "",
    rel: "",
    remove: () => {
      link.removed = true;
    },
    removed: false,
    send: (event) => listeners.get(event)?.(),
  };
  return link;
};

const makeRoot = (event: LinkEvent, children: FakeRoot[] = []): FakeRoot => {
  const links: FakeLink[] = [];
  return {
    appendChild: (link) => {
      links.push(link);
      queueMicrotask(() => link.send(event));
    },
    links,
    querySelectorAll: (selector) =>
      selector === "*" ? children.map((shadowRoot) => ({ shadowRoot })) : links,
  };
};

const setupPage = (
  root: FakeRoot,
): {
  page: never;
  styleRemoved: () => boolean;
  unrouted: () => boolean;
} => {
  const globals = createGlobalStash();
  globals.set("document", {
    createElement: makeLink,
    querySelectorAll: root.querySelectorAll,
  });
  let removedStyle = false;
  let removedRoute = false;
  return {
    page: {
      addStyleTag: () =>
        Promise.resolve({
          evaluate: (fn: (node: unknown) => unknown) =>
            Promise.resolve(
              fn({
                parentNode: {
                  removeChild: () => {
                    removedStyle = true;
                  },
                },
              }),
            ),
        }),
      evaluate: (fn: (argument: never) => unknown, argument: never) =>
        Promise.resolve(fn(argument)),
      route: () => Promise.resolve(),
      unroute: () => {
        removedRoute = true;
        globals.restore();
        return Promise.resolve();
      },
      url: () => "https://tickets.test/page",
    } as never,
    styleRemoved: () => removedStyle,
    unrouted: () => removedRoute,
  };
};

describe("screenshot layer styles", () => {
  test("loads and removes styles in nested open shadow roots", async () => {
    const nested = makeRoot("load");
    const shadow = makeRoot("load", [nested]);
    const documentRoot = makeRoot("load", [shadow]);
    const state = setupPage(documentRoot);

    const remove = await addScreenshotStyle(
      state.page,
      "button { color: red; }",
    );
    expect(shadow.links).toHaveLength(1);
    expect(nested.links).toHaveLength(1);
    expect(shadow.links[0]).toEqual(
      expect.objectContaining({ rel: "stylesheet", removed: false }),
    );

    await remove();

    expect(shadow.links[0]?.removed).toBe(true);
    expect(nested.links[0]?.removed).toBe(true);
    expect(state.styleRemoved()).toBe(true);
    expect(state.unrouted()).toBe(true);
  });

  test("cleans up when a shadow-root stylesheet fails to load", async () => {
    const shadow = makeRoot("error");
    const state = setupPage(makeRoot("load", [shadow]));

    await expect(
      addScreenshotStyle(state.page, "button { color: red; }"),
    ).rejects.toThrow("Could not load screenshot style.");

    expect(shadow.links[0]?.removed).toBe(true);
    expect(state.styleRemoved()).toBe(true);
    expect(state.unrouted()).toBe(true);
  });
});

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Browser } from "playwright";
import {
  launchScreenshotBrowser,
  layerStyle,
  withPage,
} from "./screenshots-browser-helpers.ts";

describe("screenshot layer browser contracts", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchScreenshotBrowser();
  });

  afterAll(async () => {
    await browser.close();
  });

  test("keeps SVG control icons in the controls layer", async () => {
    await withPage(
      browser,
      '<button style="color: rgb(0, 0, 255)"><svg style="fill: currentColor"><use href="#save"></use></svg><span>Save</span></button>',
      async (page) => {
        expect(await layerStyle(page, "controls", "use", "fill")).toBe(
          "rgb(0, 0, 255)",
        );
        expect(
          await layerStyle(page, "controls", "span", "-webkit-text-fill-color"),
        ).toBe("rgba(0, 0, 0, 0)");
      },
    );
  });

  test("keeps generated control labels out of the controls layer", async () => {
    await withPage(
      browser,
      '<style>button::after { color: rgb(255, 0, 0); content: "3"; }</style><button>Cart</button>',
      async (page) => {
        expect(
          await layerStyle(
            page,
            "controls",
            "button",
            "-webkit-text-fill-color",
            "::after",
          ),
        ).toBe("rgba(0, 0, 0, 0)");
        expect(
          await layerStyle(page, "text", "button", "color", "::after"),
        ).toBe("rgb(255, 0, 0)");
      },
    );
  });

  test("keeps foreignObject labels in the text layer", async () => {
    await withPage(
      browser,
      '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Label</div></foreignObject></svg>',
      async (page) => {
        expect(
          await layerStyle(page, "text", "foreignObject", "visibility"),
        ).toBe("visible");
        expect(
          await layerStyle(page, "text", "foreignObject div", "color"),
        ).not.toBe("rgba(0, 0, 0, 0)");
      },
    );
  });

  test("keeps embedded documents out of the text layer", async () => {
    await withPage(
      browser,
      '<iframe srcdoc="<p>Embedded words</p>"></iframe>',
      async (page) => {
        expect(await layerStyle(page, "text", "iframe", "visibility")).toBe(
          "hidden",
        );
        expect(
          await layerStyle(page, "background", "iframe", "visibility"),
        ).toBe("visible");
      },
    );
  });
});

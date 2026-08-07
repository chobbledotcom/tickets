import { describe, it as test } from "@std/testing/bdd";
import { capturePreparedLayers } from "#scripts/screenshots/capture.ts";
import {
  expectOnlyBackgroundColor,
  launchScreenshotBrowserWithScrollbars,
  withPage,
} from "./screenshots-browser-helpers.ts";

describe("screenshot scrollbar browser contract", () => {
  test("keeps scrollbar paint out of the text layer", async () => {
    const browser = await launchScreenshotBrowserWithScrollbars();
    try {
      await withPage(
        browser,
        `<style>
          #scroll { height: 80px; overflow: scroll; width: 160px; }
          #scroll > div { height: 300px; }
          #scroll::-webkit-scrollbar { height: 16px; width: 16px; }
          #scroll::-webkit-scrollbar-thumb { background: rgb(255, 0, 0); }
        </style><div id="scroll"><div>Words</div></div>`,
        async (page) => {
          const { layers } = await capturePreparedLayers(page);

          await expectOnlyBackgroundColor(layers, [255, 0, 0]);
        },
      );
    } finally {
      await browser.close();
    }
  });
});

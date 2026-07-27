import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  browserLaunchOptions,
  defineScreenshotBrowserLauncher,
} from "#scripts/browser-options.ts";

describe("screenshot browser options", () => {
  test("includes only provided launch fields", () => {
    expect(browserLaunchOptions(true, undefined, undefined)).toEqual({
      headless: true,
    });
    expect(browserLaunchOptions(false, "/usr/bin/ch", ["--flag"])).toEqual({
      args: ["--flag"],
      executablePath: "/usr/bin/ch",
      headless: false,
    });
  });

  test("launches Chromium with screenshot-mode headless and CDP fix", async () => {
    const calls: Parameters<
      Parameters<typeof defineScreenshotBrowserLauncher>[0]["launch"]
    >[0] = {
      args: ["--disable-features=CDPScreenshotNewSurface"],
      headless: true,
    };
    const fakeBrowser = {
      launch: (options: typeof calls) => Promise.resolve(options),
    };
    const launch = defineScreenshotBrowserLauncher(fakeBrowser as never, () =>
      Promise.resolve("/path/to/chromium"),
    );

    expect(await launch()).toEqual({
      args: ["--disable-features=CDPScreenshotNewSurface"],
      executablePath: "/path/to/chromium",
      headless: true,
    });
  });
});

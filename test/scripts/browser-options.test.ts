import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { LaunchOptions } from "playwright";
import {
  browserLaunchOptions,
  defineScreenshotBrowserLauncher,
} from "#scripts/browser-options.ts";
import { requireValue } from "#shared/required-value.ts";

const launchOptions = async (
  overrides?: Pick<LaunchOptions, "ignoreDefaultArgs">,
): Promise<LaunchOptions> => {
  let calledWith: LaunchOptions | undefined;
  const fakeBrowser = {
    launch: (options: LaunchOptions) => {
      calledWith = options;
      return Promise.resolve();
    },
  };
  await defineScreenshotBrowserLauncher(
    fakeBrowser as never,
    () => Promise.resolve("/path/to/chromium"),
    overrides,
  )();
  return requireValue(calledWith, "Chromium was not launched.");
};

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
    expect(await launchOptions()).toEqual({
      args: ["--disable-features=CDPScreenshotNewSurface"],
      executablePath: "/path/to/chromium",
      headless: true,
    });
  });

  test("passes screenshot launch overrides to Chromium", async () => {
    expect(
      await launchOptions({ ignoreDefaultArgs: ["--hide-scrollbars"] }),
    ).toEqual({
      args: ["--disable-features=CDPScreenshotNewSurface"],
      executablePath: "/path/to/chromium",
      headless: true,
      ignoreDefaultArgs: ["--hide-scrollbars"],
    });
  });
});

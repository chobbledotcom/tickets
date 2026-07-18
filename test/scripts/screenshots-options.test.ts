import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  parseScreenshotOptions,
  SCREENSHOT_NAMES,
  THEME_NAMES,
} from "../../scripts/screenshots/options.ts";

describe("screenshot options", () => {
  it("captures every scene with the default theme when no options are given", () => {
    expect(parseScreenshotOptions([])).toEqual({
      names: SCREENSHOT_NAMES,
      outputDir: "screenshots",
      themes: ["default"],
    });
  });

  it("accepts named scenes, themes and an output directory", () => {
    expect(
      parseScreenshotOptions([
        "attendees-list,listing",
        "--theme",
        "forest,ink",
        "--output",
        "/tmp/site-images",
        "--element",
        "form",
      ]),
    ).toEqual({
      elementSelector: "form",
      names: ["attendees-list", "listing"],
      outputDir: "/tmp/site-images",
      themes: ["forest", "ink"],
    });
  });

  it("expands all themes", () => {
    expect(
      parseScreenshotOptions(["dashboard", "--theme", "all"]).themes,
    ).toEqual(THEME_NAMES);
  });

  it("rejects unknown scene names", () => {
    expect(() => parseScreenshotOptions(["missing"])).toThrow(
      "Unknown screenshot: missing",
    );
  });

  it("rejects unknown themes", () => {
    expect(() => parseScreenshotOptions(["--theme", "missing"])).toThrow(
      "Unknown theme: missing",
    );
  });

  it("rejects separate scene arguments", () => {
    expect(() => parseScreenshotOptions(["dashboard", "listing"])).toThrow(
      "Choose one screenshot name, a comma-separated list, or all.",
    );
  });
});

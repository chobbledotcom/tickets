import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  parseScreenshotOptions,
  SCREENSHOT_NAMES,
  THEME_NAMES,
} from "#scripts/screenshots/options.ts";
import { SOCIAL_TARGET_NAMES } from "#scripts/screenshots/social.ts";

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

  it("loads an external scenario without built-in scenes", () => {
    expect(
      parseScreenshotOptions([
        "--scenario",
        "../tickets-site/scripts/screenshots/charity-events.js",
      ]),
    ).toEqual({
      names: [],
      outputDir: "screenshots",
      scenarioPath: "../tickets-site/scripts/screenshots/charity-events.js",
      themes: ["default"],
    });
  });

  it("accepts a single social target", () => {
    expect(
      parseScreenshotOptions(["dashboard", "--social", "facebook"]),
    ).toEqual({
      names: ["dashboard"],
      outputDir: "screenshots",
      social: ["facebook"],
      themes: ["default"],
    });
  });

  it("accepts a comma-separated list of social targets", () => {
    expect(
      parseScreenshotOptions([
        "dashboard",
        "--social",
        "facebook,instagram-square",
      ]).social,
    ).toEqual(["facebook", "instagram-square"]);
  });

  it("expands all social targets", () => {
    expect(
      parseScreenshotOptions(["dashboard", "--social", "all"]).social,
    ).toEqual(SOCIAL_TARGET_NAMES);
  });

  it("rejects unknown social targets", () => {
    expect(
      () => parseScreenshotOptions(["dashboard", "--social", "twitter"]).social,
    ).toThrow("Unknown social target: twitter");
  });

  it("rejects a scenario combined with a built-in scene", () => {
    expect(() =>
      parseScreenshotOptions(["listing", "--scenario", "charity-events.js"]),
    ).toThrow("A scenario cannot be combined with named screenshots.");
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

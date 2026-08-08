import { parseArgs } from "@std/cli/parse-args";
import { SOCIAL_TARGET_NAMES, type SocialTargetName } from "./social.ts";

export const SCREENSHOT_NAMES = [
  "dashboard",
  "attendees-list",
  "listing",
  "listing-attendees",
  "listing-form",
  "add-attendee-form",
  "calendar",
  "groups",
  "users",
  "settings",
  "activity-log",
  "sessions",
  "guide",
  "public-listing",
] as const;

export type ScreenshotName = (typeof SCREENSHOT_NAMES)[number];

export const THEME_NAMES = ["default", "forest", "sunset", "ink"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export interface ScreenshotOptions {
  elementSelector?: string;
  layers?: boolean;
  names: ScreenshotName[];
  outputDir: string;
  scenarioPath?: string;
  social?: SocialTargetName[];
  themes: ThemeName[];
}

const selections = <T extends string>(
  values: readonly T[],
  requested: string,
  label: string,
): T[] => {
  if (requested === "all") return [...values];
  const selected = requested.split(",");
  const unknown = selected.filter((value) => !values.includes(value as T));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown ${label}: ${unknown.join(", ")}. Choose from ${values.join(", ")}, or all.`,
    );
  }
  return selected as T[];
};

export const parseScreenshotOptions = (args: string[]): ScreenshotOptions => {
  const parsed = parseArgs(args, {
    alias: { o: "output", t: "theme" },
    boolean: ["layers"],
    default: { output: "screenshots", theme: "default" },
    string: ["element", "output", "scenario", "social", "theme"],
  });
  if (parsed._.length > 1) {
    throw new Error(
      "Choose one screenshot name, a comma-separated list, or all.",
    );
  }
  const requestedNames = String(parsed._[0] ?? "all");
  if (parsed.scenario && parsed._.length > 0) {
    throw new Error("A scenario cannot be combined with named screenshots.");
  }
  if (parsed.layers && !parsed.scenario) {
    throw new Error("Layers can only be captured from a scenario.");
  }
  return {
    ...(parsed.element ? { elementSelector: parsed.element } : {}),
    ...(parsed.layers ? { layers: true } : {}),
    names: parsed.scenario
      ? []
      : selections(SCREENSHOT_NAMES, requestedNames, "screenshot"),
    outputDir: parsed.output,
    ...(parsed.scenario ? { scenarioPath: parsed.scenario } : {}),
    ...(parsed.social
      ? {
          social: selections(
            SOCIAL_TARGET_NAMES,
            parsed.social,
            "social target",
          ),
        }
      : {}),
    themes: selections(THEME_NAMES, parsed.theme, "theme"),
  };
};

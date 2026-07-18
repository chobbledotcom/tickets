import { parseArgs } from "@std/cli/parse-args";

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
  names: ScreenshotName[];
  outputDir: string;
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
    default: { output: "screenshots", theme: "default" },
    string: ["element", "output", "theme"],
  });
  if (parsed._.length > 1) {
    throw new Error(
      "Choose one screenshot name, a comma-separated list, or all.",
    );
  }
  const requestedNames = String(parsed._[0] ?? "all");
  return {
    ...(parsed.element ? { elementSelector: parsed.element } : {}),
    names: selections(SCREENSHOT_NAMES, requestedNames, "screenshot"),
    outputDir: parsed.output,
    themes: selections(THEME_NAMES, parsed.theme, "theme"),
  };
};

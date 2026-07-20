import { toFileUrl } from "@std/path";
import type { Page } from "playwright";

export interface ScreenshotScenarioContext {
  balancePathFor: (attendeeId: number) => Promise<string>;
  baseUrl: string;
  page: Page;
  submit: (formSelector: string) => Promise<void>;
}

export interface ScreenshotScenario {
  css: string;
  elementSelector?: string;
  fullPage?: boolean;
  name: string;
  run: (context: ScreenshotScenarioContext) => Promise<void>;
  setupUsername?: string;
}

const isScenario = (value: unknown): value is ScreenshotScenario => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.css === "string" &&
    typeof candidate.name === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.name) &&
    typeof candidate.run === "function" &&
    (candidate.setupUsername === undefined ||
      (typeof candidate.setupUsername === "string" &&
        candidate.setupUsername.trim().length > 0)) &&
    (candidate.elementSelector === undefined ||
      typeof candidate.elementSelector === "string") &&
    (candidate.fullPage === undefined ||
      typeof candidate.fullPage === "boolean")
  );
};

export const loadScreenshotScenario = async (
  path: string,
): Promise<ScreenshotScenario> => {
  const loaded = await import(toFileUrl(path).href);
  if (!isScenario(loaded.default)) {
    throw new Error(`Invalid screenshot scenario: ${path}`);
  }
  if (loaded.default.elementSelector && loaded.default.fullPage) {
    throw new Error(
      "A screenshot scenario cannot use elementSelector and fullPage together.",
    );
  }
  return loaded.default;
};

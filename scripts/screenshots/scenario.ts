import { toFileUrl } from "@std/path";
import type { Page } from "playwright";
import * as v from "valibot";
import { optionalStringThat } from "#shared/validation/string.ts";

export interface ScreenshotScenarioContext {
  balancePathFor: (attendeeId: number) => Promise<string>;
  baseUrl: string;
  page: Page;
  submit: (formSelector: string) => Promise<void>;
}

type RunScreenshotScenario = (
  context: ScreenshotScenarioContext,
) => Promise<void>;

const ScreenshotScenarioSchema = v.object({
  adminSetup: v.optional(v.boolean()),
  css: v.string(),
  elementSelector: v.optional(v.string()),
  fullPage: v.optional(v.boolean()),
  name: v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  run: v.custom<RunScreenshotScenario>((value) => typeof value === "function"),
  setupUsername: optionalStringThat((value) => value.trim().length > 0),
});

export type ScreenshotScenario = v.InferOutput<typeof ScreenshotScenarioSchema>;

export const loadScreenshotScenario = async (
  path: string,
): Promise<ScreenshotScenario> => {
  const loaded = await import(toFileUrl(path).href);
  const parsed = v.safeParse(ScreenshotScenarioSchema, loaded.default);
  if (!parsed.success) {
    throw new Error(`Invalid screenshot scenario: ${path}`);
  }
  if (parsed.output.elementSelector && parsed.output.fullPage) {
    throw new Error(
      "A screenshot scenario cannot use elementSelector and fullPage together.",
    );
  }
  return parsed.output;
};

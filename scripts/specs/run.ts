import { join } from "node:path";
import {
  type IRunConfiguration,
  loadConfiguration,
  runCucumber,
} from "@cucumber/cucumber/api";
import type { Envelope } from "@cucumber/messages";
import { projectRoot } from "#scripts/project-root.ts";
import { readSpecCatalog } from "./catalog.ts";
import { messageIssues } from "./messages.ts";
import { shouldCheckUnusedSteps } from "./options.ts";

export interface RunSpecsOptions {
  paths?: string[];
  reports?: boolean;
  tags?: string;
}

export interface SpecRunSummary {
  success: boolean;
}

interface CompleteRunSpecsOptions {
  enforceUnused: boolean;
  paths: string[];
  reports: boolean;
  tags: string;
}

const REPORT_DIR = join(projectRoot, "reports");
const DEFAULT_SUPPORT = [
  "test/specs/support/**/*.ts",
  "test/specs/steps/**/*.ts",
];
const reportFormats = (reports: boolean): string[] =>
  reports
    ? [
        "progress",
        `message:${join(REPORT_DIR, "cucumber.ndjson")}`,
        `html:${join(REPORT_DIR, "cucumber.html")}`,
        `junit:${join(REPORT_DIR, "cucumber.junit.xml")}`,
      ]
    : ["progress"];

const cucumberConfiguration = async (
  options: CompleteRunSpecsOptions,
): Promise<IRunConfiguration> => {
  if (options.reports) await Deno.mkdir(REPORT_DIR, { recursive: true });
  const { runConfiguration } = await loadConfiguration(
    {
      file: false,
      provided: {
        format: reportFormats(options.reports),
        import: DEFAULT_SUPPORT,
        order: "defined",
        parallel: 0,
        paths: options.paths,
        publish: false,
        retry: 0,
        strict: true,
        tags: options.tags,
      },
    },
    { cwd: projectRoot },
  );
  return runConfiguration;
};

export const runSpecs = async (
  options: RunSpecsOptions = {},
): Promise<SpecRunSummary> => {
  const paths = options.paths ?? ["specs"];
  await readSpecCatalog(paths);
  const complete: CompleteRunSpecsOptions = {
    enforceUnused: shouldCheckUnusedSteps(options),
    paths,
    reports: options.reports ?? true,
    tags: options.tags ?? "",
  };
  const messages: Envelope[] = [];
  const result = await runCucumber(
    await cucumberConfiguration(complete),
    { cwd: projectRoot },
    (message) => messages.push(message),
  );
  const issues = messageIssues(messages, complete.enforceUnused);
  for (const issue of issues) console.error(issue);
  return {
    success: result.success && issues.length === 0,
  };
};

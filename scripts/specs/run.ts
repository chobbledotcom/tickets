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
import { selectSpecCases } from "./selection.ts";

export interface RunSpecsOptions {
  paths?: string[];
  reports?: boolean;
  tags?: string;
}

export interface SpecRunSummary {
  success: boolean;
}

export interface SpecRunEnvironment {
  reportDir: string;
  support: string[];
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
const DEFAULT_ENVIRONMENT: SpecRunEnvironment = {
  reportDir: REPORT_DIR,
  support: DEFAULT_SUPPORT,
};
const reportFormats = (reports: boolean, reportDir: string): string[] =>
  reports
    ? [
        "progress",
        `message:${join(reportDir, "cucumber.ndjson")}`,
        `html:${join(reportDir, "cucumber.html")}`,
        `junit:${join(reportDir, "cucumber.junit.xml")}`,
      ]
    : ["progress"];

const cucumberConfiguration = async (
  options: CompleteRunSpecsOptions,
  environment: SpecRunEnvironment,
): Promise<IRunConfiguration> => {
  const { runConfiguration } = await loadConfiguration(
    {
      file: false,
      provided: {
        format: reportFormats(options.reports, environment.reportDir),
        import: environment.support,
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

const prepareReports = async (reportDir: string): Promise<void> => {
  try {
    await Deno.remove(reportDir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir(reportDir, { recursive: true });
};

export const runSpecs = async (
  options: RunSpecsOptions = {},
  environment: SpecRunEnvironment = DEFAULT_ENVIRONMENT,
): Promise<SpecRunSummary> => {
  const paths = options.paths ?? ["specs"];
  if (options.reports ?? true) await prepareReports(environment.reportDir);
  const catalog = await readSpecCatalog(paths);
  const selectedPaths =
    options.tags === undefined ? paths : selectSpecCases(catalog, options.tags);
  const complete: CompleteRunSpecsOptions = {
    enforceUnused: shouldCheckUnusedSteps(options),
    paths: selectedPaths.length > 0 ? selectedPaths : paths,
    reports: options.reports ?? true,
    tags:
      selectedPaths.length === 0 && options.tags !== undefined
        ? "@__tickets_no_matching_case__"
        : "",
  };
  const messages: Envelope[] = [];
  const result = await runCucumber(
    await cucumberConfiguration(complete, environment),
    { cwd: projectRoot },
    (message) => messages.push(message),
  );
  const issues = messageIssues(messages, complete.enforceUnused);
  for (const issue of issues) console.error(issue);
  return {
    success: result.success && issues.length === 0,
  };
};

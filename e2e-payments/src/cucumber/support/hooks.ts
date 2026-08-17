// jscpd:ignore-start -- imports

import { readFile } from "node:fs/promises";
import {
  After,
  AfterStep,
  Before,
  type ITestCaseHookParameter,
  setDefaultTimeout,
  setWorldConstructor,
} from "@cucumber/cucumber";
import {
  type Examples,
  type GherkinDocument,
  type Pickle,
  TestStepResultStatus,
} from "@cucumber/messages";
import { launchAppBrowser } from "#e2e/browser.ts";
import {
  attemptEveryCleanup,
  cleanupErrorForScenario,
  type NamedCleanup,
} from "#e2e/cleanup.ts";
import { config, needsTunnel, providerSecrets } from "#e2e/config.ts";
import { log, warn } from "#e2e/log.ts";
import { providers } from "#e2e/providers/index.ts";
import { startAppServer } from "#e2e/server.ts";
import { noTunnel, startTunnel } from "#e2e/tunnel.ts";
import { LiveWorld } from "./world.ts";

// jscpd:ignore-end

setDefaultTimeout(config.stepTimeoutMs);

setWorldConstructor(LiveWorld);

/** The `@case:<id>` tag of the scenario being run, when it carries one. */
const caseIdFromTag = (pickle: Pickle): string | null => {
  const tag = pickle.tags.find((t) => t.name.startsWith("@case:"));
  return tag ? tag.name.slice("@case:".length) : null;
};

/** The `case_id` cell of the Examples row a Scenario Outline pickle came
 * from, reached through the pickle's row AST node. */
const caseIdFromOutlineRow = (
  document: GherkinDocument,
  rowId: string,
): string | null => {
  const feature = document.feature;
  if (feature === undefined) return null;
  for (const child of feature.children) {
    const rule = child.rule;
    if (rule === undefined) continue;
    for (const ruleChild of rule.children) {
      const outline = ruleChild.scenario;
      if (outline === undefined || outline.examples.length === 0) continue;
      const found = caseIdInExamples(outline.examples, rowId);
      if (found !== null) return found;
    }
  }
  return null;
};

const caseIdInExamples = (
  examplesList: readonly Examples[],
  rowId: string,
): string | null => {
  for (const examples of examplesList) {
    const header = examples.tableHeader?.cells.map((c) => c.value) ?? [];
    const caseColumn = header.indexOf("case_id");
    for (const row of examples.tableBody) {
      if (row.id !== rowId) continue;
      const id = row.cells[caseColumn]?.value.trim();
      if (id !== undefined && id !== "") return id;
    }
  }
  return null;
};

/** The case id of the scenario being run: from its `@case:` tag, or from the
 * Examples `case_id` cell of the row a Scenario Outline pickle came from. */
const caseIdOf = (hook: ITestCaseHookParameter): string => {
  const fromTag = caseIdFromTag(hook.pickle);
  if (fromTag !== null) return fromTag;
  const rowId = hook.pickle.astNodeIds.at(-1);
  const fromRow =
    rowId !== undefined
      ? caseIdFromOutlineRow(hook.gherkinDocument, rowId)
      : null;
  if (fromRow !== null) return fromRow;
  throw new Error(
    `scenario "${hook.pickle.name}" carries no case id the harness can resolve`,
  );
};

Before(
  { timeout: config.startupTimeoutMs },
  async function (this: LiveWorld, hook: ITestCaseHookParameter) {
    this.beginScenario(caseIdOf(hook));
    log(`— scenario ${this.scenario.caseId} (run ${this.scenario.runId})`);
    this.recordPhase("starting-infrastructure");

    const server = await startAppServer();
    const tunnel = needsTunnel(this.target)
      ? await startTunnel(server.port)
      : noTunnel(server.localBaseUrl);
    const browser = await launchAppBrowser(tunnel.publicBaseUrl);
    this.attachInfra({
      browser,
      owner: await browser.session(`${this.scenario.caseId}-owner`),
      server,
      tunnel,
      visitor: await browser.session(`${this.scenario.caseId}-visitor`),
    });

    if (this.target !== "free") {
      const driver = providers[this.target];
      this.setPaidProvider(driver, providerSecrets(this.target));
    }
    this.recordPhase("infrastructure-ready");
    await this.saveJournal();
  },
);

AfterStep(function (this: LiveWorld, { result }): void {
  if (
    result.status !== TestStepResultStatus.PASSED &&
    result.status !== TestStepResultStatus.SKIPPED
  ) {
    this.stepFailed = true;
  }
});

After(
  { timeout: config.teardownTimeoutMs },
  async function (this: LiveWorld, hook: ITestCaseHookParameter) {
    const caseId = caseIdOf(hook);
    const infra = this.infraMaybe;
    if (infra === null) {
      // Startup itself failed: nothing to sweep but the journal.
      await this.saveJournal().catch(() => {});
      return;
    }

    // Diagnostics first, while the browser is still alive: a case-id-scoped
    // screenshot and HTML per session, the final journal, and — only when a step
    // failed — a bounded screenshot plus server-log tail attached to the report.
    const capture = attemptEveryCleanup([
      {
        name: "failure screenshots",
        run: async () => {
          if (!this.stepFailed) return;
          await infra.owner.dumpPage("scenario-failed").catch(() => {});
          await infra.visitor.dumpPage("scenario-failed").catch(() => {});
        },
      },
      {
        name: "attached diagnostics",
        run: async () => {
          if (!this.stepFailed) return;
          const png = await infra.owner.page.screenshot().catch(() => null);
          if (png) {
            await this.attach(png, {
              fileName: `${caseId}-failure.png`,
              mediaType: "image/png",
            });
          }
          const logTail = (
            await readFile(infra.server.logPath, "utf8").catch(() => "")
          )
            .split("\n")
            .slice(-40)
            .join("\n");
          await this.attach(logTail, {
            fileName: `${caseId}-server-tail.txt`,
            mediaType: "text/plain",
          });
        },
      },
      {
        name: "scenario journal",
        run: () => this.saveJournal(),
      },
    ]);
    const captured = await capture;

    const fault = this.installedFault;
    const paid = this.target === "free" ? null : this.paidProvider;
    const teardownSteps: NamedCleanup[] = [
      ...(fault ? [{ name: "database fault", run: () => fault.remove() }] : []),
      {
        name: "browser",
        // Closing the browser process closes every session's context with it;
        // browser.stop bounds the graceful close and hard-kills the process.
        run: () => infra.browser.stop(),
      },
      ...(paid
        ? [
            {
              name: `${this.target} provider resources`,
              run: () =>
                paid.provider.cleanup(
                  { publicBaseUrl: infra.tunnel.publicBaseUrl },
                  paid.secrets,
                ),
            },
          ]
        : []),
      { name: "tunnel", run: () => infra.tunnel.stop() },
      { name: "app server", run: () => infra.server.stop() },
    ];
    const teardown = await attemptEveryCleanup(teardownSteps);

    const outcome = { errors: [...captured.errors, ...teardown.errors] };
    for (const error of outcome.errors) {
      warn(`${caseId}: ${error.message}`);
    }
    const failure = cleanupErrorForScenario(outcome, this.stepFailed);
    if (failure) throw failure;
  },
);

/**
 * The preview command. The deploy workflow calls it for one branch:
 *
 *   ensure <branch> <bundle-file>  create the preview, or complete a half-made
 *                                  one. Prints script_id, site_url and
 *                                  published as key=value lines on stdout.
 *   configure <site-url>           complete the setup of a new preview and save
 *                                  its payment providers. A site that is set
 *                                  up is left as it is.
 *   remove <branch>                delete the preview and its webhooks.
 *
 * Progress and errors go to stderr, so stdout holds only the output lines.
 */

import { withAccessKey, withParsedArgs } from "#scripts/deploy-edge-lib.ts";
import type { FetchText } from "#scripts/fetch-text.ts";
import { type PreviewApi, previewApi } from "#scripts/preview/bunny-api.ts";
import { configureSite } from "#scripts/preview/configure.ts";
import { readCopiedSecrets } from "#scripts/preview/copied-secrets.ts";
import { ensurePreview } from "#scripts/preview/ensure.ts";
import { type PreviewNames, previewNames } from "#scripts/preview/names.ts";
import { removePreview } from "#scripts/preview/remove.ts";
import { createSiteClient, type Send } from "#scripts/preview/site-client.ts";
import { readSitePlan, readStripeKey } from "#scripts/preview/site-plan.ts";
import { mapped } from "#scripts/preview/steps.ts";
import { removeWebhooks } from "#scripts/preview/stripe-webhooks.ts";
import type { ScriptIo } from "#scripts/script-runner.ts";
import type { Result } from "#shared/result.ts";
import { siteBaseUrl } from "#shared/site-address.ts";

export const PREVIEW_USAGE =
  "Usage: deno run scripts/preview.ts ensure <branch> <bundle-file>\n" +
  "       deno run scripts/preview.ts configure <site-url>\n" +
  "       deno run scripts/preview.ts remove <branch>";

/** A new site can take a few minutes to start and to resolve. */
const WAIT_ATTEMPTS = 18;
const WAIT_DELAY_MS = 10_000;

export interface PreviewIo extends ScriptIo {
  fetchText: FetchText;
  newEncryptionKey: () => string;
  newScheduledTaskKey: () => string;
  readTextFile: (path: string) => Promise<string>;
  /** Send one request to a site, without following a redirect. */
  send: Send;
  sleep: (ms: number) => Promise<void>;
}

type EnsureCommand = { branch: string; file: string; kind: "ensure" };
type RemoveCommand = { branch: string; kind: "remove" };
type ConfigureCommand = { kind: "configure"; siteUrl: string };

type Command = EnsureCommand | RemoveCommand | ConfigureCommand;

/** What a finished command says: one line for the log, and the output lines
 * for the workflow. */
type Report = { message: string; outputs: string[] };

const USAGE_ERROR = { error: PREVIEW_USAGE, ok: false } as const;

const parseCommand = (
  args: string[],
): ({ ok: true } & Command) | typeof USAGE_ERROR => {
  const [kind, first, second, ...extra] = args.map((arg) => arg.trim());
  if (first === undefined || first === "" || extra.length > 0) {
    return USAGE_ERROR;
  }
  if (kind === "remove" && second === undefined) {
    return { branch: first, kind, ok: true };
  }
  if (kind === "configure" && second === undefined) {
    return { kind, ok: true, siteUrl: first };
  }
  if (kind === "ensure" && second !== undefined && second !== "") {
    return { branch: first, file: second, kind, ok: true };
  }
  return USAGE_ERROR;
};

/** What a command on one branch works on: the Bunny calls and the names. */
type Target = { api: PreviewApi; io: PreviewIo; names: PreviewNames };

/** Read the build environment values that a command needs, then run the
 * command with them. A missing value fails the run before anything else. */
const withEnv = <Value>(
  io: PreviewIo,
  read: (getEnv: PreviewIo["getEnv"]) => Result<Value>,
  run: (value: Value) => Promise<Result<Report>>,
): Promise<Result<Report>> => {
  const value = read(io.getEnv);
  return value.ok ? run(value.value) : Promise.resolve(value);
};

const ensureReport = (
  { api, io, names }: Target,
  command: EnsureCommand,
): Promise<Result<Report>> =>
  withEnv(io, readCopiedSecrets, async (copiedSecrets) =>
    mapped(
      await ensurePreview(api, {
        code: await io.readTextFile(command.file),
        copiedSecrets,
        names,
        newEncryptionKey: io.newEncryptionKey,
        newScheduledTaskKey: io.newScheduledTaskKey,
      }),
      ({ published, scriptId, siteUrl }) => ({
        message: `Preview "${names.scriptName}" is ready. This run ${published ? "published" : "did not publish"} the code.`,
        outputs: [
          `script_id=${scriptId}`,
          `site_url=${siteUrl}`,
          `published=${published}`,
        ],
      }),
    ),
  );

const removeReport = ({ api, io, names }: Target): Promise<Result<Report>> =>
  withEnv(io, readStripeKey, async (secretKey) =>
    mapped(
      await removePreview(api, names, (hosts) =>
        removeWebhooks({ fetchText: io.fetchText, secretKey }, hosts),
      ),
      (removed) => ({
        message:
          removed.length === 0
            ? `Preview "${names.scriptName}" does not exist. Nothing to delete.`
            : `Deleted preview "${names.scriptName}": ${removed.join(", ")}.`,
        outputs: [],
      }),
    ),
  );

const configureReport = (
  io: PreviewIo,
  command: ConfigureCommand,
): Promise<Result<Report>> =>
  withEnv(io, readSitePlan, async (plan) =>
    mapped(
      await configureSite(
        createSiteClient(siteBaseUrl(command.siteUrl), io.send),
        plan,
        { attempts: WAIT_ATTEMPTS, delayMs: WAIT_DELAY_MS, sleep: io.sleep },
      ),
      (lines) => ({ message: lines.join("\n"), outputs: [] }),
    ),
  );

/** Print what a command reports, and give its exit code. */
const finish = async (
  io: PreviewIo,
  report: Promise<Result<Report>>,
): Promise<number> => {
  const done = await report;
  if (!done.ok) {
    io.stderr(done.error);
    return 1;
  }
  io.stderr(done.value.message);
  for (const line of done.value.outputs) io.stdout(line);
  return 0;
};

/** The commands that act on the Bunny resources of one branch. */
const onBranch = async (
  io: PreviewIo,
  accessKey: string,
  command: EnsureCommand | RemoveCommand,
): Promise<Result<Report>> => {
  const target: Target = {
    api: previewApi({ accessKey, fetchText: io.fetchText }),
    io,
    names: await previewNames(command.branch),
  };
  return command.kind === "ensure"
    ? ensureReport(target, command)
    : removeReport(target);
};

export const runPreview = (io: PreviewIo): Promise<number> =>
  withParsedArgs<Command>(io, parseCommand(io.args), (command) =>
    command.kind === "configure"
      ? finish(io, configureReport(io, command))
      : withAccessKey(io, (accessKey) =>
          finish(io, onBranch(io, accessKey, command)),
        ),
  );

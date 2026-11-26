/**
 * The preview command. The deploy workflow calls it for one branch:
 *
 *   ensure <branch> <bundle-file>  create the preview, or complete a half-made
 *                                  one. Prints script_id, site_url and
 *                                  published as key=value lines on stdout.
 *   remove <branch>                delete the preview.
 *
 * Progress and errors go to stderr, so stdout holds only the output lines.
 */

import { withAccessKey, withParsedArgs } from "#scripts/deploy-edge-lib.ts";
import type { FetchText } from "#scripts/fetch-text.ts";
import { type PreviewApi, previewApi } from "#scripts/preview/bunny-api.ts";
import { readCopiedSecrets } from "#scripts/preview/copied-secrets.ts";
import { ensurePreview } from "#scripts/preview/ensure.ts";
import { type PreviewNames, previewNames } from "#scripts/preview/names.ts";
import { removePreview } from "#scripts/preview/remove.ts";
import type { ScriptIo } from "#scripts/script-runner.ts";
import { okResult, type Result } from "#shared/result.ts";

export const PREVIEW_USAGE =
  "Usage: deno run scripts/preview.ts ensure <branch> <bundle-file>\n" +
  "       deno run scripts/preview.ts remove <branch>";

export interface PreviewIo extends ScriptIo {
  fetchText: FetchText;
  newEncryptionKey: () => string;
  newScheduledTaskKey: () => string;
  readTextFile: (path: string) => Promise<string>;
}

type Command =
  | { branch: string; file: string; kind: "ensure" }
  | { branch: string; kind: "remove" };

/** What a finished command says: one line for the log, and the output lines
 * for the workflow. */
type Report = { message: string; outputs: string[] };

const USAGE_ERROR = { error: PREVIEW_USAGE, ok: false } as const;

const parseCommand = (
  args: string[],
): ({ ok: true } & Command) | typeof USAGE_ERROR => {
  const [kind, branch, file, ...extra] = args.map((arg) => arg.trim());
  if (branch === undefined || branch === "" || extra.length > 0) {
    return USAGE_ERROR;
  }
  if (kind === "remove" && file === undefined) {
    return { branch, kind, ok: true };
  }
  if (kind === "ensure" && file !== undefined && file !== "") {
    return { branch, file, kind, ok: true };
  }
  return USAGE_ERROR;
};

/** What every command works on: the Bunny calls and the names of one branch. */
type Target = { api: PreviewApi; io: PreviewIo; names: PreviewNames };

const ensureReport = async (
  { api, io, names }: Target,
  command: Extract<Command, { kind: "ensure" }>,
): Promise<Result<Report>> => {
  const copiedSecrets = readCopiedSecrets(io.getEnv);
  if (!copiedSecrets.ok) return copiedSecrets;
  const ensured = await ensurePreview(api, {
    code: await io.readTextFile(command.file),
    copiedSecrets: copiedSecrets.value,
    names,
    newEncryptionKey: io.newEncryptionKey,
    newScheduledTaskKey: io.newScheduledTaskKey,
  });
  if (!ensured.ok) return ensured;
  const { published, scriptId, siteUrl } = ensured.value;
  return okResult({
    message: `Preview "${names.scriptName}" is ready. This run ${published ? "published" : "did not publish"} the code.`,
    outputs: [
      `script_id=${scriptId}`,
      `site_url=${siteUrl}`,
      `published=${published}`,
    ],
  });
};

const removeReport = async ({
  api,
  names,
}: Target): Promise<Result<Report>> => {
  const removed = await removePreview(api, names);
  if (!removed.ok) return removed;
  return okResult({
    message:
      removed.value.length === 0
        ? `Preview "${names.scriptName}" does not exist. Nothing to delete.`
        : `Deleted preview "${names.scriptName}": ${removed.value.join(", ")}.`,
    outputs: [],
  });
};

const runCommand = (io: PreviewIo, accessKey: string): Promise<number> =>
  withParsedArgs<Command>(io, parseCommand(io.args), async (command) => {
    const target: Target = {
      api: previewApi({ accessKey, fetchText: io.fetchText }),
      io,
      names: await previewNames(command.branch),
    };
    const report =
      command.kind === "ensure"
        ? await ensureReport(target, command)
        : await removeReport(target);
    if (!report.ok) {
      io.stderr(report.error);
      return 1;
    }
    io.stderr(report.value.message);
    for (const line of report.value.outputs) io.stdout(line);
    return 0;
  });

export const runPreview = (io: PreviewIo): Promise<number> =>
  withAccessKey(io, (accessKey) => runCommand(io, accessKey));

/**
 * IO shell for the e2e label check: reads the message catalog, walks the
 * payment e2e sources, and reports what the pure rules in `rules.ts` flag.
 */

/* jscpd:ignore-start */
import * as v from "valibot";
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { readJsonOrNull } from "#scripts/read-json.ts";
import { collectFiles, collectSourceFiles } from "#scripts/walk-files.ts";
import { type CatalogCopy, findLabelIssues } from "./rules.ts";
/* jscpd:ignore-end */

/** Where the app's words live — the only source the e2e may quote. */
export const CATALOG_DIR = "src/locales/en";

/** The tree whose clicks and assertions are held to the catalog. */
export const SCAN_ROOT = "e2e-payments/src";

/** One locale file: dotted message keys ("settings.payment_provider"). */
const CatalogFileSchema = v.record(
  v.pipe(v.string(), v.regex(/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/)),
  v.string(),
);

/**
 * The catalog as the check needs it, or null when it cannot be read. A
 * caller with no catalog has nothing to check against. The runner reports
 * that, so silence cannot pass as a clean run.
 */
export const readCatalog = async (dir: string): Promise<CatalogCopy | null> => {
  let files: string[];
  try {
    files = await collectFiles(dir, (path) => path.endsWith(".json"));
  } catch (err) {
    // A catalog directory that is not there has nothing to check against;
    // anything else (permissions, a broken symlink) is a real fault.
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    return null;
  }
  if (files.length === 0) return null;
  const keys = new Set<string>();
  const values: string[] = [];
  for (const path of files) {
    const messages = await readJsonOrNull(path, CatalogFileSchema);
    if (messages === null) return null;
    for (const [key, message] of Object.entries(messages)) {
      keys.add(key);
      values.push(message);
    }
  }
  return { keys, values };
};

/**
 * Check every label the payment e2e clicks or asserts. Returns the process
 * exit code: 0 when the driver's words all come from the catalog.
 */
export const runLabelCheck = async (
  catalogDir: string,
  scanRoot: string,
  output: CheckOutput,
): Promise<number> => {
  const catalog = await readCatalog(catalogDir);
  if (catalog === null) {
    output.logError(`Cannot read the message catalog in ${catalogDir}.`);
    return 1;
  }
  const files = await collectSourceFiles(scanRoot);
  const found = (
    await Promise.all(
      files.map(async (file) =>
        findLabelIssues(await Deno.readTextFile(file), catalog).map(
          (issue) => `${file}:${issue.line} ${issue.message}`,
        ),
      ),
    )
  ).flat();
  return reportCheck({
    ...output,
    found,
    guide: "the saveCredentials step and `deno task check:e2e-labels`",
    noun: "label",
    success:
      "Every label the payment e2e clicks or asserts is copy the " +
      "message catalog renders.",
  });
};

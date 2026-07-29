/**
 * The look a capture is shown in.
 *
 * A screenshot's styling belongs to whoever publishes it, not to the app: it
 * is a demonstration of what an organiser's own branding does to these pages,
 * and the app has no opinion about that. So the CSS lives outside this repo
 * and is handed in as a directory of files named after the captures.
 *
 * With no directory given, a capture is taken in the app's own default look,
 * which is what this repo's own CI does. With a directory given, every capture
 * must have a file in it: a missing one would silently publish a screenshot in
 * the wrong clothes, which is exactly the kind of quiet difference these
 * captures exist to prevent.
 */

import { join } from "@std/path";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";

export const EVIDENCE_THEMES_ENV = "TICKETS_EVIDENCE_THEMES";

/** Reads one capture's CSS from the directory the run was given. */
export type ReadEvidenceTheme = (captureId: string) => Promise<string>;

export const defineThemeReader = (
  readTextFile: (path: string) => Promise<string>,
  askForDirectory: () => string | undefined,
): ReadEvidenceTheme => {
  return async (captureId) => {
    // Asked for on each capture rather than when this module loads: the
    // captures run in a process that is handed the directory as it starts, and
    // reading it once at import time is a race nobody would see the loss from.
    const directory = askForDirectory();
    if (!directory) return "";
    const path = join(directory, `${captureId}.css`);
    try {
      return await readTextFile(path);
    } catch (error) {
      rethrowUnlessNotFound(error);
      throw new Error(
        `No evidence theme for ${captureId}: ${path} does not exist. Every capture needs one when a theme directory is given.`,
      );
    }
  };
};

export const readEvidenceTheme: ReadEvidenceTheme = defineThemeReader(
  Deno.readTextFile,
  () => Deno.env.get(EVIDENCE_THEMES_ENV),
);

/** The themes directory, ready to hand to the process that does the capturing.
 * Empty when none was asked for, so the child inherits nothing. */
export const evidenceThemesEnv = (): Record<string, string> => {
  const directory = Deno.env.get(EVIDENCE_THEMES_ENV);
  return directory ? { [EVIDENCE_THEMES_ENV]: directory } : {};
};

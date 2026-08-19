import { afterEach, beforeEach } from "@std/testing/bdd";
import type { CheckOutput } from "#scripts/check-report.ts";

/** A fresh temp tree, plus whatever a check printed while it ran. */
export interface CheckScriptRun {
  /** Lines the check sent to its error logger. */
  errors: string[];
  /** Lines the check sent to its normal logger. */
  logs: string[];
  /** Where the check under test sends its output. */
  output: CheckOutput;
  /** The temp folder, remade before every test. */
  readonly path: string;
  /** Write one file below the temp folder, making the folders it needs. */
  write: (path: string, body: string) => Promise<void>;
}

/**
 * A temp tree and captured output for one check script's tests. Call it inside
 * a `describe`, because it registers hooks and a hook at module level would
 * stop the file sharing an isolate with the rest of the suite.
 */
export const checkScriptRun = (): CheckScriptRun => {
  const state = { path: "" };
  const errors: string[] = [];
  const logs: string[] = [];

  beforeEach(async () => {
    state.path = await Deno.makeTempDir();
    errors.length = 0;
    logs.length = 0;
  });
  afterEach(async () => await Deno.remove(state.path, { recursive: true }));

  return {
    errors,
    logs,
    output: {
      log: (line: string) => logs.push(line),
      logError: (line: string) => errors.push(line),
    },
    get path() {
      return state.path;
    },
    write: async (path: string, body: string) => {
      const full = `${state.path}/${path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(full, body);
    },
  };
};

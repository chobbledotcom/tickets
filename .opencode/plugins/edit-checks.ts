// After each file edit: run Biome on the edited file (it fixes what it can
// in place), then run the repo's jscpd configs that scan the edited file's
// tree. Both results are appended to the tool output the model sees.
import { isAbsolute, relative } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
// Relative paths: the plugin runs in OpenCode's Bun host, which does not
// read deno.json's import map.
import { createPipeline } from "../../scripts/edit-checks/pipeline.ts";
import { createRunner } from "../../scripts/edit-checks/runner.ts";

export default (async ({ worktree }) => {
  const checks = createPipeline({ runTool: createRunner({ worktree }) });
  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "edit" && input.tool !== "write") return;
      const raw: unknown = input.args?.filePath;
      if (typeof raw !== "string") return;
      const relPath = (isAbsolute(raw) ? relative(worktree, raw) : raw)
        .replaceAll("\\", "/")
        .replace(/^\.\//, "");
      if (relPath.startsWith("..")) return;
      try {
        const text = await checks(relPath);
        if (text !== "") output.output += `\n\n${text}`;
      } catch (err) {
        output.output += `\n\nedit-checks hook failed: ${err}`;
      }
    },
  };
}) satisfies Plugin;

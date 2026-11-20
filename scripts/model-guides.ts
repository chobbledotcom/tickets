import { generateModelGuidePages } from "#scripts/model-guides/check.ts";
import { readTextFileOrNull } from "#scripts/not-found.ts";
import { rejectArgs, runDenoScript } from "#scripts/script-runner.ts";

const DIRECTORY = "docs/model-guides";

await runDenoScript(async (io) => {
  const usage = rejectArgs(io, "model-guides");
  if (usage !== undefined) return usage;
  const pages = await generateModelGuidePages();
  await Deno.mkdir(DIRECTORY, { recursive: true });
  const changed: string[] = [];
  for (const [name, content] of pages) {
    const path = `${DIRECTORY}/${name}`;
    if ((await readTextFileOrNull(path)) === content) continue;
    await Deno.writeTextFile(path, content);
    changed.push(path);
  }
  if (changed.length === 0) {
    io.stdout(`Model guides are up to date (${pages.size} pages).`);
    return 0;
  }
  for (const path of changed) io.stdout(`Wrote ${path}`);
  io.stdout(
    `Wrote ${changed.length} of ${pages.size} pages. Review the changed text.`,
  );
  return 0;
});

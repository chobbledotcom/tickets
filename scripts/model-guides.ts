import { generateModelGuidePages } from "#scripts/model-guides/check.ts";
import { renderSitePages } from "#scripts/model-guides/site.ts";
import { rejectArgs, runDenoScript } from "#scripts/script-runner.ts";

const OUTPUT = "docs-output/models";

await runDenoScript(async (io) => {
  const usage = rejectArgs(io, "model-guides");
  if (usage !== undefined) return usage;
  const pages = renderSitePages(await generateModelGuidePages());
  await Deno.mkdir(OUTPUT, { recursive: true });
  for (const [name, content] of pages) {
    await Deno.writeTextFile(`${OUTPUT}/${name}`, content);
  }
  io.stdout(`Wrote ${pages.size} model pages to ${OUTPUT}.`);
  return 0;
});

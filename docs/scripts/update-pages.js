import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setupTemplate } from "./template-utils.js";
import { exists, fs, path, read, spawn, write } from "./utils.js";

const TEMPLATE_RAW_URL =
  "https://raw.githubusercontent.com/chobbledotcom/chobble-template/refs/heads/main/.pages.yml";

/**
 * Copy local page-layout JSON files into the template's page-layouts directory.
 * Skips silently if no local page-layouts directory exists.
 */
const copyLocalPageLayouts = (templatePageLayouts) => {
  const localPageLayouts = path("_data", "page-layouts");
  if (!fs.exists(localPageLayouts)) return;

  const jsonFiles = readdirSync(localPageLayouts).filter((f) =>
    f.endsWith(".json"),
  );
  for (const file of jsonFiles) {
    cpSync(join(localPageLayouts, file), join(templatePageLayouts, file));
  }
  if (jsonFiles.length > 0) {
    console.log(`Copied ${jsonFiles.length} local page-layout(s) to template`);
  }
};

const fetchPages = async () => {
  console.log("Fetching .pages.yml from chobble-template...");

  const res = await fetch(TEMPLATE_RAW_URL);
  if (!res.ok) throw new Error(`Failed to fetch .pages.yml: ${res.status}`);

  await write(".pages.yml", (await res.text()).replace(/src\//g, ""));
  console.log("Updated .pages.yml from chobble-template (with src/ removed)");
};

const customisePages = async ({ args = [] } = {}) => {
  const { tempDir, cleanup } = await setupTemplate({ mergeSite: false });

  try {
    // Remove template's page-layouts and replace with local ones (if any)
    // so customise-cms uses our layouts, not the template defaults
    const templatePageLayouts = join(tempDir, "src", "_data", "page-layouts");
    fs.rm(templatePageLayouts);
    fs.mkdir(templatePageLayouts);
    copyLocalPageLayouts(templatePageLayouts);

    // Copy local site.json and .pages.yml to the template so customise-cms uses them as defaults
    const localSiteJson = path("_data", "site.json");
    const localPagesYml = path(".pages.yml");
    const templateSiteJson = join(tempDir, "src", "_data", "site.json");
    const templatePagesYml = join(tempDir, ".pages.yml");

    if (await exists(localSiteJson)) {
      console.log("Copying local site.json to template...");
      await write(templateSiteJson, await read(localSiteJson));
    }
    if (await exists(localPagesYml)) {
      console.log("Copying local .pages.yml to template...");
      // Add src/ prefix back when copying to template
      await write(
        templatePagesYml,
        (await read(localPagesYml)).replace(
          /^(\s+folder:\s*)(?!src\/)/gm,
          "$1src/",
        ),
      );
    }

    const cmsArgs =
      args.includes("--regenerate") || args.includes("-r")
        ? ["--regenerate"]
        : [];

    console.log("\nStarting CMS customisation...\n");

    const proc = spawn(["bun", "run", "customise-cms", ...cmsArgs], {
      cwd: tempDir,
      shell: true,
    });
    const code = await proc.exited;

    if (code !== 0) {
      throw new Error(`customise-cms exited with code ${code}`);
    }

    if (!(await exists(templatePagesYml))) {
      throw new Error("No .pages.yml found after customisation");
    }

    // Copy amended files back
    await write(
      ".pages.yml",
      (await read(templatePagesYml)).replace(/src\//g, ""),
    );
    await write(localSiteJson, await read(templateSiteJson));

    console.log("Updated .pages.yml and site.json with your customisations");
  } finally {
    cleanup();
  }
};

const updatePages = async ({ customise = false, args = [] } = {}) =>
  customise ? customisePages({ args }) : fetchPages();

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: bun run update-pages [options]

Options:
  --customise, -c    Run the interactive CMS customisation TUI
  --regenerate, -r   Non-interactive: regenerate using saved site.json config
  --help, -h         Show this help message

Without options, fetches the latest .pages.yml from chobble-template.
With --customise, clones chobble-template and runs the customise-cms TUI
to let you select which collections to include.
With --customise --regenerate, runs non-interactively using saved config.`);
    process.exit(0);
  }

  const customise = args.includes("--customise") || args.includes("-c");

  updatePages({ customise, args }).catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}

export { updatePages, fetchPages, customisePages };

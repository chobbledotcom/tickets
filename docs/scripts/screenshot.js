import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setupTemplate } from "./template-utils.js";
import { bun, fs, path } from "./utils.js";

const USAGE = `
Usage: bun run screenshot [options] [page-paths...]

Take screenshots of your site pages.

Options:
  -v, --viewport <name>   Viewport to use: mobile, tablet, desktop, full-page (default: desktop)
  -a, --all-viewports     Capture all viewport variants for each page
  -d, --output-dir <dir>  Output directory (default: ./screenshots)
  -h, --help              Show this help message

Examples:
  bun run screenshot                           # Screenshot homepage at desktop viewport
  bun run screenshot /about /contact           # Screenshot multiple pages
  bun run screenshot -a /                      # Screenshot homepage at all viewports
  bun run screenshot -v mobile /products       # Screenshot products page at mobile viewport
  bun run screenshot -d ./my-screenshots /     # Save to custom directory

Page paths should start with / (e.g., /, /about, /products/item-1)
`;

const buildSite = (tempDir) => {
  console.log("Building site...");
  const result = bun.run("build", tempDir);
  if (result.exitCode !== 0) {
    throw new Error("Failed to build site");
  }
  console.log("Build complete.");
};

const runScreenshots = async (tempDir, args) => {
  const siteDir = join(tempDir, "_site");
  const tempOutputDir = join(tempDir, "screenshots");

  // Determine final output directory
  let finalOutputDir = path("screenshots");
  const outputIdx = args.findIndex((a) => a === "-d" || a === "--output-dir");
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    const outputPath = args[outputIdx + 1];
    finalOutputDir = outputPath.startsWith("/") ? outputPath : path(outputPath);
  }

  // Build args for template's screenshot script (using relative path within temp dir)
  const scriptArgs = ["-s", siteDir, "-d", "screenshots"];

  // Pass through relevant args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-d" || arg === "--output-dir") {
      i++; // Skip, already handled
    } else if (arg === "-v" || arg === "--viewport") {
      scriptArgs.push("-v", args[++i]);
    } else if (arg === "-a" || arg === "--all-viewports") {
      scriptArgs.push("-a");
    } else if (arg.startsWith("/")) {
      scriptArgs.push(arg);
    }
  }

  // Default to homepage if no pages specified
  const hasPages = args.some((a) => a.startsWith("/"));
  if (!hasPages) {
    scriptArgs.push("/");
  }

  console.log("Taking screenshots...");
  const proc = Bun.spawn(["bun", "scripts/screenshot.js", ...scriptArgs], {
    cwd: tempDir,
    stdio: ["inherit", "inherit", "inherit"],
  });

  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Screenshot process exited with code ${code}`);
  }

  // Copy screenshots to final output directory
  fs.mkdir(finalOutputDir);
  const files = readdirSync(tempOutputDir);
  for (const file of files) {
    cpSync(join(tempOutputDir, file), join(finalOutputDir, file));
  }
  console.log(`Screenshots saved to ${finalOutputDir}`);
};

const main = async () => {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return;
  }

  console.log("Setting up template environment...");
  const { tempDir, cleanup } = await setupTemplate();

  try {
    buildSite(tempDir);
    await runScreenshots(tempDir, args);
  } finally {
    cleanup();
  }

  console.log("Done!");
};

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

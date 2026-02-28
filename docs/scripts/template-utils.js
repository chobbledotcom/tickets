import { cpSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templateRepo } from "./consts.js";
import { bun, fs, git, path } from "./utils.js";

const rootExcludes = [
  ".git",
  "*.nix",
  "README.md",
  ".build",
  "scripts",
  "node_modules",
  "package.json",
  "bun.lock",
  "old_site",
];

/**
 * Check if a path matches any exclude pattern
 */
const matchesExclude = (name, excludes) =>
  excludes.some((pattern) => {
    if (pattern.startsWith("*.")) {
      return name.endsWith(pattern.slice(1));
    }
    return name === pattern;
  });

/**
 * Copy directory contents with excludes (replacement for rsync)
 */
const copyDir = (src, dest, excludes = []) => {
  if (!existsSync(src)) return;

  fs.mkdir(dest);

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const name = entry.name;
    if (matchesExclude(name, excludes)) continue;

    const srcPath = join(src, name);
    const destPath = join(dest, name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, excludes);
    } else {
      cpSync(srcPath, destPath);
    }
  }
};

/**
 * Recursively delete all files with a given extension
 */
const deleteByExt = (dir, ext) => {
  if (!existsSync(dir)) return;

  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      deleteByExt(fullPath, ext);
    } else if (entry.name.endsWith(ext)) {
      fs.rm(fullPath);
    }
  }
};

/**
 * Creates a temporary directory for template operations
 * @param {string} prefix - Prefix for the temp directory name
 * @returns {string} Path to the created temp directory
 */
export const createTempDir = (prefix = "chobble-template-") =>
  mkdtempSync(join(tmpdir(), prefix));

/**
 * Clones the chobble-template repository
 * @param {string} dest - Destination directory
 * @returns {boolean} True if successful
 */
export const cloneTemplate = (dest) => {
  console.log("Cloning chobble-template...");
  const result = git.clone(templateRepo, dest);
  if (result.exitCode !== 0) {
    throw new Error("Failed to clone chobble-template");
  }
  return true;
};

/**
 * Installs dependencies in a directory
 * @param {string} dir - Directory to install dependencies in
 * @returns {boolean} True if successful
 */
export const installDeps = (dir) => {
  console.log("Installing dependencies...");
  const result = bun.install(dir);
  if (result.exitCode !== 0) {
    throw new Error("Failed to install dependencies");
  }
  return true;
};

/**
 * Merges site content into a template directory
 * @param {string} templateDir - The cloned template directory
 */
export const mergeSiteContent = (templateDir) => {
  console.log("Merging site content...");

  // First, delete template's .md files so our content replaces them
  const srcDir = join(templateDir, "src");
  deleteByExt(srcDir, ".md");

  // Copy our site content (including .md files)
  const root = path();
  copyDir(root, srcDir, rootExcludes);
};

/**
 * Cleans up a temporary directory
 * @param {string} dir - Directory to remove
 */
export const cleanup = (dir) => {
  console.log("Cleaning up...");
  fs.rm(dir);
};

/**
 * Sets up a complete template environment with site content merged
 * @param {Object} opts - Options
 * @param {string} [opts.prefix] - Temp directory prefix
 * @param {boolean} [opts.installDeps=true] - Whether to install dependencies
 * @param {boolean} [opts.mergeSite=true] - Whether to merge site content
 * @returns {{ tempDir: string, cleanup: () => void }} The temp directory path and cleanup function
 */
export const setupTemplate = async (opts = {}) => {
  const { prefix, installDeps: install = true, mergeSite = true } = opts;

  const tempDir = createTempDir(prefix);

  try {
    cloneTemplate(tempDir);

    if (mergeSite) {
      mergeSiteContent(tempDir);
    }

    if (install) {
      installDeps(tempDir);
    }

    return {
      tempDir,
      cleanup: () => cleanup(tempDir),
    };
  } catch (err) {
    cleanup(tempDir);
    throw err;
  }
};

/**
 * Runs a script from the template
 * @param {string} tempDir - Template directory
 * @param {string} script - Script name to run
 * @param {Object} opts - Options to pass to bun.spawn
 * @returns {Promise<number>} Exit code
 */
export const runTemplateScript = async (tempDir, script, opts = {}) => {
  const proc = bun.spawn(script, tempDir, opts);
  return proc.exited;
};

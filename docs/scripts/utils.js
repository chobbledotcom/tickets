import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";

// Paths
export const root = resolve(import.meta.dir, "..");
export const path = (...segments) => join(root, ...segments);

// File operations using Bun APIs
export const file = (p) => Bun.file(p);
export const exists = (p) => file(p).exists();
export const read = (p) => file(p).text();
export const readJson = async (p) => JSON.parse(await read(p));
export const write = Bun.write;

// Filesystem commands
export const fs = {
  exists: existsSync,
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  cp: (src, dest) => cpSync(src, dest, { recursive: true }),
  mv: renameSync,
};

// Shell primitives
export const run = (cmd, opts = {}) =>
  Bun.spawnSync(cmd, { stdio: ["inherit", "inherit", "inherit"], ...opts });

export const shell = (cmd, opts = {}) => run(["sh", "--", "-c", cmd], opts);

export const spawn = (cmd, opts = {}) =>
  Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"], ...opts });

// Git commands
export const git = {
  clone: (repo, dest, opts = {}) =>
    run(["git", "clone", "--depth", String(opts.depth || 1), repo, dest]),

  pull: (dir) =>
    run(["git", "--git-dir", join(dir, ".git"), "--work-tree", dir, "pull"]),

  reset: (dir, opts = {}) =>
    run([
      "git",
      "--git-dir",
      join(dir, ".git"),
      "--work-tree",
      dir,
      "reset",
      opts.hard ? "--hard" : "--soft",
    ]),
};

// Directory sync (replaces rsync)
const globToRegex = (pattern) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
};

const isExcluded = (name, excludes) =>
  excludes.some((p) => globToRegex(p).test(name));

const isNewer = (srcPath, destPath) =>
  !existsSync(destPath) ||
  statSync(srcPath).mtimeMs > statSync(destPath).mtimeMs;

const shouldCopy = (srcPath, destPath, update) =>
  !update || isNewer(srcPath, destPath);

const copyRecursive = (src, dest, excludes, update) => {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (isExcluded(entry.name, excludes)) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath, excludes, update);
    } else if (shouldCopy(srcPath, destPath, update)) {
      cpSync(srcPath, destPath);
      chmodSync(destPath, statSync(srcPath).mode);
    }
  }
};

const removeIfMissing = (destPath, srcPath, excludes) => {
  if (!existsSync(srcPath)) rmSync(destPath, { recursive: true, force: true });
  else if (statSync(destPath).isDirectory())
    deleteMissing(destPath, srcPath, excludes);
};

const deleteMissing = (dest, src, excludes) => {
  if (!existsSync(dest)) return;
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    if (isExcluded(entry.name, excludes)) continue;
    removeIfMissing(join(dest, entry.name), join(src, entry.name), excludes);
  }
};

export const copyDir = (src, dest, opts = {}) => {
  const excludes = opts.exclude || [];
  if (opts.delete) deleteMissing(dest, src, excludes);
  copyRecursive(src, dest, excludes, opts.update || false);
};

// Bun commands
export const bun = {
  install: (cwd) => run(["bun", "install"], { cwd }),
  run: (script, cwd) => run(["bun", "run", script], { cwd }),
  test: (cwd) => run(["bun", "test"], { cwd }),
  spawn: (script, cwd) => spawn(["bun", "run", script], { cwd, shell: true }),
};

// Find commands
export const find = {
  deleteByExt: (dir, ext) =>
    shell(`find "${dir}" -type f -name "*${ext}" -delete 2>/dev/null || true`),
};

// Utilities
export const ext = extname;

export const debounce = (fn, ms) => {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

export const loadEnv = async (p = path(".env")) => {
  if (!(await exists(p))) return;
  for (const line of (await read(p)).split("\n")) {
    const [key, ...val] = line.split("=");
    if (key && val.length && !process.env[key]) {
      process.env[key] = val.join("=").trim();
    }
  }
};

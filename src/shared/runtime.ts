/**
 * Runtime introspection — collects non-secret details about the JavaScript
 * runtime the app is executing on (Deno version, V8, OS/arch, etc.).
 *
 * The app runs in three environments, each exposing different globals:
 * - Local dev / tests: Deno (`Deno.version`, `Deno.build`)
 * - Bunny Edge (production): Deno-based, with a `Bunny` global injected
 * - Node: not used in production, but detected for completeness
 *
 * Every global is probed defensively because availability varies between
 * runtimes, and we only ever read version/platform metadata — never secrets.
 */

/** Shape of the runtime globals we probe. All optional — presence varies. */
export type RuntimeGlobals = {
  Bunny?: unknown;
  Deno?: {
    version?: { deno?: string; v8?: string; typescript?: string };
    build?: { os?: string; arch?: string };
  };
  process?: { versions?: Record<string, string | undefined> };
  navigator?: { userAgent?: string };
};

/** Non-secret runtime/platform metadata for the debug page. */
export type RuntimeInfo = {
  /** Detected host runtime. */
  runtime: "bunny" | "deno" | "node" | "unknown";
  /** Operating system (e.g. "linux", "darwin"), or "" if unknown. */
  os: string;
  /** CPU architecture (e.g. "x86_64", "aarch64"), or "" if unknown. */
  arch: string;
  /** Deno version (e.g. "2.8.3"), or "" on non-Deno runtimes. */
  denoVersion: string;
  /** V8 engine version, or "" if unknown. */
  v8Version: string;
  /** Bundled TypeScript version, or "" if unknown. */
  typescriptVersion: string;
  /** Node.js compatibility version (process.versions.node), or "" if unset. */
  nodeCompatVersion: string;
  /** navigator.userAgent (runtime identity), or "" if unavailable. */
  userAgent: string;
};

/**
 * Detect the host runtime. Mirrors the Bunny SDK's own detection order: the
 * production edge injects a `Bunny` global (and is Deno-based underneath), so
 * it must be checked before Deno.
 */
const detectRuntime = (g: RuntimeGlobals): RuntimeInfo["runtime"] => {
  if (typeof g.Bunny !== "undefined") return "bunny";
  if (g.Deno?.build != null) return "deno";
  if (g.process?.versions?.node != null) return "node";
  return "unknown";
};

/** Build a RuntimeInfo from a (possibly partial) set of runtime globals. */
export const buildRuntimeInfo = (g: RuntimeGlobals): RuntimeInfo => {
  const version = g.Deno?.version;
  const build = g.Deno?.build;
  const processVersions = g.process?.versions;
  return {
    arch: build?.arch ?? "",
    denoVersion: version?.deno ?? "",
    nodeCompatVersion: processVersions?.node ?? "",
    os: build?.os ?? "",
    runtime: detectRuntime(g),
    typescriptVersion: version?.typescript ?? "",
    userAgent: g.navigator?.userAgent ?? "",
    v8Version: version?.v8 ?? processVersions?.v8 ?? "",
  };
};

/** Collect runtime info from the current global scope. */
export const getRuntimeInfo = (): RuntimeInfo =>
  buildRuntimeInfo(globalThis as unknown as RuntimeGlobals);

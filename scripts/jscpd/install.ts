/**
 * Keep jscpd's binary at `.bin/jscpd`, downloading and verifying it on first
 * use. The cpd scans run jscpd through `ensureJscpd`.
 *
 * jscpd v5 is a Rust binary shipped through npm. The platform package Deno
 * picks on a glibc Linux (`jscpd-linux-x64-gnu`) is dynamically linked, so a
 * NixOS machine cannot start it. The musl package is a fully static binary
 * that runs anywhere, so this module fetches that one and pins its checksum.
 */

import { join } from "node:path";
import { UntarStream } from "@std/tar";
import { ensureInstalled, withTempDir } from "#scripts/bin-tools.ts";
import { sha256Hex } from "#scripts/checksum.ts";
import { withFileLock } from "#scripts/lock-file.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { streamChunks } from "#shared/stream-chunks.ts";

export const JSCPD_VERSION = "5.2.0";
export const JSCPD_URL = `https://registry.npmjs.org/jscpd-linux-x64-musl/-/jscpd-linux-x64-musl-${JSCPD_VERSION}.tgz`;
export const JSCPD_SHA256 =
  "6dc6cdd9d245b485e5382872546e406e1d608500832a63644353b97b1faedf8c";

export type JscpdPaths = {
  binDir: string;
  binaryPath: string;
};

export const defaultJscpdPaths = (): JscpdPaths => ({
  binaryPath: join(projectRoot, ".bin", "jscpd"),
  binDir: join(projectRoot, ".bin"),
});

export type JscpdInstallOptions = {
  /** Fetches the decompressed tarball. Tests replace this with a local source. */
  download?: (url: string) => Promise<Uint8Array>;
  /** The checksum to verify, pinned for production and injected by tests. */
  expectedSha256?: string;
  paths?: JscpdPaths;
};

const fetchTarball = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`Failed to download jscpd: HTTP ${response.status}`);
  }
  const gunzip = new DecompressionStream("gzip");
  const parts: Uint8Array[] = [];
  for await (const part of streamChunks(response.body.pipeThrough(gunzip))) {
    parts.push(part);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
};

/** The `package/bin/jscpd` entry's bytes, or a loud failure. */
const jscpdEntryFromTar = async (tar: Uint8Array): Promise<Uint8Array> => {
  const untarred = ReadableStream.from([tar]).pipeThrough(new UntarStream());
  for await (const entry of untarred) {
    if (entry.path === "package/bin/jscpd") {
      if (entry.readable === undefined) {
        throw new Error("The jscpd tarball's binary entry holds no content");
      }
      return new Uint8Array(await new Response(entry.readable).arrayBuffer());
    }
    await entry.readable?.cancel();
  }
  throw new Error("The jscpd tarball holds no package/bin/jscpd entry");
};

const installBinary = async (
  paths: JscpdPaths,
  download: (url: string) => Promise<Uint8Array>,
  expectedSha256: string,
): Promise<void> => {
  await Deno.mkdir(paths.binDir, { recursive: true });
  await withTempDir(paths.binDir, "jscpd-", async (tempDir) => {
    const staged = join(tempDir, "jscpd");
    await Deno.writeFile(
      staged,
      await jscpdEntryFromTar(await download(JSCPD_URL)),
    );
    const bytes = await Deno.readFile(staged);
    if ((await sha256Hex(bytes)) !== expectedSha256) {
      throw new Error("jscpd binary checksum mismatch");
    }
    await Deno.chmod(staged, 0o700);
    await Deno.rename(staged, paths.binaryPath);
  });
};

/** The path of a usable jscpd binary, installing one when it is missing. */
export const ensureJscpd = async (
  options: JscpdInstallOptions = {},
): Promise<string> => {
  const paths = options.paths ?? defaultJscpdPaths();
  const expectedSha256 = options.expectedSha256 ?? JSCPD_SHA256;
  await ensureInstalled({
    binaryPath: paths.binaryPath,
    install: () =>
      installBinary(paths, options.download ?? fetchTarball, expectedSha256),
    lock: (body) =>
      withFileLock(join(paths.binDir, "jscpd.install.lock"), body),
  });
  return paths.binaryPath;
};

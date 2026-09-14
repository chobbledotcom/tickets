import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { sha256Hex } from "#scripts/checksum.ts";
import {
  defaultJscpdPaths,
  ensureJscpd,
  type JscpdPaths,
} from "#scripts/jscpd/install.ts";
import { removeTree } from "#scripts/process.ts";

const knownBytes = new TextEncoder().encode("#!/bin/sh\necho fake-jscpd");

const octal = (value: number, width: number): string =>
  `${value.toString(8).padStart(width - 1, "0")}\0`;

type TarSpec = {
  content?: Uint8Array;
  path: string;
  type: "directory" | "file";
};

const headerFor = (spec: TarSpec): Uint8Array => {
  const name = new TextEncoder().encode(spec.path);
  if (name.length > 100) throw new Error("tar name too long");
  const content = spec.content ?? new Uint8Array();
  const header = new Uint8Array(512);
  name.forEach((byte, index) => {
    header[index] = byte;
  });
  const write = (at: number, value: string): void => {
    for (let i = 0; i < value.length; i++) {
      header[at + i] = value.charCodeAt(i);
    }
  };
  write(100, octal(spec.type === "file" ? 0o644 : 0o755, 8));
  write(108, octal(0, 8));
  write(116, octal(0, 8));
  write(124, octal(content.length, 12));
  write(136, octal(0, 12));
  header[156] = spec.type === "file" ? 0x30 : 0x35;
  write(257, "ustar");
  header[263] = 0x30;
  header[264] = 0x30;
  write(148, "        ");
  const sum = header.reduce((acc, byte) => acc + byte, 0);
  const checksum = `${sum.toString(8).padStart(6, "0")}\0 `;
  for (let i = 0; i < 8; i++) header[148 + i] = checksum.charCodeAt(i);
  return header;
};

/** A ustar archive holding the given entries, built for `UntarStream`. */
const tarWith = (specs: readonly TarSpec[]): Uint8Array => {
  const blocks: Uint8Array[] = [];
  for (const spec of specs) {
    const content = spec.content ?? new Uint8Array();
    blocks.push(headerFor(spec));
    if (spec.type === "file" && content.length > 0) {
      const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
      padded.set(content);
      blocks.push(padded);
    }
  }
  const endpoints = blocks.reduce((total, block) => total + block.length, 2048);
  const archive = new Uint8Array(endpoints);
  let at = 0;
  for (const block of blocks) {
    archive.set(block, at);
    at += block.length;
  }
  return archive;
};

const gzipOf = async (bytes: Uint8Array): Promise<ArrayBuffer> => {
  const parts: Uint8Array[] = [];
  // TS types CompressionStream's writable as BufferSource, which pipeThrough's
  // generics reject; the bytes are Uint8Array at runtime, so the cast is
  // types-only.
  const gzip = new CompressionStream("gzip") as unknown as TransformStream<
    Uint8Array<ArrayBufferLike>,
    Uint8Array<ArrayBuffer>
  >;
  const reader = ReadableStream.from([bytes]).pipeThrough(gzip).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined.buffer as ArrayBuffer;
};

const tempPaths = async (): Promise<
  JscpdPaths & { cleanup: () => Promise<void> }
> => {
  const binDir = await Deno.makeTempDir({ prefix: "jscpd-install-" });
  return {
    binaryPath: join(binDir, "jscpd"),
    binDir,
    cleanup: () => removeTree(binDir),
  };
};

const tarWithJscpd = async (): Promise<Uint8Array> =>
  tarWith([{ content: knownBytes, path: "package/bin/jscpd", type: "file" }]);

describe("defaultJscpdPaths", () => {
  test("keeps the binary at .bin/jscpd under the project root", () => {
    const paths = defaultJscpdPaths;
    expect(paths.binDir.endsWith("/.bin")).toBe(true);
    expect(paths.binaryPath.endsWith("bin/jscpd")).toBe(true);
  });
});

describe("ensureJscpd", () => {
  test("downloads, verifies, and installs a binary that matches the checksum", async () => {
    const paths = await tempPaths();
    try {
      const expectedSha256 = await sha256Hex(knownBytes);
      const binaryPath = await ensureJscpd({
        download: async () => tarWithJscpd(),
        expectedSha256,
        paths,
      });
      expect(binaryPath).toBe(paths.binaryPath);
      expect(await Deno.readFile(paths.binaryPath)).toEqual(knownBytes);
      const mode = (await Deno.stat(paths.binaryPath)).mode ?? 0;
      expect(mode & 0o777).toBe(0o700);
    } finally {
      await paths.cleanup();
    }
  });

  test("uses the real fetch path (gzip body) when no download is given", async () => {
    const paths = await tempPaths();
    try {
      const expectedSha256 = await sha256Hex(knownBytes);
      using _fetch = stub(
        globalThis,
        "fetch",
        async () => new Response(await gzipOf(await tarWithJscpd())),
      );
      const binaryPath = await ensureJscpd({ expectedSha256, paths });
      expect(binaryPath).toBe(paths.binaryPath);
    } finally {
      await paths.cleanup();
    }
  });

  test("fails loudly when the fetch answers with a bad status", async () => {
    const paths = await tempPaths();
    try {
      using _fetch = stub(
        globalThis,
        "fetch",
        async () => new Response("nope", { status: 500 }),
      );
      await expect(ensureJscpd({ paths })).rejects.toThrow(
        "Failed to download jscpd: HTTP 500",
      );
    } finally {
      await paths.cleanup();
    }
  });

  test("fails loudly when the fetch body is missing", async () => {
    const paths = await tempPaths();
    try {
      using _fetch = stub(globalThis, "fetch", async () => new Response(null));
      await expect(ensureJscpd({ paths })).rejects.toThrow(
        "Failed to download jscpd",
      );
    } finally {
      await paths.cleanup();
    }
  });

  test("rejects a downloaded binary whose checksum does not match", async () => {
    const paths = await tempPaths();
    try {
      await expect(
        ensureJscpd({
          download: async () => tarWithJscpd(),
          expectedSha256: "0".repeat(64),
          paths,
        }),
      ).rejects.toThrow("jscpd binary checksum mismatch");
    } finally {
      await paths.cleanup();
    }
  });

  test("rejects a tarball with no package/bin/jscpd entry", async () => {
    const paths = await tempPaths();
    try {
      const tar = tarWith([
        { content: knownBytes, path: "package/bin/other", type: "file" },
      ]);
      await expect(
        ensureJscpd({
          download: async () => tar,
          expectedSha256: await sha256Hex(knownBytes),
          paths,
        }),
      ).rejects.toThrow("The jscpd tarball holds no package/bin/jscpd entry");
    } finally {
      await paths.cleanup();
    }
  });

  test("rejects a directory where the binary should sit", async () => {
    const paths = await tempPaths();
    try {
      const tar = tarWith([{ path: "package/bin/jscpd", type: "directory" }]);
      await expect(
        ensureJscpd({
          download: async () => tar,
          expectedSha256: await sha256Hex(knownBytes),
          paths,
        }),
      ).rejects.toThrow("The jscpd tarball's binary entry holds no content");
    } finally {
      await paths.cleanup();
    }
  });

  /** Write a cached binary, run ensureJscpd over it, and read back what
   * sits at the binary path afterwards: the kept cache or its replacement. */
  const reconcileCachedBinary = async (
    cached: Uint8Array,
    download: () => Promise<Uint8Array>,
  ): Promise<Uint8Array> => {
    const paths = await tempPaths();
    try {
      await Deno.writeFile(paths.binaryPath, cached);
      const binaryPath = await ensureJscpd({
        download,
        expectedSha256: await sha256Hex(knownBytes),
        paths,
      });
      expect(binaryPath).toBe(paths.binaryPath);
      return await Deno.readFile(paths.binaryPath);
    } finally {
      await paths.cleanup();
    }
  };

  test("keeps a cached binary that matches the checksum", async () => {
    expect(
      await reconcileCachedBinary(knownBytes, () => {
        throw new Error("must not download");
      }),
    ).toEqual(knownBytes);
  });

  test("replaces a cached binary whose checksum does not match", async () => {
    const stale = new TextEncoder().encode("truncated stale bytes");
    expect(
      await reconcileCachedBinary(stale, async () => await tarWithJscpd()),
    ).toEqual(knownBytes);
  });

  test("lets a failed download propagate", async () => {
    const paths = await tempPaths();
    try {
      await expect(
        ensureJscpd({
          download: async () => {
            throw new Error("network down");
          },
          paths,
        }),
      ).rejects.toThrow("network down");
    } finally {
      await paths.cleanup();
    }
  });
});

import { dirname, join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { relativeToProject } from "#scripts/path.ts";
import {
  defaultStripeMockPaths,
  downloadStripeMock,
} from "#scripts/stripe-mock/install.ts";
import {
  createFakeArchive,
  withFakeCurl,
  withTempStripeMockPaths,
} from "#test/test-utils/stripe-mock/helpers.ts";

/** Make the code believe it is running on a different machine. */
const pretendMachineIs = ({
  arch,
  os,
}: {
  arch: string;
  os: string;
}): Disposable => {
  const real = Deno.build;
  Object.defineProperty(Deno, "build", {
    configurable: true,
    value: { ...real, arch, os },
  });
  return {
    [Symbol.dispose]: () => {
      Object.defineProperty(Deno, "build", { configurable: true, value: real });
    },
  };
};

/** What stripe-mock calls the machine this test is running on. */
const expectedPlatform = (): string =>
  Deno.build.os === "darwin" ? "darwin" : "linux";

const expectedArch = (): string =>
  Deno.build.arch === "aarch64" ? "arm64" : "amd64";

/** Run a download with a curl that records what it was asked for. */
const curlArgsFor = async (build?: {
  arch: string;
  os: string;
}): Promise<string[]> => {
  using _build = build
    ? pretendMachineIs(build)
    : { [Symbol.dispose]: () => {} };
  const fakeArchive = await createFakeArchive();
  let args: string[] = [];
  try {
    await withTempStripeMockPaths(async (paths) => {
      const argsPath = join(paths.binDir, "curl-args");
      await withFakeCurl(
        [
          `printf '%s\n' "$@" > ${JSON.stringify(argsPath)}`,
          `cat ${JSON.stringify(fakeArchive.archivePath)}`,
        ].join("; "),
        async (curl) => {
          await downloadStripeMock({ commands: { curl }, paths });
        },
      );
      args = (await Deno.readTextFile(argsPath)).trim().split("\n");
    });
  } finally {
    await fakeArchive.cleanup();
  }
  return args;
};

describe("what stripe-mock is fetched with", () => {
  test("asks for the pinned release built for this machine", async () => {
    const url = (await curlArgsFor()).find((arg) => arg.startsWith("https://"));

    // The version is pinned on purpose. Changing it here means changing it in
    // install.ts and in the note about it in AGENTS.md.
    const version = "0.188.0";
    expect(url).toBe(
      `https://github.com/stripe/stripe-mock/releases/download/v${version}/stripe-mock_${version}_${expectedPlatform()}_${expectedArch()}.tar.gz`,
    );
  });

  test("names the release for a Mac on Apple silicon", async () => {
    const url = (await curlArgsFor({ arch: "aarch64", os: "darwin" })).find(
      (arg) => arg.startsWith("https://"),
    );

    expect(url).toContain("_darwin_arm64.tar.gz");
  });

  test("names the release for an ordinary Linux machine", async () => {
    const url = (await curlArgsFor({ arch: "x86_64", os: "linux" })).find(
      (arg) => arg.startsWith("https://"),
    );

    expect(url).toContain("_linux_amd64.tar.gz");
  });

  test("asks curl to work quietly, follow redirects, and hand the file back", async () => {
    const args = await curlArgsFor();

    expect(args).toContain("-sL");
    expect(args).toContain("-o");
    expect(args).toContain("-");
  });

  test("puts the binary where everything else looks for it", async () => {
    // Nothing is downloaded: the real binary is already where it belongs, and
    // finding it there is what stops a second fetch.
    const fetched: string[] = [];
    await withFakeCurl('echo "should not run" >&2; exit 1', async (curl) => {
      fetched.push(curl);
      await downloadStripeMock({ commands: { curl } });
    });

    expect((await Deno.stat(defaultStripeMockPaths.binaryPath)).isFile).toBe(
      true,
    );
    expect(relativeToProject(defaultStripeMockPaths.binaryPath)).toBe(
      ".bin/stripe-mock",
    );
  });

  test("fetches with curl when no other command is named", async () => {
    const fakeArchive = await createFakeArchive();
    const realPath = Deno.env.get("PATH") ?? "";
    try {
      await withFakeCurl(
        `cat ${JSON.stringify(fakeArchive.archivePath)}`,
        async (curl) => {
          // The stand-in is called curl, so it is only found if the installer
          // asks for curl by that name.
          Deno.env.set("PATH", `${dirname(curl)}:${realPath}`);
          await withTempStripeMockPaths(async (paths) => {
            await downloadStripeMock({ paths });

            expect((await Deno.stat(paths.binaryPath)).isFile).toBe(true);
          });
        },
      );
    } finally {
      Deno.env.set("PATH", realPath);
      await fakeArchive.cleanup();
    }
  });
});

describe("when a step of the install goes wrong", () => {
  test("says which step failed when the archive cannot be opened", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await withFakeCurl("echo not-an-archive", async (curl) => {
        await expect(
          downloadStripeMock({ commands: { curl, tar: "false" }, paths }),
        ).rejects.toThrow("Failed to extract stripe-mock");
      });
    });
  });

  test("says which step failed when the binary cannot be made runnable", async () => {
    const fakeArchive = await createFakeArchive();
    try {
      await withTempStripeMockPaths(async (paths) => {
        await withFakeCurl(
          `cat ${JSON.stringify(fakeArchive.archivePath)}`,
          async (curl) => {
            await expect(
              downloadStripeMock({
                commands: { chmod: "false", curl },
                paths,
              }),
            ).rejects.toThrow("Failed to make stripe-mock executable");
          },
        );
      });
    } finally {
      await fakeArchive.cleanup();
    }
  });

  test("makes the bin folder before reaching for the lock in it", async () => {
    const fakeArchive = await createFakeArchive();
    const parent = await Deno.makeTempDir();
    try {
      // Nothing has made this folder yet, so the lock has nowhere to live.
      const paths = {
        binaryPath: join(parent, "bin", "stripe-mock"),
        binDir: join(parent, "bin"),
      };
      await withFakeCurl(
        `cat ${JSON.stringify(fakeArchive.archivePath)}`,
        async (curl) => {
          await downloadStripeMock({ commands: { curl }, paths });
        },
      );

      expect((await Deno.stat(paths.binaryPath)).isFile).toBe(true);
    } finally {
      await Deno.remove(parent, { recursive: true });
      await fakeArchive.cleanup();
    }
  });
});

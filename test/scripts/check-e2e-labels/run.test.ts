import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readCatalog, runLabelCheck } from "#scripts/check-e2e-labels/run.ts";
import { capturedCheckOutput } from "#test-utils/check-script.ts";

/** Write a file under a temp dir and return its path. */
const tempFile = async (
  dir: string,
  relative: string,
  content: string,
): Promise<string> => {
  const { dirname, join } = await import("@std/path");
  const path = join(dir, relative);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
  return path;
};

describe("e2e label check run", () => {
  test("reads the catalog files as keys and values", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await tempFile(dir, "settings.json", `{"spec.login": "Login"}`);
      await tempFile(dir, "common.json", `{"spec.edit": "Edit"}`);

      const copy = await readCatalog(dir);
      expect(copy).not.toBeNull();
      // Files are read sorted, so common.json's key lands first.
      expect([...copy!.keys]).toEqual(["spec.edit", "spec.login"]);
      expect(copy!.values).toEqual(["Edit", "Login"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("says so when the catalog directory is empty", async () => {
    const dir = await Deno.makeTempDir();
    try {
      expect(await readCatalog(dir)).toBeNull();
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("says so when a catalog file holds the wrong shape", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await tempFile(dir, "settings.json", `{"spec.count": 3}`);

      expect(await readCatalog(dir)).toBeNull();
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("raises when the catalog path is not a directory at all", async () => {
    const file = await Deno.makeTempFile();

    try {
      await expect(readCatalog(file)).rejects.toThrow();
    } finally {
      await Deno.remove(file);
    }
  });

  test("passes a scan whose labels all come from the catalog", async () => {
    const root = await Deno.makeTempDir();
    const output = capturedCheckOutput();
    try {
      await tempFile(
        root,
        "locales/en/settings.json",
        `{"spec.login": "Login"}`,
      );
      await tempFile(root, "scan/flow.ts", `await s.clickButton("Login");`);

      await expect(
        runLabelCheck(`${root}/locales/en`, `${root}/scan`, output),
      ).resolves.toBe(0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("fails a scan whose label no message renders, and names file and line", async () => {
    const root = await Deno.makeTempDir();
    const output = capturedCheckOutput();
    try {
      await tempFile(
        root,
        "locales/en/settings.json",
        `{"spec.update": "Update {provider} credentials"}`,
      );
      await tempFile(
        root,
        "scan/stripe.ts",
        [
          "// a line before, so the finding carries a real line number",
          `await session.clickButton("Update Stripe Key");`,
        ].join("\n"),
      );

      await expect(
        runLabelCheck(`${root}/locales/en`, `${root}/scan`, output),
      ).resolves.toBe(1);
      expect(
        output.lines.some(
          (line) =>
            line.includes("scan/stripe.ts:2") &&
            line.includes('"Update Stripe Key"'),
        ),
      ).toBe(true);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("fails when the catalog cannot be read", async () => {
    const root = await Deno.makeTempDir();
    const output = capturedCheckOutput();
    try {
      await tempFile(root, "scan/flow.ts", `await s.clickButton("Login");`);

      await expect(
        runLabelCheck(`${root}/no-locales`, `${root}/scan`, output),
      ).resolves.toBe(1);
      expect(output.lines.join("\n")).toContain("Cannot read the message");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

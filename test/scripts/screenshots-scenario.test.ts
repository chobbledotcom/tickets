import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { it as test } from "@std/testing/bdd";
import { loadScreenshotScenario } from "../../scripts/screenshots/scenario.ts";

const loadFixture = (name: string) =>
  loadScreenshotScenario(
    fromFileUrl(
      new URL(`../fixtures/screenshots/scenarios/${name}.ts`, import.meta.url),
    ),
  );

test("loads a screenshot scenario without a setup username", async () => {
  const scenario = await loadFixture("without-username");

  expect(scenario.setupUsername).toBeUndefined();
  await scenario.run({} as never);
});

test("loads a screenshot scenario with a setup username", async () => {
  const scenario = await loadFixture("with-username");

  expect(scenario.setupUsername).toBe("site-owner");
});

test("rejects an empty screenshot setup username", async () => {
  await expect(loadFixture("empty-username")).rejects.toThrow(
    "Invalid screenshot scenario",
  );
});

test("rejects a whitespace-only screenshot setup username", async () => {
  await expect(loadFixture("blank-username")).rejects.toThrow(
    "Invalid screenshot scenario",
  );
});

for (const name of [
  "non-object",
  "null",
  "invalid-css",
  "invalid-name-type",
  "invalid-name-format",
  "invalid-run",
  "invalid-username-type",
  "invalid-selector",
  "invalid-full-page",
]) {
  test(`rejects the malformed ${name} screenshot scenario`, async () => {
    await expect(loadFixture(name)).rejects.toThrow(
      "Invalid screenshot scenario",
    );
  });
}

test("rejects a scenario with both element and full-page capture", async () => {
  await expect(loadFixture("conflicting-options")).rejects.toThrow(
    "cannot use elementSelector and fullPage together",
  );
});

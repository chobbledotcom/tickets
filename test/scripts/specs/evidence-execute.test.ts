import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { defineEvidenceRun } from "#scripts/specs/evidence/execute.ts";
import type { EvidenceCaptureDeclaration } from "#scripts/specs/evidence/schema.ts";
import type { runSpecs } from "#scripts/specs/run.ts";
import { validFeature } from "#test/scripts/specs/profile-fixture.ts";
import { compileEvidenceFeature } from "./evidence-fixture.ts";

const declaration = {
  caseId: "payment.place-available",
  element: "#payment-result",
  id: "payment-result",
  path: "/admin/payments/{paymentId}",
  presentation: "canonical",
  profiles: ["mobile"],
} as const satisfies EvidenceCaptureDeclaration;

describe("Cucumber evidence execution", () => {
  test("validates declarations and writes the successful run bundle", async () => {
    const catalog = compileEvidenceFeature(validFeature).catalog;
    const events: string[] = [];
    const bundle = { saved: true };
    let written: { bundle: typeof bundle; outputDir: string } | undefined;
    const run: typeof runSpecs = async (options, environment, controls) => {
      if (!controls) throw new Error("Evidence run controls are missing");
      events.push("run");
      expect(options).toEqual({
        reports: false,
        tags: "@case:payment.place-available",
      });
      expect(environment).toBe(undefined);
      expect(controls.env).toEqual({ TICKETS_SPEC_EVIDENCE: "1" });
      expect(controls.parallel).toBe(0);
      await controls.beforeRun?.(catalog);
      await controls.onSuccess?.([], catalog);
      return { success: true };
    };
    const execute = defineEvidenceRun({
      buildBundle: (input) => {
        events.push("build");
        expect(input).toEqual({
          catalog,
          commit: "a".repeat(40),
          declarations: [declaration],
          messages: [],
        });
        return Promise.resolve(bundle);
      },
      clearOutput: (outputDir) => {
        events.push("clear");
        expect(outputDir).toBe("/evidence");
        return Promise.resolve();
      },
      commit: () => {
        events.push("commit");
        return Promise.resolve("a".repeat(40));
      },
      declarations: [declaration],
      outputDir: "/evidence",
      run,
      themes: () => ({}),
      writeBundle: (outputDir, result) => {
        events.push("write");
        written = { bundle: result, outputDir };
        return Promise.resolve();
      },
    });

    expect(await execute()).toEqual({ success: true });
    expect(events).toEqual(["commit", "clear", "run", "build", "write"]);
    expect(written).toEqual({ bundle, outputDir: "/evidence" });
  });

  test("rejects messages received before declaration validation", async () => {
    const catalog = compileEvidenceFeature(validFeature).catalog;
    const run: typeof runSpecs = async (_options, _environment, controls) => {
      if (!controls) throw new Error("Evidence run controls are missing");
      await controls.onSuccess?.([], catalog);
      return { success: true };
    };
    const execute = defineEvidenceRun({
      buildBundle: () => Promise.resolve("bundle"),
      clearOutput: () => Promise.resolve(),
      commit: () => Promise.resolve("a".repeat(40)),
      declarations: [declaration],
      outputDir: "/evidence",
      run,
      themes: () => ({}),
      writeBundle: () => Promise.resolve(),
    });

    await expect(execute()).rejects.toThrow(
      "Evidence declarations were not validated",
    );
  });
});

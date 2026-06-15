import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildRuntimeInfo,
  getRuntimeInfo,
  type RuntimeGlobals,
} from "#shared/runtime.ts";

describe("runtime", () => {
  describe("getRuntimeInfo (live globals)", () => {
    test("detects the Deno runtime the tests execute on", () => {
      expect(getRuntimeInfo().runtime).toBe("deno");
    });

    test("reports a concrete Deno version", () => {
      expect(getRuntimeInfo().denoVersion).toMatch(/^\d+\.\d+\.\d+/);
    });

    test("reports a Deno user agent", () => {
      expect(getRuntimeInfo().userAgent).toContain("Deno");
    });
  });

  describe("buildRuntimeInfo runtime detection", () => {
    test("reports bunny when the Bunny global is present", () => {
      const g: RuntimeGlobals = { Bunny: {}, Deno: { build: { os: "linux" } } };
      expect(buildRuntimeInfo(g).runtime).toBe("bunny");
    });

    test("reports deno when Deno.build is present", () => {
      const g: RuntimeGlobals = { Deno: { build: { os: "linux" } } };
      expect(buildRuntimeInfo(g).runtime).toBe("deno");
    });

    test("reports node when only process.versions.node is present", () => {
      const g: RuntimeGlobals = { process: { versions: { node: "20.11.0" } } };
      expect(buildRuntimeInfo(g).runtime).toBe("node");
    });

    test("reports unknown when no runtime globals are present", () => {
      expect(buildRuntimeInfo({}).runtime).toBe("unknown");
    });
  });

  describe("buildRuntimeInfo field extraction", () => {
    test("extracts every field from a fully-populated Deno global", () => {
      const g: RuntimeGlobals = {
        Deno: {
          build: { arch: "aarch64", os: "darwin" },
          version: { deno: "2.8.3", typescript: "5.9.0", v8: "13.1.0" },
        },
        navigator: { userAgent: "Deno/2.8.3" },
      };
      expect(buildRuntimeInfo(g)).toEqual({
        arch: "aarch64",
        denoVersion: "2.8.3",
        nodeCompatVersion: "",
        os: "darwin",
        runtime: "deno",
        typescriptVersion: "5.9.0",
        userAgent: "Deno/2.8.3",
        v8Version: "13.1.0",
      });
    });

    test("falls back to process.versions.v8 when Deno has no version", () => {
      const g: RuntimeGlobals = {
        process: { versions: { node: "20.11.0", v8: "11.3.244" } },
      };
      const info = buildRuntimeInfo(g);
      expect(info.v8Version).toBe("11.3.244");
      expect(info.nodeCompatVersion).toBe("20.11.0");
    });

    test("defaults all metadata to empty strings when globals are bare", () => {
      const g: RuntimeGlobals = { Deno: { build: {}, version: {} } };
      expect(buildRuntimeInfo(g)).toEqual({
        arch: "",
        denoVersion: "",
        nodeCompatVersion: "",
        os: "",
        runtime: "deno",
        typescriptVersion: "",
        userAgent: "",
        v8Version: "",
      });
    });
  });
});

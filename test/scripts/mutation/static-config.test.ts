import { expect } from "@std/expect";
import { dirname } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import {
  defaultStaticJobs,
  staticWorkerParent,
} from "#scripts/mutation/static.ts";
import { projectRoot } from "#scripts/project-root.ts";

const withStaticJobs = (value: string | null, run: () => void): void => {
  const previous = Deno.env.get("MUTATION_STATIC_JOBS");
  try {
    if (value === null) Deno.env.delete("MUTATION_STATIC_JOBS");
    else Deno.env.set("MUTATION_STATIC_JOBS", value);
    run();
  } finally {
    if (previous === undefined) Deno.env.delete("MUTATION_STATIC_JOBS");
    else Deno.env.set("MUTATION_STATIC_JOBS", previous);
  }
};

const withHardwareConcurrency = (value: number, run: () => void): void => {
  Object.defineProperty(navigator, "hardwareConcurrency", {
    configurable: true,
    value,
  });
  try {
    run();
  } finally {
    Reflect.deleteProperty(navigator, "hardwareConcurrency");
  }
};

describe("mutation static worker configuration", () => {
  test("caps an explicit setting at the CPU-aware limit", () => {
    withHardwareConcurrency(2, () => {
      withStaticJobs("20", () => expect(defaultStaticJobs()).toBe(1));
    });
  });

  test("uses an explicit setting below the CPU-aware limit", () => {
    withHardwareConcurrency(4, () => {
      withStaticJobs("2", () => expect(defaultStaticJobs()).toBe(2));
    });
  });

  test("uses a bounded CPU-aware default", () => {
    withStaticJobs(null, () => {
      const expected = defaultStaticJobs();
      expect(expected).toBeGreaterThanOrEqual(1);
      expect(expected).toBeLessThanOrEqual(4);
      withStaticJobs("0", () => expect(defaultStaticJobs()).toBe(expected));
    });
  });

  test("places workers beside the mutation work copy", () => {
    expect(staticWorkerParent()).toBe(dirname(projectRoot));
  });
});

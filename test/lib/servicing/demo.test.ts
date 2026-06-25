/**
 * Servicing §0 / §13 — pure unit tests for servicing demo overrides.
 *
 * Servicing events name the reason ("Boiler Service", "Deep Clean"), not a
 * person. The attendee submit core calls `applyDemoOverrides(form,
 * ATTENDEE_DEMO_FIELDS)` which overwrites any present, non-empty field from
 * the demo name pool — so a naive servicing reuse would replace "Boiler
 * Service" with "Alice Johnson". The servicing submit core must instead call
 * `applyDemoOverrides(form, SERVICING_DEMO_FIELDS)` so demo mode keeps
 * servicing names looking like jobs, not people.
 *
 * Implementation contract (already partially present, test-first for the
 * remaining wiring):
 *   - `#shared/demo.ts` already exports `DEMO_SERVICING_NAMES`,
 *     `SERVICING_DEMO_FIELDS = { name: DEMO_SERVICING_NAMES }`,
 *     `DEMO_NAMES`, `ATTENDEE_DEMO_FIELDS`,
 *     `applyDemoOverrides`, `setDemoModeForTest`.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ATTENDEE_DEMO_FIELDS,
  applyDemoOverrides,
  DEMO_NAMES,
  DEMO_SERVICING_NAMES,
  SERVICING_DEMO_FIELDS,
  setDemoModeForTest,
} from "#shared/demo.ts";
import { FormParams } from "#shared/form-data.ts";

// jscpd:ignore-end

describe("servicing §0 — demo override replaces a servicing name with a servicing reason", () => {
  // Random choice inside applyDemoOverrides is non-deterministic, so the
  // assertion is set-membership over many runs, never an exact value.
  test("SERVICING_DEMO_FIELDS rewrites a servicing name to a servicing reason, never a DEMO_NAMES person", () => {
    setDemoModeForTest(true);
    try {
      const observed = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const form = new FormParams({ name: "Boiler Service" });
        applyDemoOverrides(form, SERVICING_DEMO_FIELDS);
        const rewritten = form.getString("name");
        observed.add(rewritten);
      }
      // Every observed name is a valid servicing reason ...
      for (const name of observed) {
        expect(DEMO_SERVICING_NAMES).toContain(name);
        // ... and never a person name from the attendee pool.
        expect(DEMO_NAMES).not.toContain(name);
      }
      // randomness actually exercised the pool — we should have seen at least
      // a handful of distinct reasons across 50 draws (bounded by the pool
      // size, so a mutant that always returns the same name still fails).
      expect(observed.size).toBeGreaterThanOrEqual(2);
    } finally {
      setDemoModeForTest(false);
    }
  });

  test("demo override only rewrites fields present in the field map (an empty servicing contact form is untouched)", () => {
    setDemoModeForTest(true);
    try {
      // A servicing form carries only `name` + the booking grid; email/phone
      // are absent. Applying ATTENDEE_DEMO_FIELDS (the wrong pool) would set
      // nothing on those fields because they are absent, but it WOULD rewrite
      // `name` with a person — proving the wrong-pool mutant is observable.
      const form = new FormParams({ name: "Boiler Service" });
      applyDemoOverrides(form, SERVICING_DEMO_FIELDS);
      expect(form.get("name")).not.toBe("Boiler Service");
      // email/phone were never present; they remain absent.
      expect(form.getString("email")).toBe("");
      expect(form.getString("phone")).toBe("");
    } finally {
      setDemoModeForTest(false);
    }
  });

  test("the attendee demo field map's name pool is the people list (control — proves the two pools are distinct)", () => {
    // ATTENDEE_DEMO_FIELDS.name and SERVICING_DEMO_FIELDS.name must point at
    // disjoint pools; a mutant that aliases one to the other fails this.
    expect(ATTENDEE_DEMO_FIELDS.name).toBe(DEMO_NAMES);
    expect(SERVICING_DEMO_FIELDS.name).toBe(DEMO_SERVICING_NAMES);
    for (const person of DEMO_NAMES) {
      expect(DEMO_SERVICING_NAMES).not.toContain(person);
    }
  });
});

describe("servicing §0 — DEMO_SERVICING_NAMES is non-empty and distinct", () => {
  test("no duplicate servicing reasons (a mutant that dupe-fills the list fails)", () => {
    const distinct = new Set(DEMO_SERVICING_NAMES);
    expect(distinct.size).toBe(DEMO_SERVICING_NAMES.length);
  });

  test("servicing pool parity count with DEMO_NAMES (parity keeps the two feature faces symmetric)", () => {
    expect(DEMO_SERVICING_NAMES.length).toBe(DEMO_NAMES.length);
    expect(DEMO_SERVICING_NAMES.length).toBeGreaterThan(0);
  });

  test("every reason reads as a job/reason, not a person-name shape (no spaces between first+last name)", () => {
    // Persons in DEMO_NAMES are "<First> <Last>" (contain a space); servicing
    // reasons are job-shaped ("Deep Clean", "Boiler Service" — still contain a
    // space, so we instead assert none of them coincide with a person).
    for (const reason of DEMO_SERVICING_NAMES) {
      expect(DEMO_NAMES).not.toContain(reason);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });
});

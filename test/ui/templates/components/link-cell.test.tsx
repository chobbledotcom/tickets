import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { linkCell } from "#templates/components/link-cell.tsx";

type Row = { active: boolean; id: number; name: string };

const row: Row = { active: true, id: 7, name: "Gala Night" };

describe("linkCell", () => {
  test("links a row to its own page, showing what it is called", () => {
    const cell = linkCell(
      (r: Row) => `/admin/listing/${r.id}`,
      (r) => r.name,
    );
    expect(String(cell(row))).toBe('<a href="/admin/listing/7">Gala Night</a>');
  });

  test("adds no class when none is asked for", () => {
    const cell = linkCell(
      (r: Row) => `/x/${r.id}`,
      (r) => r.name,
    );
    expect(String(cell(row))).not.toContain("class");
  });

  test("dims a row its class rule turns down", () => {
    const cell = linkCell(
      (r: Row) => `/x/${r.id}`,
      (r) => r.name,
      (r) => (r.active ? undefined : "muted"),
    );
    expect(String(cell({ ...row, active: false }))).toContain('class="muted"');
    expect(String(cell(row))).not.toContain("class");
  });

  test("escapes a name that carries markup characters", () => {
    const cell = linkCell(
      (r: Row) => `/x/${r.id}`,
      (r) => r.name,
    );
    expect(String(cell({ ...row, name: "A & B" }))).toContain("A &amp; B");
  });
});

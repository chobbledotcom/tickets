import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { builderForm } from "#templates/fields/builder.ts";

test("builder form defines every field and option exactly", () => {
  expect(JSON.parse(JSON.stringify(builderForm.fields))).toEqual([
    {
      label: "Site name",
      maxlength: 250,
      minlength: 1,
      name: "siteName",
      placeholder: "My Ticket Site",
      required: true,
      type: "text",
    },
    {
      label: "Hosting provider",
      name: "hostingProvider",
      options: [
        { label: "Bunny Edge Scripting", value: "bunny" },
        { label: "Deno Deploy", value: "deno" },
      ],
      type: "select",
    },
    {
      label: "Database provider",
      name: "dbProvider",
      options: [
        { label: "Bunny DB (auto-provision)", value: "bunny" },
        { label: "Turso (auto-provision)", value: "turso" },
        { label: "Manual (enter URL below)", value: "manual" },
      ],
      type: "select",
    },
    {
      hint: "Leave blank to auto-provision a database.",
      label: "Database URL",
      name: "dbUrl",
      placeholder: "libsql://your-db.turso.io",
      type: "url",
    },
    {
      hint: "Leave blank to auto-provision a database.",
      label: "Database token",
      // A pasted machine credential: the shared textarea cap, not the
      // single-line rule.
      maxlength: 10240,
      name: "dbToken",
      placeholder: "Database auth token",
      type: "password",
    },
  ]);
});

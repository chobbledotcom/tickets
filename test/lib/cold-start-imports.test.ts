import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

const source = (path: string): Promise<string> =>
  Deno.readTextFile(new URL(`../../src/${path}`, import.meta.url));

describe("cold-start import boundaries", () => {
  test("loads authentication only after an admin API route matches", async () => {
    const [request, routes] = await Promise.all([
      source("features/app/request.ts"),
      source("features/app/routes.ts"),
    ]);

    expect(request).not.toContain('from "#routes/auth.ts"');
    expect(request).toContain('from "#shared/session-private-key.ts"');
    expect(routes).not.toContain('from "#routes/auth.ts"');
    expect(routes).toContain('await import("#routes/auth.ts")');
  });

  test("loads migrations only for a database-backed route", async () => {
    const request = await source("features/app/request.ts");

    expect(request).not.toContain('from "#shared/db/migrations.ts"');
    expect(request).toContain('await import("#shared/db/migrations.ts")');
  });

  test("keeps generic page framing independent of broad modules", async () => {
    const [errors, layout] = await Promise.all([
      source("ui/templates/public/errors.tsx"),
      source("ui/templates/layout.tsx"),
    ]);

    expect(errors).not.toContain('from "./shared.tsx"');
    expect(errors).toContain('from "./prose-page.tsx"');
    expect(layout).not.toContain('from "#shared/storage.ts"');
    expect(layout).toContain('from "#shared/image-proxy-url.ts"');
  });
});

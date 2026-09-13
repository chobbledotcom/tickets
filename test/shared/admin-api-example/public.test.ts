import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PUBLIC_API_ENDPOINTS } from "#shared/admin-api-example/public.ts";
import { documented } from "./helpers.ts";

describe("package example member children", () => {
  const response = JSON.parse(
    documented(PUBLIC_API_ENDPOINTS, "GET", "/api/packages/:slug").response,
  ) as { package: { members: { children?: unknown[] }[] } };

  test("stay public listings", () => {
    const [child] = response.package.members[0]!.children!;
    expect(child).toMatchObject({
      assignBuiltSite: false,
      name: "Extra Bedding",
    });
  });

  test("carry no plan term when they assign no site", () => {
    const [child] = response.package.members[0]!.children! as [
      Record<string, unknown>,
    ];
    expect(Object.hasOwn(child, "initialSiteMonths")).toBe(false);
  });
});

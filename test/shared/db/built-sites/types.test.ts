import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  DEFAULT_UPDATE_TIER,
  isUpdateTier,
  providerOrBunny,
  siteAcceptsDeployTier,
  UPDATE_TIERS,
} from "#db/built-sites/types.ts";

describe("built-site update tiers", () => {
  test("orders channels from most to least eager", () => {
    expect(UPDATE_TIERS).toEqual(["alpha", "beta", "release"]);
    expect(DEFAULT_UPDATE_TIER).toBe("release");
  });

  test("accepts every channel and rejects unknown values", () => {
    for (const tier of UPDATE_TIERS) expect(isUpdateTier(tier)).toBe(true);
    for (const value of ["", "ALPHA", "stable", "rel", "release "]) {
      expect(isUpdateTier(value)).toBe(false);
    }
  });

  test("matches each site channel to the deployments it accepts", () => {
    expect(
      UPDATE_TIERS.flatMap((siteTier) =>
        UPDATE_TIERS.map((deployTier) =>
          siteAcceptsDeployTier(siteTier, deployTier),
        ),
      ),
    ).toEqual([true, true, true, false, true, true, false, false, true]);
  });
});

describe("built-site providers", () => {
  test("keeps the selected non-Bunny provider", () => {
    expect(providerOrBunny("deno", "deno")).toBe("deno");
    expect(providerOrBunny("turso", "turso")).toBe("turso");
  });

  test("uses Bunny when the named provider is not selected", () => {
    expect(providerOrBunny(null, "deno")).toBe("bunny");
    expect(providerOrBunny("bunny", "turso")).toBe("bunny");
  });
});

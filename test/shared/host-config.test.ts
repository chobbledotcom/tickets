import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createHostConfigOverride } from "#shared/host-config.ts";

describe("createHostConfigOverride", () => {
  test("reads the environment while nothing stands in front of it", () => {
    const host = createHostConfigOverride(() => "from the host");
    expect(host.getHostConfig()).toBe("from the host");
  });

  test("reads the override a test put in front of it", () => {
    const host = createHostConfigOverride(() => "from the host");
    host.setOverride("from the test");
    expect(host.getHostConfig()).toBe("from the test");
  });

  test("reads the environment again when an override is set to null", () => {
    const host = createHostConfigOverride(() => "from the host");
    host.setOverride("from the test");
    host.setOverride(null);
    expect(host.getHostConfig()).toBe("from the host");
  });

  test("goes back to the environment when the override is cleared", () => {
    const host = createHostConfigOverride(() => "from the host");
    host.setOverride("from the test");
    host.resetOverride();
    expect(host.getHostConfig()).toBe("from the host");
  });

  test("reads a host that genuinely has nothing as null", () => {
    const host = createHostConfigOverride<string>(() => null);
    expect(host.getHostConfig()).toBeNull();
  });

  test("reads the environment again on every call, so a change is seen", () => {
    let value = "first";
    const host = createHostConfigOverride(() => value);
    expect(host.getHostConfig()).toBe("first");
    value = "second";
    expect(host.getHostConfig()).toBe("second");
  });

  test("keeps two overrides apart", () => {
    const one = createHostConfigOverride(() => "one");
    const two = createHostConfigOverride(() => "two");
    one.setOverride("changed");
    expect(two.getHostConfig()).toBe("two");
  });
});

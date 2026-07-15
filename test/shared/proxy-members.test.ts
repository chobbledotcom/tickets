import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import { proxyMembers } from "#shared/proxy-members.ts";

describe("proxyMembers", () => {
  test("returns replacement members", () => {
    const proxied = proxyMembers({ value: 1 }, { value: 2 });
    expect(proxied.value).toBe(2);
  });

  test("forwards unchanged values", () => {
    const proxied = proxyMembers({ value: 1 }, {});
    expect(proxied.value).toBe(1);
  });

  test("binds unchanged methods to their target", () => {
    const target = {
      read() {
        return this.value;
      },
      value: 3,
    };
    const read = proxyMembers(target, {}).read;
    expect(read()).toBe(3);
  });

  test("updates a replacement without changing its target", () => {
    const target = { value: 1 };
    const proxied = proxyMembers(target, { value: 2 });
    proxied.value = 3;
    expect(proxied.value).toBe(3);
    expect(target.value).toBe(1);
  });

  test("updates an unchanged target member", () => {
    const target = { value: 1 };
    const proxied = proxyMembers(target, {});
    proxied.value = 2;
    expect(target.value).toBe(2);
  });

  test("defines a replacement property on the replacements", () => {
    const target = { value: 1 };
    const proxied = proxyMembers(target, { value: 2 });
    Object.defineProperty(proxied, "value", { configurable: true, value: 3 });
    expect(proxied.value).toBe(3);
    expect(target.value).toBe(1);
  });

  test("defines an unchanged property on the target", () => {
    const target = { value: 1 };
    const proxied = proxyMembers(target, {});
    Object.defineProperty(proxied, "value", { configurable: true, value: 2 });
    expect(target.value).toBe(2);
  });
});

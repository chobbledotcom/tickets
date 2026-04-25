import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import {
  createTestDbWithSetup,
  createTestGroup,
  deleteTestGroup,
  updateTestGroup,
  urlFromFetchInput,
} from "#test-utils";

describe("test-compat", () => {
  describe("beforeAll hook", () => {
    let setupRan = false;

    beforeAll(() => {
      setupRan = true;
    });

    test("beforeAll runs before the first test in the suite", () => {
      expect(setupRan).toBe(true);
    });
  });

  describe("expect.resolves", () => {
    test("resolves getter allows chaining toBe on resolved value", async () => {
      await expect(Promise.resolve(10)).resolves.toBe(10);
    });
  });

  describe("expect.rejects", () => {
    test("rejects.toThrow asserts on rejected promise with message", async () => {
      const failing = Promise.reject(new Error("async failure"));
      await expect(failing).rejects.toThrow("async failure");
    });

    test("rejects.toThrow asserts on rejected promise without message", async () => {
      const failing = Promise.reject(new Error("something"));
      await expect(failing).rejects.toThrow();
    });
  });

  describe("not.toEqual", () => {
    test("asserts two values are not deeply equal", () => {
      expect({ a: 1 }).not.toEqual({ a: 2 });
    });
  });

  describe("toStrictEqual", () => {
    test("asserts strict equality for matching values", () => {
      const val = 42;
      expect(val).toStrictEqual(42);
    });

    test("not.toStrictEqual asserts strict inequality", () => {
      expect(42).not.toStrictEqual(43);
    });
  });

  describe("not.toBeTruthy", () => {
    test("asserts value is not truthy", () => {
      expect(0).not.toBeTruthy();
    });
  });

  describe("toBeFalsy", () => {
    test("asserts value is falsy", () => {
      expect(0).toBeFalsy();
    });

    test("not.toBeFalsy asserts value is not falsy", () => {
      expect(1).not.toBeFalsy();
    });
  });

  describe("not.toBeUndefined", () => {
    test("asserts value is not undefined", () => {
      expect(42).not.toBeUndefined();
    });
  });

  describe("not.toBeDefined", () => {
    test("asserts value is not defined (is undefined)", () => {
      expect(undefined).not.toBeDefined();
    });
  });

  describe("toBeNaN", () => {
    test("asserts value is NaN", () => {
      expect(NaN).toBeNaN();
    });

    test("not.toBeNaN asserts value is not NaN", () => {
      expect(42).not.toBeNaN();
    });
  });

  describe("not.toContain", () => {
    test("asserts string does not contain substring", () => {
      expect("hello world").not.toContain("xyz");
    });

    test("asserts array does not contain element", () => {
      expect([1, 2, 3]).not.toContain(4);
    });
  });

  describe("toBeLessThanOrEqual", () => {
    test("asserts value is less than or equal", () => {
      expect(5).toBeLessThanOrEqual(5);
      expect(4).toBeLessThanOrEqual(5);
    });
  });

  describe("toContainEqual", () => {
    test("asserts array contains deeply equal element", () => {
      expect([{ a: 1 }, { b: 2 }]).toContainEqual({ a: 1 });
    });

    test("not.toContainEqual asserts array does not contain deeply equal element", () => {
      expect([{ a: 1 }, { b: 2 }]).not.toContainEqual({ c: 3 });
    });
  });

  describe("not.toHaveLength", () => {
    test("asserts array does not have specified length", () => {
      expect([1, 2, 3]).not.toHaveLength(5);
    });
  });

  describe("toMatch", () => {
    test("asserts string matches regex", () => {
      expect("hello world").toMatch(/hello/);
    });

    test("asserts string matches string pattern", () => {
      expect("hello world").toMatch(/hello/);
    });

    test("not.toMatch asserts string does not match", () => {
      expect("hello world").not.toMatch(/xyz/);
    });
  });

  describe("toMatchObject", () => {
    test("not.toMatchObject asserts objects do not match", () => {
      expect({ a: 1, b: 2 }).not.toMatchObject({ a: 99 });
    });
  });

  describe("toHaveProperty", () => {
    test("asserts object has property", () => {
      expect({ name: "test" }).toHaveProperty("name");
    });

    test("asserts object has property with specific value", () => {
      expect({ name: "test" }).toHaveProperty("name", "test");
    });

    test("not.toHaveProperty asserts object does not have property", () => {
      expect({ name: "test" }).not.toHaveProperty("missing");
    });

    test("not.toHaveProperty with value asserts property does not have that value", () => {
      expect({ name: "test" }).not.toHaveProperty("name", "other");
    });
  });

  describe("toBeInstanceOf", () => {
    test("asserts value is instance of class", () => {
      expect(new Error("test")).toBeInstanceOf(Error);
    });

    test("not.toBeInstanceOf asserts value is not instance of class", () => {
      expect("string").not.toBeInstanceOf(Error);
    });
  });

  describe("toThrow", () => {
    test("not.toThrow asserts function does not throw", () => {
      expect(() => "no error").not.toThrow();
    });

    test("toThrow with Error instance matches message", () => {
      expect(() => {
        throw new Error("specific error");
      }).toThrow(new Error("specific error"));
    });

    test("toThrow with string matches error message", () => {
      expect(() => {
        throw new Error("specific error");
      }).toThrow("specific error");
    });

    test("toThrow with RegExp matches error message pattern", () => {
      expect(() => {
        throw new Error("specific error 123");
      }).toThrow(/error \d+/);
    });

    test("toThrow with no argument asserts any throw", () => {
      expect(() => {
        throw new Error("anything");
      }).toThrow();
    });
  });

  describe("fn() mock function", () => {
    test("not.toHaveBeenCalledWith asserts mock was not called with specific args", () => {
      const mockFn = fn();
      mockFn("a", "b");
      expect(mockFn).not.toHaveBeenCalledWith("x", "y");
    });

    test("creates mock with custom implementation via stubs", () => {
      const mockFn = fn((x: unknown) => (x as number) * 2);
      const result = mockFn(5);
      expect(result).toBe(10);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test("tracks calls and works with expect matchers", () => {
      const mockFn = fn();
      mockFn("hello", "world");
      mockFn("second");
      expect(mockFn).toHaveBeenCalledTimes(2);
      expect(mockFn).toHaveBeenCalledWith("hello", "world");
    });
  });

  describe("FakeTime", () => {
    test("controls Date.now", () => {
      const realNow = Date.now();
      const time = new FakeTime(1000);
      expect(Date.now()).toBe(1000);
      time.restore();
      expect(Date.now()).toBeGreaterThanOrEqual(realNow);
    });

    test("accepts a Date instance", () => {
      const date = new Date("2025-06-15T00:00:00Z");
      const time = new FakeTime(date);
      expect(Date.now()).toBe(date.getTime());
      time.restore();
    });
  });

  describe("spy", () => {
    test("spies on object method and can be restored", () => {
      const obj = { greet: (name: string) => `Hello, ${name}` };
      const greetSpy = spy(obj, "greet");
      obj.greet("world");
      expect(greetSpy.calls[0]!.args).toEqual(["world"]);
      greetSpy.restore();
      expect(obj.greet("test")).toBe("Hello, test");
    });
  });

  describe("stub", () => {
    test("replaces method with custom implementation", () => {
      const obj = { greet: (name: string) => `Hello, ${name}` };
      const greetStub = stub(obj, "greet", () => "stubbed");
      expect(obj.greet("world")).toBe("stubbed");
      expect(greetStub.calls[0]!.args).toEqual(["world"]);
      greetStub.restore();
      expect(obj.greet("test")).toBe("Hello, test");
    });
  });

  describe("not.toBeGreaterThan (isNot numeric comparison)", () => {
    test("asserts value is not greater than expected", () => {
      expect(5).not.toBeGreaterThan(10);
    });
  });

  describe("not.toThrow catch branch", () => {
    test("throws when function unexpectedly throws", () => {
      let caughtError: Error | null = null;
      try {
        expect(() => {
          throw new Error("oops");
        }).not.toThrow();
      } catch (e) {
        caughtError = e as Error;
      }
      expect(caughtError).not.toBeNull();
    });
  });

  describe("rejects.toThrow with RegExp argument", () => {
    test("asserts rejection with RegExp (covers Error class and ternary branch)", async () => {
      const failing = Promise.reject(new Error("regex test error"));
      await expect(failing).rejects.toThrow(/regex/);
    });
  });

  describe("rejects.toThrow with string message", () => {
    test("matches error message string in rejected promise", async () => {
      const rejecting = Promise.reject(new Error("specific error message"));
      await expect(rejecting).rejects.toThrow("specific error message");
    });

    test("rejects.toThrow without argument matches any Error", async () => {
      const rejecting = Promise.reject(new Error("any error"));
      await expect(rejecting).rejects.toThrow();
    });
  });

  describe("group helpers", () => {
    test("createTestGroup uses defaults when no overrides provided", async () => {
      await createTestDbWithSetup();
      const group = await createTestGroup();
      expect(group.name).toBe("Test Group");
      expect(group.slug.length).toBe(5);
      expect(group.description).toBe("");
      expect(group.terms_and_conditions).toBe("");
    });

    test("updateTestGroup can update only the name", async () => {
      await createTestDbWithSetup();
      const group = await createTestGroup({
        name: "Before",
        slug: "update-name-group",
        termsAndConditions: "Terms",
      });
      const updated = await updateTestGroup(group.id, { name: "After" });
      expect(updated.name).toBe("After");
      expect(updated.slug).toBe("update-name-group");
      expect(updated.terms_and_conditions).toBe("Terms");
    });

    test("updateTestGroup can update only the slug", async () => {
      await createTestDbWithSetup();
      const group = await createTestGroup({
        name: "Name",
        slug: "before-slug",
        termsAndConditions: "",
      });
      const updated = await updateTestGroup(group.id, { slug: "after-slug" });
      expect(updated.name).toBe("Name");
      expect(updated.slug).toBe("after-slug");
    });

    test("updateTestGroup can update only terms_and_conditions", async () => {
      await createTestDbWithSetup();
      const group = await createTestGroup({
        name: "Name",
        slug: "terms-only",
        termsAndConditions: "",
      });
      const updated = await updateTestGroup(group.id, {
        termsAndConditions: "New terms",
      });
      expect(updated.slug).toBe("terms-only");
      expect(updated.terms_and_conditions).toBe("New terms");
    });

    test("deleteTestGroup deletes the group", async () => {
      await createTestDbWithSetup();
      const group = await createTestGroup({
        name: "Del",
        slug: "delete-group-helper",
      });
      await deleteTestGroup(group.id);
      const { groupsTable } = await import("#lib/db/groups.ts");
      expect(await groupsTable.findById(group.id)).toBeNull();
    });
  });

  describe("urlFromFetchInput", () => {
    test("returns string input unchanged", () => {
      expect(urlFromFetchInput("https://example.com/path")).toBe(
        "https://example.com/path",
      );
    });

    test("converts URL object to string", () => {
      const url = new URL("https://example.com/path");
      expect(urlFromFetchInput(url)).toBe("https://example.com/path");
    });

    test("extracts url from Request object", () => {
      const request = new Request("https://example.com/path");
      expect(urlFromFetchInput(request)).toBe("https://example.com/path");
    });
  });
});

// Standalone test outside any describe block — verifies top-level test() works
test("top-level test outside describe block runs correctly", () => {
  expect(1 + 1).toBe(2);
});

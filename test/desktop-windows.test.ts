import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { enableDesktopWindows, type OpenWindow } from "#src/desktop-windows.ts";

class FakeWindow {
  static instances: FakeWindow[] = [];
  binding: OpenWindow | undefined;
  navigatedTo: string | undefined;

  constructor() {
    FakeWindow.instances.push(this);
  }

  bind(_name: "openWindow", binding: OpenWindow): void {
    this.binding = binding;
  }

  navigate(url: string): void {
    this.navigatedTo = url;
  }
}

describe("desktop windows", () => {
  test("opens links in another bound window", () => {
    FakeWindow.instances = [];
    enableDesktopWindows(FakeWindow);

    FakeWindow.instances[0]?.binding?.("https://example.com/tickets");

    expect(FakeWindow.instances).toHaveLength(2);
    expect(FakeWindow.instances[1]?.navigatedTo).toBe(
      "https://example.com/tickets",
    );
    expect(FakeWindow.instances[1]?.binding).toBeDefined();
  });

  test("lets a child window open another window", () => {
    FakeWindow.instances = [];
    enableDesktopWindows(FakeWindow);
    FakeWindow.instances[0]?.binding?.("http://127.0.0.1/admin");

    FakeWindow.instances[1]?.binding?.("https://example.com/help");

    expect(FakeWindow.instances).toHaveLength(3);
    expect(FakeWindow.instances[2]?.navigatedTo).toBe(
      "https://example.com/help",
    );
  });

  test("rejects URLs that a web window must not open", () => {
    FakeWindow.instances = [];
    enableDesktopWindows(FakeWindow);

    expect(() =>
      FakeWindow.instances[0]?.binding?.("javascript:alert(1)"),
    ).toThrow("Cannot open desktop window for protocol: javascript:");
    expect(FakeWindow.instances).toHaveLength(1);
  });
});

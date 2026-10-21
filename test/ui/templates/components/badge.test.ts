import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  Badge,
  type BadgeVariant,
  statusBadge,
} from "#templates/components/badge.tsx";

const badgeClass = (variant: BadgeVariant): string => {
  const html = String(Badge({ children: "x", variant }));
  return html.match(/class="([^"]*)"/)?.[1] ?? "";
};

describe("Badge", () => {
  test("each variant renders its own class", () => {
    expect(badgeClass("danger")).toBe("badge danger");
    expect(badgeClass("warning")).toBe("badge-warning");
    expect(badgeClass("ok")).toBe("badge-ok");
    expect(badgeClass("missing")).toBe("badge-missing");
    expect(badgeClass("alert")).toBe("badge-alert");
  });

  test("a badge without a variant is the plain badge", () => {
    expect(String(Badge({ children: "Plain" }))).toBe(
      '<span class="badge">Plain</span>',
    );
  });

  test("a status badge shows the on label with the ok pill and the off label with the missing pill", () => {
    expect(String(statusBadge(true, "Sent", "Not sent"))).toBe(
      '<span class="badge-ok">Sent</span>',
    );
    expect(String(statusBadge(false, "Sent", "Not sent"))).toBe(
      '<span class="badge-missing">Not sent</span>',
    );
  });
});

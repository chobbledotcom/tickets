import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  renderGuideSections,
} from "#templates/admin/guide/components.tsx";
import { accountsSections } from "#templates/admin/guide/accounts.tsx";

const sections = accountsSections();

const userClassesSection = () => {
  const section = sections.find(({ id }) => id === "user-classes");
  if (section === undefined) throw new Error("User classes guide is missing");
  return section;
};

describe("accounts guide schema", () => {
  test("keeps every account section in its intended order", () => {
    expect(sections.map(({ id, titleKey }) => ({ id, titleKey }))).toEqual([
      { id: "user-classes", titleKey: "users_and_permissions" },
      { id: "login-security", titleKey: "login_security" },
      { id: "data-privacy", titleKey: "data_and_privacy" },
      { id: "webhooks", titleKey: "webhooks" },
      { id: "login", titleKey: "login_sessions" },
      { id: "calendar", titleKey: "calendar" },
      { id: "activity-log", titleKey: "activity_log" },
    ]);
  });

  test("names every user class the invite form offers, in role order", () => {
    const faqs = userClassesSection().entries.map(
      (entry) => "faq" in entry && entry.faq,
    );
    expect(faqs).toEqual([
      "owner_vs_manager",
      "editor_role",
      "agent_role",
      "scanner_role",
      "invite_admin",
      "invite_link_expiry",
    ]);
  });

  test("renders the scanner answer with the role's reach and its limits", () => {
    const html = String(renderGuideSections([userClassesSection()]));
    const question = t("guide.q.scanner_role");
    const answerStart = html.indexOf(question);
    expect(answerStart).toBeGreaterThan(-1);
    const answer = html.slice(
      answerStart,
      html.indexOf(t("guide.q.invite_admin")),
    );
    // What the role is for, and the line past which it cannot go.
    expect(answer).toContain(t("guide.a.scanner_role"));
    expect(answer).toContain("<strong>Scanners</strong>");
  });
});

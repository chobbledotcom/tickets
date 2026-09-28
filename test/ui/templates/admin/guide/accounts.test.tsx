import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { LOGIN_LOCKOUT_MS, MAX_LOGIN_ATTEMPTS } from "#shared/limits.ts";
import { accountsSections } from "#templates/admin/guide/accounts.tsx";
import { renderGuideSections } from "#templates/admin/guide/components.tsx";

const sections = accountsSections();

const sectionById = (id: string) => {
  const section = sections.find((one) => one.id === id);
  if (section === undefined)
    throw new Error(`Guide section "${id}" is missing`);
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
    const faqs = sectionById("user-classes").entries.map(
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
    const html = String(renderGuideSections([sectionById("user-classes")]));
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

  test("renders the webhook answer's header with its spacing intact", () => {
    const html = String(renderGuideSections([sectionById("webhooks")]));
    expect(html).toContain("with <code>Content-Type: application/json</code>");
  });

  test("renders the lockout answer with the attempt count and the minutes", () => {
    const html = String(renderGuideSections([sectionById("login")]));
    expect(html).toContain(
      `After <strong>${MAX_LOGIN_ATTEMPTS} failed attempts</strong>`,
    );
    expect(html).toContain(
      `blocked for <strong>${LOGIN_LOCKOUT_MS / 60_000} minutes</strong>`,
    );
    expect(html).toContain(
      "Because there is <strong>no password recovery</strong>",
    );
    expect(html).toContain("(see <strong>Data &amp; Privacy</strong>)");
  });
});

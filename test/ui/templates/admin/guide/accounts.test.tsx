import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { durationWords } from "#shared/format-units.ts";
import {
  LOGIN_LOCKOUT_MS,
  MAX_LOGIN_ATTEMPTS,
  SESSION_MAX_AGE_S,
} from "#shared/limits.ts";
import { accountsSections } from "#templates/admin/guide/accounts.tsx";
import { renderGuideSections } from "#templates/admin/guide/components.tsx";

const sections = accountsSections();

const sectionById = (id: string) => {
  const section = sections.find((one) => one.id === id);
  if (section === undefined) {
    throw new Error(`Guide section "${id}" is missing`);
  }
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

  test("renders the webhook answer with its developer framing", () => {
    const html = String(renderGuideSections([sectionById("webhooks")]));
    expect(html).toContain("sent as JSON — a text shape");
  });

  test("renders the lockout answer with the attempt count and the minutes", () => {
    const html = String(renderGuideSections([sectionById("login")]));
    expect(html).toContain(
      `After <strong>${MAX_LOGIN_ATTEMPTS} wrong tries</strong>`,
    );
    expect(html).toContain(
      `blocked for <strong>${durationWords(LOGIN_LOCKOUT_MS / 1000)}</strong>`,
    );
    expect(html).toContain(
      "Because there is <strong>no password recovery</strong>",
    );
    expect(html).toContain("(see <strong>Data &amp; privacy</strong>)");
  });

  test("states the session length the site actually uses", () => {
    const html = String(renderGuideSections([sectionById("login")]));
    expect(html).toContain(
      `Sessions expire after ${durationWords(SESSION_MAX_AGE_S)}.`,
    );
  });

  test("states the login security lengths the site actually uses", () => {
    const html = String(renderGuideSections([sectionById("login-security")]));
    expect(html).toContain(
      `blocked from logging in for <strong>${
        durationWords(
          LOGIN_LOCKOUT_MS / 1000,
        )
      }</strong>`,
    );
    expect(html).toContain(
      `Wait ${durationWords(LOGIN_LOCKOUT_MS / 1000)} and try again`,
    );
    expect(html).toContain(
      `expires after <strong>${durationWords(SESSION_MAX_AGE_S)}</strong>`,
    );
  });
});

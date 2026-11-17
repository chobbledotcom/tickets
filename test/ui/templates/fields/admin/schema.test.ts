import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/message-groups.generated.ts";
import {
  getBuiltSiteForm,
  getChangePasswordForm,
  getHolidayForm,
  getInviteUserForm,
  getLoginForm,
  getSetupForm,
  getSquareWebhookFields,
  getStripeKeyFields,
  squareAccessTokenFields,
  sumupFields,
} from "#templates/fields/admin.ts";
import { fieldShape as shape } from "#test-utils/field-shape.ts";

// The builders resolve their copy while building, so the catalog must be in
// place before any group is read — as the admin shell guarantees on a page.
await ensureMessageGroups(MESSAGE_GROUPS);

// Every expected list is written out literally so a changed name, label,
// hint, flag, or choice fails here instead of moving the expectation along.
describe("admin field schemas", () => {
  test("the login form serves exactly its declared fields", () => {
    expect(getLoginForm().fields.map(shape)).toEqual([
      {
        autocomplete: "username",
        label: "Username",
        name: "username",
        pattern: "[a-zA-Z0-9][a-zA-Z0-9_\\-]*",
        required: true,
        title:
          "Letters, numbers, hyphens, and underscores only. Start with a letter or number.",
        type: "text",
      },
      {
        autocomplete: "current-password",
        label: "Password",
        name: "password",
        required: true,
        type: "password",
      },
    ]);
  });

  test("the holiday form serves exactly its declared fields", () => {
    expect(getHolidayForm().fields.map(shape)).toEqual([
      {
        label: "Holiday name",
        name: "name",
        placeholder: "Bank holiday",
        required: true,
        type: "text",
      },
      {
        label: "Start date",
        name: "startDate",
        required: true,
        type: "date",
      },
      {
        hint: "Must be on or after the start date",
        label: "End date",
        name: "endDate",
        required: true,
        type: "date",
      },
    ]);
  });

  test("the built-site form serves exactly its declared fields", () => {
    expect(getBuiltSiteForm().fields.map(shape)).toEqual([
      {
        label: "Site name",
        name: "name",
        placeholder: "My Ticket Site",
        required: true,
        type: "text",
      },
      {
        label: "Site URL",
        name: "siteUrl",
        placeholder: "https://example.b-cdn.net",
        required: true,
        type: "url",
      },
      {
        label: "Database URL",
        name: "dbUrl",
        placeholder: "libsql://your-db.turso.io",
        type: "url",
      },
      {
        label: "Database token",
        name: "dbToken",
        placeholder: "Database auth token",
        type: "password",
      },
      {
        label: "Hosting ID",
        name: "hostingId",
        placeholder: "Script ID or app ID",
        type: "text",
      },
      {
        label: "Hosting provider",
        name: "hostingProvider",
        options: [
          {
            label: "Bunny",
            value: "bunny",
          },
          {
            label: "Deno Deploy",
            value: "deno",
          },
        ],
        type: "select",
      },
      {
        label: "Database provider",
        name: "dbProvider",
        options: [
          {
            label: "Bunny DB",
            value: "bunny",
          },
          {
            label: "Turso",
            value: "turso",
          },
        ],
        type: "select",
      },
      {
        hint: "Make this site available for automatic assignment when a ticket is purchased",
        label: "Assignable",
        name: "assignable",
        options: [
          {
            label: "Available for assignment",
            value: "1",
          },
        ],
        type: "checkbox-group",
      },
      {
        hint: "Which deploys this site accepts. Alpha takes every release, beta takes beta and stable, release takes stable releases only.",
        label: "Update channel",
        name: "updates",
        options: [
          {
            label: "Release (stable only)",
            value: "release",
          },
          {
            label: "Beta (beta + stable)",
            value: "beta",
          },
          {
            label: "Alpha (every release)",
            value: "alpha",
          },
        ],
        type: "select",
      },
    ]);
  });

  test("the setup form serves exactly its declared fields", () => {
    expect(getSetupForm().fields.map(shape)).toEqual([
      {
        autocomplete: "username",
        hint: "Letters, numbers, hyphens, underscores (1-250 characters)",
        label: "Admin username *",
        name: "adminUsername",
        pattern: "[a-zA-Z0-9][a-zA-Z0-9_\\-]*",
        required: true,
        title:
          "Letters, numbers, hyphens, and underscores only. Start with a letter or number.",
        type: "text",
      },
      {
        autocomplete: "new-password",
        hint: "Minimum 8 characters",
        label: "Admin password *",
        name: "adminPassword",
        required: true,
        type: "password",
      },
      {
        autocomplete: "new-password",
        label: "Confirm admin password *",
        name: "adminPasswordConfirm",
        required: true,
        type: "password",
      },
    ]);
  });

  test("the change-password form serves exactly its declared fields", () => {
    expect(getChangePasswordForm().fields.map(shape)).toEqual([
      {
        autocomplete: "current-password",
        label: "Current password",
        name: "currentPassword",
        required: true,
        type: "password",
      },
      {
        autocomplete: "new-password",
        hint: "Minimum 8 characters",
        label: "New password",
        name: "newPassword",
        required: true,
        type: "password",
      },
      {
        autocomplete: "new-password",
        label: "Confirm new password",
        name: "newPasswordConfirm",
        required: true,
        type: "password",
      },
    ]);
  });

  test("the Stripe key fields serves exactly its declared fields", () => {
    expect(getStripeKeyFields().map(shape)).toEqual([
      {
        autocomplete: "off",
        hint: "Enter a new key to update",
        label: "Stripe secret key",
        name: "stripeSecretKey",
        placeholder: "sk_live_... or sk_test_...",
        required: true,
        type: "password",
      },
    ]);
  });

  test("the Square access fields serves exactly its declared fields", () => {
    expect(squareAccessTokenFields().map(shape)).toEqual([
      {
        autocomplete: "off",
        hint: "Your Square application's access token",
        label: "Square access token",
        name: "squareAccessToken",
        placeholder: "EAAAl...",
        required: true,
        type: "password",
      },
      {
        autocomplete: "off",
        hint: "Your Square location ID (found in Square Dashboard under Locations)",
        label: "Location ID",
        name: "squareLocationId",
        placeholder: "L...",
        required: true,
        type: "text",
      },
    ]);
  });

  test("the Square webhook fields serves exactly its declared fields", () => {
    expect(getSquareWebhookFields().map(shape)).toEqual([
      {
        autocomplete: "off",
        hint: "The signature key from your Square webhook subscription",
        label: "Webhook signature key",
        name: "squareWebhookSignatureKey",
        required: true,
        type: "password",
      },
    ]);
  });

  test("the SumUp fields serves exactly its declared fields", () => {
    expect(sumupFields().map(shape)).toEqual([
      {
        autocomplete: "off",
        hint: "Your SumUp secret API key, from me.sumup.com → For Developers → API Keys",
        label: "SumUp API key",
        name: "sumupApiKey",
        placeholder: "Paste your SumUp API key",
        required: true,
        type: "password",
      },
      {
        autocomplete: "off",
        hint: "Your SumUp merchant code, shown in your SumUp account profile (must match the API key's account)",
        label: "Merchant code",
        name: "sumupMerchantCode",
        placeholder: "M...",
        required: true,
        type: "text",
      },
    ]);
  });

  test("the invite-user form serves exactly its declared fields", () => {
    expect(getInviteUserForm().fields.map(shape)).toEqual([
      {
        hint: "Letters, numbers, hyphens, underscores (1-250 characters)",
        label: "Username",
        name: "username",
        pattern: "[a-zA-Z0-9][a-zA-Z0-9_\\-]*",
        required: true,
        title:
          "Letters, numbers, hyphens, and underscores only. Start with a letter or number.",
        type: "text",
      },
      {
        invalidMessage: "Invalid role",
        label: "Role",
        name: "adminLevel",
        options: [
          {
            label: "Choose a role…",
            value: "",
          },
          {
            label: "Owner",
            value: "owner",
          },
          {
            label: "Manager",
            value: "manager",
          },
          {
            label: "Delivery agent",
            value: "agent",
          },
          {
            label: "Editor",
            value: "editor",
          },
          {
            label: "Scanner",
            value: "scanner",
          },
        ],
        required: true,
        type: "select",
      },
    ]);
  });
});

describe("the built-site form", () => {
  test("the site URL label links to the saved address", () => {
    const [, siteUrl] = getBuiltSiteForm("https://a.example/?x=1&y=2").fields;
    expect(siteUrl).toMatchObject({
      labelSuffixHtml:
        ' <a href="https://a.example/?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">(visit)</a>',
      name: "siteUrl",
    });
  });
});

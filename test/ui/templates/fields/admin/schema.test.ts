import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/manifest.ts";
import {
  getBuiltSiteForm,
  getChangePasswordForm,
  getHolidayForm,
  getInviteUserForm,
  getLoginForm,
  getSetupForm,
  getSquareAccessTokenFields,
  getSquareWebhookFields,
  getStripeKeyFields,
  getSumupFields,
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
        pattern: "[a-zA-Z0-9_\\-]+",
        required: true,
        title: "Letters, numbers, hyphens, and underscores only",
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
        label: "Holiday Name",
        name: "name",
        placeholder: "Bank Holiday",
        required: true,
        type: "text",
      },
      {
        label: "Start Date",
        name: "start_date",
        required: true,
        type: "date",
      },
      {
        hint: "Must be on or after the start date",
        label: "End Date",
        name: "end_date",
        required: true,
        type: "date",
      },
    ]);
  });

  test("the built-site form serves exactly its declared fields", () => {
    expect(getBuiltSiteForm().fields.map(shape)).toEqual([
      {
        label: "Site Name",
        name: "name",
        placeholder: "My Ticket Site",
        required: true,
        type: "text",
      },
      {
        label: "Site URL",
        name: "site_url",
        placeholder: "https://example.b-cdn.net",
        required: true,
        type: "url",
      },
      {
        label: "Database URL",
        name: "db_url",
        placeholder: "libsql://your-db.turso.io",
        type: "url",
      },
      {
        label: "Database Token",
        name: "db_token",
        placeholder: "Database auth token",
        type: "password",
      },
      {
        label: "Hosting ID",
        name: "hosting_id",
        placeholder: "Script ID or app ID",
        type: "text",
      },
      {
        label: "Hosting Provider",
        name: "hosting_provider",
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
        label: "Database Provider",
        name: "db_provider",
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
        hint: "Letters, numbers, hyphens, underscores (2-32 chars)",
        label: "Admin Username *",
        name: "admin_username",
        required: true,
        type: "text",
      },
      {
        autocomplete: "new-password",
        hint: "Minimum 8 characters",
        label: "Admin Password *",
        name: "admin_password",
        required: true,
        type: "password",
      },
      {
        autocomplete: "new-password",
        label: "Confirm Admin Password *",
        name: "admin_password_confirm",
        required: true,
        type: "password",
      },
    ]);
  });

  test("the change-password form serves exactly its declared fields", () => {
    expect(getChangePasswordForm().fields.map(shape)).toEqual([
      {
        autocomplete: "current-password",
        label: "Current Password",
        name: "current_password",
        required: true,
        type: "password",
      },
      {
        autocomplete: "new-password",
        hint: "Minimum 8 characters",
        label: "New Password",
        name: "new_password",
        required: true,
        type: "password",
      },
      {
        autocomplete: "new-password",
        label: "Confirm New Password",
        name: "new_password_confirm",
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
        label: "Stripe Secret Key",
        name: "stripe_secret_key",
        placeholder: "sk_live_... or sk_test_...",
        required: true,
        type: "password",
      },
    ]);
  });

  test("the Square access fields serves exactly its declared fields", () => {
    expect(getSquareAccessTokenFields().map(shape)).toEqual([
      {
        autocomplete: "off",
        hint: "Your Square application's access token",
        label: "Square Access Token",
        name: "square_access_token",
        placeholder: "EAAAl...",
        required: true,
        type: "password",
      },
      {
        autocomplete: "off",
        hint: "Your Square location ID (found in Square Dashboard under Locations)",
        label: "Location ID",
        name: "square_location_id",
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
        label: "Webhook Signature Key",
        name: "square_webhook_signature_key",
        required: true,
        type: "password",
      },
    ]);
  });

  test("the SumUp fields serves exactly its declared fields", () => {
    expect(getSumupFields().map(shape)).toEqual([
      {
        autocomplete: "off",
        hint: "Your SumUp secret API key, from me.sumup.com → For Developers → API Keys",
        label: "SumUp API Key",
        name: "sumup_api_key",
        placeholder: "Paste your SumUp API key",
        required: true,
        type: "password",
      },
      {
        autocomplete: "off",
        hint: "Your SumUp merchant code, shown in your SumUp account profile (must match the API key's account)",
        label: "Merchant Code",
        name: "sumup_merchant_code",
        placeholder: "M...",
        required: true,
        type: "text",
      },
    ]);
  });

  test("the invite-user form serves exactly its declared fields", () => {
    expect(getInviteUserForm().fields.map(shape)).toEqual([
      {
        hint: "Letters, numbers, hyphens, underscores (2-32 chars)",
        label: "Username",
        name: "username",
        pattern: "[a-zA-Z0-9_\\-]+",
        required: true,
        title: "Letters, numbers, hyphens, and underscores only",
        type: "text",
      },
      {
        invalidMessage: "Invalid role",
        label: "Role",
        name: "admin_level",
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
        ],
        required: true,
        type: "select",
      },
    ]);
  });
});

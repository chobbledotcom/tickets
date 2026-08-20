import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ADMIN_FEATURE_TRIGGERS } from "#db/migrations/schema/admin-feature-triggers.ts";

const SETTINGS_USE = { settings: ["key", "value"] } as const;

const triggerContract = (trigger: (typeof ADMIN_FEATURE_TRIGGERS)[number]) => ({
  condition: trigger.sql.match(/\nWHEN ([^\n]+)\nBEGIN/)?.[1] ?? null,
  event: trigger.sql.split("\n")[1],
  name: trigger.name,
  table: trigger.table,
  uses: trigger.uses,
});

test("declares every feature trigger source and dependency", () => {
  expect(ADMIN_FEATURE_TRIGGERS.map(triggerContract)).toEqual([
    {
      condition: null,
      event: "AFTER INSERT ON attributes",
      name: "trg_admin_feature_attributes_insert",
      table: "attributes",
      uses: { attributes: [], ...SETTINGS_USE },
    },
    {
      condition: null,
      event: "AFTER UPDATE OF name, sort_order ON attributes",
      name: "trg_admin_feature_attributes_update",
      table: "attributes",
      uses: { attributes: ["name", "sort_order"], ...SETTINGS_USE },
    },
    {
      condition: null,
      event: "AFTER INSERT ON questions",
      name: "trg_admin_feature_questions_insert",
      table: "questions",
      uses: { questions: [], ...SETTINGS_USE },
    },
    {
      condition: null,
      event:
        "AFTER UPDATE OF text, sort_order, display_type, assign_all ON questions",
      name: "trg_admin_feature_questions_update",
      table: "questions",
      uses: {
        questions: ["text", "sort_order", "display_type", "assign_all"],
        ...SETTINGS_USE,
      },
    },
    {
      condition: null,
      event: "AFTER INSERT ON modifiers",
      name: "trg_admin_feature_modifiers_insert",
      table: "modifiers",
      uses: { modifiers: [], ...SETTINGS_USE },
    },
    {
      condition: null,
      event:
        "AFTER UPDATE OF name, calc_kind, calc_value, direction, active, trigger, code, code_index, scope, stock, max_per_order, min_subtotal, min_visits ON modifiers",
      name: "trg_admin_feature_modifiers_update",
      table: "modifiers",
      uses: {
        modifiers: [
          "name",
          "calc_kind",
          "calc_value",
          "direction",
          "active",
          "trigger",
          "code",
          "code_index",
          "scope",
          "stock",
          "max_per_order",
          "min_subtotal",
          "min_visits",
        ],
        ...SETTINGS_USE,
      },
    },
    {
      condition: null,
      event: "AFTER INSERT ON logistics_agents",
      name: "trg_admin_feature_logistics_agents_insert",
      table: "logistics_agents",
      uses: { logistics_agents: [], ...SETTINGS_USE },
    },
    {
      condition: null,
      event: "AFTER UPDATE OF name ON logistics_agents",
      name: "trg_admin_feature_logistics_agents_update",
      table: "logistics_agents",
      uses: { logistics_agents: ["name"], ...SETTINGS_USE },
    },
    {
      condition: "NEW.uses_logistics = 1",
      event: "AFTER INSERT ON listings",
      name: "trg_admin_feature_logistics_listings_insert",
      table: "listings",
      uses: { listings: ["uses_logistics"], ...SETTINGS_USE },
    },
    {
      condition: "NEW.uses_logistics = 1",
      event: "AFTER UPDATE OF uses_logistics ON listings",
      name: "trg_admin_feature_logistics_listings_update",
      table: "listings",
      uses: { listings: ["uses_logistics"], ...SETTINGS_USE },
    },
    {
      condition: null,
      event: "AFTER INSERT ON api_keys",
      name: "trg_admin_feature_api_keys_insert",
      table: "api_keys",
      uses: { api_keys: [], ...SETTINGS_USE },
    },
    {
      condition: "NEW.kind = 'servicing'",
      event: "AFTER INSERT ON attendees",
      name: "trg_admin_feature_servicing_insert",
      table: "attendees",
      uses: { attendees: ["kind"], ...SETTINGS_USE },
    },
    {
      condition: "NEW.kind = 'servicing'",
      event: "AFTER UPDATE OF kind, pii_blob ON attendees",
      name: "trg_admin_feature_servicing_update",
      table: "attendees",
      uses: { attendees: ["kind", "pii_blob"], ...SETTINGS_USE },
    },
  ]);
});

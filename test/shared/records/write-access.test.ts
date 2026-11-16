/** What one writer can set on this site now, from the site's own state. */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { LISTING_WRITE_KEYS } from "#shared/records/listing-fields.ts";
import {
  closedFieldsFor,
  withoutHiddenKeys,
  writeAccessFor,
} from "#shared/records/write-access.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { featureSetting } from "#test-utils/settings.ts";

/** The field features of a bare site. */
const NONE = {
  attributes: false,
  builder: false,
  logistics: false,
  subscriptions: false,
};

/** A listing answer that holds a key of each feature and two of none. */
const ROW = {
  assign_built_site: false,
  attribute_option_ids: [1],
  group_ids: [2],
  initial_site_months: 0,
  months_per_unit: 0,
  name: "Walk",
  recurring_price: 0,
  uses_logistics: false,
};

describeWithEnv("write access", { db: true }, () => {
  afterEach(() => {
    settings.clearTestOverride("enabled_features");
    setDemoModeForTest(false);
  });

  test("a site with every field feature on closes no feature", () => {
    using _env = withEnv({ CAN_BUILD_SITES: "true" });
    settings.setForTest(
      featureSetting("attributes", "logistics", "subscriptions"),
    );

    expect(writeAccessFor("owner")).toEqual({
      features: {
        attributes: true,
        builder: true,
        logistics: true,
        subscriptions: true,
      },
      locks: { demo: false, editor: false, nonOwner: false },
    });
    expect(withoutHiddenKeys(LISTING_WRITE_KEYS, ROW)).toEqual(ROW);
    expect([...closedFieldsFor(LISTING_WRITE_KEYS, "owner")]).toEqual([]);
  });

  test("each field feature follows its own switch", () => {
    using _env = withEnv({ CAN_BUILD_SITES: undefined });
    const featuresWith = (
      ...on: ("attributes" | "logistics" | "subscriptions")[]
    ) => {
      settings.setForTest(featureSetting(...on));
      return writeAccessFor("owner").features;
    };

    expect([
      featuresWith(),
      featuresWith("attributes"),
      featuresWith("logistics"),
      featuresWith("subscriptions"),
    ]).toEqual([
      { ...NONE },
      { ...NONE, attributes: true },
      { ...NONE, logistics: true },
      { ...NONE, subscriptions: true },
    ]);
  });

  test("site building follows CAN_BUILD_SITES alone", () => {
    settings.setForTest(featureSetting("attributes", "logistics"));
    using _env = withEnv({ CAN_BUILD_SITES: "true" });

    expect(writeAccessFor("owner").features.builder).toBe(true);
  });

  test("each lock follows the writer and the demo", () => {
    const locksOf = (level: "editor" | "manager" | "owner" | undefined) =>
      writeAccessFor(level).locks;

    expect([
      locksOf("owner"),
      locksOf("manager"),
      locksOf("editor"),
      locksOf(undefined),
    ]).toEqual([
      { demo: false, editor: false, nonOwner: false },
      { demo: false, editor: false, nonOwner: true },
      { demo: false, editor: true, nonOwner: true },
      { demo: false, editor: false, nonOwner: true },
    ]);
    setDemoModeForTest(true);
    expect(locksOf("owner").demo).toBe(true);
  });

  test("an answer on a bare site leaves out every key of a feature that is off", () => {
    using _env = withEnv({ CAN_BUILD_SITES: undefined });
    settings.setForTest(featureSetting());

    expect(withoutHiddenKeys(LISTING_WRITE_KEYS, ROW)).toEqual({
      group_ids: [2],
      name: "Walk",
    });
  });

  test("a manager on a bare site cannot set the feature keys or the owner key", () => {
    using _env = withEnv({ CAN_BUILD_SITES: undefined });
    settings.setForTest(featureSetting("attributes"));

    expect([...closedFieldsFor(LISTING_WRITE_KEYS, "manager")]).toEqual([
      ["assign_built_site", "builder"],
      ["initial_site_months", "builder"],
      ["months_per_unit", "builder"],
      ["recurring_interval", "subscriptions"],
      ["recurring_price", "subscriptions"],
      ["uses_logistics", "logistics"],
      ["attribute_option_ids", "nonOwner"],
    ]);
  });
});

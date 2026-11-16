/**
 * `describeWithEnv` for the suites of a record that belongs to an admin
 * feature. Each test starts with the feature on, as it is on a site that
 * uses the record. A suite that tests the feature turned off sets it off in
 * the test.
 */

import type { AdminFeatureKey } from "#shared/admin-features.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { featureSetting, useSetting } from "#test-utils/settings.ts";

const suiteWith =
  (...features: AdminFeatureKey[]): typeof describeWithEnv =>
  (name, options, fn) =>
    describeWithEnv(name, options, () => {
      useSetting(featureSetting(...features));
      fn();
    });

export const describeWithAttributes = suiteWith("attributes");
export const describeWithQuestions = suiteWith("questions");
export const describeWithSitePages = suiteWith("site");

/** For a suite that drives every record of the API in one run. */
export const describeWithRecordFeatures = suiteWith(
  "attributes",
  "questions",
  "site",
);

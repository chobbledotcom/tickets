import { addFeatureTurnedOff, bareSchemaMigration } from "./define.ts";

export default bareSchemaMigration(
  "2026-11-23_club_night_dashboard",
  "Add the club night dashboard feature, turned off, to the stored feature list.",
  addFeatureTurnedOff("clubNightDashboard"),
);

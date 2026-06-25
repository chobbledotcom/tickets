import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-24_built_sites_updates",
  "Add an updates column to built_sites recording the release channel each site opts into (alpha/beta/release, default release), so the deploy-clients workflow can pass a tier and the site-credentials endpoint returns only the sites at that tier or more eager",
  {
    columns: { built_sites: ["updates"] },
  },
);

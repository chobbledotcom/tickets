import { t } from "#i18n";
import {
  promoteSiteSchedulerRotation,
  provisionSiteScheduler,
  stageSiteSchedulerRotation,
} from "#shared/site-scheduler.ts";
import { builtSiteAction, builtSiteTabResult } from "./built-site-action.ts";

const maintenanceResult = builtSiteTabResult("maintenance");

export const handleProvisionSiteScheduler = builtSiteAction(
  async (_site, _form, id) =>
    maintenanceResult(t("built_sites.maintenance_provisioned"))(
      id,
      await provisionSiteScheduler(id),
    ),
);

export const handleStageSiteSchedulerRotation = builtSiteAction(
  async (_site, _form, id) =>
    maintenanceResult(t("built_sites.maintenance_verified"))(
      id,
      await stageSiteSchedulerRotation(id),
    ),
);

export const handlePromoteSiteSchedulerRotation = builtSiteAction(
  async (_site, _form, id) =>
    maintenanceResult(t("built_sites.maintenance_promoted"))(
      id,
      await promoteSiteSchedulerRotation(id),
    ),
);

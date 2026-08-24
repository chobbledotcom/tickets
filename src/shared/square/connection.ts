/* jscpd:ignore-start */
import { settings } from "#db/settings.ts";
import { errorMessage } from "#shared/error-message.ts";
import type { CredentialCheck } from "#shared/payment-helpers.ts";
import type { GetSquareClient } from "#shared/square/client.ts";
import type { SquareLocation } from "#shared/square/wire.ts";
/* jscpd:ignore-end */

/** The operator-facing result of checking the stored Square configuration. */
export type SquareConnectionTestResult = {
  ok: boolean;
  accessToken: CredentialCheck;
  location: {
    configured: boolean;
    locationId?: string | undefined;
    name?: string | undefined;
    status?: string | undefined;
    error?: string | undefined;
  };
  webhook: { configured: boolean; error?: string };
};

/** Check the access token, chosen location, and webhook key. */
export const testSquareConnection = async (
  getClient: GetSquareClient,
): Promise<SquareConnectionTestResult> => {
  const result: SquareConnectionTestResult = {
    accessToken: { valid: false },
    location: { configured: false },
    ok: false,
    webhook: { configured: false },
  };

  const client = await getClient();
  if (!client) {
    result.accessToken.error = "No Square access token configured";
    return result;
  }

  let locations: SquareLocation[] = [];
  try {
    locations = (await client.locations.list()).locations;
    result.accessToken = {
      mode: settings.square.sandbox ? "sandbox" : "production",
      valid: true,
    };
  } catch (error) {
    result.accessToken = { error: errorMessage(error), valid: false };
    return result;
  }

  const locationId = settings.square.locationId;
  if (!locationId) {
    result.location = {
      configured: false,
      error: "No location ID configured",
    };
  } else {
    const match = locations.find((location) => location.id === locationId);
    result.location = match
      ? {
          configured: true,
          locationId,
          name: match.name,
          status: match.status,
        }
      : {
          configured: false,
          error: "Location ID not found in account",
          locationId,
        };
  }

  const webhookKey = settings.square.webhookSignatureKey;
  result.webhook = { configured: webhookKey !== "" };
  if (!webhookKey) {
    result.webhook.error = "No webhook signature key configured";
  }
  result.ok =
    result.accessToken.valid &&
    result.location.configured &&
    result.webhook.configured;
  return result;
};

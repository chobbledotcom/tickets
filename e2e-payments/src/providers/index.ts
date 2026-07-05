import type { ProviderName } from "../config.ts";
import { stripe } from "./stripe.ts";
import { square } from "./square.ts";
import { sumup } from "./sumup.ts";
import type { PaymentProvider } from "./types.ts";

export const providers: Record<ProviderName, PaymentProvider> = {
  stripe,
  square,
  sumup,
};

export type { PaymentProvider };

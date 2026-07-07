import type { ProviderName } from "../config.ts";
import { square } from "./square.ts";
import { stripe } from "./stripe.ts";
import { sumup } from "./sumup.ts";
import type { PaymentProvider } from "./types.ts";

export const providers: Record<ProviderName, PaymentProvider> = {
  square,
  stripe,
  sumup,
};

export type { PaymentProvider };

// Keep provider behavior in its focused suite while giving targeted mutation
// the direct mirror required for src/shared/stripe-provider.ts.
import "../lib/stripe/provider.test.ts";
import "./stripe-checkout-close.test.ts";

import type { Consent } from "../../shared/consent.js";
export interface CmpAdapter {
  read(): Consent | undefined;
  subscribe(onChange: () => void): () => void;
}
export function categories(analytics: boolean, marketing: boolean): Consent {
  return {
    analytics_storage: analytics ? "granted" : "denied",
    ad_storage: marketing ? "granted" : "denied",
    ad_user_data: marketing ? "granted" : "denied",
    ad_personalization: marketing ? "granted" : "denied",
  };
}

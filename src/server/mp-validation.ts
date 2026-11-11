import { PAGE_TEXT_BYTES, shortenBytes } from "../shared/event.js";
/** Standard-property parameter limits. Diagnostics deliberately omit visitor values and custom names. */
const reservedEvents = new Set(
  "ad_activeview ad_click ad_exposure ad_query ad_reward adunit_exposure app_clear_data app_exception app_install app_remove app_store_refund app_update app_upgrade dynamic_link_app_open dynamic_link_app_update dynamic_link_first_open error firebase_campaign firebase_in_app_message_action firebase_in_app_message_dismiss firebase_in_app_message_impression first_open first_visit notification_dismiss notification_foreground notification_open notification_receive notification_send os_update session_start user_engagement ad_impression in_app_purchase screen_view".split(
    " ",
  ),
);
export function validName(name: string) {
  return (
    /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) &&
    !/^(firebase_|ga_|google_|gtag\.)/.test(name) &&
    name !== "firebase_conversion"
  );
}
export function validEventName(name: string) {
  return validName(name) && !reservedEvents.has(name);
}
const automatic = [
  "session_id",
  "engagement_time_msec",
  "page_location",
  "page_referrer",
  "page_title",
];
const pageText = new Set(["page_location", "page_referrer", "page_title"]);
/** Google keeps the first 100 characters of a longer value (BigQuery, 2026-11-11), like a Google tag hit. */
const TEXT_CHARS = 100;
function shortenText(raw: string, diagnose: () => void) {
  const chars = Array.from(raw);
  if (chars.length <= TEXT_CHARS) return raw;
  diagnose();
  return chars.slice(0, TEXT_CHARS).join("");
}
const itemStandard = new Set(
  "item_id item_name affiliation coupon discount index item_brand item_category item_category2 item_category3 item_category4 item_category5 item_list_id item_list_name item_variant location_id price quantity creative_name creative_slot promotion_id promotion_name".split(
    " ",
  ),
);
function validateItem(input: Record<string, unknown>, diagnose: (reason: string) => void) {
  const output: Record<string, unknown> = {};
  let custom = 0;
  for (const [key, raw] of Object.entries(input)) {
    if (!validName(key)) {
      diagnose("Event item parameter dropped: invalid or reserved name");
      continue;
    }
    if (!itemStandard.has(key) && custom >= 27) {
      diagnose("Event item parameter dropped: maximum 27 custom parameters");
      continue;
    }
    if (typeof raw === "string")
      output[key] = shortenText(raw, () =>
        diagnose(`Event item parameter truncated to ${TEXT_CHARS} characters`),
      );
    else if (typeof raw === "number" && Number.isFinite(raw)) output[key] = raw;
    else {
      diagnose("Event item parameter dropped: unsupported value type");
      continue;
    }
    if (!itemStandard.has(key)) custom++;
  }
  return output;
}
export function validateParams(
  input: Record<string, unknown>,
  diagnose: (reason: string) => void = console.warn,
) {
  const output: Record<string, unknown> = {};
  const entries = [
    ...automatic
      .filter((key) => Object.hasOwn(input, key))
      .map((key) => [key, input[key]] as const),
    ...Object.entries(input).filter(([key]) => !automatic.includes(key)),
  ];
  for (const [key, raw] of entries) {
    if (!validName(key)) {
      diagnose("Event parameter dropped: invalid or reserved name");
      continue;
    }
    if (Object.keys(output).length >= 25) {
      diagnose("Event parameter dropped: maximum 25 parameters including automatic fields");
      continue;
    }
    if (typeof raw === "string") {
      if (pageText.has(key)) {
        output[key] = shortenBytes(raw, PAGE_TEXT_BYTES);
        if (output[key] !== raw) diagnose(`Event page text truncated to ${PAGE_TEXT_BYTES} bytes`);
      } else
        output[key] = shortenText(raw, () =>
          diagnose(`Event parameter truncated to ${TEXT_CHARS} characters`),
        );
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      if (key === "engagement_time_msec" && (!Number.isInteger(raw) || raw < 0)) {
        diagnose("Event parameter dropped: engagement must be a non-negative integer");
        continue;
      }
      output[key] = raw;
    } else if (typeof raw === "boolean") output[key] = raw;
    else if (key === "items" && Array.isArray(raw)) {
      // Ecommerce items allow all documented fields plus up to 27 custom parameters.
      output[key] = raw
        .slice(0, 200)
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => validateItem(item as Record<string, unknown>, diagnose));
      if (raw.length > 200) diagnose("Event items truncated to 200 entries");
    } else diagnose("Event parameter dropped: unsupported value type");
  }
  return output;
}

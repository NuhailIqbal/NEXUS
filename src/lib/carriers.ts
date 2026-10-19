/**
 * Phone carriers a user can connect with their own account (BYOT: "bring your own telephony").
 * One registry drives every form and label so Twilio, Vonage and Telnyx stay consistent.
 *
 * The API keeps two generic field names for every carrier (see backend/services/carriers.py):
 *   account_sid — the public identifier (Twilio Account SID / Vonage API Key; Telnyx has none)
 *   auth_token  — the secret (Twilio Auth Token / Vonage API Secret / Telnyx API Key)
 */

export type CarrierKey = "twilio" | "vonage" | "telnyx";

export type CarrierField = {
  /** Request/response field name. */
  key: "account_sid" | "auth_token";
  label: string;
  placeholder: string;
  /** Where to find it in the carrier's console. */
  help: string;
  /** Masked by default (with a reveal toggle). */
  secret?: boolean;
};

export type CarrierDef = {
  key: CarrierKey;
  label: string;
  fields: CarrierField[];
  /** Placeholder for the optional account label input. */
  labelPlaceholder: string;
  /** Short note shown in the Connect dialog (where to find the keys, who bills what). */
  connectNote: string;
  /** Shown when creating a number on this carrier, if there is a carrier-side setup step. */
  numberNote?: string;
  /** Value the Create Phone Number dialog uses for this carrier's "your own account" provider. */
  providerValue: string;
};

export const CARRIERS: Record<CarrierKey, CarrierDef> = {
  twilio: {
    key: "twilio",
    label: "Twilio",
    providerValue: "BYOT", // historical value, kept so existing callers keep working
    labelPlaceholder: "e.g. My Twilio account",
    connectNote:
      "Find these under your Twilio Console → Account → API keys & tokens. Your number stays billed " +
      "directly by Twilio to your own account — we only use these credentials to connect it to your AI agent.",
    fields: [
      { key: "account_sid", label: "Account SID", placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", help: "Twilio Console → Account" },
      { key: "auth_token", label: "Auth Token", placeholder: "Your Twilio Auth Token", help: "Twilio Console → Account → API keys & tokens", secret: true },
    ],
  },
  vonage: {
    key: "vonage",
    label: "Vonage",
    providerValue: "BYOT_VONAGE",
    labelPlaceholder: "e.g. My Vonage account",
    connectNote:
      "Find these in your Vonage API Dashboard → API settings. Your number stays billed directly by " +
      "Vonage to your own account — we only use these credentials to connect it to your AI agent.",
    fields: [
      { key: "account_sid", label: "API Key", placeholder: "Your Vonage API Key", help: "Vonage API Dashboard → API settings" },
      { key: "auth_token", label: "API Secret", placeholder: "Your Vonage API Secret", help: "Vonage API Dashboard → API settings", secret: true },
    ],
  },
  telnyx: {
    key: "telnyx",
    label: "Telnyx",
    providerValue: "BYOT_TELNYX",
    labelPlaceholder: "e.g. My Telnyx account",
    connectNote:
      "Create an API key in your Telnyx Mission Control portal → Keys & Credentials. Your number stays " +
      "billed directly by Telnyx to your own account — we only use this key to connect it to your AI agent.",
    numberNote:
      "For outbound calls, your Telnyx Outbound Voice Profile must allow the countries you call and include " +
      "this number's connection. Inbound calls work right away.",
    fields: [
      { key: "auth_token", label: "API Key", placeholder: "KEYxxxxxxxxxxxxxxxx", help: "Telnyx portal → Keys & Credentials → API Keys", secret: true },
    ],
  },
};

export const CARRIER_KEYS = Object.keys(CARRIERS) as CarrierKey[];

/** Unknown/missing carrier values (older rows, pre-carrier API) are Twilio. */
export function carrierOf(value?: string | null): CarrierDef {
  return CARRIERS[(value || "twilio").toLowerCase() as CarrierKey] ?? CARRIERS.twilio;
}

/** The Create Phone Number dialog's provider value ("BYOT", "BYOT_VONAGE", …) -> carrier, or null for Standard. */
export function carrierFromProviderValue(value?: string | null): CarrierDef | null {
  return CARRIER_KEYS.map((k) => CARRIERS[k]).find((c) => c.providerValue === value) ?? null;
}

/** The identifier field (Twilio SID / Vonage API key), or undefined for carriers without one (Telnyx). */
export const identifierField = (c: CarrierDef) => c.fields.find((f) => f.key === "account_sid");
/** The secret field (always present). */
export const secretField = (c: CarrierDef) => c.fields.find((f) => f.key === "auth_token")!;

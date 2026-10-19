"""
Carrier registry for BYOT ("bring your own carrier") phone numbers.

Each carrier (Twilio, Vonage, Telnyx) is reached through the same few operations:
validate an account, look up a number the account owns, buy a new one, release one, and
describe how VAPI should import it. The rest of the backend (credentials service,
telephony router) talks only to this module, so adding a carrier means adding one
`*_service.py` plus an entry here.

Storage/API vocabulary is shared across carriers — a credential is an optional public
"identifier" plus a "secret" (twilio_byot_credentials.account_sid / the encrypted
auth_token, and the account_sid / auth_token request fields):

    carrier   identifier            secret
    twilio    Account SID           Auth Token
    vonage    API key               API secret
    telnyx    (none)                API v2 key

Functions look up the carrier service module's functions at call time (not at import
time) so tests can patch them on the module.
"""
from dataclasses import dataclass

from services import twilio_service, vonage_service, telnyx_service


@dataclass(frozen=True)
class CarrierSpec:
    key: str
    label: str                    # user-facing name
    identifier_required: bool     # whether the public identifier must be supplied
    required_message: str         # shown when a required field is blank
    rejected_message: str         # shown when the carrier rejects the credentials
    needs_vapi_credential: bool   # Vonage/Telnyx numbers are imported by credentialId


SPECS: dict[str, CarrierSpec] = {
    "twilio": CarrierSpec(
        "twilio", "Twilio", True,
        "Account SID and Auth Token are both required.",
        "Twilio rejected these credentials — check the Account SID and Auth Token.",
        False,
    ),
    "vonage": CarrierSpec(
        "vonage", "Vonage", True,
        "API key and API secret are both required.",
        "Vonage rejected these credentials — check the API key and API secret.",
        True,
    ),
    "telnyx": CarrierSpec(
        "telnyx", "Telnyx", False,
        "An API key is required.",
        "Telnyx rejected this API key — check it and try again.",
        True,
    ),
}

CARRIERS = tuple(SPECS)


def spec(carrier: str) -> CarrierSpec:
    try:
        return SPECS[(carrier or "").lower()]
    except KeyError:
        raise ValueError(f"Unsupported carrier: {carrier!r}")


def normalize_number(carrier: str, number: str) -> str:
    """E.164-style form of a user-typed number for Vonage/Telnyx ("+15551234567"), tolerating
    spaces, dashes, dots and brackets, and a missing "+" (11 digits starting with 1, or 10
    digits, are taken as US). Twilio input is left exactly as typed. Anything that doesn't
    look like a phone number is returned unchanged so the carrier lookup reports it."""
    if spec(carrier).key == "twilio":
        return number
    raw = (number or "").strip()
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not digits or any(ch.isalpha() for ch in raw):
        return raw
    if raw.startswith("+"):
        return f"+{digits}"
    if len(digits) == 10:
        return f"+1{digits}"
    return f"+{digits}"


async def validate_credentials(carrier: str, identifier: str | None, secret: str) -> bool:
    c = spec(carrier).key
    if c == "twilio":
        return await twilio_service.validate_credentials(identifier, secret)
    if c == "vonage":
        return await vonage_service.validate_credentials(identifier, secret)
    return await telnyx_service.validate_credentials(secret)


async def find_number(carrier: str, number: str, identifier: str | None, secret: str) -> str | None:
    """The carrier's reference for this number if the account owns it, else None.
    (Twilio: the PN sid. Vonage: the msisdn. Telnyx: Telnyx's phone number id.)"""
    c = spec(carrier).key
    if c == "twilio":
        return await twilio_service.find_sid_by_number(number, account_sid=identifier, auth_token=secret)
    if c == "vonage":
        return await vonage_service.find_number(number, identifier, secret)
    return await telnyx_service.find_number(number, secret)


async def buy_number(carrier: str, identifier: str | None, secret: str, area_code: str | None = None) -> dict:
    """Buy a US voice number on the user's account. Returns {"number": "+1...", "ref": ...}
    where ref is the same carrier reference find_number returns."""
    c = spec(carrier).key
    if c == "twilio":
        bought = await twilio_service.buy_us_number(
            sms=True, voice=True, area_code=area_code, account_sid=identifier, auth_token=secret,
        )
        return {"number": bought["number"], "ref": bought.get("sid")}
    if c == "vonage":
        return await vonage_service.buy_us_number(identifier, secret, area_code=area_code)
    return await telnyx_service.buy_us_number(secret, area_code=area_code)


async def release_number(carrier: str, number: str, ref: str | None, identifier: str | None, secret: str) -> None:
    c = spec(carrier).key
    if c == "twilio":
        await twilio_service.release_number(ref, account_sid=identifier, auth_token=secret)
    elif c == "vonage":
        await vonage_service.release_number(number, identifier, secret)
    else:
        # Telnyx deletes by its own phone-number id; if it wasn't captured at purchase time,
        # find it by the number so a rollback never silently skips the release.
        ref = ref or await telnyx_service.find_number(number, secret)
        if not ref:
            raise RuntimeError(f"Could not locate {number} on the Telnyx account to release it.")
        await telnyx_service.release_number(ref, secret)


def vapi_credential_payload(carrier: str, identifier: str | None, secret: str, name: str) -> dict | None:
    """Body for POST /credential, or None for carriers that need no VAPI credential."""
    c = spec(carrier).key
    if c == "vonage":
        return {"provider": "vonage", "name": name, "apiKey": identifier, "apiSecret": secret}
    if c == "telnyx":
        return {"provider": "telnyx", "name": name, "apiKey": secret}
    return None


def vapi_credential_update_payload(carrier: str, identifier: str | None, secret: str) -> dict:
    """Body for PATCH /credential/{id} when the keys change (the name stays put). The provider
    is included because VAPI's update bodies are keyed by it."""
    c = spec(carrier).key
    if c == "vonage":
        return {"provider": "vonage", "apiKey": identifier, "apiSecret": secret}
    return {"provider": "telnyx", "apiKey": secret}


def vapi_phone_payload(carrier: str, number: str, identifier: str | None, secret: str,
                       vapi_credential_id: str | None) -> dict:
    """Body for POST /phone-number importing `number` into VAPI."""
    c = spec(carrier).key
    if c == "twilio":
        return {"provider": "twilio", "number": number,
                "twilioAccountSid": identifier, "twilioAuthToken": secret}
    if not vapi_credential_id:
        raise RuntimeError(f"No voice-service credential stored for this {spec(c).label} account.")
    return {"provider": c, "number": number, "credentialId": vapi_credential_id}

"""
BYOT (Bring Your Own Carrier) credential storage — Twilio, Vonage and Telnyx accounts.

A user's carrier secret (Twilio Auth Token / Vonage API secret / Telnyx API key) is
sensitive — it grants control of their carrier account (buy/release numbers, spend their
money). It is never stored or returned in the clear: encrypted at rest with the same
Fernet scheme `integrations.config_encrypted` already uses (services/encryption.py), and
only ever masked when shown back to the frontend. What "identifier" and "secret" mean per
carrier is documented in services/carriers.py (the columns/fields keep their historical
Twilio names: account_sid / auth_token).

Vonage and Telnyx numbers are imported into VAPI by credentialId, so connecting one of those
accounts also registers a VAPI credential (stored as vapi_credential_id); it is updated when
the keys change and removed with the account.
"""
# Entry points: save_credentials / list_credentials / update_credentials /
# delete_credentials back the /twilio-credentials CRUD endpoints in routers/telephony.py;
# get_credential_record is the internal-only decrypting lookup used when provisioning a BYOT
# phone number there. Tables: twilio_byot_credentials (read/write) and phone_numbers
# (read-only, for the in-use check on delete). All lookups are scoped by user_id, which the
# router passes as the team owner's id.
import logging

from database import supabase
from services import carriers, vapi_client
from services.encryption import encrypt_config, decrypt_config, mask_config

logger = logging.getLogger(__name__)


class InvalidTwilioCredentials(Exception):
    """Raised when a carrier's credentials are missing, rejected by the carrier, or could
    not be verified. The message is user-facing; the router maps it to HTTP 400.
    (Name kept from when Twilio was the only carrier.)"""
    pass


class CredentialInUse(Exception):
    """Raised by delete_credentials when phone numbers still reference the credential.
    The message is user-facing and lists those numbers; the router maps it to HTTP 400."""
    pass


def _row_public(row: dict) -> dict:
    """Strip config_encrypted (and the internal VAPI credential id) and attach a masked
    secret for display."""
    out = {k: v for k, v in row.items() if k not in ("config_encrypted", "vapi_credential_id")}
    out["carrier"] = row.get("carrier") or "twilio"
    # Decrypt only to build the mask (first/last two characters). If the blob can't be
    # decrypted (e.g. the encryption key changed), show a fully masked placeholder so
    # listing credentials never fails because of one unreadable row.
    try:
        config = decrypt_config(row["config_encrypted"])
        out["auth_token_masked"] = mask_config(config).get("auth_token")
    except Exception:
        out["auth_token_masked"] = "****"
    return out


async def _verify(carrier: str, identifier: str | None, secret: str) -> None:
    """Raise InvalidTwilioCredentials unless the carrier accepts these credentials."""
    spec = carriers.spec(carrier)
    try:
        valid = await carriers.validate_credentials(carrier, identifier, secret)
    except Exception:
        # A network/timeout error reaching the carrier must not surface as a raw 500 — the
        # user can't tell that apart from "my credentials are wrong", so give them a
        # clear, retryable message instead.
        raise InvalidTwilioCredentials(
            f"Could not verify these credentials with {spec.label} right now. Please try again."
        )
    if not valid:
        raise InvalidTwilioCredentials(spec.rejected_message)


async def save_credentials(user_id: str, account_sid: str | None, auth_token: str,
                           label: str | None = None, carrier: str = "twilio") -> dict:
    """Validate a carrier account against the carrier, then store it for `user_id`.

    The secret is Fernet-encrypted into twilio_byot_credentials.config_encrypted; nothing is
    stored unless the carrier accepts the credentials (and, for Vonage/Telnyx, the voice
    service accepts the matching credential). Returns the saved row in public form (masked
    secret, no ciphertext). Raises InvalidTwilioCredentials for blank, rejected or
    unverifiable credentials. No de-duplication: the same account can be saved twice.
    """
    try:
        spec = carriers.spec(carrier)
    except ValueError as e:
        raise InvalidTwilioCredentials(str(e))
    identifier = (account_sid or "").strip() or None
    secret = (auth_token or "").strip()
    if not secret or (spec.identifier_required and not identifier):
        raise InvalidTwilioCredentials(spec.required_message)
    if not spec.identifier_required:
        identifier = None

    await _verify(spec.key, identifier, secret)

    vapi_credential_id = None
    payload = carriers.vapi_credential_payload(spec.key, identifier, secret, f"nexus-{spec.key}-{user_id[:8]}")
    if payload:
        try:
            vapi_credential_id = (await vapi_client.create_credential(payload)).get("id")
        except Exception as e:
            logger.error("VAPI credential create failed for %s account: %s", spec.key, e)
            raise InvalidTwilioCredentials(
                f"{spec.label} accepted these credentials, but the account couldn't be set up for "
                "voice calls. Check the keys have full access and try again."
            )

    row = {
        "user_id": user_id,
        "carrier": spec.key,
        "account_sid": identifier,
        "config_encrypted": encrypt_config({"auth_token": secret}),
        "label": label,
        "vapi_credential_id": vapi_credential_id,
    }
    try:
        result = supabase.table("twilio_byot_credentials").insert(row).execute()
    except Exception:
        await _drop_vapi_credential(vapi_credential_id)  # don't leave an orphan behind
        raise
    return _row_public(result.data[0] if result.data else row)


async def _drop_vapi_credential(vapi_credential_id: str | None) -> None:
    """Best-effort removal of a VAPI credential; a failure is logged, never raised."""
    if not vapi_credential_id:
        return
    try:
        await vapi_client.delete_credential(vapi_credential_id)
    except Exception:
        logger.warning("Failed to delete VAPI credential %s", vapi_credential_id, exc_info=True)


def list_credentials(user_id: str) -> list[dict]:
    """All of `user_id`'s saved carrier accounts, newest first, in public form
    (masked secret, no ciphertext). Makes no call to any carrier."""
    result = (
        supabase.table("twilio_byot_credentials")
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [_row_public(r) for r in (result.data or [])]


def get_credential_record(credential_id: str, user_id: str) -> dict | None:
    """Decrypted record for internal use only — never returned to the frontend:
    {"carrier", "identifier", "secret", "vapi_credential_id"}. None if the credential
    doesn't exist or isn't owned by user_id."""
    row = (
        supabase.table("twilio_byot_credentials")
        .select("carrier, account_sid, config_encrypted, vapi_credential_id")
        .eq("id", credential_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    if not row.data:
        return None
    # An undecryptable blob (e.g. the encryption key changed) is reported the same as "not
    # found"; the provisioning caller turns None into a 404.
    try:
        config = decrypt_config(row.data["config_encrypted"])
    except Exception:
        return None
    return {
        "carrier": row.data.get("carrier") or "twilio",
        "identifier": row.data.get("account_sid"),
        "secret": config.get("auth_token", ""),
        "vapi_credential_id": row.data.get("vapi_credential_id"),
    }


def get_credentials(credential_id: str, user_id: str) -> tuple[str, str] | None:
    """Decrypted (identifier, secret) pair — see get_credential_record for the full record."""
    record = get_credential_record(credential_id, user_id)
    return (record["identifier"], record["secret"]) if record else None


async def update_credentials(credential_id: str, user_id: str, account_sid: str | None = None,
                             auth_token: str | None = None, label: str | None = None) -> dict | None:
    """Partial update. Changing the identifier or secret re-validates against the carrier
    before saving (using the stored value for whichever of the two wasn't given — e.g.
    rotating just the secret doesn't require re-typing the identifier), and for
    Vonage/Telnyx updates the VAPI credential in place so numbers already imported keep
    working. Returns None if the credential doesn't exist or isn't owned by user_id."""
    row = (
        supabase.table("twilio_byot_credentials")
        .select("*")
        .eq("id", credential_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    if not row.data:
        return None

    carrier = row.data.get("carrier") or "twilio"
    spec = carriers.spec(carrier)

    updates: dict = {}
    # A blank label clears it (stored as NULL) rather than saving an empty string.
    if label is not None:
        updates["label"] = label.strip() or None

    # Only identifier/secret changes need a carrier round-trip; a label-only edit skips validation.
    if account_sid is not None or auth_token is not None:
        if spec.identifier_required:
            new_id = (account_sid if account_sid is not None else (row.data.get("account_sid") or "")).strip()
        else:
            new_id = None
        if auth_token is not None:
            new_secret = auth_token.strip()
        else:
            # Rotating only the identifier reuses the stored secret. If that can't be
            # decrypted the secret ends up empty and the "required" check below rejects the
            # update, so the user is asked to re-enter it.
            try:
                new_secret = decrypt_config(row.data["config_encrypted"]).get("auth_token", "")
            except Exception:
                new_secret = ""
        if not new_secret or (spec.identifier_required and not new_id):
            raise InvalidTwilioCredentials(spec.required_message)
        await _verify(carrier, new_id, new_secret)

        vapi_credential_id = row.data.get("vapi_credential_id")
        if spec.needs_vapi_credential and vapi_credential_id:
            try:
                await vapi_client.update_credential(
                    vapi_credential_id, carriers.vapi_credential_update_payload(carrier, new_id, new_secret),
                )
            except Exception as e:
                logger.error("VAPI credential update failed for %s account: %s", carrier, e)
                raise InvalidTwilioCredentials(
                    f"Could not update this {spec.label} account right now. Please try again."
                )
        updates["account_sid"] = new_id
        updates["config_encrypted"] = encrypt_config({"auth_token": new_secret})

    # Nothing to change: return the current row without touching the database.
    if not updates:
        return _row_public(row.data)

    # Ownership was already enforced by the lookup above, so filtering on id alone is enough.
    result = (
        supabase.table("twilio_byot_credentials")
        .update(updates)
        .eq("id", credential_id)
        .execute()
    )
    return _row_public(result.data[0] if result.data else {**row.data, **updates})


async def delete_credentials(credential_id: str, user_id: str) -> None:
    """Refuses to delete a credential that a live phone number still references — doing
    so would leave that number's twilio_credential_id pointing at nothing, with no way
    to re-resolve its carrier account for a future release/retry."""
    # Any phone_numbers row that references the credential blocks deletion, whatever its status.
    in_use = (
        supabase.table("phone_numbers")
        .select("id, number")
        .eq("twilio_credential_id", credential_id)
        .eq("user_id", user_id)
        .execute()
    )
    if in_use.data:
        numbers = ", ".join(r["number"] for r in in_use.data if r.get("number"))
        raise CredentialInUse(
            f"This account is still used by {len(in_use.data)} phone number"
            f"{'s' if len(in_use.data) != 1 else ''} ({numbers}). Remove them first."
        )
    row = (
        supabase.table("twilio_byot_credentials")
        .select("vapi_credential_id")
        .eq("id", credential_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    # Removes our stored copy (and the matching VAPI credential, if any); the user's carrier
    # account itself is never touched.
    supabase.table("twilio_byot_credentials").delete().eq("id", credential_id).eq("user_id", user_id).execute()
    if row.data:
        await _drop_vapi_credential(row.data.get("vapi_credential_id"))

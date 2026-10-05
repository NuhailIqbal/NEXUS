"""
BYOT (Bring Your Own Twilio) credential storage.

A user's Twilio Auth Token is sensitive — it grants full control of their Twilio
account (buy/release numbers, send SMS, read call/SMS logs, spend their money).
It is never stored or returned in the clear: encrypted at rest with the same
Fernet scheme `integrations.config_encrypted` already uses (services/encryption.py),
and only ever masked when shown back to the frontend.
"""
# Entry points: save_credentials / list_credentials / update_credentials /
# delete_credentials back the /twilio-credentials CRUD endpoints in routers/telephony.py;
# get_credentials is the internal-only decrypting lookup used when provisioning a BYOT
# phone number there. Tables: twilio_byot_credentials (read/write) and phone_numbers
# (read-only, for the in-use check on delete). All lookups are scoped by user_id, which the
# router passes as the team owner's id.
from database import supabase
from services.encryption import encrypt_config, decrypt_config, mask_config
from services.twilio_service import validate_credentials


class InvalidTwilioCredentials(Exception):
    """Raised when an Account SID / Auth Token pair is missing, rejected by Twilio, or
    could not be verified. The message is user-facing; the router maps it to HTTP 400."""
    pass


class CredentialInUse(Exception):
    """Raised by delete_credentials when phone numbers still reference the credential.
    The message is user-facing and lists those numbers; the router maps it to HTTP 400."""
    pass


def _row_public(row: dict) -> dict:
    """Strip config_encrypted and attach a masked auth token for display."""
    out = {k: v for k, v in row.items() if k != "config_encrypted"}
    # Decrypt only to build the mask (first/last two characters). If the blob can't be
    # decrypted (e.g. the encryption key changed), show a fully masked placeholder so
    # listing credentials never fails because of one unreadable row.
    try:
        config = decrypt_config(row["config_encrypted"])
        out["auth_token_masked"] = mask_config(config).get("auth_token")
    except Exception:
        out["auth_token_masked"] = "****"
    return out


async def save_credentials(user_id: str, account_sid: str, auth_token: str, label: str | None = None) -> dict:
    """Validate a Twilio SID/token pair against Twilio, then store it for `user_id`.

    The token is Fernet-encrypted into twilio_byot_credentials.config_encrypted; nothing is
    written unless Twilio accepts the pair. Returns the saved row in public form (masked
    token, no ciphertext). Raises InvalidTwilioCredentials for blank, rejected or
    unverifiable credentials. No de-duplication: the same account can be saved twice.
    """
    account_sid = (account_sid or "").strip()
    auth_token = (auth_token or "").strip()
    if not account_sid or not auth_token:
        raise InvalidTwilioCredentials("Account SID and Auth Token are both required.")
    try:
        valid = await validate_credentials(account_sid, auth_token)
    except Exception:
        # A network/timeout error reaching Twilio must not surface as a raw 500 — the
        # user can't tell that apart from "my credentials are wrong", so give them a
        # clear, retryable message instead.
        raise InvalidTwilioCredentials("Could not verify these credentials with Twilio right now. Please try again.")
    if not valid:
        raise InvalidTwilioCredentials("Twilio rejected these credentials — check the Account SID and Auth Token.")

    row = {
        "user_id": user_id,
        "account_sid": account_sid,
        "config_encrypted": encrypt_config({"auth_token": auth_token}),
        "label": label,
    }
    result = supabase.table("twilio_byot_credentials").insert(row).execute()
    return _row_public(result.data[0] if result.data else row)


def list_credentials(user_id: str) -> list[dict]:
    """All of `user_id`'s saved Twilio credentials, newest first, in public form
    (masked token, no ciphertext). Makes no call to Twilio."""
    result = (
        supabase.table("twilio_byot_credentials")
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [_row_public(r) for r in (result.data or [])]


def get_credentials(credential_id: str, user_id: str) -> tuple[str, str] | None:
    """Decrypted (account_sid, auth_token) for internal use only — never returned
    to the frontend. None if the credential doesn't exist or isn't owned by user_id."""
    row = (
        supabase.table("twilio_byot_credentials")
        .select("account_sid, config_encrypted")
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
    return row.data["account_sid"], config.get("auth_token", "")


async def update_credentials(credential_id: str, user_id: str, account_sid: str | None = None,
                             auth_token: str | None = None, label: str | None = None) -> dict | None:
    """Partial update. Changing the SID or token re-validates against Twilio before
    saving (using the existing stored value for whichever of the two wasn't given —
    e.g. rotating just the Auth Token doesn't require re-typing the Account SID).
    Returns None if the credential doesn't exist or isn't owned by user_id."""
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

    updates: dict = {}
    # A blank label clears it (stored as NULL) rather than saving an empty string.
    if label is not None:
        updates["label"] = label.strip() or None

    # Only SID/token changes need a Twilio round-trip; a label-only edit skips validation.
    if account_sid is not None or auth_token is not None:
        new_sid = (account_sid if account_sid is not None else row.data["account_sid"]).strip()
        if auth_token is not None:
            new_token = auth_token.strip()
        else:
            # Rotating only the SID reuses the stored token. If that can't be decrypted the
            # token ends up empty and the "both required" check below rejects the update,
            # so the user is asked to re-enter it.
            try:
                new_token = decrypt_config(row.data["config_encrypted"]).get("auth_token", "")
            except Exception:
                new_token = ""
        if not new_sid or not new_token:
            raise InvalidTwilioCredentials("Account SID and Auth Token are both required.")
        try:
            valid = await validate_credentials(new_sid, new_token)
        except Exception:
            raise InvalidTwilioCredentials("Could not verify these credentials with Twilio right now. Please try again.")
        if not valid:
            raise InvalidTwilioCredentials("Twilio rejected these credentials — check the Account SID and Auth Token.")
        updates["account_sid"] = new_sid
        updates["config_encrypted"] = encrypt_config({"auth_token": new_token})

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


def delete_credentials(credential_id: str, user_id: str) -> None:
    """Refuses to delete a credential that a live phone number still references — doing
    so would leave that number's twilio_credential_id pointing at nothing, with no way
    to re-resolve its Twilio account for a future release/retry."""
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
            f"This Twilio account is still used by {len(in_use.data)} phone number"
            f"{'s' if len(in_use.data) != 1 else ''} ({numbers}). Remove them first."
        )
    # Removes only our stored copy; the user's Twilio account itself is never touched.
    supabase.table("twilio_byot_credentials").delete().eq("id", credential_id).eq("user_id", user_id).execute()

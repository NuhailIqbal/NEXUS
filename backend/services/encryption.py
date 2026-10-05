"""Symmetric encryption and display-masking helpers for stored credentials.

`encrypt_config` / `decrypt_config` turn a small JSON-serialisable dict (provider API keys,
a Twilio BYOT auth token, a Google Calendar refresh token) into an opaque Fernet string
kept in `*_encrypted` columns, and back. `mask_config` produces a redacted copy that is
safe to return to the frontend. Used by routers/integrations.py and by the BYOT, calendar,
email, SMS and whitelist services.
"""
import base64
import json
import os
from cryptography.fernet import Fernet
from config import settings

# The Fernet key is derived from the first 32 characters of supabase_jwt_secret, padded
# with NUL bytes to 32 bytes and url-safe base64 encoded. Consequences: changing that
# setting makes every existing ciphertext undecryptable (decrypt_config raises), and an
# empty secret yields a fixed, publicly derivable key that provides no real protection.
_key = base64.urlsafe_b64encode(settings.supabase_jwt_secret[:32].encode().ljust(32, b"\0"))
_fernet = Fernet(_key)


def encrypt_config(config: dict) -> str:
    """Serialise `config` to JSON and return it as a Fernet token string for DB storage."""
    return _fernet.encrypt(json.dumps(config).encode()).decode()


def decrypt_config(ciphertext: str) -> dict:
    """Inverse of `encrypt_config`. Raises cryptography.fernet.InvalidToken if the token is
    corrupted or was encrypted under a different key."""
    return json.loads(_fernet.decrypt(ciphertext.encode()).decode())


def mask_config(config: dict) -> dict:
    """Return a redacted copy of `config` for API responses.

    String values longer than 4 characters keep their first and last 2 characters with
    the middle replaced by asterisks; shorter strings and non-string values become "****".
    """
    masked = {}
    for key, value in config.items():
        if isinstance(value, str) and len(value) > 4:
            masked[key] = value[:2] + "*" * (len(value) - 4) + value[-2:]
        else:
            masked[key] = "****"
    return masked

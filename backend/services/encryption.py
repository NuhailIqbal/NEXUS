import base64
import json
import os
from cryptography.fernet import Fernet
from config import settings

_key = base64.urlsafe_b64encode(settings.supabase_jwt_secret[:32].encode().ljust(32, b"\0"))
_fernet = Fernet(_key)


def encrypt_config(config: dict) -> str:
    return _fernet.encrypt(json.dumps(config).encode()).decode()


def decrypt_config(ciphertext: str) -> dict:
    return json.loads(_fernet.decrypt(ciphertext.encode()).decode())


def mask_config(config: dict) -> dict:
    masked = {}
    for key, value in config.items():
        if isinstance(value, str) and len(value) > 4:
            masked[key] = value[:2] + "*" * (len(value) - 4) + value[-2:]
        else:
            masked[key] = "****"
    return masked

"""
Security Encryption Module for RIE Desktop Client.
Provides AES/Fernet encryption for storing sensitive OAuth tokens in local SQLite database.
"""
import base64
import hashlib
import os
import sys
import json
import logging

logger = logging.getLogger(__name__)

# Try importing Fernet from cryptography library
try:
    from cryptography.fernet import Fernet
    HAS_FERNET = True
except ImportError:
    HAS_FERNET = False


def _get_encryption_key() -> bytes:
    """Generate or retrieve Fernet secret key for token encryption."""
    # Check for Cloud KMS / Environment encryption key override first
    kms_override = os.environ.get("RIE_ENCRYPTION_KEY", "")
    if kms_override:
        key_hash = hashlib.sha256(kms_override.encode("utf-8")).digest()
        return base64.urlsafe_b64encode(key_hash)

    # Use environment token or system platform details as seed for desktop local storage
    seed = os.environ.get("RIE_APP_TOKEN", "")
    if not seed:
        try:
            # Use user home path + platform details for machine-bound key
            home_path = os.path.expanduser("~")
            platform_str = sys.platform + os.name
            seed = f"rie-ai-salt-{home_path}-{platform_str}"
        except Exception:
            seed = "rie-ai-default-local-encryption-seed-key"

    key_hash = hashlib.sha256(seed.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(key_hash)


def encrypt_secret(data: str) -> str:
    """Encrypt plaintext string into base64 token."""
    if not data:
        return ""
    try:
        key = _get_encryption_key()
        if HAS_FERNET:
            f = Fernet(key)
            encrypted_bytes = f.encrypt(data.encode("utf-8"))
            return "fernet:" + encrypted_bytes.decode("utf-8")
        else:
            # Simple base64 fallback when cryptography library is missing
            encoded = base64.urlsafe_b64encode(data.encode("utf-8")).decode("utf-8")
            return "b64:" + encoded
    except Exception as e:
        logger.error(f"Error encrypting secret: {e}")
        return data


def decrypt_secret(encrypted_data: str) -> str:
    """Decrypt base64 token into plaintext string."""
    if not encrypted_data:
        return ""
    try:
        if encrypted_data.startswith("fernet:") and HAS_FERNET:
            raw_token = encrypted_data[7:].encode("utf-8")
            key = _get_encryption_key()
            f = Fernet(key)
            return f.decrypt(raw_token).decode("utf-8")
        elif encrypted_data.startswith("b64:"):
            raw_token = encrypted_data[4:].encode("utf-8")
            return base64.urlsafe_b64decode(raw_token).decode("utf-8")
        else:
            # Return raw if not formatted or plain
            return encrypted_data
    except Exception as e:
        logger.error(f"Error decrypting secret: {e}")
        return encrypted_data


def encrypt_json(obj: dict) -> str:
    """Helper to encrypt dict to string."""
    return encrypt_secret(json.dumps(obj))


def decrypt_json(encrypted_data: str) -> dict:
    """Helper to decrypt string to dict."""
    decrypted_str = decrypt_secret(encrypted_data)
    if not decrypted_str:
        return {}
    try:
        return json.loads(decrypted_str)
    except Exception:
        return {}

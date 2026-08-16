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
from pathlib import Path

logger = logging.getLogger(__name__)

# Try importing Fernet from cryptography library
try:
    from cryptography.fernet import Fernet
    HAS_FERNET = True
except ImportError:
    HAS_FERNET = False


def _get_master_key_file_path() -> Path:
    """Get the path to the persistent master key file."""
    if getattr(sys, 'frozen', False):
        base_dir = Path(os.getenv('LOCALAPPDATA', os.path.expanduser('~'))) / 'Rie-AI'
    else:
        base_dir = Path(os.getenv('LOCALAPPDATA', str(Path(__file__).parent.parent))) / 'Rie-AI'
    try:
        base_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return base_dir / '.master_key'


def _get_machine_seed() -> str:
    """Generate a consistent machine-bound seed string."""
    try:
        home_path = os.path.expanduser("~")
        platform_str = sys.platform + os.name
        user_name = os.environ.get("USERNAME") or os.environ.get("USER") or ""
        return f"rie-ai-salt-{home_path}-{platform_str}-{user_name}"
    except Exception:
        return "rie-ai-default-local-encryption-seed-key"


def _get_encryption_key() -> bytes:
    """
    Generate or retrieve Fernet secret key for token encryption.
    Guarantees persistence across restarts so saved credentials are never lost.
    """
    # 1. Check for Cloud KMS / Environment encryption key override first
    kms_override = os.environ.get("RIE_ENCRYPTION_KEY", "")
    if kms_override:
        key_hash = hashlib.sha256(kms_override.encode("utf-8")).digest()
        return base64.urlsafe_b64encode(key_hash)

    # 2. Check for persistent master key file on disk
    try:
        key_path = _get_master_key_file_path()
        if key_path.exists():
            stored_key = key_path.read_text(encoding="utf-8").strip()
            if stored_key:
                return stored_key.encode("utf-8")

        # If not present, generate and save persistent key
        seed = _get_machine_seed()
        key_hash = hashlib.sha256(seed.encode("utf-8")).digest()
        derived_key = base64.urlsafe_b64encode(key_hash)

        try:
            key_path.write_text(derived_key.decode("utf-8"), encoding="utf-8")
        except Exception as write_err:
            logger.debug(f"Could not persist master key file ({write_err}), using in-memory derived key.")

        return derived_key
    except Exception as e:
        logger.warning(f"Error accessing master key file: {e}")
        seed = _get_machine_seed()
        key_hash = hashlib.sha256(seed.encode("utf-8")).digest()
        return base64.urlsafe_b64encode(key_hash)


def _get_fallback_keys() -> list:
    """Provide fallback keys for decrypting legacy/alternative encrypted payloads."""
    keys = []
    try:
        home_path = os.path.expanduser("~")
        platform_str = sys.platform + os.name
        seed1 = f"rie-ai-salt-{home_path}-{platform_str}"
        keys.append(base64.urlsafe_b64encode(hashlib.sha256(seed1.encode("utf-8")).digest()))
        seed2 = "rie-ai-default-local-encryption-seed-key"
        keys.append(base64.urlsafe_b64encode(hashlib.sha256(seed2.encode("utf-8")).digest()))
    except Exception:
        pass
    return keys


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
            try:
                f = Fernet(key)
                return f.decrypt(raw_token).decode("utf-8")
            except Exception:
                # Try fallback keys if primary key fails (e.g. legacy machine seeds)
                for fallback_k in _get_fallback_keys():
                    if fallback_k != key:
                        try:
                            f = Fernet(fallback_k)
                            return f.decrypt(raw_token).decode("utf-8")
                        except Exception:
                            continue
                raise
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

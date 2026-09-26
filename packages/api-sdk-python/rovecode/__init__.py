"""rovecode Python SDK — see README.md for usage."""
from .client import Rovecode
from .errors import (
    APIConnectionError,
    APIError,
    AuthenticationError,
    ContentFilterError,
    NotFoundError,
    PermissionError,
    RateLimitError,
    RovecodeError,
)

__all__ = [
    "Rovecode",
    "RovecodeError",
    "AuthenticationError",
    "PermissionError",
    "NotFoundError",
    "ContentFilterError",
    "RateLimitError",
    "APIConnectionError",
    "APIError",
]
__version__ = "0.1.0"

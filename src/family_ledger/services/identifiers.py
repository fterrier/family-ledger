from __future__ import annotations

from uuid import uuid4


def generate_resource_name(resource_prefix: str, key_prefix: str) -> str:
    return f"{resource_prefix}/{key_prefix}_{uuid4().hex}"

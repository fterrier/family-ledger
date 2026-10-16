from __future__ import annotations

from collections.abc import Collection

from family_ledger.services.errors import ValidationError


def parse_update_mask(update_mask: str, allowed: Collection[str]) -> frozenset[str]:
    """Return the fields named in a PATCH update_mask, validated against `allowed`.

    The mask is required on every PATCH: without it an update would have to be a full
    replace, silently wiping any field the client didn't send.
    """
    fields = frozenset(field.strip() for field in update_mask.split(",")) - {""}
    if not fields:
        raise ValidationError(
            code="invalid_update_mask",
            message="update_mask must name at least one field.",
        )
    unknown = fields - set(allowed)
    if unknown:
        raise ValidationError(
            code="invalid_update_mask",
            message=(
                f"Unknown update_mask field(s): {', '.join(sorted(unknown))}."
                f" Allowed: {', '.join(sorted(allowed))}."
            ),
        )
    return fields

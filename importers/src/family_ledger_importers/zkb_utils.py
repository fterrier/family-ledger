from __future__ import annotations

import re

# MT940 control tokens like "?10:XXXX" embedded in ZKB description lines.
CONTROL_TOKEN_PATTERN = re.compile(r"\?[A-Z0-9]{1,4}:[^\s]*")


def _normalize_for_dedupe(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def _clean_description_line(line: str) -> str:
    normalized = CONTROL_TOKEN_PATTERN.sub(" ", line)
    return re.sub(r"\s+", " ", normalized).strip(" ,")


def _dedupe_description_lines(lines: list[str]) -> list[str]:
    deduped: list[str] = []
    deduped_norms: list[str] = []
    for raw_line in lines:
        line = _clean_description_line(raw_line)
        if not line:
            continue
        norm = _normalize_for_dedupe(line)
        if not norm:
            continue
        for index, existing_norm in enumerate(deduped_norms):
            if norm == existing_norm or norm in existing_norm:
                break
            if existing_norm in norm:
                deduped[index] = line
                deduped_norms[index] = norm
                break
        else:
            deduped.append(line)
            deduped_norms.append(norm)
    return deduped


def normalize_description(lines: list[str]) -> str | None:
    deduped = _dedupe_description_lines(lines)
    if not deduped:
        return None
    return " ".join(deduped).strip() or None


def _join_parts(parts: list[str]) -> str | None:
    joined = " ".join(part.strip() for part in parts if part and part.strip()).strip()
    return joined or None


def _assemble_descriptor_body(
    descriptor: str, body_prefix: str, rest: list[str], fallback_lines: list[str]
) -> str | None:
    body_parts = [_clean_description_line(body_prefix)] if body_prefix.strip() else []
    body_parts.extend(rest)
    body = _join_parts(body_parts)
    if not descriptor or not body:
        return normalize_description(fallback_lines)
    return body + " - " + descriptor


def format_zkb_payee(lines: list[str]) -> str | None:
    """Format a ZKB description into 'Body - Descriptor' order.

    Accepts a list of raw description lines (MT940 multi-line) or a single-element
    list containing a pre-joined string (PDF). Handles three ZKB description shapes:
    - "Einkauf ..., Body" → "Body - Einkauf ..."
    - "Descriptor: Body"  → "Body - Descriptor"  (TWINT, eBanking, Salär, etc.)
    - anything else       → normalized as-is
    """
    deduped = _dedupe_description_lines(lines)
    if not deduped:
        return None
    first_line = deduped[0]
    if first_line.startswith("Einkauf "):
        if "," in first_line:
            descriptor, first_body = first_line.split(",", 1)
            return _assemble_descriptor_body(descriptor.strip(), first_body, deduped[1:], lines)
        if len(deduped) > 1:
            return _assemble_descriptor_body(first_line.strip(), "", deduped[1:], lines)
        return normalize_description(lines)
    if ":" not in first_line:
        return normalize_description(lines)
    descriptor, first_body = first_line.split(":", 1)
    return _assemble_descriptor_body(descriptor.strip(), first_body, deduped[1:], lines)

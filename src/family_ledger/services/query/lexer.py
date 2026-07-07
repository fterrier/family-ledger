"""Tokenizer for the BQL-subset reporting query language.

Produces a flat token list ending in an ``eof`` token. Identifiers are
lowercased here, which is the single source of the language's
case-insensitivity. Date literals are validated at lex time.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from family_ledger.services.errors import ValidationError

_WHITESPACE_RE = re.compile(r"\s+")
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
# '-' appears only as a numeric sign in this grammar (no arithmetic); the
# date regex is tried first, so date literals are never split by the sign.
_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_OP_RE = re.compile(r"!=|<=|>=|[=<>~]")

_PUNCTUATION = {",": "comma", "(": "lparen", ")": "rparen", "*": "star"}


@dataclass(frozen=True)
class Token:
    # 'ident', 'string', 'date', 'number', 'op', 'comma', 'lparen', 'rparen',
    # 'star', or 'eof'
    kind: str
    value: Any
    pos: int
    text: str


def _lex_error(message: str, pos: int) -> ValidationError:
    return ValidationError(
        code="query_parse_error",
        message=f"{message} at position {pos}",
    )


def _lex_string(text: str, pos: int) -> tuple[Token, int]:
    parts: list[str] = []
    i = pos + 1
    while True:
        end = text.find("'", i)
        if end == -1:
            raise _lex_error("unterminated string literal", pos)
        if text[end + 1 : end + 2] == "'":
            parts.append(text[i:end] + "'")
            i = end + 2
        else:
            parts.append(text[i:end])
            i = end + 1
            break
    value = "".join(parts)
    return Token("string", value, pos, text[pos:i]), i


def tokenize(text: str) -> list[Token]:
    tokens: list[Token] = []
    pos = 0
    length = len(text)

    while pos < length:
        whitespace = _WHITESPACE_RE.match(text, pos)
        if whitespace:
            pos = whitespace.end()
            continue

        char = text[pos]

        if char == "'":
            token, pos = _lex_string(text, pos)
            tokens.append(token)
            continue

        date_match = _DATE_RE.match(text, pos)
        if date_match:
            try:
                value = date.fromisoformat(date_match.group())
            except ValueError:
                raise _lex_error(f"invalid date literal '{date_match.group()}'", pos) from None
            tokens.append(Token("date", value, pos, date_match.group()))
            pos = date_match.end()
            continue

        number_match = _NUMBER_RE.match(text, pos)
        if number_match:
            tokens.append(Token("number", Decimal(number_match.group()), pos, number_match.group()))
            pos = number_match.end()
            continue

        ident_match = _IDENT_RE.match(text, pos)
        if ident_match:
            tokens.append(Token("ident", ident_match.group().lower(), pos, ident_match.group()))
            pos = ident_match.end()
            continue

        op_match = _OP_RE.match(text, pos)
        if op_match:
            tokens.append(Token("op", op_match.group(), pos, op_match.group()))
            pos = op_match.end()
            continue

        kind = _PUNCTUATION.get(char)
        if kind is not None:
            tokens.append(Token(kind, char, pos, char))
            pos += 1
            continue

        raise _lex_error(f"unexpected character '{char}'", pos)

    tokens.append(Token("eof", None, length, ""))
    return tokens

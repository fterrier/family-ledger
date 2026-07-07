"""Parser for the BQL-subset reporting query language.

Recursive descent over the token stream from
:mod:`family_ledger.services.query.lexer`, producing an
:mod:`family_ledger.services.query.ast` tree.

Contract:

- syntax errors raise ``ValidationError(code="query_parse_error")`` with a
  human-readable message; the parser performs no semantic validation
  (unknown columns/functions are the compiler's concern)
- keywords are case-insensitive; column names, function names, and aliases
  are lowercased in the AST
"""

from __future__ import annotations

from family_ledger.services.errors import ValidationError
from family_ledger.services.query.ast import (
    Column,
    Condition,
    DateLiteral,
    Expr,
    FromOptions,
    FunctionCall,
    NumberLiteral,
    Query,
    Star,
    StringLiteral,
    Target,
)
from family_ledger.services.query.lexer import Token, tokenize

_RESERVED = frozenset(
    {"select", "from", "where", "group", "by", "as", "and", "open", "close", "on"}
)


class _Parser:
    def __init__(self, tokens: list[Token]) -> None:
        self._tokens = tokens
        self._index = 0

    # -- token stream helpers ------------------------------------------------

    def _peek(self) -> Token:
        return self._tokens[self._index]

    def _advance(self) -> Token:
        token = self._tokens[self._index]
        self._index += 1
        return token

    def _fail(self, token: Token, expected: str) -> ValidationError:
        if token.kind == "eof":
            found = "end of query"
        else:
            found = f"'{token.text}'"
        return ValidationError(
            code="query_parse_error",
            message=f"expected {expected} but found {found} at position {token.pos}",
        )

    def _expect(self, kind: str, expected: str) -> Token:
        token = self._peek()
        if token.kind != kind:
            raise self._fail(token, expected)
        return self._advance()

    def _at_keyword(self, keyword: str) -> bool:
        token = self._peek()
        return token.kind == "ident" and token.value == keyword

    def _expect_keyword(self, keyword: str) -> None:
        token = self._peek()
        if not self._at_keyword(keyword):
            raise self._fail(token, f"'{keyword.upper()}'")
        self._advance()

    # -- grammar rules -------------------------------------------------------

    def parse_query(self) -> Query:
        self._expect_keyword("select")
        targets = self._parse_targets()

        from_options = self._parse_from() if self._at_keyword("from") else None

        where: tuple[Condition, ...] = ()
        if self._at_keyword("where"):
            self._advance()
            where = self._parse_conditions()

        group_by: tuple[str | int, ...] = ()
        if self._at_keyword("group"):
            self._advance()
            self._expect_keyword("by")
            group_by = self._parse_group_keys()

        token = self._peek()
        if token.kind != "eof":
            raise self._fail(token, "end of query")

        return Query(
            targets=targets,
            from_options=from_options,
            where=where,
            group_by=group_by,
        )

    def _parse_targets(self) -> tuple[Target, ...]:
        targets = [self._parse_target()]
        while self._peek().kind == "comma":
            self._advance()
            targets.append(self._parse_target())
        return tuple(targets)

    def _parse_target(self) -> Target:
        expr = self._parse_expr()
        alias: str | None = None
        if self._at_keyword("as"):
            self._advance()
            token = self._expect("ident", "an alias identifier")
            alias = token.value
        return Target(expr, alias)

    def _parse_expr(self) -> Expr:
        token = self._peek()

        if token.kind == "ident" and token.value not in _RESERVED:
            self._advance()
            if self._peek().kind == "lparen":
                return self._parse_function_args(token.value)
            return Column(token.value)
        if token.kind == "string":
            self._advance()
            return StringLiteral(token.value)
        if token.kind == "date":
            self._advance()
            return DateLiteral(token.value)
        if token.kind == "number":
            self._advance()
            return NumberLiteral(token.value)

        raise self._fail(token, "a column, function call, or literal")

    def _parse_function_args(self, name: str) -> FunctionCall:
        self._expect("lparen", "'('")
        args: list[Expr] = []
        if self._peek().kind != "rparen":
            args.append(self._parse_arg())
            while self._peek().kind == "comma":
                self._advance()
                args.append(self._parse_arg())
        self._expect("rparen", "')'")
        return FunctionCall(name, tuple(args))

    def _parse_arg(self) -> Expr:
        if self._peek().kind == "star":
            self._advance()
            return Star()
        return self._parse_expr()

    def _parse_conditions(self) -> tuple[Condition, ...]:
        conditions = [self._parse_condition()]
        while self._at_keyword("and"):
            self._advance()
            conditions.append(self._parse_condition())
        return tuple(conditions)

    def _parse_condition(self) -> Condition:
        left = self._parse_expr()
        token = self._peek()
        if token.kind != "op":
            raise self._fail(token, "a comparison operator")
        self._advance()
        right = self._parse_expr()
        return Condition(left, token.value, right)

    def _parse_from(self) -> FromOptions:
        self._expect_keyword("from")
        open_on = None
        close_on = None
        if self._at_keyword("open"):
            self._advance()
            self._expect_keyword("on")
            open_on = self._expect("date", "a date literal").value
        if self._at_keyword("close"):
            self._advance()
            self._expect_keyword("on")
            close_on = self._expect("date", "a date literal").value
        if open_on is None and close_on is None:
            raise self._fail(self._peek(), "'OPEN ON' or 'CLOSE ON'")
        return FromOptions(open_on=open_on, close_on=close_on)

    def _parse_group_keys(self) -> tuple[str | int, ...]:
        keys = [self._parse_group_key()]
        while self._peek().kind == "comma":
            self._advance()
            keys.append(self._parse_group_key())
        return tuple(keys)

    def _parse_group_key(self) -> str | int:
        token = self._peek()
        if token.kind == "ident" and token.value not in _RESERVED:
            self._advance()
            return token.value
        if token.kind == "number":
            if token.value != token.value.to_integral_value():
                raise self._fail(token, "an integer ordinal")
            self._advance()
            return int(token.value)
        raise self._fail(token, "a group key (identifier or ordinal)")


def parse(text: str) -> Query:
    return _Parser(tokenize(text)).parse_query()

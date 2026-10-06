"""Tiny, safe arithmetic for calculation quantities, e.g. "days*2 - armenia_meals".

Decimals use a dot (commas separate function arguments). Only numbers,
variables, + - * / // %, comparisons, `a if cond else b`, and
ceil / floor / min / max / round / abs. No attribute access, no calls to anything
else, no powers (so nothing can run away). Values are Decimal throughout.
"""
import ast
import difflib
import math
from decimal import ROUND_HALF_UP, Decimal

MAX_LEN = 300


class FormulaError(ValueError):
    """A formula problem in plain words. `code` + `params` let the UI translate it."""

    def __init__(self, code: str, message: str, **params):
        super().__init__(message)
        self.code = code
        self.params = params


def _closest(word: str, options) -> str | None:
    match = difflib.get_close_matches(word, list(options), n=1, cutoff=0.6)
    return match[0] if match else None


def _ceil(x: Decimal) -> Decimal:
    return Decimal(math.ceil(x))


def _floor(x: Decimal) -> Decimal:
    return Decimal(math.floor(x))


def _round(x: Decimal, digits: Decimal = Decimal(0)) -> Decimal:
    return x.quantize(Decimal(1).scaleb(-int(digits)), ROUND_HALF_UP)


FUNCS = {"ceil": _ceil, "floor": _floor, "min": min, "max": max, "round": _round, "abs": abs}

_BIN = {
    ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b, ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b, ast.FloorDiv: lambda a, b: a // b, ast.Mod: lambda a, b: a % b,
}
_CMP = {
    ast.Eq: lambda a, b: a == b, ast.NotEq: lambda a, b: a != b, ast.Lt: lambda a, b: a < b,
    ast.LtE: lambda a, b: a <= b, ast.Gt: lambda a, b: a > b, ast.GtE: lambda a, b: a >= b,
}


def evaluate(expr: str, variables: dict[str, Decimal]) -> Decimal:
    expr = (expr or "").strip()
    if not expr:
        return Decimal(0)
    if len(expr) > MAX_LEN:
        raise FormulaError("too_long", f"the formula is longer than {MAX_LEN} characters", max=MAX_LEN)
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError:
        raise _syntax_error(expr) from None
    if isinstance(tree.body, ast.Tuple):  # "1,5": a decimal comma
        raise FormulaError("comma_decimal", "use a dot for decimals, e.g. 1.5")
    try:
        value = _eval(tree.body, variables)
    except ZeroDivisionError:
        raise FormulaError("div_zero", "the formula divides by zero") from None
    except (TypeError, ValueError) as e:
        if isinstance(e, FormulaError):
            raise
        raise FormulaError("bad_arguments", "a function got the wrong number of values") from None
    if isinstance(value, bool):
        value = Decimal(int(value))
    return value


def _syntax_error(expr: str) -> FormulaError:
    if expr.count("(") != expr.count(")"):
        return FormulaError("brackets", "the brackets don't match", opened=expr.count("("), closed=expr.count(")"))
    if expr.rstrip()[-1:] in "+-*/%(<>=":
        return FormulaError("ends_early", "the formula ends with an operator; something is missing after it")
    if "**" in expr or "^" in expr:
        return FormulaError("power", "powers aren't allowed; multiply instead (x * x)")
    return FormulaError("syntax", f"can't read '{expr}'", expr=expr)


def names(expr: str) -> set[str]:
    """Variables a formula refers to (for validation messages)."""
    try:
        tree = ast.parse(expr or "0", mode="eval")
    except SyntaxError:
        return set()
    return {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id not in FUNCS}


def _eval(node, v):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return Decimal(str(node.value))
    if isinstance(node, ast.Name):
        if node.id not in v:
            hint = _closest(node.id, v)
            raise FormulaError("unknown_name", f"'{node.id}' isn't a known name" + (f"; did you mean '{hint}'?" if hint else ""),
                               name=node.id, suggestion=hint or "")
        return v[node.id]
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
        return _BIN[type(node.op)](_eval(node.left, v), _eval(node.right, v))
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        x = _eval(node.operand, v)
        return -x if isinstance(node.op, ast.USub) else x
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and type(node.ops[0]) in _CMP:
        return _CMP[type(node.ops[0])](_eval(node.left, v), _eval(node.comparators[0], v))
    if isinstance(node, ast.BoolOp):
        vals = [_eval(x, v) for x in node.values]
        return all(vals) if isinstance(node.op, ast.And) else any(vals)
    if isinstance(node, ast.IfExp):
        return _eval(node.body, v) if _eval(node.test, v) else _eval(node.orelse, v)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        if node.func.id not in FUNCS:
            hint = _closest(node.func.id, FUNCS)
            raise FormulaError("unknown_function", f"'{node.func.id}' isn't a function here" + (f"; did you mean '{hint}'?" if hint else ""),
                               name=node.func.id, suggestion=hint or "")
        if not node.keywords and 1 <= len(node.args) <= 10:
            return FUNCS[node.func.id](*[_eval(a, v) for a in node.args])
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Pow):
        raise FormulaError("power", "powers aren't allowed; multiply instead (x * x)")
    raise FormulaError("not_allowed", "only numbers, names, + - * /, comparisons, 'if/else' and ceil/floor/min/max/round/abs are allowed")

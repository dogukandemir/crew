"""Temperature conversion utilities.

Exact formulas:
    F = C * 9/5 + 32
    C = (F - 32) * 5/9

Only int/float inputs are accepted; anything else (str, None, etc.)
raises TypeError.
"""


def _check_number(value, name):
    """Reject non-numeric inputs with TypeError."""
    if not isinstance(value, (int, float)):
        raise TypeError(
            "%s must be an int or float, got %s" % (name, type(value).__name__)
        )


def celsius_to_fahrenheit(value):
    """Convert a Celsius temperature to Fahrenheit.

    F = C * 9/5 + 32
    """
    _check_number(value, "value")
    return value * 9 / 5 + 32


def fahrenheit_to_celsius(value):
    """Convert a Fahrenheit temperature to Celsius.

    C = (F - 32) * 5/9
    """
    _check_number(value, "value")
    return (value - 32) * 5 / 9

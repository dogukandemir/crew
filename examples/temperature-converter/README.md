# Temperature Converter

A small Python utility for converting temperatures between Celsius and Fahrenheit.

The module `converter.py` provides two pure functions:

- `celsius_to_fahrenheit(value)`, convert Celsius to Fahrenheit
- `fahrenheit_to_celsius(value)`, convert Fahrenheit to Celsius

Both functions accept an `int` or `float` and return a `float`. Any other type
(e.g. `str`, `None`) raises `TypeError`.

## Requirements

- Python 3.x (uses only the standard library; no external dependencies).

## Usage

Import the functions from `converter.py`:

```python
from converter import celsius_to_fahrenheit, fahrenheit_to_celsius
```

### `celsius_to_fahrenheit`

Convert a Celsius temperature to Fahrenheit using `F = C * 9/5 + 32`.

```python
celsius_to_fahrenheit(0)     # 32.0
celsius_to_fahrenheit(100)   # 212.0
celsius_to_fahrenheit(-40)   # -40.0
```

### `fahrenheit_to_celsius`

Convert a Fahrenheit temperature to Celsius using `C = (F - 32) * 5/9`.

```python
fahrenheit_to_celsius(32)    # 0.0
fahrenheit_to_celsius(212)   # 100.0
fahrenheit_to_celsius(-40)   # -40.0
```

### Invalid input

Passing a non-numeric value raises `TypeError`:

```python
celsius_to_fahrenheit("100")    # TypeError
fahrenheit_to_celsius(None)     # TypeError
```

## Running Tests

The unit tests live in `test_converter.py` and use only the standard-library
`unittest` module.

Run the full test suite from the project directory:

```bash
python -m unittest test_converter.py
```

For more verbose output:

```bash
python -m unittest -v test_converter.py
```

## Files

- `converter.py`, the two conversion functions.
- `test_converter.py`, unittest test suite for both functions.
- `README.md`, this document.

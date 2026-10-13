"""Unit tests for converter.py using only unittest."""

import unittest

from converter import celsius_to_fahrenheit, fahrenheit_to_celsius


class TestCelsiusToFahrenheit(unittest.TestCase):
    """Tests for celsius_to_fahrenheit."""

    def test_freezing_point(self):
        """0 Celsius should be 32 Fahrenheit."""
        self.assertEqual(celsius_to_fahrenheit(0), 32)

    def test_boiling_point(self):
        """100 Celsius should be 212 Fahrenheit."""
        self.assertEqual(celsius_to_fahrenheit(100), 212)

    def test_negative_value(self):
        """Negative Celsius values convert correctly."""
        self.assertAlmostEqual(celsius_to_fahrenheit(-40), -40)
        self.assertAlmostEqual(celsius_to_fahrenheit(-10), 14)

    def test_invalid_string_raises_type_error(self):
        """String input raises TypeError."""
        with self.assertRaises(TypeError):
            celsius_to_fahrenheit("10")

    def test_invalid_none_raises_type_error(self):
        """None input raises TypeError."""
        with self.assertRaises(TypeError):
            celsius_to_fahrenheit(None)


class TestFahrenheitToCelsius(unittest.TestCase):
    """Tests for fahrenheit_to_celsius."""

    def test_freezing_point(self):
        """32 Fahrenheit should be 0 Celsius."""
        self.assertEqual(fahrenheit_to_celsius(32), 0)

    def test_boiling_point(self):
        """212 Fahrenheit should be 100 Celsius."""
        self.assertEqual(fahrenheit_to_celsius(212), 100)

    def test_negative_value(self):
        """Negative Fahrenheit values convert correctly."""
        self.assertAlmostEqual(fahrenheit_to_celsius(-40), -40)
        self.assertAlmostEqual(fahrenheit_to_celsius(-4), -20)

    def test_invalid_string_raises_type_error(self):
        """String input raises TypeError."""
        with self.assertRaises(TypeError):
            fahrenheit_to_celsius("32")

    def test_invalid_none_raises_type_error(self):
        """None input raises TypeError."""
        with self.assertRaises(TypeError):
            fahrenheit_to_celsius(None)


if __name__ == "__main__":
    unittest.main()

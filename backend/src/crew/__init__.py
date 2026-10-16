"""Crew: autonomous agent organization platform (backend)."""

import os

# Set these before importing the harness or vector store. Work content stays out
# of optional vendor telemetry; model requests still go to the chosen provider.
os.environ["CREWAI_TELEMETRY_DISABLED"] = "true"
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["ANONYMIZED_TELEMETRY"] = "False"

__version__ = "0.1.0"
CONTRACT_VERSION = 1

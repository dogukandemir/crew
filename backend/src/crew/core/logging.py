"""Redact formatted log records, including exception tracebacks."""
import logging


class RedactingFormatter(logging.Formatter):
    def __init__(self, delegate=None):
        super().__init__()
        self.delegate = delegate or logging.Formatter()

    def format(self, record):
        from crew.core.security import redactor
        return redactor.redact(self.delegate.format(record))[0]


def install_redaction() -> None:
    loggers = [logging.getLogger(), *[logger for logger in logging.Logger.manager.loggerDict.values()
                                    if isinstance(logger, logging.Logger)]]
    for logger in loggers:
        for handler in logger.handlers:
            if not isinstance(handler.formatter, RedactingFormatter):
                handler.setFormatter(RedactingFormatter(handler.formatter))

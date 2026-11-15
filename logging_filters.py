"""Strip personal data out of log records before they reach any handler.

A logging *filter* rather than a formatter, deliberately: a filter runs before
the record is handed to a handler, so nothing identifying is ever written to
disk, printed to stderr, or forwarded to a log service. Redacting at the
formatter would leave the raw value in memory for whatever else reads records.

Four things get rewritten: IPv4 and IPv6 addresses (truncated, not removed, so
a rough origin survives for debugging), email addresses, and quoted filenames
of imported documents -- the filename of a PDF is frequently the most sensitive
string in the whole request ("Rahul medical report.pdf").
"""

import ipaddress
import logging
import re

# Ordered: IPv6 first, because an IPv4-mapped IPv6 address would otherwise be
# half-eaten by the IPv4 pattern.
_IPV6_RE = re.compile(r"\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\b")
_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_EMAIL_RE = re.compile(r"\b[^\s@]+@[^\s@]+\.[A-Za-z]{2,}\b")
_FILENAME_RE = re.compile(
    r"""["']?[\w \-()\[\].]+\.(?:pdf|pptx?|docx?|xlsx?|png|jpe?g|inky)["']?""",
    re.IGNORECASE,
)

FILENAME_PLACEHOLDER = "[filename]"
EMAIL_PLACEHOLDER = "[email]"


def anonymise_ip(value):
    """Truncate an address: IPv4 to /24, IPv6 to /48.

    The convention Google Analytics and most EU DPAs treat as anonymisation
    for logs. Enough to tell two networks apart, not enough to tell two people
    apart on the same one.
    """
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return value

    # Loopback identifies nobody, and truncating it rewrites the dev server's
    # own startup banner to a URL that does not work (127.0.0.1 -> 127.0.0.0),
    # which sends the next person debugging in the wrong direction.
    if address.is_loopback:
        return value

    if address.version == 4:
        return str(ipaddress.ip_network(f"{address}/24", strict=False).network_address)
    return str(ipaddress.ip_network(f"{address}/48", strict=False).network_address)


def redact(text):
    """Rewrite every identifying substring in one piece of text."""
    text = _IPV6_RE.sub(lambda match: anonymise_ip(match.group(0)), text)
    text = _IPV4_RE.sub(lambda match: anonymise_ip(match.group(0)), text)
    text = _EMAIL_RE.sub(EMAIL_PLACEHOLDER, text)
    text = _FILENAME_RE.sub(FILENAME_PLACEHOLDER, text)
    return text


class RedactPII(logging.Filter):
    """Rewrite the record in place. Always returns True: this filter removes
    data from records, it never drops records."""

    def filter(self, record):
        if isinstance(record.msg, str):
            record.msg = redact(record.msg)

        if record.args:
            if isinstance(record.args, dict):
                record.args = {
                    key: redact(value) if isinstance(value, str) else value
                    for key, value in record.args.items()
                }
            elif isinstance(record.args, tuple):
                record.args = tuple(
                    redact(value) if isinstance(value, str) else value
                    for value in record.args
                )
        return True

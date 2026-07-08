"""Carrier brand classification for the CT Siting Council tower database.

The state database lists carriers under historical brand names. This module
maps each raw entry to its 2026 successor and classifies it:

  ACTIVE     - brand (or its successor) is paying rent under this name today
  UNCERTAIN  - absorbed by T-Mobile (Sprint/Nextel/MetroPCS/Clearwire);
               some sites retained, many decommissioned -> verify per site
  IGNORED    - municipal/utility/government/paging tenants; not commercial
               cell leases for acquisition purposes
"""

ACTIVE_MAP = {
    "verizon": "Verizon",
    "t-mobile": "T-Mobile",
    "metropcs/t-mobile": "T-Mobile",
    "at&t": "AT&T",
    "at&": "AT&T",          # data typo present in source
    "at&t/sclp": "AT&T",
    "cingular": "AT&T",      # Cingular renamed AT&T (2007); leases assigned
    "cingular/at&t": "AT&T",
    "new cingular": "AT&T",
    "dish": "Dish",          # active but financially wobbly - weight down
}

UNCERTAIN_MAP = {
    "sprint": "Sprint→TMO?",
    "nextel": "Nextel→TMO?",
    "sprint/nextel": "Sprint/Nextel→TMO?",
    "metropcs": "MetroPCS→TMO?",
    "clearwire": "Clearwire→TMO?",
}


def parse_carrier(raw):
    """'Verizon @ 88.5'' -> ('verizon', "88.5'")"""
    if raw is None:
        return None, None
    parts = str(raw).split("@", 1)
    name = parts[0].strip().lower()
    height = parts[1].strip() if len(parts) > 1 else None
    return (name or None), height


def classify_row(carrier_values):
    """Given the raw Carrier #1..#9 values for one site, return
    (active:list, uncertain:list, other:list) with successor names deduped."""
    active, uncertain, other = [], [], []
    for raw in carrier_values:
        name, _ = parse_carrier(raw)
        if not name:
            continue
        if name in ACTIVE_MAP:
            v = ACTIVE_MAP[name]
            if v not in active:
                active.append(v)
        elif name in UNCERTAIN_MAP:
            v = UNCERTAIN_MAP[name]
            if v not in uncertain:
                uncertain.append(v)
        else:
            if name not in other:
                other.append(name)
    return active, uncertain, other


# Structure types where the PROPERTY OWNER is the lease counterparty
# (vs. freestanding towers usually owned by ATC/Crown/SBA on ground leases)
BUILDING_TYPE_PATTERN = (
    r"rooftop|building|smokestack|penthouse|facade|chimney|billboard|parking"
)

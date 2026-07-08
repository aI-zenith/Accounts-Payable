"""Match tower sites (masked addresses like '*** Newfield Avenue') to
candidate parcels from the CT parcel/CAMA data.

Matching logic:
  1. Normalize street names on both sides (AVENUE->AVE, STREET->ST, etc.)
  2. Same town + same normalized street = candidate parcel
  3. The masked digits tell us the house-number length: '***' = 3 digits,
     '****' = 4 digits -> filter candidates to numbers of that length
  4. Score candidates: fewer candidates = higher confidence; commercial /
     apartment use codes rank above single-family (antennas need height)
"""
import re

SUFFIX = {
    "avenue": "ave", "av": "ave", "ave": "ave",
    "street": "st", "st": "st",
    "road": "rd", "rd": "rd",
    "drive": "dr", "dr": "dr",
    "boulevard": "blvd", "blvd": "blvd",
    "turnpike": "tpke", "tpke": "tpke", "tnpk": "tpke",
    "place": "pl", "pl": "pl",
    "lane": "ln", "ln": "ln",
    "court": "ct", "ct": "ct",
    "terrace": "ter", "ter": "ter",
    "highway": "hwy", "hwy": "hwy",
}

# CAMA state-use codes that suggest a building tall/commercial enough to
# host rooftop antennas (apartments, commercial, industrial, mixed).
GOOD_USE_HINT = re.compile(r"apart|apts|comm|indust|mixed|office|retail|mercant",
                           re.IGNORECASE)


def norm_street(s):
    """'*** Newfield Avenue' -> ('newfield ave', 3)  (name, masked digit count)"""
    if not s:
        return "", 0
    s = str(s).strip().lower()
    stars = re.match(r"^(\*+)", s)
    ndigits = len(stars.group(1)) if stars else 0
    s = re.sub(r"^[\*\d\-/]+\s*", "", s)          # strip number/mask
    s = re.sub(r"\(.*?\)", " ", s)                 # drop parentheticals
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    words = [w for w in s.split() if w]
    if words and words[-1] in SUFFIX:
        words[-1] = SUFFIX[words[-1]]
    return " ".join(words), ndigits


def parcel_street_and_number(addr):
    """'568 NEWFIELD AVE' -> ('newfield ave', '568')"""
    if not addr:
        return "", ""
    m = re.match(r"^\s*(\d+)[a-z]?\s+(.*)$", str(addr).strip().lower())
    if not m:
        name, _ = norm_street(addr)
        return name, ""
    name, _ = norm_street(m.group(2))
    return name, m.group(1)


def match_tower(town, tower_address, parcels_by_town_street):
    """Return scored candidate parcels for one tower row.

    parcels_by_town_street: dict[(town_lower, street_norm)] -> list of parcel
    dicts each having at least: address, owner, use_desc (may be None), raw.
    """
    street, ndigits = norm_street(tower_address)
    if not street:
        return []
    cands = list(parcels_by_town_street.get((town.strip().lower(), street), []))
    out = []
    for p in cands:
        _, num = parcel_street_and_number(p.get("address", ""))
        score = 1.0
        if ndigits and num:
            score += 2.0 if len(num) == ndigits else -1.0
        use = p.get("use_desc") or ""
        if GOOD_USE_HINT.search(use):
            score += 2.0
        out.append({**p, "match_score": score})
    out.sort(key=lambda p: -p["match_score"])
    # confidence bonus context: how many plausible candidates exist
    for p in out:
        p["n_candidates"] = len(out)
    return out


def index_parcels(rows, town_key, addr_key, owner_key, use_key):
    """Build the lookup index from parcel CSV rows (list of dicts)."""
    idx = {}
    for r in rows:
        town = (r.get(town_key) or "").strip().lower()
        street, _ = norm_street(r.get(addr_key) or "")
        if not town or not street:
            continue
        idx.setdefault((town, street), []).append({
            "address": r.get(addr_key),
            "owner": r.get(owner_key),
            "use_desc": r.get(use_key),
            "raw": r,
        })
    return idx

"""Turnkey CT tower-lead build.

Runs the whole pipeline once data.ct.gov is reachable:
  1. Detect the parcel dataset's REAL column names (they vary by vintage) by
     fetching one sample row, and map them to the town/address/owner/use flags.
  2. Download towers.
  3. Download parcels for the target towns (using the detected town column).
  4. Build output/leads.xlsx.

Usage:
  python run_all.py
  python run_all.py --towns Bridgeport "New Haven" Hartford Meriden Stamford Norwalk
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

PARCELS_ID = "pqrn-qghw"
BASE = "https://data.ct.gov/resource"

TARGET_TOWNS = ["Bridgeport", "New Haven", "Hartford", "Meriden", "Stamford", "Norwalk"]


def get_json(url):
    req = urllib.request.Request(url)
    token = os.environ.get("SOCRATA_APP_TOKEN")
    if token:
        req.add_header("X-App-Token", token)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def detect_fields():
    """Fetch one parcel row and pick the best-matching column for each role."""
    sample = get_json(f"{BASE}/{PARCELS_ID}.json?" + urllib.parse.urlencode({"$limit": 1}))
    if not sample:
        sys.exit("parcel dataset returned no rows for column detection")
    cols = list(sample[0].keys())
    print("Parcel dataset columns:", ", ".join(cols))
    low = {c.lower(): c for c in cols}

    def pick(candidates_exact, patterns, label, required=True):
        # exact (case-insensitive) name match first
        for cand in candidates_exact:
            if cand in low:
                return low[cand]
        # then regex against column names
        for pat in patterns:
            for c in cols:
                if re.search(pat, c, re.IGNORECASE):
                    return c
        if required:
            sys.exit(f"could not detect a column for {label}; columns were: {cols}")
        return None

    town = pick(["town_name", "town", "municipality", "muni"],
                [r"town", r"municipal"], "town")
    addr = pick(["location", "site_address", "situs_address", "property_address",
                 "prop_location", "address", "situs"],
                [r"situs", r"site.?addr", r"prop.*(loc|addr)", r"location", r"address"],
                "address")
    owner = pick(["owner", "owner_name", "current_owner", "own_name", "ownername"],
                 [r"^owner", r"owner.?name", r"owner"], "owner")
    use = pick(["state_use_description", "use_description", "state_use_desc",
                "use_desc", "property_use", "land_use_description", "state_use"],
               [r"use.*desc", r"desc.*use", r"land.?use", r"state.?use", r"use"],
               "use description", required=False)

    print(f"Detected -> town={town!r} addr={addr!r} owner={owner!r} use={use!r}")
    return town, addr, owner, use


def run(cmd):
    print("\n$ " + " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--towns", nargs="*", default=TARGET_TOWNS)
    args = ap.parse_args()

    os.makedirs("data", exist_ok=True)
    os.makedirs("output", exist_ok=True)

    town, addr, owner, use = detect_fields()
    py = sys.executable

    run([py, "fetch.py", "towers"])
    run([py, "fetch.py", "parcels", "--town-field", town, "--towns", *args.towns])

    build = [py, "build_leads.py", "--parcels", "data/parcels.csv",
             "--town-field", town, "--addr-field", addr, "--owner-field", owner,
             "--towns", *args.towns]
    if use:
        build += ["--use-field", use]
    run(build)

    print("\nDone. Output: output/leads.xlsx")


if __name__ == "__main__":
    main()

"""Download source datasets from the CT Open Data Portal (Socrata API).

Datasets:
  TOWERS  n7zh-5dbr  Telecommunications Towers and Antennas (statewide)
  PARCELS pqrn-qghw  2024 Connecticut Parcel and CAMA Data (statewide, ~1.2M rows)

No API key needed for moderate use; an app token (free at data.ct.gov)
raises rate limits - set SOCRATA_APP_TOKEN env var if you have one.

Usage:
  python fetch.py towers
  python fetch.py parcels --towns Bridgeport Hartford Meriden
"""
import argparse
import csv
import os
import sys
import time
import urllib.parse
import urllib.request

BASE = "https://data.ct.gov/resource"
TOWERS_ID = "n7zh-5dbr"
PARCELS_ID = "pqrn-qghw"
PAGE = 50000


def _get(url):
    req = urllib.request.Request(url)
    token = os.environ.get("SOCRATA_APP_TOKEN")
    if token:
        req.add_header("X-App-Token", token)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode("utf-8")


def fetch_csv(dataset_id, out_path, where=None):
    """Page through a Socrata dataset and write a single CSV."""
    offset, header_written, total = 0, False, 0
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        while True:
            params = {"$limit": PAGE, "$offset": offset}
            if where:
                params["$where"] = where
            url = f"{BASE}/{dataset_id}.csv?" + urllib.parse.urlencode(params)
            chunk = _get(url)
            lines = chunk.splitlines()
            if not lines or (len(lines) == 1 and not header_written):
                break
            rows = lines if not header_written else lines[1:]
            if not rows:
                break
            f.write("\n".join(rows) + "\n")
            got = len(rows) - (0 if header_written else 1)
            header_written = True
            total += got
            print(f"  {out_path}: {total} rows...", flush=True)
            if got < PAGE:
                break
            offset += PAGE
            time.sleep(0.5)
    print(f"Done: {out_path} ({total} rows)")


def towns_where(towns, field="town_name"):
    """Build a SoQL where-clause matching a list of towns (case-insensitive).
    NOTE: verify the town column name on the dataset page; CAMA datasets have
    used 'town_name' / 'municipality' in different vintages. Adjust --town-field.
    """
    quoted = ",".join("'" + t.upper().replace("'", "''") + "'" for t in towns)
    return f"upper({field}) in({quoted})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["towers", "parcels"])
    ap.add_argument("--towns", nargs="*", help="limit parcels to these towns")
    ap.add_argument("--town-field", default="town_name",
                    help="parcel dataset column holding the town name")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if args.what == "towers":
        out = args.out or "data/towers.csv"
        fetch_csv(TOWERS_ID, out)
    else:
        out = args.out or "data/parcels.csv"
        where = towns_where(args.towns, args.town_field) if args.towns else None
        if not args.towns:
            print("WARNING: full statewide parcel pull is ~1.2M rows; "
                  "consider --towns Bridgeport Hartford ...", file=sys.stderr)
        fetch_csv(PARCELS_ID, out, where=where)


if __name__ == "__main__":
    main()

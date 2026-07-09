"""Build the ranked cell-lease acquisition lead list.

Inputs (see fetch.py):
  data/towers.csv   - CT Siting Council statewide tower/antenna database
  data/parcels.csv  - CT parcel/CAMA extract (optional; enables owner matching)

Output:
  output/leads.xlsx - ranked building-mounted targets with active-carrier
                      counts and (if parcels provided) candidate owners

Usage:
  python build_leads.py                         # towers only
  python build_leads.py --parcels data/parcels.csv \
      --town-field town_name --addr-field location --owner-field owner \
      --use-field state_use_description
  python build_leads.py --towns Bridgeport Hartford   # filter output
"""
import argparse
import csv
import re
import sys

from carriers import classify_row, BUILDING_TYPE_PATTERN
import match as M

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    sys.exit("pip install openpyxl")


def load_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def carrier_cols(row):
    return [k for k in row if k.lower().startswith("carrier")]


def build(args):
    towers = load_csv(args.towers)
    if not towers:
        sys.exit("no tower rows")
    ccols = carrier_cols(towers[0])
    type_pat = re.compile(BUILDING_TYPE_PATTERN, re.IGNORECASE)

    parcel_idx = None
    if args.parcels:
        parcels = load_csv(args.parcels)
        parcel_idx = M.index_parcels(
            parcels, args.town_field, args.addr_field,
            args.owner_field, args.use_field)
        print(f"indexed {len(parcels)} parcels "
              f"({len(parcel_idx)} town/street keys)")

    town_filter = {t.lower() for t in (args.towns or [])}
    leads, seen = [], set()
    for r in towers:
        town = (r.get("Town") or r.get("town") or "").strip()
        addr = (r.get("Address") or r.get("address") or "").strip()
        ttype = (r.get("Tower Type") or r.get("tower_type") or "").strip()
        if town_filter and town.lower() not in town_filter:
            continue
        if not type_pat.search(ttype or ""):
            continue
        key = (town.lower(), addr.lower(), ttype.lower())
        if key in seen:
            continue
        seen.add(key)
        active, uncertain, _ = classify_row([r.get(c) for c in ccols])
        if len(active) < args.min_active:
            continue
        lead = {
            "town": town, "address": addr, "type": ttype,
            "active": active, "uncertain": uncertain,
            "candidates": [],
        }
        if parcel_idx is not None:
            lead["candidates"] = M.match_tower(town, addr, parcel_idx)[:args.max_candidates]
        leads.append(lead)

    # Rank: active count desc, then Dish-dependence penalty, then fewer candidates
    def rank(l):
        dish_penalty = 0.5 if ("Dish" in l["active"] and len(l["active"]) <= 2) else 0
        return (-(len(l["active"]) - dish_penalty), l["town"])
    leads.sort(key=rank)

    write_xlsx(leads, args.out, parcels_enabled=parcel_idx is not None)
    print(f"{len(leads)} leads -> {args.out}")


# Actual CAMA column names in the parcel dataset (verified from the header row):
#   owner mailing address -> mailing_address (+ _2 / city / state / zip)
#   last sale date        -> sale_date        (e.g. "7/1/2016 0:00")
#   last sale price       -> sale_price       (e.g. "340000"; "0" = non-arms-length)
MAIL_FIELDS = ["mailing_address", "mailing_address_2"]
MAIL_CITY, MAIL_STATE, MAIL_ZIP = "mailing_city", "mailing_state", "mailing_zip"
SALE_DATE_FIELD, SALE_PRICE_FIELD = "sale_date", "sale_price"


def fmt_mailing(raw):
    """Compose 'STREET[, LINE2], CITY ST ZIP' from a raw CAMA row; '' if empty."""
    raw = raw or {}
    street = ", ".join(p.strip() for p in (raw.get(f) or "" for f in MAIL_FIELDS) if p.strip())
    city = (raw.get(MAIL_CITY) or "").strip()
    st = (raw.get(MAIL_STATE) or "").strip()
    zc = (raw.get(MAIL_ZIP) or "").strip()
    locality = " ".join(p for p in [city, st, zc] if p)
    return ", ".join(p for p in [street, locality] if p)


def fmt_sale_date(raw):
    """'7/1/2016 0:00' -> '7/1/2016'; '' -> None."""
    v = ((raw or {}).get(SALE_DATE_FIELD) or "").strip()
    return v.split(" ", 1)[0] if v else None


def fmt_sale_price(raw):
    """'340000' -> '$340,000'; '' -> None (keeps 0 as $0, faithful to source)."""
    v = ((raw or {}).get(SALE_PRICE_FIELD) or "").strip()
    if not v:
        return None
    try:
        return "${:,}".format(int(float(v)))
    except ValueError:
        return v


def write_xlsx(leads, out_path, parcels_enabled):
    wb = Workbook()
    ws = wb.active
    ws.title = "Leads"
    F = "Arial"
    hdr_fill = PatternFill("solid", start_color="1F4E79")
    hdr_font = Font(name=F, bold=True, color="FFFFFF", size=10)
    thin = Border(bottom=Side(style="thin", color="D9D9D9"))
    gold = PatternFill("solid", start_color="FFF2CC")

    ws["A1"] = "CT Cell-Lease Acquisition Leads — building-mounted, active carriers"
    ws["A1"].font = Font(name=F, bold=True, size=13)
    ws["A2"] = ("Active = Verizon/T-Mobile/AT&T(incl. Cingular)/Dish. Uncertain = "
                "Sprint/Nextel/MetroPCS/Clearwire (T-Mobile absorbed; verify). "
                "Candidate owners matched by town+street; masked house-number "
                "length used to narrow. Verify visually before outreach.")
    ws["A2"].font = Font(name=F, italic=True, size=9, color="595959")

    cols = ["Town", "DB Address", "Type", "# Active", "Active Carriers",
            "Legacy/Uncertain", "Candidate Parcel(s)", "Candidate Owner(s)",
            "Owner Mailing Address", "Last Sale Date", "Last Sale Price",
            "Use", "# Cands"]
    start = 4
    for j, c in enumerate(cols, 1):
        cell = ws.cell(row=start, column=j, value=c)
        cell.fill, cell.font = hdr_fill, hdr_font
        cell.alignment = Alignment(horizontal="center")
    r = start + 1
    for l in leads:
        cands = l["candidates"]
        vals = [
            l["town"], l["address"], l["type"], len(l["active"]),
            ", ".join(l["active"]), ", ".join(l["uncertain"]) or None,
            "; ".join(str(c["address"]) for c in cands) or None,
            "; ".join(str(c["owner"]) for c in cands if c.get("owner")) or None,
            "; ".join(fmt_mailing(c.get("raw")) or "—" for c in cands) or None,
            "; ".join(fmt_sale_date(c.get("raw")) or "—" for c in cands) or None,
            "; ".join(fmt_sale_price(c.get("raw")) or "—" for c in cands) or None,
            "; ".join(str(c["use_desc"]) for c in cands if c.get("use_desc")) or None,
            cands[0]["n_candidates"] if cands else None,
        ]
        for j, v in enumerate(vals, 1):
            cell = ws.cell(row=r, column=j, value=v)
            cell.font = Font(name=F, size=9)
            cell.border = thin
            cell.alignment = Alignment(vertical="top", wrap_text=j in (7, 8, 9, 12))
            if len(l["active"]) >= 3:
                cell.fill = gold
        r += 1
    widths = [14, 28, 16, 9, 24, 24, 34, 34, 34, 14, 14, 20, 8]
    for j, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.freeze_panes = f"A{start+1}"
    last_col = get_column_letter(len(cols))
    ws.auto_filter.ref = f"A{start}:{last_col}{r-1}"
    wb.save(out_path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--towers", default="data/towers.csv")
    ap.add_argument("--parcels", default=None)
    ap.add_argument("--towns", nargs="*")
    ap.add_argument("--min-active", type=int, default=2)
    ap.add_argument("--max-candidates", type=int, default=4)
    ap.add_argument("--town-field", default="town_name")
    ap.add_argument("--addr-field", default="location")
    ap.add_argument("--owner-field", default="owner")
    ap.add_argument("--use-field", default="state_use_description")
    ap.add_argument("--out", default="output/leads.xlsx")
    args = ap.parse_args()
    build(args)

# CT Cell-Lease Lead Machine

Turns Connecticut's public data into a ranked list of buildings with active
cell-carrier leases — the acquisition pipeline we built by hand for
568 Newfield Ave, automated.

## What it does

1. **Downloads** the CT Siting Council statewide tower/antenna database and
   the statewide parcel/CAMA data (owner names) from data.ct.gov
2. **Maps carrier brands** to their 2026 successors (Cingular→AT&T,
   MetroPCS/T-Mobile→T-Mobile) and separates uncertain legacy tenants
   (Sprint/Nextel/MetroPCS/Clearwire — T-Mobile absorbed; verify per site)
3. **Filters to building-mounted sites** (rooftop / building mount /
   smokestack / billboard / parking) — where the *property owner* is the
   lease counterparty, unlike ground-leased monopoles
4. **Matches masked tower addresses to parcels**: same town + normalized
   street, narrowed by the masked house-number length (`***` = 3 digits),
   ranked by use code (apartments/commercial score above single-family)
5. **Outputs** `output/leads.xlsx`: ranked leads with active-carrier counts,
   candidate parcel addresses, and owner names

## Quick start

```bash
pip install openpyxl

# 1. Tower database (~2,400 rows, fast)
python fetch.py towers

# 2. Parcels for your target towns (statewide is ~1.2M rows; filter!)
python fetch.py parcels --towns Bridgeport Hartford Meriden "New Haven"

# 3. Build the lead list
python build_leads.py --parcels data/parcels.csv \
    --towns Bridgeport Hartford Meriden "New Haven"
```

### Column-name check (do this once)

The parcel dataset's column names vary by vintage. Open
https://data.ct.gov/Local-Government/2024-Connecticut-Parcel-and-CAMA-Data/pqrn-qghw
→ "Columns" and pass the real names:

```bash
python build_leads.py --parcels data/parcels.csv \
    --town-field <town column> --addr-field <address column> \
    --owner-field <owner column> --use-field <use description column>
```

If `fetch.py parcels` errors on the town filter, fix `--town-field` there too.

## Reading the output

- **Gold rows** = 3+ active carriers (premium sites)
- **# Cands** = how many parcels matched; 1–3 means the masked address is
  nearly resolved, 10+ means do the Street View pass first
- **Dish-heavy sites** are ranked down slightly (EchoStar financial risk)
- Owner = "CITY OF ...", housing authority, or "...CONDO ASSN" → not
  fee-simple purchasable; skip or treat as lease-purchase-from-association

## What still needs a human (or a browser agent)

- **Visual confirmation** the antennas physically exist today (Street View)
- **Land-records easement check** — has the owner already sold the lease to
  Landmark/AP Wireless/Symphony? (i2o.uslandrecords.com, grantor index)
- **CT business registry** for LLC principals (service.ct.gov/business)
- **Lease terms** — recorded Notices of Lease give carrier/term/renewals
  but never rent

These four are browser-form workflows — ideal for Claude in Chrome, or paste
findings back into the workbook.

## Extension ideas (open this folder in Claude Code)

- Auto-write per-target underwriting tabs (the 568 Newfield model)
- Pull building heights from CT LiDAR / assessor stories to cross-check
  antenna heights against candidate buildings
- Owner mailing-address dedupe → one letter per owner across multiple sites
- Mail-merge outreach letters from the lead list
- Track outreach status + follow-up dates per lead

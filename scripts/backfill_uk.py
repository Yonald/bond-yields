#!/usr/bin/env python3
"""One-time UK backfill.

The daily job only pulls the Bank of England's current-month file, because the
full archive is a ~39 MB download. This script fetches that archive once and
merges its 10-year and 30-year spot rates into data/yields.json.

Only needed if data/yields.json is missing UK history. Run:
    python scripts/backfill_uk.py
"""

import datetime as dt
import json
import sys

from fetch_yields import DATA_FILE, HISTORY_YEARS, MATURITIES, fetch_uk


def main() -> int:
    if not DATA_FILE.exists():
        print("data/yields.json not found -- run fetch_yields.py first.")
        return 1

    print("Downloading Bank of England archive (~39 MB, takes a minute)...")
    archive = fetch_uk(current_month_only=False)
    for maturity in MATURITIES:
        print(f"  {maturity}: {len(archive.get(maturity, {}))} points parsed")

    payload = json.loads(DATA_FILE.read_text())
    uk = payload["countries"].setdefault(
        "UK",
        {"name": "United Kingdom", "bond": "Gilt", "source": "Bank of England",
         "series": {}, "last": {}, "lastDate": {}},
    )

    cutoff = (dt.date.today() - dt.timedelta(days=365 * HISTORY_YEARS + 30)).isoformat()
    changed = False

    for maturity in MATURITIES:
        history = {d: v for d, v in uk["series"].get(maturity, [])}
        history.update(archive.get(maturity, {}))
        points = sorted((d, v) for d, v in history.items() if d >= cutoff)
        if not points:
            continue
        uk["series"][maturity] = [list(p) for p in points]
        uk["last"][maturity] = points[-1][1]
        uk["lastDate"][maturity] = points[-1][0]
        print(f"  {maturity}: {len(points)} stored, {points[0][0]} to {points[-1][0]}")
        changed = True

    if not changed:
        print("Archive produced no usable rows; leaving the file untouched.")
        return 1

    payload["stale"] = [c for c in payload.get("stale", []) if c != "UK"]
    DATA_FILE.write_text(json.dumps(payload, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())

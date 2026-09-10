#!/usr/bin/env python3
"""One-time UK backfill.

The daily job only pulls the Bank of England's current-month file, because the
full archive is a ~39 MB download. This script fetches that archive once and
merges its 30-year spot rates into data/yields.json.

Only needed if data/yields.json is missing UK history. Run:
    python scripts/backfill_uk.py
"""

import datetime as dt
import json
import sys

from fetch_yields import DATA_FILE, HISTORY_YEARS, fetch_uk


def main() -> int:
    if not DATA_FILE.exists():
        print("data/yields.json not found — run fetch_yields.py first.")
        return 1

    print("Downloading Bank of England archive (~39 MB, takes a minute)...")
    archive = fetch_uk(current_month_only=False)
    print(f"Parsed {len(archive)} points from the archive.")

    payload = json.loads(DATA_FILE.read_text())
    uk = payload["countries"].setdefault(
        "UK",
        {
            "name": "United Kingdom",
            "bond": "30Y Gilt",
            "source": "Bank of England",
            "series": [],
        },
    )

    history = {date: value for date, value in uk["series"]}
    history.update(archive)

    cutoff = (dt.date.today() - dt.timedelta(days=365 * HISTORY_YEARS + 30)).isoformat()
    series = sorted((d, v) for d, v in history.items() if d >= cutoff)
    if not series:
        print("Archive produced no usable rows; leaving the file untouched.")
        return 1

    uk["series"] = [list(point) for point in series]
    uk["last"], uk["lastDate"] = series[-1][1], series[-1][0]
    payload["stale"] = [c for c in payload.get("stale", []) if c != "UK"]

    DATA_FILE.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"UK now has {len(series)} points, {series[0][0]} to {series[-1][0]}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

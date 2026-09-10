#!/usr/bin/env python3
"""
Fetch 30-year government bond yields for six countries from official sources
and merge them into data/yields.json.

Every source is an official publisher (treasury / central bank). All values are
end-of-day. Nothing here is intraday.

Sources
  US  US Treasury daily yield curve CSV          (30 Yr, par yield)
  DE  Deutsche Bundesbank time series API        (Svensson spot, 30.0y residual)
  UK  Bank of England GLC nominal daily data     (spot curve, 30y)
  FR  Eurostat Maastricht convergence rate     (10Y, MONTHLY -- see README)
  CA  Bank of Canada Valet API                   (long-term benchmark bond)
  JP  Japan MoF JGB interest rate CSV            (30Y)

Run:  python scripts/fetch_yields.py
No API keys required.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import pathlib
import sys
import zipfile

import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "yields.json"

# Keep the stored history bounded so the JSON stays small enough to load fast.
HISTORY_YEARS = 3

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
TIMEOUT = 90

COUNTRIES = {
    "US": {"name": "United States", "bond": "30Y Treasury", "source": "US Treasury"},
    "DE": {"name": "Germany", "bond": "30Y Bund", "source": "Deutsche Bundesbank"},
    "UK": {"name": "United Kingdom", "bond": "30Y Gilt", "source": "Bank of England"},
    "FR": {
        "name": "France",
        "bond": "10Y \u00b7 monthly average",
        "source": "Eurostat",
        "freq": "monthly",
        "caveat": "No official daily French yield exists since July 2024.",
    },
    "CA": {"name": "Canada", "bond": "Long benchmark", "source": "Bank of Canada"},
    "JP": {"name": "Japan", "bond": "30Y JGB", "source": "Japan Ministry of Finance"},
}


def get(url: str, **kw) -> requests.Response:
    r = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT, **kw)
    r.raise_for_status()
    return r


def clean(pairs) -> dict[str, float]:
    """Drop blanks, coerce to float, key by ISO date."""
    out = {}
    for date, value in pairs:
        if value in (None, "", ".", "-", "ND", "NaN"):
            continue
        try:
            out[date] = round(float(value), 4)
        except (TypeError, ValueError):
            continue
    return out


# --------------------------------------------------------------------------
# Per-country fetchers. Each returns {"YYYY-MM-DD": yield_percent}
# --------------------------------------------------------------------------

def fetch_us() -> dict[str, float]:
    years = range(dt.date.today().year - HISTORY_YEARS + 1, dt.date.today().year + 1)
    pairs = []
    for year in years:
        url = (
            "https://home.treasury.gov/resource-center/data-chart-center/"
            f"interest-rates/daily-treasury-rates.csv/{year}/all"
            f"?type=daily_treasury_yield_curve&field_tdr_date_value={year}"
            "&page&_format=csv"
        )
        rows = csv.DictReader(io.StringIO(get(url).text))
        for row in rows:
            raw = row.get("Date")
            if not raw:
                continue
            date = dt.datetime.strptime(raw.strip(), "%m/%d/%Y").date().isoformat()
            pairs.append((date, row.get("30 Yr")))
    return clean(pairs)


def fetch_de() -> dict[str, float]:
    series = "D.I.ZST.ZI.EUR.S1311.B.A604.R30XX.R.A.A._Z._Z.A"
    url = (
        f"https://api.statistiken.bundesbank.de/rest/download/BBSIS/{series}"
        "?format=csv&lang=en"
    )
    pairs = []
    for row in csv.reader(io.StringIO(get(url).text)):
        if len(row) < 2:
            continue
        date = row[0].strip().strip('"').lstrip("\ufeff")
        # Data rows start with an ISO date; metadata rows do not.
        if len(date) == 10 and date[4] == "-" and date[7] == "-":
            pairs.append((date, row[1].strip()))
    return clean(pairs)


def fetch_uk(current_month_only: bool = True) -> dict[str, float]:
    """Bank of England publishes the nominal spot curve as xlsx inside a zip.

    The 'latest' zip holds the current month only, so this is designed to be
    merged into an accumulating history. Use scripts/backfill_uk.py once to
    load the archive.
    """
    import openpyxl

    url = (
        "https://www.bankofengland.co.uk/-/media/boe/files/statistics/"
        "yield-curves/latest-yield-curve-data.zip"
        if current_month_only
        else "https://www.bankofengland.co.uk/-/media/boe/files/statistics/"
        "yield-curves/glcnominalddata.zip"
    )
    archive = zipfile.ZipFile(io.BytesIO(get(url).content))
    names = [n for n in archive.namelist() if "Nominal" in n and n.endswith(".xlsx")]
    pairs = []
    for name in names:
        book = openpyxl.load_workbook(
            io.BytesIO(archive.read(name)), read_only=True, data_only=True
        )
        if "4. spot curve" not in book.sheetnames:
            continue
        sheet = book["4. spot curve"]
        col30 = None
        for row in sheet.iter_rows(values_only=True):
            if not row:
                continue
            head = row[0]
            # The header row labels each column with a maturity in years.
            if isinstance(head, str) and head.strip().lower() == "years:":
                for idx, cell in enumerate(row):
                    if isinstance(cell, (int, float)) and abs(cell - 30) < 1e-9:
                        col30 = idx
                break
        if col30 is None:
            continue
        for row in sheet.iter_rows(values_only=True):
            if row and isinstance(row[0], dt.datetime) and len(row) > col30:
                pairs.append((row[0].date().isoformat(), row[col30]))
        book.close()
    return clean(pairs)


def fetch_fr() -> dict[str, float]:
    """France, via Eurostat's EMU convergence criterion series (monthly).

    France is the exception on this page. Banque de France stopped publishing
    OAT rates on 10 July 2024, and no official publisher has replaced them --
    French govvies trade OTC, so the only daily signal comes from commercial
    dealer-quote feeds. Eurostat's Maastricht long-term rate is the closest
    free official substitute: 10-year rather than 30-year, and a monthly
    average rather than a daily close.

    Both compromises are surfaced in the UI rather than hidden. No API key.
    """
    url = (
        "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/"
        "irt_lt_mcby_m"
    )
    since = f"{dt.date.today().year - HISTORY_YEARS}-01"
    payload = get(url, params={"format": "JSON", "geo": "FR", "sinceTimePeriod": since}).json()

    periods = payload["dimension"]["time"]["category"]["index"]
    by_position = {position: period for period, position in periods.items()}

    pairs = []
    for flat_index, value in payload.get("value", {}).items():
        period = by_position.get(int(flat_index))
        if not period:
            continue
        # A monthly average belongs mid-month, not on the 1st.
        pairs.append((f"{period}-15", value))
    return clean(pairs)


def fetch_ca() -> dict[str, float]:
    start = (dt.date.today() - dt.timedelta(days=365 * HISTORY_YEARS)).isoformat()
    url = (
        "https://www.bankofcanada.ca/valet/observations/"
        f"BD.CDN.LONG.DQ.YLD/json?start_date={start}"
    )
    payload = get(url).json()
    pairs = [
        (obs["d"], obs.get("BD.CDN.LONG.DQ.YLD", {}).get("v"))
        for obs in payload.get("observations", [])
    ]
    return clean(pairs)


def fetch_jp() -> dict[str, float]:
    base = "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/"
    pairs = []
    for suffix in ("historical/jgbcme_all.csv", "jgbcme.csv"):
        text = get(base + suffix).content.decode("shift_jis", errors="replace")
        col30 = None
        for row in csv.reader(io.StringIO(text)):
            if not row:
                continue
            if row[0].strip() == "Date":
                col30 = row.index("30Y") if "30Y" in row else None
                continue
            if col30 is None or len(row) <= col30:
                continue
            try:
                date = dt.datetime.strptime(row[0].strip(), "%Y/%m/%d").date()
            except ValueError:
                continue
            pairs.append((date.isoformat(), row[col30].strip()))
    return clean(pairs)


FETCHERS = {
    "US": fetch_us,
    "DE": fetch_de,
    "UK": fetch_uk,
    "FR": fetch_fr,
    "CA": fetch_ca,
    "JP": fetch_jp,
}


def main() -> int:
    existing = {}
    if DATA_FILE.exists():
        existing = json.loads(DATA_FILE.read_text()).get("countries", {})

    cutoff = (dt.date.today() - dt.timedelta(days=365 * HISTORY_YEARS + 30)).isoformat()
    countries, failures = {}, []

    for code, meta in COUNTRIES.items():
        history = {d: v for d, v in existing.get(code, {}).get("series", [])}
        try:
            fresh = FETCHERS[code]()
            history.update(fresh)
            print(f"  {code}: +{len(fresh)} points fetched")
        except Exception as exc:  # keep one bad source from killing the run
            failures.append(code)
            print(f"  {code}: FAILED ({exc.__class__.__name__}: {exc})")

        series = sorted((d, v) for d, v in history.items() if d >= cutoff)
        if not series:
            continue
        countries[code] = {
            **meta,
            "last": series[-1][1],
            "lastDate": series[-1][0],
            "series": [list(point) for point in series],
        }
        print(f"      -> {len(series)} stored, latest {series[-1][0]} = {series[-1][1]}%")

    if not countries:
        print("No data at all; refusing to overwrite.")
        return 1

    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(
        json.dumps(
            {
                "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "maturity": "30Y",
                "note": "End-of-day official data. Not intraday, not investment advice.",
                "stale": failures,
                "countries": countries,
            },
            separators=(",", ":"),
        )
    )
    print(f"\nWrote {DATA_FILE} ({DATA_FILE.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

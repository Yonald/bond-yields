# Sovereign Yields

A single page showing **10-year and 30-year** government bond yields for the US, Germany, UK, France, Canada and Japan.

Each country panel carries 1-day, 1-week, 1-month and year-to-date changes in basis points, the spread against the German Bund of the same maturity, and a bar showing where today sits inside the selected window's range.

The main chart has two modes. **Levels** plots absolute yields. **Change** rebases every line to zero at the start of the window, which is usually the more useful view -- it answers "who is moving" rather than "who has high yields", and stops the tightly-clustered countries disappearing into each other.

No server, no database, no build step. A scheduled GitHub Action fetches the data, commits it as JSON, and GitHub Pages serves the page.

```
GitHub Action (weekdays, 22:30 UTC)
   -> scripts/fetch_yields.py hits six official sources
   -> writes data/yields.json
   -> commits to main
   -> GitHub Pages serves index.html, which reads that JSON
```

Because the data lives in the repo, the page has no API keys in it and no cross-origin requests to worry about.

## Data sources

Every source is the official publisher. No API keys are needed anywhere. All values are **end-of-day** — there is no intraday data here, so "1d" means the change from the previous published close.

| Country | Series | Source | Key needed |
|---|---|---|---|
| US | 10Y + 30Y par yields | US Treasury daily yield curve CSV | No |
| Germany | 10.0y + 30.0y residual, Svensson fit | Bundesbank time series API | No |
| UK | 10y + 30y nominal spot rates | Bank of England yield curve files | No |
| France | 10-year, monthly average | Eurostat (Maastricht rate) | No |
| Canada | 10y + long-term benchmark bonds | Bank of Canada Valet API | No |
| Japan | 10Y + 30Y JGB | Ministry of Finance CSV | No |

**France is a deliberate exception.** Banque de France stopped publishing OAT rates on 10 July 2024, and no official publisher replaced them. French government bonds trade over the counter, so the only daily signal now comes from commercial dealer-quote feeds (Trading Economics, EODHD and similar), which cost roughly $50/month and whose terms restrict republishing on a public site.

Rather than leave France out or quietly pay for it, the page uses Eurostat's Maastricht convergence rate: official, free, but **10-year rather than 30-year, and a monthly average rather than a daily close**. The UI makes both compromises visible — France draws as a dashed line, its panel is labelled `10Y · monthly average`, its 1d and 1w figures show as em-dashes because a monthly average cannot support them, and its 1m figure compares against the previous published month.

To swap in a paid daily feed later, replace `fetch_fr()` in `scripts/fetch_yields.py` and delete the `freq` and `caveat` keys from the `FR` entry in `COUNTRIES`. Nothing else needs to change.

Verified dead ends, so you don't repeat them: Banque de France's new Opendatasoft API (the TEC datasets exist but hold zero records), the ECB Data Portal (no French daily series at any maturity), Eurostat's daily tables (discontinued; only annual, quarterly and monthly remain), and DBnomics (no mirror). Trading Economics discontinued its free guest tier.

The other five are the closest official equivalents of a 30-year yield, but they are not identical in construction. The US is a par yield, Germany and the UK are fitted zero-coupon spot curves, Canada is the designated long-term benchmark bond, and Japan is the MoF 30-year rate. Comparable in level and direction; don't treat small cross-country differences as precise.

Canada has no formal 30-year benchmark series, so `BD.CDN.LONG.DQ.YLD` (the long-term benchmark, currently a ~30-year bond) stands in for 30Y.

France has no 30-year source of any kind. On the 30Y view its 10-year series stands in, tagged `10Y` in the legend and labelled on its panel; its spread is computed against the 10-year Bund rather than the 30-year, so the comparison stays like-for-like.

## Setup

### 1. Create the repository

Create a new repository on GitHub, then from this folder:

```bash
git init
git add .
git commit -m "30-year sovereign yield dashboard"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

### 2. Turn on Pages

Repository **Settings → Pages → Build and deployment**. Set source to **Deploy from a branch**, branch `main`, folder `/ (root)`. The site appears at `https://YOUR-USERNAME.github.io/YOUR-REPO/` within a minute or two.

### 3. Allow the Action to commit

**Settings → Actions → General → Workflow permissions**. Select **Read and write permissions**. Without this the daily update runs but can't push.

### 4. Nothing to configure

There are no API keys. Every source is open.

### 4. Run it once

Go to the **Actions** tab, choose **Update yields**, and click **Run workflow**. Check `data/yields.json` updates, then open the Pages URL.

## Running locally

```bash
pip install -r requirements.txt
python scripts/fetch_yields.py
python -m http.server 8000
```

Then open `http://localhost:8000`. Opening `index.html` directly as a `file://` URL will not work — the page fetches the JSON, which browsers block on `file://`.

## Notes

- `data/yields.json` keeps three years of history for both maturities, about 190 KB.
- The UK daily fetch only reads the Bank of England's current-month file. History accumulates in the JSON. If UK history is ever lost, `python scripts/backfill_uk.py` reloads both maturities from the full archive.
- If a source breaks, the run keeps going, the country's existing history is preserved, and its code is listed in the `stale` field so the page can flag it.
- The schedule is weekdays only, since bond markets don't publish at weekends.

## Adding a country or a maturity

Add an entry to `COUNTRIES` and a matching function in `FETCHERS` in `scripts/fetch_yields.py`, returning `{"10Y": {"YYYY-MM-DD": pct}, "30Y": {...}}`. Then add the country code to `ORDER` in `assets/app.js` and a colour variable in `assets/styles.css`.

For a new maturity, add it to `MATURITIES` in the fetcher, teach each source function to return it, and add a button to the `.maturities` group in `index.html`. The front end reads the maturity list from the data, so nothing else needs changing.

Not investment advice.

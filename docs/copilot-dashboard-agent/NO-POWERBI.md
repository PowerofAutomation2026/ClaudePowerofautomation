# Live dashboard without Power BI

`dashboard.html` is a single file with no dependencies. It reads any CSV, shows row count, totals and averages of numeric columns, a bar chart (first number by first low-cardinality text column), a line chart (first number over first date column), and the data table. It reloads a CSV URL on a timer and redraws only when the content changed.

## Test locally (1 minute)
```
cd docs/copilot-dashboard-agent
python3 -m http.server 8000
```
Open `http://localhost:8000/dashboard.html?csv=sample-sales.csv`. Expect Rows 7, Units 67, Revenue 2,090. Edit `sample-sales.csv`, save, and within the refresh interval the page updates. You can also pick a file with the file chooser.

## Use it with the Copilot agent
1. Host `dashboard.html` somewhere your users can open: Azure Static Web Apps, an internal web server, or GitHub Pages.
2. The agent flow copies the new CSV to a place that page can fetch (same host, or a host that sends CORS headers). A SharePoint file link will not work directly because it needs sign-in and does not allow cross-origin reads.
3. The agent replies with `https://<your-host>/dashboard.html?csv=<csv path>`.
4. For xlsx and pdf files, the flow first converts the data to CSV (Excel "Get tables" then "Create CSV table"; AI Builder for PDFs).

## Limits
- SharePoint serves uploaded .html files as downloads, so do not store the page in a document library expecting it to render.
- Sign-in protected data needs a small API in front of it. Do not make company files public to get around this.
- Charts are deliberately simple. Tell me which charts you need and I will add them.

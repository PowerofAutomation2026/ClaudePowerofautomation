# Simple example: build and test (about 20 minutes)

Smallest working version: drop a CSV in SharePoint, the agent reads it and replies with a summary plus a Power BI link.

## Build
1. Create a SharePoint library folder `Dashboards-Inbox`.
2. Copilot Studio, Create agent, name `Dashboard Builder`.
3. Paste this into Instructions:
   ```
   When a CSV file is added to Dashboards-Inbox, read it. Reply with: file name,
   row count, column names, total of each numeric column, the top category by
   revenue, and 3 short insights. Never invent numbers. If you cannot read the
   file, say why.
   ```
4. Overview, Triggers, Add trigger, "When a file is created (SharePoint)". Pick your site and the `Dashboards-Inbox` library.
5. In the trigger payload, pass the file content: `Get file content` then "Run the agent with: file name = FileName, content = FileContent".
6. Add the file to Knowledge only if you want Q&A. It is not needed for the trigger.
7. Publish.

## Test
1. Upload `sample-sales.csv` to `Dashboards-Inbox`.
2. In Copilot Studio, Activity, check the run started.
3. Expected reply: 7 rows, columns Date/Region/Product/Units/Revenue, Units total 67, Revenue total 2090, top region North (1040).
4. Edge tests: upload an empty CSV (expect a clear error), a CSV with a text column in Revenue (expect a warning), a second file with the same name.

## Add the live dashboard later
1. Load the CSV rows into a SharePoint list (flow step).
2. Power BI Desktop, Get data, SharePoint Online list, build a bar and card visual, publish.
3. Have the agent return the report URL.

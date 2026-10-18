# Live dashboard from a SharePoint folder (Copilot Studio, new and legacy)

## What you get
- Drop CSV, Excel or PDF files in a SharePoint folder.
- A flow reads each file and writes a data sheet and a dashboard sheet (totals, averages, bar chart, line chart, warnings) into one workbook: `Live-Dashboard.xlsx`.
- The agent returns the workbook link. No web hosting. Opens in Excel for the web, SharePoint or Teams.
- "Live" means it refreshes every time the flow runs: when you ask the agent, and (Part 5) automatically when a file is added or changed. The numbers on the dashboard are Excel formulas over the data sheet, so editing the data sheet updates them at once.

Not tested in a real tenant. Menu names change. Test with the sample files first.

## What it needs
- Copilot Studio with credits (without credits every chat fails with EnforcementUsageCredits).
- Power Automate, with the Excel Online (Business) and SharePoint connectors.
- Office Scripts turned on for your organization (admin: Microsoft 365 admin center, Settings, Org settings, Office Scripts).
- For PDF files only: AI Builder.

## Part 1: Files and folders (5 min)
1. In SharePoint, in your site's Documents library, make two folders: `Dashboards-Inbox` and `Dashboards`.
2. Upload `Live-Dashboard.xlsx` (from this folder) into `Dashboards`.
3. Upload `../copilot-dashboard-agent/sample-sales.csv` and `sample-sales.xlsx` into `Dashboards-Inbox`.

## Part 2: Add the two scripts (10 min)
1. Open `Live-Dashboard.xlsx` in Excel for the web. Click **Automate**, then **New script**.
2. Delete the sample code, paste all of `scripts/BuildDashboard.ts`, rename the script `BuildDashboard`, click **Save**.
3. Open `sample-sales.xlsx` in Excel for the web. Automate, New script, paste `scripts/ReadWorkbookAsCsv.ts`, name it `ReadWorkbookAsCsv`, Save.
4. Test BuildDashboard by hand: this script needs two inputs, so test it from the flow (Part 3).

## Part 3: Make the flow (20 min)
Go to make.powerautomate.com, **Create**, **Instant cloud flow**, name `Build dashboard from folder`, trigger **Manually trigger a flow**. (In Copilot Studio you can also create it from Tools, Add a tool, New agent flow. Steps are the same.)

Add the input: **Add an input**, Text, name `FolderPath`, example `/Shared Documents/Dashboards-Inbox`.

Then add these actions in order:
1. **SharePoint, Get files (properties only)**: Site Address = your site, Library Name = Documents, Limit Entries to Folder = pick `Dashboards-Inbox`.
2. **Initialize variable** `results`, type Array.
3. **Apply to each** over the value from step 1. Inside it:
   1. **Initialize variable** is not allowed inside a loop, so first (before the loop) add **Initialize variable** `csvText`, type String, and use **Set variable** inside.
   2. **SharePoint, Get file content using path**: Site = your site, File Path = `Full Path` from the current item.
   3. **Switch** on the lowercase extension:
      `toLower(last(split(items('Apply_to_each')?['{FilenameWithExtension}'], '.')))`
      - Case `csv`: **Set variable** csvText = `base64ToString(outputs('Get_file_content_using_path')?['body/$content'])`
      - Case `xlsx`: **Excel Online (Business), Run script**: Location SharePoint site, Document Library Documents, File = the current item's path, Script = `ReadWorkbookAsCsv`. Then **Set variable** csvText = the script's `result`.
      - Case `pdf`: **AI Builder, Extract information from documents** (use the prebuilt document model or your own). Turn the extracted table into CSV with **Create CSV table**. Set csvText = its output. Check these results by hand; PDFs vary a lot.
      - Default: **Set variable** csvText = empty text.
   4. **Condition**: csvText is not equal to empty.
      - Yes: **Excel Online (Business), Run script**: Location = your site, Document Library = Documents, File = `/Dashboards/Live-Dashboard.xlsx`, Script = `BuildDashboard`, `csvText` = csvText variable, `fileName` = the item's `{FilenameWithExtension}`. Then **Append to array variable** `results` with: `{File}: {result}` using the script's `result`.
      - No: **Append to array variable** `results` with `{File}: unsupported file type or empty`.
4. **SharePoint, Get file metadata using path**: File path `/Shared Documents/Dashboards/Live-Dashboard.xlsx`.
5. **Respond to the agent** (or "Respond to a Power Virtual Agents / Copilot"): add two outputs, Text `message` = `join(variables('results'), ' || ')` and Text `dashboardLink` = the metadata's `Link to item`.
6. **Save**. Run it once by hand with `/Shared Documents/Dashboards-Inbox` and check the results (Part 6).

## Part 4: Connect it to the agent (10 min)
New experience:
1. Open the agent, **Build** tab, **Tools**, **Add a tool**, **Flow**, pick `Build dashboard from folder`.
2. Name it exactly `Build dashboard from folder`. Description: "Reads all CSV, Excel and PDF files in a SharePoint folder and updates the live Excel dashboard. Input: FolderPath."
3. **Skills**, **Upload a skill**, upload `skill/live-dashboard/SKILL.md`.
4. Publish.

Legacy:
1. Open the agent, **Tools** tab, **Add a tool**, pick the same flow. Same name and description.
2. **Overview**, **Instructions**: paste all of `agent/agent-instructions.txt`. Save.
3. Make sure Generative orchestration is on. Publish.

## Part 5: Make it automatic (optional)
Copy the flow, change the trigger to **SharePoint, When a file is created or modified (properties only)** for `Dashboards-Inbox`, remove the Apply to each loop and use the trigger's file instead. Then each new or changed file refreshes its dashboard without asking the agent.

## Part 6: Test
Chat with the agent (New test session each time):
| Say | Pass if |
|---|---|
| `Build a dashboard from /Shared Documents/Dashboards-Inbox` | Reply lists sample-sales.csv and sample-sales.xlsx, 7 rows each, and a link |
| Open the link | Sheets `sample-sales Data`, `sample-sales Dash`, `Files`; Dash shows Rows 7, Units total 67, Revenue total 2090, a bar chart by Region (North 28, South 23, East 16) and a line chart by Date |
| Upload `sample-bad.csv` to the folder and ask again | Reply warns about "eight", "n/a" and the blank Region |
| Edit a Units number on a Data sheet | Dash totals change immediately |
| Ask with an empty folder | Says no files, no made-up link |

If a test fails, copy the flow run's error from Power Automate, My flows, Run history, and send it to me.

## Known limits
- The Dash sheet's category list (for example Region) is built when the script runs. A new region added later appears after the next run.
- The charts use the first number column and the first text column with 2 to 12 distinct values. Other files may need a manual tweak in Excel.
- Large files: the CSV text is passed to a script, so keep files to a few MB.
- Opening the link needs a sign-in with access to the folder. That is by design.
- Files with different names make their own sheets; same name replaces the old sheets.

# Import the solution into Copilot Studio (no VS Code)

File: `LiveDashboardAgentTools_1_0_0_0.zip`. It is a Power Platform solution that contains one cloud flow, "Build dashboard from folder", with the agent trigger, folder loop, file-type switch, dashboard script call and response to the agent already wired.

HONEST STATUS: I could not import it into a real tenant from here. The file structure and JSON are valid, but the flow comes in as a DRAFT and 8 settings marked `RE-POINT` need your tenant's values (site, workbook, scripts). They are tenant IDs I cannot know. If the import fails, use BUILD-GUIDE.md Part 3 to build the same flow by hand (about 20 minutes).

## Before importing (10 min)
1. Create the SharePoint folders `Dashboards-Inbox` and `Dashboards`, and upload `../Live-Dashboard.xlsx` to `Dashboards` (BUILD-GUIDE.md Part 1).
2. Add the two Office Scripts (BUILD-GUIDE.md Part 2): `BuildDashboard` in `Live-Dashboard.xlsx`, `ReadWorkbookAsCsv` in `sample-sales.xlsx`.
3. Use the same environment as your agent. Check the name in the environment picker at the top right of Copilot Studio.

## Import (5 min)
1. Go to make.powerapps.com and pick that environment (top right).
2. Left menu: **Solutions**, then **Import solution**.
3. **Browse**, choose `LiveDashboardAgentTools_1_0_0_0.zip`, **Next**.
4. When asked for connections, pick or create a **SharePoint** and an **Excel Online (Business)** connection (sign in with your work account), **Next**, then **Import**.
5. Wait for the green "Solution imported" bar.

## Fix the 8 settings (10 min)
1. Open the solution **Live Dashboard Agent Tools**, open the flow **Build dashboard from folder** and click **Edit**.
2. Action **Init_SiteUrl**: change the value to your site, for example `https://contoso.sharepoint.com/sites/team`.
3. Action **Init_WorkbookPath**: confirm `/Shared Documents/Dashboards/Live-Dashboard.xlsx` (change if different).
4. In the loop, the **xlsx** case, action **Read_xlsx_as_csv** (Run script): re-pick Location, Document Library, File (any xlsx; the real file path is passed at run time) and Script = `ReadWorkbookAsCsv`.
5. In the **Check_has_data** Yes branch, action **Run_BuildDashboard** (Run script): pick Location, Document Library, File = `Live-Dashboard.xlsx`, Script = `BuildDashboard`. If the two inputs `csvText` and `fileName` are blank after you pick the script, enter: csvText = variable `csvText`, fileName = `Name` from the current item.
6. If any action shows a red error, open it and re-select the dropdowns. That is normal after an import.
7. Click **Save**, then turn the flow **On**.

## Add it to the agent (5 min)
New experience: your agent, **Build**, **Tools**, **Add a tool**, choose **Flow**, pick "Build dashboard from folder", then paste `../agent/agent-instructions.txt` into Instructions (or upload `../skill/live-dashboard/SKILL.md` under Skills). Publish.

Legacy: your agent, **Tools** tab, **Add a tool**, pick the flow, paste the instructions into Overview, Instructions. Save, Publish.

If the flow does not appear in the tool list, the trigger type may not match your tenant. Open the flow, delete the first trigger, add **When an agent calls the flow** (or "Run a flow from Copilot"), recreate the text input `FolderPath`, and fix any actions that lost their inputs.

## Test
Same as BUILD-GUIDE.md Part 6: "Build a dashboard from Shared Documents/Dashboards-Inbox". Pass if the reply lists the files with 7 rows and a working link.

## Rebuild the zip
`python3 build_solution.py` regenerates the zip from the script.

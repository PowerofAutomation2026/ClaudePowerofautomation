# Legacy Copilot Studio: build and test

The legacy experience has no Skills upload. This agent uses the same rules as the skill, pasted into Instructions.

You still need Copilot Credits in your environment. Without them every chat fails with `EnforcementUsageCredits`.

## Build
1. Open copilotstudio.microsoft.com and your agent (or Create, New agent).
2. Make sure **Generative AI** is on: Settings, Generative AI, choose **Generative** orchestration. Save.
3. Overview tab, **Instructions** box.
4. Open `legacy/legacy-instructions.txt`, copy all, paste, **Save**.
5. Knowledge: optional. Upload `sample-sales.csv` if you want the agent to answer questions about it.
6. Optional trigger: Overview, Triggers, Add trigger, "When a file is created (SharePoint)", pick the `Dashboards-Inbox` folder.
7. **Publish**.

## Test (Test your agent panel, New chat)
| # | You type | Pass if |
|---|---|---|
| 1 | hello | Normal reply, no credit error |
| 2 | (empty) Summarize this file | Asks for data |
| 3 | Summarize this file + contents of sample-sales.csv | Rows 7, Units 67, Revenue 2090, Top North 1040, 3 insights |
| 4 | Summarize this file + contents of sample-bad.csv | Warnings for "eight", "n/a", blank Region; no invented totals |
| 5 | Summarize this file + only the header line `Date,Region,Units,Revenue` | Says file is empty |

If test 3 fails, copy the reply and the instructions you pasted, and compare with the expected format.

## Known limits of legacy
- The legacy chat cannot open an uploaded CSV by itself unless it is in Knowledge or passed through a flow. Pasting text is the reliable test.
- Dashboard link is a manual step (open `dashboard.html`, choose the file).
- This is untested in a real tenant. Menu names may differ.

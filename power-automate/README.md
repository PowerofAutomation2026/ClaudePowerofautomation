# Copy SharePoint Folder Structure (Power Automate)

Manual-trigger flow that recreates every folder (any depth) of a source library in a destination library on another site, then sets a **Copied = Yes** flag on each source folder.

## Import
1. make.powerapps.com → pick a Dataverse-enabled environment → **Solutions → Import solution**.
2. Upload `FolderStructureCopy_1_0_0_0.zip`, map the **SharePoint** connection reference to your connection, Import.
3. Open the flow → **Turn on** → **Run** and fill in the inputs.

## Inputs
| Input | Example |
|---|---|
| Source site URL | https://contoso.sharepoint.com/sites/Source |
| Source library | Documents (the library *title*, not the URL name) |
| Destination site URL | https://contoso.sharepoint.com/sites/Target |
| Destination library | Documents |
| Skip already flagged folders | Yes = only copy folders not yet flagged |

## How it works
1. Reads the root URL of both libraries.
2. Creates a Yes/No column `Copied` on the source library if missing.
3. Gets all folders (`FSObjType eq 1`, up to 5000), optionally drops already-flagged ones.
4. Sorts by depth so parents are created before children.
5. For each: builds destination path = dest root + relative path, creates the folder, sets `Copied = Yes`.

Re-runnable: folder creation is idempotent and flagged folders are skipped.

## Limits
- Folders only (no files). More than 5000 folders needs paging.
- Very large libraries may hit the list view threshold on the `FSObjType` filter.
- `flow_definition.json` is the bare definition; `build_package.py` regenerates the zip.

"""Builds LiveDashboardAgentTools_1_0_0_0.zip (a Power Platform solution with one cloud flow).
Run: python3 build_solution.py
"""
import json, uuid, zipfile, xml.dom.minidom as md

WF_ID = "7d0b6f0e-3c1a-4f0e-9a52-5b8d1c7e2a11"
FLOW_NAME = "Build dashboard from folder"
FILE_NAME = f"BuildDashboardFromFolder-{WF_ID.upper()}.json"
SP = "shared_sharepointonline"
XL = "shared_excelonlinebusiness"

def sp_action(op, params, run_after=None):
    a = {"type": "OpenApiConnection",
         "inputs": {"host": {"connectionName": SP, "operationId": op, "apiId": "/providers/Microsoft.PowerApps/apis/shared_sharepointonline"},
                    "parameters": params, "authentication": "@parameters('$authentication')"}}
    if run_after: a["runAfter"] = run_after
    return a

def var(name, typ, value, run_after=None):
    a = {"type": "InitializeVariable", "inputs": {"variables": [{"name": name, "type": typ, "value": value}]}}
    a["runAfter"] = run_after or {}
    return a

csv_expr = "@base64ToString(outputs('Get_file_content')?['body/$content'])"
ext_expr = "@toLower(last(split(items('Apply_to_each')?['Name'], '.')))"

excel_run = lambda script_label, params: {
    "type": "OpenApiConnection",
    "inputs": {"host": {"connectionName": XL, "operationId": "RunScriptProd",
                        "apiId": "/providers/Microsoft.PowerApps/apis/shared_excelonlinebusiness"},
               "parameters": params, "authentication": "@parameters('$authentication')"},
    "metadata": {"note": "RE-POINT: choose the file and the script %s in the designer after import." % script_label},
}

loop_actions = {
    "Reset_csvText": {"type": "SetVariable", "inputs": {"name": "csvText", "value": ""}, "runAfter": {}},
    "Get_file_content": sp_action("GetFileContentByPath", {
        "dataset": "@variables('SiteUrl')", "path": "@items('Apply_to_each')?['Path']", "inferContentType": True},
        {"Reset_csvText": ["Succeeded"]}),
    "Switch_on_file_type": {
        "type": "Switch", "expression": ext_expr, "runAfter": {"Get_file_content": ["Succeeded"]},
        "cases": {
            "csv": {"case": "csv", "actions": {"Set_csvText_from_csv": {"type": "SetVariable", "inputs": {"name": "csvText", "value": csv_expr}}}},
            "xlsx": {"case": "xlsx", "actions": {
                "Read_xlsx_as_csv": excel_run("ReadWorkbookAsCsv", {
                    "source": "RE-POINT", "drive": "RE-POINT", "file": "@items('Apply_to_each')?['Path']", "scriptId": "RE-POINT"}),
                "Set_csvText_from_xlsx": {"type": "SetVariable", "runAfter": {"Read_xlsx_as_csv": ["Succeeded"]},
                                          "inputs": {"name": "csvText", "value": "@{outputs('Read_xlsx_as_csv')?['body/result']}"}}}},
            "pdf": {"case": "pdf", "actions": {"Note_pdf": {"type": "Compose", "inputs":
                    "PDF: add the AI Builder 'Extract information from documents' action here, turn the table into CSV, then set csvText. See BUILD-GUIDE.md Part 3."}}},
        },
        "default": {"actions": {}}},
    "Check_has_data": {
        "type": "If", "runAfter": {"Switch_on_file_type": ["Succeeded"]},
        "expression": {"not": {"equals": ["@variables('csvText')", ""]}},
        "actions": {
            "Run_BuildDashboard": {**excel_run("BuildDashboard", {
                "source": "RE-POINT", "drive": "RE-POINT", "file": "@variables('WorkbookPath')", "scriptId": "RE-POINT",
                "ScriptParameters/csvText": "@variables('csvText')",
                "ScriptParameters/fileName": "@items('Apply_to_each')?['Name']"})},
            "Add_result": {"type": "AppendToArrayVariable", "runAfter": {"Run_BuildDashboard": ["Succeeded"]},
                           "inputs": {"name": "results", "value": "@concat(items('Apply_to_each')?['Name'], ': ', outputs('Run_BuildDashboard')?['body/result'])"}},
        },
        "else": {"actions": {"Add_skipped": {"type": "AppendToArrayVariable", "inputs": {
            "name": "results", "value": "@concat(items('Apply_to_each')?['Name'], ': unsupported file type or empty')"}}}},
    },
}

actions = {
    "Init_SiteUrl": var("SiteUrl", "string", "https://YOURTENANT.sharepoint.com/sites/YOURSITE"),
    "Init_WorkbookPath": var("WorkbookPath", "string", "/Shared Documents/Dashboards/Live-Dashboard.xlsx", {"Init_SiteUrl": ["Succeeded"]}),
    "Init_results": var("results", "array", [], {"Init_WorkbookPath": ["Succeeded"]}),
    "Init_csvText": var("csvText", "string", "", {"Init_results": ["Succeeded"]}),
    "List_folder": sp_action("ListFolder", {"dataset": "@variables('SiteUrl')", "id": "@triggerBody()?['text']"},
                             {"Init_csvText": ["Succeeded"]}),
    "Apply_to_each": {
        "type": "Foreach", "foreach": "@body('List_folder')", "runAfter": {"List_folder": ["Succeeded"]},
        "actions": loop_actions, "runtimeConfiguration": {"concurrency": {"repetitions": 1}}},
    "Get_workbook_link": sp_action("GetFileMetadataByPath", {"dataset": "@variables('SiteUrl')", "path": "@variables('WorkbookPath')"},
                                   {"Apply_to_each": ["Succeeded", "Failed", "TimedOut"]}),
    "Respond_to_the_agent": {
        "type": "Response", "kind": "Skills", "runAfter": {"Get_workbook_link": ["Succeeded"]},
        "inputs": {"statusCode": 200,
                   "body": {"message": "@{join(variables('results'), ' || ')}", "dashboardlink": "@{outputs('Get_workbook_link')?['body/{Link}']}"},
                   "schema": {"type": "object", "properties": {
                       "message": {"title": "message", "x-ms-dynamically-added": True, "type": "string"},
                       "dashboardlink": {"title": "dashboardlink", "x-ms-dynamically-added": True, "type": "string"}}}}},
}

workflow = {
    "properties": {
        "connectionReferences": {
            SP: {"runtimeSource": "embedded", "connection": {"connectionReferenceLogicalName": "ldb_sharepointonline"},
                 "api": {"name": "shared_sharepointonline"}},
            XL: {"runtimeSource": "embedded", "connection": {"connectionReferenceLogicalName": "ldb_excelonlinebusiness"},
                 "api": {"name": "shared_excelonlinebusiness"}}},
        "definition": {
            "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
            "contentVersion": "1.0.0.0",
            "parameters": {"$connections": {"defaultValue": {}, "type": "Object"},
                           "$authentication": {"defaultValue": {}, "type": "SecureObject"}},
            "triggers": {"manual": {"type": "Request", "kind": "Skills", "inputs": {"schema": {
                "type": "object",
                "properties": {"text": {"title": "FolderPath", "type": "string", "x-ms-dynamically-added": True,
                                         "description": "SharePoint folder path, for example Shared Documents/Dashboards-Inbox",
                                         "x-ms-content-hint": "TEXT"}},
                "required": ["text"]}}}},
            "actions": actions},
        "templateName": None},
    "schemaVersion": "1.0.0.0"}

def pretty(x):
    return md.parseString(x).toprettyxml(indent="  ")

pub = """<Publisher><UniqueName>livedashboard</UniqueName>
<LocalizedNames><LocalizedName description="Live Dashboard" languagecode="1033" /></LocalizedNames><Descriptions />
<EMailAddress xsi:nil="true"></EMailAddress><SupportingWebsiteUrl xsi:nil="true"></SupportingWebsiteUrl>
<CustomizationPrefix>ldb</CustomizationPrefix><CustomizationOptionValuePrefix>72700</CustomizationOptionValuePrefix>
<Addresses><Address><AddressNumber>1</AddressNumber><AddressTypeCode>1</AddressTypeCode></Address></Addresses></Publisher>"""

solution_xml = f"""<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.0.0" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<SolutionManifest><UniqueName>LiveDashboardAgentTools</UniqueName>
<LocalizedNames><LocalizedName description="Live Dashboard Agent Tools" languagecode="1033" /></LocalizedNames><Descriptions />
<Version>1.0.0.0</Version><Managed>0</Managed>{pub}
<RootComponents><RootComponent type="29" id="{{{WF_ID}}}" behavior="0" /></RootComponents><MissingDependencies /></SolutionManifest>
</ImportExportXml>"""

def connref(logical, display, api):
    return (f'<connectionreference connectionreferencelogicalname="{logical}"><connectionreferencedisplayname>{display}</connectionreferencedisplayname>'
            f'<connectorid>/providers/Microsoft.PowerApps/apis/{api}</connectorid><iscustomizable>1</iscustomizable>'
            f'<promptingbehavior>0</promptingbehavior><statecode>0</statecode><statuscode>1</statuscode></connectionreference>')

customizations_xml = f"""<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Entities></Entities><Roles></Roles><Workflows>
<Workflow WorkflowId="{{{WF_ID}}}" Name="{FLOW_NAME}"><JsonFileName>/Workflows/{FILE_NAME}</JsonFileName>
<Type>1</Type><Subprocess>0</Subprocess><Category>5</Category><Mode>0</Mode><Scope>4</Scope><OnDemand>0</OnDemand>
<TriggerOnCreate>0</TriggerOnCreate><TriggerOnDelete>0</TriggerOnDelete><AsyncAutodelete>0</AsyncAutodelete>
<SyncWorkflowLogOnFailure>0</SyncWorkflowLogOnFailure><StateCode>0</StateCode><StatusCode>1</StatusCode><RunAs>1</RunAs>
<IsTransacted>1</IsTransacted><IntroducedVersion>1.0</IntroducedVersion><IsCustomizable>1</IsCustomizable>
<BusinessProcessType>0</BusinessProcessType><IsCustomProcessingStepAllowedForOtherPublishers>1</IsCustomProcessingStepAllowedForOtherPublishers>
<PrimaryEntity>none</PrimaryEntity><LocalizedNames><LocalizedName languagecode="1033" description="{FLOW_NAME}" /></LocalizedNames>
</Workflow></Workflows><FieldSecurityProfiles></FieldSecurityProfiles><Templates /><EntityMaps /><EntityRelationships />
<OrganizationSettings /><optionsets /><CustomControls /><EntityDataProviders />
<connectionreferences>{connref("ldb_sharepointonline","SharePoint","shared_sharepointonline")}{connref("ldb_excelonlinebusiness","Excel Online (Business)","shared_excelonlinebusiness")}</connectionreferences>
<Languages><Language>1033</Language></Languages></ImportExportXml>"""

content_types = ('<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                 '<Default Extension="xml" ContentType="application/octet-stream" /><Default Extension="json" ContentType="application/octet-stream" /></Types>')

for name, xml in (("solution.xml", solution_xml), ("customizations.xml", customizations_xml), ("[Content_Types].xml", content_types)):
    md.parseString(xml)  # must be well-formed
json.loads(json.dumps(workflow))

out = "LiveDashboardAgentTools_1_0_0_0.zip"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("solution.xml", solution_xml)
    z.writestr("customizations.xml", customizations_xml)
    z.writestr("Workflows/" + FILE_NAME, json.dumps(workflow, indent=2))
print("wrote", out)

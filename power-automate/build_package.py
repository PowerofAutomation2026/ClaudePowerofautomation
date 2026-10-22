"""Builds FolderStructureCopy_1_0_0_0.zip (Power Automate solution package)."""
import json, zipfile, os

WF_ID = "5b0c7d3e-91a4-4f6e-8c21-3d7a9e4b1f60"
CR = "paf_sharedsharepointonline_7c2e1"
NAME = "Copy SharePoint Folder Structure"
HERE = os.path.dirname(os.path.abspath(__file__))

HOST = {"connectionName": "shared_sharepointonline", "operationId": "HttpRequest",
        "apiId": "/providers/Microsoft.PowerApps/apis/shared_sharepointonline"}
JSON_H = {"Accept": "application/json;odata=nometadata",
          "Content-Type": "application/json;odata=nometadata"}

def http(site, method, uri, run_after, headers=None, body=None):
    p = {"dataset": site, "parameters/method": method, "parameters/uri": uri,
         "parameters/headers": headers or {"Accept": "application/json;odata=nometadata"}}
    if body is not None:
        p["parameters/body"] = body
    return {"type": "OpenApiConnection",
            "inputs": {"host": HOST, "parameters": p, "authentication": "@parameters('$authentication')"},
            "runAfter": run_after}

def var(name, vtype, value, after):
    return {"type": "InitializeVariable",
            "inputs": {"variables": [{"name": name, "type": vtype, "value": value}]},
            "runAfter": {after: ["Succeeded"]} if after else {}}

OK = ["Succeeded"]
lib_src = "@{encodeUriComponent(variables('SrcLib'))}"
lib_dst = "@{encodeUriComponent(variables('DestLib'))}"

actions = {
 "Init_SrcSite": var("SrcSite", "string", "@triggerBody()?['text']", None),
 "Init_SrcLib": var("SrcLib", "string", "@triggerBody()?['text_1']", "Init_SrcSite"),
 "Init_DestSite": var("DestSite", "string", "@triggerBody()?['text_2']", "Init_SrcLib"),
 "Init_DestLib": var("DestLib", "string", "@triggerBody()?['text_3']", "Init_DestSite"),
 "Init_SkipFlagged": var("SkipFlagged", "boolean", "@coalesce(triggerBody()?['boolean'], true)", "Init_DestLib"),
 "Init_FlagColumn": var("FlagColumn", "string", "Copied", "Init_SkipFlagged"),
 "Init_CopiedCount": var("CopiedCount", "integer", 0, "Init_FlagColumn"),

 "Get_Source_Root": http("@variables('SrcSite')", "GET",
    f"/_api/web/lists/getbytitle('{lib_src}')/RootFolder?$select=ServerRelativeUrl",
    {"Init_CopiedCount": OK}),
 "Get_Dest_Root": http("@variables('DestSite')", "GET",
    f"/_api/web/lists/getbytitle('{lib_dst}')/RootFolder?$select=ServerRelativeUrl",
    {"Get_Source_Root": OK}),

 "Get_Flag_Field": http("@variables('SrcSite')", "GET",
    f"/_api/web/lists/getbytitle('{lib_src}')/fields?$filter=InternalName%20eq%20'@{{variables('FlagColumn')}}'&$select=InternalName",
    {"Get_Dest_Root": OK}),
 "Create_Flag_Column_If_Missing": {
    "type": "If",
    "expression": {"equals": ["@length(body('Get_Flag_Field')?['value'])", 0]},
    "actions": {"Create_Flag_Column": http("@variables('SrcSite')", "POST",
        f"/_api/web/lists/getbytitle('{lib_src}')/fields", {}, JSON_H,
        "{\"FieldTypeKind\":8,\"Title\":\"@{variables('FlagColumn')}\",\"DefaultValue\":\"0\"}")},
    "else": {"actions": {}},
    "runAfter": {"Get_Flag_Field": OK}},

 "Get_Source_Folders": http("@variables('SrcSite')", "GET",
    f"/_api/web/lists/getbytitle('{lib_src}')/items?$select=Id,FileRef,@{{variables('FlagColumn')}}&$filter=FSObjType%20eq%201&$top=5000",
    {"Create_Flag_Column_If_Missing": OK}),
 "Filter_Folders": {
    "type": "Query",
    "inputs": {"from": "@body('Get_Source_Folders')?['value']",
               "where": "@or(not(equals(variables('SkipFlagged'), true)), not(equals(item()?[variables('FlagColumn')], true)))"},
    "runAfter": {"Get_Source_Folders": OK}},
 # key = depth|path|id  -> sorting guarantees parents are created before children
 "Select_Keys": {
    "type": "Select",
    "inputs": {"from": "@body('Filter_Folders')",
               "select": "@concat(formatNumber(length(split(item()?['FileRef'],'/')),'000'),'|',item()?['FileRef'],'|',string(item()?['Id']))"},
    "runAfter": {"Filter_Folders": OK}},
 "Sort_Keys": {"type": "Compose", "inputs": "@sort(body('Select_Keys'))", "runAfter": {"Select_Keys": OK}},

 "Apply_to_each_folder": {
    "type": "Foreach",
    "foreach": "@outputs('Sort_Keys')",
    "runtimeConfiguration": {"concurrency": {"repetitions": 1}},
    "actions": {
      "Parts": {"type": "Compose", "inputs": "@split(items('Apply_to_each_folder'),'|')", "runAfter": {}},
      "Relative_Path": {"type": "Compose",
        "inputs": "@substring(outputs('Parts')[1], length(body('Get_Source_Root')?['ServerRelativeUrl']))",
        "runAfter": {"Parts": OK}},
      "Dest_Path": {"type": "Compose",
        "inputs": "@concat(body('Get_Dest_Root')?['ServerRelativeUrl'], outputs('Relative_Path'))",
        "runAfter": {"Relative_Path": OK}},
      "Create_Folder_In_Destination": http("@variables('DestSite')", "POST", "/_api/web/folders",
        {"Dest_Path": OK}, JSON_H, "{\"ServerRelativeUrl\":\"@{outputs('Dest_Path')}\"}"),
      "Flag_Source_Folder": http("@variables('SrcSite')", "POST",
        f"/_api/web/lists/getbytitle('{lib_src}')/items(@{{outputs('Parts')[2]}})",
        {"Create_Folder_In_Destination": OK},
        dict(JSON_H, **{"X-HTTP-Method": "MERGE", "IF-MATCH": "*"}),
        "{\"@{variables('FlagColumn')}\":true}"),
      "Increment_CopiedCount": {"type": "IncrementVariable",
        "inputs": {"name": "CopiedCount", "value": 1},
        "runAfter": {"Flag_Source_Folder": OK}},
    },
    "runAfter": {"Sort_Keys": OK}},

 "Summary": {"type": "Compose",
    "inputs": "@concat('Copied and flagged ', variables('CopiedCount'), ' folder(s) from ', variables('SrcSite'), ' to ', variables('DestSite'))",
    "runAfter": {"Apply_to_each_folder": OK}},
}

def txt(title, desc):
    return {"title": title, "type": "string", "x-ms-dynamically-added": True,
            "description": desc, "x-ms-content-hint": "TEXT"}

definition = {
  "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {"$connections": {"defaultValue": {}, "type": "Object"},
                 "$authentication": {"defaultValue": {}, "type": "SecureObject"}},
  "triggers": {"manual": {"type": "Request", "kind": "Button", "inputs": {"schema": {
      "type": "object",
      "properties": {
        "text": txt("Source site URL", "e.g. https://contoso.sharepoint.com/sites/Source"),
        "text_1": txt("Source library", "Library display title, e.g. Documents"),
        "text_2": txt("Destination site URL", "e.g. https://contoso.sharepoint.com/sites/Target"),
        "text_3": txt("Destination library", "Library display title, e.g. Documents"),
        "boolean": {"title": "Skip already flagged folders", "type": "boolean",
                    "x-ms-dynamically-added": True, "description": "Yes = only copy folders not yet flagged",
                    "x-ms-content-hint": "BOOLEAN"}},
      "required": ["text", "text_1", "text_2", "text_3"]}}}},
  "actions": actions,
}

wf = {"properties": {
        "connectionReferences": {"shared_sharepointonline": {
            "runtimeSource": "embedded",
            "connection": {"connectionReferenceLogicalName": CR},
            "api": {"name": "shared_sharepointonline"}}},
        "definition": definition},
      "schemaVersion": "1.0.0.0"}

content_types = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/octet-stream" /><Default Extension="json" ContentType="application/octet-stream" /></Types>'

solution = f'''<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.0.0" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>FolderStructureCopy</UniqueName>
    <LocalizedNames><LocalizedName description="Folder Structure Copy" languagecode="1033" /></LocalizedNames>
    <Descriptions />
    <Version>1.0.0.0</Version>
    <Managed>0</Managed>
    <Publisher>
      <UniqueName>PowerOfAutomation</UniqueName>
      <LocalizedNames><LocalizedName description="Power of Automation" languagecode="1033" /></LocalizedNames>
      <Descriptions />
      <EMailAddress xsi:nil="true"></EMailAddress>
      <SupportingWebsiteUrl xsi:nil="true"></SupportingWebsiteUrl>
      <CustomizationPrefix>paf</CustomizationPrefix>
      <CustomizationOptionValuePrefix>12345</CustomizationOptionValuePrefix>
      <Addresses />
    </Publisher>
    <RootComponents><RootComponent type="29" id="{{{WF_ID}}}" behavior="0" /></RootComponents>
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>'''

jf = f"Workflows/CopySharePointFolderStructure-{WF_ID.upper()}.json"
custom = f'''<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entities></Entities>
  <Roles></Roles>
  <Workflows>
    <Workflow WorkflowId="{{{WF_ID}}}" Name="{NAME}">
      <JsonFileName>/{jf}</JsonFileName>
      <Type>1</Type><Subprocess>0</Subprocess><Category>5</Category><Mode>0</Mode><Scope>4</Scope>
      <OnDemand>0</OnDemand><TriggerOnCreate>0</TriggerOnCreate><TriggerOnDelete>0</TriggerOnDelete>
      <AsyncAutodelete>0</AsyncAutodelete><SyncWorkflowLogOnFailure>0</SyncWorkflowLogOnFailure>
      <StateCode>0</StateCode><StatusCode>1</StatusCode><RunAs>1</RunAs><IsTransacted>1</IsTransacted>
      <IntroducedVersion>1.0</IntroducedVersion><IsCustomizable>1</IsCustomizable>
      <BusinessProcessType>0</BusinessProcessType>
      <IsCustomProcessingStepAllowedForOtherPublishers>1</IsCustomProcessingStepAllowedForOtherPublishers>
      <PrimaryEntity>none</PrimaryEntity>
      <LocalizedNames><LocalizedName languagecode="1033" description="{NAME}" /></LocalizedNames>
    </Workflow>
  </Workflows>
  <connectionreferences>
    <connectionreference connectionreferencelogicalname="{CR}">
      <connectionreferencedisplayname>SharePoint</connectionreferencedisplayname>
      <connectorid>/providers/Microsoft.PowerApps/apis/shared_sharepointonline</connectorid>
      <iscustomizable>1</iscustomizable>
      <promptingbehavior>0</promptingbehavior>
      <statecode>0</statecode><statuscode>1</statuscode>
    </connectionreference>
  </connectionreferences>
  <Languages><Language>1033</Language></Languages>
</ImportExportXml>'''

out = os.path.join(HERE, "FolderStructureCopy_1_0_0_0.zip")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("solution.xml", solution)
    z.writestr("customizations.xml", custom)
    z.writestr(jf, json.dumps(wf, indent=2))
with open(os.path.join(HERE, "flow_definition.json"), "w") as f:
    json.dump(definition, f, indent=2)
print("wrote", out)

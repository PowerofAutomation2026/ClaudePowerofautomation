// Office Script: ReadWorkbookAsCsv
// Run it on a SOURCE .xlsx file from Power Automate "Run script".
// Returns the first worksheet's used range as CSV text.
// The text is then passed to BuildDashboard.

function main(workbook: ExcelScript.Workbook): string {
  const sheet = workbook.getWorksheets()[0];
  if (!sheet) { return ""; }
  const values = sheet.getUsedRange().getTexts();
  return values.map(row =>
    row.map(cell => {
      const s = String(cell === null || cell === undefined ? "" : cell);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(",")
  ).join("\n");
}

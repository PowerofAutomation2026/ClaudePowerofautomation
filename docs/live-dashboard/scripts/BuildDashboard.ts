// Office Script: BuildDashboard
// Run it on Live-Dashboard.xlsx from a Power Automate "Run script" action.
// Inputs:  csvText  = the whole file as CSV text
//          fileName = original file name (for example sales.csv)
// Output:  a short status message for the agent
// For each file it creates two sheets: "<name> Data" and "<name> Dash",
// and one row on the "Files" sheet. Running it again replaces them.

function main(workbook: ExcelScript.Workbook, csvText: string, fileName: string): string {
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return "ERROR: the file is empty or has only a header row.";
  }

  const header = rows[0].map((h, i) => (h.trim() === "" ? "Column" + (i + 1) : h.trim()));
  const body = rows.slice(1).map(r => header.map((_, i) => (r[i] === undefined ? "" : r[i].trim())));
  const nRows = body.length;
  const nCols = header.length;

  // Decide each column type: number, date (YYYY-MM-DD) or text.
  const types: string[] = [];
  const warnings: string[] = [];
  for (let c = 0; c < nCols; c++) {
    const vals = body.map(r => r[c]);
    const filled = vals.filter(v => v !== "");
    const numCount = filled.filter(isNumber).length;
    const dateCount = filled.filter(isDate).length;
    let type = "text";
    if (filled.length > 0 && numCount === filled.length) {
      type = "number";
    } else if (filled.length > 0 && dateCount === filled.length) {
      type = "date";
    } else if (filled.length > 0 && numCount / filled.length >= 0.6) {
      // Mostly numbers with some bad cells: treat as number and warn.
      type = "number";
      vals.forEach((v, i) => {
        if (v !== "" && !isNumber(v)) {
          warnings.push(header[c] + " row " + (i + 2) + ': "' + v + '" is not a number (ignored in totals)');
        }
      });
    }
    types.push(type);
    const blanks = vals.length - filled.length;
    if (blanks > 0) {
      warnings.push(header[c] + ": " + blanks + " blank cell(s)");
    }
  }

  const base = cleanName(fileName).substring(0, 24);
  const dataName = base + " Data";
  const dashName = base + " Dash";
  deleteSheet(workbook, dataName);
  deleteSheet(workbook, dashName);

  // ---- Data sheet ----
  const data = workbook.addWorksheet(dataName);
  const values: (string | number)[][] = [header];
  body.forEach(r => {
    values.push(r.map((v, c) => (types[c] === "number" && isNumber(v) ? toNum(v) : v)));
  });
  types.forEach((t, c) => {
    if (t === "date") { data.getRangeByIndexes(0, c, values.length, 1).setNumberFormat("@"); }
  });
  data.getRangeByIndexes(0, 0, values.length, nCols).setValues(values);
  const table = data.addTable(data.getRangeByIndexes(0, 0, values.length, nCols), true);
  table.setName(tableName(base));
  data.getUsedRange().getFormat().autofitColumns();

  // ---- Dash sheet ----
  const dash = workbook.addWorksheet(dashName);
  dash.getRange("A1").setValue("Dashboard: " + fileName);
  dash.getRange("A1").getFormat().getFont().setBold(true);
  dash.getRange("A1").getFormat().getFont().setSize(16);
  dash.getRange("A2").setValue("Updated " + new Date().toISOString().substring(0, 16).replace("T", " ") + " UTC");

  const q = "'" + dataName + "'!";
  const lastRow = nRows + 1;
  const colLetter = (i: number) => letter(i);

  // KPI block: row count and total/average of up to 4 number columns.
  dash.getRange("A4").setValue("Rows");
  dash.getRange("A5").setFormula("=COUNTA(" + q + "A2:A" + lastRow + ")+COUNTBLANK(" + q + "A2:A" + lastRow + ")");
  let kpiCol = 1;
  const numberCols: number[] = [];
  types.forEach((t, c) => { if (t === "number") numberCols.push(c); });
  numberCols.slice(0, 4).forEach(c => {
    const rng = q + colLetter(c) + "2:" + colLetter(c) + lastRow;
    dash.getRangeByIndexes(3, kpiCol, 1, 1).setValue(header[c] + " total");
    dash.getRangeByIndexes(4, kpiCol, 1, 1).setFormula("=SUM(" + rng + ")");
    dash.getRangeByIndexes(3, kpiCol + 1, 1, 1).setValue(header[c] + " average");
    dash.getRangeByIndexes(4, kpiCol + 1, 1, 1).setFormula("=IFERROR(AVERAGE(" + rng + "),0)");
    kpiCol += 2;
  });
  dash.getRangeByIndexes(3, 0, 1, kpiCol).getFormat().getFont().setBold(true);

  const measure = numberCols.length > 0 ? numberCols[0] : -1;
  let nextRow = 7; // 0-based row index where the next block starts
  let status = "OK";

  // Category chart: first low-cardinality text column.
  let catCol = -1;
  for (let c = 0; c < nCols; c++) {
    if (types[c] !== "text") continue;
    const distinct = unique(body.map(r => r[c]).filter(v => v !== ""));
    if (distinct.length >= 2 && distinct.length <= 12) { catCol = c; break; }
  }
  if (measure >= 0 && catCol >= 0) {
    const cats = unique(body.map(r => r[catCol]).filter(v => v !== ""));
    dash.getRangeByIndexes(nextRow, 0, 1, 2).setValues([[header[catCol], header[measure] + " total"]]);
    cats.forEach((cat, i) => {
      dash.getRangeByIndexes(nextRow + 1 + i, 0, 1, 1).setValue(cat);
      dash.getRangeByIndexes(nextRow + 1 + i, 1, 1, 1).setFormula(
        "=SUMIF(" + q + colLetter(catCol) + "2:" + colLetter(catCol) + lastRow + ",A" + (nextRow + 2 + i) +
        "," + q + colLetter(measure) + "2:" + colLetter(measure) + lastRow + ")");
    });
    const src = dash.getRangeByIndexes(nextRow, 0, cats.length + 1, 2);
    const chart = dash.addChart(ExcelScript.ChartType.columnClustered, src);
    chart.getTitle().setText(header[measure] + " by " + header[catCol]);
    chart.setPosition("E7", "L22");
    nextRow += cats.length + 3;
  }

  // Date chart: first date column.
  const dateCol = types.indexOf("date");
  if (measure >= 0 && dateCol >= 0) {
    const days = unique(body.map(r => r[dateCol]).filter(v => v !== "").map(v => v.substring(0, 10))).sort();
    dash.getRangeByIndexes(nextRow, 0, days.length + 1, 1).setNumberFormat("@");
    dash.getRangeByIndexes(nextRow, 0, 1, 2).setValues([[header[dateCol], header[measure] + " total"]]);
    days.forEach((d, i) => {
      dash.getRangeByIndexes(nextRow + 1 + i, 0, 1, 1).setValue(d);
      dash.getRangeByIndexes(nextRow + 1 + i, 1, 1, 1).setFormula(
        "=SUMIF(" + q + colLetter(dateCol) + "2:" + colLetter(dateCol) + lastRow + ",A" + (nextRow + 2 + i) + '&"*",' +
        q + colLetter(measure) + "2:" + colLetter(measure) + lastRow + ")");
    });
    const src2 = dash.getRangeByIndexes(nextRow, 0, days.length + 1, 2);
    const chart2 = dash.addChart(ExcelScript.ChartType.line, src2);
    chart2.getTitle().setText(header[measure] + " over " + header[dateCol]);
    chart2.setPosition("E24", "L39");
    nextRow += days.length + 3;
  }

  if (warnings.length > 0) {
    dash.getRangeByIndexes(nextRow, 0, 1, 1).setValue("Data warnings");
    dash.getRangeByIndexes(nextRow, 0, 1, 1).getFormat().getFont().setBold(true);
    warnings.slice(0, 30).forEach((w, i) => {
      dash.getRangeByIndexes(nextRow + 1 + i, 0, 1, 1).setValue(w);
    });
    status = "OK with " + warnings.length + " warning(s)";
  }
  dash.getRange("A:A").getFormat().setColumnWidth(150);
  dash.activate();

  // ---- Files index ----
  let files = workbook.getWorksheet("Files");
  if (!files) {
    files = workbook.addWorksheet("Files");
    files.getRange("A1:E1").setValues([["File", "Rows", "Columns", "Updated (UTC)", "Dashboard sheet"]]);
    files.getRange("A1:E1").getFormat().getFont().setBold(true);
  }
  const used = files.getUsedRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < used.length; i++) {
    if (String(used[i][0]) === fileName) { rowIndex = i; break; }
  }
  if (rowIndex < 0) { rowIndex = used.length; }
  files.getRangeByIndexes(rowIndex, 0, 1, 5).setValues([[
    fileName, nRows, nCols, new Date().toISOString().substring(0, 16).replace("T", " "), dashName]]);

  return status + ": " + fileName + " | rows " + nRows + " | columns " + nCols + " | sheet '" + dashName + "'" +
    (warnings.length > 0 ? " | warnings: " + warnings.slice(0, 5).join("; ") : "");
}

// ---------- helpers ----------

function parseCsv(text: string): string[][] {
  const t = text.charCodeAt(0) === 0xfeff ? text.substring(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQuotes) {
      if (ch === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") { i++; }
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ""));
}

function toNum(v: string): number {
  return Number(v.replace(/[$\u20AC\u00A3,%\s]/g, ""));
}

function isNumber(v: string): boolean {
  const t = v.replace(/[$\u20AC\u00A3,%\s]/g, "");
  return t !== "" && /^-?\d*\.?\d+$/.test(t);
}

function isDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
}

function unique(arr: string[]): string[] {
  const seen: { [k: string]: boolean } = {};
  const out: string[] = [];
  arr.forEach(v => { if (!seen[v]) { seen[v] = true; out.push(v); } });
  return out;
}

function letter(i: number): string {
  let s = "";
  let n = i;
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}

function cleanName(fileName: string): string {
  const noExt = fileName.replace(/\.[^.]+$/, "");
  const cleaned = noExt.replace(/[\[\]:*?\/\\]/g, " ").trim();
  return cleaned === "" ? "File" : cleaned;
}

function tableName(base: string): string {
  const n = base.replace(/[^A-Za-z0-9_]/g, "_");
  return "T_" + n;
}

function deleteSheet(workbook: ExcelScript.Workbook, name: string): void {
  const s = workbook.getWorksheet(name);
  if (s) { s.delete(); }
}

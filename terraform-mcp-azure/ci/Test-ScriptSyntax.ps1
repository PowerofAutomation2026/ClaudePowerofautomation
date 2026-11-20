<# Parse-checks every .ps1 in a folder with the PowerShell parser. Exit code = number of files with errors. #>
param([Parameter(Mandatory)][string] $Path)
$bad = 0
Get-ChildItem -Path $Path -Filter *.ps1 | ForEach-Object {
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors)
  if ($errors.Count) {
    $bad++
    Write-Host "PARSE ERRORS in $($_.Name):"
    $errors | ForEach-Object { Write-Host "  line $($_.Extent.StartLineNumber): $($_.Message)" }
  } else { Write-Host "parse OK  $($_.Name)" }
}
exit $bad

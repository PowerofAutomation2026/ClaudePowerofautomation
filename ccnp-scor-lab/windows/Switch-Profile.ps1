# Start only the devices you need (RAM!).  Usage: Switch-Profile.ps1 -Profile network|ftd|nac|all
param([Parameter(Mandatory)][ValidateSet("network","ftdfdm","ftd","nac","all")][string]$Profile)
$api = "http://127.0.0.1:3080/v2"
function Api($m,$p,$b=$null){ $a=@{Uri="$api$p";Method=$m;ContentType="application/json"}; if($null -ne $b){$a.Body=($b|ConvertTo-Json)}; Invoke-RestMethod @a }
$sets = @{
  network = @("FW1-ASAv","R1","R2","SW1","Client","Outside-Desktop","DMZ-Server")
  ftdfdm  = @("R2","Outside-Desktop","DMZ-Server","FTD1","FTD-Client")
  ftd     = @("R2","Outside-Desktop","DMZ-Server","FTD1","FMC1","FTD-Client")
  nac     = @("R1","SW1","Client","DMZ-Server","ISE1")
  all     = @("FW1-ASAv","R1","R2","SW1","Client","Outside-Desktop","DMZ-Server","FTD1","FMC1","FTD-Client","ISE1") }
$p = (Api GET "/projects") | ? { $_.name -eq "SCOR-Core" }; if (-not $p) { throw "Run Build-Topology.ps1 first" }
Api POST "/projects/$($p.project_id)/open" @{} | Out-Null
foreach ($n in (Api GET "/projects/$($p.project_id)/nodes")) {
  $act = if ($sets[$Profile] -contains $n.name) { "start" } else { "stop" }
  try { Api POST "/projects/$($p.project_id)/nodes/$($n.node_id)/$act" @{} | Out-Null } catch {} }
Write-Host "Profile '$Profile' applied." -ForegroundColor Green

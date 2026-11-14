OUTAGE-WATCH  -  ZERO-TOUCH DEPLOYMENT PACKAGE (Windows)
=========================================================
Monitors Microsoft 365 and Copilot from the outside, warns early, and shows a live
blast-radius dashboard. Package version = build 925451d (113 unit tests pass; the installer runs them as a gate).

WHAT YOU NEED
  * Windows 10/11 or Windows Server 2016+ with PowerShell 5.1 (built in)
  * Python 3.9+ installed FOR ALL USERS  (the script can install it with -Yes if winget exists)
  * Administrator rights (the script asks Windows to elevate itself)
  * Outbound HTTPS from this machine to Microsoft 365 / Copilot hosts

DEPLOY IN ONE STEP
  1. Unzip this folder somewhere (for example C:\Temp\OutageWatch).
  2. Open Command Prompt or PowerShell in that folder and run:

       Deploy.cmd 00000000-0000-0000-0000-000000000000 -Yes

     Replace the GUID with your Power Platform environment ID (the part after
     /environments/ in the maker portal URL). Without -Yes it asks for the ID and
     before closing. Optional: -Tenant contoso (also probes SharePoint/OneDrive)
     and -Port 8080.
  3. Open http://127.0.0.1:8080/ on that machine. Done.

WHAT THE SCRIPT DOES (7 steps, each printed ok / warn / fail)
  1. Checks the ID strictly (GUID only), finds Python 3.9+
  2. Copies the app to C:\ProgramData\OutageWatch\<envId>\app, generates config and a
     random admin token (stored in outagewatch.env, never printed), runs the unit tests
     as a gate (a failure stops the deploy before anything starts), then does a live
     probe of 15 Microsoft 365 / Copilot endpoints and tells you what it saw
  3. Locks permissions (token file: SYSTEM, Administrators, and the service account only)
  4. Registers Scheduled Task OutageWatch-<first 8 chars> that starts at boot, restarts on
     failure and never times out; runs as LOCAL SERVICE (low privilege)
  5. Starts it and waits for the dashboard
  6. Smoke tests: /status.json, /metrics, and that the admin API REFUSES requests
     without the token
  7. Prints a summary

WHAT THE ENVIRONMENT ID DOES (honest version)
  outage-watch cannot run inside Power Platform. The ID names the deployment, task and
  folders, and adds one probe for that environment's maker portal page. Nothing is read
  from the environment.

SAFE BY DEFAULT
  Dashboard on 127.0.0.1 only. No firewall rule is opened. Admin test buttons stay off
  until you use the token. Re-running the script is an upgrade: tokens, config, data and
  the log are kept. -DryRun prints the plan and changes nothing.

OPTIONAL: ALERTS
  Add a line to  C:\ProgramData\OutageWatch\<envId>\outagewatch.env :
       OUTAGEWATCH_WEBHOOK=https://your-slack-or-teams-or-discord-webhook
  then:  schtasks /End /TN OutageWatch-<first8>   and   schtasks /Run /TN OutageWatch-<first8>
  Use a channel NOT hosted on Microsoft 365: it can fail in the same outage you are
  warning about. Note: the webhook URL is passed to the app as an argument, so other
  administrators of this machine can see it in the process list.

OPTIONAL: SEE THE DASHBOARD FROM ANOTHER PC
  Don't expose the port. Use Remote Desktop to this machine, or put an authenticating
  reverse proxy in front.

ADMIN MANUAL TEST
  Open the dashboard > Manual test (admin) > paste the token from outagewatch.env
  (open it as Administrator) > Run test now. Or from a terminal:
       python C:\ProgramData\OutageWatch\<envId>\app\outagewatch.py --test

UNINSTALL
       Uninstall.cmd <environment-id>            removes task + app, keeps config/data
       Uninstall.cmd <environment-id> -Purge     removes everything

TROUBLESHOOTING
  "Python is installed under a user profile"  -> install Python for all users, or add -RunAs System
  Port in use                                  -> add -Port 8090
  Probes show "blocked"                        -> your proxy/firewall refused them; allow the hosts
  Log of the deploy                            -> C:\ProgramData\OutageWatch\<envId>\deploy.log
  Task history                                 -> Task Scheduler > OutageWatch-<first8> > History

HONEST LIMITS
  * The installer logic (validation, config, tokens, test gate, launcher, upgrade, uninstall)
    is covered by automated tests that ran on Linux. The PowerShell script itself was NOT
    executed on Windows by its author; it passed static checks only. Use -DryRun first.
  * This build detects and displays; it has not yet seen a real Microsoft outage.
  * This build also contains newer modules (alert channels, maintenance windows, history
    database, Microsoft Service Health comparison, dashboard login, staff status page).
    They pass unit/mock tests only, were not checked live, and their setup is NOT yet
    documented in this package. The core deploy above does not depend on them.
  * The Microsoft Service Health comparison needs credentials and was only tested
    against a mock server.

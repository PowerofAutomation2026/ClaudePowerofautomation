# Supported commands (generated from the simulator)

Abbreviations work (`sh ip int br`), `?` shows help after any word, **Tab** completes, `| include|exclude|begin|section <text>` filters output, and `no <command>` negates where it makes sense. In config modes use `do show ...` to run show commands.
Commands not listed here are rejected like a real device would (`% Invalid input detected at '^' marker.`).

## IOS-style router (R1, R2)

| Mode | Command | What it does |
|---|---|---|
| user EXEC (and priv) | `enable` | Turn on privileged commands |
| privileged EXEC (#) | `disable` | Turn off privileged commands |
| user EXEC (and priv) | `show version` | System hardware and software status |
| user EXEC (and priv) | `show clock` | Display the system clock |
| user EXEC (and priv) | `show ip interface brief` | Brief summary of IP status and configuration |
| user EXEC (and priv) | `show interfaces` | Interface status and configuration |
| user EXEC (and priv) | `show interfaces <name ...>` | Interface status |
| user EXEC (and priv) | `show running-config` | Current operating configuration |
| user EXEC (and priv) | `show startup-config` | Contents of startup configuration |
| user EXEC (and priv) | `show arp` | ARP table |
| user EXEC (and priv) | `show ip arp` | IP ARP table |
| user EXEC (and priv) | `show cdp neighbors` | CDP neighbor entries |
| user EXEC (and priv) | `show users` | Display information about terminal lines |
| user EXEC (and priv) | `show history` | Display the session command history |
| user EXEC (and priv) | `show logging` | Show the contents of logging buffers |
| user EXEC (and priv) | `show flash` | Display information about flash |
| user EXEC (and priv) | `ping <ip>` | Send echo messages |
| user EXEC (and priv) | `traceroute <ip>` | Trace route to destination |
| user EXEC (and priv) | `terminal length <n>` | Set number of lines on a screen |
| user EXEC (and priv) | `terminal monitor` | Copy debug output to the current terminal |
| privileged EXEC (#) | `configure terminal` | Configure from the terminal |
| privileged EXEC (#) | `write memory` | Write to NV memory |
| privileged EXEC (#) | `write` | Write running configuration to memory |
| privileged EXEC (#) | `copy running-config startup-config` | Copy running config to startup |
| privileged EXEC (#) | `erase startup-config` | Erase the startup configuration |
| privileged EXEC (#) | `reload` | Halt and perform a cold restart |
| privileged EXEC (#) | `clear counters` | Clear counters |
| privileged EXEC (#) | `clear arp-cache` | Clear the entire ARP cache |
| global config | `hostname <name>` | Set the hostname |
| global config | `enable secret <pw>` | Assign the privileged level secret (supports `no`) |
| global config | `enable password <pw>` | Assign the privileged level password (supports `no`) |
| global config | `username <u> privilege <n> secret <pw>` | Establish User Name Authentication (supports `no`) |
| global config | `username <u> secret <pw>` | Establish User Name Authentication (supports `no`) |
| global config | `username <u> password <pw>` | Establish User Name Authentication (supports `no`) |
| global config | `banner motd <text ...>` | Set Message of the Day banner (supports `no`) |
| global config | `service <x ...>` | Modify use of network based services (supports `no`) |
| global config | `logging <x ...>` | Modify message logging facilities (supports `no`) |
| global config | `ntp <x ...>` | Configure NTP (supports `no`) |
| global config | `snmp-server <x ...>` | Modify SNMP engine parameters (supports `no`) |
| global config | `cdp <x ...>` | Global CDP configuration subcommands (supports `no`) |
| global config | `lldp <x ...>` | Global LLDP configuration subcommands (supports `no`) |
| global config | `aaa <x ...>` | Authentication, Authorization and Accounting (supports `no`) |
| global config | `clock <x ...>` | Configure time-of-day clock (supports `no`) |
| global config | `spanning-tree <x ...>` | Spanning Tree Subsystem (supports `no`) |
| global config | `crypto key generate rsa` | Generate RSA keys |
| global config | `crypto key generate rsa modulus <n>` | Generate RSA keys |
| global config | `ip domain-name <name>` | Define the default domain name (supports `no`) |
| global config | `ip domain-lookup` | Enable IP Domain Name System hostname translation (supports `no`) |
| global config | `ip ssh <x ...>` | Configure SSH parameters (supports `no`) |
| global config | `ip http server` | HTTP server (supports `no`) |
| global config | `ip http secure-server` | Enable HTTP secure server (supports `no`) |
| global config | `ip http authentication <x ...>` | Set http server authentication method (supports `no`) |
| global config | `ip name-server <ip>` | Specify address of name server (supports `no`) |
| global config | `ip cef` | Cisco Express Forwarding |
| global config | `ip classless` | Follow classless routing forwarding rules |
| global config | `ip dhcp <x ...>` | Configure DHCP server and relay parameters (supports `no`) |
| global config | `router <x ...>` | Enable a routing process (supports `no`) |
| global config | `interface <name ...>` | Select an interface to configure |
| global config | `ip access-list extended <name>` | Extended Access List (supports `no`) |
| global config | `access-list <num> permit <rule ...>` | Add a permit entry (supports `no`) |
| global config | `access-list <num> deny <rule ...>` | Add a deny entry (supports `no`) |
| ACL config | `permit <rule ...>` | Specify packets to forward (supports `no`) |
| ACL config | `deny <rule ...>` | Specify packets to reject (supports `no`) |
| ACL config | `<seq> permit <rule ...>` | Sequence number + permit (supports `no`) |
| ACL config | `<seq> deny <rule ...>` | Sequence number + deny (supports `no`) |
| ACL config | `remark <text ...>` | Access list entry comment |
| line config | `login local` | Local password checking (supports `no`) |
| line config | `login` | Enable password checking (supports `no`) |
| line config | `password <pw>` | Set a password (supports `no`) |
| line config | `transport input <x ...>` | Define which protocols to use when connecting to the terminal server (supports `no`) |
| line config | `exec-timeout <x ...>` | Set the EXEC timeout (supports `no`) |
| line config | `logging synchronous` | Synchronous logging of unsolicited messages (supports `no`) |
| global config | `line console <n>` | Primary terminal line |
| global config | `line vty <a> <b>` | Virtual terminal |
| router config | `<x ...>` | Routing process subcommand (supports `no`) |
| interface config | `description <text ...>` | Interface specific description (supports `no`) |
| interface config | `shutdown` | Shutdown the selected interface (supports `no`) |
| interface config | `duplex <x>` | Configure duplex operation (supports `no`) |
| interface config | `speed <x>` | Configure speed operation (supports `no`) |
| interface config | `cdp enable` | Enable CDP on interface |
| interface config | `negotiation auto` | Negotiation |
| user EXEC (and priv) | `show running-config <what ...>` | Show part of the configuration |
| global config | `ip route <net> <mask> <nh>` | Establish static routes (supports `no`) |
| user EXEC (and priv) | `show ip route` | IP routing table |
| user EXEC (and priv) | `show ip route <ip>` | Routing entry |
| user EXEC (and priv) | `show ip protocols` | IP routing protocol process parameters |
| user EXEC (and priv) | `show access-lists` | List access lists |
| user EXEC (and priv) | `show access-lists <name>` | List access lists |
| user EXEC (and priv) | `show ip access-lists` | List IP access lists |
| user EXEC (and priv) | `show ip access-lists <name>` | List IP access lists |
| user EXEC (and priv) | `show ip nat translations` | Translation entries |
| interface config | `ip address <ip> <mask>` | Set the IP address of an interface (supports `no`) |
| interface config | `ip access-group <name> <dir>` | Specify access control for packets (supports `no`) |
| interface config | `ip nat <x>` | NAT interface commands (supports `no`) |
| interface config | `ip helper-address <ip>` | Specify a destination address for UDP broadcasts (supports `no`) |

## IOS-style L2 switch (SW1)

| Mode | Command | What it does |
|---|---|---|
| user EXEC (and priv) | `enable` | Turn on privileged commands |
| privileged EXEC (#) | `disable` | Turn off privileged commands |
| user EXEC (and priv) | `show version` | System hardware and software status |
| user EXEC (and priv) | `show clock` | Display the system clock |
| user EXEC (and priv) | `show ip interface brief` | Brief summary of IP status and configuration |
| user EXEC (and priv) | `show interfaces` | Interface status and configuration |
| user EXEC (and priv) | `show interfaces <name ...>` | Interface status |
| user EXEC (and priv) | `show running-config` | Current operating configuration |
| user EXEC (and priv) | `show startup-config` | Contents of startup configuration |
| user EXEC (and priv) | `show arp` | ARP table |
| user EXEC (and priv) | `show ip arp` | IP ARP table |
| user EXEC (and priv) | `show cdp neighbors` | CDP neighbor entries |
| user EXEC (and priv) | `show users` | Display information about terminal lines |
| user EXEC (and priv) | `show history` | Display the session command history |
| user EXEC (and priv) | `show logging` | Show the contents of logging buffers |
| user EXEC (and priv) | `show flash` | Display information about flash |
| user EXEC (and priv) | `ping <ip>` | Send echo messages |
| user EXEC (and priv) | `traceroute <ip>` | Trace route to destination |
| user EXEC (and priv) | `terminal length <n>` | Set number of lines on a screen |
| user EXEC (and priv) | `terminal monitor` | Copy debug output to the current terminal |
| privileged EXEC (#) | `configure terminal` | Configure from the terminal |
| privileged EXEC (#) | `write memory` | Write to NV memory |
| privileged EXEC (#) | `write` | Write running configuration to memory |
| privileged EXEC (#) | `copy running-config startup-config` | Copy running config to startup |
| privileged EXEC (#) | `erase startup-config` | Erase the startup configuration |
| privileged EXEC (#) | `reload` | Halt and perform a cold restart |
| privileged EXEC (#) | `clear counters` | Clear counters |
| privileged EXEC (#) | `clear arp-cache` | Clear the entire ARP cache |
| global config | `hostname <name>` | Set the hostname |
| global config | `enable secret <pw>` | Assign the privileged level secret (supports `no`) |
| global config | `enable password <pw>` | Assign the privileged level password (supports `no`) |
| global config | `username <u> privilege <n> secret <pw>` | Establish User Name Authentication (supports `no`) |
| global config | `username <u> secret <pw>` | Establish User Name Authentication (supports `no`) |
| global config | `username <u> password <pw>` | Establish User Name Authentication (supports `no`) |
| global config | `banner motd <text ...>` | Set Message of the Day banner (supports `no`) |
| global config | `service <x ...>` | Modify use of network based services (supports `no`) |
| global config | `logging <x ...>` | Modify message logging facilities (supports `no`) |
| global config | `ntp <x ...>` | Configure NTP (supports `no`) |
| global config | `snmp-server <x ...>` | Modify SNMP engine parameters (supports `no`) |
| global config | `cdp <x ...>` | Global CDP configuration subcommands (supports `no`) |
| global config | `lldp <x ...>` | Global LLDP configuration subcommands (supports `no`) |
| global config | `aaa <x ...>` | Authentication, Authorization and Accounting (supports `no`) |
| global config | `clock <x ...>` | Configure time-of-day clock (supports `no`) |
| global config | `spanning-tree <x ...>` | Spanning Tree Subsystem (supports `no`) |
| global config | `crypto key generate rsa` | Generate RSA keys |
| global config | `crypto key generate rsa modulus <n>` | Generate RSA keys |
| global config | `ip domain-name <name>` | Define the default domain name (supports `no`) |
| global config | `ip domain-lookup` | Enable IP Domain Name System hostname translation (supports `no`) |
| global config | `ip ssh <x ...>` | Configure SSH parameters (supports `no`) |
| global config | `ip http server` | HTTP server (supports `no`) |
| global config | `ip http secure-server` | Enable HTTP secure server (supports `no`) |
| global config | `ip http authentication <x ...>` | Set http server authentication method (supports `no`) |
| global config | `ip name-server <ip>` | Specify address of name server (supports `no`) |
| global config | `ip cef` | Cisco Express Forwarding |
| global config | `ip classless` | Follow classless routing forwarding rules |
| global config | `ip dhcp <x ...>` | Configure DHCP server and relay parameters (supports `no`) |
| global config | `router <x ...>` | Enable a routing process (supports `no`) |
| global config | `interface <name ...>` | Select an interface to configure |
| global config | `ip access-list extended <name>` | Extended Access List (supports `no`) |
| global config | `access-list <num> permit <rule ...>` | Add a permit entry (supports `no`) |
| global config | `access-list <num> deny <rule ...>` | Add a deny entry (supports `no`) |
| ACL config | `permit <rule ...>` | Specify packets to forward (supports `no`) |
| ACL config | `deny <rule ...>` | Specify packets to reject (supports `no`) |
| ACL config | `<seq> permit <rule ...>` | Sequence number + permit (supports `no`) |
| ACL config | `<seq> deny <rule ...>` | Sequence number + deny (supports `no`) |
| ACL config | `remark <text ...>` | Access list entry comment |
| line config | `login local` | Local password checking (supports `no`) |
| line config | `login` | Enable password checking (supports `no`) |
| line config | `password <pw>` | Set a password (supports `no`) |
| line config | `transport input <x ...>` | Define which protocols to use when connecting to the terminal server (supports `no`) |
| line config | `exec-timeout <x ...>` | Set the EXEC timeout (supports `no`) |
| line config | `logging synchronous` | Synchronous logging of unsolicited messages (supports `no`) |
| global config | `line console <n>` | Primary terminal line |
| global config | `line vty <a> <b>` | Virtual terminal |
| router config | `<x ...>` | Routing process subcommand (supports `no`) |
| interface config | `description <text ...>` | Interface specific description (supports `no`) |
| interface config | `shutdown` | Shutdown the selected interface (supports `no`) |
| interface config | `duplex <x>` | Configure duplex operation (supports `no`) |
| interface config | `speed <x>` | Configure speed operation (supports `no`) |
| interface config | `cdp enable` | Enable CDP on interface |
| interface config | `negotiation auto` | Negotiation |
| user EXEC (and priv) | `show running-config <what ...>` | Show part of the configuration |
| user EXEC (and priv) | `show vlan brief` | VTP all VLAN status in brief |
| user EXEC (and priv) | `show vlan` | VTP all VLAN status |
| user EXEC (and priv) | `show mac address-table` | MAC forwarding table |
| user EXEC (and priv) | `show interfaces status` | Interface line status |
| user EXEC (and priv) | `show interfaces trunk` | Interface trunk information |
| user EXEC (and priv) | `show spanning-tree` | Spanning tree topology |
| global config | `vlan <id>` | VLAN commands (supports `no`) |
| vlan config | `name <n>` | Ascii name of the VLAN |
| interface config | `switchport mode <m>` | Set trunking mode of the interface (supports `no`) |
| interface config | `switchport access vlan <id>` | Set VLAN when interface is in access mode (supports `no`) |
| interface config | `switchport trunk <x ...>` | Set trunking characteristics (supports `no`) |
| interface config | `spanning-tree <x ...>` | Spanning Tree Subsystem (supports `no`) |
| interface config | `ip address <ip> <mask>` | Set the IP address of an SVI (supports `no`) |
| global config | `ip default-gateway <ip>` | Specify default gateway (supports `no`) |

## ASA-style firewall (FW1-ASA)

| Mode | Command | What it does |
|---|---|---|
| user EXEC (and priv) | `show running-config <what ...>` | Show part of the configuration |
| user EXEC (and priv) | `show version` | System hardware and software status |
| user EXEC (and priv) | `show clock` | Display the system clock |
| user EXEC (and priv) | `show interface ip brief` | Interface IP summary |
| user EXEC (and priv) | `show interface` | Interface status |
| user EXEC (and priv) | `show nameif` | Interface names and levels |
| user EXEC (and priv) | `show running-config` | Current operating configuration |
| user EXEC (and priv) | `show route` | Routing table |
| user EXEC (and priv) | `show access-list` | Access list |
| user EXEC (and priv) | `show access-list <name>` | Access list |
| user EXEC (and priv) | `show xlate` | NAT translations |
| user EXEC (and priv) | `show conn` | Connection table |
| user EXEC (and priv) | `show conn count` | Connection count |
| user EXEC (and priv) | `show nat` | NAT policies |
| user EXEC (and priv) | `show arp` | ARP table |
| user EXEC (and priv) | `show logging` | Logging |
| user EXEC (and priv) | `show asp drop` | Accelerated security path drop counters |
| user EXEC (and priv) | `ping <ip>` | Send ICMP echo |
| user EXEC (and priv) | `ping <if> <ip>` | Send ICMP echo via interface |
| user EXEC (and priv) | `traceroute <ip>` | Trace route |
| user EXEC (and priv) | `packet-tracer input <if> <proto> <sip> <sport> <dip> <dport>` | Trace a packet through the ASA |
| user EXEC (and priv) | `packet-tracer input <if> icmp <sip> <type> <code> <dip>` | Trace an ICMP packet |
| user EXEC (and priv) | `enable` | Turn on privileged commands |
| privileged EXEC (#) | `disable` | Turn off privileged commands |
| privileged EXEC (#) | `configure terminal` | Configure using terminal |
| privileged EXEC (#) | `write memory` | Save the running configuration |
| privileged EXEC (#) | `copy running-config startup-config` | Copy running to startup |
| privileged EXEC (#) | `clear xlate` | Clear NAT translations |
| privileged EXEC (#) | `clear conn` | Clear connections |
| privileged EXEC (#) | `clear access-list` | Clear access-list counters |
| privileged EXEC (#) | `clear configure access-list <name>` | Delete an access-list |
| privileged EXEC (#) | `reload` | Reload the system |
| global config | `hostname <name>` | Set the hostname |
| global config | `domain-name <n>` | Set the default domain name (supports `no`) |
| global config | `enable password <pw>` | Set enable password (supports `no`) |
| global config | `username <u> password <pw> privilege <n>` | Create a user (supports `no`) |
| global config | `username <u> password <pw>` | Create a user (supports `no`) |
| global config | `aaa <x ...>` | Configuration command (supports `no`) |
| global config | `http <x ...>` | Configuration command (supports `no`) |
| global config | `ssh <x ...>` | Configuration command (supports `no`) |
| global config | `telnet <x ...>` | Configuration command (supports `no`) |
| global config | `logging <x ...>` | Logging facility (supports `no`) |
| global config | `ntp <x ...>` | Configuration command (supports `no`) |
| global config | `snmp-server <x ...>` | Configuration command (supports `no`) |
| global config | `crypto <x ...>` | Configuration command (supports `no`) |
| global config | `policy-map <x ...>` | Configuration command (supports `no`) |
| global config | `class-map <x ...>` | Configuration command (supports `no`) |
| global config | `service-policy <x ...>` | Configuration command (supports `no`) |
| global config | `dhcpd <x ...>` | Configuration command (supports `no`) |
| global config | `icmp <x ...>` | Internet Control Message Protocol (supports `no`) |
| global config | `threat-detection <x ...>` | Configuration command (supports `no`) |
| global config | `asdm <x ...>` | Configuration command (supports `no`) |
| global config | `mtu <x ...>` | Configuration command (supports `no`) |
| global config | `failover <x ...>` | Configuration command (supports `no`) |
| global config | `same-security-traffic <x ...>` | Configuration command (supports `no`) |
| global config | `timeout <x ...>` | Configuration command (supports `no`) |
| global config | `dns <x ...>` | Configuration command (supports `no`) |
| global config | `names <x ...>` | Configuration command (supports `no`) |
| global config | `service <x ...>` | Configuration command (supports `no`) |
| global config | `clock <x ...>` | Display the system clock (supports `no`) |
| global config | `webvpn <x ...>` | Configuration command (supports `no`) |
| global config | `group-policy <x ...>` | Configuration command (supports `no`) |
| global config | `tunnel-group <x ...>` | Configuration command (supports `no`) |
| global config | `interface <name ...>` | Select an interface |
| interface config | `nameif <n>` | Assign name to interface (supports `no`) |
| interface config | `security-level <n>` | Set security level (supports `no`) |
| interface config | `ip address <ip> <mask>` | Set the IP address (supports `no`) |
| interface config | `shutdown` | Shut down the interface (supports `no`) |
| interface config | `description <t ...>` | Interface description (supports `no`) |
| interface config | `speed <x>` | Speed |
| interface config | `duplex <x>` | Duplex |
| interface config | `management-only` | Management only |
| global config | `route <if> <net> <mask> <gw>` | Configure a static route (supports `no`) |
| global config | `route <if> <net> <mask> <gw> <metric>` | Configure a static route (supports `no`) |
| global config | `access-list <name> extended <rule ...>` | Extended access list (supports `no`) |
| global config | `access-list <name> line <n> extended <rule ...>` | Insert at line (supports `no`) |
| global config | `access-list <name> remark <text ...>` | Access list comment (supports `no`) |
| global config | `access-group <name> in interface <if>` | Bind an access-list to an interface (supports `no`) |
| global config | `object network <name>` | Create a network object (supports `no`) |
| object config | `host <ip>` | Specify a host |
| object config | `subnet <ip> <mask>` | Specify a subnet |
| object config | `description <t ...>` | Description (supports `no`) |
| object config | `nat <spec> static <ip>` | Static NAT (supports `no`) |
| object config | `nat <spec> dynamic interface` | Dynamic PAT to the interface address (supports `no`) |
| object config | `nat <spec> dynamic <ip>` | Dynamic NAT/PAT to an address (supports `no`) |

## FTD (FTD1): clish + diagnostic CLI

| Mode | Command | What it does |
|---|---|---|
| FTD diagnostic CLI | `show running-config <what ...>` | Show part of the configuration |
| FTD clish (>) | `show version` | Display version |
| FTD clish (>) | `show managers` | Display managers |
| FTD clish (>) | `show network` | Display network settings |
| FTD clish (>) | `show interface ip brief` | Interface summary |
| FTD clish (>) | `show ntp` | NTP status |
| FTD clish (>) | `configure manager add <host> <key>` | Register to a manager |
| FTD clish (>) | `configure network <x ...>` | Configure management network |
| FTD clish (>) | `ping <ip>` | Send echo |
| FTD clish (>) | `expert` | Linux shell |
| FTD clish (>) | `system support diagnostic-cli` | Enter the ASA-style diagnostic CLI |
| FTD diagnostic CLI | `enable` | Turn on privileged commands |
| FTD diagnostic CLI | `show version` | System hardware and software status |
| FTD diagnostic CLI | `show clock` | Display the system clock |
| FTD diagnostic CLI | `show interface ip brief` | Interface IP summary |
| FTD diagnostic CLI | `show interface` | Interface status |
| FTD diagnostic CLI | `show nameif` | Interface names and levels |
| FTD diagnostic CLI | `show running-config` | Current operating configuration |
| FTD diagnostic CLI | `show route` | Routing table |
| FTD diagnostic CLI | `show access-list <name>` | Access list |
| FTD diagnostic CLI | `show xlate` | NAT translations |
| FTD diagnostic CLI | `show conn` | Connection table |
| FTD diagnostic CLI | `show conn count` | Connection count |
| FTD diagnostic CLI | `show nat` | NAT policies |
| FTD diagnostic CLI | `show arp` | ARP table |
| FTD diagnostic CLI | `show logging` | Logging |
| FTD diagnostic CLI | `show asp drop` | Accelerated security path drop counters |
| FTD diagnostic CLI | `ping <ip>` | Send ICMP echo |
| FTD diagnostic CLI | `ping <if> <ip>` | Send ICMP echo via interface |
| FTD diagnostic CLI | `traceroute <ip>` | Trace route |
| FTD diagnostic CLI | `packet-tracer input <if> <proto> <sip> <sport> <dip> <dport>` | Trace a packet through the ASA |
| FTD diagnostic CLI | `packet-tracer input <if> icmp <sip> <type> <code> <dip>` | Trace an ICMP packet |
| FTD diagnostic CLI | `show access-list` | Access control rules (compiled from FMC policy) |

## Linux PCs (Client, Outside-Desktop, DMZ-Server, FTD-Client)

`ip addr`, `ip route`, `ifconfig`, `arp -n`, `ss -tln`, `ping <ip>`, `traceroute <ip>`, `curl [-A agent] <url>`, `nmap [-Pn] [-p ports] <ip>`, `hostname`, `uname -a`, `whoami`, `ip addr add x/len dev eth0`, `ip route add default via x`, `help`, `clear`

## Not simulated
Dynamic routing (OSPF/EIGRP/BGP are accepted but exchange no routes), VPNs, ISE/AAA servers, NAT on IOS routers, QoS, real spanning-tree.

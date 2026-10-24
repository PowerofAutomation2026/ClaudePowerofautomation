# Core SCOR topology (build once in EVE-NG GUI, reuse for every lab)

```
           [Internet/Cloud0 NAT]
                   |
              (outside)
            [ASAv / FTDv]----(mgmt)----[FMC]   [ISE]
              |       \
          (inside)    (dmz)--[Linux web server]
              |
         [IOSv R1]==IPsec/FlexVPN==[IOSv R2]--[Linux client]
              |
        [IOSvL2 SW1] (802.1X, DAI, DHCP snooping, port-sec)--[Win/Linux supplicant]
              |
          [WSA/ESA virtual] (optional)
```
Nodes & RAM: IOSv 0.5G, IOSvL2 0.8G, ASAv 2G, FTDv 8G, FMCv 28G, ISE 16-24G, Linux 1G.
Azure D16s_v5 (64G) runs FTDv+FMC+ISE together only barely — use ASAv for most labs and bring up FMC/ISE for their labs.

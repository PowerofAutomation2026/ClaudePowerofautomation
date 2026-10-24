# Domain 1 — Network Security (30%)
1. ASA/FTD: zones/interfaces, NAT (object NAT, PAT), ACLs, `packet-tracer input inside tcp ...`
2. FTD via FMC: register FTD, access-control policy, intrusion policy (Snort), file/malware policy, SSL decryption, prefilter, URL filtering.
3. Site-to-site IKEv2 IPsec R1<->R2 and ASA<->R; verify `show crypto ikev2 sa`, `show crypto ipsec sa`.
4. FlexVPN / DMVPN with IKEv2 + NHRP; compare with GETVPN concepts.
5. Remote-access VPN (AnyConnect/Secure Client) on ASA/FTD with ISE auth.
6. Infra hardening: CoPP, uRPF, AAA (TACACS+/RADIUS), SNMPv3, NTP auth, SSH-only, ACL on VTY.
7. Layer 2: DHCP snooping, DAI, IP source guard, port security, storm control, BPDU guard, VLAN hopping mitigation, MACsec.
8. Segmentation: TrustSec SGT/SGACL (ISE + switch), VRF-lite.
9. NetFlow/Flexible NetFlow + Stealthwatch (Secure Network Analytics) concepts; `show flow monitor`.

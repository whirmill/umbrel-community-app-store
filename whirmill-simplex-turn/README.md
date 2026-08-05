# SimpleX TURN Relay for Umbrel

This package runs a small coturn STUN service and authenticated TURN relay for
SimpleX WebRTC audio and video calls. It does not replace the SMP or XFTP
services.

## Security boundary

- TURN allocations require the app-specific Umbrel password.
- STUN binding is enabled for WebRTC candidate gathering; it cannot allocate a
  relay or reach private peers.
- TCP client transport is accepted, but TCP relay endpoints are disabled.
- Loopback, LAN, Docker-private, link-local, CGNAT/Tailscale, and multicast peers
  are denied to prevent use as an internal-network proxy.
- Up to 12 concurrent allocations per authenticated user and 16 allocations
  total are allowed, with approximately 20 Mbit/s aggregate relay capacity.
- TLS/DTLS listeners, CLI, web administration, and persistent coturn logs are
  not exposed.
- STUN binding logging is temporarily enabled for the PoC and should be removed
  after call validation because runtime logs can contain client IP metadata.

## Ports

The router must preserve the same external and internal port numbers:

```text
3478/TCP       -> Umbrel 3478/TCP
3478/UDP       -> Umbrel 3478/UDP
49160-49179/UDP -> Umbrel 49160-49179/UDP
```

The Cloudflare `A` record `turn.satssurge.com` must point to the current public
IPv4 address with proxy status **DNS only**. Do not forward 5349, a TCP relay
range, coturn CLI/web ports, or any additional UDP range.

Coturn detects the public IPv4 when the container starts. A watchdog checks it
once per minute and, after observing the same new address twice, terminates the
server with a failure status so Docker restarts it with the updated address.
Transient lookup failures and a single differing observation are ignored. DNS
still needs to be updated separately, for example by the Cloudflare DDNS app.

## Client configuration

Open the app through Umbrel and copy the concealed three-line configuration
into SimpleX Chat under WebRTC ICE servers. It contains:

```text
stun:turn.satssurge.com:3478
turn:simplex:<app-password>@turn.satssurge.com:3478?transport=udp
turn:simplex:<app-password>@turn.satssurge.com:3478?transport=tcp
```

Configure the same three lines on both devices and enable **Always use relay**
for the end-to-end test.

## Verification

1. Wrong or missing credentials cannot allocate.
2. An authenticated ICE test returns a relay candidate on the current public
   IPv4 and a port within `49160-49179`.
3. Private/link-local peer targets and TCP relay requests fail.
4. A SimpleX audio and video call succeeds with Wi-Fi disabled and **Always use
   relay** enabled.
5. Restarting the app preserves its generated password and redetects the public
   IPv4. The ICE addresses remain concealed by default in the local UI and the
   credential is not written to application logs.
6. After two consecutive watchdog checks report a changed public IPv4, Coturn
   restarts automatically and authenticated ICE tests advertise the new address.

## Rollback

1. Remove the router forwards before stopping the app.
2. Revert SimpleX clients to their previous ICE server configuration.
3. Remove the DNS record and uninstall the app.

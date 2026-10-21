---
name: add-cua-tool
description: Add a persistent Cua Linux desktop to this fork's Cline workers, preserving browser login and routing outbound web traffic through OneCLI.
---

# Persistent Cua desktop

This fork carries the host module at `src/modules/computer-use/`, the worker
adapter at `container/agent-runner/src/computer-use/`, and the installer/runtime
in this skill. Read `docs/computer-use.md` before installation or maintenance.

The desktop belongs to an agent group. Workers and sessions in that group share
its browser authentication and take turns. Releasing a worker lease never deletes
the desktop. This is intended for the operator's personal group.

## Install or reconcile

1. Confirm the selected gateway is OneCLI and resolve the existing group with
   `ncl groups list`. Do not create a replacement agent group.
2. Use the dependency pins in `versions.json`. Do not bypass pnpm release-age or
   build-script approval rules. The Node host uses the Cua SDK; workers do not.
3. Run `pnpm exec tsx .claude/skills/add-cua-tool/scripts/setup.ts --group <id>`.
   It creates a dedicated internal Docker network, attaches the existing OneCLI
   gateway, builds the pinned desktop with browser CA trust and Japanese fonts,
   and registers the persistent desktop in the central DB. Existing containers
   and profile volumes are reused. Setup never silently recreates a desktop.
4. Run host build, runner typecheck and the computer-use host/runner tests.
   Restart the installed host service using this copy's detected service name.
   No runner image rebuild is needed unless runner dependencies changed: source
   is mounted by the existing runtime.
5. Run `pnpm exec tsx scripts/cua-smoke.ts <id>` to verify a real screen.
   Verify proxy traffic succeeds and direct external traffic is blocked.
6. A freshly started runner reads `computerUse` from materialized container.json.
   GUI tasks use `computer: true` in delegate_tasks. Existing runner processes
   that cached older config pick this up on their normal next spawn.

## Watch or log in

### Permanent LAN viewing

The fixed entry point runs `scripts/watch.ts` as a separate operator service.
It embeds the standard Cua viewer and automatically renews read-only tickets,
including after `computer resume` rotates the root token. It never pauses agents.
All devices that can reach this private LAN endpoint may watch; no separate
login is requested. Keep this service on the explicitly selected private IP.

1. Store a private JSON config outside the GUI-mounted directory, for example
   `data/computer-use-viewers/<group-id>/watch.json`, with `group`, `host` (LAN
   IPv4), `port` (13214), `cert` and `key` (absolute server-certificate/key paths).
   Reuse the CA already trusted by the viewing devices.
2. Render `runtime/viewer.service.in`: replace `@PROJECT_ROOT@` with this checkout,
   `@NODE@` with the absolute Node executable and `@CONFIG@` with that JSON path.
   Install it as `~/.config/systemd/user/nanoclaw-cua-viewer-<install-slug>.service`.
3. Stop only the old temporary `view.ts` forwarding process using that port.
   Run `systemctl --user daemon-reload` and `systemctl --user enable --now
   nanoclaw-cua-viewer-<install-slug>.service`. Existing host/desktop services stay up.
4. Open `https://<LAN-IP>:13214/`. This fixed URL has no ticket. It reuses Cua's
   standard viewer, checks the ticket every five seconds and renews five minutes
   before its one-hour expiry. Transient disconnects retry automatically.
5. Verify actual video, Cua's input rejection for a read-only ticket and automatic
   reconnection after a service restart and a `computer resume`. Ensure the
   browser process is preserved and agent GUI admission remains enabled.

For interactive human control on this same service, run `view.ts <group-id>
<private-output-file> --control --origin https://<LAN-IP>:13214`. It pauses agent
input and creates the usual Cua control link without trying to bind the occupied
port. Return control with `ncl computer resume --id <group-id>`. The fixed watch
page automatically reconnects with a new read-only ticket afterwards.

### Temporary operator links

Generate a Cua-standard viewer ticket into an operator-only file:

`pnpm exec tsx .claude/skills/add-cua-tool/scripts/view.ts <id> /tmp/cua-view.json`

For a browser on this host, add `--local-port 13211` and keep the command running.
It forwards Cua to loopback only for 30 minutes, retaining Cua's ticket auth.
Use the URL written to the private file. Localhost enables the browser's H.264
decoder; the pinned Linux guest's viewer fails codec negotiation over a private
HTTP IP even though the viewer claims it can fall back to PNG. Do not infer
success from opening a browser tab: verify that desktop frames actually render.

For another device on the LAN, use an explicit host LAN IP and a certificate
whose subjectAltName includes that IP. The client must trust its issuing CA.
Pass `--https-host <LAN-IP> --port 13214 --tls-cert <server.crt> --tls-key
<server.key>` instead of `--local-port`. This binds only that private IPv4
interface and terminates TLS while forwarding Cua's HTTP and WebSocket protocol
unchanged. The resulting private ticket URL uses HTTPS and the host LAN IP.
The command must remain running; its listener expires after 30 minutes.
Keep CA/server private keys outside the GUI-mounted configuration directory,
for example in `data/computer-use-viewers/<group-id>/`. Distribute only the CA certificate.
Do not disable certificate validation in the operator's browser.

Add `--control` to pause agent input, wait for in-flight input to settle and
create an interactive ticket. Log in using that Cua viewer. Afterwards run
`ncl computer resume --id <id>`. Resume rotates Cua's control token and restarts
only cua-spacesd, revoking old viewer tickets while Chromium stays open.

Tickets are sensitive. Do not put them, screenshots, browser cookies or typed
input in ordinary logs or Discord. The endpoint is private to the Docker bridge;
remote operators need their existing secure host access/tunnel to reach it.
Do not expose the guest control port publicly.

## Troubleshooting

- `disabled`: no registered desktop, or operator control has paused the group.
- `busy`: another session/worker owns the same desktop. Wait outside the shared
  worker tool lock; never force a second holder.
- `expired`: observe again or reacquire. Do not repeat an uncertain write.
- `unavailable`: check GUI container, gateway and isolated network. Failure does
  not delete the profile or fall back to direct internet.
- Browser certificate errors: check the OneCLI CA and Chromium NSS store.
- Viewer reports `no acceptable codec`: use localhost forwarding as above or
  authenticated HTTPS access. For a remote browser, tunnel the localhost port
  over existing authenticated host access; the Docker IP is not a secure context.
- Another device's localhost points to that device, not this host. Use the LAN
  HTTPS option or an actual SSH tunnel. A successful host-browser test does not
  establish that a remote browser can reach the endpoint or trusts its CA.
- Fixed watch page is reconnecting: inspect the viewer service status, desktop,
  OneCLI network, certificate and port. It serves 503 while unable to obtain a
  valid read-only ticket; it never uses a stale token as an input-capable fallback.
- Gateway replacement: rerun setup to reattach it; inspect the GUI's proxy host
  mapping if its address changed. Do not recreate the profile to fix networking.

See `REMOVE.md` for removal and recovery.

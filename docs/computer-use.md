# Persistent Cua GUI for Cline workers

This install uses one persistent desktop for its personal agent group. Login
cookies, app state and the home volume survive worker completion. An expiring
lease controls input; its lifetime is independent of the desktop's lifetime.
Multiple NanoClaw sessions of the group can use the desktop sequentially.

## Components

- Host `computer-use` module registers a portable `cua_environments` migration,
  a guarded `gui_request` delivery action, response cleanup, and host-only
  `computer pause/resume` commands. Configuration is central-DB backed.
- Runner native tools use existing session Mailboxes. They send requests to the
  host and read deterministic response IDs; no new HTTP management API or Docker
  socket is exposed to workers. System responses never wake the model.
- A per-worker computer session acquires before entering tool execution locks,
  exposes image-aware `gui_observe` and `gui_act`, and releases in finally. On
  iteration-limit recovery it reacquires and requires a new observation.
- Host pins `@trycua/cua` 0.4.4 (published 2026-10-16). The deployed Linux guest
  image is digest-pinned separately and reports cua-spacesd 0.6.0. Screenshot,
  pointer/keyboard and viewer compatibility are verified independently.
- A dedicated internal Docker network has no direct internet route. The existing
  OneCLI gateway is its outbound HTTP/HTTPS hop. A loopback proxy adds the scoped
  proxy authorization required by OneCLI, so Chromium can use a normal proxy.
  Chromium managed policy, OS/NSS CA trust and QUIC disablement are configured.
- `/home/cua` is a named persistent volume. Gateway connection material and the
  Cua control token remain in a host-owned directory mounted read-only. Real API
  keys are not copied into this desktop. Existing gateway grants still determine
  which matching API credentials OneCLI may inject for this group.

## Operation

Install/reconcile with the `add-cua-tool` skill. The Cline parent sets
`computer: true` for a delegated GUI task. Tasks have the existing 300-second
worker budget; GUI input rights expire after 330 seconds. Waiting for the shared
desktop is cancelable and never occupies the worker tool execution lock.

The host serializes the entire GUI lease across sessions, validates request
expiry/ownership and binds each input to a fresh screen. Input consumes that
observation. Request IDs deduplicate recent retries. An uncertain input is not
replayed; a new screenshot and inspection are required. Host restart forgets
leases, so old tokens cannot operate the desktop, and never deletes the GUI.

The worker sees actual image content rather than JSON-serialized base64. Images
are limited to 512KiB and desktop dimensions to 4096px. The full screenshot's
scale maps image coordinates into logical desktop points. Consumed response
images are acknowledged and removed by the host; responses older than a minute
are pruned when the session makes another GUI request. Abandoned sessions with no
further GUI activity can retain their last response in the session DB. Worker
history follows the existing bounded Cline recovery lifetime; large image history
can exceed its 2MB recovery bound. User reports do not automatically include raw
images. Input text is still part of session request storage, like other task data.

## Human viewing and control

For this personal LAN installation, a separate enabled user service runs the
skill's `watch.ts`. Its fixed URL is `https://<host-LAN-IP>:13214/`, with no ticket
in the address bar. Any device that can reach that LAN interface may watch after
trusting the configured certificate. The service uses the standard Cua viewer in
a same-origin frame; only its embedding policy is narrowed from `none` to `self`.
The outer page rejects embedding by other sites, and HTTP/WebSocket requests
reject mismatching Host/Origin values. Root credentials are never sent to browsers.

The fixed page polls its read-only session every five seconds. The host caches
the Cua ticket across viewers, renews it five minutes before its one-hour expiry,
and reacquires it after a root-token rotation. A failed refresh displays a
reconnecting state and retries; waking a background tab refreshes immediately.
Watching never changes agent admission or leases, including during human control.
The service supervises itself with systemd and survives NanoClaw host restarts.
Its JSON config and TLS keys live outside the GUI mount under
`data/computer-use-viewers/<group-id>/`. See the install skill's permanent-viewing
steps and service template. Renew TLS certificates before expiry; keeping the
viewer process running does not extend their validity.

Use the skill's `view.ts` to create Cua-standard view-only or interactive tickets.
It stores the URL in a private file rather than ordinary logs. `--control` calls
host-only `computer pause` and waits for in-flight calls before enabling human
input. Returning control uses `ncl computer resume --id <group-id>`: disable agent
input, rotate the root Cua token, restart only cua-spacesd, check health, then
reenable agents. Chromium and its login stay running. Old viewer tickets become
invalid. These commands use the existing local operator socket and are denied to
container callers, including callers with global CLI scope.

With the permanent service running, pass `--origin https://<host-LAN-IP>:13214`
to `view.ts --control`, instead of starting another temporary forwarder on the
same port. After control is returned, the fixed watch page reconnects on its own.

The Cua endpoint is the verified IP on the internal bridge and is not published
on the internet. For a remote PC, use existing authenticated host access/tunneling
or configure Cua's supported remote access separately. Display and input remain
in the standard Cua viewer. WebCodecs needs HTTPS/localhost. With this pinned Linux guest,
private HTTP access reports `no acceptable codec`: the advertised PNG fallback
does not negotiate. For a local browser, add `--local-port 13211` to `view.ts`
and keep that command running. It writes a localhost ticket URL and forwards TCP
on 127.0.0.1 only, including the standard viewer's video WebSocket, for 30 minutes.
Ticket authentication stays enforced by Cua. The forwarding process closes its
listener and active connections on expiry or termination. A remote operator can
tunnel that loopback port using existing authenticated host access. Confirm actual
desktop frames in the browser; a queued panel-open result is not a rendering check.

For direct access from another device on the LAN, use `--https-host <LAN-IP>
--port 13214 --tls-cert <server.crt> --tls-key <server.key>` instead of
`--local-port`. The forwarder binds only that explicit private IPv4 address and
serves TLS, including video WebSockets, with Cua's existing ticket authentication.
The certificate must cover the LAN IP and its CA must be trusted on the viewing
device. A localhost URL without a tunnel points to the viewing device itself.
Both forwarding modes last 30 minutes and require the command to stay running.
Those limits apply to temporary links, not to the permanent watch service.

Keep viewer TLS material in a separate host-only directory, for example
`data/computer-use-viewers/<group-id>/`. Distribute only the public CA certificate
to viewing devices and keep both CA and server private keys on the host. This
directory must be outside the GUI's mounted configuration directory. Renew the
server certificate before expiry and reissue it if the LAN IP changes. Do not
commit installation-specific certificate files.

## Limits and maintenance

This is a shared personal authority boundary. Children are not isolated accounts.
Same-group sessions intentionally share browser authentication; different groups
cannot borrow each other's lease. Browser cookies remain in the GUI, independent
of API credentials in OneCLI. Gateway request policies cannot generally infer the
meaning of every browser click.

Do not auto-delete this desktop as an orphan. Pause/failed jobs only release
rights; a missing or mismatching environment needs operator inspection. Container
recreation must preserve the home volume. Site login expiry can still require
human reauthentication. Gateway replacement may require reattaching the dedicated
network and updating stale host mappings; there is no direct-network fallback.

The GUI uses two CPUs, 4GiB RAM and 512MiB shared memory. Disk growth is monitored
operationally; this installer does not impose a writable-layer/home-volume disk
quota. Updating the base image requires an explicit rebuild/recreation with the
profile volume preserved. See the skill's REMOVE.md before removing anything.

## Validation

Host tests cover actual module registration, capability materialization, guarded
lease admission, cross-session exclusion, expiry, stale observations, duplicate
writes, host restart and transient response cleanup. Runner tests exercise actual
SDK delegation and verify native GUI images become model image parts, with no GUI
tools on ordinary tasks. Existing delegation/cancellation tests remain in place.

`cua-smoke.ts` checks a real screen. `cua-browser-smoke.ts` is an operator test
that changes the dedicated browser to a public test page; run before signing in
or when changing the current tab is acceptable. Neither script is scheduled.

## Validation on 2026-10-21 (this install)

- Full host suite: 3,700 passed, 1 existing skip. Additional pause/host-only and
  retention coverage: computer-use's 15 tests passed. Host build and separate
  runner typecheck passed.
- Full Bun runner suite: 716 passed, 3 existing skips.
- Real desktop: 1280x800 screenshots, Japanese fonts, Chromium CA trust. HTTPS
  through OneCLI returned 200; the same request with the proxy bypassed could not
  connect (000). The GUI network has no internet gateway route.
- Real `deepseek-v4.1-flash` workers used the production session Mailbox and host
  delivery action. One worker read a random screen-only code. Another clicked
  the synthetic Verify button and observed VERIFIED. A subsequent worker read
  the same code and VERIFIED state. All three completed; no Discord test posts.
- GUI response rows were acknowledged and removed after consumption.
- Human pause/control/resume succeeded. Rotating the Cua token and restarting
  only spacesd left the same Chromium PID running. The host was restarted and
  two idle agent containers refreshed; the GUI container remained healthy.
- Standard viewer rendering was checked in a real Chromium browser. Private HTTP
  failed codec negotiation; localhost forwarding enabled WebCodecs and rendered
  the existing Desk Check desktop. No desktop recreation was needed.
- LAN HTTPS returned 200 with the generated CA and IP
  validation enabled. A dedicated host Chromium test rendered video over HTTPS
  and WebSocket; only that test browser ignored certificate trust temporarily.
  Remote client reachability and CA trust still require checks on that device.

The operator subsequently trusted the CA on macOS and confirmed both viewing and
interactive control from that separate device. Forwarding expiry and binary
stream preservation also have automated regression coverage.

Final review on 2026-10-22: 3,707 host tests and 717 runner tests passed, with
1 existing host skip and 3 existing runner skips. Host build, runner and installer
typechecks, formatting, module lint and skill-pin verification passed. Added
regressions reject malformed operation values and prevent input after a failed
fresh observation. Viewer TLS keys were moved outside the GUI-mounted directory.

Automated validation did not log into any real website. The operator can log in through Cua's
interactive viewer. Site-specific login expiry and host/container recreation
recovery remain operational checks when those situations occur.

## Permanent watch validation on 2026-10-22

- Full host suite: 3,714 passed, 1 existing skip. The seven new regressions cover
  ticket caching/renewal/root-token rotation, retry after failure, HTTP origin and
  Host checks, standard viewer proxying, binary WebSockets and browser reconnects.
  Host build, runner/installer typechecks, lint, formatting and skill pins passed.
- A real Chromium browser rendered the standard Cua viewer at the fixed HTTPS
  root URL, using read-only media policy. HTTPS certificate and IP validation
  succeeded with the configured CA; the isolated browser test pinned the server
  certificate's public key. A read-only Cua ticket rejected pointer input.
- NanoClaw could obtain a real 1280x800 screenshot while the viewer was open.
  Both control-token rotation and a watch-service restart reconnected video
  automatically, keeping the root browser URL unchanged and Chromium's PID intact.
- An interactive `view.ts --control --origin ...` link also rendered through the
  permanent service. Afterwards control was returned: agent GUI admission was
  enabled and the fixed page reconnected using a new read-only ticket.
- The viewer service is enabled for automatic startup and the host user already
  has lingering enabled. The NanoClaw host and persistent desktop remain running.

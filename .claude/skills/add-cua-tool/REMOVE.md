# Remove persistent Cua support

1. Pause the desktop with `ncl computer pause --id <group-id>`. This disables
   agent input and waits for active operations; it preserves browser state.
2. Stop `nanoclaw-gui-<group-id>`. Keep its named home volume by default.
3. If uninstalling the runtime, remove that stopped container, disconnect the
   gateway from `nanoclaw-gui-<group-id>-net` and remove that dedicated network.
   Never remove the shared OneCLI gateway or its other networks.
4. Keep the `cua_environments` row disabled while recovery remains possible.
   Re-running setup reuses the existing desktop/profile. On complete removal,
   delete only this group's row through the configured central DB driver.
5. Only when the operator explicitly requests erasing login state, remove
   `nanoclaw-gui-<group-id>-home` and `data/computer-use/<group-id>/`. Deleting
   that volume logs the browser out and loses downloaded files/settings.
6. For code rollback, remove the computer-use module import, its container
   materialization lookup and capability field, and the Cline computer-session
   factory/schema/lifecycle additions. Remove the computer-use host/runner files,
   optional transient-system-message cleanup method, container skill, these
   installer files and Cua scripts/docs. Remove `@trycua/cua` from host deps and
   update the lockfile using pnpm's normal policies. Rebuild and restart host.
   Do not roll back unrelated worktree changes.
7. Preserve the applied migration's identity. Leaving the unused table is safe;
   do not drop user state or rewrite schema_version as part of a code rollback.

Existing release/restart/sweep paths never destroy a Cua desktop automatically.

For permanent watching, first disable and stop this copy's
`nanoclaw-cua-viewer-<install-slug>.service`, remove its user unit, and run
`systemctl --user daemon-reload`. Remove `src/modules/computer-use/watch.ts`,
its tests, the skill's `watch.ts` and service template on code rollback. Remove
only this group's optional `watch.json` configuration. None of this stops the desktop.

Temporary viewer forwarding: terminate the running `view.ts` command or wait
30 minutes to close its listener and streams; this never stops the desktop.
On full removal, revoke/remove the optional local viewer CA from devices where
the operator installed it, then remove `data/computer-use-viewers/<group-id>/` if no
other endpoint uses that CA. Keep browser profile state unless erasure was asked.

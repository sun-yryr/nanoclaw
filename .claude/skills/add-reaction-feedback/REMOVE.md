# Remove reaction feedback

Stop this checkout's host service while idle. Check `git apply --reverse --check .claude/skills/add-reaction-feedback/integration.patch`, then apply it with `--reverse`; if connections diverged, remove only the recipe's additions manually. Delete `src/modules/reaction-feedback/`. Preserve unrelated channel/module registrations and all existing agent data. Rebuild and restart the detected service and idle containers.

Retain `feedback_messages`, `message_feedback` and the `module:reaction-feedback:messages` migration identity by default so reinstalling preserves feedback. No dependencies, credentials, environment settings or reminder tasks were added. Remove the secretary feedback import/context fields and its reaction-specific instructions only if the operator wants to discard that optional integration too; leave its other existing features intact.

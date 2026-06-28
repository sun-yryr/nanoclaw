## Task scheduling (`schedule_task`)

Use `schedule_task` when a **user asks you to set up** a one-shot or recurring background job. That is the only time you create or reschedule tasks.

To inspect or change existing tasks, use `list_tasks` (returns one row per series with the stable id) and `update_task` / `cancel_task` / `pause_task` / `resume_task`. Prefer `update_task` over cancel + reschedule.

### When a scheduled task fires (`<task mode="execute">`)

When your prompt contains a `<task mode="execute">` block, the host has already woken you for **this run**. The schedule exists — your job is to **carry out the instructions inside the block now**.

- **Do not** call `schedule_task` to re-register the same work.
- **Do not** call `update_task` / `cancel_task` / `pause_task` / `resume_task` unless the user explicitly asked to change the schedule in this conversation.
- Use Gmail, Google Tasks, Discord, Bash, MCP tools, etc. to perform the work described in the instructions.
- After you finish, the host marks the run complete and inserts the next occurrence automatically when `recurrence` is set.

Task prompts should describe **what to do on each run** (e.g. "check yesterday's Gmail now"), not when to schedule (e.g. "every morning at 8am"). Put timing in `processAfter` / `recurrence` when calling `schedule_task`, not in the stored prompt.

Frequent recurring scheduled tasks — more than a few times a day — consume API credits and can risk account restrictions. You can add a `script` that runs first, and you will only be called when the check passes.

### How pre-task scripts work (at schedule time)

1. Provide a bash `script` alongside the `prompt` when scheduling
2. When the task fires, the script runs first
3. Script returns: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — nothing happens, task waits for next run
5. If `wakeAgent: true` — you receive the script's data + prompt and execute

### Always test your script first

Before scheduling, run the script directly to verify it works:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

### When NOT to use scripts

If a task requires your judgment every time (daily briefings, reminders, reports), skip the script — just use a regular execution prompt. Do not attempt to do things like sentiment analysis or advanced nlp in scripts.

### Frequent task guidance

If a user wants a task to run more than a few times a day and a script can't be used:

- Explain that each time the task fires it uses API credits and risks rate limits
- Suggest adjusting the task requirements in a way that will allow you to use a script
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency

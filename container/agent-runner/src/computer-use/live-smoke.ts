/** Explicit operator probe: GUI-only read of a synthetic screen, no channel messages. */
import '../mailbox/compose.js';
import { getAgentMailbox, readMailboxContext } from '../mailbox/index.js';
import { createComputerSession } from './client.js';
import { buildClineDelegateTasksTool, type DelegateTasksOutput } from '../providers/cline-delegation.js';
import { resolveClineSpawnConfig } from '../providers/cline-spawn.js';
const spawn = resolveClineSpawnConfig({
  spawnModel: process.env.CLINE_SPAWN_MODEL,
  spawnApi: process.env.CLINE_SPAWN_API,
  spawnBaseUrl: process.env.CLINE_SPAWN_BASE_URL,
  parentBaseUrl: process.env.CLINE_BASE_URL,
  apiKey: process.env.OPENCODE_GO_API_KEY || 'placeholder',
  maxIterations: 8,
  parentAuthMode: process.env.CLINE_AUTH_MODE === 'siwc' ? 'siwc' : 'default',
  spawnAuthMode: process.env.CLINE_SPAWN_AUTH_MODE === 'siwc' ? 'siwc' : 'default',
});
if (!spawn) throw new Error('No configured worker model');
const mailbox = getAgentMailbox();
await mailbox.start(await readMailboxContext());
const controller = new AbortController();
const actionMode = process.argv.includes('--act');
const tool = buildClineDelegateTasksTool({
  spawn,
  cwd: '/tmp',
  createComputerSession,
  parentSignal: controller.signal,
});
try {
  const result = (await tool.execute(
    {
      tasks: [
        {
          id: 'gui-smoke',
          computer: true,
          objective: actionMode
            ? 'Use ONLY gui_observe and gui_act on the current synthetic Desk Check page. Read its code, click the Verify button once, observe again and report the exact code and resulting status with report_task_result. Do not navigate or use shell, files or network.'
            : 'Use ONLY gui_observe to look at the current desktop. Read the code under Desk Check. Do not use shell, files, network, navigation or input. Report the exact code with report_task_result, then finish.',
          expectedOutput: 'The exact visible code and a statement that it came from gui_observe.',
        },
      ],
    },
    { agentId: 'operator-gui-smoke', iteration: 1, signal: controller.signal },
  )) as DelegateTasksOutput;
  console.log(JSON.stringify(result));
  if (actionMode) {
    const next = (await tool.execute(
      {
        tasks: [
          {
            id: 'gui-next-worker',
            computer: true,
            objective:
              'Use ONLY gui_observe to read the existing Desk Check code and status. Do not navigate or use input, shell, files or network. Report the exact visible code and status with report_task_result.',
            expectedOutput: 'Code and current status observed by this new worker.',
          },
        ],
      },
      { agentId: 'operator-gui-smoke', iteration: 2, signal: controller.signal },
    )) as DelegateTasksOutput;
    console.log(JSON.stringify(next));
  }
} finally {
  controller.abort();
  await mailbox.stop();
}

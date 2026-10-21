import crypto from 'node:crypto';
import { createTool, type AgentTool } from '@cline/sdk';
import { getAgentMailbox } from '../mailbox/index.js';
import { GUI_MAX_IMAGE_BYTES, GUI_REQUEST_MS, type GuiOperation, type GuiResponse } from './protocol.generated.js';
export interface ComputerSession {
  tools: AgentTool[];
  start(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export type GuiSend = (operation: GuiOperation, signal: AbortSignal) => Promise<GuiResponse>;
/** Correlation by host-written row ID avoids a new mailbox schema and keeps system rows out of prompts. */
export const sendGuiRequest: GuiSend = async (operation, signal) => {
  signal.throwIfAborted();
  const mailbox = getAgentMailbox();
  const requestId = crypto.randomUUID();
  const deadline = Date.now() + GUI_REQUEST_MS;
  await mailbox.run(() =>
    mailbox.operations.writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'gui_request', requestId, deadline, operation }),
    }),
  );
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const row = await mailbox.run(() => mailbox.operations.getMessageIn(`gui-response-${requestId}`));
    if (row) {
      const parsed = JSON.parse(row.content);
      if (row.kind !== 'system' || parsed.type !== 'gui_response' || parsed.requestId !== requestId)
        throw new Error('Invalid GUI response');
      await mailbox.run(() => mailbox.operations.markMessages([row.id], 'completed'));
      await mailbox.run(() =>
        mailbox.operations.writeMessageOut({
          id: crypto.randomUUID(),
          kind: 'system',
          content: JSON.stringify({ action: 'gui_ack', requestId }),
        }),
      );
      return parsed.response as GuiResponse;
    }
    await Bun.sleep(100);
  }
  throw new Error('GUI response timed out; observe before retrying an uncertain operation');
};
export function createComputerSession(owner: string, send: GuiSend = sendGuiRequest): ComputerSession {
  let lease: string | undefined;
  let observation: string | undefined;
  let active: AbortSignal | undefined;
  const requireSignal = () => {
    if (!active || !lease) throw new Error('GUI session is inactive');
    active.throwIfAborted();
    return active;
  };
  const tools: AgentTool[] = [
    createTool({
      name: 'gui_observe',
      description:
        'See the shared persistent desktop. Always observe when starting and after each action. Other tasks may have left tabs or dialogs open.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        observation = undefined;
        const result = await send({ kind: 'observe', lease: lease! }, requireSignal());
        if (!result.ok || !result.screen) throw new Error('GUI observation unavailable');
        const s = result.screen;
        if (
          !['image/jpeg', 'image/png'].includes(s.mediaType) ||
          typeof s.data !== 'string' ||
          s.data.length > Math.ceil(GUI_MAX_IMAGE_BYTES / 3) * 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(s.data) ||
          !Number.isSafeInteger(s.width) ||
          !Number.isSafeInteger(s.height) ||
          s.width < 1 ||
          s.height < 1
        )
          throw new Error('Invalid GUI image');
        observation = s.observation;
        // A native content array is converted into real model image parts by the pinned SDK.
        return [
          { type: 'text', text: `Desktop ${s.width} x ${s.height} pixels. Observe again after input.` },
          { type: 'image', data: s.data, mediaType: s.mediaType },
        ];
      },
    }),
    createTool({
      name: 'gui_act',
      description:
        'One desktop action. Requires a fresh gui_observe before EVERY action. Use screenshot pixel coordinates. Do not log out, clear the profile, or close unrelated work. Report uncertain outcomes instead of repeating writes.',
      retryable: false,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['click', 'double_click', 'type', 'key', 'scroll', 'drag'] },
          x: { type: ['number', 'null'] },
          y: { type: ['number', 'null'] },
          toX: { type: ['number', 'null'] },
          toY: { type: ['number', 'null'] },
          text: { type: ['string', 'null'] },
          keys: { type: ['array', 'null'], items: { type: 'string' } },
          dx: { type: ['number', 'null'] },
          dy: { type: ['number', 'null'] },
        },
        required: ['kind'],
      },
      execute: async (input: any) => {
        const signal = requireSignal();
        if (!observation) throw new Error('Call gui_observe first');
        const seen = observation;
        observation = undefined;
        const result = await send({ kind: 'act', lease: lease!, observation: seen, input }, signal);
        if (!result.ok) throw new Error(`GUI action ${result.code}; observe current state before continuing`);
        return 'Action completed. Observe the screen to verify the outcome.';
      },
    }),
  ];
  return {
    tools,
    async start(signal) {
      active = signal;
      observation = undefined;
      while (true) {
        signal.throwIfAborted();
        const result = await send({ kind: 'acquire', owner }, signal);
        if (result.ok && result.lease) {
          lease = result.lease;
          return;
        }
        if (result.ok || result.code !== 'busy') throw new Error('GUI is disabled or unavailable');
        await Bun.sleep(300);
      }
    },
    async close() {
      const released = lease;
      active = undefined;
      lease = undefined;
      observation = undefined;
      if (released) {
        // Cleanup gets its own signal after the worker signal is aborted. Desktop is never deleted.
        try {
          await send({ kind: 'release', lease: released }, AbortSignal.timeout(GUI_REQUEST_MS + 1000));
        } catch {
          /* Host expiry invalidates an abandoned lease. */
        }
      }
    },
  };
}

import { expect, it, vi } from 'vitest';
import type { Adapter } from 'chat';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge, handleForwardedEvent } from './chat-sdk-bridge.js';
import type { ProgressTransport } from '../agent-progress/discord.js';

it('handles ncp buttons in the permanent Gateway path and never sends legacy embeds', async () => {
  const request = vi.spyOn(globalThis, 'fetch');
  const interaction = vi.fn().mockResolvedValue(undefined);
  const progress = { interaction } as unknown as ProgressTransport;
  const event = { type: 'GATEWAY_INTERACTION_CREATE', data: { type: 3, data: { custom_id: 'ncp:1:synthetic:e' } } };
  const adapter = {} as Parameters<typeof handleForwardedEvent>[1];
  try {
    await handleForwardedEvent(JSON.stringify(event), adapter, {} as ChannelSetup, 'placeholder', progress);
    expect(interaction).toHaveBeenCalledWith(event.data);
    expect(request).not.toHaveBeenCalled();
    await handleForwardedEvent(
      JSON.stringify({ ...event, data: { type: 3, data: { custom_id: 'unknown:button' } } }),
      adapter,
      {} as ChannelSetup,
      'placeholder',
      progress,
    );
    expect(interaction).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
  }
});
it('routes structured progress through its own transport, preserving ordinary chat delivery', async () => {
  const deliver = vi.fn().mockResolvedValue('900');
  const postMessage = vi.fn().mockResolvedValue({ id: '901', raw: {} });
  const adapter = { name: 'discord', postMessage } as unknown as Adapter;
  const bridge = createChatSdkBridge({
    adapter,
    supportsThreads: true,
    progress: { deliver } as unknown as ProgressTransport,
  });
  expect(
    await bridge.deliver('discord:200:300', null, {
      kind: 'agent_progress',
      content: { snapshot: { runId: 'synthetic' } },
    }),
  ).toBe('900');
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(postMessage).not.toHaveBeenCalled();
  await bridge.deliver('discord:200:300', null, { kind: 'chat', content: { text: 'final answer' } });
  expect(postMessage).toHaveBeenCalledTimes(1);
});

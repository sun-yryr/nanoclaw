import { beforeEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ stop: vi.fn(async () => {}), start: vi.fn() }));
vi.mock('./runtime.js', () => ({ startPortalRuntime: runtime.start }));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  runtime.start.mockReturnValue({ stop: runtime.stop });
});

it('the real modules barrel registers the portal connection with host start and shutdown', async () => {
  const lifecycle = await import('../../host-lifecycle.js');
  await import('../index.js');
  expect(runtime.start).not.toHaveBeenCalled();
  const signal = new AbortController().signal;
  const startArgs = { signal, db: {} as never, deliveryAdapter: {} as never };
  for (const cb of lifecycle.getHostStartCallbacks()) await cb(startArgs);
  expect(runtime.start).toHaveBeenCalledWith({ signal, log: expect.any(Function) });
  for (const cb of lifecycle.getHostShutdownCallbacks()) await cb();
  expect(runtime.stop).toHaveBeenCalledOnce();
});

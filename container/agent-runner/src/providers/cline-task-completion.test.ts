import { expect, it } from 'bun:test';
import { recoverIncompleteTurn, workerCompletionReport } from './cline-task-completion.js';

it('requires evidence and forbids completed reports with outstanding work', async () => {
  const report = workerCompletionReport();
  const ctx = { agentId: 'worker', iteration: 1 };
  for (const input of [
    { status: 'completed', evidence: '', remainingWork: '' },
    { status: 'completed', evidence: '12 read', remainingWork: 'page count unknown' },
    { status: 'partial', evidence: '12 read', remainingWork: '' },
  ])
    await expect(report.tool.execute(input, ctx)).rejects.toThrow();
  await report.tool.execute({ status: 'partial', evidence: '12 read', remainingWork: 'reconcile IDs' }, ctx);
  expect(report.get()?.status).toBe('partial');
  report.clear();
  expect(report.get()).toBeUndefined();
});

it('reviews an incomplete parent final at most twice without replaying the initial run', async () => {
  let runs = 0,
    reviews = 0;
  const result = await recoverIncompleteTurn(
    async () => {
      runs++;
      return { status: 'completed', outputText: 'premature disclaimer' };
    },
    async (prompt) => {
      reviews++;
      expect(prompt).toContain('Completion review');
      return { status: 'completed', outputText: 'bounded outcome' };
    },
    () => 'Completion review: reconcile remaining IDs',
    new AbortController().signal,
  );
  expect(runs).toBe(1);
  expect(reviews).toBe(2);
  expect(result.outputText).toBe('bounded outcome');
});

it('reconciles actual ID sets, deduplicates pages and rejects capped or mismatched coverage as incomplete', async () => {
  const report = workerCompletionReport(true);
  const ctx = { agentId: 'worker', iteration: 1 };
  const base = { status: 'completed', evidence: 'read receipts in the requested window', remainingWork: '' };
  await report.tool.execute(base, ctx);
  expect(report.get()?.status).toBe('partial');
  await report.tool.execute(
    {
      ...base,
      coverage: {
        listedIds: ['a', 'a', 'b'],
        reviewedIds: ['a', 'outside-window'],
        classifiedIds: ['a'],
        paginationComplete: false,
      },
    },
    ctx,
  );
  expect(report.get()).toMatchObject({
    status: 'partial',
    coverage: {
      listed: 2,
      reviewed: 2,
      classified: 1,
      missingIds: ['b'],
      unexpectedIds: ['outside-window'],
      paginationComplete: false,
    },
  });
  await report.tool.execute(
    {
      ...base,
      coverage: {
        listedIds: ['a', 'a', 'b'],
        reviewedIds: ['b', 'a'],
        classifiedIds: ['a', 'b'],
        paginationComplete: true,
      },
    },
    ctx,
  );
  expect(report.get()).toMatchObject({
    status: 'completed',
    coverage: { listed: 2, reviewed: 2, classified: 2, missingIds: [], unexpectedIds: [] },
  });
  await report.tool.execute(
    { ...base, coverage: { listedIds: ['a'], reviewedIds: ['a'], classifiedIds: ['a'], paginationComplete: true } },
    ctx,
  );
  expect(report.get()).toMatchObject({ status: 'partial', coverage: { missingIds: ['b'] } });
  const followUp = workerCompletionReport(true, report.listedIds());
  await followUp.tool.execute(
    { ...base, coverage: { listedIds: ['b'], reviewedIds: ['b'], classifiedIds: ['b'], paginationComplete: true } },
    ctx,
  );
  expect(followUp.get()).toMatchObject({ status: 'partial', coverage: { missingIds: ['a'] } });
});

it('does not correct failed, cancelled, verified or tool-free turns', async () => {
  for (const status of ['failed', 'aborted', 'completed']) {
    const controller = new AbortController();
    if (status === 'completed') controller.abort();
    let reviews = 0;
    await recoverIncompleteTurn(
      async () => ({ status }),
      async () => {
        reviews++;
        return { status };
      },
      () => 'gap',
      controller.signal,
    );
    expect(reviews).toBe(0);
  }
  let reviews = 0;
  await recoverIncompleteTurn(
    async () => ({ status: 'completed' }),
    async () => {
      reviews++;
      return { status: 'completed' };
    },
    () => undefined,
    new AbortController().signal,
  );
  expect(reviews).toBe(0);
});

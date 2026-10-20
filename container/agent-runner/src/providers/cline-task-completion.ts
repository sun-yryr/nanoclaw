import { createTool } from '@cline/sdk';
import { z } from 'zod';

const reportSchema = z
  .object({
    status: z.enum(['completed', 'partial', 'blocked']),
    evidence: z.string().trim().min(1).max(4000),
    remainingWork: z.string().trim().max(2000),
    coverage: z
      .object({
        listedIds: z.array(z.string().trim().min(1).max(200)).max(5000),
        reviewedIds: z.array(z.string().trim().min(1).max(200)).max(5000),
        classifiedIds: z.array(z.string().trim().min(1).max(200)).max(5000),
        paginationComplete: z.boolean(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine((r) => r.status !== 'completed' || r.remainingWork === '', {
    message: 'Completed tasks cannot have remaining work',
  })
  .refine((r) => r.status === 'completed' || r.remainingWork.length > 0, {
    message: 'Partial or blocked tasks must identify remaining work or the blocker',
  });

export type TaskCompletion = {
  status: 'completed' | 'partial' | 'blocked' | 'unverified';
  evidence: string;
  remainingWork: string;
  coverage?: {
    listed: number;
    reviewed: number;
    classified: number;
    paginationComplete: boolean;
    missingCount: number;
    unexpectedCount: number;
    missingIds: string[];
    unexpectedIds: string[];
  };
};

/** A model's completion claim is evidence for parent review, not a trusted proof. */
export function workerCompletionReport(requireCoverage = false, inheritedIds: Iterable<string> = []) {
  let report: TaskCompletion | undefined;
  let checkpoint: TaskCompletion | undefined;
  const knownIds = new Set(inheritedIds);
  return {
    get: () => report,
    checkpoint: () => checkpoint,
    listedIds: () => [...knownIds],
    clear: () => {
      report = undefined;
    },
    tool: createTool({
      name: 'report_task_result',
      description:
        'Before finishing, report whether the entire bounded objective and expected output are satisfied. Cite observed evidence and remaining work. For exhaustive checks provide actual listed/reviewed/classified IDs and paginationComplete; the harness compares their sets. This records a claim for parent review, not independent proof of retrieval; it performs no external action.',
      inputSchema: z.toJSONSchema(reportSchema),
      retryable: false,
      async execute(input: unknown) {
        report = undefined;
        const parsed = reportSchema.parse(input);
        const { coverage: raw, ...rest } = parsed;
        for (const id of raw?.listedIds ?? []) knownIds.add(id);
        const listed = knownIds,
          reviewed = new Set(raw?.reviewedIds),
          classified = new Set(raw?.classifiedIds);
        const missingIds = [...listed].filter((id) => !reviewed.has(id) || !classified.has(id));
        const unexpectedIds = [...new Set([...reviewed, ...classified])].filter((id) => !listed.has(id));
        const coverage = raw
          ? {
              listed: listed.size,
              reviewed: reviewed.size,
              classified: classified.size,
              paginationComplete: raw.paginationComplete,
              missingCount: missingIds.length,
              unexpectedCount: unexpectedIds.length,
              missingIds: missingIds.slice(0, 50),
              unexpectedIds: unexpectedIds.slice(0, 50),
            }
          : undefined;
        const gap =
          requireCoverage && !raw
            ? 'Required enumeration/read/classification coverage is missing.'
            : raw && (!raw.paginationComplete || missingIds.length || unexpectedIds.length)
              ? 'Coverage is incomplete: finish pagination and reconcile the listed/reviewed/classified ID sets.'
              : undefined;
        // Preserve the evidence and exact missing IDs rather than discarding a useful
        // checkpoint because the worker prematurely claimed completion.
        report = {
          ...rest,
          ...(coverage ? { coverage } : {}),
          ...(parsed.status === 'completed' && gap ? { status: 'partial', remainingWork: gap } : {}),
        };
        checkpoint = report;
        return { recorded: true, completion: report };
      },
    }),
  };
}

export const MAX_COMPLETION_RECOVERY_ROUNDS = 2;

/** Keep the same turn budget/history across corrections; never replay a child automatically. */
export async function recoverIncompleteTurn<T extends { status: string }>(
  initial: () => Promise<T>,
  next: (prompt: string) => Promise<T>,
  recoveryPrompt: () => string | undefined,
  signal: AbortSignal,
): Promise<T> {
  let result = await initial();
  for (let round = 0; round < MAX_COMPLETION_RECOVERY_ROUNDS && result.status === 'completed'; round++) {
    if (signal.aborted) break;
    const prompt = recoveryPrompt();
    if (!prompt) break;
    result = await next(
      `${prompt}\nCompletion review ${round + 1}/${MAX_COMPLETION_RECOVERY_ROUNDS}. On the last review, finish with the verified outcome and any concrete unresolved blocker.`,
    );
  }
  return result;
}

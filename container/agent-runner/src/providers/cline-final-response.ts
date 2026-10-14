import type { AgentRuntimeHooks } from '@cline/agents';
type BeforeModel = Parameters<NonNullable<AgentRuntimeHooks['beforeModel']>>[0];
type BeforeTool = Parameters<NonNullable<AgentRuntimeHooks['beforeTool']>>[0];

/** Recovery is one model request using existing evidence, never an action replay. */
export class FinalResponseGate {
  private active = false;
  private requests = 0;
  begin(finalOnly: boolean): void {
    this.active = finalOnly;
    this.requests = 0;
  }
  hooks(base: AgentRuntimeHooks, finalIo: AgentRuntimeHooks = base): AgentRuntimeHooks {
    return {
      ...base,
      beforeModel: async (context: BeforeModel) => {
        if (!this.active) return base.beforeModel?.(context);
        if (this.requests++ >= 1) return { stop: true, reason: 'Final answer recovery allows one model request.' };
        const result = await finalIo.beforeModel?.({ ...context, request: { ...context.request, tools: [] } });
        return { ...result, tools: [] };
      },
      beforeTool: (context: BeforeTool) =>
        this.active
          ? {
              skip: true,
              reason:
                'Answer using existing results. Tool execution and action replay are disabled during final-answer recovery.',
            }
          : base.beforeTool?.(context),
    };
  }
}

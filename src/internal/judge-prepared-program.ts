import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimePreparedCodeCall,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedExecutionProvider,
  RuntimePreparedProgram,
  RuntimePreparedTraceBatchCall,
  RuntimePreparedTraceCall,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
} from '../../packages/runtime-contracts/src/index';
import { RuntimeProgramConcurrencyGate } from '../../packages/runtime-browser/src/program-concurrency-gate';

export function isPreparedExecutionProvider(
  provider: object
): provider is RuntimePreparedExecutionProvider {
  return (
    'prepareProgram' in provider &&
    typeof provider.prepareProgram === 'function'
  );
}

interface PreparedEvaluationState {
  closed: boolean;
  preparing: boolean;
  program?: RuntimePreparedProgram;
  gate?: RuntimeProgramConcurrencyGate;
}

function invalidPreparation(
  message: string
): RuntimeProgramPreparationResult {
  return {
    kind: 'failed',
    error: message,
    diagnosticStage: 'compile',
    consoleOutput: [],
  };
}

/**
 * Private ownership boundary for provider artifacts.
 *
 * Each evaluation may prepare one program. Cases share only its immutable
 * artifact and are throttled to the provider-declared concurrency limit. The
 * provider remains responsible for fresh mutable language state on every
 * executeIsolated call.
 */
export class RuntimePreparedProgramRegistry {
  private readonly evaluations = new Map<string, PreparedEvaluationState>();
  private readonly disposedPrograms = new WeakSet<object>();

  constructor(
    private readonly provider: RuntimePreparedExecutionProvider
  ) {}

  begin(evaluationId: string): void {
    if (this.evaluations.has(evaluationId)) {
      throw new Error(
        `Prepared runtime evaluation ${JSON.stringify(evaluationId)} already exists.`
      );
    }
    this.evaluations.set(evaluationId, {
      closed: false,
      preparing: false,
    });
  }

  async prepare(
    evaluationId: string,
    call: RuntimeProgramPreparationCall
  ): Promise<RuntimeProgramPreparationResult> {
    const state = this.requireState(evaluationId);
    if (state.closed) {
      return invalidPreparation('Prepared runtime evaluation is already closed.');
    }
    if (state.preparing || state.program) {
      return invalidPreparation(
        'Prepared runtime evaluation may prepare exactly one program.'
      );
    }
    state.preparing = true;
    try {
      const result = await this.provider.prepareProgram(call);
      if (result.kind !== 'prepared') return result;

      const program = result.program;
      const maximum = program.capabilities.maxConcurrency;
      if (program.mode !== call.mode) {
        await this.disposeOnce(program);
        return invalidPreparation(
          `Prepared runtime returned ${JSON.stringify(program.mode)} mode ` +
          `for a ${JSON.stringify(call.mode)} preparation.`
        );
      }
      if (
        program.capabilities.caseIsolation !== 'fresh-case-state' ||
        !Number.isSafeInteger(maximum) ||
        maximum < 1
      ) {
        await this.disposeOnce(program);
        return invalidPreparation(
          'Prepared runtime must guarantee fresh-case-state isolation and a ' +
          'positive integer maxConcurrency.'
        );
      }
      if (state.closed) {
        try {
          await this.disposeOnce(program);
        } catch {
          // The evaluation has already been interrupted. Teardown was still
          // attempted exactly once; the active evaluation owns no result path
          // on which a late disposal error could be reported.
        }
        return invalidPreparation(
          'Prepared runtime evaluation closed before preparation completed.'
        );
      }
      state.program = program;
      state.gate = new RuntimeProgramConcurrencyGate(maximum);
      return result;
    } finally {
      state.preparing = false;
    }
  }

  executeCode(
    evaluationId: string,
    call: RuntimePreparedCodeCall
  ): Promise<CodeExecutionResult> {
    const { program, gate } = this.preparedState(evaluationId);
    if (program.mode !== 'code') {
      return Promise.reject(
        new Error('Tracing prepared program cannot execute a code-only case.')
      );
    }
    return gate.run(call.signal, () => program.executeIsolated(call));
  }

  executeCodeBatch(
    evaluationId: string,
    call: RuntimePreparedCodeBatchCall
  ): Promise<readonly CodeExecutionResult[]> {
    const { program, gate } = this.preparedState(evaluationId);
    if (program.mode !== 'code') {
      return Promise.reject(
        new Error('Tracing prepared program cannot execute a code-only batch.')
      );
    }
    if (program.executeBatchIsolated) {
      return gate.run(call.signal, () => program.executeBatchIsolated!(call));
    }
    return Promise.all(
      call.inputBatch.map((inputs) =>
        gate.run(call.signal, () =>
          program.executeIsolated({
            inputs,
            signal: call.signal,
            limits: call.limits,
          })
        )
      )
    );
  }

  executeTrace(
    evaluationId: string,
    call: RuntimePreparedTraceCall
  ): Promise<ExecutionResult> {
    const { program, gate } = this.preparedState(evaluationId);
    if (program.mode !== 'trace') {
      return Promise.reject(
        new Error('Code-only prepared program cannot execute a tracing case.')
      );
    }
    return gate.run(call.signal, () => program.executeIsolated(call));
  }

  executeTraceBatch(
    evaluationId: string,
    call: RuntimePreparedTraceBatchCall
  ): Promise<readonly ExecutionResult[]> {
    const { program, gate } = this.preparedState(evaluationId);
    if (program.mode !== 'trace') {
      return Promise.reject(
        new Error('Code-only prepared program cannot execute a tracing batch.')
      );
    }
    if (
      call.traceEnabledBatch !== undefined &&
      (
        call.traceEnabledBatch.length !== call.inputBatch.length ||
        call.traceEnabledBatch.some((enabled) => typeof enabled !== 'boolean')
      )
    ) {
      return Promise.reject(
        new TypeError(
          'Prepared trace selection must contain one boolean per batch case.'
        )
      );
    }
    if (program.executeBatchIsolated) {
      return gate.run(call.signal, () => program.executeBatchIsolated!(call));
    }
    return Promise.all(
      call.inputBatch.map((inputs, index) =>
        gate.run(call.signal, () =>
          program.executeIsolated({
            inputs,
            ...(call.traceEnabledBatch === undefined
              ? {}
              : { recordTrace: call.traceEnabledBatch[index] }),
            signal: call.signal,
            limits: call.limits,
          })
        )
      )
    );
  }

  async dispose(evaluationId: string): Promise<void> {
    const state = this.evaluations.get(evaluationId);
    if (!state) return;
    this.evaluations.delete(evaluationId);
    state.closed = true;
    if (state.program) {
      const program = state.program;
      state.program = undefined;
      state.gate = undefined;
      await this.disposeOnce(program);
    }
  }

  private preparedState(evaluationId: string): {
    readonly program: RuntimePreparedProgram;
    readonly gate: RuntimeProgramConcurrencyGate;
  } {
    const state = this.requireState(evaluationId);
    if (state.closed || !state.program || !state.gate) {
      throw new Error(
        `Prepared runtime evaluation ${JSON.stringify(evaluationId)} ` +
        'does not own a prepared program.'
      );
    }
    return {
      program: state.program,
      gate: state.gate,
    };
  }

  private requireState(evaluationId: string): PreparedEvaluationState {
    const state = this.evaluations.get(evaluationId);
    if (!state) {
      throw new Error(
        `Unknown prepared runtime evaluation ${JSON.stringify(evaluationId)}.`
      );
    }
    return state;
  }

  private async disposeOnce(program: RuntimePreparedProgram): Promise<void> {
    if (this.disposedPrograms.has(program)) return;
    this.disposedPrograms.add(program);
    await program.dispose();
  }
}

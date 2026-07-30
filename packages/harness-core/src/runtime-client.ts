import type {
  RuntimeCommandResult,
  RuntimeProjectCommandRequest,
} from './runtime-project';
import type {
  RuntimeExecuteCodeRequest,
  RuntimeExecuteResult,
} from './judge-contracts';
import type {
  CodeExecutionResult,
  ExecutionResult,
} from './runtime-execution';
import type {
  RuntimeCodeCall,
  RuntimeExecutionProvider,
  RuntimeTraceCall,
} from './runtime-calls';

export interface RuntimeExecuteProjectRequest extends RuntimeProjectCommandRequest {
  kind: 'project';
}

export type RuntimeExecuteRequest = RuntimeExecuteCodeRequest | RuntimeExecuteProjectRequest;

export type RuntimeExecuteResponse = RuntimeExecuteResult | RuntimeCommandResult;

/**
 * Combined client retained while callers migrate from direct execution to
 * explicit Judge and workspace orchestration. Generic language runtimes
 * implement `RuntimeExecutionProvider`; this contract adds the legacy
 * case-batch and project dispatch surface.
 */
export interface RuntimeClient extends RuntimeExecutionProvider {
  execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse>;
  executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult>;
  executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult>;
}

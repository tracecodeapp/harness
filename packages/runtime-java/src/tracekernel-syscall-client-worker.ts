import { TraceKernelSharedSyscallClient } from '@tracecode/tracekernel';

Object.defineProperty(globalThis, 'TraceCodeTraceKernelSharedSyscallClient', {
  configurable: false,
  enumerable: false,
  writable: false,
  value: TraceKernelSharedSyscallClient,
});

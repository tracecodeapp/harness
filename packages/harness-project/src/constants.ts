

export const DEFAULT_CWD = '/workspace';

export const TRACE_KERNEL_NAME = 'tracekernel';

export const TRACEKERNEL_BIN_PATH = '/tracekernel/bin';

export const TRACEKERNEL_SKILLS_ROOT = '/skills';

export const CPP_COMPILER_COMMANDS = new Set(['clang++', 'clang', 'gcc', 'cc', 'g++', 'c++']);

export const TRACEKERNEL_EXEC_COMMAND = 'tracekernel-exec';

export const TRACEKERNEL_SHELL_COMMAND_PREFIX = 'tracekernel-shell-';

export const TRACEKERNEL_SHELL_COMMAND_REWRITES = new Map([
  ['bg', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}bg`],
  ['command', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}command`],
  ['fg', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}fg`],
  ['jobs', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}jobs`],
  ['kill', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}kill`],
  ['ps', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}ps`],
  ['wait', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}wait`],
]);


export const TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS = 64;

export const TRACEKERNEL_MAX_PROJECT_COMMAND_STEP_NESTING_DEPTH = 32;

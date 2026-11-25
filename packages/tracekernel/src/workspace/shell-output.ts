import type { RuntimeCommandEvent } from '@tracecode/runtime-contracts';
import { terminalStaticWordValue } from './arg-parsers';

/**
 * Where a command's stdout or stderr goes, relative to the frame that runs it
 * (the shell's own descriptors, or a function or nested script's caller).
 * - `stdout` / `stderr`: the frame's own stream of that name.
 * - `captured`: a pipe, file, substitution or closed descriptor. `/dev/tty`
 *   and `/dev/fd/N` count too: the shell writes those bytes to the device.
 */
export type ShellOutputDisposition = 'stdout' | 'stderr' | 'captured';

/** A runtime child's stream route on its parent's output, resolved by the patched interpreter. */
export type ShellOutputRoute = ShellOutputDisposition;

/**
 * Per command: stdout route, stderr route, and whether both streams reach the
 * same sink (`2>&1`, `>&2`, `&> f`), so their bytes form one ordered stream.
 */
export type ShellOutputRoutes = readonly [stdout: ShellOutputRoute, stderr: ShellOutputRoute, merged?: boolean];

/** One output sink; descriptors that share a sink object write to the same place. */
interface Sink {
  readonly disposition: ShellOutputDisposition;
}

type Descriptors = Map<number, Sink>;

interface RedirectionLike {
  fd?: number | null;
  fdVariable?: string;
  operator?: string;
  target?: unknown;
}

const COMPOUND_COMMANDS = new Set([
  'If', 'For', 'CStyleFor', 'While', 'Until', 'Case', 'Subshell', 'Group',
  'ArithmeticCommand', 'ConditionalCommand',
]);

const FRAME_STDOUT: Sink = { disposition: 'stdout' };
const FRAME_STDERR: Sink = { disposition: 'stderr' };

function frameDescriptors(): Descriptors {
  return new Map([[1, FRAME_STDOUT], [2, FRAME_STDERR]]);
}

function capturedSink(): Sink {
  return { disposition: 'captured' };
}

/** An unknown target keeps the stream on its own frame stream: today's visible behaviour. */
function setUnknown(descriptors: Descriptors, fd: number): void {
  if (fd === 1) descriptors.set(1, FRAME_STDOUT);
  else if (fd === 2) descriptors.set(2, FRAME_STDERR);
  else descriptors.delete(fd);
}

function setDescriptor(descriptors: Descriptors, fd: number, sink: Sink | undefined): void {
  if (sink === undefined) setUnknown(descriptors, fd);
  else descriptors.set(fd, sink);
}

function fileSink(target: unknown, descriptors: Descriptors): Sink | undefined {
  const path = terminalStaticWordValue(target);
  if (path === null || path.length === 0) return undefined;
  // just-bash routes these two names itself. Other device paths, such as
  // /dev/tty and /dev/fd/N, are written by the shell through the device.
  if (path === '/dev/stdout') return descriptors.get(1);
  if (path === '/dev/stderr') return descriptors.get(2);
  return capturedSink();
}

/** Apply redirections in source order, as Bash does (`2>&1 >f` keeps stderr on the old stdout). */
function applyRedirections(input: Descriptors, redirections: readonly RedirectionLike[] | undefined): Descriptors {
  const descriptors = new Map(input);
  for (const redirection of redirections ?? []) {
    if (redirection.fdVariable) continue;
    const operator = redirection.operator ?? '';
    const target = redirection.target;
    switch (operator) {
      case '>':
      case '>>':
      case '>|':
        setDescriptor(descriptors, redirection.fd ?? 1, fileSink(target, descriptors));
        break;
      case '&>':
      case '&>>': {
        const sink = fileSink(target, descriptors);
        setDescriptor(descriptors, 1, sink);
        setDescriptor(descriptors, 2, sink);
        break;
      }
      case '>&':
      case '<&': {
        const fd = redirection.fd ?? (operator === '>&' ? 1 : 0);
        const word = terminalStaticWordValue(target);
        if (word === '-') descriptors.set(fd, capturedSink());
        else if (word !== null && /^\d+$/.test(word)) setDescriptor(descriptors, fd, descriptors.get(Number(word)));
        else if (operator === '>&' && word !== null && redirection.fd == null) {
          const sink = fileSink(target, descriptors);
          setDescriptor(descriptors, 1, sink);
          setDescriptor(descriptors, 2, sink);
        } else if (operator === '>&' && word !== null) setDescriptor(descriptors, fd, fileSink(target, descriptors));
        else setUnknown(descriptors, fd);
        break;
      }
      case '<>':
        if (redirection.fd === 1 || redirection.fd === 2) descriptors.set(redirection.fd, capturedSink());
        break;
      default:
        break;
    }
  }
  return descriptors;
}

function withCapturedStdout(descriptors: Descriptors): Descriptors {
  const next = new Map(descriptors);
  next.set(1, capturedSink());
  return next;
}

/**
 * Mark every SimpleCommand with `tracecodeOutput`: its stdout and stderr
 * dispositions relative to the frame that runs it, and whether they share a
 * sink. The patched interpreter resolves them against the caller's routes
 * when the command runs, so functions, `source`, nested scripts and package
 * scripts compose. A runtime child then streams live output only on routes
 * that reach its parent's output; its buffered result still flows through the
 * shell's own routing. Unknown targets keep today's behaviour (shown).
 */
export function markShellOutputInAst(ast: unknown): void {
  const visit = (value: unknown, descriptors: Descriptors, pipeStderr = false): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, descriptors);
      return;
    }
    const node = value as Record<string, unknown>;
    const redirections = node.redirections as RedirectionLike[] | undefined;
    switch (node.type) {
      case 'Pipeline': {
        const commands = (node.commands as unknown[] | undefined) ?? [];
        const pipedStderr = (node.pipeStderr as boolean[] | undefined) ?? [];
        commands.forEach((command, index) => {
          const last = index === commands.length - 1;
          visit(command, last ? descriptors : withCapturedStdout(descriptors), !last && pipedStderr[index] === true);
        });
        return;
      }
      case 'SimpleCommand': {
        const own = applyRedirections(descriptors, redirections);
        // `|&` is `2>&1 |`, applied after the command's own redirections.
        if (pipeStderr) setDescriptor(own, 2, own.get(1));
        const stdout = own.get(1) ?? FRAME_STDOUT;
        const stderr = own.get(2) ?? FRAME_STDERR;
        node.tracecodeOutput = [stdout.disposition, stderr.disposition, stdout === stderr];
        // Word, assignment and redirect-target expansions run before this
        // command's redirections, on the pipeline stage's descriptors.
        for (const [key, entry] of Object.entries(node)) {
          if (key !== 'tracecodeOutput') visit(entry, descriptors);
        }
        return;
      }
      case 'FunctionDef': {
        // A function body runs on its caller's descriptors, plus the definition's redirections.
        visit(node.body, applyRedirections(frameDescriptors(), redirections));
        visit(redirections, frameDescriptors());
        return;
      }
      case 'CommandSubstitution':
        visit(node.body, withCapturedStdout(descriptors));
        return;
      case 'ProcessSubstitution':
        visit(node.body, node.direction === 'input' ? withCapturedStdout(descriptors) : descriptors);
        return;
      default:
        break;
    }
    if (typeof node.type === 'string' && COMPOUND_COMMANDS.has(node.type)) {
      const body = applyRedirections(descriptors, redirections);
      if (pipeStderr) setDescriptor(body, 2, body.get(1));
      for (const [key, entry] of Object.entries(node)) {
        visit(entry, key === 'redirections' ? descriptors : body);
      }
      return;
    }
    for (const entry of Object.values(node)) visit(entry, descriptors);
  };
  visit(ast, frameDescriptors());
}

/** A frame's own descriptors: each stream reaches its caller's stream of the same name. */
export const SHELL_FRAME_OUTPUT_ROUTES: ShellOutputRoutes = ['stdout', 'stderr', false];

/**
 * Forward a child's live output event through its routes: drop a captured
 * stream (the shell delivers those bytes where it routes them) and move a
 * duplicated one (`2>&1`) onto the stream it reaches. Other events pass.
 */
export function routeChildOutputEvent(
  event: RuntimeCommandEvent,
  routes: ShellOutputRoutes | undefined
): RuntimeCommandEvent | null {
  if (event.type !== 'output' || !routes) return event;
  const route = routes[event.stream === 'stderr' ? 1 : 0];
  if (route === 'captured') return null;
  if (route === event.stream) return event;
  return { ...event, stream: route, device: route === 'stderr' ? '/dev/stderr' : '/dev/stdout' };
}

/**
 * The buffered result of a child whose streams share one sink. just-bash
 * joins them as all of stdout then all of stderr; when the child's live
 * transcript holds exactly its returned bytes, return them in the order the
 * program wrote them, on stdout, so the shell's routing keeps that order.
 */
export function mergedChildOutput<Result extends { stdout: string; stderr: string }>(
  result: Result,
  transcript: readonly { stream: 'stdout' | 'stderr'; data: string }[] | undefined
): Result {
  if (!transcript?.length) return result;
  let stdout = '';
  let stderr = '';
  for (const chunk of transcript) {
    if (chunk.stream === 'stdout') stdout += chunk.data;
    else stderr += chunk.data;
  }
  if (stdout !== result.stdout || stderr !== result.stderr || !stderr) return result;
  return { ...result, stdout: transcript.map((chunk) => chunk.data).join(''), stderr: '' };
}

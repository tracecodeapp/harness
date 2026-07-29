import type { TraceJVMProjectClient } from './tracejvm-project';

export type TraceJVMHarnessClient = TraceJVMProjectClient;

export interface TraceJVMHarnessWarmupResult {
  totalMs: number;
  runtimeInitializeMs: number;
  compileMs: number;
  runMs: number;
}

const warmupGates = new WeakMap<object, Promise<TraceJVMHarnessWarmupResult>>();

const WARMUP_CLASS = 'tracecode.harness.warmup.TraceJVMHarnessWarmup';
const WARMUP_STDOUT = '__TRACECODE_TRACEJVM_WARM__';
const WARMUP_SOURCE = `package tracecode.harness.warmup;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

public final class TraceJVMHarnessWarmup {
  private static int processLocal = 0;

  private static int add(int left, int right) {
    return left + right;
  }

  private static int invokeAdd(int left, int right) throws Exception {
    try {
      Method method = TraceJVMHarnessWarmup.class.getDeclaredMethod(
          "add", int.class, int.class);
      return ((Integer) method.invoke(null, left, right)).intValue();
    } catch (InvocationTargetException error) {
      Throwable cause = error.getCause();
      if (cause instanceof Exception) throw (Exception) cause;
      throw error;
    }
  }

  private static String roundTrip(String value) {
    byte[] encoded = Base64.getEncoder().encode(
        value.getBytes(StandardCharsets.UTF_8));
    return new String(Base64.getDecoder().decode(encoded), StandardCharsets.UTF_8);
  }

  public static void main(String[] args) throws Exception {
    processLocal += 1;
    ThreadLocal<String> local = new ThreadLocal<>();
    local.set("warm");
    System.setProperty("tracecode.harness.warmup", "mutated");
    List<Integer> values = new ArrayList<>();
    values.add(Integer.valueOf(1));
    values.add(Integer.valueOf(2));
    values.add(Integer.valueOf(3));
    int total = 0;
    for (Integer value : values) total = invokeAdd(total, value.intValue());
    System.out.print(roundTrip(
        "${WARMUP_STDOUT}:" + total + ":" + processLocal + ":" + local.get()));
  }
}
`;

function elapsedSince(startedAt: number): number {
  return performance.now() - startedAt;
}

async function performWarmup(
  client: TraceJVMHarnessClient,
): Promise<TraceJVMHarnessWarmupResult> {
  const startedAt = performance.now();
  const initialization = await client.initialize?.();
  const compileStartedAt = performance.now();
  const compile = await client.compile({
    sources: [{
      path: 'tracecode/harness/warmup/TraceJVMHarnessWarmup.java',
      content: WARMUP_SOURCE,
    }],
  });
  const compileMs = elapsedSince(compileStartedAt);
  if (
    compile.status !== 'completed' ||
    compile.exitCode !== 0 ||
    !compile.program
  ) {
    throw new Error(
      compile.stderr ||
      compile.stdout ||
      `TraceJVM harness warmup compilation ended with ${compile.status}.`
    );
  }

  const runStartedAt = performance.now();
  const run = await client.run({
    program: compile.program,
    mainClass: WARMUP_CLASS,
  });
  const runMs = elapsedSince(runStartedAt);
  if (
    run.status !== 'completed' ||
    run.exitCode !== 0 ||
    run.stdout !== `${WARMUP_STDOUT}:6:1:warm`
  ) {
    throw new Error(
      run.stderr ||
      `TraceJVM harness warmup execution ended with ${run.status}: ${JSON.stringify(run.stdout)}.`
    );
  }
  if (
    run.isolation.status !== 'clean' ||
    run.isolation.hardBoundaryRecommended
  ) {
    throw new Error(
      `TraceJVM harness warmup did not leave a reusable isolated VM: ${JSON.stringify(run.isolation)}.`
    );
  }
  if (run.retirementRecommended) {
    throw new Error(
      'TraceJVM harness warmup exhausted the configured execution boundary; ' +
      'the client must allow at least one learner execution after warmup.'
    );
  }

  return {
    totalMs: elapsedSince(startedAt),
    runtimeInitializeMs: initialization?.initializeMs ?? run.timings.runtimeInitMs,
    compileMs,
    runMs,
  };
}

/**
 * Initializes and exercises javac plus one isolated Java process exactly once
 * per client. Callers may start this in the background; commands can await the
 * same promise without duplicating work.
 */
export function warmTraceJVMHarnessClient(
  client: TraceJVMHarnessClient,
): Promise<TraceJVMHarnessWarmupResult> {
  const identity = client as object;
  const existing = warmupGates.get(identity);
  if (existing) return existing;
  const gate = performWarmup(client);
  warmupGates.set(identity, gate);
  void gate.catch(() => {
    if (warmupGates.get(identity) === gate) warmupGates.delete(identity);
  });
  return gate;
}

/**
 * A retired, aborted, or failed Worker is a new cold runtime boundary even
 * when its host client object is reused. Invalidate before admitting another
 * learner process so the replacement Worker receives the same warmup.
 */
export function invalidateTraceJVMHarnessWarmup(
  client: TraceJVMHarnessClient,
): void {
  warmupGates.delete(client as object);
}

import * as Effect from 'effect/Effect';
import { TraceKernelRuntimeUnavailableError } from '../errors';
import type {
  TraceKernelRuntimeFactory,
  TraceKernelRuntimeLease,
  TraceKernelRuntimeName,
  TraceKernelRuntimeProcessContext,
  TraceKernelRuntimeProvider,
} from '../model';

export interface TraceKernelRuntimeProviderSlot {
  readonly provider: TraceKernelRuntimeProvider;
  readonly initialize: Effect.Effect<TraceKernelRuntimeFactory, Error>;
}

export function makeTraceKernelRuntimeProviderSlots(
  providers: readonly TraceKernelRuntimeProvider[]
): Effect.Effect<
  ReadonlyMap<TraceKernelRuntimeName, TraceKernelRuntimeProviderSlot>
> {
  return Effect.forEach(providers, (provider) =>
    Effect.cached(provider.initialize).pipe(
      Effect.map((initialize) => [provider.runtime, { provider, initialize }] as const)
    )
  ).pipe(
    Effect.map((entries) => new Map(entries))
  );
}

export function acquireTraceKernelRuntimeLease(
  slots: ReadonlyMap<TraceKernelRuntimeName, TraceKernelRuntimeProviderSlot>,
  runtime: TraceKernelRuntimeName,
  process: TraceKernelRuntimeProcessContext
): Effect.Effect<
  TraceKernelRuntimeLease,
  TraceKernelRuntimeUnavailableError | Error
> {
  const slot = slots.get(runtime);
  if (!slot) {
    return Effect.fail(new TraceKernelRuntimeUnavailableError({
      runtime,
      message: `Runtime provider ${JSON.stringify(runtime)} is not registered.`,
    }));
  }
  return slot.initialize.pipe(
    Effect.flatMap((factory) => factory.acquire(process))
  );
}

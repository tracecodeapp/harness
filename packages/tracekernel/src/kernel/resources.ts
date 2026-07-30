import type { TraceKernelPipe } from '../descriptors';
import type { TraceKernelTerminal } from '../terminal';
import type { TraceKernelOpenFileDescription } from '../vfs';

export type TraceKernelSessionResource =
  | TraceKernelPipe
  | TraceKernelOpenFileDescription
  | TraceKernelTerminal;

/**
 * Session-local resource identity and lookup.
 *
 * Descriptor tables own references to resources; this registry owns the
 * session-wide identity namespace used to attach, inspect, and dispose them.
 */
export class TraceKernelResourceRegistry {
  private readonly resources = new Map<
    string,
    TraceKernelSessionResource
  >();
  private nextResourceId = 1;

  allocateId(prefix: string): string {
    return `${prefix}-${this.nextResourceId++}`;
  }

  set(id: string, resource: TraceKernelSessionResource): void {
    this.resources.set(id, resource);
  }

  get(id: string): TraceKernelSessionResource | undefined {
    return this.resources.get(id);
  }

  delete(id: string): boolean {
    return this.resources.delete(id);
  }

  keys(): IterableIterator<string> {
    return this.resources.keys();
  }

  values(): IterableIterator<TraceKernelSessionResource> {
    return this.resources.values();
  }

  clear(): void {
    this.resources.clear();
  }
}

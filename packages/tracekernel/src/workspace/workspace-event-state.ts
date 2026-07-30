import type {
  KernelJournalRecord,
  RuntimeCommandEvent,
  RuntimeWorkspaceEventHandler,
  RuntimeWorkspaceUnsubscribe,
} from '@tracecode/runtime-core';

const DEFAULT_WORKSPACE_EVENT_LOG_LIMIT = 256;

type DistributiveOmit<T, K extends keyof any> =
  T extends unknown ? Omit<T, K> : never;

export type KernelJournalEntry = DistributiveOmit<
  KernelJournalRecord,
  'seq' | 'ts'
>;

export interface WorkspaceKernelEventRecord {
  seq: number;
  time: string;
  type: string;
  pid?: number;
  detail?: Record<string, unknown>;
}

/**
 * Owns the bounded event streams emitted by one workspace session.
 *
 * Attribution remains with the workspace orchestration layer because it needs
 * authoritative process snapshots. Sequence allocation, retention, watchers,
 * and journal reads live here so lifecycle teardown has one clear boundary.
 */
export class WorkspaceEventState {
  private readonly limit: number;
  private readonly kernelEventLog: WorkspaceKernelEventRecord[] = [];
  private readonly kernelJournalLog: KernelJournalRecord[] = [];
  private readonly watchers = new Set<RuntimeWorkspaceEventHandler>();
  private nextKernelEventSeq = 1;
  private nextJournalSeq = 1;

  constructor(limit = DEFAULT_WORKSPACE_EVENT_LOG_LIMIT) {
    this.limit = Math.max(1, Math.trunc(limit));
  }

  recordKernelEvent(
    event: Omit<WorkspaceKernelEventRecord, 'seq' | 'time'>
  ): WorkspaceKernelEventRecord {
    const record: WorkspaceKernelEventRecord = {
      seq: this.nextKernelEventSeq++,
      time: new Date().toISOString(),
      ...event,
    };
    this.kernelEventLog.push(record);
    this.trim(this.kernelEventLog);
    return record;
  }

  recordJournal(entry: KernelJournalEntry): KernelJournalRecord {
    const record = {
      seq: this.nextJournalSeq++,
      ...entry,
    } as KernelJournalRecord;
    this.kernelJournalLog.push(record);
    this.trim(this.kernelJournalLog);
    return record;
  }

  kernelEvents(): readonly WorkspaceKernelEventRecord[] {
    return this.kernelEventLog;
  }

  journal(sinceSeq?: number): readonly KernelJournalRecord[] {
    if (sinceSeq === undefined) return [...this.kernelJournalLog];
    return this.kernelJournalLog.filter((record) => record.seq > sinceSeq);
  }

  dispatch(event: RuntimeCommandEvent): void {
    for (const watcher of this.watchers) {
      watcher(event);
    }
  }

  watch(
    listener: RuntimeWorkspaceEventHandler
  ): RuntimeWorkspaceUnsubscribe {
    this.watchers.add(listener);
    return () => {
      this.watchers.delete(listener);
    };
  }

  clearWatchers(): void {
    this.watchers.clear();
  }

  private trim<T>(records: T[]): void {
    if (records.length > this.limit) {
      records.splice(0, records.length - this.limit);
    }
  }
}

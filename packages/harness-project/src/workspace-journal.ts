import {
  runtimeHttpRequestText,
  runtimeHttpResponseText,
  type KernelJournalRecord,
  type RuntimeCommandFileChangeEvent,
  type RuntimeKernelHttpRequest,
  type RuntimeKernelHttpResponse,
  type RuntimeWorkspaceActor,
} from '@tracecode/harness-core';
import type {
  TraceKernelFileSystemMutation,
  TraceKernelProcessSnapshot,
} from '@tracecode/tracekernel';
import {
  isRuntimeDirectoryChange,
  type RuntimeCommandExecutionContext,
} from './fs-observed';
import {
  stableKernelJournalFingerprint,
} from './http-state';
import {
  isWithinWorkspace,
  toProjectPath,
} from './paths';
import type {
  RuntimeKernelProcessRecord,
} from './process-state';
import {
  type KernelJournalEntry,
  type WorkspaceEventState,
} from './workspace-event-state';
import { workspaceHttpPolicy } from './http-policy';

export interface WorkspaceJournalOptions {
  readonly cwd: string;
  readonly eventState: WorkspaceEventState;
  readonly systemActor: RuntimeWorkspaceActor;
  readonly authoritativeProcessSnapshot: (
    process: { readonly pid: number }
  ) => TraceKernelProcessSnapshot | undefined;
  readonly resolveFileSystemMutationProcess: (
    mutation: TraceKernelFileSystemMutation
  ) =>
    | {
        readonly process: RuntimeKernelProcessRecord;
        readonly snapshot: TraceKernelProcessSnapshot;
      }
    | undefined;
  readonly emitJournalEvent: (
    record: KernelJournalRecord,
    actor: RuntimeWorkspaceActor | undefined,
    commandContext?: RuntimeCommandExecutionContext
  ) => void;
}

/**
 * Attributes and records the observable journal for one workspace.
 *
 * Process and filesystem state stay authoritative in TraceKernel. The journal
 * receives snapshots through callbacks and owns only attribution, redaction,
 * fingerprints, and the append-only event projection.
 */
export class WorkspaceJournal {
  constructor(private readonly options: WorkspaceJournalOptions) {}

  actorId(actor: RuntimeWorkspaceActor | undefined): string | undefined {
    return actor ? `${actor.kind}:${actor.id}` : undefined;
  }

  actorFromProcess(
    process: TraceKernelProcessSnapshot,
    hintedActor?: RuntimeWorkspaceActor
  ): RuntimeWorkspaceActor {
    if (
      hintedActor &&
      hintedActor.id === process.owner.id &&
      this.principalKind(hintedActor) === process.owner.kind
    ) {
      return hintedActor;
    }
    const kind: RuntimeWorkspaceActor['kind'] =
      process.owner.kind === 'system'
        ? 'system'
        : process.owner.kind === 'user'
          ? 'principal'
          : process.owner.kind === 'agent'
            ? 'runtime'
            : 'test';
    return { id: process.owner.id, kind };
  }

  record(
    entry: KernelJournalEntry,
    commandContext?: RuntimeCommandExecutionContext,
    actor?: RuntimeWorkspaceActor,
    attributedProcess?: TraceKernelProcessSnapshot
  ): KernelJournalRecord {
    const process =
      attributedProcess ??
      (commandContext?.process
        ? this.options.authoritativeProcessSnapshot(
            commandContext.process
          )
        : 'pid' in entry && entry.pid !== undefined
          ? this.options.authoritativeProcessSnapshot({
              pid: entry.pid,
            })
          : undefined);
    const authoritativeActor = process
      ? this.actorFromProcess(process, actor)
      : actor;
    const attributedEntry = process
      ? this.authoritativeEntry(
          entry,
          process,
          authoritativeActor!
        )
      : entry;
    const record =
      this.options.eventState.recordJournal(attributedEntry);
    this.options.emitJournalEvent(
      record,
      authoritativeActor,
      commandContext
    );
    return record;
  }

  recordFileChange(
    event: RuntimeCommandFileChangeEvent,
    commandContext?: RuntimeCommandExecutionContext,
    process: RuntimeKernelProcessRecord | undefined =
      commandContext?.process as RuntimeKernelProcessRecord | undefined
  ): void {
    const actor =
      event.actor ??
      commandContext?.actor ??
      this.options.systemActor;
    const change = event.change;
    const op = isRuntimeDirectoryChange(change)
      ? change.deleted === true
        ? 'rmdir'
        : 'mkdir'
      : 'deleted' in change && change.deleted === true
        ? 'delete'
        : 'write';
    this.record(
      {
        kind: 'fs',
        op,
        path: change.path,
        actor: this.actorId(actor) ?? 'system:system',
        ...(process?.pid !== undefined
          ? { pid: process.pid }
          : {}),
        ...(event.phase ? { phase: event.phase } : {}),
      },
      commandContext,
      actor
    );
  }

  recordFileSystemMutation(
    mutation: TraceKernelFileSystemMutation
  ): void {
    const resolved =
      this.options.resolveFileSystemMutationProcess(mutation);
    if (!resolved) return;
    const { process, snapshot } = resolved;
    const actor = this.actorFromProcess(snapshot, process.actor);
    const op: Extract<
      KernelJournalRecord,
      { kind: 'fs' }
    >['op'] =
      mutation.operation === 'mkdir'
        ? 'mkdir'
        : mutation.operation === 'rmdir'
          ? 'rmdir'
          : mutation.operation === 'unlink'
            ? 'delete'
            : mutation.operation === 'rename'
              ? 'rename'
              : 'write';
    const paths =
      mutation.operation === 'rename'
        ? mutation.paths.slice(0, 1)
        : mutation.paths;
    for (const path of paths) {
      if (!isWithinWorkspace(this.options.cwd, path)) continue;
      this.record(
        {
          kind: 'fs',
          op,
          path: toProjectPath(this.options.cwd, path),
          actor: this.actorId(actor) ?? 'system:system',
          pid: snapshot.pid,
          phase: 'live',
        },
        undefined,
        actor,
        snapshot
      );
    }
  }

  recordHttp(
    normalizedRequest: RuntimeKernelHttpRequest,
    url: URL,
    via: Extract<KernelJournalRecord, { kind: 'http' }>['via'],
    actor: RuntimeWorkspaceActor,
    commandContext: RuntimeCommandExecutionContext | undefined,
    result: {
      status?: number;
      annotation?: unknown;
      error?: string;
      response?: RuntimeKernelHttpResponse;
    }
  ): void {
    const meta = this.httpMeta(
      normalizedRequest,
      result.response
    );
    this.record(
      {
        kind: 'http',
        op: 'request',
        method: normalizedRequest.method,
        host: url.hostname
          .replace(/^\[|\]$/g, '')
          .toLowerCase(),
        path: url.pathname || '/',
        ...(result.status !== undefined
          ? { status: result.status }
          : {}),
        via,
        ...(this.actorId(actor)
          ? { actor: this.actorId(actor) }
          : {}),
        ...(commandContext?.process.pid !== undefined
          ? { pid: commandContext.process.pid }
          : {}),
        ...this.httpAuth(normalizedRequest.headers),
        ...(result.annotation !== undefined
          ? { annotation: result.annotation }
          : {}),
        ...(result.error !== undefined
          ? {
              error: this.httpError(
                result.error,
                normalizedRequest.headers
              ),
            }
          : {}),
        ...(meta ? { meta } : {}),
      },
      commandContext,
      actor
    );
  }

  journal(sinceSeq?: number): readonly KernelJournalRecord[] {
    return this.options.eventState.journal(sinceSeq);
  }

  private principalKind(
    actor: RuntimeWorkspaceActor
  ): TraceKernelProcessSnapshot['owner']['kind'] {
    return actor.kind === 'system'
      ? 'system'
      : actor.kind === 'test' || actor.kind === 'hidden-test'
        ? 'grader'
        : actor.kind === 'runtime'
          ? 'agent'
          : 'user';
  }

  private authoritativeEntry(
    entry: KernelJournalEntry,
    process: TraceKernelProcessSnapshot,
    actor: RuntimeWorkspaceActor
  ): KernelJournalEntry {
    const actorId = this.actorId(actor);
    switch (entry.kind) {
      case 'fs':
        return {
          ...entry,
          pid: process.pid,
          actor: actorId ?? 'system:system',
        };
      case 'process':
        return {
          ...entry,
          pid: process.pid,
          ...(entry.op === 'exec'
            ? {
                ppid: process.ppid,
                cwd: process.cwd,
              }
            : {}),
          ...(actorId ? { actor: actorId } : {}),
        };
      case 'http':
        return {
          ...entry,
          pid: process.pid,
          ...(actorId ? { actor: actorId } : {}),
        };
    }
  }

  private httpAuth(
    headers: Record<string, string> | undefined
  ): Pick<
    Extract<KernelJournalRecord, { kind: 'http' }>,
    'authPresent' | 'authFingerprint'
  > {
    const authorization = headers?.authorization;
    if (!authorization) return { authPresent: false };
    return {
      authPresent: true,
      authFingerprint:
        stableKernelJournalFingerprint(authorization),
    };
  }

  private httpError(
    error: string,
    headers: Record<string, string> | undefined
  ): string {
    let message =
      workspaceHttpPolicy.sanitizeDiagnosticField(error);
    const authorization = headers?.authorization;
    if (authorization) {
      message = message.split(authorization).join('redacted');
    }
    return message;
  }

  private headerValue(
    headers: Record<string, string> | undefined,
    name: string
  ): string | undefined {
    if (!headers) return undefined;
    const needle = name.toLowerCase();
    for (const [headerName, value] of Object.entries(headers)) {
      if (headerName.toLowerCase() === needle) return value;
    }
    return undefined;
  }

  private httpMeta(
    request: RuntimeKernelHttpRequest,
    response?: RuntimeKernelHttpResponse
  ): Extract<
    KernelJournalRecord,
    { kind: 'http' }
  >['meta'] | undefined {
    type HttpMeta = NonNullable<
      Extract<KernelJournalRecord, { kind: 'http' }>['meta']
    >;
    const meta: HttpMeta = {};
    const idempotencyKey = this.headerValue(
      request.headers,
      'idempotency-key'
    );
    const contentType = this.headerValue(
      request.headers,
      'content-type'
    );
    const retryAfter = this.headerValue(
      response?.headers,
      'retry-after'
    );
    const rateLimitLimit = this.headerValue(
      response?.headers,
      'x-ratelimit-limit'
    );
    const rateLimitRemaining = this.headerValue(
      response?.headers,
      'x-ratelimit-remaining'
    );
    const rateLimitReset = this.headerValue(
      response?.headers,
      'x-ratelimit-reset'
    );
    if (idempotencyKey !== undefined) {
      meta.idempotencyKeyFingerprint =
        stableKernelJournalFingerprint(idempotencyKey);
    }
    if (request.body !== undefined) {
      meta.requestBodyFingerprint =
        stableKernelJournalFingerprint(
          runtimeHttpRequestText(request)
        );
    }
    if (
      response?.body !== undefined &&
      (idempotencyKey !== undefined ||
        request.body !== undefined)
    ) {
      meta.responseBodyFingerprint =
        stableKernelJournalFingerprint(
          runtimeHttpResponseText(response)
        );
    }
    if (contentType !== undefined) meta.contentType = contentType;
    if (retryAfter !== undefined) meta.retryAfter = retryAfter;
    const rateLimit: NonNullable<HttpMeta['rateLimit']> = {};
    if (rateLimitLimit !== undefined) {
      rateLimit.limit = rateLimitLimit;
    }
    if (rateLimitRemaining !== undefined) {
      rateLimit.remaining = rateLimitRemaining;
    }
    if (rateLimitReset !== undefined) {
      rateLimit.reset = rateLimitReset;
    }
    if (Object.keys(rateLimit).length > 0) {
      meta.rateLimit = rateLimit;
    }
    return Object.keys(meta).length > 0 ? meta : undefined;
  }
}

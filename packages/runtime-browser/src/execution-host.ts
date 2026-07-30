export const BROWSER_EXECUTION_HOST_PROTOCOL = 'tracecode.browser-execution-host.v1';

export interface BrowserWorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export type BrowserWorkerFactory = (
  url: string | URL,
  options?: WorkerOptions
) => BrowserWorkerLike;

export interface BrowserExecutionWorkerHostOptions {
  /** HTML endpoint on a dedicated credential-free execution origin. */
  url: string;
  /** Exact expected origin; defaults to the origin parsed from url. */
  targetOrigin?: string;
  /** Parent element for the hidden host frame. Defaults to document.body. */
  parent?: HTMLElement;
  handshakeTimeoutMs?: number;
  /**
   * Credentialless iframes avoid ambient cookies where supported. Dedicated
   * execution origins must still be configured without application secrets.
   */
  credentialless?: boolean;
  /** Test-only escape hatch; production Java project hosting requires COOP/COEP. */
  allowUnisolatedForTesting?: boolean;
  document?: Document;
  window?: Window;
}

export interface BrowserExecutionWorkerHost {
  readonly origin: string;
  readonly workerFactory: BrowserWorkerFactory;
  ready(): Promise<void>;
  dispose(): void;
}

type ParentToHostMessage =
  | {
      protocol: typeof BROWSER_EXECUTION_HOST_PROTOCOL;
      type: 'create-worker';
      workerId: string;
      url: string;
      options?: WorkerOptions;
    }
  | {
      protocol: typeof BROWSER_EXECUTION_HOST_PROTOCOL;
      type: 'worker-post-message';
      workerId: string;
      data: unknown;
    }
  | {
      protocol: typeof BROWSER_EXECUTION_HOST_PROTOCOL;
      type: 'terminate-worker';
      workerId: string;
    }
  | {
      protocol: typeof BROWSER_EXECUTION_HOST_PROTOCOL;
      type: 'dispose';
    };

type HostToParentMessage =
  | {
      protocol: typeof BROWSER_EXECUTION_HOST_PROTOCOL;
      type: 'host-ready';
      token: string;
    }
  | {
      protocol: typeof BROWSER_EXECUTION_HOST_PROTOCOL;
      type: 'worker-message';
      workerId: string;
      data: unknown;
    }
  | {
      protocol: typeof BROWSER_EXECUTION_HOST_PROTOCOL;
      type: 'worker-error';
      workerId: string;
      error: {
        message: string;
        filename?: string;
        lineno?: number;
        colno?: number;
      };
    };

function secureRandomToken(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Browser execution hosts require crypto.getRandomValues().');
  }
  const values = new Uint32Array(4);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('');
}

function exactHttpOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP(S) URL or origin.`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin === 'null') {
    throw new TypeError(`${label} must use HTTP or HTTPS.`);
  }
  return parsed.origin;
}

class RemoteBrowserWorker implements BrowserWorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;

  constructor(
    readonly id: string,
    private readonly send: (message: ParentToHostMessage, transfer?: Transferable[]) => void,
    url: string | URL,
    options?: WorkerOptions
  ) {
    this.send({
      protocol: BROWSER_EXECUTION_HOST_PROTOCOL,
      type: 'create-worker',
      workerId: id,
      url: String(url),
      ...(options ? { options } : {}),
    });
  }

  postMessage(data: unknown, transfer?: Transferable[]): void {
    if (this.terminated) {
      throw new Error('Remote execution-host worker has been terminated.');
    }
    this.send({
      protocol: BROWSER_EXECUTION_HOST_PROTOCOL,
      type: 'worker-post-message',
      workerId: this.id,
      data,
    }, transfer);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.send({
      protocol: BROWSER_EXECUTION_HOST_PROTOCOL,
      type: 'terminate-worker',
      workerId: this.id,
    });
  }

  deliverMessage(data: unknown): void {
    if (this.terminated) return;
    this.onmessage?.({ data } as MessageEvent);
  }

  deliverError(error: Extract<HostToParentMessage, { type: 'worker-error' }>['error']): void {
    if (this.terminated) return;
    const event = typeof ErrorEvent === 'function'
      ? new ErrorEvent('error', error)
      : ({ type: 'error', ...error } as ErrorEvent);
    this.onerror?.(event);
  }
}

export function createBrowserExecutionWorkerHost(
  options: BrowserExecutionWorkerHostOptions
): BrowserExecutionWorkerHost {
  const windowObject = options.window ?? globalThis.window;
  const documentObject = options.document ?? globalThis.document;
  if (!windowObject || !documentObject) {
    throw new Error('Browser execution hosts require a Window and Document.');
  }
  if (!options.allowUnisolatedForTesting && globalThis.crossOriginIsolated !== true) {
    throw new Error(
      'Browser execution hosts require cross-origin isolation (COOP: same-origin and COEP: require-corp or credentialless).'
    );
  }
  const frameUrl = new URL(options.url, windowObject.location.href);
  const targetOrigin = options.targetOrigin
    ? exactHttpOrigin(options.targetOrigin, 'Browser execution host targetOrigin')
    : exactHttpOrigin(frameUrl.href, 'Browser execution host url');
  if (frameUrl.origin !== targetOrigin) {
    throw new TypeError('Browser execution host url must match targetOrigin.');
  }
  if (frameUrl.origin === windowObject.location.origin) {
    throw new Error('Browser execution host must use a different origin from the application.');
  }
  const parent = options.parent ?? documentObject.body;
  if (!parent) {
    throw new Error('Browser execution host requires document.body or an explicit parent element.');
  }

  const iframe = documentObject.createElement('iframe');
  iframe.hidden = true;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.referrerPolicy = 'no-referrer';
  if (options.credentialless !== false && 'credentialless' in iframe) {
    (iframe as HTMLIFrameElement & { credentialless: boolean }).credentialless = true;
  }
  iframe.src = frameUrl.href;

  const token = secureRandomToken();
  const channel = new MessageChannel();
  const workers = new Map<string, RemoteBrowserWorker>();
  const queuedMessages: Array<{ message: ParentToHostMessage; transfer?: Transferable[] }> = [];
  let disposed = false;
  let ready = false;
  let nextWorkerId = 0;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timeoutId = globalThis.setTimeout(() => {
    if (ready || disposed) return;
    readyReject?.(new Error('Browser execution host handshake timed out.'));
  }, options.handshakeTimeoutMs ?? 15_000);

  const send = (message: ParentToHostMessage, transfer?: Transferable[]): void => {
    if (disposed) throw new Error('Browser execution host has been disposed.');
    if (!ready) {
      queuedMessages.push({ message, ...(transfer?.length ? { transfer } : {}) });
      return;
    }
    channel.port1.postMessage(message, transfer ?? []);
  };

  channel.port1.onmessage = (event: MessageEvent<HostToParentMessage>) => {
    const message = event.data;
    if (!message || message.protocol !== BROWSER_EXECUTION_HOST_PROTOCOL) return;
    if (message.type === 'host-ready') {
      if (message.token !== token) return;
      if (ready) return;
      ready = true;
      globalThis.clearTimeout(timeoutId);
      readyResolve?.();
      for (const queued of queuedMessages.splice(0)) {
        channel.port1.postMessage(queued.message, queued.transfer ?? []);
      }
      return;
    }
    const worker = workers.get(message.workerId);
    if (!worker) return;
    if (message.type === 'worker-message') {
      worker.deliverMessage(message.data);
    } else if (message.type === 'worker-error') {
      worker.deliverError(message.error);
    }
  };
  channel.port1.start();

  iframe.addEventListener('load', () => {
    if (disposed || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(
      {
        protocol: BROWSER_EXECUTION_HOST_PROTOCOL,
        type: 'connect',
        token,
      },
      targetOrigin,
      [channel.port2]
    );
  }, { once: true });
  parent.appendChild(iframe);

  const workerFactory: BrowserWorkerFactory = (url, workerOptions) => {
    if (disposed) throw new Error('Browser execution host has been disposed.');
    const id = `worker-${++nextWorkerId}-${token}`;
    const worker = new RemoteBrowserWorker(id, send, url, workerOptions);
    workers.set(id, worker);
    return worker;
  };

  return Object.freeze({
    origin: targetOrigin,
    workerFactory,
    ready: () => readyPromise,
    dispose() {
      if (disposed) return;
      globalThis.clearTimeout(timeoutId);
      if (!ready) readyReject?.(new Error('Browser execution host was disposed before it became ready.'));
      if (ready) {
        channel.port1.postMessage({ protocol: BROWSER_EXECUTION_HOST_PROTOCOL, type: 'dispose' });
      }
      disposed = true;
      channel.port1.close();
      workers.clear();
      iframe.remove();
    },
  });
}

function transferableValues(value: unknown, ports: readonly MessagePort[] = []): Transferable[] {
  const transferables = new Set<Transferable>(ports);
  const visited = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || visited.has(candidate)) return;
    visited.add(candidate);
    if (candidate instanceof ArrayBuffer) {
      transferables.add(candidate);
      return;
    }
    if (ArrayBuffer.isView(candidate)) {
      if (candidate.buffer instanceof ArrayBuffer) transferables.add(candidate.buffer);
      return;
    }
    if (typeof MessagePort !== 'undefined' && candidate instanceof MessagePort) {
      transferables.add(candidate);
      return;
    }
    const constructorName = (candidate as { constructor?: { name?: string } }).constructor?.name;
    if (
      constructorName === 'ImageBitmap' ||
      constructorName === 'OffscreenCanvas' ||
      constructorName === 'ReadableStream' ||
      constructorName === 'WritableStream' ||
      constructorName === 'TransformStream' ||
      constructorName === 'AudioData' ||
      constructorName === 'VideoFrame'
    ) {
      transferables.add(candidate as Transferable);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const item of Object.values(candidate as Record<string, unknown>)) visit(item);
  };
  visit(value);
  return Array.from(transferables);
}

export interface InstallBrowserExecutionWorkerHostOptions {
  allowedParentOrigins: readonly string[];
  allowedWorkerOrigins?: readonly string[];
  window?: Window;
  workerFactory?: BrowserWorkerFactory;
}

export interface InstalledBrowserExecutionWorkerHost {
  dispose(): void;
}

export function installBrowserExecutionWorkerHost(
  options: InstallBrowserExecutionWorkerHostOptions
): InstalledBrowserExecutionWorkerHost {
  const windowObject = options.window ?? globalThis.window;
  if (!windowObject) throw new Error('Execution worker host installation requires a Window.');
  const allowedParentOrigins = new Set(
    options.allowedParentOrigins.map((origin) => exactHttpOrigin(origin, 'allowedParentOrigins entry'))
  );
  if (allowedParentOrigins.size === 0) {
    throw new TypeError('Execution worker host requires at least one allowed parent origin.');
  }
  const allowedWorkerOrigins = new Set(
    (options.allowedWorkerOrigins ?? [windowObject.location.origin]).map(
      (origin) => exactHttpOrigin(origin, 'allowedWorkerOrigins entry')
    )
  );
  const createWorker: BrowserWorkerFactory = options.workerFactory ?? ((url, workerOptions) => (
    new Worker(url, workerOptions)
  ));
  const connections = new Set<{ port: MessagePort; workers: Map<string, BrowserWorkerLike> }>();

  const closeConnection = (connection: { port: MessagePort; workers: Map<string, BrowserWorkerLike> }) => {
    for (const worker of connection.workers.values()) worker.terminate();
    connection.workers.clear();
    connection.port.close();
    connections.delete(connection);
  };

  const connect = (event: MessageEvent) => {
    const message = event.data as { protocol?: unknown; type?: unknown; token?: unknown } | undefined;
    if (
      !message ||
      message.protocol !== BROWSER_EXECUTION_HOST_PROTOCOL ||
      message.type !== 'connect' ||
      typeof message.token !== 'string' ||
      !allowedParentOrigins.has(event.origin) ||
      event.source !== windowObject.parent
    ) {
      return;
    }
    const port = event.ports[0];
    if (!port) return;
    const connection = { port, workers: new Map<string, BrowserWorkerLike>() };
    connections.add(connection);
    port.onmessage = (portEvent: MessageEvent<ParentToHostMessage>) => {
      const request = portEvent.data;
      if (!request || request.protocol !== BROWSER_EXECUTION_HOST_PROTOCOL) return;
      if (request.type === 'dispose') {
        closeConnection(connection);
        return;
      }
      if (request.type === 'create-worker') {
        if (connection.workers.has(request.workerId)) return;
        const workerUrl = new URL(request.url, windowObject.location.href);
        if (
          (workerUrl.protocol !== 'http:' && workerUrl.protocol !== 'https:') ||
          !allowedWorkerOrigins.has(workerUrl.origin)
        ) {
          port.postMessage({
            protocol: BROWSER_EXECUTION_HOST_PROTOCOL,
            type: 'worker-error',
            workerId: request.workerId,
            error: { message: `Execution host rejected worker origin ${JSON.stringify(workerUrl.origin)}.` },
          } satisfies HostToParentMessage);
          return;
        }
        try {
          const worker = createWorker(workerUrl.href, request.options);
          connection.workers.set(request.workerId, worker);
          worker.onmessage = (workerEvent) => {
            const response = {
              protocol: BROWSER_EXECUTION_HOST_PROTOCOL,
              type: 'worker-message',
              workerId: request.workerId,
              data: workerEvent.data,
            } satisfies HostToParentMessage;
            port.postMessage(response, transferableValues(workerEvent.data, workerEvent.ports));
          };
          worker.onerror = (workerEvent) => {
            port.postMessage({
              protocol: BROWSER_EXECUTION_HOST_PROTOCOL,
              type: 'worker-error',
              workerId: request.workerId,
              error: {
                message: workerEvent.message || 'Execution-host worker error',
                ...(workerEvent.filename ? { filename: workerEvent.filename } : {}),
                ...(workerEvent.lineno ? { lineno: workerEvent.lineno } : {}),
                ...(workerEvent.colno ? { colno: workerEvent.colno } : {}),
              },
            } satisfies HostToParentMessage);
          };
        } catch (error) {
          port.postMessage({
            protocol: BROWSER_EXECUTION_HOST_PROTOCOL,
            type: 'worker-error',
            workerId: request.workerId,
            error: { message: error instanceof Error ? error.message : String(error) },
          } satisfies HostToParentMessage);
        }
        return;
      }
      const worker = connection.workers.get(request.workerId);
      if (!worker) return;
      if (request.type === 'worker-post-message') {
        worker.postMessage(request.data, transferableValues(request.data, portEvent.ports));
      } else if (request.type === 'terminate-worker') {
        worker.terminate();
        connection.workers.delete(request.workerId);
      }
    };
    port.start();
    port.postMessage({
      protocol: BROWSER_EXECUTION_HOST_PROTOCOL,
      type: 'host-ready',
      token: message.token,
    } satisfies HostToParentMessage);
  };
  windowObject.addEventListener('message', connect);

  return Object.freeze({
    dispose() {
      windowObject.removeEventListener('message', connect);
      for (const connection of Array.from(connections)) closeConnection(connection);
    },
  });
}

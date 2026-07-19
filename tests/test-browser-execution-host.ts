import {
  BROWSER_EXECUTION_HOST_PROTOCOL,
  createBrowserExecutionWorkerHost,
  installBrowserExecutionWorkerHost,
  type BrowserWorkerLike,
} from '../packages/harness-browser/src/execution-host';
import { JavaWorkerClient } from '../packages/harness-browser/src/java-worker-client';
import { PythonWorkerClient } from '../packages/harness-browser/src/pyodide-worker-client';
import { JavaScriptWorkerClient } from '../packages/harness-browser/src/javascript-worker-client';
import { CSharpWorkerClient } from '../packages/harness-browser/src/csharp-worker-client';
import { CppWorkerClient } from '../packages/harness-browser/src/cpp-worker-client';
import { createBrowserJavaScriptProjectRunner } from '../packages/harness-javascript/src/project-browser';

const asJsProjectRequest = (request: object) =>
  request as import('../packages/harness-javascript/src/project-browser').JavaScriptProjectCommandRequest;

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type MessageListener = (event: MessageEvent) => void;

class FakeWindow {
  readonly location: { href: string; origin: string };
  parent: unknown;
  private readonly listeners = new Set<MessageListener>();

  constructor(href: string) {
    const url = new URL(href);
    this.location = { href: url.href, origin: url.origin };
    this.parent = this;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message') this.listeners.add(listener as MessageListener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message') this.listeners.delete(listener as MessageListener);
  }

  emitMessage(data: unknown, origin: string, source: unknown, ports: MessagePort[]): void {
    const event = { data, origin, source, ports } as unknown as MessageEvent;
    for (const listener of this.listeners) listener(event);
  }
}

class FakeIframe {
  hidden = false;
  src = '';
  referrerPolicy = '';
  credentialless = false;
  removed = false;
  readonly attributes = new Map<string, string>();
  private loadListener: (() => void) | undefined;

  constructor(readonly contentWindow: { postMessage(data: unknown, targetOrigin: string, ports: Transferable[]): void }) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'load') this.loadListener = listener as () => void;
  }

  triggerLoad(): void {
    this.loadListener?.();
  }

  remove(): void {
    this.removed = true;
  }
}

class MockWorker implements BrowserWorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: unknown[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;

  constructor() {
    queueMicrotask(() => this.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent));
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.posted.push(message);
    this.transfers.push(transfer);
    const request = message as { id?: string; type?: string; protocolToken?: string; payload?: unknown };
    queueMicrotask(() => {
      if (request.type === 'init') {
        this.onmessage?.({
          data: {
            id: request.id,
            type: 'init',
            protocolToken: request.protocolToken,
            payload: { success: true, loadTimeMs: 1 },
          },
        } as MessageEvent);
        return;
      }
      if (request.type === 'execute-project-java') {
        this.onmessage?.({
          data: {
            id: request.id,
            type: 'project-event',
            protocolToken: request.protocolToken,
            payload: { type: 'output', stream: 'stdout', data: 'remote-event\n' },
          },
        } as MessageEvent);
        this.onmessage?.({
          data: {
            id: request.id,
            type: request.type,
            protocolToken: request.protocolToken,
            payload: { stdout: 'remote-java\n', stderr: '', exitCode: 0, files: [] },
          },
        } as MessageEvent);
        return;
      }
      if (request.type === 'execute-project-javascript') {
        this.onmessage?.({
          data: {
            id: request.id,
            type: request.type,
            protocolToken: request.protocolToken,
            payload: { stdout: 'remote-javascript\n', stderr: '', exitCode: 0, files: [] },
          },
        } as MessageEvent);
        return;
      }
      if (request.id && request.type) {
        this.onmessage?.({
          data: {
            id: request.id,
            type: request.type,
            protocolToken: request.protocolToken,
            payload: { success: true, loadTimeMs: 1 },
          },
        } as MessageEvent);
        return;
      }
      this.onmessage?.({ data: { echoed: message } } as MessageEvent);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function main(): Promise<void> {
  const parentWindow = new FakeWindow('https://app.tracecode.test/editor');
  const executionWindow = new FakeWindow('https://exec.tracecode.test/host');
  executionWindow.parent = parentWindow;
  const createdWorkers: Array<{ url: string; options?: WorkerOptions; worker: MockWorker }> = [];
  const installed = installBrowserExecutionWorkerHost({
    window: executionWindow as unknown as Window,
    allowedParentOrigins: [parentWindow.location.origin],
    workerFactory(url, options) {
      const worker = new MockWorker();
      createdWorkers.push({ url: String(url), ...(options ? { options } : {}), worker });
      return worker;
    },
  });

  const iframe = new FakeIframe({
    postMessage(data, targetOrigin, ports) {
      assertCondition(targetOrigin === executionWindow.location.origin, 'Parent must use the exact execution origin');
      executionWindow.emitMessage(
        data,
        parentWindow.location.origin,
        parentWindow,
        ports as MessagePort[]
      );
    },
  });
  const parentElement = {
    appendChild(node: FakeIframe) {
      assertCondition(node === iframe, 'Unexpected execution iframe');
      queueMicrotask(() => node.triggerLoad());
      return node;
    },
  };
  const documentObject = {
    body: parentElement,
    createElement(name: string) {
      assertCondition(name === 'iframe', 'Execution host must create an iframe');
      return iframe;
    },
  };

  const host = createBrowserExecutionWorkerHost({
    url: executionWindow.location.href,
    window: parentWindow as unknown as Window,
    document: documentObject as unknown as Document,
    parent: parentElement as unknown as HTMLElement,
    allowUnisolatedForTesting: true,
  });
  await host.ready();

  const remote = host.workerFactory('/workers/java-worker.js');
  const echoed = new Promise<unknown>((resolve) => {
    remote.onmessage = (event) => {
      if ((event.data as { echoed?: unknown } | undefined)?.echoed !== undefined) resolve(event.data);
    };
  });
  remote.postMessage({ command: 'init' });
  assertCondition(
    JSON.stringify(await echoed) === JSON.stringify({ echoed: { command: 'init' } }),
    'Execution host must relay worker messages'
  );
  const transferredBytes = new Uint8Array([1, 2, 3, 4]);
  const transferredEcho = new Promise<unknown>((resolve) => {
    remote.onmessage = (event) => {
      if ((event.data as { echoed?: unknown } | undefined)?.echoed !== undefined) resolve(event.data);
    };
  });
  remote.postMessage({ bytes: transferredBytes }, [transferredBytes.buffer]);
  await transferredEcho;
  assertCondition(transferredBytes.byteLength === 0, 'Parent ownership should transfer to the execution host');
  assertCondition(
    createdWorkers[0]?.worker.transfers[1]?.length === 1,
    'Execution host must preserve transfer lists when relaying to workers'
  );
  assertCondition(
    createdWorkers[0]?.url === 'https://exec.tracecode.test/workers/java-worker.js',
    `Worker URL must resolve on the execution origin: ${createdWorkers[0]?.url}`
  );
  assertCondition(
    iframe.attributes.get('sandbox') === 'allow-scripts allow-same-origin' &&
      iframe.referrerPolicy === 'no-referrer',
    'Execution iframe must retain the narrow sandbox/referrer policy'
  );

  remote.terminate();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertCondition(createdWorkers[0]?.worker.terminated === true, 'Remote termination must terminate the hosted worker');

  const javaClient = new JavaWorkerClient({
    workerUrl: '/workers/java-worker.js',
    workerFactory: host.workerFactory,
    isolatedRuntimeStorage: true,
    projectUserAuthorityMode: 'isolated-origin',
  });
  const javaEvents: unknown[] = [];
  const javaResult = await javaClient.executeProjectJava({
    code: 'class Main {}',
    source: 'run',
    scriptPath: 'Main.java',
    args: [],
    cwd: '/workspace',
    env: {},
    project: { files: [{ path: 'Main.java', contents: 'class Main {}\n' }] },
  }, 1_000, (event) => javaEvents.push(event));
  assertCondition(javaResult.stdout === 'remote-java\n' && javaResult.exitCode === 0, 'Java client must run through the remote worker host');
  assertCondition(javaEvents.length === 1, 'Remote Java project events must reach the parent client');
  const remoteJavaInit = createdWorkers[1]?.worker.posted.find(
    (message) => (message as { type?: unknown }).type === 'init'
  ) as { payload?: { allowIsolatedRuntimeStorage?: unknown } } | undefined;
  assertCondition(
    remoteJavaInit?.payload?.allowIsolatedRuntimeStorage === true,
    'Execution-origin Java init must explicitly enable runtime-owned storage'
  );
  const remoteJavaExecution = createdWorkers[1]?.worker.posted.find(
    (message) => (message as { type?: unknown }).type === 'execute-project-java'
  ) as { payload?: { projectUserAuthorityMode?: unknown } } | undefined;
  assertCondition(
    remoteJavaExecution?.payload?.projectUserAuthorityMode === 'isolated-origin',
    'Execution-origin Java commands must declare the isolated-origin authority contract'
  );
  javaClient.terminate();

  const pythonClient = new PythonWorkerClient({
    workerUrl: '/workers/python-worker.js',
    workerFactory: host.workerFactory,
    debug: false,
  });
  const javascriptClient = new JavaScriptWorkerClient({
    workerUrl: '/workers/javascript-worker.js',
    workerFactory: host.workerFactory,
    debug: false,
  });
  const csharpClient = new CSharpWorkerClient({
    workerUrl: '/workers/csharp-worker.js',
    workerFactory: host.workerFactory,
    assetBaseUrl: '/workers/dotnet',
    debug: false,
  });
  const cppClient = new CppWorkerClient({
    workerUrl: '/workers/cpp-worker.js',
    workerFactory: host.workerFactory,
    clangWasmUrl: '/workers/clang.wasm',
    lldWasmUrl: '/workers/lld.wasm',
    sysrootUrl: '/workers/sysroot.tar',
    runtimeHeaderUrl: '/workers/runtime.hpp',
    compilerBundleUrl: '/workers/compiler.js',
    debug: false,
  });
  await Promise.all([
    pythonClient.init(),
    javascriptClient.init(),
    csharpClient.init(),
    cppClient.init(),
  ]);
  const javascriptProjectRunner = createBrowserJavaScriptProjectRunner({
    workerUrl: '/workers/javascript-project-worker.js',
    workerFactory: host.workerFactory,
  });
  const javascriptProjectResult = await javascriptProjectRunner(asJsProjectRequest({
    source: 'run',
    scriptPath: 'index.js',
    args: [],
    cwd: '/workspace',
    env: {},
    project: { files: [{ path: 'index.js', contents: 'console.log("remote")\n' }] },
  }));
  assertCondition(
    javascriptProjectResult.stdout === 'remote-javascript\n',
    `Project JavaScript must execute through the provider-neutral host: ${JSON.stringify(javascriptProjectResult)}`
  );
  assertCondition(
    createdWorkers.some(({ url }) => url.endsWith('/workers/python-worker.js')) &&
      createdWorkers.some(({ url }) => url.includes('/workers/javascript-worker.js')) &&
      createdWorkers.some(({ url }) => url.endsWith('/workers/javascript-project-worker.js')) &&
      createdWorkers.some(({ url }) => url.endsWith('/workers/csharp-worker.js')) &&
      createdWorkers.some(({ url }) => url.endsWith('/workers/cpp-worker.js')),
    'Execution host worker factories must be provider-neutral'
  );
  assertCondition(
    createdWorkers.find(({ url }) => url.endsWith('/workers/csharp-worker.js'))?.options?.type === 'module' &&
      createdWorkers.find(({ url }) => url.endsWith('/workers/cpp-worker.js'))?.options?.type === 'module',
    'Execution host must preserve provider worker construction options'
  );
  pythonClient.terminate();
  javascriptClient.terminate();
  csharpClient.terminate();
  cppClient.terminate();

  const rejected = host.workerFactory('https://evil.example/worker.js');
  const rejectedError = new Promise<string>((resolve) => {
    rejected.onerror = (event) => resolve(event.message);
  });
  assertCondition(
    (await rejectedError).includes('rejected worker origin'),
    'Execution host must reject undeclared worker origins'
  );

  host.dispose();
  installed.dispose();
  assertCondition(iframe.removed, 'Disposing the parent host must remove its iframe');

  let sameOriginError = '';
  try {
    createBrowserExecutionWorkerHost({
      url: parentWindow.location.href,
      window: parentWindow as unknown as Window,
      document: documentObject as unknown as Document,
      parent: parentElement as unknown as HTMLElement,
      allowUnisolatedForTesting: true,
    });
  } catch (error) {
    sameOriginError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(sameOriginError.includes('different origin'), 'Same-origin execution hosts must fail closed');

  console.log('PASS: cross-origin execution worker host protocol, origin policy, and lifecycle');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

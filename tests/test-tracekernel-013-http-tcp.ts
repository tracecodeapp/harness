#!/usr/bin/env npx tsx

import {
  createRuntimeWorkspace,
  runtimeHttpBodyFromBytes,
  runtimeHttpRequestBytes,
  runtimeHttpResponseBytes,
  type KernelJournalRecord,
} from '../packages/harness-project/src/index';
import {
  encodeTraceKernelHttp1Request,
  TraceKernelHttp1Decoder,
  type TraceKernelSyscallRequest,
  type TraceKernelSyscallResult,
  type TraceKernelSyscallValue,
} from '@tracecode/tracekernel';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function syscallValue(
  result: TraceKernelSyscallResult,
  operation: TraceKernelSyscallValue['op']
): TraceKernelSyscallValue {
  assertCondition(
    result.ok && result.value.op === operation,
    `TraceKernel ${operation} syscall failed: ${JSON.stringify(result)}`
  );
  return result.value;
}

async function main(): Promise<void> {
  const workspace = await createRuntimeWorkspace();
  const observedPaths: string[] = [];
  let timeoutSignalAborted = false;
  const listener = workspace.http.listen(
    { host: '127.0.0.1', port: 3860 },
    async (request) => {
      observedPaths.push(request.path);
      assertCondition(
        request.headers?.host === 'localhost:3860',
        `HTTP transport did not synthesize the Host field: ${JSON.stringify(request)}`
      );
      assertCondition(
        request.headers?.['content-length'] ===
          String(runtimeHttpRequestBytes(request).byteLength),
        `HTTP transport did not frame the request body: ${JSON.stringify(request)}`
      );
      assertCondition(
        request.rawHeaders?.some(
          ([name, value]) => name === 'X-Request-Case' && value === 'preserved'
        ),
        `HTTP transport did not preserve raw request header spelling: ${JSON.stringify(request)}`
      );
      await new Promise((resolve) => setTimeout(resolve, request.path.length % 3));
      return {
        status: 207,
        rawHeaders: [
          ['Content-Type', 'application/octet-stream'],
          ['X-Response-Case', request.path],
        ],
        ...runtimeHttpBodyFromBytes(new Uint8Array([0, 255, request.path.length])),
        annotation: { transport: 'tcp', path: request.path },
      };
    }
  );

  try {
    await listener.ready;
    const paths = Array.from({ length: 24 }, (_, index) => `/request/${index}`);
    const responses = await Promise.all(
      paths.map((path) =>
        workspace.http.request({
          method: 'POST',
          url: `http://localhost:3860${path}`,
          rawHeaders: [['X-Request-Case', 'preserved']],
          ...runtimeHttpBodyFromBytes(new Uint8Array([indexFor(path), 0, 255])),
        })
      )
    );
    for (let index = 0; index < responses.length; index += 1) {
      const response = responses[index]!;
      const path = paths[index]!;
      assertCondition(
        response.status === 207,
        `Concurrent HTTP-over-TCP response failed for ${path}: ${JSON.stringify(response)}`
      );
      assertCondition(
        response.headers?.['content-length'] === '3',
        `Response did not traverse bounded HTTP framing: ${JSON.stringify(response)}`
      );
      assertCondition(
        response.rawHeaders?.some(
          ([name, value]) => name === 'X-Response-Case' && value === path
        ),
        `Raw response headers did not survive TCP framing: ${JSON.stringify(response)}`
      );
      assertCondition(
        runtimeHttpResponseBytes(response).join(',') === `0,255,${path.length}`,
        `Binary response did not survive TCP framing: ${JSON.stringify(response)}`
      );
    }
    assertCondition(
      observedPaths.length === paths.length &&
        paths.every((path) => observedPaths.includes(path)),
      `Concurrent TCP accepts lost structured requests: ${JSON.stringify(observedPaths)}`
    );

    const journals = workspace
      .journal()
      .filter(
        (record): record is Extract<KernelJournalRecord, { kind: 'http' }> =>
          record.kind === 'http'
      );
    const annotated = journals.find((record) => record.path === '/request/0');
    assertCondition(
      JSON.stringify(annotated?.annotation) ===
        JSON.stringify({ transport: 'tcp', path: '/request/0' }),
      `Trusted grading annotation was lost across the data-plane migration: ${JSON.stringify(annotated)}`
    );

    const named = workspace.http.listen(
      { host: 'service.example', port: 3861 },
      (request) => ({ status: 200, body: `${new URL(request.url).hostname}\n` })
    );
    try {
      await named.ready;
      const namedResponse = await workspace.http.request({
        url: 'http://service.example:3861/identity',
      });
      assertCondition(
        namedResponse.status === 200 && namedResponse.body === 'service.example\n',
        `Logical scenario hostname did not retain its identity over private TCP: ${JSON.stringify(namedResponse)}`
      );
    } finally {
      named.close();
    }

    const rawListener = workspace.http.listen(
      { host: '127.0.0.1', port: 3863 },
      (request) => ({
        status: 200,
        rawHeaders: [['X-Raw-Transport', request.headers?.host ?? 'missing']],
        body: `raw:${request.method}:${request.path}\n`,
      })
    );
    try {
      await rawListener.ready;
      const dispatch = (
        workspace as unknown as {
          dispatchRuntimeKernelSyscall(
            request: TraceKernelSyscallRequest
          ): Promise<TraceKernelSyscallResult>;
        }
      ).dispatchRuntimeKernelSyscall.bind(workspace);

      const contender = syscallValue(await dispatch({ op: 'socket' }), 'socket');
      assertCondition(contender.op === 'socket', 'socket syscall returned the wrong value');
      const conflict = await dispatch({
        op: 'bind',
        fd: contender.fd,
        address: { host: '127.0.0.1', port: 3863 },
      });
      assertCondition(
        !conflict.ok && conflict.error.code === 'EADDRINUSE',
        `Structured HTTP listener did not own its TCP port: ${JSON.stringify(conflict)}`
      );
      await dispatch({ op: 'close', fd: contender.fd });

      const socket = syscallValue(await dispatch({ op: 'socket' }), 'socket');
      assertCondition(socket.op === 'socket', 'raw client socket was not created');
      await dispatch({
        op: 'connect',
        fd: socket.fd,
        address: { host: '127.0.0.1', port: 3863 },
      });
      const rawRequest = encodeTraceKernelHttp1Request({
        method: 'PATCH',
        target: '/raw-client',
        headers: [{ name: 'Host', value: 'raw.example:3863' }],
        body: new Uint8Array(),
      });
      await dispatch({ op: 'send', fd: socket.fd, bytes: rawRequest });
      await dispatch({ op: 'shutdown', fd: socket.fd, how: 'write' });
      const rawDecoder = new TraceKernelHttp1Decoder('response');
      let rawResponse: ReturnType<typeof rawDecoder.push> = null;
      while (!rawResponse) {
        const received = syscallValue(
          await dispatch({ op: 'recv', fd: socket.fd, maxBytes: 7 }),
          'recv'
        );
        assertCondition(received.op === 'recv', 'recv syscall returned the wrong value');
        rawResponse = received.bytes.byteLength === 0
          ? rawDecoder.finish()
          : rawDecoder.push(received.bytes);
      }
      assertCondition(
        rawResponse.status === 200 &&
          new TextDecoder().decode(rawResponse.body) === 'raw:PATCH:/raw-client\n' &&
          rawResponse.headers.some(
            ({ name, value }) =>
              name === 'X-Raw-Transport' && value === 'raw.example:3863'
          ),
        `Raw TCP client did not reach the structured HTTP service: ${JSON.stringify(rawResponse)}`
      );
      await dispatch({ op: 'close', fd: socket.fd });
    } finally {
      rawListener.close();
    }

    const stalled = workspace.http.listen(
      { host: '127.0.0.1', port: 3862 },
      (request) =>
        new Promise((resolve) => {
          request.signal?.addEventListener(
            'abort',
            () => {
              timeoutSignalAborted = true;
              resolve({ status: 499, body: 'aborted\n' });
            },
            { once: true }
          );
        })
    );
    try {
      await stalled.ready;
      const timedOut = await workspace.http.request({
        url: 'http://localhost:3862/stall',
        timeoutMs: 5,
      });
      assertCondition(
        timedOut.status === 0 && timedOut.error?.code === 'ETIMEDOUT',
        `HTTP-over-TCP timeout did not retain its structured failure: ${JSON.stringify(timedOut)}`
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertCondition(timeoutSignalAborted, 'Timeout did not reach the server handler signal');
    } finally {
      stalled.close();
    }
  } finally {
    listener.close();
    await workspace.destroy();
  }

  console.log(
    JSON.stringify({
      schema: 'tracekernel-013-http-tcp-conformance-v1',
      concurrentRequests: 24,
      binaryBodies: true,
      logicalHosts: true,
      rawTcpClients: true,
      unifiedPortOwnership: true,
      annotations: true,
      cancellation: true,
    })
  );
}

function indexFor(path: string): number {
  const value = Number(path.slice(path.lastIndexOf('/') + 1));
  return Number.isFinite(value) ? value : 0;
}

void main();

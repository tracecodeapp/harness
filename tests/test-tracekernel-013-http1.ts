#!/usr/bin/env npx tsx

import {
  encodeTraceKernelHttp1Request,
  encodeTraceKernelHttp1Response,
  TraceKernelHttp1Decoder,
  TraceKernelHttp1Error,
  type TraceKernelHttp1Message,
} from '@tracecode/tracekernel';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertHttpError(
  operation: () => unknown,
  code: TraceKernelHttp1Error['code'],
  message: string
): void {
  try {
    operation();
  } catch (error) {
    assertCondition(
      error instanceof TraceKernelHttp1Error && error.code === code,
      `${message}: expected ${code}, received ${String(error)}`
    );
    return;
  }
  throw new Error(`${message}: expected ${code}, but operation succeeded`);
}

function decodeFragmented<Kind extends TraceKernelHttp1Message['kind']>(
  kind: Kind,
  bytes: Uint8Array,
  chunkSize: number
): Extract<TraceKernelHttp1Message, { kind: Kind }> {
  const http = new TraceKernelHttp1Decoder(kind);
  let message: Extract<TraceKernelHttp1Message, { kind: Kind }> | null = null;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const next = http.push(bytes.slice(offset, offset + chunkSize));
    if (next) {
      assertCondition(
        offset + chunkSize >= bytes.byteLength,
        `${kind} decoder completed before consuming the frame`
      );
      message = next;
    }
  }
  assertCondition(message !== null, `${kind} decoder did not complete`);
  return message;
}

function main(): void {
  const requestBody = new Uint8Array([0, 1, 2, 127, 128, 255]);
  const encodedRequest = encodeTraceKernelHttp1Request({
    method: 'POST',
    target: '/upload?part=1',
    headers: [
      { name: 'Host', value: '127.0.0.1:8080' },
      { name: 'X-Trace', value: 'first' },
      { name: 'X-Trace', value: 'second' },
    ],
    body: requestBody,
  });
  requestBody.fill(9);

  for (const chunkSize of [1, 2, 3, 7, 64, encodedRequest.byteLength]) {
    const request = decodeFragmented('request', encodedRequest, chunkSize);
    assertCondition(request.method === 'POST', 'Request method did not round-trip');
    assertCondition(
      request.target === '/upload?part=1',
      'Request target did not round-trip'
    );
    assertCondition(
      request.headers.filter((header) => header.name === 'X-Trace').length === 2,
      'Repeated request headers were not preserved'
    );
    assertCondition(
      request.body.join(',') === '0,1,2,127,128,255',
      'Request body was not defensively copied or did not round-trip'
    );
  }

  const responseBody = encoder.encode('created');
  const encodedResponse = encodeTraceKernelHttp1Response({
    status: 201,
    statusText: 'Created',
    headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
    body: responseBody,
  });
  responseBody.fill(0);
  const response = decodeFragmented('response', encodedResponse, 1);
  assertCondition(response.status === 201, 'Response status did not round-trip');
  assertCondition(response.statusText === 'Created', 'Response status text did not round-trip');
  assertCondition(decoder.decode(response.body) === 'created', 'Response body did not round-trip');

  const duplicateLength = encoder.encode(
    'POST / HTTP/1.1\r\nContent-Length: 3\r\nContent-Length: 3\r\n\r\nabc'
  );
  assertCondition(
    decoder.decode(decodeFragmented('request', duplicateLength, 2).body) === 'abc',
    'Matching duplicate content-length fields were not accepted'
  );

  assertHttpError(
    () => new TraceKernelHttp1Decoder('request').push(
      encoder.encode('POST / HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nabc')
    ),
    'EPROTO',
    'Conflicting content-length fields'
  );
  assertHttpError(
    () => new TraceKernelHttp1Decoder('request').push(
      encoder.encode('POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n')
    ),
    'EPROTO',
    'Unsupported chunked transfer encoding'
  );
  assertHttpError(
    () => new TraceKernelHttp1Decoder('request').push(
      encoder.encode('GET / HTTP/1.1\r\n Folded: forbidden\r\n\r\n')
    ),
    'EPROTO',
    'Obsolete folded header'
  );
  assertHttpError(
    () => new TraceKernelHttp1Decoder('request').push(
      encoder.encode('GET relative HTTP/1.1\r\n\r\n')
    ),
    'EPROTO',
    'Non-origin request target'
  );
  assertHttpError(
    () => new TraceKernelHttp1Decoder('request').push(
      encoder.encode('GET / HTTP/1.0\r\n\r\n')
    ),
    'EPROTO',
    'Unsupported HTTP version'
  );
  assertHttpError(
    () => new TraceKernelHttp1Decoder('request').push(
      encoder.encode('GET / HTTP/1.1\r\n\r\ntrailing')
    ),
    'EPROTO',
    'Pipelined trailing bytes'
  );

  const incomplete = new TraceKernelHttp1Decoder('request');
  incomplete.push(encoder.encode('POST / HTTP/1.1\r\nContent-Length: 4\r\n\r\nabc'));
  assertHttpError(() => incomplete.finish(), 'EPROTO', 'Unexpected body EOF');

  assertHttpError(
    () => new TraceKernelHttp1Decoder('request', { maxHeaderBytes: 16 }).push(
      encoder.encode('GET / HTTP/1.1\r\nX: value\r\n\r\n')
    ),
    'E2BIG',
    'Header byte limit'
  );
  assertHttpError(
    () => new TraceKernelHttp1Decoder('request', { maxHeaderCount: 1 }).push(
      encoder.encode('GET / HTTP/1.1\r\nA: 1\r\nB: 2\r\n\r\n')
    ),
    'E2BIG',
    'Header count limit'
  );
  assertHttpError(
    () => new TraceKernelHttp1Decoder('request', { maxStartLineBytes: 4 }).push(
      encoder.encode('GET / HTTP/1.1\r\n\r\n')
    ),
    'E2BIG',
    'Start-line limit'
  );
  assertHttpError(
    () => new TraceKernelHttp1Decoder('request', { maxBodyBytes: 2 }).push(
      encoder.encode('POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc')
    ),
    'E2BIG',
    'Body limit'
  );
  assertHttpError(
    () => encodeTraceKernelHttp1Request({
      method: 'POST',
      target: '/',
      headers: [{ name: 'Content-Length', value: '2' }],
      body: encoder.encode('abc'),
    }),
    'EPROTO',
    'Encoded content-length mismatch'
  );
  assertHttpError(
    () => encodeTraceKernelHttp1Response({
      status: 200,
      statusText: 'OK',
      headers: [{ name: 'Transfer-Encoding', value: 'chunked' }],
      body: new Uint8Array(),
    }),
    'EPROTO',
    'Encoded unsupported transfer encoding'
  );

  console.log(JSON.stringify({
    schema: 'tracekernel-013-http1-conformance-v1',
    fragmentationChunkSizes: [1, 2, 3, 7, 64, encodedRequest.byteLength],
    requestBytes: encodedRequest.byteLength,
    responseBytes: encodedResponse.byteLength,
  }));
}

main();

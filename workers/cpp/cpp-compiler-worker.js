function encodeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function decodeUtf8(value) {
  return new TextDecoder().decode(value);
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function fetchText(name, url) {
  if (!url || typeof url !== 'string') {
    throw new Error(`Missing C++ compiler asset URL for ${name}.`);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${name} failed to load from ${url} (${response.status} ${response.statusText})`);
  }

  return response.text();
}

function transferableArrayBuffer(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function compileWithYowasp(payload) {
  const startedAt = performance.now();
  const assets = payload?.assets || {};
  const driverSource = typeof payload?.driverSource === 'string' ? payload.driverSource : '';
  if (!driverSource) {
    throw new Error('Missing C++ driver source.');
  }

  const runtimeHeader = await fetchText('tracecode_runtime.hpp', assets.runtimeHeaderUrl);
  const compilerBundle = await import(assets.compilerBundleUrl);
  if (typeof compilerBundle.runClang !== 'function') {
    throw new Error('C++ compiler bundle does not expose runClang.');
  }

  const stdoutChunks = [];
  const stderrChunks = [];
  const collect = (chunks) => (bytes) => {
    if (bytes) chunks.push(bytes);
  };

  try {
    const files = await compilerBundle.runClang(
      [
        'clang++',
        'TraceCodeDriver.cpp',
        `-std=${payload?.standard || 'c++23'}`,
        '-O0',
        '-fno-exceptions',
        `-Wl,-z,stack-size=${Number(payload?.stackSize) || 8 * 1024 * 1024}`,
        '-o',
        'program.wasm',
      ],
      {
        'TraceCodeDriver.cpp': driverSource,
        'tracecode_runtime.hpp': runtimeHeader,
      },
      {
        stdout: collect(stdoutChunks),
        stderr: collect(stderrChunks),
        fetchProgress: () => {},
      }
    );

    const programBytes = files?.['program.wasm'];
    if (!(programBytes instanceof Uint8Array)) {
      return {
        success: false,
        error: 'C++ compilation did not produce program.wasm.',
        stdout: decodeUtf8(concatBytes(stdoutChunks)),
        stderr: decodeUtf8(concatBytes(stderrChunks)),
        compileMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    }

    return {
      success: true,
      programBuffer: transferableArrayBuffer(programBytes),
      stdout: decodeUtf8(concatBytes(stdoutChunks)),
      stderr: decodeUtf8(concatBytes(stderrChunks)),
      compileMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } catch (error) {
    return {
      success: false,
      error: encodeError(error),
      stdout: decodeUtf8(concatBytes(stdoutChunks)),
      stderr: decodeUtf8(concatBytes(stderrChunks)),
      compileMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};
  if (!id) return;

  try {
    if (type !== 'compile') {
      throw new Error(`Unknown C++ compiler worker message: ${type}`);
    }
    const result = await compileWithYowasp(payload);
    const transfer = result.programBuffer instanceof ArrayBuffer ? [result.programBuffer] : [];
    postMessage({ id, type: 'compile-result', payload: result }, transfer);
  } catch (error) {
    postMessage({
      id,
      type: 'compile-result',
      payload: { success: false, error: encodeError(error) },
    });
  }
};

postMessage({ type: 'worker-ready' });

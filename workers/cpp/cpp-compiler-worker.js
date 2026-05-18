function encodeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function decodeUtf8(value) {
  return new TextDecoder().decode(value);
}

function encodeUtf8(value) {
  return new TextEncoder().encode(value);
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

function normalizeProjectRoot(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!raw || !raw.startsWith('/')) return '';
  return raw || '/';
}

function projectWorkspaceRoots(context) {
  const project = context?.project && typeof context.project === 'object' ? context.project : context;
  const roots = [];
  for (const value of [project?.workspaceRoot, project?.cwd, project?.workspaceAlias, '/workspace']) {
    const root = normalizeProjectRoot(value);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

function stripProjectWorkspaceRoot(context, pathname) {
  const raw = String(pathname || '').replace(/\\/g, '/');
  for (const root of projectWorkspaceRoots(context)) {
    if (raw === root) return '';
    if (root !== '/' && raw.startsWith(`${root}/`)) return raw.slice(root.length + 1);
  }
  return null;
}

function normalizeProjectPath(pathname, context) {
  const raw = String(pathname || '').replace(/\\/g, '/');
  const stripped = stripProjectWorkspaceRoot(context, raw);
  const withoutWorkspace = stripped === null ? raw.replace(/^\/+/, '') : stripped;
  const parts = [];
  for (const part of withoutWorkspace.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new Error(`Project path escapes workspace: ${pathname}`);
    }
    parts.push(part);
  }
  return parts.join('/');
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function projectFileBytes(file) {
  return file?.encoding === 'base64'
    ? decodeBase64(String(file.contents || ''))
    : new TextEncoder().encode(String(file?.contents || ''));
}

function includeRelativePath(path, includePath) {
  if (!includePath) return path;
  if (path === includePath) return '';
  return path.startsWith(`${includePath}/`) ? path.slice(includePath.length + 1) : '';
}

function relativePathFromCwd(path, cwd, context) {
  const normalizedPath = normalizeProjectPath(path, context);
  const normalizedCwd = normalizeProjectPath(cwd, context);
  if (!normalizedCwd) return normalizedPath;
  const pathParts = normalizedPath.split('/').filter(Boolean);
  const cwdParts = normalizedCwd.split('/').filter(Boolean);
  let shared = 0;
  while (shared < pathParts.length && shared < cwdParts.length && pathParts[shared] === cwdParts[shared]) {
    shared += 1;
  }
  return [
    ...Array(cwdParts.length - shared).fill('..'),
    ...pathParts.slice(shared),
  ].join('/') || '.';
}

function basename(pathname) {
  const normalized = normalizeProjectPath(pathname);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function isLinkerArtifactPath(pathname) {
  return /\.(?:a|lib|o|obj)$/i.test(pathname);
}

function projectStdinSourcePath(payload) {
  return 'tracecode-stdin.cpp';
}

const TRACEKERNEL_STATVFS_SOURCE = String.raw`
#include <errno.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>

#ifdef __cplusplus
extern "C" {
#endif

static void tracecode_fill_statvfs(struct statvfs *out) {
  memset(out, 0, sizeof(*out));
  out->f_bsize = 4096;
  out->f_frsize = 4096;
  out->f_blocks = 1048576;
  out->f_bfree = 1048000;
  out->f_bavail = 1048000;
  out->f_files = 1000000;
  out->f_ffree = 999000;
  out->f_favail = 999000;
  out->f_fsid = 0x74726365UL;
  out->f_namemax = 255;
  out->f_type = 0x74726365U;
}

#ifdef __cplusplus
extern "C"
#endif
int __wrap_statvfs(const char *path, struct statvfs *out) {
  struct stat st;
  if (!path || !out) {
    errno = EINVAL;
    return -1;
  }
  if (stat(path, &st) != 0) {
    return -1;
  }
  tracecode_fill_statvfs(out);
  return 0;
}

#ifdef __cplusplus
extern "C"
#endif
int __wrap_fstatvfs(int fd, struct statvfs *out) {
  struct stat st;
  if (!out) {
    errno = EINVAL;
    return -1;
  }
  if (fstat(fd, &st) != 0) {
    return -1;
  }
  tracecode_fill_statvfs(out);
  return 0;
}

#ifdef __cplusplus
}
#endif
`;

function shouldLinkTracekernelStatvfs(args) {
  return !args.some((arg) => arg === '-c' || arg === '-S' || arg === '-E');
}

async function compileProjectWithYowasp(payload) {
  const startedAt = performance.now();
  const assets = payload?.assets || {};
  const compilerBundle = await import(assets.compilerBundleUrl);
  if (typeof compilerBundle.runClang !== 'function') {
    throw new Error('C++ compiler bundle does not expose runClang.');
  }

  const sourceFiles = {};
  const cwd = normalizeProjectPath(payload?.cwd || '', payload);
  const includePaths = Array.isArray(payload?.includePaths)
    ? payload.includePaths.map((path) => normalizeProjectPath(path, payload)).filter(Boolean)
    : [];
  for (const file of payload?.project?.files || []) {
    const path = normalizeProjectPath(file.path, payload);
    if (!path) continue;
    const bytes = projectFileBytes(file);
    sourceFiles[path] = bytes;
    if (cwd && path.startsWith(`${cwd}/`)) {
      sourceFiles[path.slice(cwd.length + 1)] = bytes;
    }
    const relativeFromCwd = relativePathFromCwd(path, cwd, payload);
    if (relativeFromCwd && relativeFromCwd !== path && sourceFiles[relativeFromCwd] === undefined) {
      sourceFiles[relativeFromCwd] = bytes;
    }
    for (const includePath of includePaths) {
      const includeRelative = includeRelativePath(path, includePath);
      if (includeRelative && sourceFiles[includeRelative] === undefined) {
        sourceFiles[includeRelative] = bytes;
      }
    }
    if (isLinkerArtifactPath(path)) {
      const localName = basename(path);
      if (localName && sourceFiles[localName] === undefined) {
        sourceFiles[localName] = bytes;
      }
    }
    if (/\.(?:c|cc|cpp|cxx|h|hpp|hh)$/i.test(path)) {
      const localName = basename(path);
      if (localName && sourceFiles[localName] === undefined) {
        sourceFiles[localName] = bytes;
      }
    }
  }

  const stdinSourcePath = projectStdinSourcePath(payload);
  const requestedArgs = Array.isArray(payload?.args)
    ? payload.args.map((arg) => String(arg) === '-' ? stdinSourcePath : String(arg))
    : [];
  if (requestedArgs.includes(stdinSourcePath)) {
    const stdinBytes = encodeUtf8(String(payload?.stdin ?? ''));
    sourceFiles[stdinSourcePath] = stdinBytes;
    if (cwd && stdinSourcePath.startsWith(`${cwd}/`)) {
      sourceFiles[stdinSourcePath.slice(cwd.length + 1)] = stdinBytes;
    }
  }
  const linkTracekernelStatvfs = shouldLinkTracekernelStatvfs(requestedArgs);
  if (linkTracekernelStatvfs) {
    sourceFiles['tracecode_statvfs.c'] = encodeUtf8(TRACEKERNEL_STATVFS_SOURCE);
  }
  const outputIndex = requestedArgs.indexOf('-o');
  const outputPath = normalizeProjectPath(outputIndex >= 0 ? requestedArgs[outputIndex + 1] || 'a.out' : 'a.out', payload) || 'a.out';
  const workspaceOutputPath = payload?.workspaceOutputPath
    ? normalizeProjectPath(payload.workspaceOutputPath, payload)
    : cwd && !outputPath.startsWith(`${cwd}/`)
      ? normalizeProjectPath(`${cwd}/${outputPath}`, payload)
      : outputPath;
  const compilerCommand = payload?.compilerCommand === 'clang' ? 'clang' : 'clang++';
  const defaultStandard = compilerCommand === 'clang' ? 'c17' : 'c++23';
  const compileArgs = [
    compilerCommand,
    ...(linkTracekernelStatvfs ? ['tracecode_statvfs.c'] : []),
    ...requestedArgs.map((arg, index) => outputIndex >= 0 && index === outputIndex + 1 ? outputPath : normalizeCompilePathArg(arg, payload)),
    ...(outputIndex >= 0 ? [] : ['-o', outputPath]),
  ];
  if (!compileArgs.some((arg) => arg.startsWith('-std='))) {
    compileArgs.splice(1, 0, `-std=${compilerCommand === 'clang' ? defaultStandard : payload?.standard || defaultStandard}`);
  }
  if (!compileArgs.includes('-fno-exceptions')) {
    compileArgs.splice(1, 0, '-fno-exceptions');
  }
  if (!compileArgs.some((arg) => arg.startsWith('-Wl,-z,stack-size='))) {
    compileArgs.splice(1, 0, `-Wl,-z,stack-size=${Number(payload?.stackSize) || 8 * 1024 * 1024}`);
  }
  if (linkTracekernelStatvfs) {
    compileArgs.splice(1, 0, '-Wl,--wrap=statvfs', '-Wl,--wrap=fstatvfs');
  }

  const stdoutChunks = [];
  const stderrChunks = [];
  const collect = (chunks) => (bytes) => {
    if (bytes) chunks.push(bytes);
  };

  try {
    const files = await compilerBundle.runClang(
      compileArgs,
      sourceFiles,
      {
        stdout: collect(stdoutChunks),
        stderr: collect(stderrChunks),
        fetchProgress: () => {},
      }
    );
    const programBytes = files?.[outputPath];
    if (!(programBytes instanceof Uint8Array)) {
      return {
        success: false,
        error: `C++ compilation did not produce ${outputPath}.`,
        stdout: decodeUtf8(concatBytes(stdoutChunks)),
        stderr: decodeUtf8(concatBytes(stderrChunks)),
        compileMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    }
    return {
      success: true,
      outputPath: workspaceOutputPath,
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

function normalizePrefixedPathArg(arg, prefix, context) {
  if (!arg.startsWith(prefix) || arg.length <= prefix.length) return null;
  const value = arg.slice(prefix.length);
  if (!value.startsWith('/')) return null;
  const stripped = stripProjectWorkspaceRoot(context, value);
  return stripped === null ? null : `${prefix}${normalizeProjectPath(stripped, context)}`;
}

function normalizeCompilePathArg(arg, context) {
  if (stripProjectWorkspaceRoot(context, arg) === '') return '.';
  if (arg.startsWith('/') && stripProjectWorkspaceRoot(context, arg) !== null) {
    return normalizeProjectPath(arg, context);
  }
  const includeArg = normalizePrefixedPathArg(arg, '-I', context);
  if (includeArg !== null) return includeArg;
  const libraryArg = normalizePrefixedPathArg(arg, '-L', context);
  if (libraryArg !== null) return libraryArg;
  const systemIncludeArg = normalizePrefixedPathArg(arg, '-isystem', context);
  if (systemIncludeArg !== null) return systemIncludeArg;
  return arg;
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};
  if (!id) return;

  try {
    if (type !== 'compile' && type !== 'compile-project') {
      throw new Error(`Unknown C++ compiler worker message: ${type}`);
    }
    const result = type === 'compile-project' || payload?.project
      ? await compileProjectWithYowasp(payload)
      : await compileWithYowasp(payload);
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

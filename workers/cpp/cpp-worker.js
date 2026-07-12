import {
  isRuntimeKernelDeviceDirectory as isRuntimeDeviceDirectory,
  isRuntimeKernelDeviceNamespacePath as isRuntimeDeviceNamespacePath,
  isRuntimeKernelProcPath as isRuntimeProcPath,
  normalizeRuntimeKernelDeviceReference,
  runtimeKernelVirtualMutationTarget,
  runtimeKernelVirtualPathTarget,
  withRuntimeUserAuthorityLockdown,
} from './shared/runtime-kernel-policy.js';

const trustedCppWorkerPostMessage = self.postMessage.bind(self);

const RESULT_MARKER = '__TRACECODE_RESULT__';
const TRACE_EVENT_MARKER = '__TRACECODE_EVENT__';
const TRACE_STATUS_MARKER = '__TRACECODE_TRACE_STATUS__';
const RUNTIME_TRACE_SCHEMA_VERSION = 'runtime-trace-2026-04-28';
const CPP_USER_SOURCE_FILE = 'solution.cpp';
const CPP_STANDARD = 'c++23';
const CPP_SCRIPT_FUNCTION_NAME = '__tracecode_script_main';
const CPP_BATCH_TRACE_CASE_MARKER_FUNCTION = '__tracecode_batch_case';
const TRACE_EVENT_TRANSFER_SCHEMA = 'tracecode.trace-events.transfer.v1';
const TRACE_EVENT_TRANSFER_DEFAULT_CHUNK_BYTES = 64 * 1024;
const TRACE_EVENT_TRANSFER_MAX_CHUNK_BYTES = 256 * 1024;
const TRACE_EVENT_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
const TRACE_EVENT_TRANSFER_MIN_EVENTS = 128;
const DEFAULT_MAX_STORED_EVENTS = 50_000;
const DEFAULT_INTERVIEW_MAX_TRACE_STEPS = 10_000;
const DEFAULT_INTERVIEW_MAX_LINE_EVENTS = 12_000;
const DEFAULT_INTERVIEW_MAX_SINGLE_LINE_HITS = 1_000;
const CPP_PROGRAM_STACK_SIZE = 8 * 1024 * 1024;
const DEFAULT_CPP_PROGRAM_CACHE_LIMIT = 32;
const MAX_CPP_PROGRAM_CACHE_LIMIT = 512;
const CPP_WARMUP_SOURCE = 'class Solution { public: int add(int a, int b) { return a + b; } };';
const WORKER_DEBUG = (() => {
  try {
    return typeof self !== 'undefined' && typeof self.location?.search === 'string' && self.location.search.includes('dev=');
  } catch {
    return false;
  }
})();
const ESUCCESS = 0;
const EACCES = 2;
const EADDRINUSE = 3;
const EAFNOSUPPORT = 5;
const EBADF = 8;
const ECONNABORTED = 13;
const ECONNREFUSED = 14;
const EEXIST = 20;
const EINVAL = 28;
const EIO = 29;
const EISDIR = 31;
const EISCONN = 30;
const ENOENT = 44;
const ENOTCONN = 53;
const ENOTDIR = 54;
const ENOTEMPTY = 55;
const ENOTSUP = 58;
const EROFS = 69;
const ESPIPE = 70;
const FILETYPE_UNKNOWN = 0;
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;
const FILETYPE_SOCKET_STREAM = 6;
const OFLAGS_CREAT = 1;
const OFLAGS_DIRECTORY = 2;
const OFLAGS_EXCL = 4;
const OFLAGS_TRUNC = 8;
const FDFLAGS_APPEND = 1;
const RIGHTS_FD_READ = 1n << 1n;
const RIGHTS_FD_WRITE = 1n << 6n;
const WHENCE_SET = 0;
const WHENCE_CUR = 1;
const WHENCE_END = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const PROJECT_MAX_OUTPUT_STREAM_BYTES = 1024 * 1024;
const PROJECT_MAX_LIVE_FILE_CHANGES = 1024;
const PROJECT_MAX_LIVE_FILE_CHANGE_BYTES = 4 * 1024 * 1024;
const CPP_BASE_GENERATED_INCLUDES = Object.freeze([
  '#include "/tracecode_runtime.hpp"',
  '#include <algorithm>',
  '#include <array>',
  '#include <bitset>',
  '#include <climits>',
  '#include <cmath>',
  '#include <cstdint>',
  '#include <functional>',
  '#include <limits>',
  '#include <numeric>',
  '#include <sstream>',
  '#include <tuple>',
]);
const CPP_STANDARD_INCLUDE_RULES = Object.freeze([
  [/\bvector\s*</, '#include <vector>'],
  [/\bunordered_map\s*</, '#include <unordered_map>'],
  [/\bunordered_set\s*</, '#include <unordered_set>'],
  [/\bmap\s*</, '#include <map>'],
  [/\bset\s*</, '#include <set>'],
  [/\bdeque\s*</, '#include <deque>'],
  [/\b(?:priority_queue|queue)\s*</, '#include <queue>'],
  [/\bstack\s*</, '#include <stack>'],
  [/\bpair\s*</, '#include <utility>'],
  [/\bstring\b/, '#include <string>'],
  [/\bspan\s*</, '#include <span>'],
  [/\bviews::|\branges::|std::views|std::ranges/, '#include <ranges>'],
  [/\bconcept\b|\brequires\b/, '#include <concepts>'],
  [/\b(?:any|any_cast|make_any)\b/, '#include <any>'],
  [/\b(?:bit_cast|bit_ceil|bit_floor|bit_width|byteswap|countl_one|countl_zero|countr_one|countr_zero|has_single_bit|popcount|rotl|rotr)\s*\(/, '#include <bit>'],
  [/\b(?:isalpha|isalnum|isblank|iscntrl|isdigit|isgraph|islower|isprint|ispunct|isspace|isupper|isxdigit|tolower|toupper)\s*\(/, '#include <cctype>'],
  [/\berrno\b/, '#include <cerrno>'],
  [/\b(?:DBL_|FLT_|LDBL_)/, '#include <cfloat>'],
  [/\b(?:from_chars|to_chars)\s*\(/, '#include <charconv>'],
  [/\b(?:chrono::|std::chrono::|duration\s*<|time_point\s*<|system_clock|steady_clock|high_resolution_clock)\b/, '#include <chrono>'],
  [/\b(?:intmax_t|uintmax_t|imaxabs|imaxdiv|strtoimax|strtoumax)\b/, '#include <cinttypes>'],
  [/\b(?:strong_ordering|weak_ordering|partial_ordering|compare_three_way)\b|<=>/, '#include <compare>'],
  [/\bcomplex\s*</, '#include <complex>'],
  [/\b(?:byte|nullptr_t|ptrdiff_t|size_t)\b/, '#include <cstddef>'],
  [/\b(?:FILE|clearerr|fclose|feof|ferror|fflush|fgetc|fgetpos|fgets|fopen|fprintf|fputc|fputs|fread|freopen|fscanf|fseek|fsetpos|ftell|fwrite|getc|getchar|perror|printf|putc|putchar|puts|remove|rename|rewind|scanf|setbuf|setvbuf|snprintf|sprintf|sscanf|tmpfile|tmpnam|ungetc|vfprintf|vfscanf|vprintf|vscanf|vsnprintf|vsprintf|vsscanf)\b/, '#include <cstdio>'],
  [/\b(?:abort|abs|aligned_alloc|atexit|atof|atoi|atol|atoll|bsearch|calloc|div|exit|free|getenv|labs|ldiv|llabs|lldiv|malloc|mblen|mbstowcs|mbtowc|qsort|rand|realloc|srand|strtod|strtof|strtol|strtold|strtoll|strtoul|strtoull|system|wcstombs|wctomb)\b/, '#include <cstdlib>'],
  [/\b(?:memchr|memcmp|memcpy|memmove|memset|strcat|strchr|strcmp|strcoll|strcpy|strcspn|strerror|strlen|strncat|strncmp|strncpy|strpbrk|strrchr|strspn|strstr|strtok|strxfrm)\s*\(/, '#include <cstring>'],
  [/\b(?:exception|exception_ptr|current_exception|make_exception_ptr|rethrow_exception|terminate|uncaught_exceptions?)\b/, '#include <exception>'],
  [/\b(?:expected|unexpected)\s*<|\bunexpect\b/, '#include <expected>'],
  [/\bforward_list\s*</, '#include <forward_list>'],
  [/\binitializer_list\s*</, '#include <initializer_list>'],
  [/\b(?:boolalpha|defaultfloat|fixed|hexfloat|noboolalpha|put_money|put_time|quoted|scientific|setbase|setfill|setiosflags|setprecision|setw)\b/, '#include <iomanip>'],
  [/\b(?:ios|ios_base|streampos|streamoff)\b/, '#include <ios>'],
  [/\b(?:cerr|cin|clog|cout|wcin|wcout|wcerr|wclog)\b/, '#include <iostream>'],
  [/\b(?:advance|back_inserter|begin|cbegin|cend|crbegin|crend|distance|end|front_inserter|inserter|istream_iterator|iterator_traits|make_move_iterator|next|ostream_iterator|prev|rbegin|rend)\b/, '#include <iterator>'],
  [/\blist\s*</, '#include <list>'],
  [/\b(?:allocator|make_shared|make_unique|shared_ptr|unique_ptr|weak_ptr)\b/, '#include <memory>'],
  [/\b(?:numbers::|std::numbers::)/, '#include <numbers>'],
  [/\boptional\s*<|\b(?:make_optional|nullopt)\b/, '#include <optional>'],
  [/\b(?:bernoulli_distribution|binomial_distribution|default_random_engine|discrete_distribution|exponential_distribution|geometric_distribution|knuth_b|linear_congruential_engine|lognormal_distribution|mersenne_twister_engine|minstd_rand|mt19937|mt19937_64|normal_distribution|piecewise_constant_distribution|piecewise_linear_distribution|poisson_distribution|random_device|ranlux24|ranlux48|shuffle_order_engine|student_t_distribution|uniform_int_distribution|uniform_real_distribution|weibull_distribution)\b/, '#include <random>'],
  [/\bratio\s*</, '#include <ratio>'],
  [/\b(?:cmatch|cregex_iterator|cregex_token_iterator|regex|regex_error|regex_iterator|regex_match|regex_replace|regex_search|regex_token_iterator|smatch|sregex_iterator|sregex_token_iterator|wregex|wsmatch)\b/, '#include <regex>'],
  [/\b(?:logic_error|domain_error|invalid_argument|length_error|out_of_range|runtime_error|range_error|overflow_error|underflow_error)\b/, '#include <stdexcept>'],
  [/\bstring_view\b/, '#include <string_view>'],
  [/\b(?:add_const|add_cv|add_lvalue_reference|add_pointer|add_rvalue_reference|add_volatile|aligned_storage|common_type|conditional|decay|enable_if|false_type|integral_constant|is_arithmetic|is_array|is_base_of|is_class|is_const|is_convertible|is_enum|is_floating_point|is_function|is_integral|is_lvalue_reference|is_pointer|is_reference|is_same|is_signed|is_trivially_copyable|is_void|remove_const|remove_cv|remove_pointer|remove_reference|true_type|underlying_type|void_t)\b/, '#include <type_traits>'],
  [/\btype_index\b/, '#include <typeindex>'],
  [/\b(?:type_info|typeid\s*\()/, '#include <typeinfo>'],
  [/\bvalarray\s*</, '#include <valarray>'],
  [/\bvariant\s*<|\b(?:holds_alternative|monostate|visit)\b/, '#include <variant>'],
  [/\b__cpp_lib_/, '#include <version>'],
]);

let configuredAssets = null;
let toolchainPromise = null;
let warmupPromise = null;
let queue = Promise.resolve();
let idleTimer = null;
let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
let queuedTasks = 0;
let activeRequestId = null;
let activeRequestStartedAt = 0;
let activeRequestProtocolToken = null;
let programCache = new Map();
let programCacheLimit = DEFAULT_CPP_PROGRAM_CACHE_LIMIT;
let usePrecompiledHeader = false;
let externalCompileRequestId = 0;
const pendingExternalCompiles = new Map();
const activeCompilerWorkers = new Set();
let compilerWorkerRequestId = 0;
const pendingCompilerWorkerRequests = new Map();

function emitRuntimeDiagnostic(level, phase, message, detail) {
  if (!WORKER_DEBUG && level !== 'error') return;
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'info';
  console[method]('[TraceRuntime]', {
    schema: 'tracecode.runtime-diagnostic.v1',
    source: 'harness',
    component: 'CppWorker',
    runtime: 'cpp',
    phase,
    message,
    ...(detail === undefined ? {} : { detail }),
  });
}

class ProcExit extends Error {
  constructor(code) {
    super(`process exited with code ${code}`);
    this.code = code;
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(now() - startedAt));
}

function emitRequestProgress(stage, detail = undefined) {
  if (!activeRequestId) return;
  trustedCppWorkerPostMessage({
    id: activeRequestId,
    type: 'runtime-progress',
    ...(activeRequestProtocolToken ? { protocolToken: activeRequestProtocolToken } : {}),
    payload: {
      stage,
      elapsedMs: elapsedMs(activeRequestStartedAt || now()),
      ...(detail === undefined ? {} : { detail }),
    },
  });
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function resetIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    trustedCppWorkerPostMessage({ type: 'idle-timeout' });
    self.close();
  }, idleTimeoutMs);
}

function applyWorkerOptions(payload) {
  const requestedIdleTimeoutMs = Number(payload?.idleTimeoutMs);
  if (Number.isFinite(requestedIdleTimeoutMs) && requestedIdleTimeoutMs >= 1_000) {
    idleTimeoutMs = Math.round(requestedIdleTimeoutMs);
  }

  const requestedProgramCacheLimit = Number(payload?.programCacheLimit);
  if (Number.isFinite(requestedProgramCacheLimit) && requestedProgramCacheLimit >= 0) {
    programCacheLimit = Math.min(
      MAX_CPP_PROGRAM_CACHE_LIMIT,
      Math.max(0, Math.floor(requestedProgramCacheLimit))
    );
    trimProgramCache();
  }

  if (typeof payload?.usePrecompiledHeader === 'boolean') {
    usePrecompiledHeader = payload.usePrecompiledHeader;
  }
}

function getProgramCacheKey(compiler, driverSource) {
  return [compiler, CPP_STANDARD, String(CPP_PROGRAM_STACK_SIZE), driverSource].join('\0');
}

function getCachedProgramModule(cacheKey) {
  if (!programCache.has(cacheKey)) return null;
  const module = programCache.get(cacheKey);
  programCache.delete(cacheKey);
  programCache.set(cacheKey, module);
  return module;
}

function storeProgramModule(cacheKey, module) {
  if (programCacheLimit <= 0) return;
  if (programCache.has(cacheKey)) {
    programCache.delete(cacheKey);
  }
  programCache.set(cacheKey, module);
  trimProgramCache();
}

function trimProgramCache() {
  while (programCache.size > programCacheLimit) {
    const oldestKey = programCache.keys().next().value;
    programCache.delete(oldestKey);
  }
}

function encodeUtf8(value) {
  return new TextEncoder().encode(value);
}

function decodeUtf8(value) {
  return new TextDecoder().decode(value);
}

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

function projectUtf8Bytes(value) {
  return encodeUtf8(String(value ?? '')).byteLength;
}

function projectTruncateUtf8(value, maxBytes) {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let output = '';
  for (const char of String(value ?? '')) {
    const nextBytes = projectUtf8Bytes(char);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    output += char;
  }
  return output;
}

function projectFileChangeByteSize(change) {
  if (!change || typeof change !== 'object') return 0;
  let size = projectUtf8Bytes(change.path ?? '');
  if (typeof change.contents === 'string') {
    size += change.encoding === 'base64'
      ? Math.ceil(change.contents.length * 3 / 4)
      : projectUtf8Bytes(change.contents);
  }
  return size;
}

function createProjectOutputByteBudget() {
  const outputBytes = { stdout: 0, stderr: 0 };
  const truncatedOutputStreams = new Set();

  return {
    capture(stream, chunks) {
      const normalizedStream = stream === 'stderr' ? 'stderr' : 'stdout';
      if (truncatedOutputStreams.has(normalizedStream)) return [];
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const used = outputBytes[normalizedStream] ?? 0;
      const remaining = PROJECT_MAX_OUTPUT_STREAM_BYTES - used;
      if (total <= remaining) {
        outputBytes[normalizedStream] = used + total;
        return chunks;
      }

      const output = [];
      let remainingBytes = Math.max(0, remaining);
      for (const chunk of chunks) {
        if (remainingBytes <= 0) break;
        if (chunk.length <= remainingBytes) {
          output.push(chunk);
          remainingBytes -= chunk.length;
        } else {
          output.push(chunk.subarray(0, remainingBytes));
          remainingBytes = 0;
        }
      }

      const marker = encodeUtf8(`\n[tracekernel: ${normalizedStream} output truncated after ${PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\n`);
      output.push(marker);
      outputBytes[normalizedStream] = PROJECT_MAX_OUTPUT_STREAM_BYTES + marker.length;
      truncatedOutputStreams.add(normalizedStream);
      return output;
    },
  };
}

function createProjectEventBudget(runtimeName) {
  const outputBytes = { stdout: 0, stderr: 0 };
  const truncatedOutputStreams = new Set();
  let liveFileChangeCount = 0;
  let liveFileChangeBytes = 0;
  let warnedLiveFileBudget = false;

  function warnLiveFileBudget(size) {
    if (warnedLiveFileBudget) return;
    warnedLiveFileBudget = true;
    emitRuntimeDiagnostic('warn', 'project-event-budget', `Dropped oversized ${runtimeName} live file-change event.`, {
      count: liveFileChangeCount,
      bytes: liveFileChangeBytes,
      eventBytes: size,
    });
  }

  function reserveLiveFileChangeSize(path, contentsBytes = 0) {
    liveFileChangeCount += 1;
    const size = projectUtf8Bytes(path ?? '') + Math.max(0, contentsBytes);
    const overBudget =
      liveFileChangeCount > PROJECT_MAX_LIVE_FILE_CHANGES ||
      size > PROJECT_MAX_LIVE_FILE_CHANGE_BYTES ||
      liveFileChangeBytes + size > PROJECT_MAX_LIVE_FILE_CHANGE_BYTES;
    if (overBudget) {
      warnLiveFileBudget(size);
      return false;
    }
    liveFileChangeBytes += size;
    return true;
  }

  return {
    truncatedOutputStreams,
    apply(event) {
      if (!event || typeof event !== 'object') return event;

      if (
        event.type === 'output' &&
        (event.stream === 'stdout' || event.stream === 'stderr') &&
        typeof event.data === 'string'
      ) {
        if (truncatedOutputStreams.has(event.stream)) return null;
        const used = outputBytes[event.stream] ?? 0;
        const remaining = PROJECT_MAX_OUTPUT_STREAM_BYTES - used;
        const bytes = projectUtf8Bytes(event.data);
        if (bytes <= remaining) {
          outputBytes[event.stream] = used + bytes;
          return event;
        }

        truncatedOutputStreams.add(event.stream);
        const marker = `\n[tracekernel: ${event.stream} output truncated after ${PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\n`;
        const data = `${projectTruncateUtf8(event.data, Math.max(0, remaining))}${marker}`;
        outputBytes[event.stream] = PROJECT_MAX_OUTPUT_STREAM_BYTES + projectUtf8Bytes(marker);
        return data ? { ...event, data } : null;
      }

      if (event.type === 'file-change' && (event.phase ?? 'live') === 'live') {
        const size = projectFileChangeByteSize(event.change);
        if (!reserveLiveFileChangeSize('', size)) return null;
      }

      return event;
    },
    reserveLiveFileChangeSize,
  };
}

function normalizePath(pathname) {
  const raw = String(pathname || '/').replace(/\\/g, '/');
  const absolute = raw.startsWith('/') ? raw : `/${raw}`;
  const parts = [];
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function dirname(pathname) {
  const normalized = normalizePath(pathname);
  if (normalized === '/') return '/';
  const slash = normalized.lastIndexOf('/');
  return slash <= 0 ? '/' : normalized.slice(0, slash);
}

function basename(pathname) {
  const normalized = normalizePath(pathname);
  if (normalized === '/') return '/';
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function resolveAt(base, child) {
  if (!child || child === '.') return normalizePath(base || '/');
  if (child.startsWith('/')) return normalizePath(child);
  return normalizePath(`${base || '/'}/${child}`);
}

function wasiRights(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
}

function inodeForPath(pathname) {
  let hash = 2166136261;
  for (const ch of normalizePath(pathname)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return BigInt(hash >>> 0) + 1n;
}

function cloneBytes(value) {
  return new Uint8Array(value);
}

function prepareCppTraceEventTransfer(result, request, mode) {
  if (
    request?.schema !== TRACE_EVENT_TRANSFER_SCHEMA ||
    request?.encoding !== 'json-utf8' ||
    typeof TextEncoder === 'undefined'
  ) {
    return null;
  }
  const eventArrays = mode === 'batch'
    ? Array.isArray(result?.results)
      ? result.results.map((entry) => entry?.trace?.events)
      : []
    : [result?.trace?.events];
  if (eventArrays.length === 0 || eventArrays.some((events) => !Array.isArray(events))) return null;
  const eventCounts = eventArrays.map((events) => events.length);
  const eventCount = eventCounts.reduce((sum, count) => sum + count, 0);
  const requestedMinEvents = Number(request.minEventCount);
  const minEventCount = Number.isSafeInteger(requestedMinEvents)
    ? Math.max(TRACE_EVENT_TRANSFER_MIN_EVENTS, requestedMinEvents)
    : TRACE_EVENT_TRANSFER_MIN_EVENTS;
  if (eventCount < minEventCount) return null;

  let encoded;
  try {
    encoded = new TextEncoder().encode(JSON.stringify(mode === 'batch' ? eventArrays : eventArrays[0]));
  } catch {
    return null;
  }
  const requestedMinBytes = Number(request.minTransferBytes);
  const minTransferBytes = Number.isSafeInteger(requestedMinBytes)
    ? Math.max(0, requestedMinBytes)
    : 64 * 1024;
  if (encoded.byteLength < minTransferBytes || encoded.byteLength > TRACE_EVENT_TRANSFER_MAX_BYTES) {
    return null;
  }

  const requestedChunkBytes = Number(request.maxChunkBytes);
  const chunkBytes = Number.isSafeInteger(requestedChunkBytes)
    ? Math.max(16 * 1024, Math.min(TRACE_EVENT_TRANSFER_MAX_CHUNK_BYTES, requestedChunkBytes))
    : TRACE_EVENT_TRANSFER_DEFAULT_CHUNK_BYTES;
  const chunks = [];
  for (let offset = 0; offset < encoded.byteLength; offset += chunkBytes) {
    chunks.push(encoded.slice(offset, Math.min(encoded.byteLength, offset + chunkBytes)).buffer);
  }
  const payload = mode === 'batch'
    ? {
        ...result,
        results: result.results.map((entry) => ({
          ...entry,
          trace: { ...entry.trace, events: [] },
        })),
      }
    : {
        ...result,
        trace: { ...result.trace, events: [] },
      };
  payload.__traceEventTransport = {
    schema: TRACE_EVENT_TRANSFER_SCHEMA,
    encoding: 'json-utf8',
    path: mode === 'batch' ? 'results[].trace.events' : 'trace.events',
    eventCount,
    ...(mode === 'batch' ? { eventCounts } : {}),
    byteLength: encoded.byteLength,
    chunks,
  };
  return { payload, transfer: chunks };
}

function postSuccess(id, type, payload, traceEventTransport) {
  const mode = type === 'execute-with-tracing'
    ? 'single'
    : type === 'execute-trace-batch'
      ? 'batch'
      : null;
  const transported = mode
    ? prepareCppTraceEventTransfer(payload, traceEventTransport, mode)
    : null;
  trustedCppWorkerPostMessage(
    {
      id,
      type,
      payload: transported?.payload ?? payload,
      ...(activeRequestProtocolToken ? { protocolToken: activeRequestProtocolToken } : {}),
    },
    transported?.transfer ?? []
  );
}

function postFailure(id, error) {
  trustedCppWorkerPostMessage({
    id,
    type: 'error',
    ...(activeRequestProtocolToken ? { protocolToken: activeRequestProtocolToken } : {}),
    payload: { error: error instanceof Error ? error.message : String(error) },
  });
}

function postProjectEvent(id, payload) {
  if (!id) return;
  trustedCppWorkerPostMessage({ id, type: 'project-event', payload, ...(activeRequestProtocolToken ? { protocolToken: activeRequestProtocolToken } : {}) });
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeSha256(value) {
  return String(value || '').trim().toLowerCase().replace(/^sha256[-:]/, '');
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('C++ asset integrity verification requires Web Crypto.');
  }
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function cppIntegrityEntries() {
  const assets = configuredAssets?.toolchainIntegrity?.assets;
  return Array.isArray(assets) ? assets : [];
}

function cppIntegrityEntryForHref(href) {
  for (const entry of cppIntegrityEntries()) {
    if (!entry?.url || !entry?.sha256) continue;
    try {
      if (new URL(entry.url, self.location.href).href === href) return entry;
    } catch {
      // Ignore malformed manifest entries; the exact asset will fail closed.
    }
  }
  return null;
}

function assertTrustedCppAsset(name, url) {
  const parsed = new URL(url, self.location.href);
  const href = parsed.href;
  const integrity = cppIntegrityEntryForHref(href);
  if (parsed.origin === self.location.origin) {
    return { href, integrity };
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${name} must be served from the C++ worker origin or a pinned HTTPS toolchain manifest URL.`);
  }
  if (!integrity) {
    throw new Error(`${name} must be served from the C++ worker origin or an exact pinned toolchain manifest URL.`);
  }
  return { href, integrity };
}

function assertSameOriginCppAsset(name, url) {
  return assertTrustedCppAsset(name, url).href;
}

async function verifyCppAssetBytes(name, href, integrity, bytes) {
  if (!integrity) return;
  if (typeof integrity.size === 'number' && bytes.byteLength !== integrity.size) {
    throw new Error(`${name} failed integrity verification: expected ${integrity.size} bytes, got ${bytes.byteLength}.`);
  }
  const expectedSha256 = normalizeSha256(integrity.sha256);
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(`${name} has an invalid pinned SHA-256 digest.`);
  }
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${name} failed integrity verification from ${href}.`);
  }
}

async function fetchTrustedCppAssetResponse(name, url, init, fetchImplementation = globalThis.fetch) {
  if (!url || typeof url !== 'string') {
    throw new Error(`Missing C++ toolchain asset URL for ${name}.`);
  }
  const { href, integrity } = assertTrustedCppAsset(name, url);
  const response = await fetchImplementation(href, init);
  if (!response.ok) {
    throw new Error(`${name} failed to load from ${url} (${response.status} ${response.statusText})`);
  }
  if (!integrity) return response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyCppAssetBytes(name, href, integrity, bytes);
  const headers = new Headers(response.headers);
  headers.set('content-length', String(bytes.byteLength));
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function fetchAsset(name, url, responseType) {
  const response = await fetchTrustedCppAssetResponse(name, url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return responseType === 'text' ? decodeUtf8(bytes) : arrayBufferFromBytes(bytes);
}

function arrayBufferFromBytes(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const cppPinnedFetchState = { active: 0, href: '', nativeFetch: null };

function cppSourceWithPinnedImportMetaUrl(source, href) {
  return source.replace(/\bimport\.meta\.url\b/g, JSON.stringify(href));
}

async function withPinnedCppFetch(href, callback) {
  if (cppPinnedFetchState.active === 0) {
    cppPinnedFetchState.nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const requestHref = new URL(requestUrl, cppPinnedFetchState.href).href;
      return fetchTrustedCppAssetResponse(requestHref, requestHref, init, cppPinnedFetchState.nativeFetch);
    };
  }
  cppPinnedFetchState.active += 1;
  cppPinnedFetchState.href = href;
  try {
    return await callback();
  } finally {
    cppPinnedFetchState.active -= 1;
    if (cppPinnedFetchState.active === 0) {
      globalThis.fetch = cppPinnedFetchState.nativeFetch;
      cppPinnedFetchState.nativeFetch = null;
      cppPinnedFetchState.href = '';
    }
  }
}

function wrapPinnedCppExports(bundle, href) {
  return new Proxy(bundle, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args) => withPinnedCppFetch(href, () => value.apply(target, args));
    },
  });
}

async function importCppCompilerBundle(name, url) {
  const { href, integrity } = assertTrustedCppAsset(name, url);
  if (!integrity) {
    return import(href);
  }
  if (typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error(`${name} requires Blob module loading for pinned remote toolchain assets.`);
  }
  const response = await fetchTrustedCppAssetResponse(name, href);
  const source = cppSourceWithPinnedImportMetaUrl(decodeUtf8(new Uint8Array(await response.arrayBuffer())), href);
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const bundle = await withPinnedCppFetch(href, () => import(blobUrl));
    return wrapPinnedCppExports(bundle, href);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function defaultCompilerWorkerUrl() {
  try {
    return self.location?.href ? new URL('cpp-compiler-worker.js', self.location.href).href : '';
  } catch {
    return '';
  }
}

function getCompilerWorkerUrl() {
  return configuredAssets?.compilerWorkerUrl || defaultCompilerWorkerUrl();
}

function canUseEphemeralCompilerWorker() {
  return Boolean(
    canUseExternalCompilerHost() ||
      (configuredAssets?.compilerBundleUrl &&
        getCompilerWorkerUrl() &&
        typeof Worker !== 'undefined' &&
        typeof WebAssembly !== 'undefined')
  );
}

function canUseExternalCompilerHost() {
  return Boolean(configuredAssets?.compilerFrameEnabled);
}

function readTarString(bytes, offset, length) {
  let end = offset;
  const max = offset + length;
  while (end < max && bytes[end] !== 0) end += 1;
  return decodeUtf8(bytes.subarray(offset, end)).trim();
}

function readTarOctal(bytes, offset, length) {
  const value = readTarString(bytes, offset, length).replace(/\0.*$/, '').trim();
  return value ? parseInt(value, 8) : 0;
}

function parseTarEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const entries = [];
  let offset = 0;

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const size = readTarOctal(header, 124, 12);
    const type = readTarString(header, 156, 1) || '0';
    const prefix = readTarString(header, 345, 155);
    const filename = normalizePath(prefix ? `${prefix}/${name}` : name);
    offset += 512;

    if (type === '5') {
      entries.push({ type: 'dir', path: filename });
    } else if (type === '0' || type === '') {
      entries.push({ type: 'file', path: filename, contents: cloneBytes(bytes.subarray(offset, offset + size)) });
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return entries;
}

class InMemoryFileSystem {
  constructor() {
    this.files = new Map();
    this.dirs = new Set(['/']);
    this.readOnlyFiles = new Set();
    this.fileChangeObserver = null;
  }

  setFileChangeObserver(observer) {
    this.fileChangeObserver = observer;
  }

  clone() {
    const next = new InMemoryFileSystem();
    next.dirs = new Set(this.dirs);
    next.files = new Map([...this.files.entries()].map(([key, value]) => [key, cloneBytes(value)]));
    next.readOnlyFiles = new Set(this.readOnlyFiles);
    return next;
  }

  addDirectory(pathname) {
    const normalized = normalizePath(pathname);
    if (normalized === '/') {
      this.dirs.add('/');
      return;
    }
    this.addDirectory(dirname(normalized));
    const existed = this.dirs.has(normalized);
    this.dirs.add(normalized);
    if (!existed) this.fileChangeObserver?.({ path: normalized, directory: true });
  }

  addFile(pathname, contents) {
    const normalized = normalizePath(pathname);
    this.addDirectory(dirname(normalized));
    this.files.set(normalized, contents instanceof Uint8Array ? cloneBytes(contents) : encodeUtf8(String(contents)));
  }

  addReadOnlyFile(pathname, contents) {
    const normalized = normalizePath(pathname);
    this.addFile(normalized, contents);
    this.readOnlyFiles.add(normalized);
  }

  isReadOnly(pathname) {
    const normalized = normalizePath(pathname);
    return this.readOnlyFiles.has(normalized) || isRuntimeProcPath(normalized);
  }

  exists(pathname) {
    const normalized = normalizePath(pathname);
    return this.files.has(normalized) || this.dirs.has(normalized);
  }

  isDirectory(pathname) {
    return this.dirs.has(normalizePath(pathname));
  }

  isFile(pathname) {
    return this.files.has(normalizePath(pathname));
  }

  readFile(pathname) {
    const normalized = normalizePath(pathname);
    const file = this.files.get(normalized);
    if (!file) throw new Error(`File not found: ${normalized}`);
    return file;
  }

  writeFile(pathname, contents) {
    const normalized = normalizePath(pathname);
    if (this.isReadOnly(normalized)) throw Object.assign(new Error(`Read-only file system: ${normalized}`), { code: 'EROFS' });
    const bytes = contents instanceof Uint8Array ? cloneBytes(contents) : encodeUtf8(String(contents));
    this.addDirectory(dirname(normalized));
    this.files.set(normalized, bytes);
    this.fileChangeObserver?.({ path: normalized, bytes });
  }

  link(oldPathname, newPathname) {
    const oldPath = normalizePath(oldPathname);
    const newPath = normalizePath(newPathname);
    if (this.isReadOnly(newPath)) return EROFS;
    if (this.dirs.has(oldPath)) return EISDIR;
    if (!this.files.has(oldPath)) return ENOENT;
    if (this.files.has(newPath) || this.dirs.has(newPath)) return EEXIST;
    this.writeFile(newPath, this.readFile(oldPath));
    return ESUCCESS;
  }

  resizeFile(pathname, size) {
    const current = this.readFile(pathname);
    const next = new Uint8Array(size);
    next.set(current.subarray(0, Math.min(current.length, size)));
    this.writeFile(pathname, next);
  }

  emitPathSnapshot(pathname) {
    const normalized = normalizePath(pathname);
    if (this.files.has(normalized)) {
      this.fileChangeObserver?.({ path: normalized, bytes: this.readFile(normalized) });
      return;
    }
    if (this.dirs.has(normalized)) {
      this.fileChangeObserver?.({ path: normalized, directory: true });
    }
  }

  unlink(pathname) {
    const normalized = normalizePath(pathname);
    if (this.isReadOnly(normalized)) throw Object.assign(new Error(`Read-only file system: ${normalized}`), { code: 'EROFS' });
    if (this.dirs.has(normalized)) return EISDIR;
    if (!this.files.has(normalized)) return ENOENT;
    this.files.delete(normalized);
    this.readOnlyFiles.delete(normalized);
    this.fileChangeObserver?.({ path: normalized, deleted: true });
    return ESUCCESS;
  }

  removeDirectory(pathname) {
    const normalized = normalizePath(pathname);
    if (normalized === '/' || !this.dirs.has(normalized)) return ENOENT;
    const prefix = `${normalized}/`;
    for (const dir of this.dirs) {
      if (dir.startsWith(prefix)) return ENOTEMPTY;
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) return ENOTEMPTY;
    }
    this.dirs.delete(normalized);
    this.fileChangeObserver?.({ path: normalized, directory: true, deleted: true });
    return ESUCCESS;
  }

  rename(oldPathname, newPathname) {
    const oldPath = normalizePath(oldPathname);
    const newPath = normalizePath(newPathname);
    if (oldPath === newPath) return this.exists(oldPath) ? ESUCCESS : ENOENT;
    if (this.isReadOnly(oldPath) || this.isReadOnly(newPath)) {
      throw Object.assign(new Error(`Read-only file system: ${oldPath}`), { code: 'EROFS' });
    }
    if (this.files.has(oldPath)) {
      if (this.dirs.has(newPath)) return EISDIR;
      this.writeFile(newPath, this.readFile(oldPath));
      this.unlink(oldPath);
      return ESUCCESS;
    }
    if (!this.dirs.has(oldPath)) return ENOENT;
    if (oldPath === '/') return EINVAL;
    if (newPath.startsWith(`${oldPath}/`)) return EINVAL;
    if (this.files.has(newPath)) return ENOTDIR;
    if (this.dirs.has(newPath)) return EEXIST;
    const oldPrefix = `${oldPath}/`;
    const newPrefix = `${newPath}/`;
    const directories = [...this.dirs]
      .filter((path) => path === oldPath || path.startsWith(oldPrefix))
      .sort((left, right) => left.length - right.length);
    const files = [...this.files.entries()].filter(([path]) => path.startsWith(oldPrefix));
    for (const directory of directories) {
      const target = directory === oldPath ? newPath : `${newPrefix}${directory.slice(oldPrefix.length)}`;
      this.addDirectory(target);
    }
    for (const [file, bytes] of files) {
      const target = `${newPrefix}${file.slice(oldPrefix.length)}`;
      this.writeFile(target, bytes);
    }
    for (const [file] of files) {
      this.unlink(file);
    }
    for (const directory of directories.sort((left, right) => right.length - left.length)) {
      this.dirs.delete(directory);
      this.fileChangeObserver?.({ path: directory, directory: true, deleted: true });
    }
    return ESUCCESS;
  }

  listDirectory(pathname) {
    const normalized = normalizePath(pathname);
    const prefix = normalized === '/' ? '/' : `${normalized}/`;
    const names = new Set();
    for (const dir of this.dirs) {
      if (dir === normalized || !dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (rest && !rest.includes('/')) names.add(rest);
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (rest && !rest.includes('/')) names.add(rest);
    }
    return [...names].sort();
  }

  applyTarEntries(entries) {
    for (const entry of entries) {
      if (entry.type === 'dir') this.addDirectory(entry.path);
      if (entry.type === 'file') this.addFile(entry.path, entry.contents);
    }
  }
}

class MemoryView {
  constructor(memory) {
    this.memory = memory;
    this.refresh();
  }

  refresh() {
    if (this.buffer !== this.memory.buffer) {
      this.buffer = this.memory.buffer;
      this.u8 = new Uint8Array(this.buffer);
      this.view = new DataView(this.buffer);
    }
  }

  readU8(offset) {
    this.refresh();
    return this.view.getUint8(offset);
  }

  writeU8(offset, value) {
    this.refresh();
    this.view.setUint8(offset, value);
  }

  readU16(offset) {
    this.refresh();
    return this.view.getUint16(offset, true);
  }

  writeU16(offset, value) {
    this.refresh();
    this.view.setUint16(offset, value, true);
  }

  readU32(offset) {
    this.refresh();
    return this.view.getUint32(offset, true);
  }

  writeU32(offset, value) {
    this.refresh();
    this.view.setUint32(offset, value >>> 0, true);
  }

  readU64(offset) {
    this.refresh();
    return this.view.getBigUint64(offset, true);
  }

  writeU64(offset, value) {
    this.refresh();
    this.view.setBigUint64(offset, BigInt(value), true);
  }

  readBytes(offset, length) {
    this.refresh();
    return cloneBytes(this.u8.subarray(offset, offset + length));
  }

  writeBytes(offset, bytes) {
    this.refresh();
    this.u8.set(bytes, offset);
  }

  readString(offset, length) {
    return decodeUtf8(this.readBytes(offset, length));
  }

  writeString(offset, value) {
    const bytes = encodeUtf8(value);
    this.writeBytes(offset, bytes);
    return bytes.length;
  }
}

const STDIN_PIPE_HEADER_INTS = 3;
const STDIN_PIPE_HEADER_BYTES = STDIN_PIPE_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const STDIN_PIPE_READ_INDEX = 0;
const STDIN_PIPE_WRITE_INDEX = 1;
const STDIN_PIPE_CLOSED_INDEX = 2;

function stdinPipeState(pipe) {
  const buffer = pipe?.buffer;
  if (
    typeof SharedArrayBuffer === 'undefined' ||
    !(buffer instanceof SharedArrayBuffer) ||
    buffer.byteLength <= STDIN_PIPE_HEADER_BYTES
  ) {
    return null;
  }
  return {
    header: new Int32Array(buffer, 0, STDIN_PIPE_HEADER_INTS),
    bytes: new Uint8Array(buffer, STDIN_PIPE_HEADER_BYTES),
  };
}

function stdinPipeAvailable(state, readIndex, writeIndex) {
  const capacity = state.bytes.byteLength;
  return readIndex <= writeIndex
    ? writeIndex - readIndex
    : capacity - readIndex + writeIndex;
}

function staticStdinBytesFromText(text) {
  return encodeUtf8(String(text || ''));
}

class WasiProcess {
  constructor(options) {
    this.args = options.args || [];
    this.env = options.env || {};
    this.fs = options.fs;
    this.cwd = normalizePath(options.cwd || '/');
    this.fs.addDirectory(this.cwd);
    this.stdinPipe = stdinPipeState(options.stdinPipe);
    this.stdinBytes = options.stdinBytes instanceof Uint8Array
      ? options.stdinBytes
      : options.stdinText !== undefined
        ? staticStdinBytesFromText(options.stdinText)
        : new Uint8Array();
    this.outputBudget = options.outputBudget || null;
    this.inputDeviceOffsets = new Map();
    this.stdoutChunks = [];
    this.stderrChunks = [];
    this.onOutput = options.onOutput;
    this.kernelHttp = options.kernelHttp || null;
    this.socketHostsByToken = new Map();
    this.nextSocketHostToken = 1;
    this.kernelDevices = wasiKernelDevices(options);
    this.knownKernelDevices = new Set(this.kernelDevices.keys());
    this.filestatSizeOffset = options.filestatSizeOffset || 32;
    this.fds = new Map([
      [0, this.stdioEntryForDevice('/dev/stdin')],
      [1, this.stdioEntryForDevice('/dev/stdout')],
      [2, this.stdioEntryForDevice('/dev/stderr')],
      [3, { kind: 'dir', path: this.cwd, offset: 0, readable: true, writable: false, preopen: '/' }],
    ]);
    this.nextFd = 4;
    this.memory = null;
    this.mem = null;
  }

  setMemory(memory) {
    this.memory = memory;
    this.mem = new MemoryView(memory);
  }

  get stdout() {
    return decodeUtf8(concatBytes(this.stdoutChunks));
  }

  get stderr() {
    return decodeUtf8(concatBytes(this.stderrChunks));
  }

  bind(name) {
    if (typeof this[name] === 'function') return this[name].bind(this);
    return () => ENOTSUP;
  }

  // Host functions imported through the `tracecode_kernel` wasm import module
  // by the auto-linked tracecode_socket.c shim. Together with the standard
  // WASI sock_accept/sock_recv/sock_send imports, these back plain BSD-socket
  // programs: connect/send speak HTTP bytes which the worker converts to
  // TraceKernel HTTP messages, so user code never sees a TraceCode API.
  tracecodeKernelImports() {
    return {
      sock_open: (domain, _type) => {
        if (domain !== 1 && domain !== 2) return -EAFNOSUPPORT;
        const fd = this.nextFd++;
        this.fds.set(fd, {
          kind: 'socket',
          readable: true,
          writable: true,
          offset: 0,
          socket: { role: 'tcp' },
        });
        return fd;
      },
      sock_connect: (fd, ipValue, port) => {
        const entry = this.fds.get(fd);
        if (entry?.kind !== 'socket') return -EBADF;
        if (entry.socket.role !== 'tcp') return -EISCONN;
        if (!this.kernelHttp) return -ECONNREFUSED;
        const host = this.socketHostForIp(ipValue >>> 0);
        if (host === null) return -ECONNREFUSED;
        entry.socket = {
          role: 'client',
          host,
          port: port & 0xffff,
          sendBytes: new Uint8Array(),
          recvBytes: new Uint8Array(),
          recvOffset: 0,
          failed: false,
        };
        return 0;
      },
      sock_bind: (fd, ipValue, port) => {
        const entry = this.fds.get(fd);
        if (entry?.kind !== 'socket') return -EBADF;
        if (entry.socket.role !== 'tcp') return -EINVAL;
        const ip = ipValue >>> 0;
        const host = ip === 0 ? '127.0.0.1' : this.socketHostForIp(ip);
        if (host === null) return -EAFNOSUPPORT;
        entry.socket.bind = { host, port: port & 0xffff };
        return 0;
      },
      sock_listen: (fd, _backlog) => {
        const entry = this.fds.get(fd);
        if (entry?.kind !== 'socket') return -EBADF;
        if (entry.socket.role === 'listener') return 0;
        if (entry.socket.role !== 'tcp') return -EINVAL;
        if (!this.kernelHttp) return -EAFNOSUPPORT;
        const bind = entry.socket.bind ?? { host: '127.0.0.1', port: 0 };
        const result = this.kernelHttp.listen({ host: bind.host, port: bind.port });
        if (result.error !== undefined) {
          return String(result.error).includes('EADDRINUSE') ? -EADDRINUSE : -EACCES;
        }
        entry.socket = {
          role: 'listener',
          serverId: result.serverId,
          host: result.host,
          port: result.port,
        };
        return 0;
      },
      sock_port: (fd) => {
        const entry = this.fds.get(fd);
        if (entry?.kind !== 'socket') return -EBADF;
        if (entry.socket.role === 'listener') return entry.socket.port;
        if (entry.socket.role === 'client') return entry.socket.port;
        if (entry.socket.bind) return entry.socket.bind.port;
        return -ENOTCONN;
      },
      sock_resolve: (hostPtr, hostLen) => {
        const host = decodeUtf8(this.mem.readBytes(hostPtr, hostLen >>> 0)).trim().toLowerCase();
        if (!host || host.length > 255) return -EINVAL;
        if (this.nextSocketHostToken > 0xffff) return -EAFNOSUPPORT;
        for (const [token, existing] of this.socketHostsByToken) {
          if (existing === host) return token;
        }
        const token = this.nextSocketHostToken++;
        this.socketHostsByToken.set(token, host);
        return token;
      },
    };
  }

  socketHostForIp(ip) {
    if ((ip >>> 16) === CPP_SOCKET_RESOLVED_PREFIX) {
      return this.socketHostsByToken.get(ip & 0xffff) ?? null;
    }
    return dottedQuadFromU32(ip);
  }

  socketEntry(fd) {
    const entry = this.fds.get(fd);
    return entry?.kind === 'socket' ? entry : null;
  }

  // Appends program-written bytes to a socket. Client sockets dispatch each
  // complete HTTP request through the kernel bridge and queue the serialized
  // response for reading; server sockets answer their accepted request once
  // the written response is complete.
  socketWrite(entry, bytes) {
    const socket = entry.socket;
    if (socket.role === 'client') {
      socket.sendBytes = concatBytes([socket.sendBytes, bytes]);
      while (true) {
        const extracted = extractCppHttpRequest(socket.sendBytes);
        if (!extracted) break;
        if (extracted.error) {
          socket.sendBytes = new Uint8Array();
          socket.failed = true;
          break;
        }
        socket.sendBytes = cloneBytes(socket.sendBytes.subarray(extracted.consumed));
        const request = cppHttpRequestToKernelRequest(extracted.head, extracted.body, socket.host, socket.port);
        const response = this.kernelHttp
          ? this.kernelHttp.dispatch(request, 0)
          : { status: 0 };
        if (!Number.isFinite(response?.status) || response.status <= 0) {
          // Transport-level failure (connection refused, timeout, abort):
          // surface as the peer closing the connection without a response.
          socket.failed = true;
          continue;
        }
        socket.recvBytes = concatBytes([socket.recvBytes, serializeCppHttpResponse(response)]);
      }
      return bytes.length;
    }
    if (socket.role === 'server') {
      socket.sendBytes = concatBytes([socket.sendBytes, bytes]);
      this.trySocketServerRespond(socket, false);
      return bytes.length;
    }
    return -ENOTCONN;
  }

  trySocketServerRespond(socket, closing) {
    if (socket.responded || !this.kernelHttp) return;
    const parsed = parseCppHttpResponseBytes(socket.sendBytes);
    if (parsed?.complete || (closing && parsed)) {
      socket.responded = true;
      const { complete: _complete, ...response } = parsed;
      this.kernelHttp.respond(socket.serverId, response);
      return;
    }
    if (closing) {
      socket.responded = true;
      this.kernelHttp.respond(socket.serverId, {
        status: 500,
        headers: { 'content-type': 'text/plain' },
        body: 'C++ HTTP server closed the connection without a valid response\n',
      });
    }
  }

  socketRead(entry, maxLength) {
    const socket = entry.socket;
    if (socket.role === 'client') {
      const available = socket.recvBytes.length - socket.recvOffset;
      if (available <= 0) return new Uint8Array();
      const length = Math.min(maxLength, available);
      const chunk = cloneBytes(socket.recvBytes.subarray(socket.recvOffset, socket.recvOffset + length));
      socket.recvOffset += length;
      if (socket.recvOffset >= socket.recvBytes.length) {
        socket.recvBytes = new Uint8Array();
        socket.recvOffset = 0;
      }
      return chunk;
    }
    if (socket.role === 'server') {
      const available = socket.recvBytes.length - socket.recvOffset;
      if (available <= 0) return new Uint8Array();
      const length = Math.min(maxLength, available);
      const chunk = cloneBytes(socket.recvBytes.subarray(socket.recvOffset, socket.recvOffset + length));
      socket.recvOffset += length;
      return chunk;
    }
    return null;
  }

  closeSocket(entry) {
    const socket = entry.socket;
    if (socket.role === 'server') {
      this.trySocketServerRespond(socket, true);
      return;
    }
    if (socket.role === 'listener' && this.kernelHttp) {
      this.kernelHttp.close(socket.serverId);
    }
  }

  sock_accept(fd, _flags, fdOut) {
    const entry = this.socketEntry(fd);
    if (!entry) return EBADF;
    if (entry.socket.role !== 'listener') return EINVAL;
    if (!this.kernelHttp) return ENOTSUP;
    const result = this.kernelHttp.nextRequest(entry.socket.serverId, 0);
    if (!result.request) return ECONNABORTED;
    const requestBytes = serializeCppHttpRequest(result.request, entry.socket.host, entry.socket.port);
    const connFd = this.nextFd++;
    this.fds.set(connFd, {
      kind: 'socket',
      readable: true,
      writable: true,
      offset: 0,
      socket: {
        role: 'server',
        serverId: entry.socket.serverId,
        recvBytes: requestBytes,
        recvOffset: 0,
        sendBytes: new Uint8Array(),
        responded: false,
      },
    });
    this.mem.writeU32(fdOut, connFd);
    return ESUCCESS;
  }

  sock_recv(fd, riDataPtr, riDataLen, _riFlags, roDataLenOut, roFlagsOut) {
    const entry = this.socketEntry(fd);
    if (!entry) return EBADF;
    let total = 0;
    for (let index = 0; index < riDataLen; index += 1) {
      const ptr = this.mem.readU32(riDataPtr + index * 8);
      const len = this.mem.readU32(riDataPtr + index * 8 + 4);
      const chunk = this.socketRead(entry, len);
      if (chunk === null) return ENOTCONN;
      this.mem.writeBytes(ptr, chunk);
      total += chunk.length;
      if (chunk.length < len) break;
    }
    this.mem.writeU32(roDataLenOut, total);
    this.mem.writeU16(roFlagsOut, 0);
    return ESUCCESS;
  }

  sock_send(fd, siDataPtr, siDataLen, _siFlags, soDataLenOut) {
    const entry = this.socketEntry(fd);
    if (!entry) return EBADF;
    const chunks = [];
    for (let index = 0; index < siDataLen; index += 1) {
      const ptr = this.mem.readU32(siDataPtr + index * 8);
      const len = this.mem.readU32(siDataPtr + index * 8 + 4);
      chunks.push(this.mem.readBytes(ptr, len));
    }
    const written = this.socketWrite(entry, concatBytes(chunks));
    if (written < 0) return -written;
    this.mem.writeU32(soDataLenOut, written);
    return ESUCCESS;
  }

  sock_shutdown(fd, how) {
    const entry = this.socketEntry(fd);
    if (!entry) return EBADF;
    // sdflags: 1 = RD, 2 = WR. Shutting down the write side finalizes a
    // pending server response.
    if ((how & 2) !== 0 && entry.socket.role === 'server') {
      this.trySocketServerRespond(entry.socket, true);
    }
    return ESUCCESS;
  }

  resolveFdPath(fd, pathPtr, pathLen) {
    const entry = this.fds.get(fd);
    if (!entry) return null;
    const path = this.mem.readString(pathPtr, pathLen);
    if (path.startsWith('/')) return normalizePath(path);
    const virtualPath = normalizePath(path);
    if (
      path === 'proc' ||
      path === 'dev' ||
      this.isKnownDevicePath(virtualPath) ||
      standaloneKernelDevices().has(virtualPath) ||
      this.isKernelVirtualPathOperand(virtualPath) ||
      this.isKernelVirtualNamespaceOperand(virtualPath)
    ) {
      return virtualPath;
    }
    const base = entry.kind === 'dir' ? entry.path : dirname(entry.path || '/');
    return resolveAt(base, path);
  }

  stdioEntryForDevice(device, devices = this.kernelDevices) {
    const normalizedDevice = normalizePath(device);
    const info = devices.get(normalizedDevice) || standaloneKernelDevices().get(normalizedDevice);
    if (!info) return { kind: 'stdio', device, offset: 0, readable: false, writable: false, inputDevice: '', outputDevice: '' };
    return {
      kind: 'stdio',
      device: info.path,
      offset: 0,
      readable: info.readable,
      writable: info.writable,
      inputDevice: info.inputDevice || '',
      outputDevice: info.outputDevice || '',
    };
  }

  stdioEntryForPath(pathname, options = {}) {
    const entry = this.stdioEntryForDevice(pathname);
    if (!entry.device || !this.kernelDevices.has(normalizePath(pathname))) return null;
    if (options.create || options.truncate || options.append) return entry.writable ? entry : null;
    if (options.write && !entry.writable) return null;
    if (!options.write && !entry.readable) return null;
    if (options.read && !entry.readable && !entry.writable) return null;
    return entry;
  }

  isKnownDevicePath(pathname) {
    return this.knownKernelDevices.has(normalizePath(pathname));
  }

  kernelVirtualPathTarget(pathname) {
    return runtimeKernelVirtualPathTarget(pathname, {
      knownDevices: this.knownKernelDevices,
      readOnlyPaths: this.fs.readOnlyFiles,
    });
  }

  isKernelVirtualPathOperand(pathname) {
    const normalized = normalizePath(pathname);
    if (normalized === '/') return false;
    for (const path of this.fs.readOnlyFiles) {
      if (normalized === path || path.startsWith(`${normalized}/`)) return true;
    }
    return false;
  }

  isKernelVirtualNamespaceOperand(pathname) {
    const normalized = normalizePath(pathname);
    if (normalized === '/') return false;
    for (const path of this.fs.readOnlyFiles) {
      const slash = path.indexOf('/', 1);
      const root = slash < 0 ? path : path.slice(0, slash);
      if (normalized === root || normalized.startsWith(`${root}/`)) return true;
    }
    return false;
  }

  kernelVirtualMutationErrno(pathname, missingErrno = ENOENT) {
    const target = runtimeKernelVirtualMutationTarget(pathname, {
      knownDevices: this.knownKernelDevices,
      readOnlyPaths: this.fs.readOnlyFiles,
    });
    if (target.kind === 'workspace') return null;
    return target.reason === 'device-not-found' ? missingErrno : EROFS;
  }

  parentDirectoryErrno(pathname) {
    const parent = dirname(pathname);
    if (parent === '/') return null;
    if (this.fs.isFile(parent)) return ENOTDIR;
    if (!this.fs.isDirectory(parent)) return ENOENT;
    return null;
  }

  filetypeForPath(pathname) {
    const normalized = normalizePath(pathname);
    const target = this.kernelVirtualPathTarget(normalized);
    if (target.kind === 'device-directory') return FILETYPE_DIRECTORY;
    if (target.kind === 'device-file') return FILETYPE_CHARACTER_DEVICE;
    if (this.fs.isDirectory(normalized)) return FILETYPE_DIRECTORY;
    return FILETYPE_REGULAR_FILE;
  }

  openFile(pathname, options = {}) {
    const normalized = normalizePath(pathname);
    const target = this.kernelVirtualPathTarget(normalized);
    if (target.kind === 'device-directory') {
      return options.directory ? this.allocateFd({ kind: 'dir', path: normalized, offset: 0, readable: true, writable: false }) : -EISDIR;
    }
    const stdioEntry = this.stdioEntryForPath(normalized, options);
    if (stdioEntry) {
      return this.allocateFd(stdioEntry);
    }
    if (target.kind === 'device-file') {
      return -EBADF;
    }
    if (target.kind === 'device-not-found') {
      return -ENOENT;
    }
    if ((target.kind === 'proc' || target.kind === 'read-only-file') && (options.create || options.truncate || options.append || options.write)) {
      return -EROFS;
    }
    if (options.directory) {
      if (!this.fs.isDirectory(normalized)) return -ENOENT;
      return this.allocateFd({ kind: 'dir', path: normalized, offset: 0, readable: true, writable: false });
    }

    if (!this.fs.exists(normalized)) {
      if (!options.create) return -ENOENT;
      const parentErrno = this.parentDirectoryErrno(normalized);
      if (parentErrno !== null) return -parentErrno;
      this.fs.writeFile(normalized, new Uint8Array());
    } else if (options.exclusive) {
      return -EEXIST;
    }

    if (this.fs.isDirectory(normalized)) {
      if (options.write || options.truncate || options.append || options.create) return -EISDIR;
      return this.allocateFd({ kind: 'dir', path: normalized, offset: 0, readable: true, writable: false });
    }

    if (options.truncate) {
      this.fs.writeFile(normalized, new Uint8Array());
    }

    const offset = options.append ? this.fs.readFile(normalized).length : 0;
    return this.allocateFd({ kind: 'file', path: normalized, offset, readable: true, writable: !this.fs.isReadOnly(normalized) && options.write !== false, append: Boolean(options.append) });
  }

  allocateFd(entry) {
    const fd = this.nextFd++;
    this.fds.set(fd, entry);
    return fd;
  }

  writeFilestat(pathname, outPtr) {
    const normalized = normalizePath(pathname);
    const target = this.kernelVirtualPathTarget(normalized);
    if (target.kind === 'device-directory' || target.kind === 'device-file') {
      this.mem.writeU64(outPtr, 1);
      this.mem.writeU64(outPtr + 8, inodeForPath(normalized));
      this.mem.writeU8(outPtr + 16, this.filetypeForPath(normalized));
      this.mem.writeU64(outPtr + 24, this.filestatSizeOffset === 24 ? 0n : 1n);
      this.mem.writeU64(outPtr + 32, 0);
      this.mem.writeU64(outPtr + 40, 0);
      this.mem.writeU64(outPtr + 48, 0);
      this.mem.writeU64(outPtr + 56, 0);
      return ESUCCESS;
    }
    if (target.kind === 'device-not-found') return ENOENT;
    const isDir = this.fs.isDirectory(normalized);
    const isFile = this.fs.isFile(normalized);
    if (!isDir && !isFile) return ENOENT;
    const size = isFile ? this.fs.readFile(normalized).length : 0;
    this.mem.writeU64(outPtr, 1);
    this.mem.writeU64(outPtr + 8, inodeForPath(normalized));
    this.mem.writeU8(outPtr + 16, isDir ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
    this.mem.writeU64(outPtr + 24, this.filestatSizeOffset === 24 ? BigInt(size) : 1);
    this.mem.writeU64(outPtr + 32, BigInt(size));
    this.mem.writeU64(outPtr + 40, 0);
    this.mem.writeU64(outPtr + 48, 0);
    this.mem.writeU64(outPtr + 56, 0);
    return ESUCCESS;
  }

  args_sizes_get(argcOut, argvBufSizeOut) {
    const encoded = this.args.map((arg) => encodeUtf8(`${arg}\0`));
    this.mem.writeU32(argcOut, encoded.length);
    this.mem.writeU32(argvBufSizeOut, encoded.reduce((sum, arg) => sum + arg.length, 0));
    return ESUCCESS;
  }

  args_get(argvOut, argvBuf) {
    let ptrOffset = argvOut;
    let bufOffset = argvBuf;
    for (const arg of this.args) {
      const bytes = encodeUtf8(`${arg}\0`);
      this.mem.writeU32(ptrOffset, bufOffset);
      this.mem.writeBytes(bufOffset, bytes);
      ptrOffset += 4;
      bufOffset += bytes.length;
    }
    return ESUCCESS;
  }

  environ_sizes_get(countOut, bufSizeOut) {
    const entries = Object.entries(this.env).map(([key, value]) => encodeUtf8(`${key}=${value}\0`));
    this.mem.writeU32(countOut, entries.length);
    this.mem.writeU32(bufSizeOut, entries.reduce((sum, entry) => sum + entry.length, 0));
    return ESUCCESS;
  }

  environ_get(environOut, environBuf) {
    let ptrOffset = environOut;
    let bufOffset = environBuf;
    for (const [key, value] of Object.entries(this.env)) {
      const bytes = encodeUtf8(`${key}=${value}\0`);
      this.mem.writeU32(ptrOffset, bufOffset);
      this.mem.writeBytes(bufOffset, bytes);
      ptrOffset += 4;
      bufOffset += bytes.length;
    }
    return ESUCCESS;
  }

  fd_write(fd, iovs, iovsLen, nwrittenOut) {
    const entry = this.fds.get(fd);
    if (entry?.kind === 'file' && this.fs.isReadOnly(entry.path)) return EROFS;
    if (!entry || !entry.writable) return EBADF;
    const chunks = [];
    let total = 0;
    for (let index = 0; index < iovsLen; index += 1) {
      const ptr = this.mem.readU32(iovs + index * 8);
      const len = this.mem.readU32(iovs + index * 8 + 4);
      const bytes = this.mem.readBytes(ptr, len);
      chunks.push(bytes);
      total += len;
    }

    if (entry.kind === 'socket') {
      const written = this.socketWrite(entry, concatBytes(chunks));
      if (written < 0) return -written;
      this.mem.writeU32(nwrittenOut, written);
      return ESUCCESS;
    }

    if (entry.kind === 'stdio' && entry.outputDevice) {
      if (entry.outputDevice === '/dev/null') {
        this.mem.writeU32(nwrittenOut, total);
        return ESUCCESS;
      }
      const stream = entry.outputDevice === '/dev/stderr' ? 'stderr' : 'stdout';
      const outputChunks = this.outputBudget ? this.outputBudget.capture(stream, chunks) : chunks;
      if (stream === 'stdout') this.stdoutChunks.push(...outputChunks);
      if (stream === 'stderr') this.stderrChunks.push(...outputChunks);
      if (outputChunks.length > 0) {
        this.onOutput?.(stream, decodeUtf8(concatBytes(outputChunks)), entry.device, entry.outputDevice);
      }
    } else if (entry.kind === 'file') {
      const current = this.fs.exists(entry.path) ? this.fs.readFile(entry.path) : new Uint8Array();
      const offset = entry.append ? current.length : entry.offset;
      const next = new Uint8Array(Math.max(current.length, offset + total));
      next.set(current);
      let writeOffset = offset;
      for (const chunk of chunks) {
        next.set(chunk, writeOffset);
        writeOffset += chunk.length;
      }
      entry.offset = writeOffset;
      this.fs.writeFile(entry.path, next);
    }

    this.mem.writeU32(nwrittenOut, total);
    return ESUCCESS;
  }

  fd_read(fd, iovs, iovsLen, nreadOut) {
    const entry = this.fds.get(fd);
    if (!entry || !entry.readable) return EBADF;
    if (entry.kind === 'socket') {
      let total = 0;
      for (let index = 0; index < iovsLen; index += 1) {
        const ptr = this.mem.readU32(iovs + index * 8);
        const len = this.mem.readU32(iovs + index * 8 + 4);
        const chunk = this.socketRead(entry, len);
        if (chunk === null) return ENOTCONN;
        this.mem.writeBytes(ptr, chunk);
        total += chunk.length;
        if (chunk.length < len) break;
      }
      this.mem.writeU32(nreadOut, total);
      return ESUCCESS;
    }
    if (entry.kind === 'stdio' && entry.inputDevice && entry.inputDevice !== '/dev/null' && this.stdinPipe) {
      return this.fd_read_stdin_pipe(iovs, iovsLen, nreadOut);
    }
    const source = entry.kind === 'stdio' && entry.inputDevice && entry.inputDevice !== '/dev/null'
      ? this.stdinBytes
      : entry.kind === 'file'
        ? this.fs.readFile(entry.path)
        : new Uint8Array();
    let sourceOffset = entry.kind === 'stdio' && entry.inputDevice
      ? this.inputDeviceOffsets.get(entry.inputDevice) ?? 0
      : entry.offset;
    let total = 0;
    for (let index = 0; index < iovsLen; index += 1) {
      const ptr = this.mem.readU32(iovs + index * 8);
      const len = this.mem.readU32(iovs + index * 8 + 4);
      const chunk = source.subarray(sourceOffset, sourceOffset + len);
      this.mem.writeBytes(ptr, chunk);
      sourceOffset += chunk.length;
      total += chunk.length;
      if (chunk.length < len) break;
    }
    entry.offset = sourceOffset;
    if (entry.kind === 'stdio' && entry.inputDevice) {
      this.inputDeviceOffsets.set(entry.inputDevice, sourceOffset);
    }
    this.mem.writeU32(nreadOut, total);
    return ESUCCESS;
  }

  readStdinPipeBytes(maxLength, block) {
    const state = this.stdinPipe;
    if (!state || maxLength <= 0) return new Uint8Array();
    const capacity = state.bytes.byteLength;
    while (true) {
      const readIndex = Atomics.load(state.header, STDIN_PIPE_READ_INDEX);
      const writeIndex = Atomics.load(state.header, STDIN_PIPE_WRITE_INDEX);
      const available = stdinPipeAvailable(state, readIndex, writeIndex);
      if (available > 0) {
        const length = Math.min(maxLength, available);
        const out = new Uint8Array(length);
        const firstLength = Math.min(length, capacity - readIndex);
        out.set(state.bytes.subarray(readIndex, readIndex + firstLength), 0);
        if (firstLength < length) {
          out.set(state.bytes.subarray(0, length - firstLength), firstLength);
        }
        Atomics.store(state.header, STDIN_PIPE_READ_INDEX, (readIndex + length) % capacity);
        return out;
      }
      if (Atomics.load(state.header, STDIN_PIPE_CLOSED_INDEX) !== 0 || !block) {
        return new Uint8Array();
      }
      Atomics.wait(state.header, STDIN_PIPE_WRITE_INDEX, writeIndex);
    }
  }

  fd_read_stdin_pipe(iovs, iovsLen, nreadOut) {
    let total = 0;
    for (let index = 0; index < iovsLen; index += 1) {
      const ptr = this.mem.readU32(iovs + index * 8);
      const len = this.mem.readU32(iovs + index * 8 + 4);
      const chunk = this.readStdinPipeBytes(len, total === 0);
      this.mem.writeBytes(ptr, chunk);
      total += chunk.length;
      if (chunk.length < len) break;
    }
    this.mem.writeU32(nreadOut, total);
    return ESUCCESS;
  }

  fd_pwrite(fd, iovs, iovsLen, offset, nwrittenOut) {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== 'file') return EBADF;
    if (!entry.writable) return EBADF;
    if (this.fs.isReadOnly(entry.path)) return EROFS;
    const oldOffset = entry.offset;
    entry.offset = Number(offset);
    const result = this.fd_write(fd, iovs, iovsLen, nwrittenOut);
    entry.offset = oldOffset;
    return result;
  }

  fd_pread(fd, iovs, iovsLen, offset, nreadOut) {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== 'file') return EBADF;
    const oldOffset = entry.offset;
    entry.offset = Number(offset);
    const result = this.fd_read(fd, iovs, iovsLen, nreadOut);
    entry.offset = oldOffset;
    return result;
  }

  fd_seek(fd, offset, whence, newOffsetOut) {
    const entry = this.fds.get(fd);
    if (!entry) return EBADF;
    if (entry.kind === 'socket') return ESPIPE;
    const fileSize = entry.kind === 'file' && this.fs.exists(entry.path) ? this.fs.readFile(entry.path).length : 0;
    const currentOffset = entry.kind === 'stdio' && entry.inputDevice
      ? this.inputDeviceOffsets.get(entry.inputDevice) ?? entry.offset ?? 0
      : entry.offset;
    const rawOffset = Number(offset);
    if (whence === WHENCE_SET) entry.offset = rawOffset;
    else if (whence === WHENCE_CUR) entry.offset = currentOffset + rawOffset;
    else if (whence === WHENCE_END) entry.offset = fileSize + rawOffset;
    else return EINVAL;
    if (entry.offset < 0) entry.offset = 0;
    if (entry.kind === 'stdio' && entry.inputDevice) {
      this.inputDeviceOffsets.set(entry.inputDevice, entry.offset);
    }
    this.mem.writeU64(newOffsetOut, BigInt(entry.offset));
    return ESUCCESS;
  }

  fd_tell(fd, offsetOut) {
    const entry = this.fds.get(fd);
    if (!entry) return EBADF;
    const offset = entry.kind === 'stdio' && entry.inputDevice
      ? this.inputDeviceOffsets.get(entry.inputDevice) ?? entry.offset ?? 0
      : entry.offset || 0;
    this.mem.writeU64(offsetOut, BigInt(offset));
    return ESUCCESS;
  }

  fd_close(fd) {
    if (fd <= 2) return ESUCCESS;
    const entry = this.fds.get(fd);
    if (!entry) return EBADF;
    if (entry.kind === 'socket') this.closeSocket(entry);
    this.fds.delete(fd);
    return ESUCCESS;
  }

  fd_sync() {
    return ESUCCESS;
  }

  fd_datasync() {
    return ESUCCESS;
  }

  fd_fdstat_get(fd, outPtr) {
    const entry = this.fds.get(fd);
    if (!entry) return EBADF;
    const filetype = entry.kind === 'dir'
      ? FILETYPE_DIRECTORY
      : entry.kind === 'stdio'
        ? FILETYPE_CHARACTER_DEVICE
        : entry.kind === 'socket'
          ? FILETYPE_SOCKET_STREAM
          : FILETYPE_REGULAR_FILE;
    this.mem.writeU8(outPtr, filetype);
    this.mem.writeU16(outPtr + 2, entry.append ? FDFLAGS_APPEND : 0);
    this.mem.writeU64(outPtr + 8, 0xffff_ffffn);
    this.mem.writeU64(outPtr + 16, 0xffff_ffffn);
    return ESUCCESS;
  }

  fd_fdstat_set_flags(fd, flags) {
    const entry = this.fds.get(fd);
    if (!entry) return EBADF;
    entry.append = Boolean(flags & FDFLAGS_APPEND);
    return ESUCCESS;
  }

  fd_filestat_get(fd, outPtr) {
    const entry = this.fds.get(fd);
    if (!entry) return EBADF;
    if (entry.kind === 'stdio') return this.writeFilestat(entry.device, outPtr);
    return this.writeFilestat(entry.path, outPtr);
  }

  fd_filestat_set_size(fd, size) {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== 'file') return EBADF;
    if (!entry.writable) return EBADF;
    if (this.fs.isReadOnly(entry.path)) return EROFS;
    this.fs.resizeFile(entry.path, Number(size));
    return ESUCCESS;
  }

  fd_filestat_set_times(fd) {
    const entry = this.fds.get(fd);
    if (!entry) return EBADF;
    if (entry.kind === 'stdio') return EROFS;
    const virtualErrno = this.kernelVirtualMutationErrno(entry.path);
    if (virtualErrno !== null) return virtualErrno;
    if (!this.fs.exists(entry.path)) return ENOENT;
    this.fs.emitPathSnapshot(entry.path);
    return ESUCCESS;
  }

  fd_allocate(fd, offset, length) {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== 'file') return EBADF;
    if (!entry.writable) return EBADF;
    if (this.fs.isReadOnly(entry.path)) return EROFS;
    const end = Number(offset) + Number(length);
    if (!Number.isFinite(end) || end < 0) return EINVAL;
    const currentSize = this.fs.exists(entry.path) ? this.fs.readFile(entry.path).length : 0;
    if (end > currentSize) this.fs.resizeFile(entry.path, end);
    return ESUCCESS;
  }

  fd_prestat_get(fd, outPtr) {
    const entry = this.fds.get(fd);
    if (!entry || !entry.preopen) return EBADF;
    const name = entry.preopen;
    this.mem.writeU8(outPtr, 0);
    this.mem.writeU32(outPtr + 4, encodeUtf8(name).length);
    return ESUCCESS;
  }

  fd_prestat_dir_name(fd, pathPtr, pathLen) {
    const entry = this.fds.get(fd);
    if (!entry || !entry.preopen) return EBADF;
    this.mem.writeBytes(pathPtr, encodeUtf8(entry.preopen).subarray(0, pathLen));
    return ESUCCESS;
  }

  fd_readdir(fd, bufPtr, bufLen, cookie, bufUsedOut) {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== 'dir') return EBADF;
    const names = [
      '.',
      '..',
      ...(isRuntimeDeviceDirectory(entry.path)
        ? [...this.kernelDevices.keys()]
            .filter((path) => path.startsWith('/dev/'))
            .map((path) => path.slice('/dev/'.length))
            .filter(Boolean)
            .sort()
        : this.fs.listDirectory(entry.path)),
    ];
    let offset = 0;
    const start = Number(cookie);
    for (let index = start; index < names.length; index += 1) {
      const name = names[index];
      const childPath = name === '.' ? entry.path : name === '..' ? dirname(entry.path) : resolveAt(entry.path, name);
      const nameBytes = encodeUtf8(name);
      const entrySize = 24 + nameBytes.length;
      if (offset + entrySize > bufLen) break;
      this.mem.writeU64(bufPtr + offset, BigInt(index + 1));
      this.mem.writeU64(bufPtr + offset + 8, BigInt(index + 1));
      this.mem.writeU32(bufPtr + offset + 16, nameBytes.length);
      this.mem.writeU8(bufPtr + offset + 20, this.filetypeForPath(childPath));
      this.mem.writeBytes(bufPtr + offset + 24, nameBytes);
      offset += entrySize;
    }
    this.mem.writeU32(bufUsedOut, offset);
    return ESUCCESS;
  }

  path_open(dirfd, _dirflags, pathPtr, pathLen, oflags, rightsBase, _rightsInheriting, fdflags, openedFdOut) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    const fd = this.openFile(pathname, {
      create: Boolean(oflags & OFLAGS_CREAT),
      directory: Boolean(oflags & OFLAGS_DIRECTORY),
      exclusive: Boolean(oflags & OFLAGS_EXCL),
      truncate: Boolean(oflags & OFLAGS_TRUNC),
      append: Boolean(fdflags & FDFLAGS_APPEND),
      read: (wasiRights(rightsBase) & RIGHTS_FD_READ) !== 0n,
      write: (wasiRights(rightsBase) & RIGHTS_FD_WRITE) !== 0n,
    });
    if (fd < 0) return -fd;
    this.mem.writeU32(openedFdOut, fd);
    return ESUCCESS;
  }

  path_filestat_get(dirfd, _flags, pathPtr, pathLen, outPtr) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    return this.writeFilestat(pathname, outPtr);
  }

  path_filestat_set_times(dirfd, _flags, pathPtr, pathLen) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    const virtualErrno = this.kernelVirtualMutationErrno(pathname);
    if (virtualErrno !== null) return virtualErrno;
    if (!this.fs.exists(pathname)) return ENOENT;
    this.fs.emitPathSnapshot(pathname);
    return ESUCCESS;
  }

  path_create_directory(dirfd, pathPtr, pathLen) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    const virtualErrno = this.kernelVirtualMutationErrno(pathname);
    if (virtualErrno !== null) return virtualErrno;
    if (this.fs.exists(pathname)) return EEXIST;
    const parentErrno = this.parentDirectoryErrno(pathname);
    if (parentErrno !== null) return parentErrno;
    this.fs.addDirectory(pathname);
    return ESUCCESS;
  }

  path_unlink_file(dirfd, pathPtr, pathLen) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    const virtualErrno = this.kernelVirtualMutationErrno(pathname);
    if (virtualErrno !== null) return virtualErrno;
    return this.fs.unlink(pathname);
  }

  path_remove_directory(dirfd, pathPtr, pathLen) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    const virtualErrno = this.kernelVirtualMutationErrno(pathname, ENOTDIR);
    if (virtualErrno !== null) return virtualErrno;
    if (this.fs.isFile(pathname)) return ENOTDIR;
    return this.fs.removeDirectory(pathname);
  }

  path_rename(oldFd, oldPathPtr, oldPathLen, newFd, newPathPtr, newPathLen) {
    const oldPath = this.resolveFdPath(oldFd, oldPathPtr, oldPathLen);
    const newPath = this.resolveFdPath(newFd, newPathPtr, newPathLen);
    if (!oldPath || !newPath) return EBADF;
    const oldVirtualErrno = this.kernelVirtualMutationErrno(oldPath);
    if (oldVirtualErrno !== null) return oldVirtualErrno;
    const newVirtualErrno = this.kernelVirtualMutationErrno(newPath);
    if (newVirtualErrno !== null) return newVirtualErrno;
    const parentErrno = this.parentDirectoryErrno(newPath);
    if (parentErrno !== null) return parentErrno;
    return this.fs.rename(oldPath, newPath);
  }

  path_readlink(dirfd, pathPtr, pathLen, _bufPtr, _bufLen, bufUsedOut) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    if (bufUsedOut) this.mem.writeU32(bufUsedOut, 0);
    return EINVAL;
  }

  path_symlink(_oldPathPtr, _oldPathLen, dirfd, newPathPtr, newPathLen) {
    const newPath = this.resolveFdPath(dirfd, newPathPtr, newPathLen);
    if (!newPath) return EBADF;
    const virtualErrno = this.kernelVirtualMutationErrno(newPath);
    if (virtualErrno !== null) return virtualErrno;
    return ENOTSUP;
  }

  path_link(oldFd, _oldFlags, oldPathPtr, oldPathLen, newFd, newPathPtr, newPathLen) {
    const oldPath = this.resolveFdPath(oldFd, oldPathPtr, oldPathLen);
    const newPath = this.resolveFdPath(newFd, newPathPtr, newPathLen);
    if (!oldPath || !newPath) return EBADF;
    const oldVirtualErrno = this.kernelVirtualMutationErrno(oldPath);
    if (oldVirtualErrno !== null) return oldVirtualErrno;
    const newVirtualErrno = this.kernelVirtualMutationErrno(newPath);
    if (newVirtualErrno !== null) return newVirtualErrno;
    const parentErrno = this.parentDirectoryErrno(newPath);
    if (parentErrno !== null) return parentErrno;
    return this.fs.link(oldPath, newPath);
  }

  random_get(buf, bufLen) {
    const bytes = new Uint8Array(bufLen);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    }
    this.mem.writeBytes(buf, bytes);
    return ESUCCESS;
  }

  clock_time_get(_clockId, _precision, timeOut) {
    this.mem.writeU64(timeOut, BigInt(Date.now()) * 1_000_000n);
    return ESUCCESS;
  }

  poll_oneoff(_inPtr, _outPtr, _nsubscriptions, neventsOut) {
    this.mem.writeU32(neventsOut, 0);
    return ESUCCESS;
  }

  proc_exit(code) {
    throw new ProcExit(Number(code));
  }
}

// Synchronous TraceKernel HTTP bridge. Mirrors the Java worker protocol: the
// worker thread posts kernel-http-*-sync messages carrying SharedArrayBuffers
// and blocks on Atomics.wait while the client services them through the
// command's RuntimeKernelHttpBridge. Manifests are newline-delimited with
// base64 fields so the C++ side can parse them without a JSON library.
const CPP_KERNEL_HTTP_SYNC_HEADER_BYTES = 8;
const CPP_KERNEL_HTTP_SYNC_STATE_INDEX = 0;
const CPP_KERNEL_HTTP_SYNC_LENGTH_INDEX = 1;
const CPP_KERNEL_HTTP_SYNC_IDLE = 0;
const CPP_KERNEL_HTTP_SYNC_REQUEST = 1;
const CPP_KERNEL_HTTP_SYNC_RESPONSE = 2;
const CPP_KERNEL_HTTP_SYNC_CLOSED = 3;
const CPP_KERNEL_HTTP_SYNC_BUFFER_BYTES = 4 * 1024 * 1024;
const CPP_KERNEL_HTTP_SYNC_CONTROL_BYTES = 16 * 1024;
const CPP_KERNEL_HTTP_SYNC_WAIT_MS = 30_000;

function cppKernelHttpBase64FromString(value) {
  return encodeBase64(encodeUtf8(String(value ?? '')));
}

function cppKernelHttpStringFromBase64(value) {
  return decodeUtf8(decodeBase64(String(value ?? '')));
}

function cppKernelHttpErrorManifest(message) {
  return `ERROR\n${cppKernelHttpBase64FromString(message || 'TraceKernel HTTP request failed')}`;
}

function cppKernelHttpSyncSupported() {
  return typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined' && typeof Atomics.wait === 'function';
}

function parseCppKernelHttpRequestManifest(manifestBytes) {
  const lines = decodeUtf8(manifestBytes).split('\n');
  if (lines[0] !== 'REQUEST' || lines.length < 6) return null;
  const method = cppKernelHttpStringFromBase64(lines[1]) || 'GET';
  const url = cppKernelHttpStringFromBase64(lines[2]);
  if (!url) return null;
  let path = cppKernelHttpStringFromBase64(lines[3]);
  if (!path) {
    try {
      const parsed = new URL(url, 'http://localhost');
      path = `${parsed.pathname}${parsed.search}`;
    } catch {
      path = '/';
    }
  }
  const headerCount = Number.parseInt(lines[4] ?? '', 10);
  if (!Number.isFinite(headerCount) || headerCount < 0 || lines.length < 5 + headerCount) return null;
  const rawHeaders = [];
  const headers = {};
  for (let index = 0; index < headerCount; index += 1) {
    const [encodedName, encodedValue] = (lines[5 + index] ?? '').split('\t');
    if (!encodedName || encodedValue === undefined) continue;
    const name = cppKernelHttpStringFromBase64(encodedName);
    const value = cppKernelHttpStringFromBase64(encodedValue);
    rawHeaders.push([name, value]);
    headers[name] = value;
  }
  const bodyBase64 = lines[5 + headerCount] ?? '';
  return {
    method,
    url,
    path,
    headers,
    rawHeaders,
    ...(bodyBase64 ? { body: bodyBase64, bodyEncoding: 'base64' } : {}),
  };
}

function parseCppKernelHttpResponseManifest(manifestBytes) {
  const lines = decodeUtf8(manifestBytes).split('\n');
  if (lines[0] === 'ERROR') {
    const message = lines[1] ? cppKernelHttpStringFromBase64(lines[1]) : '';
    return {
      status: 500,
      headers: { 'content-type': 'text/plain' },
      body: cppKernelHttpBase64FromString(`${message || 'TraceKernel HTTP request failed'}\n`),
      bodyEncoding: 'base64',
    };
  }
  if (lines[0] !== 'OK' || lines.length < 4) return null;
  const status = Number.parseInt(lines[1] ?? '', 10);
  const headerCount = Number.parseInt(lines[2] ?? '', 10);
  if (!Number.isFinite(status) || !Number.isFinite(headerCount) || headerCount < 0 || lines.length < 4 + headerCount) {
    return null;
  }
  const rawHeaders = [];
  const headers = {};
  for (let index = 0; index < headerCount; index += 1) {
    const [encodedName, encodedValue] = (lines[3 + index] ?? '').split('\t');
    if (!encodedName || encodedValue === undefined) continue;
    const name = cppKernelHttpStringFromBase64(encodedName);
    const value = cppKernelHttpStringFromBase64(encodedValue);
    rawHeaders.push([name, value]);
    headers[name.toLowerCase()] = value;
  }
  return {
    status,
    headers,
    rawHeaders,
    body: lines[3 + headerCount] ?? '',
    bodyEncoding: 'base64',
  };
}

function cppKernelHttpResponseManifest(response) {
  const status = Number.isFinite(response?.status) ? Math.trunc(response.status) : 500;
  const rawHeaders = Array.isArray(response?.rawHeaders) && response.rawHeaders.length > 0
    ? response.rawHeaders
    : Object.entries(response?.headers ?? {});
  const headerLines = rawHeaders.map(([name, value]) => (
    `${cppKernelHttpBase64FromString(String(name))}\t${cppKernelHttpBase64FromString(String(value))}`
  ));
  const body = response?.body ?? '';
  const bodyBase64 = response?.bodyEncoding === 'base64' ? body : cppKernelHttpBase64FromString(body);
  return ['OK', String(status), String(headerLines.length), ...headerLines, bodyBase64].join('\n');
}

class CppKernelHttpSyncBridge {
  constructor(messageId) {
    this.messageId = messageId;
    this.servers = new Map();
    this.nextServerId = 1;
  }

  post(type, payload) {
    trustedCppWorkerPostMessage({
      id: this.messageId,
      type,
      payload,
      ...(activeRequestProtocolToken ? { protocolToken: activeRequestProtocolToken } : {}),
    });
  }

  waitForSyncManifest(buffer, timeoutMs) {
    const header = new Int32Array(buffer, 0, 2);
    const waitResult = Atomics.wait(header, CPP_KERNEL_HTTP_SYNC_STATE_INDEX, CPP_KERNEL_HTTP_SYNC_IDLE, timeoutMs);
    if (waitResult === 'timed-out') return null;
    const length = Atomics.load(header, CPP_KERNEL_HTTP_SYNC_LENGTH_INDEX);
    const capacity = buffer.byteLength - CPP_KERNEL_HTTP_SYNC_HEADER_BYTES;
    if (!Number.isFinite(length) || length < 0 || length > capacity) return null;
    return cloneBytes(new Uint8Array(buffer, CPP_KERNEL_HTTP_SYNC_HEADER_BYTES, length));
  }

  dispatch(request, timeoutMs) {
    if (!cppKernelHttpSyncSupported()) {
      return {
        status: 0,
        headers: { 'content-type': 'text/plain' },
        body: 'SharedArrayBuffer support is required for C++ TraceKernel HTTP\n',
      };
    }
    const buffer = new SharedArrayBuffer(CPP_KERNEL_HTTP_SYNC_HEADER_BYTES + CPP_KERNEL_HTTP_SYNC_BUFFER_BYTES);
    this.post('kernel-http-dispatch-sync', {
      request,
      buffer,
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs: Math.ceil(timeoutMs) } : {}),
    });
    const manifest = this.waitForSyncManifest(buffer, CPP_KERNEL_HTTP_SYNC_WAIT_MS);
    if (!manifest) {
      return { status: 0, headers: { 'content-type': 'text/plain' }, body: 'TraceKernel HTTP request timed out\n' };
    }
    return parseCppKernelHttpResponseManifest(manifest) ?? {
      status: 0,
      headers: { 'content-type': 'text/plain' },
      body: 'TraceKernel HTTP returned an invalid response\n',
    };
  }

  listen(options) {
    if (!cppKernelHttpSyncSupported()) {
      return { error: 'SharedArrayBuffer support is required for C++ TraceKernel HTTP listeners' };
    }
    const serverId = this.nextServerId++;
    const clientServerId = `cpp-http-${serverId}`;
    const requestBuffer = new SharedArrayBuffer(CPP_KERNEL_HTTP_SYNC_HEADER_BYTES + CPP_KERNEL_HTTP_SYNC_BUFFER_BYTES);
    const controlBuffer = new SharedArrayBuffer(CPP_KERNEL_HTTP_SYNC_HEADER_BYTES + CPP_KERNEL_HTTP_SYNC_CONTROL_BYTES);
    this.servers.set(serverId, { clientServerId, requestBuffer, closed: false });
    this.post('kernel-http-listen-sync', {
      serverId: clientServerId,
      options,
      requestBuffer,
      controlBuffer,
    });
    const controlManifest = this.waitForSyncManifest(controlBuffer, CPP_KERNEL_HTTP_SYNC_WAIT_MS);
    if (!controlManifest) {
      this.servers.delete(serverId);
      return { error: 'TraceKernel HTTP listener registration timed out' };
    }
    const lines = decodeUtf8(controlManifest).split('\n');
    if (lines[0] !== 'OK' || !lines[1]) {
      this.servers.delete(serverId);
      const message = lines[0] === 'ERROR' && lines[1] ? cppKernelHttpStringFromBase64(lines[1]) : '';
      return { error: message || 'TraceKernel HTTP listener registration failed' };
    }
    let info;
    try {
      info = JSON.parse(cppKernelHttpStringFromBase64(lines[1]));
    } catch {
      this.servers.delete(serverId);
      return { error: 'TraceKernel HTTP listener registration returned invalid metadata' };
    }
    const port = Number(info?.port);
    return {
      serverId,
      host: String(info?.host || options.host || '127.0.0.1'),
      port: Number.isFinite(port) ? port : options.port,
    };
  }

  nextRequest(serverId, timeoutMs) {
    const server = this.servers.get(serverId);
    if (!server || server.closed) return { closed: true };
    const header = new Int32Array(server.requestBuffer, 0, 2);
    const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : null;
    while (true) {
      const state = Atomics.load(header, CPP_KERNEL_HTTP_SYNC_STATE_INDEX);
      if (state === CPP_KERNEL_HTTP_SYNC_REQUEST) {
        const length = Atomics.load(header, CPP_KERNEL_HTTP_SYNC_LENGTH_INDEX);
        const capacity = server.requestBuffer.byteLength - CPP_KERNEL_HTTP_SYNC_HEADER_BYTES;
        const safeLength = Math.max(0, Math.min(length, capacity));
        const manifest = cloneBytes(new Uint8Array(server.requestBuffer, CPP_KERNEL_HTTP_SYNC_HEADER_BYTES, safeLength));
        const request = parseCppKernelHttpRequestManifest(manifest);
        if (!request) {
          this.respond(serverId, {
            status: 400,
            headers: { 'content-type': 'text/plain' },
            body: 'TraceKernel HTTP request could not be parsed\n',
          });
          continue;
        }
        return { request };
      }
      if (state === CPP_KERNEL_HTTP_SYNC_CLOSED) return { closed: true };
      const remainingMs = deadline === null ? CPP_KERNEL_HTTP_SYNC_WAIT_MS : deadline - Date.now();
      if (remainingMs <= 0) return { timedOut: true };
      Atomics.wait(
        header,
        CPP_KERNEL_HTTP_SYNC_STATE_INDEX,
        CPP_KERNEL_HTTP_SYNC_IDLE,
        Math.min(remainingMs, CPP_KERNEL_HTTP_SYNC_WAIT_MS)
      );
    }
  }

  respond(serverId, response) {
    const server = this.servers.get(serverId);
    if (!server || server.closed) return false;
    const header = new Int32Array(server.requestBuffer, 0, 2);
    if (Atomics.load(header, CPP_KERNEL_HTTP_SYNC_STATE_INDEX) !== CPP_KERNEL_HTTP_SYNC_REQUEST) return false;
    const bytes = new Uint8Array(server.requestBuffer, CPP_KERNEL_HTTP_SYNC_HEADER_BYTES);
    const encoded = encodeUtf8(cppKernelHttpResponseManifest(response));
    const written = encoded.byteLength > bytes.byteLength
      ? encodeUtf8(cppKernelHttpErrorManifest('TraceKernel HTTP response exceeded C++ bridge buffer capacity'))
      : encoded;
    bytes.set(written.subarray(0, bytes.byteLength));
    Atomics.store(header, CPP_KERNEL_HTTP_SYNC_LENGTH_INDEX, Math.min(written.byteLength, bytes.byteLength));
    Atomics.store(header, CPP_KERNEL_HTTP_SYNC_STATE_INDEX, CPP_KERNEL_HTTP_SYNC_RESPONSE);
    Atomics.notify(header, CPP_KERNEL_HTTP_SYNC_STATE_INDEX);
    return true;
  }

  close(serverId) {
    const server = this.servers.get(serverId);
    if (!server) return;
    this.servers.delete(serverId);
    server.closed = true;
    // Do not overwrite an unread RESPONSE: the client's in-flight dispatch
    // still has to consume it. The client finishes the close once drained.
    const header = new Int32Array(server.requestBuffer, 0, 2);
    Atomics.compareExchange(header, CPP_KERNEL_HTTP_SYNC_STATE_INDEX, CPP_KERNEL_HTTP_SYNC_IDLE, CPP_KERNEL_HTTP_SYNC_CLOSED);
    Atomics.compareExchange(header, CPP_KERNEL_HTTP_SYNC_STATE_INDEX, CPP_KERNEL_HTTP_SYNC_REQUEST, CPP_KERNEL_HTTP_SYNC_CLOSED);
    Atomics.notify(header, CPP_KERNEL_HTTP_SYNC_STATE_INDEX);
    this.post('kernel-http-close', {
      serverId: server.clientServerId,
      requestBuffer: server.requestBuffer,
    });
  }

  closeAll() {
    for (const serverId of Array.from(this.servers.keys())) {
      this.close(serverId);
    }
  }
}

// --- HTTP byte-stream <-> TraceKernel message conversion --------------------
// C++ programs speak plain HTTP over BSD sockets; the worker converts complete
// messages to/from RuntimeKernelHttp requests/responses so the kernel bridge
// (and its routing/policy) stays message-based.

const CPP_HTTP_HEAD_TERMINATOR = encodeUtf8('\r\n\r\n');
// Synthetic resolver range for getaddrinfo results: 198.18.0.0/16 (RFC 2544
// benchmark space) with the low 16 bits carrying the worker's hostname token.
const CPP_SOCKET_RESOLVED_PREFIX = (198 << 8) | 18;

const CPP_HTTP_REASON_PHRASES = new Map([
  [200, 'OK'], [201, 'Created'], [202, 'Accepted'], [204, 'No Content'],
  [206, 'Partial Content'], [301, 'Moved Permanently'], [302, 'Found'],
  [304, 'Not Modified'], [307, 'Temporary Redirect'], [308, 'Permanent Redirect'],
  [400, 'Bad Request'], [401, 'Unauthorized'], [403, 'Forbidden'], [404, 'Not Found'],
  [405, 'Method Not Allowed'], [408, 'Request Timeout'], [409, 'Conflict'],
  [411, 'Length Required'], [413, 'Payload Too Large'], [429, 'Too Many Requests'],
  [500, 'Internal Server Error'], [501, 'Not Implemented'], [502, 'Bad Gateway'],
  [503, 'Service Unavailable'], [504, 'Gateway Timeout'],
]);

function findBytesIndex(haystack, needle, start = 0) {
  outer: for (let index = start; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function parseCppHttpHead(bytes) {
  const headEnd = findBytesIndex(bytes, CPP_HTTP_HEAD_TERMINATOR);
  if (headEnd < 0) return null;
  const headText = decodeUtf8(bytes.subarray(0, headEnd));
  const lines = headText.split('\r\n');
  const startLine = lines[0] ?? '';
  const rawHeaders = [];
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    rawHeaders.push([name, value]);
    headers[name.toLowerCase()] = value;
  }
  return { startLine, rawHeaders, headers, bodyStart: headEnd + CPP_HTTP_HEAD_TERMINATOR.length };
}

function cppHttpContentLength(headers) {
  const value = headers['content-length'];
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// Extracts one complete HTTP request from the front of `bytes`, or null when
// more bytes are needed. Chunked request bodies are not supported.
function extractCppHttpRequest(bytes) {
  const head = parseCppHttpHead(bytes);
  if (!head) return null;
  if (String(head.headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
    return { error: 'chunked request bodies are not supported' };
  }
  const contentLength = cppHttpContentLength(head.headers) ?? 0;
  if (bytes.length < head.bodyStart + contentLength) return null;
  return {
    head,
    body: cloneBytes(bytes.subarray(head.bodyStart, head.bodyStart + contentLength)),
    consumed: head.bodyStart + contentLength,
  };
}

function cppHttpRequestToKernelRequest(head, body, connectHost, connectPort) {
  const [method = 'GET', target = '/'] = head.startLine.split(/\s+/);
  let url;
  let path;
  if (/^https?:\/\//i.test(target)) {
    url = target;
    try {
      const parsed = new URL(target);
      path = `${parsed.pathname}${parsed.search}`;
    } catch {
      path = '/';
    }
  } else {
    path = target.startsWith('/') ? target : `/${target}`;
    const scheme = connectPort === 443 ? 'https' : 'http';
    const defaultPort = scheme === 'https' ? 443 : 80;
    const authority = connectPort === defaultPort ? connectHost : `${connectHost}:${connectPort}`;
    url = `${scheme}://${authority}${path}`;
  }
  return {
    method: method.toUpperCase(),
    url,
    path,
    headers: Object.fromEntries(head.rawHeaders.map(([name, value]) => [String(name).toLowerCase(), value])),
    rawHeaders: head.rawHeaders,
    ...(body.length > 0 ? { body: encodeBase64(body), bodyEncoding: 'base64' } : {}),
  };
}

function cppKernelBodyBytes(message) {
  const body = message?.body ?? '';
  if (!body) return new Uint8Array();
  return message?.bodyEncoding === 'base64' ? decodeBase64(body) : encodeUtf8(body);
}

function serializeCppHttpResponse(response) {
  const status = Number.isFinite(response?.status) ? Math.trunc(response.status) : 500;
  const body = cppKernelBodyBytes(response);
  const reason = CPP_HTTP_REASON_PHRASES.get(status) ?? '';
  const rawHeaders = Array.isArray(response?.rawHeaders) && response.rawHeaders.length > 0
    ? response.rawHeaders
    : Object.entries(response?.headers ?? {});
  const lines = [`HTTP/1.1 ${status}${reason ? ` ${reason}` : ''}`];
  let sawContentLength = false;
  for (const [name, value] of rawHeaders) {
    if (String(name).toLowerCase() === 'transfer-encoding') continue;
    if (String(name).toLowerCase() === 'content-length') {
      sawContentLength = true;
      lines.push(`${name}: ${body.length}`);
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  if (!sawContentLength) lines.push(`Content-Length: ${body.length}`);
  lines.push('Connection: close');
  const headBytes = encodeUtf8(`${lines.join('\r\n')}\r\n\r\n`);
  return concatBytes([headBytes, body]);
}

function serializeCppHttpRequest(request, listenerHost, listenerPort) {
  const method = String(request?.method || 'GET').toUpperCase();
  const path = String(request?.path || '/');
  const body = cppKernelBodyBytes(request);
  const rawHeaders = Array.isArray(request?.rawHeaders) && request.rawHeaders.length > 0
    ? request.rawHeaders
    : Object.entries(request?.headers ?? {});
  const lines = [`${method} ${path} HTTP/1.1`];
  let sawHost = false;
  let sawContentLength = false;
  for (const [name, value] of rawHeaders) {
    const lowered = String(name).toLowerCase();
    if (lowered === 'host') sawHost = true;
    if (lowered === 'transfer-encoding') continue;
    if (lowered === 'content-length') {
      sawContentLength = true;
      lines.push(`${name}: ${body.length}`);
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  if (!sawHost) lines.push(`Host: ${listenerHost}:${listenerPort}`);
  if (!sawContentLength && body.length > 0) lines.push(`Content-Length: ${body.length}`);
  const headBytes = encodeUtf8(`${lines.join('\r\n')}\r\n\r\n`);
  return concatBytes([headBytes, body]);
}

function parseCppHttpResponseBytes(bytes) {
  const head = parseCppHttpHead(bytes);
  if (!head) return null;
  const statusMatch = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})/.exec(head.startLine);
  if (!statusMatch) return null;
  const contentLength = cppHttpContentLength(head.headers);
  const body = contentLength === null
    ? bytes.subarray(head.bodyStart)
    : bytes.subarray(head.bodyStart, head.bodyStart + contentLength);
  return {
    status: Number.parseInt(statusMatch[1], 10),
    headers: Object.fromEntries(head.rawHeaders.map(([name, value]) => [String(name).toLowerCase(), value])),
    rawHeaders: head.rawHeaders,
    ...(body.length > 0 ? { body: encodeBase64(cloneBytes(body)), bodyEncoding: 'base64' } : {}),
    complete: contentLength !== null && bytes.length >= head.bodyStart + contentLength,
  };
}

function dottedQuadFromU32(value) {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

async function instantiateWasi(module, process) {
  const imports = {};
  const wasiNames = [
    'args_get',
    'args_sizes_get',
    'clock_time_get',
    'environ_get',
    'environ_sizes_get',
    'fd_close',
    'fd_datasync',
    'fd_fdstat_get',
    'fd_fdstat_set_flags',
    'fd_allocate',
    'fd_filestat_get',
    'fd_filestat_set_size',
    'fd_filestat_set_times',
    'fd_pread',
    'fd_prestat_dir_name',
    'fd_prestat_get',
    'fd_pwrite',
    'fd_read',
    'fd_readdir',
    'fd_seek',
    'fd_sync',
    'fd_tell',
    'fd_write',
    'path_create_directory',
    'path_filestat_get',
    'path_filestat_set_times',
    'path_link',
    'path_open',
    'path_readlink',
    'path_remove_directory',
    'path_rename',
    'path_symlink',
    'path_unlink_file',
    'poll_oneoff',
    'proc_exit',
    'random_get',
    'sock_accept',
    'sock_recv',
    'sock_send',
    'sock_shutdown',
  ];
  const wasi = Object.fromEntries(wasiNames.map((name) => [name, process.bind(name)]));

  const tracecodeKernelImports = process.tracecodeKernelImports();
  for (const item of WebAssembly.Module.imports(module)) {
    if (item.kind !== 'function') continue;
    if (item.module === 'wasi_snapshot_preview1' || item.module === 'wasi_unstable') {
      imports[item.module] ??= {};
      imports[item.module][item.name] = wasi[item.name] || (() => ENOTSUP);
    } else if (item.module === 'tracecode_kernel') {
      imports[item.module] ??= {};
      imports[item.module][item.name] = tracecodeKernelImports[item.name] || (() => -1);
    } else if (item.module === 'env') {
      imports.env ??= {};
      imports.env[item.name] =
        item.name === 'abort'
          ? () => {
              throw new Error('abort');
            }
          : () => ENOTSUP;
    } else {
      imports[item.module] ??= {};
      imports[item.module][item.name] = () => ENOTSUP;
    }
  }

  const instance = await WebAssembly.instantiate(module, imports);
  const memory = instance.exports.memory;
  if (!memory) {
    throw new Error('WASI module did not export memory.');
  }
  process.setMemory(memory);
  return instance;
}

async function runWasi(module, args, fs, options = {}) {
  const process = new WasiProcess({
    args,
    fs,
    cwd: options.cwd || '/',
    stdinPipe: options.stdinPipe,
    stdinBytes: options.stdinBytes,
    stdinText: options.stdinText,
    env: options.env || { USER: 'tracecode' },
    kernelDevices: options.kernelDevices,
    kernelHttp: options.kernelHttp,
    filestatSizeOffset: options.filestatSizeOffset,
    outputBudget: options.outputBudget,
    onOutput: options.onOutput,
  });
  const instance = await instantiateWasi(module, process);
  const start = instance.exports._start || instance.exports.__main_argc_argv || instance.exports.main;
  if (typeof start !== 'function') {
    throw new Error('WASI module does not export _start or main.');
  }

  let exitCode = 0;
  try {
    start();
  } catch (error) {
    if (error instanceof ProcExit) {
      exitCode = error.code;
    } else {
      throw error;
    }
  }

  return {
    exitCode,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function findClangResourceDir(fs) {
  const prefix = '/lib/clang/';
  const versions = [...fs.dirs]
    .filter((path) => path.startsWith(prefix) && path !== prefix)
    .map((path) => path.slice(prefix.length).split('/')[0])
    .filter(Boolean)
    .sort();
  return versions.length > 0 ? `/lib/clang/${versions[versions.length - 1]}` : '/lib/clang/8.0.1';
}

async function loadToolchain() {
  if (!configuredAssets) {
    throw new Error('C++ worker has not been initialized with toolchain asset URLs.');
  }
  if (toolchainPromise) return toolchainPromise;

  toolchainPromise = (async () => {
    const runtimeHeader = await fetchAsset('tracecode_runtime.hpp', configuredAssets.runtimeHeaderUrl, 'text');
    const injectedCompilerBundle =
      typeof globalThis !== 'undefined' ? globalThis.__tracecodeCppCompilerBundle : undefined;
    if (injectedCompilerBundle && typeof injectedCompilerBundle.runClang === 'function') {
      return {
        compiler: 'yowasp',
        runClang: injectedCompilerBundle.runClang,
        runtimeHeader,
      };
    }

    if (configuredAssets.compilerBundleUrl) {
      try {
        const compilerBundle = await importCppCompilerBundle('C++ compiler bundle', configuredAssets.compilerBundleUrl);
        if (typeof compilerBundle.runClang === 'function') {
          return {
            compiler: 'yowasp',
            runClang: compilerBundle.runClang,
            runtimeHeader,
          };
        }
      } catch {
        // Fall back to raw clang/lld assets. This lets consumers experiment with
        // either focused compiler package without changing the public worker API.
      }
    }

    const [clangBuffer, lldBuffer, sysrootBuffer] = await Promise.all([
      fetchAsset('clang.wasm', configuredAssets.clangWasmUrl, 'arrayBuffer'),
      fetchAsset('lld.wasm', configuredAssets.lldWasmUrl, 'arrayBuffer'),
      fetchAsset('sysroot.tar', configuredAssets.sysrootUrl, 'arrayBuffer'),
    ]);

    const sysrootEntries = parseTarEntries(sysrootBuffer);
    const baseFs = new InMemoryFileSystem();
    baseFs.applyTarEntries(sysrootEntries);
    baseFs.addFile('/tracecode_runtime.hpp', runtimeHeader);
    baseFs.addFile('/tmp/tracecode_runtime.hpp', runtimeHeader);

    return {
      compiler: 'raw-wasi',
      clangModule: await WebAssembly.compile(clangBuffer),
      lldModule: await WebAssembly.compile(lldBuffer),
      baseFs,
    };
  })();

  return toolchainPromise;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/\/\/.*$/gm, '');
}

function cppNoExceptionDefaultReturn(returnType) {
  const valueType = localCppType(String(returnType || 'void'));
  const normalized = stripCppTypeQualifiers(valueType);
  if (!normalized || normalized === 'void') return '';
  if (normalized.endsWith('*') || normalized === 'nullptr_t') return 'nullptr';
  if (normalized === 'bool') return 'false';
  if (normalized === 'string') return 'std::string()';
  if (
    normalized.startsWith('vector<') ||
    normalized.startsWith('array<') ||
    normalized.startsWith('deque<') ||
    normalized.startsWith('queue<') ||
    normalized.startsWith('priority_queue<') ||
    normalized.startsWith('stack<') ||
    normalized.startsWith('unordered_map<') ||
    normalized.startsWith('map<') ||
    normalized.startsWith('unordered_set<') ||
    normalized.startsWith('set<') ||
    normalized.startsWith('pair<') ||
    normalized.startsWith('tuple<')
  ) return '{}';
  if (/^(?:unsigned)?(?:short|int|long|longlong|longlongint|size_t|std::size_t|float|double|longdouble)$/.test(normalized)) {
    return '0';
  }
  return `${valueType}()`;
}

function cppExceptionMessageForThrowExpression(expression) {
  const rawExpression = String(expression || '').trim();
  const stringMatch = rawExpression.match(/"((?:\\.|[^"\\])*)"/);
  if (stringMatch) {
    try {
      return JSON.parse(`"${stringMatch[1]}"`);
    } catch {
      return stringMatch[1];
    }
  }
  return 'C++ exception thrown.';
}

function cppExceptionTraceInstrumentation(lineNumber, message) {
  const eventJson = `{"kind":"exception","line":${lineNumber},"message":${jsonStringLiteral(message)}}`;
  return `tracecode::write_trace_event_json(std::string(${cppStringLiteral(eventJson)}), ${lineNumber});`;
}

function cppThrowReplacementForReturnType(returnType, options = {}) {
  const defaultValue = cppNoExceptionDefaultReturn(returnType);
  const traceInstrumentation = options.traceLine
    ? `${cppExceptionTraceInstrumentation(options.traceLine, options.message || 'C++ exception thrown.')} `
    : '';
  return defaultValue
    ? `{ ${traceInstrumentation}__tracecode_exception_pending = true; return ${defaultValue}; }`
    : `{ ${traceInstrumentation}__tracecode_exception_pending = true; return; }`;
}

function rewriteCppThrowsWithoutExceptions(source, options = {}) {
  if (!/\bthrow\b/.test(source)) return source;
  const lines = source.split(/\r?\n/);
  const output = [];
  const frames = [];
  let depth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    let rewritten = line;
    const lambdaMatch = line.match(/\[[^\]]*\]\s*\([^)]*\)\s*->\s*([^{]+?)\s*\{/);
    const functionMatch = line.match(/^\s*(?!if\b|for\b|while\b|switch\b|catch\b)(?:[A-Za-z_][\w:<>?,*&\s]*?)\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/);
    if (lambdaMatch) {
      frames.push({ depth: depth + braceDeltaForLine(line), returnType: lambdaMatch[1].trim() });
    } else if (functionMatch) {
      const prefix = line.slice(0, line.indexOf(functionMatch[1])).trim();
      const returnType = cleanCppReturnType(prefix);
      frames.push({ depth: depth + braceDeltaForLine(line), returnType });
    }

    const activeFrame = frames.at(-1);
    if (/\bthrow\b/.test(rewritten) && activeFrame) {
      rewritten = rewritten.replace(/throw(?:\s+([^;]+))?\s*;/g, (_match, expression) => (
        cppThrowReplacementForReturnType(activeFrame.returnType, {
          ...(options.emitTraceEvents ? {
            traceLine: lineNumber,
            message: cppExceptionMessageForThrowExpression(expression),
          } : {}),
        })
      ));
    }

    output.push(rewritten);
    depth += braceDeltaForLine(line);
    while (frames.length > 0 && depth < frames.at(-1).depth) frames.pop();
  }

  return output.join('\n');
}

function rewriteTryBodyReturnsForNoExceptions(tryBody, catchBody, tryId = 0) {
  const trimmedCatch = catchBody.trim();
  let returnIndex = 0;
  return tryBody.replace(/^(\s*)return(?:\s+(.+?))?\s*;\s*$/gm, (match, indent, expression) => {
    if (!trimmedCatch) return match;
    if (!expression) {
      return `${indent}if (__tracecode_exception_pending) { __tracecode_exception_pending = false; ${trimmedCatch} }\n${indent}return;`;
    }
    const trimmedExpression = String(expression).trim();
    if (trimmedExpression.startsWith('{')) {
      return `${indent}if (__tracecode_exception_pending) { __tracecode_exception_pending = false; ${trimmedCatch} }\n${indent}return ${trimmedExpression};`;
    }
    const localName = `__tracecode_try_return_${tryId}_${returnIndex++}`;
    return [
      `${indent}auto ${localName} = (${trimmedExpression});`,
      `${indent}if (__tracecode_exception_pending) { __tracecode_exception_pending = false; ${trimmedCatch} }`,
      `${indent}return ${localName};`,
    ].join('\n');
  });
}

function rewriteCppTryCatchWithoutExceptions(source) {
  if (!/\btry\s*\{/.test(source)) return source;
  let output = '';
  let cursor = 0;

  while (cursor < source.length) {
    const tryMatch = /\btry\s*\{/.exec(source.slice(cursor));
    if (!tryMatch) {
      output += source.slice(cursor);
      break;
    }
    const tryStart = cursor + tryMatch.index;
    const tryOpenBrace = source.indexOf('{', tryStart);
    const tryCloseBrace = findMatchingBrace(source, tryOpenBrace);
    if (tryOpenBrace < 0 || tryCloseBrace < 0) {
      output += source.slice(cursor);
      break;
    }
    const catchMatch = /^\s*catch\s*\([^)]*\)\s*\{/.exec(source.slice(tryCloseBrace + 1));
    if (!catchMatch) {
      output += source.slice(cursor, tryCloseBrace + 1);
      cursor = tryCloseBrace + 1;
      continue;
    }
    const catchStart = tryCloseBrace + 1 + catchMatch.index;
    const catchOpenBrace = source.indexOf('{', catchStart);
    const catchCloseBrace = findMatchingBrace(source, catchOpenBrace);
    if (catchOpenBrace < 0 || catchCloseBrace < 0) {
      output += source.slice(cursor);
      break;
    }

    const tryBody = source.slice(tryOpenBrace + 1, tryCloseBrace);
    const catchBody = source.slice(catchOpenBrace + 1, catchCloseBrace);
    const loweredTryBody = rewriteTryBodyReturnsForNoExceptions(tryBody, catchBody, tryStart);
    const loweredCatch = catchBody.trim()
      ? `\nif (__tracecode_exception_pending) { __tracecode_exception_pending = false; ${catchBody.trim()} }\n`
      : '\n__tracecode_exception_pending = false;\n';

    output += source.slice(cursor, tryStart);
    output += `{ __tracecode_exception_pending = false;${loweredTryBody}${loweredCatch}}`;
    cursor = catchCloseBrace + 1;
  }

  return output;
}

function lowerCppExceptionSyntaxForNoExceptions(source, options = {}) {
  if (!/\b(?:try|throw|catch)\b/.test(source)) return source;
  const lowered = rewriteCppThrowsWithoutExceptions(rewriteCppTryCatchWithoutExceptions(source), options);
  return `static bool __tracecode_exception_pending = false;\n${lowered}`;
}

function normalizeCppUserSource(source, options = {}) {
  const withoutUnsupportedIncludes = String(source || '')
    .split(/\r?\n/)
    .map((line) => (/^\s*#\s*include\s*<bits\/stdc\+\+\.h>\s*$/.test(line) ? '' : line))
    .join('\n');
  return lowerCppExceptionSyntaxForNoExceptions(withoutUnsupportedIncludes, {
    emitTraceEvents: options.tracing === true,
  });
}

function splitTopLevelCommaList(source) {
  return splitTopLevel(source, ',').map((part) => part.trim()).filter(Boolean);
}

const CPP_SPACED_TEMPLATE_PREFIXES = new Set([
  'array',
  'deque',
  'map',
  'multimap',
  'multiset',
  'optional',
  'pair',
  'priority_queue',
  'queue',
  'set',
  'stack',
  'tuple',
  'unordered_map',
  'unordered_multimap',
  'unordered_multiset',
  'unordered_set',
  'variant',
  'vector',
]);

function cppTokenBefore(source, index) {
  let end = index - 1;
  while (end >= 0 && /\s/.test(source[end] || '')) end -= 1;
  let start = end;
  while (start >= 0 && /[A-Za-z0-9_:>]/.test(source[start] || '')) start -= 1;
  return source.slice(start + 1, end + 1);
}

function cppTokenAfter(source, index) {
  let start = index + 1;
  while (start < source.length && /\s/.test(source[start] || '')) start += 1;
  let end = start;
  while (end < source.length && /[A-Za-z0-9_:]/.test(source[end] || '')) end += 1;
  return source.slice(start, end);
}

function isCppSpacedTemplatePrefix(token) {
  if (!token) return false;
  if (token.endsWith('>')) return true;
  const unqualified = token.split('::').filter(Boolean).at(-1) || token;
  return CPP_SPACED_TEMPLATE_PREFIXES.has(unqualified) || /^[A-Z]/.test(unqualified);
}

function isCppTemplateAngleStart(source, index) {
  const previousToken = cppTokenBefore(source, index);
  const nextToken = cppTokenAfter(source, index);
  if (!previousToken || !nextToken) return false;
  if (/^\d/.test(previousToken) || /^\d/.test(nextToken)) return false;
  if (!/[A-Za-z_>:]/.test(previousToken.at(-1) || '') || !/^[A-Za-z_:]/.test(nextToken)) return false;
  const compact = !/\s/.test(source[index - 1] || '') && !/\s/.test(source[index + 1] || '');
  return compact || isCppSpacedTemplatePrefix(previousToken);
}

function splitTopLevel(source, separator, options = {}) {
  const trackAngleBrackets = options.trackAngleBrackets !== false;
  const parts = [];
  let current = '';
  let depth = 0;
  let angleDepth = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      current += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (trackAngleBrackets && ch === '<' && isCppTemplateAngleStart(source, index)) {
      angleDepth += 1;
    } else if (trackAngleBrackets && ch === '>' && angleDepth > 0) {
      angleDepth -= 1;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) {
      depth -= 1;
    }
    if (ch === separator && depth === 0 && angleDepth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function findMatchingSquareBracket(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findMatchingAngleBracket(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '<') depth += 1;
    if (ch === '>') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseMethodSignature(source, functionName, options = {}) {
  if (Number.isFinite(options.parameterCount)) {
    const inputNames = new Set(options.inputNames || []);
    const candidates = parseCppFunctionSignatures(source)
      .filter((signature) => signature.name === functionName)
      .filter((signature) => signature.parameters.length === options.parameterCount);
    const namedCandidate = candidates.find((signature) =>
      signature.parameters.every((parameter) => inputNames.size === 0 || inputNames.has(parameter.name))
    );
    if (namedCandidate) return namedCandidate;
    if (candidates.length > 0) return candidates[candidates.length - 1];
  }

  const cleaned = stripComments(source);
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namePattern = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
  let match = null;
  let openParenIndex = -1;
  let closeParenIndex = -1;
  let foundSignatureMatch = false;

  while ((match = namePattern.exec(cleaned))) {
    const previousPrefix = cleaned.slice(0, match.index).trimEnd();
    const previousChar = previousPrefix.at(-1);
    if (previousChar === '.' || previousPrefix.endsWith('->')) continue;
    openParenIndex = cleaned.indexOf('(', match.index);
    closeParenIndex = findMatchingParen(cleaned, openParenIndex);
    if (closeParenIndex < 0) continue;
    const afterSignature = cleaned.slice(closeParenIndex + 1, closeParenIndex + 96);
    if (!/^\s*(?:(?:const|noexcept|override|final)\b\s*|[&]\s*)*(?:\{|:)/.test(afterSignature)) continue;
    foundSignatureMatch = true;
    break;
  }

  if (!foundSignatureMatch || !match || openParenIndex < 0 || closeParenIndex < 0) {
    const functionField = parseFunctionFieldSignature(cleaned, functionName);
    if (functionField) return functionField;
    throw new Error(`Unable to find C++ Solution method "${functionName}".`);
  }

  const signaturePrefix = cleaned.slice(0, match.index);
  const returnTypeMatch = signaturePrefix.match(/([A-Za-z_][\w:\s<>,*&]*?)\s*$/);
  if (!returnTypeMatch) {
    const functionField = parseFunctionFieldSignature(cleaned, functionName);
    if (functionField) return functionField;
    throw new Error(`Unable to parse C++ Solution method "${functionName}" return type.`);
  }

  const parameterText = cleaned.slice(openParenIndex + 1, closeParenIndex);
  const parameters = splitTopLevelCommaList(parameterText).map((parameterSource, index) => {
    const withoutDefault = parameterSource.split('=')[0].trim();
    const paramMatch = withoutDefault.match(/^(.+?)([A-Za-z_]\w*)$/);
    if (!paramMatch) {
      throw new Error(`Unable to parse C++ parameter ${index + 1}: ${parameterSource}`);
    }
    const type = paramMatch[1].trim();
    const name = paramMatch[2].trim();
    return { type, name };
  });

  const functionNameOffset = match.index;
  const line = cleaned.slice(0, functionNameOffset).split(/\r?\n/).length;
  return { returnType: cleanCppReturnType(returnTypeMatch[1]), parameters, line };
}

function parseFunctionFieldSignature(source, functionName) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`\\b(?:std::)?function\\s*<\\s*([^()<>]+?)\\s*\\(([^<>]*)\\)\\s*>\\s+${escaped}\\s*;`));
  if (!match) return null;
  const [, returnType, parameterText] = match;
  const initializerLambda = source.match(new RegExp(`${escaped}\\s*\\(\\s*\\[[^\\]]*\\]\\s*\\(([^)]*)\\)`));
  const parameters = initializerLambda
    ? parseCppParameters(initializerLambda[1])
    : splitTopLevelCommaList(parameterText)
      .filter(Boolean)
      .map((type, index) => ({ type: type.trim(), name: `arg${index}` }));
  const line = source.slice(0, match.index).split(/\r?\n/).length;
  return { returnType: cleanCppReturnType(returnType), parameters, line };
}

function resolveCppObjectMethodMacro(source, operation) {
  const escaped = operation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cleaned = stripComments(source);
  const macroTarget = cleaned.match(new RegExp(`^\\s*#\\s*define\\s+${escaped}\\s+([A-Za-z_]\\w*)\\s*$`, 'm'))?.[1];
  if (macroTarget) return macroTarget;
  if (operation === 'delete' && /\bdeleteKey\s*\(/.test(cleaned)) return 'deleteKey';
  return operation;
}

function cleanCppReturnType(returnType) {
  return String(returnType || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#?\s*include\s*<[^>]+>\s*/, '').trim())
    .filter(Boolean)
    .at(-1) || '';
}

function parseConstructorSignature(source, className, aliases = new Map(), options = {}) {
  const cleaned = stripComments(source);
  const constructorNames = [...new Set([className, normalizeCppType(className, aliases), resolveCppType(className, aliases)])]
    .filter(Boolean);
  const candidates = [];
  for (const constructorName of constructorNames) {
    const escaped = constructorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namePattern = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
    let match = null;

    while ((match = namePattern.exec(cleaned))) {
      const prefix = cleaned.slice(Math.max(0, match.index - 96), match.index);
      if (/~\s*$/.test(prefix)) continue;
      const previousToken = prefix.match(/([A-Za-z_]\w*)\s*$/)?.[1];
      if (
        previousToken &&
        previousToken !== 'public' &&
        previousToken !== 'private' &&
        previousToken !== 'protected' &&
        !/^(?:explicit|inline|constexpr|consteval)$/.test(previousToken)
      ) {
        continue;
      }
      const openParenIndex = cleaned.indexOf('(', match.index);
      const closeParenIndex = findMatchingParen(cleaned, openParenIndex);
      if (closeParenIndex < 0) continue;
      const parameterText = cleaned.slice(openParenIndex + 1, closeParenIndex);
      let parameters;
      try {
        parameters = parseCppParameters(parameterText);
      } catch (_error) {
        continue;
      }
      candidates.push({
        returnType: className,
        parameters,
        line: cleaned.slice(0, match.index).split(/\r?\n/).length,
      });
    }
  }
  if (Number.isFinite(options.parameterCount)) {
    const arityMatch = candidates.find((signature) => signature.parameters.length === options.parameterCount);
    if (arityMatch) return arityMatch;
  }
  if (candidates.length > 0) return candidates[0];

  return { returnType: className, parameters: [], line: 1 };
}

function parseCppParameters(parameterText) {
  return splitTopLevelCommaList(parameterText)
    .filter((parameterSource) => parameterSource && parameterSource.trim() !== 'void')
    .map((parameterSource, index) => {
      const withoutDefault = parameterSource.split('=')[0].trim();
      const paramMatch = withoutDefault.match(/^(.+?)([A-Za-z_]\w*)$/);
      if (!paramMatch) {
        throw new Error(`Unable to parse C++ parameter ${index + 1}: ${parameterSource}`);
      }
      const type = paramMatch[1].trim();
      const name = paramMatch[2].trim();
      return { type, name };
    });
}

function sourceDeclaresCppType(source, name) {
  const cleaned = stripComments(source);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:class|struct)\\s+${escaped}\\b`).test(cleaned) ||
    new RegExp(`\\busing\\s+${escaped}\\b`).test(cleaned) ||
    new RegExp(`\\btypedef\\b[^;]*\\b${escaped}\\s*;`).test(cleaned);
}

function buildTracecodeFallbackAliases(source) {
  const aliases = [];
  if (!sourceDeclaresCppType(source, 'TreeNode')) aliases.push('using tracecode::TreeNode;');
  if (!sourceDeclaresCppType(source, 'ListNode')) aliases.push('using tracecode::ListNode;');
  return aliases.join('\n');
}

function buildCppLexicalAccessVariables(frameStack) {
  const activeFrame = frameStack.at(-1) || null;
  if (!activeFrame?.signature?.lambda) {
    return activeFrame?.variables || new Map();
  }
  const variables = new Map();
  for (const frame of frameStack) {
    for (const [name, variable] of frame.variables || []) {
      variables.set(name, variable);
    }
  }
  return variables;
}

function buildCppLexicalIndexedElementAliases(frameStack) {
  const activeFrame = frameStack.at(-1) || null;
  if (!activeFrame?.signature?.lambda) {
    return activeFrame?.indexedElementAliases || new Map();
  }
  const aliases = new Map();
  for (const frame of frameStack) {
    for (const [name, alias] of frame.indexedElementAliases || []) {
      aliases.set(name, alias);
    }
  }
  return aliases;
}

function sourceDeclaresSolutionClass(source) {
  return /\b(?:class|struct)\s+Solution\b/.test(stripComments(source));
}

function collectCppDeclaredClassNames(source) {
  const names = new Set();
  const cleaned = stripComments(source);
  const pattern = /\b(?:class|struct)\s+([A-Za-z_]\w*)\b/g;
  let match;
  while ((match = pattern.exec(cleaned))) {
    names.add(match[1]);
  }
  return [...names];
}

function sourceDeclaresCustomToJson(source, type) {
  const normalized = normalizeCppType(type);
  if (!/^[A-Za-z_]\w*$/.test(normalized)) return false;
  return new RegExp(`\\btoJson\\s*\\(\\s*(?:const\\s+)?${escapeRegExp(normalized)}\\s*(?:&|\\b)`).test(stripComments(source));
}

function cppJsonExpressionForValue(expression, type, source) {
  return sourceDeclaresCustomToJson(source, type) ? `toJson(${expression})` : `tracecode::to_json(${expression})`;
}

function collectTraceContainerMemberNames(source, aliases = new Map(), className = 'Solution') {
  const names = new Set();
  const members = collectTraceContainerMemberVariables(source, aliases, className);
  for (const [name, member] of members) {
    const normalizedType = normalizeCppType(member.type, aliases);
    const innerType = normalizedType.startsWith('vector<') ? normalizedType.slice('vector<'.length, -1).trim() : '';
    if (
      (isVectorCppType(member.type, aliases) && innerType !== 'string')
    ) {
      names.add(name);
    }
  }
  return names;
}

function collectTraceContainerMemberVariables(source, aliases = new Map(), className = 'Solution') {
  const members = new Map();
  const cleaned = stripComments(source);
  const classMatch = cleaned.match(new RegExp(`\\b(?:class|struct)\\s+${escapeRegExp(className)}\\b[\\s\\S]*?\\{([\\s\\S]*?)\\n\\s*public\\s*:`)) ||
    cleaned.match(new RegExp(`\\b(?:class|struct)\\s+${escapeRegExp(className)}\\b[\\s\\S]*?\\{([\\s\\S]*?)\\n\\s*\\};`));
  if (!classMatch) return members;
  for (const line of classMatch[1].split(/\r?\n/)) {
    const variables = extractDeclaredSnapshotVariables(`${line.trim().replace(/^(?:public|private|protected)\s*:\s*/, '')}`, aliases);
    for (const variable of variables) {
      if (isTraceWrappedCppType(variable.type, aliases)) members.set(variable.name, { type: variable.type, scopeDepth: 0 });
    }
  }
  return members;
}

function collectSerializableMemberVariables(source, aliases = new Map(), className = 'Solution') {
  const members = new Map();
  const cleaned = stripComments(source);
  const classMatch = cleaned.match(new RegExp(`\\b(?:class|struct)\\s+${escapeRegExp(className)}\\b[\\s\\S]*?\\{([\\s\\S]*?)\\n\\s*public\\s*:`)) ||
    cleaned.match(new RegExp(`\\b(?:class|struct)\\s+${escapeRegExp(className)}\\b[\\s\\S]*?\\{([\\s\\S]*?)\\n\\s*\\};`));
  if (!classMatch) return members;
  for (const line of classMatch[1].split(/\r?\n/)) {
    const variables = extractDeclaredSnapshotVariables(`${line.trim().replace(/^(?:public|private|protected)\s*:\s*/, '')}`, aliases);
    for (const variable of variables) {
      if (isSnapshotSerializableCppType(variable.type, aliases)) {
        members.set(variable.name, { type: variable.type, scopeDepth: 0 });
      }
    }
  }
  return members;
}

function isScriptExecutionRequest(functionName, options = {}) {
  return !String(functionName || '').trim() && options.executionStyle === 'function';
}

function parseCppFunctionSignatures(source) {
  const cleaned = stripComments(source);
  const signatures = parseCppLambdaSignatures(cleaned);
  const namePattern = /\b([A-Za-z_]\w*)\s*\(/g;
  const skippedNames = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
    'sizeof',
    'decltype',
    'static_cast',
    'dynamic_cast',
    'reinterpret_cast',
    'const_cast',
  ]);
  let match;

  while ((match = namePattern.exec(cleaned))) {
    const name = match[1];
    if (skippedNames.has(name)) continue;

    const openParenIndex = cleaned.indexOf('(', match.index);
    const closeParenIndex = findMatchingParen(cleaned, openParenIndex);
    if (closeParenIndex < 0) continue;

    let cursor = closeParenIndex + 1;
    while (/\s/.test(cleaned[cursor] || '')) cursor += 1;
    while (/^(?:const|noexcept|override|final)\b/.test(cleaned.slice(cursor))) {
      const qualifier = cleaned.slice(cursor).match(/^(?:const|noexcept|override|final)\b/)?.[0] || '';
      cursor += qualifier.length;
      while (/\s/.test(cleaned[cursor] || '')) cursor += 1;
    }
    if (cleaned[cursor] !== '{') continue;
    const closeBraceIndex = findMatchingBrace(cleaned, cursor);
    if (
      closeBraceIndex > cursor &&
      cleaned.slice(0, closeBraceIndex).split(/\r?\n/).length === cleaned.slice(0, cursor).split(/\r?\n/).length
    ) {
      namePattern.lastIndex = closeParenIndex + 1;
      continue;
    }

    const signaturePrefix = cleaned.slice(0, match.index);
    const returnTypeMatch = signaturePrefix.match(/([A-Za-z_][\w:\s<>,*&]*?)\s*$/);
    if (!returnTypeMatch) continue;
    const returnType = cleanCppReturnType(returnTypeMatch[1]);
    if (/^(?:class|struct|public:|private:|protected:)$/.test(returnType)) continue;

    const parameterText = cleaned.slice(openParenIndex + 1, closeParenIndex);
    let parameters;
    try {
      parameters = parseCppParameters(parameterText);
    } catch (_error) {
      namePattern.lastIndex = closeParenIndex + 1;
      continue;
    }
    const line = cleaned.slice(0, match.index).split(/\r?\n/).length;
    signatures.push({
      name,
      returnType,
      parameters,
      line,
      bodyLine: cleaned.slice(0, cursor).split(/\r?\n/).length,
    });
    namePattern.lastIndex = closeParenIndex + 1;
  }

  return signatures.sort((left, right) => left.line - right.line || left.bodyLine - right.bodyLine);
}

function cppStdFunctionReturnType(type) {
  const normalized = String(type || '').trim().replace(/^std::/, '');
  const match = normalized.match(/^function\s*<([\s\S]+)>\s*$/);
  if (!match) return null;
  const signature = match[1].trim();
  let depth = 0;
  for (let index = 0; index < signature.length; index += 1) {
    const ch = signature[index];
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === '(' && depth === 1) {
      return cleanCppReturnType(signature.slice(0, index).trim()) || null;
    }
  }
  return null;
}

function rewriteCppStdFunctionTraceTypes(line, aliases = new Map()) {
  if (!line.includes('function')) return line;
  let rewritten = line;
  const pattern = /\b(?:std::)?function\s*</g;
  let match;
  while ((match = pattern.exec(rewritten))) {
    const typeStart = match.index;
    const openAngleIndex = rewritten.indexOf('<', typeStart);
    const closeAngleIndex = findMatchingAngleBracket(rewritten, openAngleIndex);
    if (openAngleIndex < 0 || closeAngleIndex < 0) {
      pattern.lastIndex = typeStart + match[0].length;
      continue;
    }

    const signature = rewritten.slice(openAngleIndex + 1, closeAngleIndex).trim();
    const openParenIndex = signature.indexOf('(');
    if (openParenIndex < 0) {
      pattern.lastIndex = closeAngleIndex + 1;
      continue;
    }
    const closeParenIndex = findMatchingParen(signature, openParenIndex);
    if (closeParenIndex < 0) {
      pattern.lastIndex = closeAngleIndex + 1;
      continue;
    }

    const returnType = signature.slice(0, openParenIndex).trim();
    const argsSource = signature.slice(openParenIndex + 1, closeParenIndex);
    const args = splitTopLevelCommaList(argsSource);
    const rewrittenArgs = args.map((arg) => {
      const trimmed = arg.trim();
      if (!trimmed || trimmed === 'void' || /\bconst\b/.test(trimmed)) return trimmed;
      const referenceSuffix = trimmed.endsWith('&&') ? '&&' : trimmed.endsWith('&') ? '&' : '';
      const baseType = referenceSuffix ? trimmed.slice(0, -referenceSuffix.length).trim() : trimmed;
      return isTraceWrappedCppType(baseType, aliases)
        ? `${cppTraceType(baseType, aliases)}${referenceSuffix}`
        : trimmed;
    });
    if (args.length === rewrittenArgs.length && args.every((arg, index) => arg.trim() === rewrittenArgs[index])) {
      pattern.lastIndex = closeAngleIndex + 1;
      continue;
    }

    const functionPrefix = rewritten.slice(typeStart, openAngleIndex);
    const replacement = `${functionPrefix}<${returnType}(${rewrittenArgs.join(', ')})>`;
    rewritten = `${rewritten.slice(0, typeStart)}${replacement}${rewritten.slice(closeAngleIndex + 1)}`;
    pattern.lastIndex = typeStart + replacement.length;
  }
  return rewritten;
}

function parseCppLambdaSignatures(source) {
  const signatures = [];
  const lines = source.split(/\r?\n/);
  const lambdaPattern = /\b(auto|(?:std::)?function\s*<[^=;]+>)\s+([A-Za-z_]\w*)\s*=\s*\[[^\]]*\]\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?\s*\{/;
  const inlineLambdaPattern = /\[[^\]]*\]\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?\s*\{/g;
  const lambdaHeaderStartPattern = /\b(?:auto|(?:std::)?function\s*<[^=;]+>)\s+([A-Za-z_]\w*)\s*=\s*\[[^\]]*\]\s*\(([^)]*)\)\s*$/;

  lines.forEach((line, index) => {
    const match = line.match(lambdaPattern);
    if (match) {
      const [, declarationType, name, parameterText, returnType] = match;
      signatures.push({
        name,
        returnType: (returnType || cppStdFunctionReturnType(declarationType) || 'auto').trim(),
        parameters: parseCppParameters(parameterText),
        line: index + 1,
        bodyLine: index + 1,
        lambda: true,
      });
    } else {
      const multilineStart = line.match(lambdaHeaderStartPattern);
      if (multilineStart) {
        let header = line;
        let bodyLine = index + 1;
        for (let nextIndex = index + 1; nextIndex < lines.length && nextIndex <= index + 6; nextIndex += 1) {
          header += `\n${lines[nextIndex]}`;
          bodyLine = nextIndex + 1;
          if (stripCppStringsAndComments(lines[nextIndex]).includes('{') || /;\s*$/.test(lines[nextIndex].trim())) {
            break;
          }
        }
        const flattenedHeader = header.replace(/\s+/g, ' ');
        const multilineMatch = flattenedHeader.match(lambdaPattern);
        if (multilineMatch) {
          const [, declarationType, name, parameterText, returnType] = multilineMatch;
          signatures.push({
            name,
            returnType: (returnType || cppStdFunctionReturnType(declarationType) || 'auto').trim(),
            parameters: parseCppParameters(parameterText),
            line: index + 1,
            bodyLine,
            lambda: true,
          });
        }
      }
    }

    inlineLambdaPattern.lastIndex = 0;
    let inlineMatch;
    while ((inlineMatch = inlineLambdaPattern.exec(line))) {
      const assignmentPrefix = line.slice(0, inlineMatch.index);
      const assignedLambda = assignmentPrefix.match(/(\b(?:auto|(?:std::)?function\s*<[^=;]+>)\s+)?([A-Za-z_]\w*)\s*=\s*$/);
      const hasDeclaration = Boolean(assignedLambda?.[1]);
      const assignedName = assignedLambda?.[2];
      if (!assignedName) continue;
      if (assignedName && match?.[2] === assignedName) continue;
      const [, parameterText, returnType] = inlineMatch;
      signatures.push({
        name: hasDeclaration ? assignedName : `<lambda:${index + 1}>`,
        returnType: (returnType || 'auto').trim(),
        parameters: parseCppParameters(parameterText),
        line: index + 1,
        bodyLine: index + 1,
        lambda: true,
      });
    }
  });

  return signatures;
}

function collectCppTypeAliases(source) {
  const aliases = new Map();
  const cleaned = stripComments(source);
  const usingPattern = /\busing\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g;
  let match;
  while ((match = usingPattern.exec(cleaned))) {
    aliases.set(match[1], match[2].trim());
  }

  const typedefPattern = /\btypedef\s+([^;]+?)\s+([A-Za-z_]\w*)\s*;/g;
  while ((match = typedefPattern.exec(cleaned))) {
    aliases.set(match[2], match[1].trim());
  }
  return aliases;
}

function stripCppTypeQualifiers(type) {
  return type
    .replace(/\bconst\b/g, '')
    .replace(/[&]/g, '')
    .replace(/\s+/g, '')
    .replace(/\bstd::/g, '');
}

function resolveCppType(type, aliases = new Map(), seen = new Set()) {
  const trimmed = type.trim();
  const normalized = stripCppTypeQualifiers(trimmed);
  if (aliases.has(normalized) && !seen.has(normalized)) {
    seen.add(normalized);
    return resolveCppType(aliases.get(normalized), aliases, seen);
  }
  return trimmed;
}

function normalizeCppType(type, aliases = new Map()) {
  return stripCppTypeQualifiers(resolveCppType(type, aliases));
}

function localCppType(type) {
  return type
    .replace(/\b(?:public|private|protected)\s*:\s*/g, '')
    .replace(/\b(?:static|inline|constexpr|consteval|constinit|virtual|friend|explicit|extern|mutable)\b/g, '')
    .replace(/\bconst\b/g, '')
    .replace(/[&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNullCppReturnType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return normalized === 'nullptr_t' || normalized === 'std::nullptr_t' || normalized === 'void*';
}

function materializedCppType(type, aliases = new Map()) {
  return localCppType(resolveCppType(type, aliases));
}

function findCppClassBodyRange(source, className) {
  const cleaned = stripComments(String(source || ''));
  const escapedName = String(className).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b(class|struct)\\s+${escapedName}\\b`, 'g');
  let match;
  while ((match = pattern.exec(cleaned))) {
    const openBrace = cleaned.indexOf('{', match.index + match[0].length);
    if (openBrace < 0) continue;
    const closeBrace = findMatchingBrace(cleaned, openBrace);
    if (closeBrace > openBrace) {
      return { kind: match[1], start: openBrace + 1, end: closeBrace, body: cleaned.slice(openBrace + 1, closeBrace) };
    }
  }
  return null;
}

function cppBraceDepthBefore(source, endIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < endIndex; index += 1) {
    const ch = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') depth = Math.max(0, depth - 1);
  }
  return depth;
}

function parseCppPublicDataFields(typeBody, kind) {
  const fields = [];
  let access = kind === 'struct' ? 'public' : 'private';
  for (const rawStatement of splitTopLevel(typeBody, ';')) {
    let statement = rawStatement.trim();
    if (!statement) continue;
    const accessMatches = [...statement.matchAll(/\b(public|private|protected)\s*:/g)];
    if (accessMatches.length > 0) {
      access = accessMatches[accessMatches.length - 1][1];
      statement = statement.replace(/\b(?:public|private|protected)\s*:/g, '').trim();
      if (!statement) continue;
    }
    if (access !== 'public') continue;
    if (/[(){}]/.test(statement)) continue;
    if (/^(?:using|typedef|friend|static|constexpr|consteval|constinit|template)\b/.test(statement)) continue;
    statement = statement
      .replace(/\s*=\s*[\s\S]*$/, '')
      .replace(/\s*([*&]+)\s*([A-Za-z_]\w*)$/, ' $1 $2')
      .trim();
    if (!statement || splitTopLevelCommaList(statement).length > 1) continue;
    const match = statement.match(/^(.+?)\s+([A-Za-z_]\w*)$/);
    if (!match) continue;
    const fieldType = match[1].replace(/\bmutable\b/g, '').trim();
    const fieldName = match[2].trim();
    if (!fieldType || !fieldName) continue;
    fields.push({ type: fieldType, name: fieldName });
  }
  return fields;
}

function cppMemberAccessAt(body, index, initialAccess) {
  let access = initialAccess;
  const prefix = body.slice(0, Math.max(0, index));
  const accessPattern = /\b(public|private|protected)\s*:/g;
  let match;
  while ((match = accessPattern.exec(prefix))) {
    if (cppBraceDepthBefore(body, match.index) === 0) {
      access = match[1];
    }
  }
  return access;
}

function collectCppNestedTypes(source, ownerName = 'Solution') {
  const range = findCppClassBodyRange(source, ownerName);
  const types = [];
  if (!range) return types;
  const body = range.body;
  const initialAccess = range.kind === 'struct' ? 'public' : 'private';
  const pattern = /\b(struct|class)\s+([A-Za-z_]\w*)\b[^;{]*\{/g;
  let match;
  while ((match = pattern.exec(body))) {
    if (cppBraceDepthBefore(body, match.index) !== 0) continue;
    const kind = match[1];
    const name = match[2];
    const access = cppMemberAccessAt(body, match.index, initialAccess);
    const openBrace = body.indexOf('{', match.index + match[0].length - 1);
    const closeBrace = findMatchingBrace(body, openBrace);
    if (openBrace < 0 || closeBrace <= openBrace) continue;
    const typeBody = body.slice(openBrace + 1, closeBrace);
    types.push({
      kind,
      name,
      access,
      qualifiedName: `${ownerName}::${name}`,
      fields: parseCppPublicDataFields(typeBody, kind),
    });
    pattern.lastIndex = closeBrace + 1;
  }
  return types;
}

function collectCppTopLevelTypes(source) {
  const cleaned = stripComments(String(source || ''));
  const types = [];
  const pattern = /\b(struct|class)\s+([A-Za-z_]\w*)\b[^;{]*\{/g;
  let match;
  while ((match = pattern.exec(cleaned))) {
    if (cppBraceDepthBefore(cleaned, match.index) !== 0) continue;
    const kind = match[1];
    const name = match[2];
    const openBrace = cleaned.indexOf('{', match.index + match[0].length - 1);
    const closeBrace = findMatchingBrace(cleaned, openBrace);
    if (openBrace < 0 || closeBrace <= openBrace) continue;
    pattern.lastIndex = closeBrace + 1;
    if (name === 'Solution') continue;
    const typeBody = cleaned.slice(openBrace + 1, closeBrace);
    types.push({
      kind,
      name,
      access: 'public',
      qualifiedName: name,
      fields: parseCppPublicDataFields(typeBody, kind),
    });
  }
  return types;
}

function collectCppSignatureCustomTypeNames(signature, aliases = new Map()) {
  const names = new Set();
  const visit = (type) => {
    const normalized = materializedCppType(type, aliases).replace(/\s+/g, '').replace(/\bstd::/g, '');
    if (!normalized || isPrimitiveCppType(normalized) || normalized === 'void' || normalized === 'nullptr_t') return;
    if (normalized.endsWith('*')) return;
    const templateStart = normalized.indexOf('<');
    if (templateStart >= 0 && normalized.endsWith('>')) {
      for (const arg of splitTopLevelCommaList(normalized.slice(templateStart + 1, -1))) {
        visit(arg);
      }
      return;
    }
    if (/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?$/.test(normalized)) {
      names.add(normalized);
      names.add(normalized.split('::').pop());
    }
  };
  visit(signature.returnType);
  for (const parameter of signature.parameters || []) {
    visit(parameter.type);
  }
  return names;
}

function buildCppDriverTypeContext(source, ownerName = 'Solution', signature = null, aliases = new Map()) {
  const signatureCustomTypeNames = signature ? collectCppSignatureCustomTypeNames(signature, aliases) : null;
  const signatureUsesType = (type) =>
    !signatureCustomTypeNames ||
    signatureCustomTypeNames.has(type.name) ||
    signatureCustomTypeNames.has(type.qualifiedName);
  const topLevelTypes = collectCppTopLevelTypes(source);
  const nestedTypes = collectCppNestedTypes(source, ownerName);
  const availableTypes = [...topLevelTypes, ...nestedTypes];
  if (signatureCustomTypeNames) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const type of availableTypes) {
        if (!signatureCustomTypeNames.has(type.name) && !signatureCustomTypeNames.has(type.qualifiedName)) continue;
        for (const field of type.fields) {
          const fieldNames = collectCppSignatureCustomTypeNames({ returnType: field.type, parameters: [] }, aliases);
          for (const name of fieldNames) {
            if (!signatureCustomTypeNames.has(name)) {
              signatureCustomTypeNames.add(name);
              changed = true;
            }
          }
        }
      }
    }
  }
  const jsonTypes = availableTypes.filter(signatureUsesType);
  const publicJsonTypes = jsonTypes.filter((type) => type.access === 'public' && type.fields.length > 0);
  return {
    ownerName,
    topLevelTypes,
    nestedTypes,
    jsonTypes,
    nestedTypeNames: new Set(nestedTypes.map((type) => type.name)),
    customJsonTypes: new Set(publicJsonTypes.map((type) => type.qualifiedName)),
  };
}

function qualifyCppTypeForDriver(type, context) {
  if (!context || !context.nestedTypeNames || context.nestedTypeNames.size === 0) return type;
  let out = String(type || '');
  for (const nestedTypeName of context.nestedTypeNames) {
    const escaped = nestedTypeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![:\\w])${escaped}(?![\\w])`, 'g'), `${context.ownerName}::${nestedTypeName}`);
  }
  return out;
}

function qualifyCppSignatureForDriver(signature, context, aliases = new Map()) {
  if (!context || context.nestedTypeNames.size === 0) return signature;
  return {
    ...signature,
    returnType: qualifyCppTypeForDriver(resolveCppType(signature.returnType, aliases), context),
    parameters: signature.parameters.map((parameter) => ({
      ...parameter,
      type: qualifyCppTypeForDriver(resolveCppType(parameter.type, aliases), context),
    })),
  };
}

function buildCppJsonObjectAdapters(context, aliases = new Map()) {
  const adapterTypes = (context?.jsonTypes ?? context?.nestedTypes ?? []).filter((type) => type.access === 'public' && type.fields.length > 0);
  if (adapterTypes.length === 0) return '';
  const adapters = adapterTypes.map((type) => {
    const fieldReads = type.fields.flatMap((field) => {
      const fieldType = qualifyCppTypeForDriver(field.type, context);
      return [
        `    if (const JsonValue* found = object_get(value, ${cppStringLiteral(field.name)})) {`,
        `      out.${field.name} = tracecode::json_to<${materializedCppType(fieldType, aliases)}>(*found);`,
        '    }',
      ];
    });
    const jsonLines = type.fields.flatMap((field, index) => [
      `    if (${index} > 0) json += ",";`,
      `    json += tracecode::to_json(std::string(${cppStringLiteral(field.name)}));`,
      `    json += ":";`,
      `    json += tracecode::to_json(value.${field.name});`,
    ]);
    return `template <>
struct JsonObjectAdapter<${type.qualifiedName}> {
  static constexpr bool available = true;
  static const JsonValue& field(const JsonValue& value, const char* name) {
    static const JsonValue null_value;
    const JsonValue* found = object_get(value, name);
    return found ? *found : null_value;
  }
  static ${type.qualifiedName} from(const JsonValue& value) {
    ${type.qualifiedName} out{};
${fieldReads.join('\n')}
    return out;
  }
  static std::string to_json(const ${type.qualifiedName}& value) {
    std::string json = "{";
${jsonLines.join('\n')}
    json += "}";
    return json;
  }
};`;
  });
  return `\nnamespace tracecode {\n${adapters.join('\n\n')}\n}\n`;
}

function cppTraceType(type, aliases = new Map()) {
  const resolved = resolveCppType(type, aliases);
  const withoutQualifiers = resolved
    .replace(/\bconst\b/g, '')
    .replace(/[&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = normalizeCppType(resolved, aliases);
  if (normalized.startsWith('vector<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::Vector<${innerType}>`;
  }
  if (normalized.startsWith('deque<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::Deque<${innerType}>`;
  }
  if (normalized.startsWith('queue<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::Queue<${innerType}>`;
  }
  if (normalized.startsWith('priority_queue<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::PriorityQueue<${innerType}>`;
  }
  if (normalized.startsWith('stack<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::Stack<${innerType}>`;
  }
  if (normalized.startsWith('unordered_map<') && normalized.endsWith('>')) {
    const innerTypes = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::UnorderedMap<${innerTypes}>`;
  }
  if (normalized.startsWith('map<') && normalized.endsWith('>')) {
    const innerTypes = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::Map<${innerTypes}>`;
  }
  if (normalized.startsWith('unordered_set<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::UnorderedSet<${innerType}>`;
  }
  if (normalized.startsWith('set<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::Set<${innerType}>`;
  }
  return withoutQualifiers;
}

function isVectorCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  if (!normalized.startsWith('vector<') || !normalized.endsWith('>')) return false;
  if (normalized.includes('any') || normalized.includes('variant<')) return false;
  if (normalized.startsWith('vector<vector<vector<')) return false;
  if (normalized.includes('pair<') || normalized.includes('tuple<')) return false;
  const inner = normalized.slice('vector<'.length, -1).trim().replace(/^std::/, '');
  if (/^(?:TreeNode|ListNode|Node)\s*\*$/.test(inner)) return true;
  if (normalized.includes('*')) return false;
  if (/^[A-Z]/.test(inner)) return false;
  return true;
}

function isAnyVectorCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return normalized.startsWith('vector<') && normalized.endsWith('>');
}

function isStringCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return normalized === 'string' || normalized === 'std::string';
}

function vectorElementCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  if (!normalized.startsWith('vector<') || !normalized.endsWith('>')) return null;
  return normalized.slice('vector<'.length, -1).trim();
}

function mapValueCppType(type, aliases = new Map()) {
  return mapKeyValueCppTypes(type, aliases)?.valueType ?? null;
}

function rangeForElementSnapshotType(rangeName, knownVariables, aliases = new Map()) {
  const rangeType = knownVariables?.get(rangeName)?.type;
  if (!rangeType) return null;
  const elementType = vectorElementCppType(rangeType, aliases);
  if (elementType && isSnapshotSerializableCppType(elementType, aliases)) {
    return elementType;
  }
  if (isStringCppType(rangeType, aliases)) {
    return 'char';
  }
  return null;
}

function mapKeyValueCppTypes(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  const prefix = normalized.startsWith('unordered_map<')
    ? 'unordered_map<'
    : normalized.startsWith('map<')
      ? 'map<'
      : null;
  if (!prefix || !normalized.endsWith('>')) return null;
  const innerTypes = splitTopLevelCommaList(normalized.slice(prefix.length, -1));
  if (innerTypes.length < 2) return null;
  return {
    keyType: innerTypes[0].trim(),
    valueType: innerTypes[1].trim(),
  };
}

function isDequeCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return normalized.startsWith('deque<') && normalized.endsWith('>');
}

function isAdapterCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return (
    (normalized.startsWith('queue<') && normalized.endsWith('>')) ||
    (normalized.startsWith('priority_queue<') && normalized.endsWith('>')) ||
    (normalized.startsWith('stack<') && normalized.endsWith('>'))
  );
}

function isUnorderedMapCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return normalized.startsWith('unordered_map<') && normalized.endsWith('>');
}

function isMapCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return normalized.startsWith('map<') && normalized.endsWith('>');
}

function hasContainerMappedValueCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  const prefix = normalized.startsWith('unordered_map<')
    ? 'unordered_map<'
    : normalized.startsWith('map<')
      ? 'map<'
      : null;
  if (!prefix || !normalized.endsWith('>')) return false;
  const innerTypes = splitTopLevelCommaList(normalized.slice(prefix.length, -1));
  if (innerTypes.length < 2) return false;
  const valueType = innerTypes[1].trim().replace(/^std::/, '');
  return /^(?:vector|deque|queue|priority_queue|stack|map|unordered_map|set|unordered_set)</.test(valueType);
}

function hasAutoReferenceBindingForMapProxy(source, name) {
  const pattern = new RegExp(`\\bauto\\s*&\\s+[A-Za-z_]\\w*\\s*=\\s*${escapeRegExp(name)}\\s*\\[`);
  return pattern.test(stripComments(source || ''));
}

function hasUnsafeMapProxyAutoReferenceBinding(type, source, name, aliases = new Map()) {
  return hasContainerMappedValueCppType(type, aliases) && hasAutoReferenceBindingForMapProxy(source, name);
}

function parameterAddressEscapes(source, name) {
  const pattern = new RegExp(`(?<![\\w>&])&(?!&)\\s*${escapeRegExp(name)}\\b`);
  return pattern.test(stripComments(source || ''));
}

function isSetCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  const prefix = normalized.startsWith('unordered_set<')
    ? 'unordered_set<'
    : normalized.startsWith('set<')
      ? 'set<'
      : null;
  if (!prefix || !normalized.endsWith('>')) return false;
  return splitTopLevelCommaList(normalized.slice(prefix.length, -1)).length === 1;
}

function isSetLikeCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return (
    (normalized.startsWith('unordered_set<') || normalized.startsWith('set<')) &&
    normalized.endsWith('>')
  );
}

function isTraceWrappedCppType(type, aliases = new Map()) {
  return (
    isVectorCppType(type, aliases) ||
    isDequeCppType(type, aliases) ||
    isAdapterCppType(type, aliases) ||
    isUnorderedMapCppType(type, aliases) ||
    isMapCppType(type, aliases) ||
    isSetCppType(type, aliases)
  );
}

function quoteCppString(value) {
  return JSON.stringify(String(value));
}

function cppStringLiteral(value) {
  return JSON.stringify(String(value));
}

function jsonStringLiteral(value) {
  return JSON.stringify(String(value));
}

function traceBudgetForOptions(options = {}) {
  const traceOptions = options.traceOptions || {};
  const rawBudget = Number.isFinite(traceOptions.maxStoredEvents)
    ? Number(traceOptions.maxStoredEvents)
    : Number.isFinite(traceOptions.maxTraceSteps)
      ? Number(traceOptions.maxTraceSteps)
      : Number.isFinite(traceOptions.maxLineEvents)
        ? Number(traceOptions.maxLineEvents)
        : DEFAULT_MAX_STORED_EVENTS;
  return Math.max(1, Math.floor(rawBudget));
}

function traceLineBudgetForOptions(options = {}) {
  const traceOptions = options.traceOptions || {};
  return Number.isFinite(traceOptions.maxLineEvents)
    ? Math.max(1, Math.floor(Number(traceOptions.maxLineEvents)))
    : 0;
}

function traceSingleLineHitBudgetForOptions(options = {}) {
  const traceOptions = options.traceOptions || {};
  return Number.isFinite(traceOptions.maxSingleLineHits)
    ? Math.max(1, Math.floor(Number(traceOptions.maxSingleLineHits)))
    : 0;
}

function minimalTraceForOptions(options = {}) {
  return options?.traceOptions?.minimalTrace === true;
}

function traceBudgetHardStopForOptions(options = {}) {
  const traceOptions = options.traceOptions || {};
  if (traceOptions.softTraceBudget === true) return false;
  return (
    Number.isFinite(traceOptions.maxTraceSteps) &&
    !Number.isFinite(traceOptions.maxStoredEvents)
  );
}

function traceLineBudgetHardStopForOptions(options = {}) {
  const traceOptions = options.traceOptions || {};
  return (
    Number.isFinite(traceOptions.maxLineEvents) ||
    Number.isFinite(traceOptions.maxSingleLineHits)
  );
}

function configureTraceBudgetCall(options = {}) {
  return `tracecode::configure_trace_budget(${traceBudgetForOptions(options)}, ${traceBudgetHardStopForOptions(options) ? 'true' : 'false'}, ${traceLineBudgetForOptions(options)}, ${traceSingleLineHitBudgetForOptions(options)}, ${minimalTraceForOptions(options) ? 'true' : 'false'}, ${traceLineBudgetHardStopForOptions(options) ? 'true' : 'false'});`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildTreeObjectFromLevelOrder(values) {
  if (!Array.isArray(values) || values.length === 0 || values[0] === null || values[0] === undefined) return null;
  const root = { val: values[0], left: null, right: null };
  const queue = [root];
  let index = 1;
  while (queue.length > 0 && index < values.length) {
    const node = queue.shift();
    const leftValue = values[index++];
    if (leftValue !== null && leftValue !== undefined) {
      node.left = { val: leftValue, left: null, right: null };
      queue.push(node.left);
    }
    if (index >= values.length) break;
    const rightValue = values[index++];
    if (rightValue !== null && rightValue !== undefined) {
      node.right = { val: rightValue, left: null, right: null };
      queue.push(node.right);
    }
  }
  return root;
}

function buildListObjectFromArray(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const head = { val: values[0], next: null };
  let current = head;
  for (let index = 1; index < values.length; index += 1) {
    current.next = { val: values[index], next: null };
    current = current.next;
  }
  return head;
}

function collectSerializedNodes(root, childKeys) {
  const records = [];
  const names = new WeakMap();
  const ids = new Map();

  function visit(node) {
    if (!isRecord(node) || typeof node.__ref__ === 'string') return;
    if (names.has(node)) return;
    const name = `__tc_node_${records.length}`;
    names.set(node, name);
    records.push(node);
    if (typeof node.__id__ === 'string' && node.__id__.length > 0) {
      ids.set(node.__id__, name);
    }
    for (const key of childKeys) {
      visit(node[key]);
    }
  }

  visit(root);
  return { records, names, ids };
}

function serializedNodeValue(record) {
  return record?.val ?? record?.value ?? 0;
}

function childNodeExpression(child, names, ids) {
  if (child === null || child === undefined) return 'nullptr';
  if (isRecord(child) && typeof child.__ref__ === 'string') {
    return ids.get(child.__ref__) || 'nullptr';
  }
  if (isRecord(child) && names.has(child)) {
    return names.get(child);
  }
  return 'nullptr';
}

function buildSerializedTreeNodeLiteral(value, aliases = new Map()) {
  const root = Array.isArray(value) ? buildTreeObjectFromLevelOrder(value) : value;
  if (root === null || root === undefined) return 'nullptr';
  if (!isRecord(root)) {
    throw new Error(`Expected TreeNode object or level-order array input.`);
  }
  const { records, names, ids } = collectSerializedNodes(root, ['left', 'right']);
  if (records.length === 0) return 'nullptr';
  const lines = ['[&]() -> TreeNode* {'];
  for (const record of records) {
    lines.push(`    TreeNode* ${names.get(record)} = new TreeNode(${toCppLiteral(serializedNodeValue(record), 'int', aliases)});`);
  }
  for (const record of records) {
    const name = names.get(record);
    lines.push(`    ${name}->left = ${childNodeExpression(record.left, names, ids)};`);
    lines.push(`    ${name}->right = ${childNodeExpression(record.right, names, ids)};`);
  }
  lines.push(`    return ${names.get(root)};`);
  lines.push('  }()');
  return lines.join('\n');
}

function buildSerializedListNodeLiteral(value, aliases = new Map()) {
  const root = Array.isArray(value) ? buildListObjectFromArray(value) : value;
  if (root === null || root === undefined) return 'nullptr';
  if (!isRecord(root)) {
    throw new Error(`Expected ListNode object or array input.`);
  }
  const { records, names, ids } = collectSerializedNodes(root, ['next']);
  if (records.length === 0) return 'nullptr';
  const lines = ['[&]() -> ListNode* {'];
  for (const record of records) {
    lines.push(`    ListNode* ${names.get(record)} = new ListNode(${toCppLiteral(serializedNodeValue(record), 'int', aliases)});`);
  }
  for (const record of records) {
    lines.push(`    ${names.get(record)}->next = ${childNodeExpression(record.next, names, ids)};`);
  }
  lines.push(`    return ${names.get(root)};`);
  lines.push('  }()');
  return lines.join('\n');
}

function buildSerializedQuadNodeLiteral(value, aliases = new Map()) {
  const root = value;
  if (root === null || root === undefined) return 'nullptr';
  if (!isRecord(root)) {
    throw new Error(`Expected Node object input.`);
  }
  const { records, names, ids } = collectSerializedNodes(root, ['topLeft', 'topRight', 'bottomLeft', 'bottomRight']);
  if (records.length === 0) return 'nullptr';
  const lines = ['[&]() -> Node* {'];
  for (const record of records) {
    lines.push(`    Node* ${names.get(record)} = new Node(${toCppLiteral(serializedNodeValue(record), 'int', aliases)}, ${toCppLiteral(Boolean(record.isLeaf), 'bool', aliases)}, nullptr, nullptr, nullptr, nullptr);`);
  }
  for (const record of records) {
    const name = names.get(record);
    lines.push(`    ${name}->topLeft = ${childNodeExpression(record.topLeft, names, ids)};`);
    lines.push(`    ${name}->topRight = ${childNodeExpression(record.topRight, names, ids)};`);
    lines.push(`    ${name}->bottomLeft = ${childNodeExpression(record.bottomLeft, names, ids)};`);
    lines.push(`    ${name}->bottomRight = ${childNodeExpression(record.bottomRight, names, ids)};`);
  }
  lines.push(`    return ${names.get(root)};`);
  lines.push('  }()');
  return lines.join('\n');
}

function buildSerializedBinaryNodeLiteral(value, aliases = new Map()) {
  const root = Array.isArray(value) ? buildTreeObjectFromLevelOrder(value) : value;
  if (root === null || root === undefined) return 'nullptr';
  if (!isRecord(root)) {
    throw new Error(`Expected Node object or level-order array input.`);
  }
  const { records, names, ids } = collectSerializedNodes(root, ['left', 'right']);
  if (records.length === 0) return 'nullptr';
  const lines = ['[&]() -> Node* {'];
  for (const record of records) {
    const nodeValue = serializedNodeValue(record);
    const valueType = typeof nodeValue === 'string' ? 'std::string' : 'int';
    lines.push(`    Node* ${names.get(record)} = new Node(${toCppLiteral(nodeValue, valueType, aliases)}, nullptr, nullptr);`);
  }
  for (const record of records) {
    const name = names.get(record);
    lines.push(`    ${name}->left = ${childNodeExpression(record.left, names, ids)};`);
    lines.push(`    ${name}->right = ${childNodeExpression(record.right, names, ids)};`);
  }
  lines.push(`    return ${names.get(root)};`);
  lines.push('  }()');
  return lines.join('\n');
}

function buildSerializedNaryNodeLiteral(value, aliases = new Map()) {
  const root = value;
  if (root === null || root === undefined) return 'nullptr';
  if (!isRecord(root)) {
    throw new Error(`Expected N-ary Node object input.`);
  }
  const { records, names, ids } = collectSerializedNodes(root, ['children']);
  function visitChildren(node) {
    if (!isRecord(node) || !Array.isArray(node.children)) return;
    for (const child of node.children) {
      if (isRecord(child) && !names.has(child) && typeof child.__ref__ !== 'string') {
        const name = `__tc_node_${records.length}`;
        names.set(child, name);
        records.push(child);
        if (typeof child.__id__ === 'string' && child.__id__.length > 0) ids.set(child.__id__, name);
        visitChildren(child);
      }
    }
  }
  visitChildren(root);
  if (records.length === 0) return 'nullptr';
  const lines = ['[&]() -> Node* {'];
  for (const record of records) {
    lines.push(`    Node* ${names.get(record)} = new Node(${toCppLiteral(serializedNodeValue(record), 'int', aliases)});`);
  }
  for (const record of records) {
    const childExpressions = Array.isArray(record.children)
      ? record.children.map((child) => childNodeExpression(child, names, ids)).filter((child) => child !== 'nullptr')
      : [];
    lines.push(`    ${names.get(record)}->children = std::vector<Node*>{${childExpressions.join(', ')}};`);
  }
  lines.push(`    return ${names.get(root)};`);
  lines.push('  }()');
  return lines.join('\n');
}

function isPrimitiveCppType(type) {
  return /^(?:bool|char|string|size_t|std::size_t|(?:unsigned)?(?:short|int|long|longlong|longlongint)|float|double|longdouble)$/.test(type);
}

function cppTypeConstructorName(type, aliases = new Map()) {
  return localCppType(resolveCppType(type, aliases));
}

function nestedListElementType(type) {
  const normalized = String(type || '').replace(/\s+/g, '');
  const match = normalized.match(/^([A-Za-z_]\w*)::List$/);
  return match ? match[1] : null;
}

function buildCustomCppObjectLiteral(value, type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  const pointer = normalized.endsWith('*');
  const objectType = pointer ? normalized.slice(0, -1) : normalized;
  if (!objectType || isPrimitiveCppType(objectType) || objectType.includes('<')) return null;
  if (!/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?$/.test(objectType)) return null;
  const constructorName = cppTypeConstructorName(type, aliases);
  const valueConstructorName = pointer ? constructorName.replace(/\*$/, '').trim() : constructorName;
  const wrap = (args) => pointer ? `new ${valueConstructorName}(${args})` : `${constructorName}{ ${args} }`;

  if (Array.isArray(value)) {
    const nestedElementType = nestedListElementType(objectType);
    const elementType = nestedElementType || objectType;
    return wrap(value.map((entry) => toCppLiteral(entry, elementType, aliases)).join(', '));
  }

  if (isRecord(value)) {
    const recordType = typeof value.__type__ === 'string' ? normalizeCppType(String(value.__type__), aliases) : null;
    if (recordType && recordType !== objectType) return null;
    const entries = Object.entries(value).filter(([key]) => key !== '__type__' && key !== '__id__' && key !== '__ref__');
    return wrap(entries.map(([, child]) => toCppLiteral(child, 'auto', aliases)).join(', '));
  }

  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'string') {
    return wrap(toCppLiteral(value, typeof value === 'string' ? 'string' : typeof value === 'boolean' ? 'bool' : 'long long', aliases));
  }

  return null;
}

function isCppUnsignedNumericType(normalized) {
  return /^(?:unsigned|size_t|std::size_t)/.test(normalized);
}

function isCppIntegerNumericType(normalized) {
  return /^(?:signed)?(?:char|short|int|long|longint|longlong|longlongint)$/.test(normalized) ||
    /^(?:unsigned)(?:char|short|int|long|longint|longlong|longlongint)?$/.test(normalized) ||
    normalized === 'size_t' ||
    normalized === 'std::size_t';
}

function isCppFloatingNumericType(normalized) {
  return normalized === 'float' || normalized === 'double' || normalized === 'longdouble';
}

function isCppNumericType(normalized) {
  return isCppIntegerNumericType(normalized) || isCppFloatingNumericType(normalized);
}

function toCppNumericLiteral(value, normalized, type) {
  if (isCppIntegerNumericType(normalized)) {
    if (typeof value === 'bigint') {
      if (isCppUnsignedNumericType(normalized) && value < 0n) {
        throw new Error(`Expected non-negative integer input for ${type}.`);
      }
      return value.toString();
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`Expected integer input for ${type}.`);
    }
    if (isCppUnsignedNumericType(normalized) && value < 0) {
      throw new Error(`Expected non-negative integer input for ${type}.`);
    }
    return String(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected finite numeric input for ${type}.`);
  }
  return String(value);
}

function toCppInferredNumericLiteral(value, type) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected finite numeric input for ${type}.`);
  }
  return String(value);
}

function toCppLiteral(value, type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  if (normalized === 'JsonValue' || normalized === 'tracecode::JsonValue') {
    return `tracecode::parse_json(${cppStringLiteral(JSON.stringify(value))})`;
  }
  if (normalized === 'TreeNode*') {
    return buildSerializedTreeNodeLiteral(value, aliases);
  }
  if (normalized === 'TreeNode') {
    return `*(${buildSerializedTreeNodeLiteral(value, aliases)})`;
  }
  if (normalized === 'ListNode*') {
    return buildSerializedListNodeLiteral(value, aliases);
  }
  if (normalized === 'Node*' && isRecord(value) && ('topLeft' in value || 'isLeaf' in value)) {
    return buildSerializedQuadNodeLiteral(value, aliases);
  }
  if (normalized === 'Node*' && isRecord(value) && Array.isArray(value.children)) {
    return buildSerializedNaryNodeLiteral(value, aliases);
  }
  if (normalized === 'Node*' && (Array.isArray(value) || (isRecord(value) && ('left' in value || 'right' in value)))) {
    return buildSerializedBinaryNodeLiteral(value, aliases);
  }
  if (
    (
      normalized.startsWith('vector<') ||
      normalized.startsWith('array<') ||
      normalized.startsWith('deque<') ||
      normalized.startsWith('queue<') ||
      normalized.startsWith('priority_queue<') ||
      normalized.startsWith('stack<')
    ) &&
    normalized.endsWith('>')
  ) {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array input for ${type}.`);
    }
    const innerType = normalized.slice(normalized.indexOf('<') + 1, -1);
    const arrayTypes = normalized.startsWith('array<') ? splitTopLevelCommaList(innerType) : null;
    const elementType = arrayTypes ? arrayTypes[0] || 'int' : innerType;
    return `{ ${value.map((entry) => toCppLiteral(entry, elementType, aliases)).join(', ')} }`;
  }
  if ((normalized.startsWith('unordered_map<') || normalized.startsWith('map<')) && normalized.endsWith('>')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Expected object input for ${type}.`);
    }
    const args = splitTopLevelCommaList(normalized.slice(normalized.indexOf('<') + 1, -1));
    const keyType = args[0] || 'string';
    const valueType = args[1] || 'int';
    return `{ ${Object.entries(value)
      .map(([key, child]) => `{ ${toCppLiteral(key, keyType, aliases)}, ${toCppLiteral(child, valueType, aliases)} }`)
      .join(', ')} }`;
  }
  if (normalized.startsWith('tuple<') && normalized.endsWith('>')) {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array input for ${type}.`);
    }
    const tupleTypes = splitTopLevelCommaList(normalized.slice(normalized.indexOf('<') + 1, -1));
    return `{ ${value.map((entry, index) => toCppLiteral(entry, tupleTypes[index] || 'int', aliases)).join(', ')} }`;
  }
  if ((normalized.startsWith('unordered_set<') || normalized.startsWith('set<')) && normalized.endsWith('>')) {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array input for ${type}.`);
    }
    const innerType = normalized.slice(normalized.indexOf('<') + 1, -1);
    return `{ ${value.map((entry) => toCppLiteral(entry, innerType, aliases)).join(', ')} }`;
  }
  if (normalized === 'string') return quoteCppString(value);
  if (normalized === 'char') return quoteCppString(String(value)[0] || '\0').replace(/^"/, "'").replace(/"$/, "'");
  if (normalized === 'bool') return value ? 'true' : 'false';
  if (value === null || value === undefined) return 'nullptr';
  if (normalized === 'auto') {
    if (typeof value === 'number' || typeof value === 'bigint') {
      return toCppInferredNumericLiteral(value, type);
    }
    if (Array.isArray(value)) return `{ ${value.map((entry) => toCppLiteral(entry, 'auto', aliases)).join(', ')} }`;
    if (isRecord(value)) {
      if (typeof value.__type__ !== 'string') {
        return `{ ${Object.entries(value)
          .map(([key, child]) => `{ ${quoteCppString(key)}, ${toCppLiteral(child, 'auto', aliases)} }`)
          .join(', ')} }`;
      }
      const entries = Object.entries(value).filter(([key]) => key !== '__type__' && key !== '__id__' && key !== '__ref__');
      return `{ ${entries.map(([, child]) => toCppLiteral(child, 'auto', aliases)).join(', ')} }`;
    }
  }
  if (isCppNumericType(normalized)) {
    return toCppNumericLiteral(value, normalized, type);
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return toCppInferredNumericLiteral(value, type);
  }
  if (typeof value === 'string') return quoteCppString(value);
  const customLiteral = buildCustomCppObjectLiteral(value, type, aliases);
  if (customLiteral) return customLiteral;
  throw new Error(`Unsupported C++ literal for type ${type}: ${JSON.stringify(value)}`);
}

function inputValueForParameter(inputs, parameter, index) {
  if (Object.prototype.hasOwnProperty.call(inputs, parameter.name)) return inputs[parameter.name];
  const values = Object.values(inputs || {});
  return values[index];
}

function isDynamicJsonMapKeyType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases).replace(/^std::/, '');
  return isPrimitiveCppType(normalized) || normalized === 'string';
}

function isDynamicJsonInputType(type, aliases = new Map(), customJsonTypes = new Set()) {
  const normalized = normalizeCppType(type, aliases);
  if (normalized === 'any' || normalized === 'JsonValue' || normalized === 'tracecode::JsonValue') return true;
  if (customJsonTypes.has(materializedCppType(type, aliases)) || customJsonTypes.has(normalized)) return true;
  if (normalized === 'TreeNode' || normalized === 'TreeNode*' || normalized === 'ListNode' || normalized === 'ListNode*') {
    return true;
  }
  if (isPrimitiveCppType(normalized)) return true;
  if (
    (
      normalized.startsWith('vector<') ||
      normalized.startsWith('deque<') ||
      normalized.startsWith('queue<') ||
      normalized.startsWith('priority_queue<') ||
      normalized.startsWith('stack<') ||
      normalized.startsWith('set<') ||
      normalized.startsWith('unordered_set<')
    ) &&
    normalized.endsWith('>')
  ) {
    return isDynamicJsonInputType(normalized.slice(normalized.indexOf('<') + 1, -1), aliases, customJsonTypes);
  }
  if (normalized.startsWith('array<') && normalized.endsWith('>')) {
    const args = splitTopLevelCommaList(normalized.slice(normalized.indexOf('<') + 1, -1));
    return args.length >= 1 && isDynamicJsonInputType(args[0], aliases, customJsonTypes);
  }
  if (
    (
      normalized.startsWith('map<') ||
      normalized.startsWith('unordered_map<')
    ) &&
    normalized.endsWith('>')
  ) {
    const args = splitTopLevelCommaList(normalized.slice(normalized.indexOf('<') + 1, -1));
    return args.length >= 2 && isDynamicJsonMapKeyType(args[0], aliases) && isDynamicJsonInputType(args[1], aliases, customJsonTypes);
  }
  if (normalized.startsWith('pair<') && normalized.endsWith('>')) {
    const args = splitTopLevelCommaList(normalized.slice(normalized.indexOf('<') + 1, -1));
    return args.length >= 2 && isDynamicJsonInputType(args[0], aliases, customJsonTypes) && isDynamicJsonInputType(args[1], aliases, customJsonTypes);
  }
  if (normalized.startsWith('tuple<') && normalized.endsWith('>')) {
    const args = splitTopLevelCommaList(normalized.slice(normalized.indexOf('<') + 1, -1));
    return args.length > 0 && args.every((arg) => isDynamicJsonInputType(arg, aliases, customJsonTypes));
  }
  return false;
}

function cppDynamicInputExpression(parameter, index, aliases = new Map(), customJsonTypes = new Set()) {
  if (!isDynamicJsonInputType(parameter.type, aliases, customJsonTypes)) return null;
  const normalized = normalizeCppType(parameter.type, aliases);
  const inputValue = `tracecode::json_input_value(__tc_inputs, ${cppStringLiteral(parameter.name)}, ${index})`;
  if (normalized === 'TreeNode*') {
    return `tracecode::json_to_tree_node<${materializedCppType(parameter.type, aliases).replace(/\*$/, '').trim()}>(${inputValue})`;
  }
  if (normalized === 'TreeNode') {
    return `*tracecode::json_to_tree_node<${materializedCppType(parameter.type, aliases)}>(${inputValue})`;
  }
  if (normalized === 'ListNode*') {
    return `tracecode::json_to_list_node<${materializedCppType(parameter.type, aliases).replace(/\*$/, '').trim()}>(${inputValue})`;
  }
  if (normalized === 'ListNode') {
    return `*tracecode::json_to_list_node<${materializedCppType(parameter.type, aliases)}>(${inputValue})`;
  }
  return `tracecode::read_json_input<${materializedCppType(parameter.type, aliases)}>(__tc_inputs, ${cppStringLiteral(parameter.name)}, ${index})`;
}

function buildGeneratedIncludes(source, signature) {
  const probe = `${source}\n${signature.parameters.map((parameter) => parameter.type).join('\n')}`;
  const includes = new Set(CPP_BASE_GENERATED_INCLUDES);
  for (const [pattern, include] of CPP_STANDARD_INCLUDE_RULES) {
    if (pattern.test(probe)) includes.add(include);
  }
  return [...includes].join('\n');
}

function buildTraceArgsJsonExpression(signature, variableNameForParameter = (_parameter, index) => `__tc_arg_${index}`, aliases = new Map()) {
  const pieces = [];
  signature.parameters.forEach((parameter, index) => {
    const normalizedType = normalizeCppType(parameter.type, aliases);
    if (
      normalizedType === 'auto' ||
      /\bauto\b/.test(parameter.type) ||
      /\bauto\b/.test(normalizedType) ||
      !isSnapshotSerializableCppType(parameter.type, aliases)
    ) return;
    const localName = variableNameForParameter(parameter, index);
    const prefix = `${pieces.length > 0 ? ',' : ''}${jsonStringLiteral(parameter.name)}:`;
    pieces.push(`${cppStringLiteral(prefix)} + tracecode::to_json(${localName})`);
  });
  return pieces.length > 0 ? pieces.join(' + ') : cppStringLiteral('');
}

function stripCppStringsAndComments(line) {
  return line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/\/\/.*$/, '');
}

function stripCppLineCommentPreservingStrings(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const ch = line[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '/' && line[index + 1] === '/') {
      return line.slice(0, index);
    }
  }
  return line;
}

function braceDeltaForLine(line) {
  const stripped = stripCppStringsAndComments(line);
  let delta = 0;
  for (const ch of stripped) {
    if (ch === '{') delta += 1;
    if (ch === '}') delta -= 1;
  }
  return delta;
}

function parenDeltaForLine(line) {
  const stripped = stripCppStringsAndComments(line);
  let delta = 0;
  for (const ch of stripped) {
    if (ch === '(') delta += 1;
    if (ch === ')') delta -= 1;
  }
  return delta;
}

function shouldInstrumentCppLine(line) {
  const trimmed = stripCppStringsAndComments(line).trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) return false;
  if (/^(public|private|protected)\s*:/.test(trimmed)) return false;
  if (/^(else|catch)\b/.test(trimmed)) return false;
  if (/^(case\b|default\s*:)/.test(trimmed)) return false;
  if (/^delete\b/.test(trimmed)) return false;
  if (/\b(?:destroy|cleanup|deleteTree|deleteList)\s*\(/i.test(trimmed)) return false;
  if (/^[{};]+$/.test(trimmed)) return false;
  if (/^};?$/.test(trimmed)) return false;
  return (
    /;$/.test(trimmed) ||
    /^(if|for|while|switch)\s*\(/.test(trimmed) ||
    /^do\b/.test(trimmed) ||
    /^return\b/.test(trimmed)
  );
}

function isCppControlHeaderLine(line) {
  const trimmed = stripCppStringsAndComments(line).trim();
  return /^(?:if|else\s+if|for|while|switch)\s*\(/.test(trimmed);
}

function isUnbracedControlHeader(line, nextLine = '') {
  const trimmed = stripCppStringsAndComments(line).trim();
  if (!/^(?:if|else\s+if|for|while)\s*\(.*\)\s*$/.test(trimmed)) return false;
  if (trimmed.includes('{') || trimmed.endsWith(';')) return false;
  const nextTrimmed = stripCppStringsAndComments(nextLine).trim();
  return Boolean(nextTrimmed) && !nextTrimmed.startsWith('{');
}

function buildLineInstrumentation(lineNumber, functionName) {
  return `tracecode::TraceHooks::emitPostLineFrame(${lineNumber}, ${cppStringLiteral(functionName)});`;
}

function buildCurrentLineInstrumentation(lineNumber) {
  return `tracecode::TraceHooks::setCurrentLine(${lineNumber});`;
}

function rewriteControlConditionLineScope(line, lineNumber, variables = new Map(), aliases = new Map()) {
  if (line.includes('tracecode::with_trace_line')) {
    const wrapperPattern = /tracecode::with_trace_line\((\d+),\s*\[[^\]]*\]\(\)\s*\{\s*return\s+static_cast<bool>\(([\s\S]*?)\);\s*\}\)/;
    const match = line.match(wrapperPattern);
    if (!match) return line;
    const condition = match[2].trim();
    let rewrittenCondition = rewriteFieldContainerCountInstrumentation(condition, lineNumber);
    rewrittenCondition = rewriteIndexReadInstrumentation(rewrittenCondition, variables, aliases, lineNumber);
    if (rewrittenCondition === condition) return line;
    return line.replace(condition, rewrittenCondition);
  }
  const controlMatch = line.match(/^(\s*)(else\s+if|if|while|for)\s*\(/);
  if (!controlMatch) return line;
  const keywordEnd = controlMatch[0].length - 1;
  const openIndex = line.indexOf('(', keywordEnd);
  if (openIndex < 0) return line;
  const closeIndex = findMatchingParen(line, openIndex);
  if (closeIndex < 0) return line;

  const keyword = controlMatch[2];
  const source = line.slice(openIndex + 1, closeIndex);
  let rewrittenSource = source;
  if (keyword === 'for') {
    const parts = splitTopLevel(source, ';', { trackAngleBrackets: false });
    if (parts.length !== 3 || !parts[1].trim()) return line;
    let condition = rewriteFieldContainerCountInstrumentation(parts[1].trim(), lineNumber);
    condition = rewriteIndexReadInstrumentation(condition, variables, aliases, lineNumber);
    rewrittenSource = `${parts[0]}; tracecode::with_trace_line(${lineNumber}, [&]() { return static_cast<bool>(${condition}); }); ${parts[2]}`;
  } else {
    let condition = rewriteFieldContainerCountInstrumentation(source.trim(), lineNumber);
    condition = rewriteIndexReadInstrumentation(condition, variables, aliases, lineNumber);
    if (!condition) return line;
    rewrittenSource = `tracecode::with_trace_line(${lineNumber}, [&]() { return static_cast<bool>(${condition}); })`;
  }
  return `${line.slice(0, openIndex + 1)}${rewrittenSource}${line.slice(closeIndex)}`;
}

function rewriteRangeForIndexedReads(line, lineNumber, variables, aliases = new Map()) {
  const stripped = stripCppStringsAndComments(line);
  const structuredMapMatch = stripped.match(/^(\s*for\s*\(\s*[^:;]+?\[\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*|_)\s*\]\s*:\s*)([A-Za-z_]\w*)(\s*\).*)$/);
  if (structuredMapMatch) {
    const [, prefix, keyBindingName, valueBindingName, rangeName, suffix] = structuredMapMatch;
    const variable = variables?.get(rangeName);
    if (variable && (isUnorderedMapCppType(variable.type, aliases) || isMapCppType(variable.type, aliases))) {
      const valueBinding = valueBindingName === '_' ? 'nullptr' : cppStringLiteral(valueBindingName);
      const rewritten = `${prefix}tracecode::keyed_range_readable(${rangeName}, ${lineNumber}, ${cppStringLiteral(keyBindingName)}, ${valueBinding})${suffix}`;
      return line.replace(stripped, rewritten);
    }
  }
  const structuredVectorMatch = stripped.match(/^(\s*for\s*\(\s*[^:;]+?\[\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*\]\s*:\s*)([A-Za-z_]\w*)(\s*\).*)$/);
  if (structuredVectorMatch) {
    const [, prefix, bindingNamesSource, rangeName, suffix] = structuredVectorMatch;
    const variable = variables?.get(rangeName);
    if (variable && isAnyVectorCppType(variable.type, aliases)) {
      const bindingNames = bindingNamesSource
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name && name !== '_')
        .join(',');
      const bindingName = bindingNames ? cppStringLiteral(bindingNames) : 'nullptr';
      const rewritten = `${prefix}tracecode::indexed_range_readable(${rangeName}, ${lineNumber}, ${bindingName}, ${cppStringLiteral(rangeName)})${suffix}`;
      return line.replace(stripped, rewritten);
    }
  }
  const indexedMatch = stripped.match(/^(\s*for\s*\(\s*[^;]+?[*&]*\s+[*&]*\s*([A-Za-z_]\w*)\s*:\s*)([A-Za-z_]\w*)\s*\[(.+)\](\s*\).*)$/);
  if (indexedMatch) {
    const [, prefix, bindingName, rangeName, indexSource, suffix] = indexedMatch;
    const variable = variables?.get(rangeName);
    if (variable && isVectorCppType(variable.type, aliases)) {
      const indexExpression = indexSource.trim();
      if (indexExpression) {
        const rewritten = `${prefix}tracecode::indexed_nested_range_readable(${rangeName}, ${cppStringLiteral(rangeName)}, ${indexExpression}, ${cppIndexSourceForExpression(indexExpression)}, ${lineNumber}, ${cppStringLiteral(bindingName)})${suffix}`;
        return line.replace(stripped, rewritten);
      }
    }
  }
  const match = stripped.match(/^(\s*for\s*\(\s*[^;]+?[*&]*\s+[*&]*\s*([A-Za-z_]\w*)\s*:\s*)([A-Za-z_]\w*)(\s*\).*)$/);
  if (!match) return line;
  const [, prefix, bindingName, rangeName, suffix] = match;
  const variable = variables?.get(rangeName);
  if (!variable) return line;
  if (isSetCppType(variable.type, aliases)) {
    const rewritten = `${prefix}tracecode::set_range_readable(${rangeName}, ${lineNumber}, ${cppStringLiteral(bindingName)}, ${cppStringLiteral(rangeName)})${suffix}`;
    return line.replace(stripped, rewritten);
  }
  if (!isVectorCppType(variable.type, aliases) && !isStringCppType(variable.type, aliases)) return line;
  const rewritten = `${prefix}tracecode::indexed_range_readable(${rangeName}, ${lineNumber}, ${cppStringLiteral(bindingName)}, ${cppStringLiteral(rangeName)})${suffix}`;
  return line.replace(stripped, rewritten);
}

function isSnapshotSerializableCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  if (!normalized || normalized === 'void') return false;
  if (normalized === 'auto' || normalized.includes('auto&&') || normalized.includes('function<')) return false;
  if (normalized === 'TreeNode' || normalized === 'TreeNode*' || normalized === 'ListNode' || normalized === 'ListNode*' || normalized === 'TrieNode' || normalized === 'TrieNode*') return true;
  if (/^(?:bool|char|string|size_t|std::size_t|(?:unsigned)?(?:short|int|long|longlong|longlongint)|float|double|longdouble)$/.test(normalized)) {
    return true;
  }
  if (normalized.startsWith('variant<') || normalized.startsWith('optional<')) return true;
  return (
    normalized.startsWith('vector<') ||
    normalized.startsWith('array<') ||
    normalized.startsWith('deque<') ||
    normalized.startsWith('queue<') ||
    normalized.startsWith('priority_queue<') ||
    normalized.startsWith('stack<') ||
    normalized.startsWith('unordered_map<') ||
    normalized.startsWith('map<') ||
    normalized.startsWith('unordered_set<') ||
    normalized.startsWith('set<') ||
    normalized.startsWith('pair<') ||
    normalized.startsWith('tuple<')
  );
}

function buildSnapshotInstrumentation(lineNumber, variables, currentDepth) {
  return [...variables.entries()]
    .filter(([, variable]) => {
      if (variable.declarationLine === lineNumber && !variable.sameLineVisible) return false;
      return variable.scopeDepth <= currentDepth || variable.declarationLine === lineNumber;
    })
    .map(([name]) => `tracecode::emit_snapshot_value(${cppStringLiteral(name)}, ${name}, ${lineNumber});`)
    .join('\n');
}

function buildScalarWriteInstrumentation(name, lineNumber, indent = '') {
  return `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(`{"kind":"write","line":${lineNumber},"target":{"variable":${jsonStringLiteral(name)}},"value":`)}) + tracecode::to_json(${name}) + "}", ${lineNumber});`;
}

function buildDeclarationWriteInstrumentation(lineNumber, variables, currentDepth, indent = '') {
  return [...variables.entries()]
    .filter(([, variable]) => variable.declarationLine === lineNumber && variable.scopeDepth <= currentDepth)
    .map(([name]) => buildScalarWriteInstrumentation(name, lineNumber, indent))
    .join('\n');
}

function buildOpaqueObjectSnapshotInstrumentation(name, lineNumber, indent = '') {
  if (name === 'this') return '';
  return `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(`{"kind":"snapshot","line":${lineNumber},"target":{"variable":${jsonStringLiteral(name)}},"value":`)}) + tracecode::to_json(${name}) + "}", ${lineNumber});`;
}

function cppStringExpression(parts) {
  let expression = 'std::string()';
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === 'string') {
      expression += ` + ${cppStringLiteral(part)}`;
    } else if (part.expression) {
      expression += ` + ${part.expression}`;
    }
  }
  return expression;
}

function buildFieldPathTargetJsonExpression(objectName, pathParts) {
  const parts = [`{"variable":${jsonStringLiteral(objectName)},"path":[`];
  const indexSources = [];
  let hasIndexSource = false;
  for (const [index, part] of pathParts.entries()) {
    if (index > 0) parts.push(',');
    if (part.fieldName) {
      parts.push(jsonStringLiteral(part.fieldName));
      indexSources.push('nullptr');
      continue;
    }
    if (part.keyExpression) {
      parts.push({ expression: `tracecode::to_json(${part.keyExpression})` });
      const indexSource = cppIndexSourceForExpression(part.keyExpression);
      indexSources.push(indexSource);
      hasIndexSource ||= indexSource !== 'nullptr';
    }
  }
  parts.push(']');
  if (hasIndexSource && indexSources.length <= 2) {
    parts.push(',"indexSources":');
    parts.push({ expression: `tracecode::index_sources_json(${indexSources.join(', ')})` });
  }
  parts.push('}');
  return cppStringExpression(parts);
}

function parseFieldAccessExpression(expression) {
  const trimmed = expression.trim();
  const objectMatch = trimmed.match(/^([A-Za-z_]\w*)/);
  if (!objectMatch) return null;
  const objectName = objectMatch[1];
  const pathParts = [];
  let cursor = objectName.length;
  while (cursor < trimmed.length) {
    while (/\s/.test(trimmed[cursor] || '')) cursor += 1;
    if (trimmed.startsWith('->', cursor)) {
      cursor += 2;
    } else if (trimmed[cursor] === '.') {
      cursor += 1;
    } else {
      break;
    }
    while (/\s/.test(trimmed[cursor] || '')) cursor += 1;
    const fieldMatch = trimmed.slice(cursor).match(/^([A-Za-z_]\w*)/);
    if (!fieldMatch) return null;
    const fieldName = fieldMatch[1];
    pathParts.push({ fieldName });
    cursor += fieldName.length;
    while (/\s/.test(trimmed[cursor] || '')) cursor += 1;
    if (trimmed[cursor] === '[') {
      const closeIndex = findMatchingSquareBracket(trimmed, cursor);
      if (closeIndex < 0) return null;
      const keyExpression = trimmed.slice(cursor + 1, closeIndex).trim();
      if (!keyExpression) return null;
      pathParts.push({ keyExpression });
      cursor = closeIndex + 1;
    }
  }
  while (/\s/.test(trimmed[cursor] || '')) cursor += 1;
  if (cursor !== trimmed.length || pathParts.length === 0) return null;
  return {
    objectName,
    fieldName: pathParts[0]?.fieldName,
    keyExpression: pathParts.length === 2 && pathParts[1]?.keyExpression ? pathParts[1].keyExpression : undefined,
    pathParts,
  };
}

function buildFieldReadInstrumentation(expression, valueExpression, lineNumber, indent = '') {
  const access = parseFieldAccessExpression(expression);
  if (!access) return '';
  const targetExpression = buildFieldPathTargetJsonExpression(access.objectName, access.pathParts);
  return [
    `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(`{"kind":"read","line":${lineNumber},"target":`)}) + ${targetExpression} + ",\\\"value\\\":" + tracecode::to_json(${valueExpression}) + "}", ${lineNumber});`,
    buildOpaqueObjectSnapshotInstrumentation(access.objectName, lineNumber, indent),
  ].join('\n');
}

function parseSimpleAssignmentStatement(line) {
  const match = line.match(/^(\s*)(.+?)\s*=\s*(.+?)\s*;\s*$/);
  if (!match) return null;
  const [, indent, lhsExpression, rhsExpression] = match;
  const operatorIndex = line.indexOf('=', indent.length + lhsExpression.length);
  const previous = line.slice(0, operatorIndex).trimEnd().at(-1) || '';
  const next = line.slice(operatorIndex + 1).trimStart()[0] || '';
  if (previous === '!' || previous === '<' || previous === '>' || previous === '=' || next === '=') return null;
  return { indent, lhsExpression, rhsExpression };
}

function rewriteFieldWriteInstrumentation(line, lineNumber) {
  const assignment = parseSimpleAssignmentStatement(line);
  if (!assignment) return line;
  const { indent, lhsExpression } = assignment;
  const access = parseFieldAccessExpression(lhsExpression);
  if (!access) return line;
  const targetExpression = buildFieldPathTargetJsonExpression(access.objectName, access.pathParts);
  const valueExpression = lhsExpression.trim();
  return [
    line,
    `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(`{"kind":"write","line":${lineNumber},"target":`)}) + ${targetExpression} + ",\\\"value\\\":" + tracecode::to_json(${valueExpression}) + "}", ${lineNumber});`,
    buildOpaqueObjectSnapshotInstrumentation(access.objectName, lineNumber, indent),
  ].join('\n');
}

function isCppPointerVariable(variable) {
  return typeof variable?.type === 'string' && /\*\s*$/.test(variable.type.trim());
}

function shouldGuardNullCheckedPointerFieldRead(strippedExpression, objectName, accessStart) {
  const before = strippedExpression.slice(0, accessStart);
  const escapedName = escapeRegExp(objectName);
  const nullValue = String.raw`(?:nullptr|NULL|0)`;
  const guardedReadPrefix = String.raw`(?:[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?\s*\(\s*)*`;
  const pointerCondition = String.raw`\(?\s*\b${escapedName}\s*\)?`;
  const nullComparison = String.raw`(?:\(?\s*\b${escapedName}\s*(?:!=|==)\s*${nullValue}\s*\)?|\(?\s*${nullValue}\s*(?:!=|==)\s*\b${escapedName}\s*\)?)`;
  const nullEquality = String.raw`(?:\(?\s*\b${escapedName}\s*==\s*${nullValue}\s*\)?|\(?\s*${nullValue}\s*==\s*\b${escapedName}\s*\)?)`;
  const negatedPointerCondition = String.raw`\(?\s*!\s*\(?\s*\b${escapedName}\s*\)?\s*\)?`;
  return (
    new RegExp(String.raw`\b${escapedName}\s*(?:\?|\&\&)\s*$`).test(before) ||
    new RegExp(String.raw`${pointerCondition}\s*(?:\?|\&\&)\s*${guardedReadPrefix}$`).test(before) ||
    new RegExp(String.raw`\b${escapedName}\s*(?:!=|==)\s*${nullValue}\s*(?:\?|\&\&)\s*$`).test(before) ||
    new RegExp(String.raw`${nullValue}\s*(?:!=|==)\s*\b${escapedName}\s*(?:\?|\&\&)\s*$`).test(before) ||
    new RegExp(String.raw`${nullComparison}\s*(?:\?|\&\&)\s*${guardedReadPrefix}$`).test(before) ||
    new RegExp(String.raw`${negatedPointerCondition}\s*\|\|\s*${guardedReadPrefix}$`).test(before) ||
    new RegExp(String.raw`${nullEquality}\s*\|\|\s*${guardedReadPrefix}$`).test(before) ||
    new RegExp(String.raw`\b${escapedName}\s*(?:!=|==)\s*${nullValue}\s*\?[^:]*:\s*$`).test(before) ||
    new RegExp(String.raw`${nullValue}\s*(?:!=|==)\s*\b${escapedName}\s*\?[^:]*:\s*$`).test(before) ||
    new RegExp(String.raw`${nullComparison}\s*\?[^:]*:\s*${guardedReadPrefix}$`).test(before)
  );
}

function buildPointerFieldReadsForExpression(expression, lineNumber, variables = new Map(), indent = '') {
  const stripped = stripCppStringsAndComments(expression);
  const reads = [];
  const seen = new Set();
  const fieldAccessPattern = /\b([A-Za-z_]\w*(?:\s*->\s*[A-Za-z_]\w*(?:\s*\[[^\[\]]+?\])?)+)\b/g;
  for (const match of stripped.matchAll(fieldAccessPattern)) {
    const accessExpression = match[1].replace(/\s+/g, '');
    if (!accessExpression || seen.has(accessExpression)) continue;
    const accessStart = match.index ?? 0;
    const accessEnd = accessStart + match[0].length;
    const beforeAccess = stripped.slice(Math.max(0, accessStart - 2), accessStart);
    if (beforeAccess === '->' || beforeAccess.endsWith('.')) continue;
    if (nextNonWhitespace(stripped, accessEnd).ch === '(') continue;
    const access = parseFieldAccessExpression(accessExpression);
    if (!access || access.objectName === 'this') continue;
    const objectVariable = variables?.get(access.objectName);
    if (objectVariable && !isCppPointerVariable(objectVariable)) continue;
    seen.add(accessExpression);
    const readInstrumentation = buildFieldReadInstrumentation(accessExpression, accessExpression, lineNumber, indent);
    if (!readInstrumentation) continue;
    const shouldGuard = (objectVariable && isCppPointerVariable(objectVariable)) ||
      (!objectVariable && shouldGuardNullCheckedPointerFieldRead(stripped, access.objectName, accessStart));
    reads.push(shouldGuard
      ? `${indent}if (${access.objectName}) {\n${readInstrumentation}\n${indent}}`
      : readInstrumentation);
  }
  return reads.join('\n');
}

function rewritePointerFieldReadInstrumentation(line, lineNumber, variables = new Map()) {
  if (!line.includes('->')) return line;
  const firstLine = line.split('\n')[0] ?? line;
  const assignment = parseSimpleAssignmentStatement(firstLine);
  if (assignment) {
    const { indent, lhsExpression, rhsExpression } = assignment;
    if (parseFieldAccessExpression(lhsExpression)) {
      const rhsReads = buildPointerFieldReadsForExpression(rhsExpression, lineNumber, variables, indent);
      if (rhsReads) return `${rhsReads}\n${line}`;
    }
  }
  const pointerFieldAssignment = firstLine.match(/^(\s*)([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*->\s*([A-Za-z_]\w*)(?:\s*\[\s*([^\[\]]+?)\s*\])?\s*;\s*$/);
  if (pointerFieldAssignment) {
    const [, indent, assigneeName, objectName, fieldName, keyExpression] = pointerFieldAssignment;
    const objectVariable = variables?.get(objectName);
    if (!objectVariable || isCppPointerVariable(objectVariable)) {
      const accessExpression = keyExpression
        ? `${objectName}->${fieldName}[${keyExpression.trim()}]`
        : `${objectName}->${fieldName}`;
      const tempName = `__tc_pointer_field_read_${lineNumber}_${assigneeName}`;
      return [
        `${indent}auto ${tempName} = ${accessExpression};`,
        buildFieldReadInstrumentation(accessExpression, tempName, lineNumber, indent),
        `${indent}${assigneeName} = ${tempName};`,
        buildScalarWriteInstrumentation(assigneeName, lineNumber, indent),
      ].join('\n');
    }
  }
  if (/^\s*[A-Za-z_]\w*(?:\.|->)[A-Za-z_]\w*(?:\s*\[[^\[\]]+?\])?\s*=/.test(line)) return line;
  const stripped = stripCppStringsAndComments(line);
  const reads = [];
  const seen = new Set();
  const fieldAccessPattern = /\b([A-Za-z_]\w*)\s*->\s*([A-Za-z_]\w*)\b/g;
  for (const match of stripped.matchAll(fieldAccessPattern)) {
    const objectName = match[1];
    const fieldName = match[2];
    if (!objectName || !fieldName) continue;
    const accessStart = match.index ?? 0;
    const beforeAccess = stripped.slice(Math.max(0, accessStart - 2), accessStart);
    if (beforeAccess === '->' || beforeAccess.endsWith('.')) continue;
    if (objectName === 'this') continue;
    const objectVariable = variables?.get(objectName);
    if (objectVariable && !isCppPointerVariable(objectVariable)) continue;
    const accessEnd = accessStart + match[0].length;
    const before = stripped.slice(0, accessStart);
    const after = stripped.slice(accessEnd);
    if (/\b(?:new|delete)\s+$/.test(before)) continue;
    if (/^\s*=(?!=)/.test(after)) continue;
    if (/^\s*\(/.test(after)) continue;
    const bracketStart = stripped.indexOf('[', accessEnd);
    let expression = `${objectName}->${fieldName}`;
    if (bracketStart === accessEnd) {
      const bracketEnd = findMatchingSquareBracket(stripped, bracketStart);
      if (bracketEnd > bracketStart) {
        expression += stripped.slice(bracketStart, bracketEnd + 1);
      }
    }
    if (seen.has(expression)) continue;
    seen.add(expression);
    const indent = line.match(/^(\s*)/)?.[1] ?? '';
    const readInstrumentation = buildFieldReadInstrumentation(expression, expression, lineNumber, `${indent}  `);
    if (readInstrumentation) {
      const shouldGuard = (objectVariable && isCppPointerVariable(objectVariable)) ||
        (!objectVariable && shouldGuardNullCheckedPointerFieldRead(stripped, objectName, accessStart));
      if (shouldGuard) {
        reads.push(`${indent}if (${objectName}) {\n${readInstrumentation}\n${indent}}`);
      } else {
        reads.push(readInstrumentation);
      }
    }
  }
  const instrumentation = reads.filter(Boolean).join('\n');
  return instrumentation ? `${instrumentation}\n${line}` : line;
}

function rewritePointerAssignmentWriteInstrumentation(line, lineNumber) {
  if (line.includes('tracecode::') || !line.includes('->')) return line;
  const match = line.match(/^(\s*)([A-Za-z_]\w*)\s*=\s*(.+->.+)\s*;\s*$/);
  if (!match) return line;
  const [, indent, name] = match;
  return `${line}\n${buildScalarWriteInstrumentation(name, lineNumber, indent)}`;
}

function rewriteFieldContainerCountInstrumentation(line, lineNumber) {
  if (line.includes('tracecode::trace_field_container_count')) return line;
  if (!line.includes('.count')) return line;

  let rewritten = line;
  let cursor = 0;
  const pattern = /\b([A-Za-z_]\w*)\s*(->|\.)\s*([A-Za-z_]\w*)\s*\.\s*count\s*\(/g;
  while (true) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(rewritten);
    if (!match) break;
    const start = match.index ?? 0;
    if (isInsideCppStringOrCharLiteral(rewritten, start)) {
      cursor = start + match[0].length;
      continue;
    }
    const [source, objectName, operator, fieldName] = match;
    const openIndex = start + source.lastIndexOf('(');
    const closeIndex = findMatchingParen(rewritten, openIndex);
    if (closeIndex < 0) break;
    const keyExpression = rewritten.slice(openIndex + 1, closeIndex).trim();
    if (!keyExpression) {
      cursor = closeIndex + 1;
      continue;
    }
    const replacement = `tracecode::trace_field_container_count(${objectName}${operator}${fieldName}, ${cppStringLiteral(objectName)}, ${cppStringLiteral(fieldName)}, ${keyExpression}, ${lineNumber}, ${cppIndexSourceForExpression(keyExpression)})`;
    rewritten = `${rewritten.slice(0, start)}${replacement}${rewritten.slice(closeIndex + 1)}`;
    cursor = start + replacement.length;
  }
  return rewritten;
}

function rewriteBareMemberAssignmentWriteInstrumentation(
  line,
  lineNumber,
  memberVariables = new Map(),
  localVariables = new Map(),
  activeClassName = null,
  traceMemberClassName = null
) {
  if (!activeClassName || activeClassName !== traceMemberClassName || line.includes('tracecode::')) return line;
  const match = line.match(/^(\s*)([A-Za-z_]\w*)\s*=\s*(.+?)\s*;\s*$/);
  if (!match) return line;
  const [, indent, name] = match;
  if (!memberVariables.has(name) || localVariables.has(name)) return line;
  const targetExpression = `std::string(${cppStringLiteral(`{"variable":"this","path":[${jsonStringLiteral(name)}]}`)})`;
  return [
    line,
    `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(`{"kind":"write","line":${lineNumber},"target":`)}) + ${targetExpression} + ",\\\"value\\\":" + tracecode::to_json(${name}) + "}", ${lineNumber});`,
  ].join('\n');
}

function rewriteBareMemberReadInstrumentation(
  line,
  lineNumber,
  memberVariables = new Map(),
  localVariables = new Map(),
  activeClassName = null,
  traceMemberClassName = null
) {
  if (!activeClassName || activeClassName !== traceMemberClassName || line.includes('tracecode::')) return line;
  const firstLine = line.split('\n')[0] ?? line;
  const match = firstLine.match(/^(\s*)(?:(?:const\s+)?[A-Za-z_][\w:<>,\s*&*]*\s+)?([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*;\s*$/);
  if (!match) return line;
  const [, indent, assigneeName, memberName] = match;
  if (assigneeName === memberName || !memberVariables.has(memberName) || localVariables.has(memberName)) return line;
  const targetExpression = `std::string(${cppStringLiteral(`{"variable":"this","path":[${jsonStringLiteral(memberName)}]}`)})`;
  return [
    `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(`{"kind":"read","line":${lineNumber},"target":`)}) + ${targetExpression} + ",\\\"value\\\":" + tracecode::to_json(${memberName}) + "}", ${lineNumber});`,
    line,
  ].join('\n');
}

function buildCallInstrumentation(lineNumber, signature, aliases = new Map()) {
  const callLine = signature.callLine ?? lineNumber;
  const callLineName = `__tc_call_line_${lineNumber}`;
  const callLineExpression = signature.dynamicCallLine ? 'tracecode::trace_event_line()' : String(callLine);
  const callEventPrefix = `{"kind":"call","line":`;
  const callEventSuffix = `,"function":${jsonStringLiteral(signature.name)},"args":`;
  const entryLine = signature.entryLine ?? callLine;
  const argsExpression = buildTraceArgsJsonExpression(signature, (parameter) => parameter.name, aliases);
  return [
    `int ${callLineName} = ${callLineExpression};`,
    `std::string __tc_args_json_${lineNumber} = std::string("{") + ${argsExpression} + "}";`,
    `tracecode::write_trace_event_json(std::string(${cppStringLiteral(callEventPrefix)}) + tracecode::to_json(${callLineName}) + ${cppStringLiteral(callEventSuffix)} + __tc_args_json_${lineNumber} + "}", ${callLineName});`,
    ...(signature.name === CPP_SCRIPT_FUNCTION_NAME ? [] : [`tracecode::emit_line(${entryLine}, ${cppStringLiteral(signature.name)});`]),
  ].join('\n');
}

function buildScopedTraceNameInstrumentation(lineNumber, signature, aliases = new Map()) {
  if (signature.skipScopedTraceNames) return '';
  const skipNames = signature.skipTraceParameterNames || new Set();
  return signature.parameters
    .filter((parameter) =>
      !skipNames.has(parameter.name) &&
      isVectorCppType(parameter.type, aliases) &&
      !/\bconst\b/.test(parameter.type)
    )
    .map((parameter) =>
      `auto __tc_trace_name_scope_${parameter.name}_${lineNumber} = tracecode::scoped_trace_name(${parameter.name}, ${cppStringLiteral(parameter.name)});`
    )
    .join('\n');
}

function buildReturnInstrumentation(lineNumber, signature) {
  const returnEventPrefix = `{"kind":"return","line":${lineNumber},"function":${jsonStringLiteral(signature.name)}`;
  return `tracecode::write_trace_event_json(std::string(${cppStringLiteral(`${returnEventPrefix}}`)}), ${lineNumber});`;
}

function splitTopLevelTernaryExpression(expression) {
  let depth = 0;
  let questionIndex = -1;
  for (let index = 0; index < expression.length; index += 1) {
    const ch = expression[index];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === '?' && depth === 0) {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex < 0) return null;
  depth = 0;
  for (let index = questionIndex + 1; index < expression.length; index += 1) {
    const ch = expression[index];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ':' && depth === 0) {
      return {
        condition: expression.slice(0, questionIndex).trim(),
        whenTrue: expression.slice(questionIndex + 1, index).trim(),
        whenFalse: expression.slice(index + 1).trim(),
      };
    }
  }
  return null;
}

function buildPostLineInstrumentation(lineNumber, functionName, variables, currentDepth, indent = '', includeSnapshots = true, includeLine = true) {
  const pieces = includeLine
    ? [`${indent}${buildLineInstrumentation(lineNumber, functionName)}`]
    : [];
  const declarationWrites = buildDeclarationWriteInstrumentation(lineNumber, variables, currentDepth, indent);
  if (declarationWrites) {
    pieces.push(declarationWrites);
  }
  const snapshots = includeSnapshots ? buildSnapshotInstrumentation(lineNumber, variables, currentDepth) : '';
  if (snapshots) {
    pieces.push(snapshots
      .split('\n')
      .filter(Boolean)
      .map((line) => `${indent}${line}`)
      .join('\n'));
  }
  return pieces.join('\n');
}

function shouldEmitCppFrameSnapshots(activeSignature, insideLocalLambdaBody) {
  return Boolean(activeSignature) && (!insideLocalLambdaBody || Boolean(activeSignature.lambda));
}

function shouldEmitCppImplicitFrameReturn(signature, aliases) {
  if (!signature) return false;
  const normalizedReturnType = normalizeCppType(signature.returnType, aliases);
  return normalizedReturnType === 'void' || (signature.lambda && normalizedReturnType === 'auto');
}

function cppCallNameMatchesAt(line, name, start) {
  const before = line.slice(Math.max(0, start - 6), start);
  if (before.endsWith('::')) return false;
  if (before.endsWith('.')) return false;
  if (before.endsWith('->') && !before.endsWith('this->')) return false;
  return true;
}

function cppLineCallsName(line, name) {
  if (!name || name.startsWith('<')) return false;
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'g');
  let match;
  while ((match = pattern.exec(line))) {
    if (cppCallNameMatchesAt(line, name, match.index)) return true;
  }
  return false;
}

function cppLineConstructsCallSiteType(line, callSiteNames) {
  const stripped = stripCppStringsAndComments(line).trim();
  for (const name of callSiteNames) {
    if (!name || name.startsWith('<')) continue;
    const escaped = escapeRegExp(name);
    if (new RegExp(`^(?:const\\s+)?${escaped}(?:\\s*[*&])*\\s+[A-Za-z_]\\w*\\s*\\(`).test(stripped)) return true;
    if (new RegExp(`^(?:const\\s+)?${escaped}(?:\\s*[*&])*\\s+[A-Za-z_]\\w*\\s*=\\s*${escaped}\\s*\\(`).test(stripped)) return true;
  }
  return false;
}

function shouldEmitCppCallSiteLine(line, activeSignature, callSiteNames) {
  const stripped = stripCppStringsAndComments(line);
  if (!stripped.includes('(')) return false;
  if (cppLineConstructsCallSiteType(stripped, callSiteNames)) return true;
  for (const name of callSiteNames) {
    if (cppLineCallsName(stripped, name)) return true;
  }
  const selfParameter = activeSignature?.lambda ? activeSignature.parameters?.[0] : null;
  if (
    selfParameter &&
    /\b(?:auto|function)\b|&&/.test(selfParameter.type || '') &&
    cppLineCallsName(stripped, selfParameter.name)
  ) {
    return true;
  }
  return false;
}

function cppCallExpressionStart(line, nameStart) {
  let cursor = nameStart;
  let prefix = line.slice(0, cursor);
  const memberMatch = prefix.match(/([A-Za-z_]\w*)\s*(?:\.|->)\s*$/);
  if (memberMatch && typeof memberMatch.index === 'number') {
    cursor = memberMatch.index;
  }
  return cursor;
}

function rewriteCppCallSiteExpressionLines(line, lineNumber, functionName, callSiteNames) {
  if (!line.includes('(')) return line;
  let output = line;
  let cursor = 0;

  while (cursor < output.length) {
    let best = null;
    for (const name of callSiteNames) {
      if (!name || name.startsWith('<')) continue;
      const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'g');
      pattern.lastIndex = cursor;
      const match = pattern.exec(output);
      if (!match) continue;
      if (output.slice(Math.max(0, match.index - 2), match.index).endsWith('::')) continue;
      if (!best || match.index < best.index) {
        best = { index: match.index, name, text: match[0] };
      }
    }
    if (!best) break;

    const openIndex = output.indexOf('(', best.index + best.name.length);
    const closeIndex = findMatchingParen(output, openIndex);
    if (openIndex < 0 || closeIndex < 0) {
      cursor = best.index + best.name.length;
      continue;
    }

    const expressionStart = cppCallExpressionStart(output, best.index);
    const expression = output.slice(expressionStart, closeIndex + 1);
    if (/^\s*(?:if|for|while|switch|return)\b/.test(expression)) {
      cursor = closeIndex + 1;
      continue;
    }
    const replacement = `([&]() { ${buildLineInstrumentation(lineNumber, functionName)} return ${expression}; })()`;
    output = `${output.slice(0, expressionStart)}${replacement}${output.slice(closeIndex + 1)}`;
    cursor = expressionStart + replacement.length;
  }

  return output;
}

function startsCppLocalLambdaDeclaration(line) {
  const stripped = stripCppStringsAndComments(line).trim();
  return (
    /\b(?:auto|(?:std::)?function\s*<[^=;]+>)\s+[A-Za-z_]\w*\s*=\s*\[[^\]]*\]/.test(stripped) &&
    !stripped.includes('{') &&
    !stripped.includes(';')
  );
}

function startsCppLocalLambdaBodyLine(line) {
  return stripCppStringsAndComments(line).includes('{');
}

function buildValueReturnInstrumentation(expression, lineNumber, signature, indent = '', postLineInstrumentation = '') {
  const returnEventPrefix = `{"kind":"return","line":${lineNumber},"function":${jsonStringLiteral(signature.name)},"value":`;
  const returnStorageType = signature.returnType && signature.returnType.trim() !== 'auto'
    ? localCppType(signature.returnType)
    : 'auto';
  const trimmedExpression = expression.trim();
  const ternary = returnStorageType !== 'auto' ? splitTopLevelTernaryExpression(trimmedExpression) : null;
  const returnStorageIsPointer = /\*$/.test(returnStorageType.trim());
  const returnDeclaration =
    ternary
      ? returnStorageIsPointer
        ? `${returnStorageType} __tc_return_${lineNumber} = (${ternary.condition}) ? (${ternary.whenTrue}) : (${ternary.whenFalse});`
        : `${returnStorageType} __tc_return_${lineNumber} = (${ternary.condition}) ? ${returnStorageType}(${ternary.whenTrue}) : ${returnStorageType}(${ternary.whenFalse});`
      : returnStorageType !== 'auto' && trimmedExpression.startsWith('{') && trimmedExpression.endsWith('}')
      ? `${returnStorageType} __tc_return_${lineNumber} ${trimmedExpression};`
      : `${returnStorageType} __tc_return_${lineNumber} = (${expression});`;
  return [
    `${indent}${returnDeclaration}`,
    buildFieldReadInstrumentation(trimmedExpression, `__tc_return_${lineNumber}`, lineNumber, indent),
    postLineInstrumentation,
    `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(returnEventPrefix)}) + ${signature.customJsonReturn ? `toJson(__tc_return_${lineNumber})` : `tracecode::to_json(__tc_return_${lineNumber})`} + "}", ${lineNumber});`,
    `${indent}return __tc_return_${lineNumber};`,
  ].filter(Boolean).join('\n');
}

function rewriteReturnInstrumentation(line, lineNumber, signature, postLineInstrumentation = '') {
  const match = line.match(/^(\s*)return(?:\s+(.+?))?\s*;\s*$/);
  if (!match) return line;
  const [, indent, expression] = match;
  if (!expression) {
    return [
      postLineInstrumentation,
      `${indent}${buildReturnInstrumentation(lineNumber, signature)}`,
      `${indent}return;`,
    ].filter(Boolean).join('\n');
  }
  return buildValueReturnInstrumentation(expression, lineNumber, signature, indent, postLineInstrumentation);
}

function rewriteSingleLineControlReturn(line, lineNumber, signature, postLineInstrumentation = '') {
  const match = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*\(.*?\)|else)\s+return(?:\s+(.+?))?\s*;\s*$/);
  if (!match) return line;
  const [, indent, control, expression] = match;
  if (/^\s*(?:do|switch)\b/.test(line)) return line;
  if (control !== 'else' && parenDeltaForLine(control) !== 0) return line;
  const innerIndent = `${indent}  `;
  if (!expression) {
    return [
      `${indent}${control} {`,
      `${innerIndent}${buildCurrentLineInstrumentation(lineNumber)}`,
      postLineInstrumentation,
      `${innerIndent}${buildReturnInstrumentation(lineNumber, signature)}`,
      `${innerIndent}return;`,
      `${indent}}`,
    ].join('\n');
  }
  return [
    `${indent}${control} {`,
    `${innerIndent}${buildCurrentLineInstrumentation(lineNumber)}`,
    buildValueReturnInstrumentation(expression, lineNumber, signature, innerIndent, postLineInstrumentation),
    `${indent}}`,
  ].join('\n');
}

function rewriteBracedSingleLineControlReturn(line, lineNumber, signature, postLineInstrumentation = '') {
  const match = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*\(.*?\)|else)\s*\{\s*return(?:\s+(.+?))?\s*;\s*\}\s*$/);
  if (!match) return line;
  const [, indent, control, expression] = match;
  if (control !== 'else' && parenDeltaForLine(control) !== 0) return line;
  const innerIndent = `${indent}  `;
  if (!expression) {
    return [
      `${indent}${control} {`,
      `${innerIndent}${buildCurrentLineInstrumentation(lineNumber)}`,
      postLineInstrumentation,
      `${innerIndent}${buildReturnInstrumentation(lineNumber, signature)}`,
      `${innerIndent}return;`,
      `${indent}}`,
    ].join('\n');
  }
  return [
    `${indent}${control} {`,
    `${innerIndent}${buildCurrentLineInstrumentation(lineNumber)}`,
    buildValueReturnInstrumentation(expression, lineNumber, signature, innerIndent, postLineInstrumentation),
    `${indent}}`,
  ].join('\n');
}

function rewriteControlTransferInstrumentation(line, lineNumber, postLineInstrumentation = '') {
  const match = line.match(/^(\s*)(break|continue)\s*;\s*$/);
  if (!match) return line;
  const [, indent, control] = match;
  return [
    postLineInstrumentation,
    `${indent}${control};`,
  ].filter(Boolean).join('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteTraceContainerParameters(line, signature, aliases = new Map(), source = '') {
  let rewritten = line;
  for (const parameter of signature.parameters) {
    if (!shouldTraceWrapCppParameter(parameter, signature, aliases, source)) continue;
    const baseParameterType = parameter.type.replace(/[&]/g, '').trim();
    const typePattern = escapeRegExp(baseParameterType).replace(/\\\s+/g, '\\s+');
    const pattern = new RegExp(`${typePattern}\\s*&?\\s+${escapeRegExp(parameter.name)}\\b`);
    const beforePrimaryRewrite = rewritten;
    rewritten = rewritten.replace(pattern, (match) => {
      const rewrittenType = /&/.test(match)
        ? `${cppTraceType(parameter.type, aliases)}&`
        : cppTraceType(parameter.type, aliases);
      return `${rewrittenType} ${parameter.name}`;
    });
    if (rewritten === beforePrimaryRewrite) {
      const fallbackPattern = new RegExp(`((?:std::)?(?:vector|deque|queue|priority_queue|stack|unordered_map|map|unordered_set|set)\\s*<.+>)\\s*(&?)\\s*${escapeRegExp(parameter.name)}\\b`);
      rewritten = rewritten.replace(fallbackPattern, (_match, _type, ref) => {
        const rewrittenType = ref ? `${cppTraceType(parameter.type, aliases)}&` : cppTraceType(parameter.type, aliases);
        return `${rewrittenType} ${parameter.name}`;
      });
    }
  }
  return rewritten;
}

function shouldTraceWrapCppParameter(parameter, signature, aliases = new Map(), source = '') {
  const skipNames = signature?.skipTraceParameterNames || new Set();
  if (skipNames.has(parameter.name)) return false;
  if (!isTraceWrappedCppType(parameter.type, aliases)) return false;
  if (/\bconst\b/.test(parameter.type)) return false;
  if (hasUnsafeMapProxyAutoReferenceBinding(parameter.type, source, parameter.name, aliases)) return false;
  return true;
}

function shouldRewriteTraceContainerParametersForSignature(signature, functionName, options = {}) {
  return !(options.traceMemberClassName && signature?.name !== functionName && !signature?.lambda);
}

function rewriteControlConditionSource(control, lineNumber, accessVariables = new Map(), aliases = new Map()) {
  if (control === 'else') return control;
  const openIndex = control.indexOf('(');
  if (openIndex < 0) return control;
  const closeIndex = findMatchingParen(control, openIndex);
  if (closeIndex < 0) return control;
  const condition = control.slice(openIndex + 1, closeIndex).trim();
  if (!condition) return control;
  const rewrittenCondition = rewriteIndexReadInstrumentation(condition, accessVariables, aliases, lineNumber);
  if (rewrittenCondition === condition) return control;
  return `${control.slice(0, openIndex + 1)}${rewrittenCondition}${control.slice(closeIndex)}`;
}

function rewriteInlineControlStatementInstrumentation(statement, lineNumber, variables = new Map(), accessVariables = new Map(), aliases = new Map(), source = '') {
  let rewritten = rewriteKeyedIndexSourceInstrumentation(statement, accessVariables, aliases, lineNumber);
  rewritten = rewriteVectorSwapInstrumentation(rewritten, accessVariables, aliases);
  rewritten = rewritePlainContainerMutationInstrumentation(rewritten, lineNumber, accessVariables, aliases, source);
  rewritten = rewriteNestedIndexedWriteInstrumentation(rewritten, lineNumber, accessVariables, aliases);
  rewritten = rewriteVectorIndexedWriteInstrumentation(rewritten, lineNumber, accessVariables, aliases);
  rewritten = rewritePlainIndexedWriteInstrumentation(rewritten, lineNumber, accessVariables, aliases);
  rewritten = rewriteFieldWriteInstrumentation(rewritten, lineNumber);
  rewritten = rewriteIndexReadInstrumentation(rewritten, accessVariables, aliases, lineNumber);
  rewritten = rewriteScalarWriteInstrumentation(rewritten, lineNumber, variables);
  return rewritten;
}

function inlineControlStatementSource(statement) {
  return statement
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}

function rewriteSingleLineControlBody(line, lineNumber, functionName, postLineInstrumentation = '', emitInsideBody = false, variables = new Map(), accessVariables = new Map(), aliases = new Map(), source = '') {
  let match = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*\(.*?\)|else)\s+([^{}].*;\s*)$/);
  let indent;
  let rawControl;
  let statement;
  if (match) {
    [, indent, rawControl, statement] = match;
  }
  if (!match || (rawControl !== 'else' && parenDeltaForLine(rawControl) !== 0)) {
    const controlMatch = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*)\(/);
    if (!controlMatch) return line;
    const openIndex = line.indexOf('(', controlMatch[0].length - 1);
    const closeIndex = findMatchingParen(line, openIndex);
    if (openIndex < 0 || closeIndex < 0) return line;
    const rest = line.slice(closeIndex + 1).trim();
    if (!rest || rest.includes('{') || rest.includes('}') || !/;\s*$/.test(rest)) return line;
    indent = controlMatch[1];
    rawControl = line.slice(indent.length, closeIndex + 1).trim();
    statement = rest;
    match = [line, indent, rawControl, statement];
  }
  if (/^\s*(?:do|switch)\b/.test(line)) return line;
  const control = rewriteControlConditionSource(rawControl, lineNumber, accessVariables, aliases);
  if (control !== 'else' && parenDeltaForLine(control) !== 0) return line;
  const controlTransfer = statement.trim().match(/^(break|continue)\s*;$/);
  if (controlTransfer) {
    const transfer = controlTransfer[1];
    return `${indent}${control} { ${buildCurrentLineInstrumentation(lineNumber)} ${postLineInstrumentation} ${transfer}; }`;
  }
  const rewrittenStatement = rewriteInlineControlStatementInstrumentation(statement.trim(), lineNumber, variables, accessVariables, aliases, source);
  const scalarWrite = buildInlineScalarWriteInstrumentation(rewrittenStatement, lineNumber, variables);
  const statementSource = inlineControlStatementSource(
    scalarWrite && !rewrittenStatement.includes('write_trace_event_json')
      ? `${rewrittenStatement}\n${scalarWrite}`
      : rewrittenStatement
  );
  if (emitInsideBody) {
    return `${indent}${control} { ${buildCurrentLineInstrumentation(lineNumber)} ${statementSource} ${postLineInstrumentation} }`;
  }
  return `${indent}${control} { ${buildCurrentLineInstrumentation(lineNumber)} ${statementSource} }`;
}

function buildInlineScalarWriteInstrumentation(statement, lineNumber, variables) {
  const stripped = stripCppStringsAndComments(statement).trim();
  if (!stripped) return '';
  const assignment = stripped.match(/^([A-Za-z_]\w*)\s*(?:[+\-*/%]?=)\s*.+;\s*$/);
  if (assignment && variables?.has(assignment[1])) {
    return buildScalarWriteInstrumentation(assignment[1], lineNumber);
  }
  const postfix = stripped.match(/^([A-Za-z_]\w*)\s*(?:\+\+|--)\s*;\s*$/);
  if (postfix && variables?.has(postfix[1])) {
    return buildScalarWriteInstrumentation(postfix[1], lineNumber);
  }
  const prefix = stripped.match(/^(?:\+\+|--)\s*([A-Za-z_]\w*)\s*;\s*$/);
  if (prefix && variables?.has(prefix[1])) {
    return buildScalarWriteInstrumentation(prefix[1], lineNumber);
  }
  return '';
}

function rewriteBracedSingleLineControlBody(line, lineNumber, postLineInstrumentation = '', variables = new Map(), accessVariables = new Map(), aliases = new Map(), source = '') {
  const match = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*\(.*?\)|else)\s*\{\s*([^{}].*;\s*)\}\s*$/);
  if (!match) return line;
  const [, indent, control, statement] = match;
  if (/^\s*(?:do|switch)\b/.test(line)) return line;
  if (control !== 'else' && parenDeltaForLine(control) !== 0) return line;
  const rewrittenStatement = rewriteInlineControlStatementInstrumentation(statement.trim(), lineNumber, variables, accessVariables, aliases, source);
  const scalarWrite = buildInlineScalarWriteInstrumentation(rewrittenStatement, lineNumber, variables);
  const statementSource = inlineControlStatementSource(
    scalarWrite && !rewrittenStatement.includes('write_trace_event_json')
      ? `${rewrittenStatement}\n${scalarWrite}`
      : rewrittenStatement
  );
  return `${indent}${control} { ${buildCurrentLineInstrumentation(lineNumber)} ${statementSource} ${postLineInstrumentation} }`;
}

function rewriteVectorElementMemberAccess(line, variables, aliases = new Map(), extraTraceContainerNames = new Set()) {
  let rewritten = line;
  const candidateNames = new Set(extraTraceContainerNames);
  const nestedVectorNames = new Set();
  for (const [name, variable] of variables || []) {
    const normalizedType = normalizeCppType(variable.type, aliases);
    const innerType = normalizedType.startsWith('vector<') ? normalizedType.slice('vector<'.length, -1).trim() : '';
    if (isVectorCppType(variable.type, aliases) && innerType.startsWith('vector<')) {
      nestedVectorNames.add(name);
    }
    if (
      isVectorCppType(variable.type, aliases) &&
      !/\bconst\b/.test(variable.type) &&
      !innerType.startsWith('vector<') &&
      innerType !== 'string' &&
      !/^(?:array|deque|queue|priority_queue|stack|map|unordered_map|set|unordered_set)</.test(innerType.replace(/^std::/, ''))
    ) {
      candidateNames.add(name);
    }
  }
  for (const name of new Set([...nestedVectorNames, ...extraTraceContainerNames])) {
    rewritten = rewriteNestedVectorMemberMethodIndexSources(rewritten, name);
  }
  for (const name of candidateNames) {
    const memberPattern = new RegExp(`\\bthis\\s*->\\s*${escapeRegExp(name)}\\s*\\[([^\\]]+)\\]\\s*\\.`, 'g');
    rewritten = rewritten.replace(memberPattern, (_match, indexExpression) => {
      const trimmedIndex = String(indexExpression || '').trim();
      return `this->${name}.with_index_source(${trimmedIndex}, ${cppIndexSourceForExpression(trimmedIndex)}).`;
    });
    const indexedMemberPattern = new RegExp(`\\bthis\\s*->\\s*${escapeRegExp(name)}\\s*\\[([^\\]]+)\\]`, 'g');
    rewritten = rewritten.replace(indexedMemberPattern, (match, indexExpression) => {
      if (match.includes('.with_index_source')) return match;
      const trimmedIndex = String(indexExpression || '').trim();
      return `this->${name}.with_index_source(${trimmedIndex}, ${cppIndexSourceForExpression(trimmedIndex)})`;
    });
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\[[^\\]]+\\]\\s*\\.`, 'g');
    rewritten = rewritten.replace(pattern, (match) => match.replace(/\.\s*$/, '->'));
  }
  return rewritten;
}

function rewriteNestedVectorMemberMethodIndexSources(line, name) {
  const methods = new Set(['assign', 'push_back', 'emplace_back', 'insert', 'erase', 'clear', 'pop_back']);
  let rewritten = line;
  let cursor = 0;
  while (cursor < rewritten.length) {
    const nameIndex = rewritten.indexOf(name, cursor);
    if (nameIndex < 0) break;
    const before = nameIndex > 0 ? rewritten[nameIndex - 1] : '';
    const beforeTwo = nameIndex >= 2 ? rewritten.slice(nameIndex - 2, nameIndex) : '';
    const afterName = rewritten[nameIndex + name.length] || '';
    if (
      /[A-Za-z0-9_]/.test(before) ||
      /[A-Za-z0-9_]/.test(afterName) ||
      before === '.' ||
      beforeTwo === '->' ||
      beforeTwo === '::' ||
      isInsideCppStringOrCharLiteral(rewritten, nameIndex)
    ) {
      cursor = nameIndex + name.length;
      continue;
    }

    let bracketIndex = nameIndex + name.length;
    while (/\s/.test(rewritten[bracketIndex] || '')) bracketIndex += 1;
    if (rewritten[bracketIndex] !== '[') {
      cursor = nameIndex + name.length;
      continue;
    }
    const closeIndex = findMatchingSquareBracket(rewritten, bracketIndex);
    if (closeIndex < 0) {
      cursor = nameIndex + name.length;
      continue;
    }

    let dotIndex = closeIndex + 1;
    while (/\s/.test(rewritten[dotIndex] || '')) dotIndex += 1;
    if (rewritten[dotIndex] !== '.') {
      cursor = closeIndex + 1;
      continue;
    }
    let methodIndex = dotIndex + 1;
    while (/\s/.test(rewritten[methodIndex] || '')) methodIndex += 1;
    const methodMatch = rewritten.slice(methodIndex).match(/^([A-Za-z_]\w*)\s*\(/);
    if (!methodMatch || !methods.has(methodMatch[1])) {
      cursor = closeIndex + 1;
      continue;
    }

    const openIndex = methodIndex + methodMatch[0].lastIndexOf('(');
    const indexExpression = rewritten.slice(bracketIndex + 1, closeIndex).trim();
    if (!indexExpression) {
      cursor = closeIndex + 1;
      continue;
    }

    const replacement = `${name}.with_index_source(${indexExpression}, ${cppIndexSourceForExpression(indexExpression)}).${methodMatch[1]}(`;
    rewritten = `${rewritten.slice(0, nameIndex)}${replacement}${rewritten.slice(openIndex + 1)}`;
    cursor = nameIndex + replacement.length;
  }
  return rewritten;
}

function previousNonWhitespace(source, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(source[cursor])) return source[cursor];
  }
  return '';
}

function nextNonWhitespace(source, index) {
  for (let cursor = index; cursor < source.length; cursor += 1) {
    if (!/\s/.test(source[cursor])) return { ch: source[cursor], index: cursor };
  }
  return { ch: '', index: source.length };
}

function isInsideCppStringOrCharLiteral(source, index) {
  let quote = '';
  let escaped = false;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const ch = source[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = Boolean(quote);
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
  }
  return Boolean(quote);
}

function isIndexReadInstrumentableCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return (
    normalized.startsWith('vector<') ||
    normalized.startsWith('tracecode::Vector<') ||
    normalized.startsWith('array<') ||
    normalized.startsWith('deque<') ||
    normalized.startsWith('tracecode::Deque<') ||
    normalized === 'string'
  );
}

function isStdArrayCppType(type, aliases = new Map()) {
  return normalizeCppType(type, aliases).startsWith('array<');
}

function isPlainIndexedWriteInstrumentableCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return normalized.startsWith('array<') || normalized === 'string';
}

function cppIndexSourceForExpression(expression) {
  const trimmed = expression.trim();
  const normalized = trimmed.replace(/\s+/g, ' ');
  if (/^[A-Za-z_]\w*$/.test(normalized)) return cppStringLiteral(normalized);
  const unaryIndexMatch = normalized.match(/^(?:\+\+|--)\s*([A-Za-z_]\w*)$/) ?? normalized.match(/^([A-Za-z_]\w*)\s*(?:\+\+|--)$/);
  if (unaryIndexMatch?.[1]) {
    return cppStringLiteral(unaryIndexMatch[1]);
  }
  if (/^[A-Za-z_]\w*\s*\[[^\]]+\]\s*$/.test(normalized)) return cppStringLiteral(normalized.replace(/\s+/g, ''));
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*\(\))+(?:\s*[+\-*/%]\s*\d+)?$/.test(normalized)) {
    return cppStringLiteral(normalized);
  }
  if (/^[A-Za-z_]\w*\s*\([^()]*\)$/.test(normalized)) {
    const openIndex = normalized.indexOf('(');
    const argsSource = normalized.slice(openIndex + 1, -1).trim();
    const args = argsSource ? splitTopLevelCommaList(argsSource) : [];
    const simpleArgument = String.raw`(?:[A-Za-z_]\w*|\d+|'(?:\\.|[^'\\])')`;
    const simpleExpression = new RegExp(`^${simpleArgument}(?:\\s*(?:[+\\-*/%]|<<|>>|&|\\||\\^)\\s*${simpleArgument})*$`);
    if (args.every((arg) => simpleExpression.test(arg.trim()))) {
      return cppStringLiteral(normalized);
    }
  }
  const indexedArithmeticTerm = String.raw`(?:[A-Za-z_]\w*\s*\[[^\]]+\]|[A-Za-z_]\w*|\d+|'(?:\\.|[^'\\])')`;
  const indexedArithmeticPattern = new RegExp(`^${indexedArithmeticTerm}(?:\\s*(?:[+\\-*/%]|<<|>>|&|\\||\\^)\\s*${indexedArithmeticTerm})*$`);
  if (indexedArithmeticPattern.test(trimmed) && /\b[A-Za-z_]\w*\b/.test(trimmed)) {
    return cppStringLiteral(normalized);
  }
  const identifiers = new Set(trimmed.match(/\b[A-Za-z_]\w*\b/g) || []);
  const literalsAndOperatorsOnly = /^(?:[A-Za-z_]\w*|\d+)(?:\s*(?:[+\-*/%]|<<|>>|&|\||\^)\s*(?:[A-Za-z_]\w*|\d+))*$/.test(trimmed);
  if (literalsAndOperatorsOnly && identifiers.size > 0) {
    return cppStringLiteral(normalized);
  }
  return 'nullptr';
}

function rewriteIndexReadInstrumentation(line, variables, aliases = new Map(), lineNumber = 1) {
  if (
    line.includes('tracecode::trace_index_read') ||
    line.includes('tracecode::trace_index_field_read') ||
    line.includes('tracecode::trace_nested_index_read')
  ) {
    return line;
  }
  if (/\b(?:std::)?swap\s*\(/.test(stripCppStringsAndComments(line))) {
    return line;
  }
  const candidateNames = [...(variables || []).entries()]
    .filter(([, variable]) => isIndexReadInstrumentableCppType(variable.type, aliases))
    .map(([name]) => name)
    .sort((left, right) => right.length - left.length);
  if (candidateNames.length === 0) return line;

  let rewritten = line;
  for (const name of candidateNames) {
    let cursor = 0;
    while (cursor < rewritten.length) {
      const nameIndex = rewritten.indexOf(name, cursor);
      if (nameIndex < 0) break;
      const before = nameIndex > 0 ? rewritten[nameIndex - 1] : '';
      const beforeTwo = nameIndex >= 2 ? rewritten.slice(nameIndex - 2, nameIndex) : '';
      const afterName = rewritten[nameIndex + name.length] || '';
      if (
        /[A-Za-z0-9_]/.test(before) ||
        /[A-Za-z0-9_]/.test(afterName) ||
        before === '.' ||
        beforeTwo === '->' ||
        beforeTwo === '::' ||
        isInsideCppStringOrCharLiteral(rewritten, nameIndex)
      ) {
        cursor = nameIndex + name.length;
        continue;
      }
      let bracketIndex = nameIndex + name.length;
      while (/\s/.test(rewritten[bracketIndex] || '')) bracketIndex += 1;
      if (rewritten[bracketIndex] !== '[') {
        let memberIndex = nameIndex + name.length;
        while (/\s/.test(rewritten[memberIndex] || '')) memberIndex += 1;
        if (rewritten[memberIndex] === '.') {
          const methodMatch = rewritten.slice(memberIndex).match(/^\.\s*(find|count)\s*\(/);
          if (methodMatch) {
            const openIndex = memberIndex + methodMatch[0].lastIndexOf('(');
            const closeIndex = findMatchingParen(rewritten, openIndex);
            if (closeIndex >= 0) {
              const keyExpression = rewritten.slice(openIndex + 1, closeIndex).trim();
              const indexSource = cppIndexSourceForExpression(keyExpression);
              const methodName = methodMatch[1];
              const replacement = `.${methodName}_with_index_source(${keyExpression}, ${indexSource})`;
              rewritten = `${rewritten.slice(0, memberIndex)}${replacement}${rewritten.slice(closeIndex + 1)}`;
              cursor = memberIndex + replacement.length;
              continue;
            }
          }
        }
        cursor = nameIndex + name.length;
        continue;
      }
      const closeIndex = findMatchingSquareBracket(rewritten, bracketIndex);
      if (closeIndex < 0) {
        cursor = nameIndex + name.length;
        continue;
      }
      const previous = previousNonWhitespace(rewritten, nameIndex);
      const prefixBeforeName = rewritten.slice(0, nameIndex).replace(/\s+$/g, '');
      const previousIsAddressOf = previous === '&' && !prefixBeforeName.endsWith('&&');
      const next = nextNonWhitespace(rewritten, closeIndex + 1);
      const twoCharNext = rewritten.slice(next.index, next.index + 2);
      const indexExpression = rewritten.slice(bracketIndex + 1, closeIndex).trim();
      const indexSource = cppIndexSourceForExpression(indexExpression);
      if (next.ch === '.') {
        if (previousIsAddressOf) {
          cursor = closeIndex + 1;
          continue;
        }
        const elementType = vectorElementCppType(variables.get(name)?.type || '', aliases);
        const memberSource = rewritten.slice(next.index);
        const sizeMatch = memberSource.match(/^\.\s*size\s*\(\s*\)/);
        if (sizeMatch && elementType?.replace(/^std::/, '').startsWith('vector<')) {
          const replacement = `tracecode::trace_nested_size_read(${name}, ${cppStringLiteral(name)}, ${indexExpression}, ${lineNumber}, ${indexSource})`;
          rewritten = `${rewritten.slice(0, nameIndex)}${replacement}${rewritten.slice(next.index + sizeMatch[0].length)}`;
          cursor = nameIndex + replacement.length;
          continue;
        }
        const fieldMatch = memberSource.match(/^\.\s*([A-Za-z_]\w*)\b(?!\s*\()/);
        if (fieldMatch && !elementType?.replace(/^std::/, '').startsWith('vector<')) {
          const fieldName = fieldMatch[1];
          const fieldEnd = next.index + fieldMatch[0].length;
          const replacement = `tracecode::trace_index_field_read(${name}, ${cppStringLiteral(name)}, ${indexExpression}, ${cppStringLiteral(fieldName)}, ${name}[${indexExpression}].${fieldName}, ${lineNumber}, ${indexSource})`;
          rewritten = `${rewritten.slice(0, nameIndex)}${replacement}${rewritten.slice(fieldEnd)}`;
          cursor = nameIndex + replacement.length;
          continue;
        }
        if (elementType?.replace(/^std::/, '').startsWith('vector<')) {
          cursor = closeIndex + 1;
          continue;
        }
        const replacement = `tracecode::trace_index_read(${name}, ${cppStringLiteral(name)}, ${indexExpression}, ${lineNumber}, ${indexSource})`;
        rewritten = `${rewritten.slice(0, nameIndex)}${replacement}${rewritten.slice(closeIndex + 1)}`;
        cursor = nameIndex + replacement.length;
        continue;
      }
      if (next.ch === '[') {
        const secondBracketIndex = next.index;
        const secondCloseIndex = findMatchingSquareBracket(rewritten, secondBracketIndex);
        if (secondCloseIndex < 0) {
          cursor = closeIndex + 1;
          continue;
        }
        const afterNested = nextNonWhitespace(rewritten, secondCloseIndex + 1);
        const twoCharAfterNested = rewritten.slice(afterNested.index, afterNested.index + 2);
        if (
          previousIsAddressOf ||
          afterNested.ch === '[' ||
          afterNested.ch === '.' ||
          twoCharAfterNested === '->' ||
          twoCharAfterNested === '++' ||
          twoCharAfterNested === '--' ||
          (/^[+\-*/%]?=$/.test(twoCharAfterNested) && twoCharAfterNested !== '==') ||
          (afterNested.ch === '=' && rewritten[afterNested.index + 1] !== '=')
        ) {
          cursor = secondCloseIndex + 1;
          continue;
        }
        const outerExpression = rewritten.slice(bracketIndex + 1, closeIndex).trim();
        const innerExpression = rewritten.slice(secondBracketIndex + 1, secondCloseIndex).trim();
        const outerSource = cppIndexSourceForExpression(outerExpression);
        const innerSource = cppIndexSourceForExpression(innerExpression);
        const replacement = `tracecode::trace_nested_index_read(${name}, ${cppStringLiteral(name)}, ${outerExpression}, ${innerExpression}, ${lineNumber}, ${outerSource}, ${innerSource})`;
        rewritten = `${rewritten.slice(0, nameIndex)}${replacement}${rewritten.slice(secondCloseIndex + 1)}`;
        cursor = nameIndex + replacement.length;
        continue;
      }
      if (previousIsAddressOf) {
        const replacement = `tracecode::trace_index_address_read(${name}, ${cppStringLiteral(name)}, ${indexExpression}, ${lineNumber}, ${indexSource})`;
        rewritten = `${rewritten.slice(0, nameIndex)}${replacement}${rewritten.slice(closeIndex + 1)}`;
        cursor = nameIndex + replacement.length;
        continue;
      }
      if (
        twoCharNext === '->' ||
        twoCharNext === '++' ||
        twoCharNext === '--' ||
        (/^[+\-*/%]?=$/.test(twoCharNext) && twoCharNext !== '==') ||
        (next.ch === '=' && rewritten[next.index + 1] !== '=')
      ) {
        cursor = closeIndex + 1;
        continue;
      }
      const replacement = `tracecode::trace_index_read(${name}, ${cppStringLiteral(name)}, ${indexExpression}, ${lineNumber}, ${indexSource})`;
      rewritten = `${rewritten.slice(0, nameIndex)}${replacement}${rewritten.slice(closeIndex + 1)}`;
      cursor = nameIndex + replacement.length;
    }
  }
  return rewritten;
}

function rewriteStringPointerIndexedReadInstrumentation(line, lineNumber, pointerAliases = new Map()) {
  if (line.includes('tracecode::trace_index_read') || !line.includes('(*') || pointerAliases.size === 0) {
    return line;
  }
  let rewritten = line;
  for (const pointerName of [...pointerAliases.keys()].sort((left, right) => right.length - left.length)) {
    let cursor = 0;
    const needle = `(*${pointerName}`;
    while (cursor < rewritten.length) {
      const start = rewritten.indexOf(needle, cursor);
      if (start < 0) break;
      if (isInsideCppStringOrCharLiteral(rewritten, start)) {
        cursor = start + needle.length;
        continue;
      }
      const before = previousNonWhitespace(rewritten, start);
      const closePointer = rewritten.indexOf(')', start + needle.length);
      if (closePointer < 0) break;
      const bracket = nextNonWhitespace(rewritten, closePointer + 1);
      if (bracket.ch !== '[') {
        cursor = closePointer + 1;
        continue;
      }
      const closeBracket = findMatchingSquareBracket(rewritten, bracket.index);
      if (closeBracket < 0) break;
      const next = nextNonWhitespace(rewritten, closeBracket + 1);
      const twoCharNext = rewritten.slice(next.index, next.index + 2);
      if (
        before === '&' ||
        twoCharNext === '++' ||
        twoCharNext === '--' ||
        (/^[+\-*/%]?=$/.test(twoCharNext) && twoCharNext !== '==') ||
        (next.ch === '=' && rewritten[next.index + 1] !== '=')
      ) {
        cursor = closeBracket + 1;
        continue;
      }
      const indexExpression = rewritten.slice(bracket.index + 1, closeBracket).trim();
      if (!indexExpression) {
        cursor = closeBracket + 1;
        continue;
      }
      const replacement = `tracecode::trace_index_read(*${pointerName}, ${cppStringLiteral(pointerName)}, ${indexExpression}, ${lineNumber}, ${cppIndexSourceForExpression(indexExpression)})`;
      rewritten = `${rewritten.slice(0, start)}${replacement}${rewritten.slice(closeBracket + 1)}`;
      cursor = start + replacement.length;
    }
  }
  return rewritten;
}

function updateStringPointerAliasesForLine(line, pointerAliases, variables, aliases = new Map(), scopeDepth = 0) {
  const stripped = stripCppStringsAndComments(line).trim();
  const assignmentMatch = stripped.match(/^(?:(?:const\s+)?(?:std::)?string\s*\*\s*)?([A-Za-z_]\w*)\s*=\s*&\s*([A-Za-z_]\w*)\s*;\s*$/);
  if (assignmentMatch) {
    const [, pointerName, sourceName] = assignmentMatch;
    const sourceVariable = variables?.get(sourceName);
    if (sourceVariable && isStringCppType(sourceVariable.type, aliases)) {
      pointerAliases.set(pointerName, { sourceName, scopeDepth: 1 });
    }
    return;
  }
  for (const match of stripped.matchAll(/\b([A-Za-z_]\w*)\s*=\s*&\s*([A-Za-z_]\w*)\b/g)) {
    const [, pointerName, sourceName] = match;
    const sourceVariable = variables?.get(sourceName);
    if (sourceVariable && isStringCppType(sourceVariable.type, aliases)) {
      pointerAliases.set(pointerName, { sourceName, scopeDepth: 1 });
    }
  }
  const nullAssignmentMatch = stripped.match(/^([A-Za-z_]\w*)\s*=\s*(?:nullptr|NULL|0)\s*;\s*$/);
  if (nullAssignmentMatch) {
    pointerAliases.delete(nullAssignmentMatch[1]);
  }
}

function parseIndexedElementAliasDeclaration(line) {
  const match = line.match(/^(\s*)(.*?)\s*=\s*([A-Za-z_]\w*)\s*\[([^\]]+)\](\s*;\s*)$/);
  if (!match) return null;
  const [, indent, leftHandSide, sourceName, outerIndex, suffix] = match;
  const aliasMatch = leftHandSide.match(/^(.*?)([A-Za-z_]\w*)\s*$/);
  if (!aliasMatch) return null;
  const [, declarationPrefix, aliasName] = aliasMatch;
  if (!declarationPrefix.includes('&')) return null;
  const trimmedOuterIndex = outerIndex.trim();
  if (!trimmedOuterIndex) return null;
  return {
    indent,
    declarationPrefix,
    aliasName,
    sourceName,
    outerIndex: trimmedOuterIndex,
    suffix,
  };
}

function detectIndexedElementAlias(line, variables, aliases = new Map(), scopeDepth = 0, lineNumber = 0) {
  const declaration = parseIndexedElementAliasDeclaration(line);
  if (!declaration) return null;
  const { aliasName, sourceName, outerIndex } = declaration;
  const sourceVariable = variables?.get(sourceName);
  if (!sourceVariable) return null;
  const vectorElementType = vectorElementCppType(sourceVariable.type || '', aliases);
  const mappedValueType = vectorElementType ? null : mapValueCppType(sourceVariable.type || '', aliases);
  const elementType = vectorElementType ?? (mappedValueType && isVectorCppType(mappedValueType, aliases) ? mappedValueType : null);
  if (elementType && isStringCppType(elementType, aliases)) return null;
  if (!elementType || !isIndexReadInstrumentableCppType(elementType, aliases)) return null;
  const indexVariableName = `__tracecode_alias_index_${lineNumber || 'local'}_${aliasName}`;
  return {
    name: aliasName,
    sourceName,
    originalOuterIndex: outerIndex,
    outerIndex: indexVariableName,
    outerSource: cppIndexSourceForExpression(outerIndex),
    indexVariableName,
    scopeDepth,
  };
}

function rewriteIndexedElementAliasDeclaration(line, alias) {
  if (!alias?.indexVariableName || !alias?.originalOuterIndex) return line;
  const declaration = parseIndexedElementAliasDeclaration(line);
  if (!declaration) return line;
  const { indent, declarationPrefix, aliasName, sourceName, suffix } = declaration;
  if (aliasName !== alias.name || sourceName !== alias.sourceName) return line;
  return [
    `${indent}const auto ${alias.indexVariableName} = ${alias.originalOuterIndex};`,
    `${indent}${declarationPrefix}${aliasName} = ${sourceName}[${alias.indexVariableName}]${suffix.trimEnd()}`,
  ].join('\n');
}

function rewriteIndexedElementAliasReadInstrumentation(line, lineNumber, indexedElementAliases = new Map()) {
  if (!indexedElementAliases?.size || line.includes('tracecode::trace_nested_index_read')) {
    return line;
  }
  let rewritten = line;
  const aliasNames = [...indexedElementAliases.keys()].sort((left, right) => right.length - left.length);
  for (const aliasName of aliasNames) {
    const alias = indexedElementAliases.get(aliasName);
    if (!alias?.sourceName) continue;
    let cursor = 0;
    while (cursor < rewritten.length) {
      const nameIndex = rewritten.indexOf(aliasName, cursor);
      if (nameIndex < 0) break;
      const before = nameIndex > 0 ? rewritten[nameIndex - 1] : '';
      const beforeTwo = nameIndex >= 2 ? rewritten.slice(nameIndex - 2, nameIndex) : '';
      const afterName = rewritten[nameIndex + aliasName.length] || '';
      if (
        /[A-Za-z0-9_]/.test(before) ||
        /[A-Za-z0-9_]/.test(afterName) ||
        before === '.' ||
        beforeTwo === '->' ||
        beforeTwo === '::' ||
        isInsideCppStringOrCharLiteral(rewritten, nameIndex)
      ) {
        cursor = nameIndex + aliasName.length;
        continue;
      }
      let bracketIndex = nameIndex + aliasName.length;
      while (/\s/.test(rewritten[bracketIndex] || '')) bracketIndex += 1;
      if (rewritten[bracketIndex] !== '[') {
        cursor = nameIndex + aliasName.length;
        continue;
      }
      const closeIndex = findMatchingSquareBracket(rewritten, bracketIndex);
      if (closeIndex < 0) {
        cursor = nameIndex + aliasName.length;
        continue;
      }
      const previous = previousNonWhitespace(rewritten, nameIndex);
      const prefixBeforeName = rewritten.slice(0, nameIndex).replace(/\s+$/g, '');
      const previousIsAddressOf = previous === '&' && !prefixBeforeName.endsWith('&&');
      const next = nextNonWhitespace(rewritten, closeIndex + 1);
      const twoCharNext = rewritten.slice(next.index, next.index + 2);
      if (
        previousIsAddressOf ||
        next.ch === '[' ||
        next.ch === '.' ||
        twoCharNext === '->' ||
        twoCharNext === '++' ||
        twoCharNext === '--' ||
        (/^[+\-*/%]?=$/.test(twoCharNext) && twoCharNext !== '==') ||
        (next.ch === '=' && rewritten[next.index + 1] !== '=')
      ) {
        cursor = closeIndex + 1;
        continue;
      }
      const innerIndex = rewritten.slice(bracketIndex + 1, closeIndex).trim();
      if (!innerIndex) {
        cursor = closeIndex + 1;
        continue;
      }
      const replacement = `tracecode::trace_nested_index_read(${alias.sourceName}, ${cppStringLiteral(alias.sourceName)}, ${alias.outerIndex}, ${innerIndex}, ${lineNumber}, ${alias.outerSource}, ${cppIndexSourceForExpression(innerIndex)})`;
      rewritten = `${rewritten.slice(0, nameIndex)}${replacement}${rewritten.slice(closeIndex + 1)}`;
      cursor = nameIndex + replacement.length;
    }
  }
  return rewritten;
}

function rewriteIndexedElementAliasMutationInstrumentation(line, lineNumber, indexedElementAliases = new Map()) {
  if (!indexedElementAliases?.size) return line;
  const match = line.match(/^(\s*)([A-Za-z_]\w*)\s*\.\s*(push_back|emplace_back)\s*\((.*)\)\s*;\s*$/);
  if (!match) return line;
  const [, indent, aliasName, method, argsSource] = match;
  const alias = indexedElementAliases.get(aliasName);
  if (!alias?.sourceName || !alias.outerIndex || !alias.outerSource) return line;
  return `${indent}${alias.sourceName}.with_index_source(${alias.outerIndex}, ${alias.outerSource}, ${lineNumber}).${method}(${argsSource});`;
}

function isKeyedIndexSourceInstrumentableCppType(type, aliases = new Map()) {
  return isUnorderedMapCppType(type, aliases) || isMapCppType(type, aliases);
}

function isKeyedIndexSourceInstrumentableVariable(variable, aliases = new Map()) {
  if (!variable || !isKeyedIndexSourceInstrumentableCppType(variable.type, aliases)) return false;
  if (variable.parameter && !variable.traceWrapped) return false;
  return true;
}

function rewriteKeyedIndexSourceInstrumentation(line, variables, aliases = new Map(), lineNumber = 0) {
  const candidateNames = [...(variables || []).entries()]
    .filter(([, variable]) => isKeyedIndexSourceInstrumentableVariable(variable, aliases))
    .map(([name]) => name)
    .sort((left, right) => right.length - left.length);
  if (candidateNames.length === 0) return line;

  let rewritten = line;
  for (const name of candidateNames) {
    let cursor = 0;
    while (cursor < rewritten.length) {
      const nameIndex = rewritten.indexOf(name, cursor);
      if (nameIndex < 0) break;
      const before = nameIndex > 0 ? rewritten[nameIndex - 1] : '';
      const beforeTwo = nameIndex >= 2 ? rewritten.slice(nameIndex - 2, nameIndex) : '';
      const afterName = rewritten[nameIndex + name.length] || '';
      if (
        /[A-Za-z0-9_]/.test(before) ||
        /[A-Za-z0-9_]/.test(afterName) ||
        before === '.' ||
        beforeTwo === '->' ||
        beforeTwo === '::' ||
        isInsideCppStringOrCharLiteral(rewritten, nameIndex)
      ) {
        cursor = nameIndex + name.length;
        continue;
      }
      let bracketIndex = nameIndex + name.length;
      while (/\s/.test(rewritten[bracketIndex] || '')) bracketIndex += 1;
      if (rewritten[bracketIndex] !== '[') {
        if (rewritten[bracketIndex] === '.') {
          const methodMatch = rewritten.slice(bracketIndex).match(/^\.\s*(find|count)\s*\(/);
          if (methodMatch) {
            const openIndex = bracketIndex + methodMatch[0].lastIndexOf('(');
            const closeIndex = findMatchingParen(rewritten, openIndex);
            if (closeIndex >= 0) {
              const keyExpression = rewritten.slice(openIndex + 1, closeIndex).trim();
              const indexSource = cppIndexSourceForExpression(keyExpression);
              const methodName = methodMatch[1];
              const replacement = `.${methodName}_with_index_source(${keyExpression}, ${indexSource})`;
              rewritten = `${rewritten.slice(0, bracketIndex)}${replacement}${rewritten.slice(closeIndex + 1)}`;
              cursor = bracketIndex + replacement.length;
              continue;
            }
          }
        }
        cursor = nameIndex + name.length;
        continue;
      }
      const closeIndex = findMatchingSquareBracket(rewritten, bracketIndex);
      if (closeIndex < 0) {
        cursor = nameIndex + name.length;
        continue;
      }
      const indexExpression = rewritten.slice(bracketIndex + 1, closeIndex).trim();
      const indexSource = cppIndexSourceForExpression(indexExpression);
      const replacement = `${name}.with_index_source(${indexExpression}, ${indexSource}, ${lineNumber})`;
      rewritten = `${rewritten.slice(0, nameIndex)}${replacement}${rewritten.slice(closeIndex + 1)}`;
      cursor = nameIndex + replacement.length;
    }
  }
  return rewritten;
}

function parseSimpleIndexedAccessExpression(expression) {
  const trimmed = expression.trim();
  const nameMatch = trimmed.match(/^([A-Za-z_]\w*)\s*\[/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const bracketIndex = trimmed.indexOf('[', name.length);
  const closeIndex = findMatchingSquareBracket(trimmed, bracketIndex);
  if (closeIndex < 0) return null;
  if (trimmed.slice(closeIndex + 1).trim() !== '') return null;
  const indexExpression = trimmed.slice(bracketIndex + 1, closeIndex).trim();
  if (!indexExpression) return null;
  return { name, indexExpression };
}

function rewriteVectorSwapInstrumentation(line, variables, aliases = new Map()) {
  if (!/\b(?:std::)?swap\s*\(/.test(stripCppStringsAndComments(line))) return line;
  if (line.includes('tracecode::trace_index_ref')) return line;
  const swapMatch = line.match(/\b(?:std::)?swap\s*\(/);
  if (!swapMatch || swapMatch.index === undefined) return line;
  const openIndex = line.indexOf('(', swapMatch.index);
  const closeIndex = findMatchingParen(line, openIndex);
  if (openIndex < 0 || closeIndex < 0) return line;
  if (!/^\s*;\s*$/.test(line.slice(closeIndex + 1))) return line;

  const args = splitTopLevelCommaList(line.slice(openIndex + 1, closeIndex));
  if (args.length !== 2) return line;
  const accesses = args.map(parseSimpleIndexedAccessExpression);
  if (accesses.some((access) => access === null)) return line;

  const rewrittenArgs = [];
  for (const access of accesses) {
    const variable = variables.get(access.name);
    if (!variable || !isVectorCppType(variable.type, aliases)) return line;
    rewrittenArgs.push(
      `tracecode::trace_index_ref(${access.name}, ${cppStringLiteral(access.name)}, ${access.indexExpression}, ${cppIndexSourceForExpression(access.indexExpression)})`
    );
  }

  return `${line.slice(0, swapMatch.index)}swap(${rewrittenArgs.join(', ')})${line.slice(closeIndex + 1)}`;
}

function scopeTraceContainerAssignmentLine(line, lineNumber) {
  if (!line.includes('.with_index_source') || line.includes('TraceHooks::setCurrentLine')) return line;
  const stripped = stripCppStringsAndComments(line);
  if (!/\.with_index_source\s*\([^;]*\)\s*=/.test(stripped)) return line;
  const indent = line.match(/^(\s*)/)?.[1] ?? '';
  return `${indent}${buildCurrentLineInstrumentation(lineNumber)}\n${line}`;
}

function findIndexedStatementAccess(line, name) {
  let cursor = 0;
  while (cursor < line.length) {
    const nameIndex = line.indexOf(name, cursor);
    if (nameIndex < 0) return null;
    const before = nameIndex > 0 ? line[nameIndex - 1] : '';
    const afterName = line[nameIndex + name.length] || '';
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(afterName)) {
      cursor = nameIndex + name.length;
      continue;
    }
    let bracketIndex = nameIndex + name.length;
    while (/\s/.test(line[bracketIndex] || '')) bracketIndex += 1;
    if (line[bracketIndex] !== '[') {
      cursor = nameIndex + name.length;
      continue;
    }
    const closeIndex = findMatchingSquareBracket(line, bracketIndex);
    if (closeIndex < 0) return null;
    return { nameIndex, bracketIndex, closeIndex };
  }
  return null;
}

function findNestedIndexedStatementAccess(line, name) {
  const outer = findIndexedStatementAccess(line, name);
  if (!outer) return null;
  const next = nextNonWhitespace(line, outer.closeIndex + 1);
  if (next.ch !== '[') return null;
  const innerCloseIndex = findMatchingSquareBracket(line, next.index);
  if (innerCloseIndex < 0) return null;
  return {
    nameIndex: outer.nameIndex,
    outerBracketIndex: outer.bracketIndex,
    outerCloseIndex: outer.closeIndex,
    innerBracketIndex: next.index,
    innerCloseIndex,
  };
}

function rewriteNestedIndexedWriteInstrumentation(line, lineNumber, variables, aliases = new Map()) {
  const stripped = stripCppStringsAndComments(line).trim();
  if (!stripped || /^(?:if|for|while|switch|return|break|continue)\b/.test(stripped)) return line;
  if (line.includes('tracecode::')) return line;

  const candidateNames = [...(variables || []).entries()]
    .filter(([, variable]) => isVectorCppType(variable.type, aliases))
    .map(([name]) => name)
    .sort((left, right) => right.length - left.length);
  if (candidateNames.length === 0) return line;

  const indent = line.match(/^(\s*)/)?.[1] ?? '';
  for (const name of candidateNames) {
    const access = findNestedIndexedStatementAccess(line, name);
    if (!access) continue;
    const beforeAccess = line.slice(indent.length, access.nameIndex).trim();
    const afterAccess = line.slice(access.innerCloseIndex + 1).trim();
    const outerExpression = line.slice(access.outerBracketIndex + 1, access.outerCloseIndex).trim();
    const innerExpression = line.slice(access.innerBracketIndex + 1, access.innerCloseIndex).trim();
    if (!outerExpression || !innerExpression) continue;

    let rewrittenStatement = null;
    const nestedRef = `tracecode::trace_nested_index_ref(${name}, ${cppStringLiteral(name)}, ${outerExpression}, ${innerExpression}, ${cppIndexSourceForExpression(outerExpression)}, ${cppIndexSourceForExpression(innerExpression)})`;
    if ((beforeAccess === '++' || beforeAccess === '--') && afterAccess === ';') {
      rewrittenStatement = `${beforeAccess}${nestedRef};`;
    } else if (beforeAccess === '') {
      if (/^(?:\+\+|--)\s*;\s*$/.test(afterAccess)) {
        rewrittenStatement = `${nestedRef}${afterAccess}`;
      } else {
        const assignment = afterAccess.match(/^((?:[+\-*/%&|^]|<<|>>)?=)\s*(.+;\s*)$/);
        if (assignment && assignment[1] !== '==') {
          rewrittenStatement = `${nestedRef} ${assignment[1]} ${assignment[2]}`;
        }
      }
    }
    if (!rewrittenStatement) continue;
    return `${indent}${rewrittenStatement.trim()}`;
  }
  return line;
}

function rewriteVectorIndexedWriteInstrumentation(line, lineNumber, variables, aliases = new Map()) {
  const stripped = stripCppStringsAndComments(line).trim();
  if (!stripped || /^(?:if|for|while|switch|return|break|continue)\b/.test(stripped)) return line;
  if (line.includes('tracecode::')) return line;

  const candidateNames = [...(variables || []).entries()]
    .filter(([, variable]) => isVectorCppType(variable.type, aliases))
    .map(([name]) => name)
    .sort((left, right) => right.length - left.length);
  if (candidateNames.length === 0) return line;

  const indent = line.match(/^(\s*)/)?.[1] ?? '';
  for (const name of candidateNames) {
    const access = findIndexedStatementAccess(line, name);
    if (!access) continue;
    const beforeAccess = line.slice(indent.length, access.nameIndex).trim();
    const afterAccess = line.slice(access.closeIndex + 1).trim();
    const indexExpression = line.slice(access.bracketIndex + 1, access.closeIndex).trim();
    if (!indexExpression) continue;

    const indexedRef = `tracecode::trace_index_ref(${name}, ${cppStringLiteral(name)}, ${indexExpression}, ${cppIndexSourceForExpression(indexExpression)})`;
    let rewrittenStatement = null;
    if ((beforeAccess === '++' || beforeAccess === '--') && afterAccess === ';') {
      rewrittenStatement = `${beforeAccess}${indexedRef};`;
    } else if (beforeAccess === '') {
      if (/^(?:\+\+|--)\s*;\s*$/.test(afterAccess)) {
        rewrittenStatement = `${indexedRef}${afterAccess}`;
      } else {
        const assignment = afterAccess.match(/^((?:[+\-*/%&|^]|<<|>>)?=)\s*(.+;\s*)$/);
        if (assignment && assignment[1] !== '==') {
          rewrittenStatement = `${indexedRef} ${assignment[1]} ${assignment[2]}`;
        }
      }
    }
    if (!rewrittenStatement) continue;
    return `${indent}${rewrittenStatement.trim()}`;
  }
  return line;
}

function rewritePlainIndexedWriteInstrumentation(line, lineNumber, variables, aliases = new Map()) {
  const stripped = stripCppStringsAndComments(line).trim();
  if (!stripped || /^(?:if|for|while|switch|return|break|continue)\b/.test(stripped)) return line;
  if (line.includes('tracecode::')) return line;

  const candidateNames = [...(variables || []).entries()]
    .filter(([, variable]) => isPlainIndexedWriteInstrumentableCppType(variable.type, aliases))
    .map(([name]) => name)
    .sort((left, right) => right.length - left.length);
  if (candidateNames.length === 0) return line;

  const indent = line.match(/^(\s*)/)?.[1] ?? '';
  for (const name of candidateNames) {
    const access = findIndexedStatementAccess(line, name);
    if (!access) continue;
    const beforeAccess = line.slice(indent.length, access.nameIndex).trim();
    const afterAccess = line.slice(access.closeIndex + 1).trim();
    const indexExpression = line.slice(access.bracketIndex + 1, access.closeIndex).trim();
    if (!indexExpression) continue;

    let rewrittenStatement = null;
    if ((beforeAccess === '++' || beforeAccess === '--') && afterAccess === ';') {
      rewrittenStatement = `${beforeAccess}${name}[__tc_index_${lineNumber}];`;
    } else if (beforeAccess === '') {
      if (/^(?:\+\+|--)\s*;\s*$/.test(afterAccess)) {
        rewrittenStatement = `${name}[__tc_index_${lineNumber}]${afterAccess}`;
      } else {
        const assignment = afterAccess.match(/^((?:[+\-*/%&|^]|<<|>>)?=)\s*(.+;\s*)$/);
        if (assignment && assignment[1] !== '==') {
          rewrittenStatement = `${name}[__tc_index_${lineNumber}] ${assignment[1]} ${assignment[2]}`;
        }
      }
    }
    if (!rewrittenStatement) continue;
    const indexSource = cppIndexSourceForExpression(indexExpression);
    return [
      `${indent}{`,
      `${indent}  auto __tc_index_${lineNumber} = static_cast<std::size_t>(${indexExpression});`,
      `${indent}  (void)tracecode::trace_index_read(${name}, ${cppStringLiteral(name)}, __tc_index_${lineNumber}, ${lineNumber}, ${indexSource});`,
      `${indent}  ${rewrittenStatement.trim()}`,
      `${indent}  tracecode::emit_index_write_value(${cppStringLiteral(name)}, ${name}, __tc_index_${lineNumber}, ${lineNumber}, ${indexSource});`,
      `${indent}}`,
    ].join('\n');
  }
  return line;
}

function shouldEmitPlainContainerMutation(variable, name, aliases = new Map(), source = '') {
  if (!variable || !isSnapshotSerializableCppType(variable.type, aliases)) return false;
  if (variable.parameter && variable.traceWrapEligible && !variable.traceWrapped) return true;
  if (/[&]/.test(variable.type || '') && isTraceWrappedCppType(variable.type, aliases)) return false;
  if (variable.parameter && /\bstd::/.test(variable.type)) {
    if (
      !variable.lambdaParameter &&
      isTraceWrappedCppType(variable.type, aliases) &&
      !parameterAddressEscapes(source, name) &&
      !hasUnsafeMapProxyAutoReferenceBinding(variable.type, source, name, aliases)
    ) {
      return false;
    }
    return true;
  }
  if (!isTraceWrappedCppType(variable.type, aliases)) return true;
  const normalized = normalizeCppType(variable.type, aliases);
  return normalized === 'vector<string>' && !localVectorStringFeedsTraceWrappedParameter(source, name, aliases);
}

function isAssociativeCppType(type, aliases = new Map()) {
  return isMapCppType(type, aliases) || isUnorderedMapCppType(type, aliases) || isSetLikeCppType(type, aliases);
}

function cppValueTypeTempInitialization(containerName, tempName, argumentSource) {
  const trimmedArgument = argumentSource.trim();
  const initializer = trimmedArgument.startsWith('{') ? trimmedArgument : `(${trimmedArgument})`;
  return `std::decay_t<decltype(${containerName})>::value_type ${tempName} = ${initializer};`;
}

function buildMutationArgumentCapture(containerName, tempName, argumentSource, indent = '') {
  const trimmedArgument = argumentSource.trim();
  if (trimmedArgument.startsWith('{') && trimmedArgument.endsWith('}')) {
    const aggregateArgs = splitTopLevel(trimmedArgument.slice(1, -1), ',', { trackAngleBrackets: true })
      .map((arg) => arg.trim())
      .filter(Boolean);
    if (aggregateArgs.length > 0 && aggregateArgs.every((arg) => !arg.startsWith('{'))) {
      const valueNames = aggregateArgs.map((_, index) => `${tempName}_field_${index}`);
      return {
        initLines: [
          ...aggregateArgs.map((arg, index) => `${indent}  auto ${valueNames[index]} = ${arg};`),
          `${indent}  std::decay_t<decltype(${containerName})>::value_type ${tempName} = {${valueNames.join(', ')}};`,
        ],
        argsJsonExpression: `std::string("[") + tracecode::mutation_args_json(${valueNames.join(', ')}) + "]"`,
      };
    }
  }
  return {
    initLines: [`${indent}  ${cppValueTypeTempInitialization(containerName, tempName, argumentSource)}`],
    argsJsonExpression: `tracecode::mutation_args_json(${tempName})`,
  };
}

function rewritePlainContainerMutationInstrumentation(line, lineNumber, variables, aliases = new Map(), source = '') {
  if (line.includes('tracecode::')) return line;
  const stripped = stripCppStringsAndComments(line).trim();
  const statement = stripCppLineCommentPreservingStrings(line).trim();
  if (!stripped || /^(?:if|for|while|switch|return|break|continue)\b/.test(stripped)) return line;
  const indent = line.match(/^(\s*)/)?.[1] ?? '';

  const fillMatch = statement.match(/^([A-Za-z_]\w*)\s*\.\s*fill\s*\((.*)\)\s*;\s*$/);
  if (fillMatch) {
    const [, name, argsSource] = fillMatch;
    const variable = variables?.get(name);
    if (variable && (isStdArrayCppType(variable.type, aliases) || shouldEmitPlainContainerMutation(variable, name, aliases, source))) {
      const args = splitTopLevelCommaList(argsSource).filter((arg) => arg.trim());
      return [
        line,
        `${indent}tracecode::emit_container_mutate_value(${cppStringLiteral(name)}, ${name}, "fill", ${lineNumber}, tracecode::mutation_args_json(${args.join(', ')}));`,
      ].join('\n');
    }
  }

  const sortMatch = statement.match(/^(?:std::)?sort\s*\(\s*((?:this->)?([A-Za-z_]\w*))\s*\.\s*begin\s*\(\s*\)\s*,\s*\1\s*\.\s*end\s*\(\s*\)(?:\s*,\s*.*)?\)\s*;\s*$/);
  if (sortMatch) {
    const [, receiver, name] = sortMatch;
    const variable = variables?.get(name);
    if (receiver.startsWith('this->') && variable && isTraceWrappedCppType(variable.type, aliases)) {
      const indexName = `__tc_sort_index_${lineNumber}_${name}`;
      const rawName = `__tc_sort_values_${lineNumber}_${name}`;
      return [
        line,
        `${indent}${receiver}.emit_mutate("sort", ${lineNumber}, tracecode::mutation_args_json());`,
        `${indent}{ const auto& ${rawName} = ${receiver}.raw(); for (std::size_t ${indexName} = 0; ${indexName} < ${rawName}.size(); ++${indexName}) { ${receiver}.emit_write(${indexName}, ${rawName}[${indexName}], ${lineNumber}); } }`,
      ].join('\n');
    }
    if (variable && isSnapshotSerializableCppType(variable.type, aliases)) {
      return [
        line,
        `${indent}tracecode::emit_container_mutate_value(${cppStringLiteral(name)}, ${name}, "sort", ${lineNumber}, tracecode::mutation_args_json());`,
        `${indent}tracecode::emit_index_writes_value(${cppStringLiteral(name)}, ${name}, ${lineNumber});`,
      ].join('\n');
    }
  }

  const thisMethodMatch = statement.match(/^this->([A-Za-z_]\w*)\s*\.\s*(push_back|insert|erase|pop_back|clear)\s*\((.*)\)\s*;\s*$/);
  if (thisMethodMatch) {
    const [, name, method, argsSource] = thisMethodMatch;
    const variable = variables?.get(name);
    if (!variable || isSnapshotSerializableCppType(variable.type, aliases)) {
      const trimmedArgsSource = argsSource.trim();
      const args = trimmedArgsSource.startsWith('{') && trimmedArgsSource.endsWith('}')
        ? [trimmedArgsSource]
        : splitTopLevelCommaList(argsSource).map((arg) => arg.trim()).filter(Boolean);
      if ((method === 'push_back' || method === 'insert') && args.length === 1) {
        const tempName = `__tc_member_mutation_arg_${lineNumber}_${name}`;
        const capture = buildMutationArgumentCapture(`this->${name}`, tempName, args[0], indent);
        const isAssociativeInsert = method === 'insert' && variable && isAssociativeCppType(variable.type, aliases);
        const writeIndex = `tracecode::trace_container_raw_size(this->${name}) - 1`;
        const rewritten = [
          `${indent}{`,
          ...capture.initLines,
          `${indent}  this->${name}.${method}(${tempName});`,
          `${indent}  tracecode::emit_field_container_mutate_value("this", ${cppStringLiteral(name)}, this->${name}, ${cppStringLiteral(method)}, ${lineNumber}, ${capture.argsJsonExpression});`,
        ];
        if (!isAssociativeInsert) {
          rewritten.push(`${indent}  tracecode::emit_field_index_write_value("this", ${cppStringLiteral(name)}, this->${name}, ${writeIndex}, ${lineNumber}, nullptr);`);
        }
        rewritten.push(`${indent}}`);
        return rewritten.join('\n');
      }
      if (method === 'erase' && args.length === 1) {
        const iteratorArg = args[0].replace(/\s+/g, '');
        const mutationArgs = iteratorArg === `this->${name}.begin()` ? 'tracecode::mutation_args_json(0)' : 'tracecode::mutation_args_json()';
        return [
          line,
          `${indent}tracecode::emit_field_container_mutate_value("this", ${cppStringLiteral(name)}, this->${name}, ${cppStringLiteral(method)}, ${lineNumber}, ${mutationArgs});`,
        ].join('\n');
      }
      if ((method === 'pop_back' || method === 'clear') && args.length === 0) {
        return [
          line,
          `${indent}tracecode::emit_field_container_mutate_value("this", ${cppStringLiteral(name)}, this->${name}, ${cppStringLiteral(method)}, ${lineNumber}, tracecode::mutation_args_json());`,
        ].join('\n');
      }
    }
  }

  const plainMethodMatch = statement.match(/^([A-Za-z_]\w*)\s*\.\s*(push_back|insert|erase|pop_back|clear)\s*\((.*)\)\s*;\s*$/);
  if (plainMethodMatch) {
    const [, name, method, argsSource] = plainMethodMatch;
    const variable = variables?.get(name);
    if (shouldEmitPlainContainerMutation(variable, name, aliases, source)) {
      const trimmedArgsSource = argsSource.trim();
      const args = trimmedArgsSource.startsWith('{') && trimmedArgsSource.endsWith('}')
        ? [trimmedArgsSource]
        : splitTopLevelCommaList(argsSource).map((arg) => arg.trim()).filter(Boolean);
      if ((method === 'push_back' || method === 'insert') && args.length === 1) {
        const tempName = `__tc_mutation_arg_${lineNumber}_${name}`;
        const capture = buildMutationArgumentCapture(name, tempName, args[0], indent);
        const isAssociativeInsert = variable && method === 'insert' && isAssociativeCppType(variable.type, aliases);
        const writeIndex = `tracecode::trace_container_raw_size(${name}) - 1`;
        const rewritten = [
          `${indent}{`,
          ...capture.initLines,
          `${indent}  ${name}.${method}(${tempName});`,
          `${indent}  tracecode::emit_container_mutate_value(${cppStringLiteral(name)}, ${name}, ${cppStringLiteral(method)}, ${lineNumber}, ${capture.argsJsonExpression});`,
        ];
        if (!isAssociativeInsert) {
          rewritten.push(`${indent}  tracecode::emit_index_write_value(${cppStringLiteral(name)}, ${name}, ${writeIndex}, ${lineNumber}, nullptr);`);
        }
        rewritten.push(`${indent}}`);
        return rewritten.join('\n');
      }
      if (method === 'erase' && args.length === 1) {
        const iteratorArg = args[0].replace(/\s+/g, '');
        const mutationArgs = iteratorArg === `${name}.begin()` ? 'tracecode::mutation_args_json(0)' : 'tracecode::mutation_args_json()';
        return [
          line,
          `${indent}tracecode::emit_container_mutate_value(${cppStringLiteral(name)}, ${name}, ${cppStringLiteral(method)}, ${lineNumber}, ${mutationArgs});`,
        ].join('\n');
      }
      if ((method === 'pop_back' || method === 'clear') && args.length === 0) {
        return [
          line,
          `${indent}tracecode::emit_container_mutate_value(${cppStringLiteral(name)}, ${name}, ${cppStringLiteral(method)}, ${lineNumber}, tracecode::mutation_args_json());`,
        ].join('\n');
      }
    }
  }

  return line;
}

function shouldEmitPlainSetLookup(variable, aliases = new Map()) {
  if (!variable || !variable.parameter || !/\bstd::/.test(variable.type || '')) return false;
  return isSetLikeCppType(variable.type, aliases);
}

function rewritePlainContainerLookupInstrumentation(line, lineNumber, variables, aliases = new Map()) {
  if (line.includes('tracecode::trace_container_find_value') ||
    line.includes('tracecode::trace_container_count_value') ||
    line.includes('tracecode::trace_container_contains_value')) return line;
  const stripped = stripCppStringsAndComments(line);
  if (!stripped.includes('.find') && !stripped.includes('.count') && !stripped.includes('.contains')) return line;
  const candidateNames = [...(variables || []).entries()]
    .filter(([, variable]) => shouldEmitPlainSetLookup(variable, aliases))
    .map(([name]) => name)
    .sort((left, right) => right.length - left.length);
  if (candidateNames.length === 0) return line;

  let rewritten = line;
  for (const name of candidateNames) {
    let cursor = 0;
    while (cursor < rewritten.length) {
      const nameIndex = rewritten.indexOf(name, cursor);
      if (nameIndex < 0) break;
      const before = nameIndex > 0 ? rewritten[nameIndex - 1] : '';
      const beforeTwo = nameIndex >= 2 ? rewritten.slice(nameIndex - 2, nameIndex) : '';
      const afterName = rewritten[nameIndex + name.length] || '';
      if (
        /[A-Za-z0-9_]/.test(before) ||
        /[A-Za-z0-9_]/.test(afterName) ||
        before === '.' ||
        beforeTwo === '->' ||
        beforeTwo === '::' ||
        isInsideCppStringOrCharLiteral(rewritten, nameIndex)
      ) {
        cursor = nameIndex + name.length;
        continue;
      }
      let memberIndex = nameIndex + name.length;
      while (/\s/.test(rewritten[memberIndex] || '')) memberIndex += 1;
      if (rewritten[memberIndex] !== '.') {
        cursor = nameIndex + name.length;
        continue;
      }
      const methodMatch = rewritten.slice(memberIndex).match(/^\.\s*(find|count|contains)\s*\(/);
      if (!methodMatch) {
        cursor = memberIndex + 1;
        continue;
      }
      const method = methodMatch[1];
      const openIndex = memberIndex + methodMatch[0].lastIndexOf('(');
      const closeIndex = findMatchingParen(rewritten, openIndex);
      if (closeIndex < 0) break;
      const keyExpression = rewritten.slice(openIndex + 1, closeIndex).trim();
      if (!keyExpression) {
        cursor = closeIndex + 1;
        continue;
      }
      const helper = method === 'count'
        ? 'trace_container_count_value'
        : method === 'contains'
          ? 'trace_container_contains_value'
          : 'trace_container_find_value';
      const replacement = `tracecode::${helper}(${cppStringLiteral(name)}, ${name}, ${keyExpression}, ${lineNumber}, ${cppIndexSourceForExpression(keyExpression)})`;
      rewritten = `${rewritten.slice(0, nameIndex)}${replacement}${rewritten.slice(closeIndex + 1)}`;
      cursor = nameIndex + replacement.length;
    }
  }
  return rewritten;
}

function detectMapIteratorAlias(line, variables, aliases = new Map(), scopeDepth = 0) {
  const statement = stripCppLineCommentPreservingStrings(line).trim();
  const match = statement.match(/^(?:const\s+)?(?:(?:auto)|(?:[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?(?:\s*<[^;]+>)?(?:::[A-Za-z_]\w+)?))\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\.\s*(?:find|find_with_index_source)\s*\((.*)\)\s*;\s*$/);
  if (!match) return null;
  const [, iteratorName, containerName, keySource] = match;
  const variable = variables?.get(containerName);
  if (!isKeyedIndexSourceInstrumentableVariable(variable, aliases)) return null;
  const keyExpression = splitTopLevelCommaList(keySource)[0]?.trim();
  return {
    name: iteratorName,
    containerName,
    keySource: keyExpression ? cppIndexSourceForExpression(keyExpression) : 'nullptr',
    scopeDepth,
  };
}

function rewriteMapIteratorSecondMutationInstrumentation(line, lineNumber, iteratorAliases) {
  if (line.includes('tracecode::')) return line;
  const statement = stripCppLineCommentPreservingStrings(line).trim();
  const match = statement.match(/^([A-Za-z_]\w*)\s*->\s*second\s*\.\s*(clear|pop_back)\s*\(\s*\)\s*;\s*$/);
  if (!match) return line;
  const [, iteratorName, method] = match;
  const alias = iteratorAliases?.get(iteratorName);
  if (!alias?.containerName) return line;
  const indent = line.match(/^(\s*)/)?.[1] ?? '';
  return [
    line,
    `${indent}${alias.containerName}.emit_keyed_mutate(${iteratorName}->first, ${cppStringLiteral(method)}, ${lineNumber}, tracecode::mutation_args_json(), ${alias.keySource || 'nullptr'});`,
    `${indent}${alias.containerName}.emit_snapshot(${lineNumber});`,
  ].join('\n');
}

function rewriteTraceContainerProxyReferences(line, variables, aliases = new Map()) {
  if (!/\bauto\s*&\s+[A-Za-z_]\w*\s*=/.test(line)) {
    return line;
  }
  const candidateNames = [...(variables || []).entries()]
    .filter(([, variable]) => isIndexReadInstrumentableCppType(variable.type, aliases))
    .map(([name]) => name)
    .sort((left, right) => right.length - left.length);
  if (candidateNames.length === 0) {
    return line;
  }
  const accessPattern = new RegExp(`\\b(?:${candidateNames.map(escapeRegExp).join('|')})\\s*(?:\\[[^\\]]+\\]|\\.\\s*(?:front|back)\\s*\\()`);
  if (!accessPattern.test(line)) {
    return line;
  }
  return line.replace(/\bauto\s*&(\s+[A-Za-z_]\w*\s*=)/, 'auto$1');
}

function rewriteTraceContainerAliasNames(line, lineNumber, variables, aliases = new Map()) {
  const match = line.match(/^(\s*)(?:const\s+)?auto\s*&\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*;\s*$/);
  if (!match) return line;
  const [, indent, aliasName, sourceName] = match;
  const sourceVariable = variables?.get(sourceName);
  if (!sourceVariable || !isIndexReadInstrumentableCppType(sourceVariable.type, aliases)) {
    return line;
  }
  return `${indent}auto __tc_trace_name_scope_${aliasName}_${lineNumber} = tracecode::scoped_trace_name(${sourceName}, ${cppStringLiteral(aliasName)});\n${line}`;
}

function rewriteTraceMutatingCallLineScope(line, lineNumber) {
  if (line.includes('tracecode::with_trace_line')) return line;
  const match = line.match(/^(\s*)(.+\.(?:assign|push_back|emplace_back|push|emplace|insert|erase|clear|pop|pop_back|pop_front)\s*\(.*\)\s*;)\s*$/);
  if (!match) return line;
  const [, indent, statement] = match;
  if (/^\s*(?:if|for|while|switch|return)\b/.test(statement)) return line;
  if (/^\s*(?:const\s+)?(?:auto|[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?(?:\s*<[^;]+>)?(?:\s*[*&])?)\s+[A-Za-z_]\w*\s*=/.test(statement)) return line;
  if (/^[^;=]+=[^=]/.test(statement)) return line;
  return `${indent}tracecode::with_scoped_trace_line(${lineNumber}, [&]() { ${statement.trim()} });`;
}

function rewriteScalarWriteInstrumentation(line, lineNumber, variables) {
  const stripped = stripCppStringsAndComments(line).trim();
  if (!stripped) return line;

  const forDeclaration = line.match(/^(\s*)for\s*\(\s*(?:const\s+)?(?:[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?(?:\s*<[^;]+>)?(?:\s*[*&])?)\s+([A-Za-z_]\w*)\s*=([^;]+);.*\)\s*\{\s*$/);
  if (forDeclaration && variables?.has(forDeclaration[2])) {
    return `${line}\n${buildScalarWriteInstrumentation(forDeclaration[2], lineNumber, `${forDeclaration[1]}  `)}`;
  }

  if (/^(?:if|for|while|switch|return|break|continue)\b/.test(stripped)) return line;

  const assignment = line.match(/^(\s*)([A-Za-z_]\w*)\s*(?:[+\-*/%]?=)\s*.+;\s*$/);
  if (assignment && variables?.has(assignment[2])) {
    return `${line}\n${buildScalarWriteInstrumentation(assignment[2], lineNumber, assignment[1])}`;
  }

  const postfix = line.match(/^(\s*)([A-Za-z_]\w*)\s*(?:\+\+|--)\s*;\s*$/);
  if (postfix && variables?.has(postfix[2])) {
    return `${line}\n${buildScalarWriteInstrumentation(postfix[2], lineNumber, postfix[1])}`;
  }

  const prefix = line.match(/^(\s*)(?:\+\+|--)\s*([A-Za-z_]\w*)\s*;\s*$/);
  if (prefix && variables?.has(prefix[2])) {
    return `${line}\n${buildScalarWriteInstrumentation(prefix[2], lineNumber, prefix[1])}`;
  }

  const updateNames = [];
  const seenUpdateNames = new Set();
  const updatePattern = /(?:\+\+|--)\s*([A-Za-z_]\w*)|\b([A-Za-z_]\w*)\s*(?:\+\+|--)/g;
  for (const match of stripped.matchAll(updatePattern)) {
    const name = match[1] || match[2];
    if (!name || !variables?.has(name) || seenUpdateNames.has(name)) continue;
    seenUpdateNames.add(name);
    updateNames.push(name);
  }
  if (updateNames.length > 0) {
    const indent = line.match(/^(\s*)/)?.[1] ?? '';
    return [
      line,
      ...updateNames.map((name) => buildScalarWriteInstrumentation(name, lineNumber, indent)),
    ].join('\n');
  }

  return line;
}

function findContainerDeclarationSemicolon(lines, startIndex) {
  let candidate = '';
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    candidate += `${index === startIndex ? '' : '\n'}${line}`;
    for (const ch of stripCppStringsAndComments(line)) {
      if (ch === '<' || ch === '(' || ch === '{' || ch === '[') depth += 1;
      if (ch === '>' || ch === ')' || ch === '}' || ch === ']') depth -= 1;
      if (ch === ';' && depth <= 0) return { text: candidate, endIndex: index };
    }
  }
  return null;
}

function rewriteTraceMultipleContainerLocals(line, lineNumber, aliases = new Map(), source = '') {
  const collapsed = stripCppLineCommentPreservingStrings(line).replace(/\s*\n\s*/g, ' ');
  const match = collapsed.match(/^(\s*)((?:(?:std::)?(?:vector|deque|queue|priority_queue|stack|unordered_map|map|unordered_set|set)\s*<.+>|[A-Za-z_]\w*))\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)+)\s*;\s*$/);
  if (!match) return line;
  const [, indent, declaredType, namesSource] = match;
  if (!isTraceWrappedCppType(declaredType, aliases)) return line;
  if (
    hasContainerMappedValueCppType(declaredType, aliases) &&
    namesSource.split(',').some((name) => hasAutoReferenceBindingForMapProxy(source, name.trim()))
  ) return line;
  const type = cppTraceType(declaredType, aliases);
  return namesSource
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => `${indent}${type} ${name}(${cppStringLiteral(name)}, ${lineNumber});`)
    .join('\n');
}

function localVectorStringFeedsTraceWrappedParameter(source, name, aliases = new Map()) {
  const signatures = parseCppFunctionSignatures(source);
  for (const signature of signatures) {
    for (const [index, parameter] of signature.parameters.entries()) {
      if (/\bconst\b/.test(parameter.type)) continue;
      if (parameterAddressEscapes(source, parameter.name)) continue;
      if (normalizeCppType(parameter.type, aliases) !== 'vector<string>') continue;
      const callPattern = new RegExp(`\\b${escapeRegExp(signature.name)}\\s*\\(`, 'g');
      let match;
      while ((match = callPattern.exec(source))) {
        const openParenIndex = source.indexOf('(', match.index);
        const closeParenIndex = findMatchingParen(source, openParenIndex);
        if (closeParenIndex < 0) continue;
        const args = splitTopLevelCommaList(source.slice(openParenIndex + 1, closeParenIndex));
        if (args[index]?.trim() === name) return true;
        callPattern.lastIndex = closeParenIndex + 1;
      }
    }
  }
  return false;
}

function localNestedVectorUsedInMinMaxInitializerList(source, name) {
  const escapedName = escapeRegExp(name);
  const pattern = new RegExp(`\\b(?:std::)?(?:min|max)\\s*\\(\\s*\\{[^}]*\\b${escapedName}\\s*\\[`, 's');
  return pattern.test(stripComments(source || ''));
}

function localDequeUsedWithStructuredFrontBackBinding(source, name) {
  const escapedName = escapeRegExp(name);
  const pattern = new RegExp(`\\bauto\\s*\\[[^\\]]+\\]\\s*=\\s*${escapedName}\\s*\\.\\s*(?:front|back)\\s*\\(`);
  return pattern.test(stripComments(source || ''));
}

function rewriteTraceContainerLocal(line, lineNumber, aliases = new Map(), source = '') {
  const collapsed = stripCppLineCommentPreservingStrings(line).replace(/\s*\n\s*/g, ' ');
  const multiple = rewriteTraceMultipleContainerLocals(collapsed, lineNumber, aliases, source);
  if (multiple !== collapsed) return multiple;
  const declarationParts = collapsed.match(/^(\s*)((?:(?:std::)?(?:vector|deque|queue|priority_queue|stack|unordered_map|map|unordered_set|set)\s*<.+>|[A-Za-z_]\w*))\s+(.+);\s*$/);
  if (declarationParts && splitTopLevelCommaList(declarationParts[3]).length > 1) return line;
  let match = collapsed.match(/^(\s*)((?:(?:std::)?(?:vector|deque|queue|priority_queue|stack|unordered_map|map|unordered_set|set)\s*<.+>|[A-Za-z_]\w*))\s+([A-Za-z_]\w*)\s*(?:\((.*)\)|=\s*(.+)|(\{.*\}))?\s*;\s*$/);
  if (!match) return line;
  const [, indent, declaredType, name, constructorArgs, assignedValue, bracedValue] = match;
  if (!isTraceWrappedCppType(declaredType, aliases)) return line;
  if (
    normalizeCppType(declaredType, aliases) === 'vector<string>' &&
    !localVectorStringFeedsTraceWrappedParameter(source, name, aliases)
  ) return line;
  if (
    normalizeCppType(declaredType, aliases).startsWith('vector<vector<') &&
    localNestedVectorUsedInMinMaxInitializerList(source, name)
  ) return line;
  if (
    normalizeCppType(declaredType, aliases).startsWith('deque<') &&
    localDequeUsedWithStructuredFrontBackBinding(source, name)
  ) return line;
  if (hasUnsafeMapProxyAutoReferenceBinding(declaredType, source, name, aliases)) return line;
  const normalized = normalizeCppType(declaredType, aliases);
  const kind = normalized.slice(0, normalized.indexOf('<'));
  const initializerType = resolveCppType(declaredType, aliases)
    .replace(/\bconst\b/g, '')
    .replace(/[&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const initializer = constructorArgs ? `${initializerType}(${constructorArgs})` : assignedValue || bracedValue;
  const traceInitializer = bracedValue && (kind === 'set' || kind === 'unordered_set')
    ? `${initializerType}${bracedValue}`
    : initializer;
  const type = cppTraceType(declaredType, aliases);
  if (kind === 'priority_queue' && constructorArgs && constructorArgs.trim()) {
    return `${indent}${type} ${name}(${constructorArgs.trim()}, ${cppStringLiteral(name)}, ${lineNumber});`;
  }
  if ((kind === 'queue' || kind === 'priority_queue' || kind === 'stack') && traceInitializer && traceInitializer.trim() !== '{}') {
    return line;
  }
  if (!traceInitializer || traceInitializer.trim() === '{}') {
    return `${indent}${type} ${name}(${cppStringLiteral(name)}, ${lineNumber});`;
  }
  return `${indent}${type} ${name}(${traceInitializer.trim()}, ${cppStringLiteral(name)}, ${lineNumber});`;
}

function rewriteTraceContainerMember(line, lineNumber, aliases = new Map(), activeClassName = null, traceMemberClassName = null) {
  if (!activeClassName || activeClassName !== traceMemberClassName) return line;
  const collapsed = stripCppLineCommentPreservingStrings(line).replace(/\s*\n\s*/g, ' ');
  const match = collapsed.match(/^(\s*)((?:(?:std::)?(?:vector|deque|queue|priority_queue|stack|unordered_map|map|unordered_set|set)\s*<.+>|[A-Za-z_]\w*))\s+([A-Za-z_]\w*)\s*(?:=\s*(.+)|(\{.*\}))?\s*;\s*$/);
  if (!match) return line;
  const [, indent, declaredType, name, assignedValue, bracedValue] = match;
  if (!isTraceWrappedCppType(declaredType, aliases)) return line;
  const normalized = normalizeCppType(declaredType, aliases);
  const kind = normalized.slice(0, normalized.indexOf('<'));
  if (
    kind !== 'vector' &&
    kind !== 'deque' &&
    kind !== 'queue' &&
    kind !== 'priority_queue' &&
    kind !== 'stack' &&
    kind !== 'unordered_map' &&
    kind !== 'map' &&
    kind !== 'set' &&
    kind !== 'unordered_set'
  ) return line;
  const initializerType = resolveCppType(declaredType, aliases)
    .replace(/\bconst\b/g, '')
    .replace(/[&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const initializer = assignedValue || bracedValue;
  const type = cppTraceType(declaredType, aliases);
  if (!initializer || initializer.trim() === '{}') {
    return `${indent}${type} ${name}{${cppStringLiteral('this')}, ${cppStringLiteral(name)}, ${lineNumber}};`;
  }
  return `${indent}${type} ${name}{${initializerType}(${initializer.trim()}), ${cppStringLiteral('this')}, ${cppStringLiteral(name)}, ${lineNumber}};`;
}

function getOpsClassInputs(inputs = {}) {
  const operations = Array.isArray(inputs.operations)
    ? inputs.operations
    : Array.isArray(inputs.ops)
      ? inputs.ops
      : null;
  const argumentsList = Array.isArray(inputs.arguments)
    ? inputs.arguments
    : Array.isArray(inputs.args)
      ? inputs.args
      : null;
  if (!operations || !argumentsList) {
    throw new Error('C++ ops-class execution requires inputs.operations and inputs.arguments (or ops/args).');
  }
  if (operations.length !== argumentsList.length) {
    throw new Error('C++ ops-class operations and arguments must have the same length.');
  }
  return { operations, argumentsList };
}

function normalizeOpsArguments(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function buildOpsClassDriverSource(userCode, className, inputs, options = {}) {
  userCode = normalizeCppUserSource(userCode, options);
  const aliases = collectCppTypeAliases(userCode);
  const { operations, argumentsList } = getOpsClassInputs(inputs || {});
  let firstOperationIndex = 1;
  let constructorArgumentIndex = 0;
  if (operations[0] === '__init__') {
    firstOperationIndex = 1;
    constructorArgumentIndex = 0;
  } else if (operations[0] === className) {
    firstOperationIndex = 1;
    constructorArgumentIndex = 0;
  } else if (operations.length > 0) {
    firstOperationIndex = 0;
    constructorArgumentIndex = -1;
  } else {
    throw new Error(`C++ ops-class inputs must start with constructor operation "${className}".`);
  }

  const firstMethod = operations.slice(firstOperationIndex).find((operation) => typeof operation === 'string' && operation.trim());
  const firstMethodForTracing = firstMethod ? resolveCppObjectMethodMacro(userCode, firstMethod) : firstMethod;
  const sourceForDriver = options.tracing === true && firstMethod
    ? instrumentCppSourceForTracing(userCode, firstMethodForTracing, { traceMemberClassName: className })
    : userCode;
  const lines = [];
  const constructorArgs = constructorArgumentIndex >= 0 ? normalizeOpsArguments(argumentsList[constructorArgumentIndex]) : [];
  const constructorSignature = parseConstructorSignature(userCode, className, aliases, {
    parameterCount: constructorArgs.length,
  });
  if (constructorArgs.length !== constructorSignature.parameters.length) {
    throw new Error(`C++ ops-class constructor "${className}" expected ${constructorSignature.parameters.length} args, received ${constructorArgs.length}.`);
  }
  lines.push(`  ${configureTraceBudgetCall(options)}`);
  const constructorArgNames = constructorArgs.map((value, index) => {
    const localName = `__tc_ctor_arg_${index}`;
    const type = localCppType(constructorSignature.parameters[index].type);
    lines.push(`  ${type} ${localName} = ${toCppLiteral(value, constructorSignature.parameters[index].type, aliases)};`);
    return localName;
  });
  const constructorArgsSource = constructorArgNames.join(', ');
  lines.push(constructorArgs.length === 0
    ? `  ${className} __tc_instance;`
    : `  ${className} __tc_instance(${constructorArgsSource});`);
  lines.push('  std::vector<std::string> __tc_outputs;');
  if (constructorArgumentIndex >= 0) {
    lines.push('  __tc_outputs.push_back("null");');
  }

  for (let index = firstOperationIndex; index < operations.length; index += 1) {
    const operation = operations[index];
    if (typeof operation !== 'string' || !operation.trim()) {
      throw new Error(`C++ ops-class operation at index ${index} must be a method name.`);
    }
    const signatureOperation = resolveCppObjectMethodMacro(userCode, operation);
    const signature = parseMethodSignature(userCode, signatureOperation);
    const args = normalizeOpsArguments(argumentsList[index]);
    if (args.length !== signature.parameters.length) {
      throw new Error(`C++ ops-class method "${operation}" expected ${signature.parameters.length} args, received ${args.length}.`);
    }
    const argNames = [];
    signature.parameters.forEach((parameter, argIndex) => {
      const localName = `__tc_op_${index}_arg_${argIndex}`;
      const shouldTraceParameter = options.tracing === true && shouldTraceWrapCppParameter(parameter, signature, aliases, userCode);
      const declarationType = shouldTraceParameter
        ? cppTraceType(parameter.type, aliases)
        : localCppType(parameter.type);
      const value = args[argIndex];
      if (shouldTraceParameter) {
        lines.push(`  ${declarationType} ${localName}(${materializedCppType(parameter.type, aliases)}(${toCppLiteral(value, parameter.type, aliases)}), ${cppStringLiteral(parameter.name)}, ${signature.line});`);
      } else {
        lines.push(`  ${declarationType} ${localName} = ${toCppLiteral(value, parameter.type, aliases)};`);
      }
      argNames.push(localName);
    });
    if (options.tracing === true) {
      const callEventPrefix = `{"kind":"call","line":${signature.line},"function":${jsonStringLiteral(operation)},"args":`;
      lines.push(`  std::string __tc_args_json_${index} = std::string("{") + ${buildTraceArgsJsonExpression(signature, (_parameter, argIndex) => `__tc_op_${index}_arg_${argIndex}`, aliases)} + "}";`);
      lines.push(`  tracecode::write_trace_event_json(std::string(${cppStringLiteral(callEventPrefix)}) + __tc_args_json_${index} + "}", ${signature.line});`);
    }
    if (normalizeCppType(signature.returnType, aliases) === 'void' || isNullCppReturnType(signature.returnType, aliases)) {
      lines.push(`  __tc_instance.${signatureOperation}(${argNames.join(', ')});`);
      lines.push('  __tc_outputs.push_back("null");');
    } else {
      lines.push(`  auto __tc_op_${index}_result = __tc_instance.${signatureOperation}(${argNames.join(', ')});`);
      lines.push(`  __tc_outputs.push_back(tracecode::to_json(__tc_op_${index}_result));`);
    }
  }
  lines.push('  std::string __tc_result_json = "[";');
  lines.push('  for (std::size_t __tc_i = 0; __tc_i < __tc_outputs.size(); ++__tc_i) {');
  lines.push('    if (__tc_i > 0) __tc_result_json += ",";');
  lines.push('    __tc_result_json += __tc_outputs[__tc_i];');
  lines.push('  }');
  lines.push('  __tc_result_json += "]";');
  lines.push('  tracecode::write_result_json_raw(__tc_result_json);');

return `${buildGeneratedIncludes(userCode, { parameters: [] })}
using namespace std;
${buildTracecodeFallbackAliases(userCode)}

#line 1 "${CPP_USER_SOURCE_FILE}"
${sourceForDriver}

#line 1 "TraceCodeDriver.cpp"
int main() {
${lines.join('\n')}
  return 0;
}
`;
}

function inferAutoSnapshotVariableType(initializer, knownVariables, aliases = new Map()) {
  const expression = stripCppStringsAndComments(initializer).trim();
  const directVariableMatch = expression.match(/^([A-Za-z_]\w*)$/);
  if (directVariableMatch && knownVariables?.has(directVariableMatch[1])) {
    const type = knownVariables.get(directVariableMatch[1])?.type || '';
    return isSnapshotSerializableCppType(type, aliases) ? type : null;
  }
  if (/^(?:true|false)$/.test(expression)) return 'bool';
  if (/^"(?:\\.|[^"\\])*"$/.test(expression)) return 'string';
  if (/^[+-]?\d+$/.test(expression)) return 'long long';
  if (/^[+-]?(?:(?:\d+\.\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(expression)) return 'double';
  return null;
}

function extractDeclaredSnapshotVariables(line, aliases = new Map(), knownVariables = null) {
  const variables = [];
  const collapsed = stripCppLineCommentPreservingStrings(line).replace(/\s*\n\s*/g, ' ').trim();
  if (!collapsed || collapsed.startsWith('//')) return variables;

  const rangeMatch = collapsed.match(/^(?:for)\s*\(\s*([^;]+?[*&]*)\s+[*&]*\s*([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)\s*\)/);
  if (rangeMatch) {
    if (!collapsed.includes('{')) return variables;
    const [, type, name, rangeName] = rangeMatch;
    const normalizedType = normalizeCppType(type, aliases);
    const normalizedAutoType = normalizedType
      .replace(/\bconst\b/g, '')
      .replace(/[&*]/g, '')
      .trim();
    const inferredType = normalizedAutoType === 'auto'
      ? rangeForElementSnapshotType(rangeName, knownVariables, aliases)
      : null;
    const snapshotType = inferredType ?? type;
    if (isSnapshotSerializableCppType(snapshotType, aliases)) variables.push({ name, type: snapshotType, sameLineVisible: true });
    return variables;
  }

  const structuredRangeMatch = collapsed.match(/^(?:for)\s*\(\s*[^:;]+?\[\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*|_)\s*\]\s*:\s*([A-Za-z_]\w*)\s*\)/);
  if (structuredRangeMatch) {
    if (!collapsed.includes('{')) return variables;
    const [, keyName, valueName, rangeName] = structuredRangeMatch;
    const rangeType = knownVariables?.get(rangeName)?.type;
    const mapTypes = rangeType ? mapKeyValueCppTypes(rangeType, aliases) : null;
    if (mapTypes) {
      if (keyName !== '_' && isSnapshotSerializableCppType(mapTypes.keyType, aliases)) {
        variables.push({ name: keyName, type: mapTypes.keyType, sameLineVisible: true });
      }
      if (valueName !== '_' && isSnapshotSerializableCppType(mapTypes.valueType, aliases)) {
        variables.push({ name: valueName, type: mapTypes.valueType, sameLineVisible: true });
      }
    }
    return variables;
  }

  const forInitMatch = collapsed.match(/^for\s*\(\s*([^;]+);/);
  if (forInitMatch) {
    if (!collapsed.includes('{')) return variables;
    variables.push(...extractDeclaredSnapshotVariables(`${forInitMatch[1]};`, aliases, knownVariables).map((variable) => ({
      ...variable,
      sameLineVisible: true,
    })));
    return variables;
  }

  const scalarDeclarationMatch = collapsed.match(/^((?:(?:const|unsigned|long|short|signed)\s+)*(?:bool|char|int|long|float|double|string|size_t|std::size_t)(?:\s*[*&])?)\s+(.+);\s*$/);
  const declarationMatch = scalarDeclarationMatch ?? collapsed.match(/^((?:(?:const|unsigned|long|short|signed)\s+)*(?:(?:std::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?(?:\s*<.+>)?(?:\s*[*&])?))\s+(.+);\s*$/);
  if (!declarationMatch) return variables;
  const [, rawType, declaratorsSource] = declarationMatch;
  const rawTypeSerializable = isSnapshotSerializableCppType(rawType, aliases);
  const rawTypeIsAuto = normalizeCppType(rawType, aliases) === 'auto';
  if (!rawTypeSerializable && !rawTypeIsAuto) return variables;
  for (const declarator of splitTopLevelCommaList(declaratorsSource)) {
    const trimmedDeclarator = declarator.trim();
    const nameMatch = trimmedDeclarator.match(/^([A-Za-z_]\w*)\b/);
    const rawArrayDeclarator = nameMatch
      ? new RegExp(`^${escapeRegExp(nameMatch[1])}\\s*\\[`).test(trimmedDeclarator)
      : false;
    const variableType = rawTypeSerializable
      ? rawArrayDeclarator
        ? `array<${rawType}>`
        : rawType
      : inferAutoSnapshotVariableType(trimmedDeclarator.replace(/^([A-Za-z_]\w*)\s*=\s*/, ''), knownVariables, aliases);
    if (nameMatch) {
      if (!variableType) continue;
      variables.push({
        name: nameMatch[1],
        type: variableType,
        sameLineVisible: true,
      });
    }
  }
  return variables;
}

function extractMultilineStatementStartDeclaredSnapshotVariables(line, aliases = new Map(), knownVariables = null) {
  const collapsed = stripCppLineCommentPreservingStrings(line).replace(/\s*\n\s*/g, ' ').trim();
  if (!collapsed || /;\s*$/.test(collapsed)) return [];
  return extractDeclaredSnapshotVariables(`${collapsed};`, aliases, knownVariables);
}

function instrumentCppSourceForTracing(source, functionName, options = {}) {
  const aliases = collectCppTypeAliases(source);
  const traceMemberNames = collectTraceContainerMemberNames(source, aliases, options.traceMemberClassName || 'Solution');
  const traceMemberVariables = collectTraceContainerMemberVariables(source, aliases, options.traceMemberClassName || 'Solution');
  const serializableMemberVariables = collectSerializableMemberVariables(source, aliases, options.traceMemberClassName || 'Solution');
  const targetSignature = parseMethodSignature(source, functionName);
  const skipTraceParameterNames = new Set(
    targetSignature.parameters
      .filter((parameter) => parameterAddressEscapes(source, parameter.name))
      .map((parameter) => parameter.name)
  );
  targetSignature.skipTraceParameterNames = skipTraceParameterNames;
  const signatures = parseCppFunctionSignatures(source);
  for (const signature of signatures) {
    signature.customJsonReturn = sourceDeclaresCustomToJson(source, signature.returnType);
    if (/^(?:destroy|free|cleanup|deleteTree|deleteList)$/i.test(signature.name)) {
      signature.skipInstrumentation = true;
    }
    signature.skipTraceParameterNames = new Set(
      signature.parameters
        .filter((parameter) => parameterAddressEscapes(source, parameter.name))
        .map((parameter) => parameter.name)
    );
  }
  targetSignature.customJsonReturn = sourceDeclaresCustomToJson(source, targetSignature.returnType);
  if (options.traceMemberClassName) {
    const constructorSignature = parseConstructorSignature(source, options.traceMemberClassName, aliases);
    if (
      constructorSignature &&
      !signatures.some((signature) => signature.line === constructorSignature.line && signature.name === options.traceMemberClassName)
    ) {
      signatures.push({
        ...constructorSignature,
        name: options.traceMemberClassName,
        bodyLine: constructorSignature.line,
        customJsonReturn: false,
        skipTraceParameterNames: new Set(),
        skipScopedTraceNames: true,
      });
      signatures.sort((left, right) => left.line - right.line || left.bodyLine - right.bodyLine);
    }
    const sourceLines = source.split(/\r?\n/);
    for (const className of collectCppDeclaredClassNames(source)) {
      if (className === options.traceMemberClassName) continue;
      const helperConstructorSignature = parseConstructorSignature(source, className, aliases);
      if (!helperConstructorSignature) continue;
      const constructorLine = sourceLines[helperConstructorSignature.line - 1] || '';
      if (!new RegExp(`\\b${escapeRegExp(className)}\\s*\\(`).test(stripCppStringsAndComments(constructorLine))) continue;
      if (signatures.some((signature) => signature.line === helperConstructorSignature.line && signature.name === className)) continue;
      signatures.push({
        ...helperConstructorSignature,
        name: className,
        bodyLine: helperConstructorSignature.line,
        customJsonReturn: false,
        skipTraceParameterNames: new Set(),
        skipScopedTraceNames: true,
      });
    }
    signatures.sort((left, right) => left.line - right.line || left.bodyLine - right.bodyLine);
  }
  if (functionName === CPP_SCRIPT_FUNCTION_NAME) {
    const sourceLines = source.split(/\r?\n/);
    for (const className of collectCppDeclaredClassNames(source)) {
      const constructorSignature = parseConstructorSignature(source, className, aliases);
      const constructorLine = sourceLines[constructorSignature.line - 1] || '';
      if (!new RegExp(`\\b${escapeRegExp(className)}\\s*\\(`).test(stripCppStringsAndComments(constructorLine))) continue;
      if (signatures.some((signature) => signature.line === constructorSignature.line && signature.name === className)) continue;
      signatures.push({
        ...constructorSignature,
        name: className,
        bodyLine: constructorSignature.line,
        customJsonReturn: false,
        skipTraceParameterNames: new Set(),
        skipScopedTraceNames: true,
      });
    }
    signatures.sort((left, right) => left.line - right.line || left.bodyLine - right.bodyLine);
  }
  if (!signatures.some((signature) => signature.line === targetSignature.line && signature.name === functionName)) {
    signatures.push({
      ...targetSignature,
      name: functionName,
      bodyLine: targetSignature.line,
    });
    signatures.sort((left, right) => left.line - right.line || left.bodyLine - right.bodyLine);
  }
  const callSiteNames = new Set(
    signatures
      .filter((signature) => !signature.skipInstrumentation && signature.name && !signature.name.startsWith('<'))
      .map((signature) => signature.name)
  );
  const lines = source.split(/\r?\n/);
  const output = [];
  let nextSignatureIndex = 0;
  let pendingSignature = null;
  const frameStack = [];
  const classStack = [];
  let multilineControlConditionDepth = 0;
  let multilineStatementDepth = 0;
  let multilineStatementContinuation = false;
  let localLambdaDepth = 0;
  let pendingLocalLambdaBody = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const activeFrame = frameStack.at(-1) || null;
    const activeSignature = activeFrame?.signature || null;
    const skipActiveInstrumentation = Boolean(activeSignature?.skipInstrumentation);
    const activeClassName = classStack.at(-1)?.name || null;
    const scriptWrapperFrame = activeSignature?.name === CPP_SCRIPT_FUNCTION_NAME;
    const classDeclarationLine = Boolean(activeFrame) && /\b(?:class|struct)\s+[A-Za-z_]\w*\b/.test(stripCppStringsAndComments(line));
    const localClassDeclarationLine = classDeclarationLine && !scriptWrapperFrame;
    const scriptWrapperClassScope = scriptWrapperFrame && (classDeclarationLine || classStack.some((entry) => entry.scriptWrapperLocal));
    const insideLocalClassDeclaration = Boolean(activeFrame) && (
      classStack.some((entry) => entry.local) ||
      localClassDeclarationLine ||
      scriptWrapperClassScope
    );
    if (!pendingSignature && nextSignatureIndex < signatures.length && lineNumber >= signatures[nextSignatureIndex].line) {
      pendingSignature = signatures[nextSignatureIndex];
      nextSignatureIndex += 1;
    }

    const inFunctionBodyBeforeLine = Boolean(activeFrame) && activeFrame.depth > 0 && !insideLocalClassDeclaration;
    const trimmedLine = line.trim();
    const strippedLine = stripCppStringsAndComments(line);
    const strippedTrimmedLine = strippedLine.trim();
    const nextSourceLine = lines[index + 1]?.trim() || '';
    const nextStrippedLine = stripCppStringsAndComments(lines[index + 1] || '').trim();
    if (activeFrame && /^}\s*else\b/.test(trimmedLine)) {
      for (const [name, variable] of activeFrame.variables) {
        if (variable.scopeDepth >= activeFrame.depth) activeFrame.variables.delete(name);
      }
    }
    const lineStartsElse = /^else\b/.test(trimmedLine);
    const insideLocalLambdaBody = localLambdaDepth > 0;
    const includeSnapshotsForActiveFrame = shouldEmitCppFrameSnapshots(activeSignature, insideLocalLambdaBody);
    const startsLocalLambdaBody =
      inFunctionBodyBeforeLine &&
      (
        /\b(?:auto|(?:std::)?function\s*<[^=;]+>)\s+[A-Za-z_]\w*\s*=\s*\[[^\]]*\]\s*\([^)]*\)\s*(?:->\s*[^{]+)?\{/.test(strippedLine) ||
        /\[[^\]]*\]\s*\([^)]*\)\s*(?:->\s*[^{]+)?\s*\{/.test(strippedLine) ||
        (pendingLocalLambdaBody && startsCppLocalLambdaBodyLine(line))
      );
    const unbracedControlHeaderLine = isUnbracedControlHeader(line, lines[index + 1] || '');
    const unbracedControlBodyLine = index > 0 && isUnbracedControlHeader(lines[index - 1] || '', line);
    const lineParenDelta = parenDeltaForLine(line);
    const startsMultilineControlCondition =
      inFunctionBodyBeforeLine &&
      multilineControlConditionDepth === 0 &&
      /^\s*(?:if|else\s+if|while|for|switch)\s*\(/.test(stripCppStringsAndComments(line)) &&
      lineParenDelta > 0;
    const startsContinuationStatement =
      inFunctionBodyBeforeLine &&
      multilineStatementDepth === 0 &&
      !multilineStatementContinuation &&
      !startsMultilineControlCondition &&
      !/[;{}]\s*$/.test(strippedTrimmedLine) &&
      (
        /(?:,|\+|-|\*|\/|%|&&|\|\||\?|:)\s*$/.test(strippedTrimmedLine) ||
        /^(?:return\b|[\w:<>,\s*&*]+\s+[A-Za-z_]\w*\s*[=({]|(?:std::)?priority_queue\s*<)/.test(strippedTrimmedLine) ||
        /^(?:,|\+|-|\*|\/|%|&&|\|\||\?|:)/.test(nextStrippedLine)
      );
    const inMultilineControlCondition =
      inFunctionBodyBeforeLine && (multilineControlConditionDepth > 0 || startsMultilineControlCondition);
    const startsMultilineStatement =
      inFunctionBodyBeforeLine &&
      multilineStatementDepth === 0 &&
      multilineControlConditionDepth === 0 &&
      !multilineStatementContinuation &&
      !startsMultilineControlCondition &&
      (lineParenDelta > 0 || startsContinuationStatement) &&
      !/;\s*$/.test(stripCppStringsAndComments(line).trim());
    const inMultilineStatement =
      inFunctionBodyBeforeLine && (multilineStatementDepth > 0 || multilineStatementContinuation || startsMultilineStatement);
    const shouldInstrumentLine = inFunctionBodyBeforeLine &&
      !skipActiveInstrumentation &&
      !unbracedControlBodyLine &&
      !inMultilineControlCondition &&
      !inMultilineStatement &&
      !lineStartsElse &&
      shouldInstrumentCppLine(line);
    const shouldAnchorMultilineStatement =
      startsMultilineStatement &&
      (
        shouldInstrumentCppLine(line) ||
        (!strippedTrimmedLine.startsWith('{') && strippedTrimmedLine.includes('='))
      );
    const shouldAnchorMultilineLambdaBodyLine =
      inMultilineStatement &&
      insideLocalLambdaBody &&
      !strippedTrimmedLine.startsWith('}') &&
      shouldInstrumentCppLine(line);
    if (shouldInstrumentLine || startsMultilineControlCondition || shouldAnchorMultilineStatement || shouldAnchorMultilineLambdaBodyLine) {
      output.push(`#line ${lineNumber} "${CPP_USER_SOURCE_FILE}"`);
      output.push(buildCurrentLineInstrumentation(lineNumber));
      if (shouldInstrumentLine && isCppControlHeaderLine(line)) {
        output.push(buildLineInstrumentation(lineNumber, activeSignature.name));
      } else if (shouldAnchorMultilineStatement) {
        output.push(buildLineInstrumentation(lineNumber, activeSignature.name));
      }
    }

    if (
      startsMultilineStatement &&
      inFunctionBodyBeforeLine &&
      activeFrame &&
      !skipActiveInstrumentation &&
      !insideLocalClassDeclaration &&
      (!insideLocalLambdaBody || activeSignature?.lambda)
    ) {
      const lineDelta = braceDeltaForLine(line);
      const declaredScopeDepth = activeFrame.depth + Math.max(0, lineDelta);
      for (const variable of extractMultilineStatementStartDeclaredSnapshotVariables(line, aliases, activeFrame.variables)) {
        activeFrame.variables.set(variable.name, {
          type: variable.type,
          scopeDepth: declaredScopeDepth,
          declarationLine: lineNumber,
          sameLineVisible: false,
        });
      }
    }

    const shouldRewriteTraceParameters = pendingSignature
      ? shouldRewriteTraceContainerParametersForSignature(pendingSignature, functionName, options)
      : false;
    let lineForDriver = shouldRewriteTraceParameters
      ? rewriteTraceContainerParameters(line, pendingSignature, aliases, source)
      : line;
    lineForDriver = rewriteCppStdFunctionTraceTypes(lineForDriver, aliases);
    if (pendingSignature && !shouldRewriteTraceParameters) {
      lineForDriver = line;
    }
    if (inFunctionBodyBeforeLine && !skipActiveInstrumentation && !unbracedControlHeaderLine && !unbracedControlBodyLine && !inMultilineControlCondition && !inMultilineStatement) {
      const declaration = findContainerDeclarationSemicolon(lines, index);
      if (strippedTrimmedLine && declaration) {
        let rewrittenDeclaration = rewriteTraceContainerLocal(declaration.text, lineNumber, aliases, source);
        if (rewrittenDeclaration !== declaration.text) {
          const callSiteRewrittenDeclaration = activeSignature.name === CPP_SCRIPT_FUNCTION_NAME
            ? rewriteCppCallSiteExpressionLines(rewrittenDeclaration, lineNumber, activeSignature.name, callSiteNames)
            : rewrittenDeclaration;
          const declarationEmitsCallSiteLine = callSiteRewrittenDeclaration !== rewrittenDeclaration;
          rewrittenDeclaration = callSiteRewrittenDeclaration;
          output.push(`#line ${lineNumber} "${CPP_USER_SOURCE_FILE}"`);
          output.push(buildCurrentLineInstrumentation(lineNumber));
          output.push(rewrittenDeclaration);
          for (const variable of extractDeclaredSnapshotVariables(declaration.text, aliases, activeFrame.variables)) {
            activeFrame.variables.set(variable.name, {
              type: variable.type,
              scopeDepth: activeFrame.depth,
              declarationLine: lineNumber,
              sameLineVisible: Boolean(variable.sameLineVisible),
            });
          }
          if (shouldInstrumentCppLine(declaration.text)) {
            output.push(buildPostLineInstrumentation(lineNumber, activeSignature.name, activeFrame.variables, activeFrame.depth, '', includeSnapshotsForActiveFrame, !declarationEmitsCallSiteLine));
          }
          index = declaration.endIndex;
          continue;
        }
      }
      lineForDriver = rewriteTraceContainerLocal(lineForDriver, lineNumber, aliases, source);
      let lexicalAccessVariables = buildCppLexicalAccessVariables(frameStack);
      const rangeAccessVariables =
        activeClassName === (options.traceMemberClassName || 'Solution')
          ? new Map([...traceMemberVariables, ...lexicalAccessVariables])
          : lexicalAccessVariables;
      lineForDriver = rewriteRangeForIndexedReads(lineForDriver, lineNumber, rangeAccessVariables, aliases);
      const lineDelta = braceDeltaForLine(line);
      const declaredScopeDepth = activeFrame.depth + Math.max(0, lineDelta, /^\s*for\s*\(/.test(trimmedLine) ? 1 : 0);
      const postLineDepth = activeFrame.depth + Math.min(0, lineDelta);
      if (!insideLocalLambdaBody || activeSignature.lambda) {
        for (const variable of extractDeclaredSnapshotVariables(line, aliases, activeFrame.variables)) {
          activeFrame.variables.set(variable.name, {
            type: variable.type,
            scopeDepth: declaredScopeDepth,
            declarationLine: lineNumber,
            sameLineVisible: Boolean(variable.sameLineVisible),
          });
        }
        lexicalAccessVariables = buildCppLexicalAccessVariables(frameStack);
      }
      const iteratorAlias = detectMapIteratorAlias(line, lexicalAccessVariables, aliases, declaredScopeDepth);
      if (iteratorAlias) {
        activeFrame.mapIterators.set(iteratorAlias.name, iteratorAlias);
      }
      const indexedElementAlias = detectIndexedElementAlias(line, lexicalAccessVariables, aliases, declaredScopeDepth, lineNumber);
      if (indexedElementAlias) {
        activeFrame.indexedElementAliases.set(indexedElementAlias.name, indexedElementAlias);
        lineForDriver = rewriteIndexedElementAliasDeclaration(lineForDriver, indexedElementAlias);
      }
      if (/\b(?:destroy|cleanup|deleteTree|deleteList)\s*\(/i.test(trimmedLine)) {
        for (const [name, variable] of activeFrame.variables) {
          if (normalizeCppType(variable.type, aliases).includes('*')) activeFrame.variables.delete(name);
        }
      }
      const preControlLineEmitted = shouldInstrumentLine && isCppControlHeaderLine(line);
      const postLineInstrumentation = (shouldInstrumentLine || lineStartsElse)
        ? buildPostLineInstrumentation(lineNumber, activeSignature.name, activeFrame.variables, postLineDepth, '', includeSnapshotsForActiveFrame, !preControlLineEmitted)
        : '';
      let postLineHandledInline = false;
      const allowReturnInstrumentation = !(insideLocalLambdaBody && !activeSignature.lambda);
      if (allowReturnInstrumentation) {
        let rewrittenControlLine = rewriteBracedSingleLineControlReturn(lineForDriver, lineNumber, activeSignature, postLineInstrumentation);
        postLineHandledInline ||= rewrittenControlLine !== lineForDriver;
        lineForDriver = rewrittenControlLine;
        rewrittenControlLine = rewriteSingleLineControlReturn(lineForDriver, lineNumber, activeSignature, postLineInstrumentation);
        postLineHandledInline ||= rewrittenControlLine !== lineForDriver;
        lineForDriver = rewrittenControlLine;
      }
      let rewrittenControlLine;
      const preControlAccessVariables =
        activeClassName === (options.traceMemberClassName || 'Solution')
          ? new Map([...traceMemberVariables, ...lexicalAccessVariables])
          : lexicalAccessVariables;
      rewrittenControlLine = rewriteBracedSingleLineControlBody(
        lineForDriver,
        lineNumber,
        postLineInstrumentation,
        activeFrame.variables,
        preControlAccessVariables,
        aliases,
        source
      );
      postLineHandledInline ||= rewrittenControlLine !== lineForDriver;
      lineForDriver = rewrittenControlLine;
      rewrittenControlLine = rewriteSingleLineControlBody(
        lineForDriver,
        lineNumber,
        activeSignature.name,
        postLineInstrumentation,
        lineStartsElse || nextSourceLine.startsWith('else') || /^(?:for|while)\s*\(/.test(trimmedLine),
        activeFrame.variables,
        preControlAccessVariables,
        aliases,
        source
      );
      postLineHandledInline ||= rewrittenControlLine !== lineForDriver;
      lineForDriver = rewrittenControlLine;
      lineForDriver = rewriteControlTransferInstrumentation(lineForDriver, lineNumber, postLineInstrumentation);
      lineForDriver = rewriteFieldWriteInstrumentation(lineForDriver, lineNumber);
      if (allowReturnInstrumentation) {
        lineForDriver = rewriteReturnInstrumentation(lineForDriver, lineNumber, activeSignature, postLineInstrumentation);
      }
      lineForDriver = rewriteTraceContainerAliasNames(lineForDriver, lineNumber, activeFrame.variables, aliases);
      lineForDriver = rewriteTraceContainerProxyReferences(lineForDriver, lexicalAccessVariables, aliases);
      const accessVariables =
        activeClassName === (options.traceMemberClassName || 'Solution')
          ? new Map([...traceMemberVariables, ...lexicalAccessVariables])
          : lexicalAccessVariables;
      lineForDriver = rewriteVectorElementMemberAccess(lineForDriver, lexicalAccessVariables, aliases, traceMemberNames);
      lineForDriver = rewriteKeyedIndexSourceInstrumentation(lineForDriver, accessVariables, aliases, lineNumber);
      lineForDriver = rewriteVectorSwapInstrumentation(lineForDriver, accessVariables, aliases);
      lineForDriver = scopeTraceContainerAssignmentLine(lineForDriver, lineNumber);
      lineForDriver = rewriteNestedIndexedWriteInstrumentation(lineForDriver, lineNumber, accessVariables, aliases);
      lineForDriver = rewriteVectorIndexedWriteInstrumentation(lineForDriver, lineNumber, accessVariables, aliases);
      lineForDriver = rewritePlainIndexedWriteInstrumentation(lineForDriver, lineNumber, accessVariables, aliases);
      lineForDriver = rewriteIndexedElementAliasMutationInstrumentation(lineForDriver, lineNumber, buildCppLexicalIndexedElementAliases(frameStack));
      lineForDriver = rewritePlainContainerMutationInstrumentation(lineForDriver, lineNumber, accessVariables, aliases, source);
      lineForDriver = rewritePlainContainerLookupInstrumentation(lineForDriver, lineNumber, accessVariables, aliases);
      lineForDriver = rewriteMapIteratorSecondMutationInstrumentation(lineForDriver, lineNumber, activeFrame.mapIterators);
      lineForDriver = rewriteIndexedElementAliasReadInstrumentation(lineForDriver, lineNumber, buildCppLexicalIndexedElementAliases(frameStack));
      lineForDriver = rewriteIndexReadInstrumentation(lineForDriver, accessVariables, aliases, lineNumber);
      lineForDriver = rewriteStringPointerIndexedReadInstrumentation(lineForDriver, lineNumber, activeFrame.stringPointerAliases);
      lineForDriver = rewriteControlConditionLineScope(lineForDriver, lineNumber, accessVariables, aliases);
      lineForDriver = rewriteFieldContainerCountInstrumentation(lineForDriver, lineNumber);
      lineForDriver = rewriteTraceMutatingCallLineScope(lineForDriver, lineNumber);
      if (activeSignature.name === CPP_SCRIPT_FUNCTION_NAME) {
        lineForDriver = rewriteCppCallSiteExpressionLines(lineForDriver, lineNumber, activeSignature.name, callSiteNames);
      }
      lineForDriver = rewriteBareMemberReadInstrumentation(
        lineForDriver,
        lineNumber,
        serializableMemberVariables,
        activeFrame.variables,
        activeClassName,
        options.traceMemberClassName || 'Solution'
      );
      lineForDriver = rewriteScalarWriteInstrumentation(lineForDriver, lineNumber, activeFrame.variables);
      lineForDriver = rewritePointerAssignmentWriteInstrumentation(lineForDriver, lineNumber);
      lineForDriver = rewritePointerFieldReadInstrumentation(lineForDriver, lineNumber, activeFrame.variables);
      lineForDriver = rewriteBareMemberAssignmentWriteInstrumentation(
        lineForDriver,
        lineNumber,
        serializableMemberVariables,
        activeFrame.variables,
        activeClassName,
        options.traceMemberClassName || 'Solution'
      );
      const externalPostLineIsScopeSafe = /^\s*for\s*\([^;:]+:/.test(trimmedLine) && !trimmedLine.includes('{');
      if (postLineHandledInline && !externalPostLineIsScopeSafe) {
        lineForDriver = `${lineForDriver}\n#define __TC_POST_LINE_HANDLED_${lineNumber} 1`;
      }
    } else {
      lineForDriver = rewriteTraceContainerMember(
        lineForDriver,
        lineNumber,
        aliases,
        activeClassName,
        options.traceMemberClassName || 'Solution'
      );
    }

    const closesActiveImplicitReturnFrame =
      inFunctionBodyBeforeLine &&
      shouldEmitCppImplicitFrameReturn(activeSignature, aliases) &&
      activeFrame.depth + braceDeltaForLine(line) <= 0;
    if (closesActiveImplicitReturnFrame) {
      output.push(`#line ${lineNumber} "${CPP_USER_SOURCE_FILE}"`);
      output.push(buildLineInstrumentation(lineNumber, activeSignature.name));
      output.push(buildReturnInstrumentation(lineNumber, activeSignature));
    }

    if (
      shouldInstrumentLine &&
      !unbracedControlHeaderLine &&
      shouldEmitCppCallSiteLine(line, activeSignature, callSiteNames)
    ) {
      output.push(`#line ${lineNumber} "${CPP_USER_SOURCE_FILE}"`);
      output.push(buildLineInstrumentation(lineNumber, activeSignature.name));
    }

    output.push(`#line ${lineNumber} "${CPP_USER_SOURCE_FILE}"`);
    output.push(lineForDriver);
    if (
      shouldInstrumentLine &&
      !unbracedControlHeaderLine &&
      !lineForDriver.includes(`__TC_POST_LINE_HANDLED_${lineNumber}`) &&
      !nextSourceLine.startsWith('else') &&
      !/^\s*(?:return|break|continue)\b/.test(trimmedLine)
    ) {
      const externalPostLineDepth = activeFrame.depth + Math.min(0, braceDeltaForLine(line));
      const preControlLineEmitted = shouldInstrumentLine && isCppControlHeaderLine(line);
      output.push(buildPostLineInstrumentation(lineNumber, activeSignature.name, activeFrame.variables, externalPostLineDepth, '', includeSnapshotsForActiveFrame, !preControlLineEmitted));
    }
    if (lineForDriver.includes(`__TC_POST_LINE_HANDLED_${lineNumber}`)) {
      output[output.length - 1] = output[output.length - 1].replace(`\n#define __TC_POST_LINE_HANDLED_${lineNumber} 1`, '');
    }
    if (inFunctionBodyBeforeLine && activeFrame && !skipActiveInstrumentation) {
      updateStringPointerAliasesForLine(line, activeFrame.stringPointerAliases, activeFrame.variables, aliases, activeFrame.depth);
    }

    if (startsMultilineControlCondition) {
      multilineControlConditionDepth = lineParenDelta;
    } else if (multilineControlConditionDepth > 0) {
      multilineControlConditionDepth = Math.max(0, multilineControlConditionDepth + lineParenDelta);
    }
    if (startsMultilineStatement) {
      multilineStatementDepth = Math.max(0, lineParenDelta);
      multilineStatementContinuation = multilineStatementDepth === 0 && !/;\s*$/.test(strippedTrimmedLine);
    } else if (multilineStatementDepth > 0) {
      multilineStatementDepth = Math.max(0, multilineStatementDepth + lineParenDelta);
    } else if (multilineStatementContinuation) {
      multilineStatementContinuation = !/;\s*$/.test(strippedTrimmedLine);
    }
    if (startsLocalLambdaBody || localLambdaDepth > 0) {
      localLambdaDepth += braceDeltaForLine(line);
      if (localLambdaDepth < 0) localLambdaDepth = 0;
    }
    if (startsLocalLambdaBody) {
      pendingLocalLambdaBody = false;
    } else if (pendingLocalLambdaBody && /;\s*$/.test(strippedTrimmedLine)) {
      pendingLocalLambdaBody = false;
    } else if (inFunctionBodyBeforeLine && !insideLocalLambdaBody && startsCppLocalLambdaDeclaration(line)) {
      pendingLocalLambdaBody = true;
    }

    if (pendingSignature || frameStack.length > 0) {
      const delta = braceDeltaForLine(line);
      if (pendingSignature && delta > 0) {
        const nextSignature = pendingSignature;
        pendingSignature = null;
        const variables = new Map();
        for (const parameter of nextSignature.parameters) {
          if (isSnapshotSerializableCppType(parameter.type, aliases)) {
            const traceWrapEligible = shouldTraceWrapCppParameter(parameter, nextSignature, aliases, source);
            const traceWrapped = traceWrapEligible &&
              shouldRewriteTraceContainerParametersForSignature(nextSignature, functionName, options);
            variables.set(parameter.name, {
              type: parameter.type,
              scopeDepth: 1,
              parameter: true,
              traceWrapEligible,
              traceWrapped,
              lambdaParameter: Boolean(nextSignature.lambda),
            });
          }
        }
        frameStack.push({ signature: nextSignature, depth: delta, variables, mapIterators: new Map(), indexedElementAliases: new Map(), stringPointerAliases: new Map() });
        if (
          delta > 0 &&
          !nextSignature.skipInstrumentation
        ) {
          if (functionName === CPP_SCRIPT_FUNCTION_NAME && nextSignature.lambda) {
            nextSignature.callLine = nextSignature.line;
          }
          if (nextSignature.lambda) {
            nextSignature.dynamicCallLine = true;
            nextSignature.entryLine = nextSignature.line;
          }
          output.push(`#line ${lineNumber} "${CPP_USER_SOURCE_FILE}"`);
          output.push(buildCallInstrumentation(lineNumber, nextSignature, aliases));
        }
        const scopedTraceNames = buildScopedTraceNameInstrumentation(lineNumber, nextSignature, aliases);
        if (scopedTraceNames) {
          output.push(`#line ${lineNumber} "${CPP_USER_SOURCE_FILE}"`);
          output.push(scopedTraceNames);
        }
      } else if (pendingSignature && lineNumber >= pendingSignature.bodyLine && delta <= 0) {
        pendingSignature = null;
      } else if (frameStack.length > 0) {
        const frame = frameStack[frameStack.length - 1];
        frame.depth += delta;
        for (const [name, variable] of frame.variables) {
          if (variable.scopeDepth > frame.depth) frame.variables.delete(name);
        }
        for (const [name, iterator] of frame.mapIterators) {
          if (iterator.scopeDepth > frame.depth) frame.mapIterators.delete(name);
        }
        for (const [name, alias] of frame.indexedElementAliases) {
          if (alias.scopeDepth > frame.depth) frame.indexedElementAliases.delete(name);
        }
        for (const [name, alias] of frame.stringPointerAliases) {
          if (alias.scopeDepth > frame.depth) frame.stringPointerAliases.delete(name);
        }
        while (frameStack.length > 0 && frameStack[frameStack.length - 1].depth <= 0) {
          frameStack.pop();
        }
      }
    }

    const classDecl = stripCppStringsAndComments(line).match(/\b(?:class|struct)\s+([A-Za-z_]\w*)\b/);
    const classDelta = braceDeltaForLine(line);
    if (classDecl && classDelta > 0) {
      classStack.push({
        name: classDecl[1],
        depth: classDelta,
        local: Boolean(activeFrame) && activeSignature?.name !== CPP_SCRIPT_FUNCTION_NAME,
        scriptWrapperLocal: Boolean(activeFrame) && activeSignature?.name === CPP_SCRIPT_FUNCTION_NAME,
      });
    } else if (classStack.length > 0) {
      classStack[classStack.length - 1].depth += classDelta;
      while (classStack.length > 0 && classStack[classStack.length - 1].depth <= 0) {
        classStack.pop();
      }
    }
  }

  return output.join('\n');
}

function buildDriverSource(userCode, functionName, inputs, options = {}) {
  userCode = normalizeCppUserSource(userCode, options);
  const aliases = collectCppTypeAliases(userCode);
  const signature = parseMethodSignature(userCode, functionName, {
    parameterCount: Object.keys(inputs || {}).length,
    inputNames: Object.keys(inputs || {}),
  });
  const typeContext = sourceDeclaresSolutionClass(userCode)
    ? buildCppDriverTypeContext(userCode, 'Solution', signature, aliases)
    : buildCppDriverTypeContext(userCode, functionName, signature, aliases);
  const driverSignature = qualifyCppSignatureForDriver(signature, typeContext, aliases);
  const skipTraceParameterNames = new Set(
    signature.parameters
      .filter((parameter) => parameterAddressEscapes(userCode, parameter.name))
      .map((parameter) => parameter.name)
  );
  signature.skipTraceParameterNames = skipTraceParameterNames;
  const traced = options.tracing === true;
  const usesSolutionClass = options.executionStyle !== 'function' || sourceDeclaresSolutionClass(userCode);
  const sourceForDriver = options.tracing === true ? instrumentCppSourceForTracing(userCode, functionName) : userCode;
  const declarations = [];
  const argumentNames = [];
  let usesDynamicInputs = false;

  driverSignature.parameters.forEach((parameter, index) => {
    const localName = `__tc_arg_${index}`;
    const shouldTraceParameter = traced && shouldTraceWrapCppParameter(parameter, signature, aliases, userCode);
    const declarationType = shouldTraceParameter ? cppTraceType(parameter.type, aliases) : materializedCppType(parameter.type, aliases);
    const dynamicInput = cppDynamicInputExpression(parameter, index, aliases, typeContext.customJsonTypes);
    const value = dynamicInput ?? toCppLiteral(inputValueForParameter(inputs, parameter, index), parameter.type, aliases);
    usesDynamicInputs ||= dynamicInput !== null;
    if (shouldTraceParameter) {
      declarations.push(`  ${declarationType} ${localName}(${materializedCppType(parameter.type, aliases)}(${value}), ${cppStringLiteral(parameter.name)}, ${signature.line});`);
    } else {
      declarations.push(`  ${declarationType} ${localName} = ${value};`);
    }
    argumentNames.push(localName);
  });

  const callEventPrefix = `{"kind":"call","line":${signature.line},"function":${jsonStringLiteral(functionName)},"args":`;
  const returnEventPrefix = `{"kind":"return","line":${signature.line},"function":${jsonStringLiteral(functionName)},"value":`;
  const returnsNull = isNullCppReturnType(driverSignature.returnType, aliases);
  const returnsVoid = normalizeCppType(localCppType(driverSignature.returnType), aliases) === 'void';
  const noStoredResult = returnsVoid || returnsNull;
  const voidOutputParameter = returnsVoid && driverSignature.parameters.length > 0 && isSnapshotSerializableCppType(driverSignature.parameters[0].type, aliases)
    ? driverSignature.parameters[0]
    : null;
  const traceSetup = traced ? `  ${configureTraceBudgetCall(options)}` : '';
  const signatureSourceLine = userCode.split(/\r?\n/)[signature.line - 1] ?? '';
  const hasSingleLineFunctionBody = signatureSourceLine.includes('{') && signatureSourceLine.includes('}');
  const traceCall = traced && hasSingleLineFunctionBody
    ? [
        `  std::string __tc_args_json = std::string("{") + ${buildTraceArgsJsonExpression(driverSignature, (_parameter, index) => `__tc_arg_${index}`, aliases)} + "}";`,
        `  tracecode::write_trace_event_json(std::string(${cppStringLiteral(callEventPrefix)}) + __tc_args_json + "}", ${signature.line});`,
        `  tracecode::emit_line(${signature.line}, ${cppStringLiteral(functionName)});`,
      ].join('\n')
    : '';
  const traceReturn = traced && hasSingleLineFunctionBody
    ? noStoredResult
      ? returnsNull
        ? `  tracecode::write_trace_event_json(std::string(${cppStringLiteral(`${returnEventPrefix}null}`)}), ${signature.line});`
        : voidOutputParameter
        ? `  tracecode::write_trace_event_json(std::string(${cppStringLiteral(returnEventPrefix)}) + ${cppJsonExpressionForValue('__tc_arg_0', voidOutputParameter.type, userCode)} + "}", ${signature.line});`
        : `  tracecode::write_trace_event_json(std::string(${cppStringLiteral(`${returnEventPrefix}null}`)}), ${signature.line});`
      : `  tracecode::write_trace_event_json(std::string(${cppStringLiteral(returnEventPrefix)}) + ${cppJsonExpressionForValue('__tc_result', driverSignature.returnType, userCode)} + "}", ${signature.line});`
    : '';
  const resultJsonExpression = noStoredResult
    ? returnsNull
      ? '"null"'
      : voidOutputParameter
      ? cppJsonExpressionForValue('__tc_arg_0', voidOutputParameter.type, userCode)
      : '"null"'
    : cppJsonExpressionForValue('__tc_result', driverSignature.returnType, userCode);
  const callExpression = `${usesSolutionClass ? `solution.${functionName}` : functionName}(${argumentNames.join(', ')})`;
  const invokeAndStore = noStoredResult ? `  ${callExpression};` : `  auto __tc_result = ${callExpression};`;

return `${buildGeneratedIncludes(userCode, driverSignature)}
using namespace std;
${buildTracecodeFallbackAliases(userCode)}

#line 1 "${CPP_USER_SOURCE_FILE}"
${sourceForDriver}
${buildCppJsonObjectAdapters(typeContext, aliases)}

#line 1 "TraceCodeDriver.cpp"
int main() {
${usesSolutionClass ? '  Solution solution;' : ''}
${traceSetup}
${usesDynamicInputs ? '  tracecode::JsonValue __tc_inputs = tracecode::parse_json(tracecode::read_stdin_all());' : ''}
${declarations.join('\n')}
${traceCall}
${invokeAndStore}
${traceReturn}
  tracecode::write_result_json_raw(${resultJsonExpression});
  return 0;
}
`;
}

function buildBatchDriverSource(userCode, functionName, inputBatch, options = {}) {
  userCode = normalizeCppUserSource(userCode, options);
  const firstInputs = Array.isArray(inputBatch) && inputBatch.length > 0 && inputBatch[0] && typeof inputBatch[0] === 'object'
    ? inputBatch[0]
    : {};
  const aliases = collectCppTypeAliases(userCode);
  const signature = parseMethodSignature(userCode, functionName, {
    parameterCount: Object.keys(firstInputs || {}).length,
    inputNames: Object.keys(firstInputs || {}),
  });
  const typeContext = sourceDeclaresSolutionClass(userCode)
    ? buildCppDriverTypeContext(userCode, 'Solution', signature, aliases)
    : buildCppDriverTypeContext(userCode, functionName, signature, aliases);
  const driverSignature = qualifyCppSignatureForDriver(signature, typeContext, aliases);
  const usesSolutionClass = options.executionStyle !== 'function' || sourceDeclaresSolutionClass(userCode);
  const traced = options.tracing === true;
  const sourceForDriver = traced ? instrumentCppSourceForTracing(userCode, functionName) : userCode;
  const declarations = [];
  const argumentNames = [];

  driverSignature.parameters.forEach((parameter, index) => {
    const localName = `__tc_arg_${index}`;
    const materializedType = materializedCppType(parameter.type, aliases);
    const shouldTraceParameter = traced && shouldTraceWrapCppParameter(parameter, signature, aliases, userCode);
    const declarationType = shouldTraceParameter ? cppTraceType(parameter.type, aliases) : materializedType;
    const value = `tracecode::read_json_input<${materializedType}>(__tc_case, ${cppStringLiteral(parameter.name)}, ${index})`;
    declarations.push(shouldTraceParameter
      ? `    ${declarationType} ${localName}(${materializedType}(${value}), ${cppStringLiteral(parameter.name)}, ${signature.line});`
      : `    ${declarationType} ${localName} = ${value};`);
    argumentNames.push(localName);
  });

  const returnsNull = isNullCppReturnType(driverSignature.returnType, aliases);
  const returnsVoid = normalizeCppType(localCppType(driverSignature.returnType), aliases) === 'void';
  const noStoredResult = returnsVoid || returnsNull;
  const voidOutputParameter = returnsVoid && driverSignature.parameters.length > 0 && isSnapshotSerializableCppType(driverSignature.parameters[0].type, aliases)
    ? driverSignature.parameters[0]
    : null;
  const resultJsonExpression = noStoredResult
    ? returnsNull
      ? '"null"'
      : voidOutputParameter
      ? cppJsonExpressionForValue('__tc_arg_0', voidOutputParameter.type, userCode)
      : '"null"'
    : cppJsonExpressionForValue('__tc_result', driverSignature.returnType, userCode);
  const callExpression = `${usesSolutionClass ? `solution.${functionName}` : functionName}(${argumentNames.join(', ')})`;
  const invokeAndStore = noStoredResult ? `    ${callExpression};` : `    auto __tc_result = ${callExpression};`;
  const traceCaseSetup = traced
    ? `    ${configureTraceBudgetCall(options)}\n    tracecode::write_trace_event_json(std::string(${cppStringLiteral(`{"kind":"call","line":1,"function":"${CPP_BATCH_TRACE_CASE_MARKER_FUNCTION}","args":{"index":`)}) + std::to_string(__tc_case_index) + "}}", 1);`
    : '';

return `${buildGeneratedIncludes(userCode, driverSignature)}
using namespace std;
${buildTracecodeFallbackAliases(userCode)}

#line 1 "${CPP_USER_SOURCE_FILE}"
${sourceForDriver}
${buildCppJsonObjectAdapters(typeContext, aliases)}

#line 1 "TraceCodeDriver.cpp"
int main() {
  tracecode::JsonValue __tc_cases = tracecode::parse_json(tracecode::read_stdin_all());
  if (__tc_cases.kind != tracecode::JsonValue::Kind::Array) {
    std::fputs("C++ batch input must be a JSON array.\\n", stderr);
    return 1;
  }
  std::string __tc_results = "[";
  for (std::size_t __tc_case_index = 0; __tc_case_index < __tc_cases.array_values.size(); ++__tc_case_index) {
    const tracecode::JsonValue& __tc_case = __tc_cases.array_values[__tc_case_index];
    if (__tc_case_index > 0) __tc_results += ",";
${traceCaseSetup}
${usesSolutionClass ? '    Solution solution;\n' : ''}${declarations.join('\n')}
${invokeAndStore}
    __tc_results += ${resultJsonExpression};
  }
  __tc_results += "]";
  tracecode::write_result_json_raw(__tc_results);
  return 0;
}
`;
}

function buildOpsClassBatchDriverSource(userCode, className, inputBatch, options = {}) {
  userCode = normalizeCppUserSource(userCode, options);
  const firstInputs = Array.isArray(inputBatch) && inputBatch.length > 0 && inputBatch[0] && typeof inputBatch[0] === 'object'
    ? inputBatch[0]
    : {};
  const aliases = collectCppTypeAliases(userCode);
  const typeContext = buildCppDriverTypeContext(userCode, className, null, aliases);
  const { operations, argumentsList } = getOpsClassInputs(firstInputs || {});
  let firstOperationIndex = 1;
  let constructorArgumentIndex = 0;
  if (operations[0] === '__init__') {
    firstOperationIndex = 1;
    constructorArgumentIndex = 0;
  } else if (operations[0] === className) {
    firstOperationIndex = 1;
    constructorArgumentIndex = 0;
  } else if (operations.length > 0) {
    firstOperationIndex = 0;
    constructorArgumentIndex = -1;
  } else {
    throw new Error(`C++ ops-class inputs must start with constructor operation "${className}".`);
  }

  const lines = [];
  const constructorArgs = constructorArgumentIndex >= 0 ? normalizeOpsArguments(argumentsList[constructorArgumentIndex]) : [];
  const constructorSignature = qualifyCppSignatureForDriver(
    parseConstructorSignature(userCode, className, aliases, {
      parameterCount: constructorArgs.length,
    }),
    typeContext,
    aliases
  );
  if (constructorArgs.length !== constructorSignature.parameters.length) {
    throw new Error(`C++ ops-class constructor "${className}" expected ${constructorSignature.parameters.length} args, received ${constructorArgs.length}.`);
  }
  const constructorArgNames = constructorArgs.map((_value, index) => {
    const localName = `__tc_ctor_arg_${index}`;
    const type = materializedCppType(constructorSignature.parameters[index].type, aliases);
    lines.push(`    ${type} ${localName} = tracecode::json_to<${type}>(__tc_ops_arg_at(__tc_ops_item_at(*__tc_arguments, ${constructorArgumentIndex}), ${index}));`);
    return localName;
  });
  lines.push(constructorArgs.length === 0
    ? `    ${className} __tc_instance;`
    : `    ${className} __tc_instance(${constructorArgNames.join(', ')});`);
  lines.push('    std::vector<std::string> __tc_case_outputs;');
  if (constructorArgumentIndex >= 0) {
    lines.push('    __tc_case_outputs.push_back("null");');
  }

  for (let index = firstOperationIndex; index < operations.length; index += 1) {
    const operation = operations[index];
    if (typeof operation !== 'string' || !operation.trim()) {
      throw new Error(`C++ ops-class operation at index ${index} must be a method name.`);
    }
    const signatureOperation = resolveCppObjectMethodMacro(userCode, operation);
    const signature = qualifyCppSignatureForDriver(parseMethodSignature(userCode, signatureOperation), typeContext, aliases);
    const args = normalizeOpsArguments(argumentsList[index]);
    if (args.length !== signature.parameters.length) {
      throw new Error(`C++ ops-class method "${operation}" expected ${signature.parameters.length} args, received ${args.length}.`);
    }
    const argNames = [];
    signature.parameters.forEach((parameter, argIndex) => {
      const localName = `__tc_op_${index}_arg_${argIndex}`;
      const type = materializedCppType(parameter.type, aliases);
      lines.push(`    ${type} ${localName} = tracecode::json_to<${type}>(__tc_ops_arg_at(__tc_ops_item_at(*__tc_arguments, ${index}), ${argIndex}));`);
      argNames.push(localName);
    });
    if (normalizeCppType(signature.returnType, aliases) === 'void' || isNullCppReturnType(signature.returnType, aliases)) {
      lines.push(`    __tc_instance.${signatureOperation}(${argNames.join(', ')});`);
      lines.push('    __tc_case_outputs.push_back("null");');
    } else {
      lines.push(`    auto __tc_op_${index}_result = __tc_instance.${signatureOperation}(${argNames.join(', ')});`);
      lines.push(`    __tc_case_outputs.push_back(${cppJsonExpressionForValue(`__tc_op_${index}_result`, signature.returnType, userCode)});`);
    }
  }
  const operationChecks = operations.map((operation, index) => `    if (__tc_operations && __tc_operations->kind == tracecode::JsonValue::Kind::Array && __tc_operations->array_values.size() > ${index} && __tc_operations->array_values[${index}].kind == tracecode::JsonValue::Kind::String && __tc_operations->array_values[${index}].string_value != ${cppStringLiteral(String(operation))}) {
      std::fputs("C++ ops-class case operation name differs from the first case.\\n", stderr);
      return 1;
    }`);

return `${buildGeneratedIncludes(userCode, { parameters: [] })}
using namespace std;
${buildTracecodeFallbackAliases(userCode)}

#line 1 "${CPP_USER_SOURCE_FILE}"
${userCode}
${buildCppJsonObjectAdapters(typeContext, aliases)}

#line 1 "TraceCodeDriver.cpp"
int main() {
  tracecode::JsonValue __tc_cases = tracecode::parse_json(tracecode::read_stdin_all());
  if (__tc_cases.kind != tracecode::JsonValue::Kind::Array) {
    std::fputs("C++ ops-class batch input must be a JSON array.\\n", stderr);
    return 1;
  }
  const tracecode::JsonValue __tc_null_value;
  auto __tc_ops_item_at = [&__tc_null_value](const tracecode::JsonValue& values, std::size_t index) -> const tracecode::JsonValue& {
    if (values.kind == tracecode::JsonValue::Kind::Array && index < values.array_values.size()) return values.array_values[index];
    return __tc_null_value;
  };
  auto __tc_ops_arg_at = [&__tc_ops_item_at](const tracecode::JsonValue& values, std::size_t index) -> const tracecode::JsonValue& {
    if (values.kind == tracecode::JsonValue::Kind::Array) return __tc_ops_item_at(values, index);
    return values;
  };
  std::string __tc_results = "[";
  for (std::size_t __tc_case_index = 0; __tc_case_index < __tc_cases.array_values.size(); ++__tc_case_index) {
    const tracecode::JsonValue& __tc_case = __tc_cases.array_values[__tc_case_index];
    const tracecode::JsonValue* __tc_operations = tracecode::object_get(__tc_case, "operations");
    if (!__tc_operations) __tc_operations = tracecode::object_get(__tc_case, "ops");
    const tracecode::JsonValue* __tc_arguments = tracecode::object_get(__tc_case, "arguments");
    if (!__tc_arguments) __tc_arguments = tracecode::object_get(__tc_case, "args");
    if (!__tc_arguments || __tc_arguments->kind != tracecode::JsonValue::Kind::Array) {
      std::fputs("C++ ops-class case must include arguments or args array.\\n", stderr);
      return 1;
    }
    if (__tc_operations && __tc_operations->kind == tracecode::JsonValue::Kind::Array && __tc_operations->array_values.size() != ${operations.length}) {
      std::fputs("C++ ops-class case operations length differs from the first case.\\n", stderr);
      return 1;
    }
${operationChecks.join('\n')}
    if (__tc_case_index > 0) __tc_results += ",";
${lines.join('\n')}
    std::string __tc_case_json = "[";
    for (std::size_t __tc_i = 0; __tc_i < __tc_case_outputs.size(); ++__tc_i) {
      if (__tc_i > 0) __tc_case_json += ",";
      __tc_case_json += __tc_case_outputs[__tc_i];
    }
    __tc_case_json += "]";
    __tc_results += __tc_case_json;
  }
  __tc_results += "]";
  tracecode::write_result_json_raw(__tc_results);
  return 0;
}
`;
}

function scriptLineCount(source) {
  return String(source || '').split(/\r?\n/).length;
}

function buildScriptWrapperSource(userCode, options = {}) {
  userCode = normalizeCppUserSource(userCode, options);
  const userLineCount = scriptLineCount(userCode);
  return `auto ${CPP_SCRIPT_FUNCTION_NAME}() {
#line 1 "${CPP_USER_SOURCE_FILE}"
${userCode}
#line ${userLineCount + 1} "${CPP_USER_SOURCE_FILE}"
  return result;
}`;
}

function buildScriptDriverSource(userCode, options = {}) {
  userCode = normalizeCppUserSource(userCode, options);
  const userLineCount = scriptLineCount(userCode);
  const scriptClassNames = collectCppDeclaredClassNames(userCode);
  const traceMemberClassName = scriptClassNames.length === 1 ? scriptClassNames[0] : null;
  const wrappedSource = buildScriptWrapperSource(userCode, options);
  const sourceForDriver = options.tracing === true
    ? instrumentCppSourceForTracing(
        wrappedSource,
        CPP_SCRIPT_FUNCTION_NAME,
        traceMemberClassName ? { traceMemberClassName } : {}
      )
    : wrappedSource;
  const traceCall = options.tracing === true
    ? [
        `  ${configureTraceBudgetCall(options)}`,
        `  tracecode::write_trace_event_json(std::string(${cppStringLiteral('{"kind":"call","line":1,"function":"<script>","args":{}}')}), 1);`,
      ].join('\n')
    : '';
  const traceReturn = options.tracing === true
    ? `  tracecode::write_trace_event_json(std::string(${cppStringLiteral('{"kind":"return","line":1,"function":"<script>","value":')}) + tracecode::to_json(__tc_result) + "}", 1);`
    : '';

return `${buildGeneratedIncludes(userCode, { parameters: [] })}
using namespace std;
${buildTracecodeFallbackAliases(userCode)}

#line 1 "${CPP_USER_SOURCE_FILE}"
${sourceForDriver}

#line 1 "TraceCodeDriver.cpp"
int main() {
${traceCall}
  auto __tc_result = ${CPP_SCRIPT_FUNCTION_NAME}();
${traceReturn}
  tracecode::write_result_json(__tc_result);
  return 0;
}
`;
}

function splitMarkerLine(text, markerIndex, marker) {
  const afterMarker = text.slice(markerIndex + marker.length);
  const markerLineEnd = afterMarker.search(/\r?\n/);
  if (markerLineEnd < 0) {
    return {
      payload: afterMarker,
      nextIndex: text.length,
    };
  }
  return {
    payload: afterMarker.slice(0, markerLineEnd),
    nextIndex: markerIndex + marker.length + markerLineEnd + (afterMarker[markerLineEnd] === '\r' ? 2 : 1),
  };
}

function appendConsoleChunk(chunk, consoleOutput, traceEvents, pendingStdoutEvents, defaultLine) {
  for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
    consoleOutput.push(line);
    if (traceEvents) {
      const event = {
        kind: 'stdout',
        line: defaultLine,
        text: line,
      };
      traceEvents.push(event);
      pendingStdoutEvents?.push(event);
    }
  }
}

function anchorPendingStdoutEvents(pendingStdoutEvents, event) {
  if (!pendingStdoutEvents?.length || typeof event?.line !== 'number') return;
  for (const stdoutEvent of pendingStdoutEvents) {
    stdoutEvent.line = event.line;
  }
  pendingStdoutEvents.length = 0;
}

function parseProgramStdout(stdout, options = {}) {
  const consoleOutput = [];
  const traceEvents = options.tracing ? [] : null;
  const pendingStdoutEvents = options.tracing ? [] : null;
  let output = null;
  let foundResult = false;
  let traceStatus = null;
  let cursor = 0;

  while (cursor < stdout.length) {
    const resultIndex = stdout.indexOf(RESULT_MARKER, cursor);
    const traceIndex = options.tracing ? stdout.indexOf(TRACE_EVENT_MARKER, cursor) : -1;
    const statusIndex = stdout.indexOf(TRACE_STATUS_MARKER, cursor);
    const markerIndex = [resultIndex, traceIndex, statusIndex]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;

    if (markerIndex < 0) {
      appendConsoleChunk(stdout.slice(cursor), consoleOutput, traceEvents, pendingStdoutEvents, options.defaultLine ?? 1);
      break;
    }

    appendConsoleChunk(stdout.slice(cursor, markerIndex), consoleOutput, traceEvents, pendingStdoutEvents, options.defaultLine ?? 1);

    if (markerIndex === resultIndex) {
      const marker = splitMarkerLine(stdout, markerIndex, RESULT_MARKER);
      output = marker.payload ? JSON.parse(marker.payload) : null;
      foundResult = true;
      cursor = marker.nextIndex;
    } else if (markerIndex === statusIndex) {
      const marker = splitMarkerLine(stdout, markerIndex, TRACE_STATUS_MARKER);
      traceStatus = marker.payload ? JSON.parse(marker.payload) : null;
      cursor = marker.nextIndex;
    } else {
      const marker = splitMarkerLine(stdout, markerIndex, TRACE_EVENT_MARKER);
      if (traceEvents && marker.payload) {
        try {
          const event = JSON.parse(marker.payload);
          anchorPendingStdoutEvents(pendingStdoutEvents, event);
          traceEvents.push(event);
        } catch (error) {
          throw new Error(`C++ trace event JSON parse failed: ${error instanceof Error ? error.message : String(error)}; payload=${marker.payload}`);
        }
      }
      cursor = marker.nextIndex;
    }
  }

  if (!foundResult && !options.allowMissingResult) {
    throw new Error('C++ program did not emit a TraceCode result.');
  }
  return { output, consoleOutput, events: traceEvents ?? [], traceStatus };
}

function normalizeScriptTraceEvents(events, userLineCount) {
  const normalizeLine = (line) => {
    if (typeof line !== 'number') return line;
    // Script tracing wraps user code in `auto __tracecode_script_main() {`
    // followed by a `#line` directive before instrumentation. Runtime events
    // are emitted from the generated wrapper's physical source, so user code is
    // shifted by two lines unless we map it back here.
    return line > 2 ? line - 2 : line;
  };
  const normalizedEvents = events.flatMap((event) => {
    const normalized = { ...event };
    if (normalized.function === CPP_SCRIPT_FUNCTION_NAME) {
      normalized.function = '<script>';
    }
    if (typeof normalized.line === 'number') {
      normalized.line = normalizeLine(normalized.line);
      if (normalized.line > userLineCount) return [];
    }
    if (Array.isArray(normalized.callStack)) {
      normalized.callStack = normalized.callStack.map((frame) => ({
        ...frame,
        function: frame.function === CPP_SCRIPT_FUNCTION_NAME ? '<script>' : frame.function,
        line: normalizeLine(frame.line),
      }));
    }
    return [normalized];
  });
  return reorderScriptCallSiteLines(normalizedEvents);
}

function reorderScriptCallSiteLines(events) {
  const firstNestedCallIndex = events.findIndex((event) => event.kind === 'call' && event.function && event.function !== '<script>');
  if (firstNestedCallIndex < 0) return events;
  const nestedFunction = events[firstNestedCallIndex].function;
  const returnIndex = events.findIndex((event, index) => index > firstNestedCallIndex && event.kind === 'return' && event.function === nestedFunction);
  if (returnIndex < 0) return events;
  const callSiteIndex = events.findIndex((event, index) => (
    index > returnIndex &&
    event.kind === 'line' &&
    event.function === '<script>' &&
    typeof event.line === 'number'
  ));
  if (callSiteIndex < 0) return events;
  const callSiteLine = events[callSiteIndex].line;
  const movedCallSite = { ...events[callSiteIndex] };
  return [
    ...events.slice(0, firstNestedCallIndex).filter((event) => !(event.kind === 'line' && event.function === '<script>' && event.line !== callSiteLine)),
    movedCallSite,
    ...events.slice(firstNestedCallIndex, callSiteIndex),
    ...events.slice(callSiteIndex + 1),
  ];
}

function cloneCppCallStack(stack) {
  return stack.map((frame) => ({ ...frame }));
}

function popCppCallStackFrame(stack, functionName) {
  if (stack.length === 0) return;
  if (!functionName || stack[stack.length - 1]?.function === functionName) {
    stack.pop();
    return;
  }
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]?.function === functionName) {
      stack.splice(index);
      return;
    }
  }
}

function enrichCppRuntimeTraceCallStacks(events) {
  const stack = [];
  return events.map((event) => {
    if (event?.kind === 'call') {
      const frame = {
        function: event.function || '<module>',
        ...(event.args !== undefined ? { args: event.args } : {}),
        ...(typeof event.line === 'number' ? { line: event.line } : {}),
      };
      stack.push(frame);
      return { ...event, callStack: cloneCppCallStack(stack) };
    }
    if (event?.kind === 'return') {
      const withStack = stack.length > 0 ? { ...event, callStack: cloneCppCallStack(stack) } : { ...event };
      popCppCallStackFrame(stack, event.function);
      return withStack;
    }
    return stack.length > 0 ? { ...event, callStack: cloneCppCallStack(stack) } : { ...event };
  });
}

function normalizeMaxPathDepth(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(8, Math.max(1, Math.floor(value)));
}

function normalizeRuntimeTraceEventTargetDepth(event, maxPathDepth) {
  if (maxPathDepth === undefined || !event || typeof event !== 'object') return event;
  const target = event.target;
  if (!target || typeof target !== 'object' || !Array.isArray(target.path) || target.path.length <= maxPathDepth) {
    return event;
  }
  const nextTarget = { ...target };
  delete nextTarget.path;
  delete nextTarget.indexSources;
  return { ...event, target: nextTarget };
}

function buildCppUserFunctionNameSet(source) {
  const names = new Set();
  if (typeof source !== 'string' || source.trim() === '') return names;
  for (const signature of parseCppFunctionSignatures(source)) {
    if (typeof signature?.name === 'string' && signature.name) names.add(signature.name);
  }

  const cleaned = stripComments(source);
  const namePattern = /\b(tracecode[A-Z]\w*)\s*\(/g;
  const skippedReturnTypes = new Set([
    'class',
    'struct',
    'public:',
    'private:',
    'protected:',
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
  ]);
  let match;
  while ((match = namePattern.exec(cleaned))) {
    const name = match[1];
    const openParenIndex = cleaned.indexOf('(', match.index);
    const closeParenIndex = findMatchingParen(cleaned, openParenIndex);
    if (closeParenIndex < 0) continue;

    let cursor = closeParenIndex + 1;
    while (/\s/.test(cleaned[cursor] || '')) cursor += 1;
    while (/^(?:const|noexcept|override|final)\b/.test(cleaned.slice(cursor))) {
      const qualifier = cleaned.slice(cursor).match(/^(?:const|noexcept|override|final)\b/)?.[0] || '';
      cursor += qualifier.length;
      while (/\s/.test(cleaned[cursor] || '')) cursor += 1;
    }
    if (cleaned[cursor] !== '{') continue;

    const signaturePrefix = cleaned.slice(0, match.index);
    const returnTypeMatch = signaturePrefix.match(/([A-Za-z_][\w:\s<>,*&]*?)\s*$/);
    if (!returnTypeMatch) continue;
    const returnType = cleanCppReturnType(returnTypeMatch[1]);
    if (skippedReturnTypes.has(returnType)) continue;
    names.add(name);
    namePattern.lastIndex = closeParenIndex + 1;
  }
  return names;
}

function isCppSyntheticHelperFunctionName(name, userFunctionNames = new Set()) {
  return (
    typeof name === 'string' &&
    /^tracecode[A-Z]/.test(name) &&
    !(userFunctionNames instanceof Set && userFunctionNames.has(name))
  );
}

function stripCppSyntheticHelperFrames(event, userFunctionNames = new Set()) {
  if (!event || typeof event !== 'object' || !Array.isArray(event.callStack)) return event;
  const callStack = event.callStack.filter((frame) => !isCppSyntheticHelperFunctionName(frame?.function, userFunctionNames));
  return callStack.length === event.callStack.length ? event : { ...event, callStack };
}

function isDroppableCppSyntheticHelperEvent(event, userFunctionNames = new Set()) {
  return (
    isCppSyntheticHelperFunctionName(event?.function, userFunctionNames) &&
    (event.kind === 'call' || event.kind === 'line' || event.kind === 'return')
  );
}

function traceLineParenDelta(line) {
  let delta = 0;
  let quote = null;
  let escaped = false;
  for (const char of String(line ?? '')) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') delta += 1;
    else if (char === ')') delta -= 1;
  }
  return delta;
}

function buildRuntimeStatementSourceMap(code) {
  const lines = String(code ?? '').split(/\r?\n/);
  const spans = new Map();
  let startLine = 0;
  let startColumn = 0;
  let balance = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index] ?? '';
    const delta = traceLineParenDelta(line);
    if (startLine === 0) {
      if (delta > 0) {
        startLine = lineNumber;
        startColumn = /\S/.exec(line)?.index ?? 0;
        balance = delta;
      }
      continue;
    }
    balance += delta;
    if (balance <= 0) {
      const span = {
        statementId: `stmt:${startLine}:${lineNumber}:${startColumn}`,
        startLine,
        startColumn,
        endLine: lineNumber,
        endColumn: line.length,
      };
      for (let mappedLine = startLine; mappedLine <= lineNumber; mappedLine += 1) {
        spans.set(mappedLine, span);
      }
      startLine = 0;
      startColumn = 0;
      balance = 0;
    }
  }
  return spans;
}

function cppRuntimeTraceSourceOwnership(event, statementSourceMap) {
  if (!(statementSourceMap instanceof Map) || typeof event?.line !== 'number') return {};
  const span = statementSourceMap.get(Math.floor(event.line));
  if (!span) return {};
  const functionName = typeof event.function === 'string' && event.function.length > 0 ? event.function : undefined;
  return {
    statementId: functionName ? `${functionName}:${span.statementId}` : span.statementId,
    sourceSpan: {
      startLine: span.startLine,
      startColumn: span.startColumn,
      endLine: span.endLine,
      endColumn: span.endColumn,
    },
  };
}

function finalizeRuntimeTrace(events, options = {}) {
  const runId = options.runId || 'cpp:run';
  const file = options.file || CPP_USER_SOURCE_FILE;
  const maxPathDepth = normalizeMaxPathDepth(options.maxPathDepth);
  const statementSourceMap = typeof options.sourceCode === 'string'
    ? buildRuntimeStatementSourceMap(options.sourceCode)
    : new Map();
  const userFunctionNames = buildCppUserFunctionNameSet(options.sourceCode);
  const maxEvents = Number.isFinite(options.maxStoredEvents)
    ? Number(options.maxStoredEvents)
    : Number.isFinite(options.maxTraceSteps)
      ? Number(options.maxTraceSteps)
      : DEFAULT_MAX_STORED_EVENTS;
  const normalizedEvents = enrichCppRuntimeTraceCallStacks(events).flatMap((event) => {
    const activeFunction = Array.isArray(event.callStack) ? event.callStack[event.callStack.length - 1]?.function : undefined;
    const normalized = stripCppSyntheticHelperFrames({
      ...event,
      ...(event.kind === 'line' && !event.function && activeFunction ? { function: activeFunction } : {}),
      runId,
      file,
    }, userFunctionNames);
    if (isDroppableCppSyntheticHelperEvent(normalized, userFunctionNames)) return [];
    return [normalizeRuntimeTraceEventTargetDepth({
      ...normalized,
      ...cppRuntimeTraceSourceOwnership(normalized, statementSourceMap),
    }, maxPathDepth)];
  });
  const traceLimitExceeded = maxEvents !== undefined && normalizedEvents.length > maxEvents;
  let storedEvents = traceLimitExceeded ? normalizedEvents.slice(0, Math.max(0, maxEvents)) : normalizedEvents;
  if (
    traceLimitExceeded &&
    normalizedEvents.some((event) => event.kind === 'timeout') &&
    !storedEvents.some((event) => event.kind === 'timeout')
  ) {
    const timeoutEvent = normalizedEvents.find((event) => event.kind === 'timeout');
    storedEvents =
      maxEvents && maxEvents > 1 && timeoutEvent
        ? [...normalizedEvents.slice(0, maxEvents - 1), timeoutEvent]
        : timeoutEvent
          ? [timeoutEvent]
          : storedEvents;
  }
  return {
    trace: {
      schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
      language: 'cpp',
      runId,
      events: storedEvents,
      lineEventCount: storedEvents.filter((event) => event.kind === 'line').length,
      traceStepCount: storedEvents.length,
    },
    traceLimitExceeded,
    droppedEventCount: traceLimitExceeded ? Math.max(0, normalizedEvents.length - storedEvents.length) : 0,
  };
}

function splitCppBatchTraceEvents(events, caseCount) {
  const batches = Array.from({ length: Math.max(0, caseCount) }, () => []);
  let currentCaseIndex = -1;

  for (const event of Array.isArray(events) ? events : []) {
    if (
      event?.kind === 'call' &&
      event.function === CPP_BATCH_TRACE_CASE_MARKER_FUNCTION &&
      event.args &&
      Number.isInteger(Number(event.args.index))
    ) {
      const nextIndex = Number(event.args.index);
      currentCaseIndex = nextIndex >= 0 && nextIndex < batches.length ? nextIndex : -1;
      continue;
    }

    if (currentCaseIndex >= 0) {
      batches[currentCaseIndex].push(event);
    }
  }

  return batches;
}

function cppBatchTraceResultsFromParsedOutput(parsed, source, inputBatch, timings, startedAt, options = {}) {
  if (!Array.isArray(parsed?.output) || parsed.output.length !== inputBatch.length) {
    const error = `C++ trace batch driver returned ${Array.isArray(parsed?.output) ? parsed.output.length : 'non-array'} results for ${inputBatch.length} cases.`;
    return {
      success: false,
      results: inputBatch.map(() => ({
        success: false,
        output: null,
        error,
        trace: finalizeRuntimeTrace([{ kind: 'exception', line: 1, message: error }], { ...(options.traceOptions || {}), sourceCode: source }).trace,
        consoleOutput: [],
        executionTimeMs: elapsedMs(startedAt),
        timings: { ...timings, totalMs: elapsedMs(startedAt) },
      })),
      error,
      consoleOutput: parsed?.consoleOutput ?? [],
      timings: { ...timings, totalMs: elapsedMs(startedAt), batchMode: 'compile-once-trace', batchCaseCount: inputBatch.length },
    };
  }

  const traceBatches = splitCppBatchTraceEvents(parsed.events, inputBatch.length);
  const results = parsed.output.map((output, index) => {
    const finalizedTrace = finalizeRuntimeTrace(traceBatches[index] ?? [], {
      ...(options.traceOptions || {}),
      sourceCode: source,
    });
    return {
      success: true,
      output,
      trace: finalizedTrace.trace,
      consoleOutput: index === 0 ? (parsed.consoleOutput ?? []) : [],
      executionTimeMs: index === 0 ? elapsedMs(startedAt) : 0,
      lineEventCount: finalizedTrace.trace.lineEventCount,
      traceStepCount: finalizedTrace.trace.traceStepCount,
      traceLimitExceeded: finalizedTrace.traceLimitExceeded,
      ...(finalizedTrace.traceLimitExceeded ? { timeoutReason: timeoutReasonForParsedTrace(parsed) } : {}),
      ...(finalizedTrace.traceLimitExceeded ? { droppedEventCount: finalizedTrace.droppedEventCount } : {}),
      timings: index === 0
        ? { ...timings, totalMs: elapsedMs(startedAt), batchCaseIndex: index }
        : { runMs: 0, totalMs: 0, compileCacheHit: true, batchCaseIndex: index },
    };
  });

  return {
    success: true,
    results,
    consoleOutput: parsed.consoleOutput ?? [],
    timings: {
      ...timings,
      totalMs: elapsedMs(startedAt),
      batchMode: 'compile-once-trace',
      batchCaseCount: inputBatch.length,
    },
  };
}

function timeoutReasonForParsedTrace(parsed) {
  const statusReason = parsed?.traceStatus?.timeoutReason;
  if (typeof statusReason === 'string' && statusReason.length > 0) {
    return statusReason;
  }
  const timeoutEvent = Array.isArray(parsed?.events)
    ? parsed.events.find((event) => event?.kind === 'timeout' && typeof event.reason === 'string')
    : null;
  return timeoutEvent?.reason || 'trace-limit';
}

function isTraceTimeoutReason(value) {
  return (
    value === 'trace-limit' ||
    value === 'line-limit' ||
    value === 'single-line-limit' ||
    value === 'recursion-limit' ||
    value === 'memory-limit' ||
    value === 'client-timeout'
  );
}

function extractUserErrorLine(diagnostics) {
  const match = diagnostics.match(new RegExp(`${escapeRegExp(CPP_USER_SOURCE_FILE)}:(\\d+):\\d+:`));
  return match ? Number(match[1]) : undefined;
}

function extractDiagnosticLocation(diagnostics) {
  const match = diagnostics.match(new RegExp(`(?:^|\\n)(${escapeRegExp(CPP_USER_SOURCE_FILE)}|TraceCodeDriver\\.cpp):(\\d+):(\\d+):\\s*(fatal error|error|warning|note):\\s*([^\\n]+)`));
  if (!match) return null;
  return {
    file: match[1],
    line: Number(match[2]),
    column: Number(match[3]),
    severity: match[4],
    message: match[5].trim(),
  };
}

function compileFailureResult(diagnostics, fallbackMessage, start, details = {}) {
  const cleanDiagnostics = (diagnostics || '').trim();
  const location = extractDiagnosticLocation(cleanDiagnostics);
  const userLine = location?.file === CPP_USER_SOURCE_FILE ? location.line : extractUserErrorLine(cleanDiagnostics);
  const prefix =
    location?.file === 'TraceCodeDriver.cpp'
      ? 'C++ generated driver failed'
      : location?.file === CPP_USER_SOURCE_FILE
        ? 'C++ compilation failed'
        : fallbackMessage;

  return {
    success: false,
    output: null,
    error: cleanDiagnostics ? `${prefix}: ${cleanDiagnostics}` : fallbackMessage,
    ...(userLine !== undefined ? { errorLine: userLine } : {}),
    ...(details.generatedSource ? { generatedSource: details.generatedSource } : {}),
    ...(details.diagnosticStage ? { diagnosticStage: details.diagnosticStage } : {}),
    consoleOutput: [],
    executionTimeMs: elapsedMs(start),
    timings: {
      ...(details.timings && typeof details.timings === 'object' ? details.timings : {}),
      totalMs: elapsedMs(start),
    },
  };
}

function splitNonEmptyOutputLines(value) {
  return String(value || '').split(/\r?\n/).filter(Boolean);
}

function programOutputDiagnostics(program, error) {
  return [
    program?.stderr,
    program?.stdout,
    error instanceof Error ? error.message : String(error),
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function programOutputParseFailureResult(error, program, signature, start, timings, options = {}) {
  const diagnostics = programOutputDiagnostics(program, error) || 'C++ program output could not be parsed.';
  const consoleOutput = [
    ...splitNonEmptyOutputLines(program?.stdout),
    ...splitNonEmptyOutputLines(program?.stderr),
  ];
  if (options.tracing) {
    const trace = finalizeRuntimeTrace(
      [{ kind: 'exception', line: signature.line, message: diagnostics }],
      options.traceOptions || {}
    ).trace;
    return {
      success: false,
      output: null,
      error: diagnostics,
      trace,
      consoleOutput,
      executionTimeMs: elapsedMs(start),
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
      timings: { ...timings, totalMs: elapsedMs(start) },
    };
  }
  return {
    success: false,
    output: null,
    error: diagnostics,
    consoleOutput,
    executionTimeMs: elapsedMs(start),
    timings: { ...timings, totalMs: elapsedMs(start) },
  };
}

async function runTool(module, fs, args) {
  emitRequestProgress(`tool:${args[0] || 'unknown'}:start`);
  const result = await runWasi(module, args, fs, {
    filestatSizeOffset: args[0] === 'wasm-ld' ? 24 : 32,
  });
  emitRequestProgress(`tool:${args[0] || 'unknown'}:complete`, { exitCode: result.exitCode });
  if (result.exitCode !== 0) {
    const message = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    const error = new Error(message || `${args[0]} exited with code ${result.exitCode}`);
    error.exitCode = result.exitCode;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}

function rejectPendingCompilerWorkerRequests(error) {
  for (const [, request] of pendingCompilerWorkerRequests) {
    clearTimeout(request.timeoutId);
    request.worker.onmessage = null;
    request.worker.onerror = null;
    request.worker.onmessageerror = null;
    request.worker.terminate();
    activeCompilerWorkers.delete(request.worker);
    request.reject(error);
  }
  pendingCompilerWorkerRequests.clear();
}

function resetCompilerWorker(error = new Error('C++ compiler worker was reset.')) {
  rejectPendingCompilerWorkerRequests(error);
  for (const worker of activeCompilerWorkers) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }
  activeCompilerWorkers.clear();
}

function finishCompilerWorkerRequest(id) {
  const request = pendingCompilerWorkerRequests.get(id);
  if (!request) return null;
  pendingCompilerWorkerRequests.delete(id);
  clearTimeout(request.timeoutId);
  request.worker.onmessage = null;
  request.worker.onerror = null;
  request.worker.onmessageerror = null;
  request.worker.terminate();
  activeCompilerWorkers.delete(request.worker);
  return request;
}

function createCompilerWorker(id) {
  const workerUrl = getCompilerWorkerUrl();
  if (!workerUrl) {
    throw new Error('Missing C++ compiler worker URL.');
  }

  const worker = new Worker(workerUrl, { type: 'module' });
  activeCompilerWorkers.add(worker);
  worker.onmessage = (event) => {
    const message = event.data || {};
    if (message.type === 'worker-ready') return;
    const request = pendingCompilerWorkerRequests.get(message.id);
    if (!request) return;
    if (message.protocolToken !== request.protocolToken) return;
    finishCompilerWorkerRequest(message.id);
    if (message.type !== 'compile-result') {
      request.reject(new Error(`Unexpected C++ compiler worker response: ${message.type}`));
      return;
    }
    request.resolve(message.payload || {});
  };
  worker.onerror = (event) => {
    const request = finishCompilerWorkerRequest(id);
    request?.reject(new Error(event.message || 'C++ compiler worker error'));
  };
  worker.onmessageerror = () => {
    const request = finishCompilerWorkerRequest(id);
    request?.reject(new Error('C++ compiler worker message failed to deserialize'));
  };
  return worker;
}

function runCompilerWorker(driverSource) {
  return new Promise((resolve, reject) => {
    const id = `compile-${++compilerWorkerRequestId}`;
    const protocolToken = `${id}-${Date.now()}-${Math.random()}`;
    let worker;
    try {
      worker = createCompilerWorker(id);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const timeoutId = setTimeout(() => {
      const request = finishCompilerWorkerRequest(id);
      request?.reject(new Error('C++ compiler worker request timed out.'));
    }, 120_000);
    pendingCompilerWorkerRequests.set(id, { protocolToken, resolve, reject, timeoutId, worker });
    worker.postMessage({
      id,
      type: 'compile',
      protocolToken,
      payload: {
        assets: configuredAssets,
        driverSource,
        standard: CPP_STANDARD,
        stackSize: CPP_PROGRAM_STACK_SIZE,
        usePrecompiledHeader,
      },
    });
  });
}

function runCompilerWorkerPayload(payload) {
  return new Promise((resolve, reject) => {
    const id = `compile-${++compilerWorkerRequestId}`;
    const protocolToken = `${id}-${Date.now()}-${Math.random()}`;
    let worker;
    try {
      worker = createCompilerWorker(id);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const timeoutId = setTimeout(() => {
      const request = finishCompilerWorkerRequest(id);
      request?.reject(new Error('C++ compiler worker request timed out.'));
    }, 120_000);
    pendingCompilerWorkerRequests.set(id, { protocolToken, resolve, reject, timeoutId, worker });
    worker.postMessage({
      id,
      type: 'compile',
      protocolToken,
      payload,
    });
  });
}

function requestExternalCompile(driverSource) {
  const requestId = String(++externalCompileRequestId);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingExternalCompiles.delete(requestId);
      reject(new Error('C++ external compiler request timed out.'));
    }, 120_000);

    pendingExternalCompiles.set(requestId, { resolve, reject, timeoutId, protocolToken: activeRequestProtocolToken });
    trustedCppWorkerPostMessage({
      type: 'compile-request',
      requestId,
      ...(activeRequestProtocolToken ? { protocolToken: activeRequestProtocolToken } : {}),
      payload: {
        assets: configuredAssets,
        driverSource,
        standard: CPP_STANDARD,
        stackSize: CPP_PROGRAM_STACK_SIZE,
        usePrecompiledHeader,
      },
    });
  });
}

function requestExternalCompilePayload(payload) {
  const requestId = String(++externalCompileRequestId);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingExternalCompiles.delete(requestId);
      reject(new Error('C++ external compiler request timed out.'));
    }, 120_000);

    pendingExternalCompiles.set(requestId, { resolve, reject, timeoutId, protocolToken: activeRequestProtocolToken });
    trustedCppWorkerPostMessage({
      type: 'compile-request',
      requestId,
      ...(activeRequestProtocolToken ? { protocolToken: activeRequestProtocolToken } : {}),
      payload,
    });
  });
}

function compileDriverOutsideMainWorker(driverSource) {
  if (canUseExternalCompilerHost()) {
    return requestExternalCompile(driverSource);
  }
  return runCompilerWorker(driverSource);
}

// BSD-socket support for C++ project programs. User code writes plain POSIX
// networking (<sys/socket.h>, <netinet/in.h>, <netdb.h>): send/recv/accept
// lower to standard WASI sock_* imports handled by the WasiProcess, while the
// calls WASI preview1 cannot express (socket/connect/bind/listen/getaddrinfo)
// come from an invisibly injected, auto-linked shim over the tracecode_kernel
// import module. Injected into the compile payload (not the toolchain) so all
// compile backends behave identically; the shim never appears in workspaces.
const CPP_KERNEL_SOCKET_HEADER_FILENAME = 'tracecode_socket.h';
const CPP_KERNEL_SOCKET_SHIM_FILENAME = 'tracecode_socket.c';
const CPP_KERNEL_NETDB_HEADER_FILENAME = 'netdb.h';

// Declarations wasi-libc's <sys/socket.h> is missing; force-included into
// every project TU so standard POSIX code compiles unchanged.
const CPP_KERNEL_SOCKET_HEADER_SOURCE = String.raw`#ifndef TRACECODE_SOCKET_DECLARATIONS
#define TRACECODE_SOCKET_DECLARATIONS

#ifdef __cplusplus
extern "C" {
#endif

struct sockaddr;

int socket(int __domain, int __type, int __protocol);
int connect(int __fd, const struct sockaddr* __addr, unsigned int __len);
int bind(int __fd, const struct sockaddr* __addr, unsigned int __len);
int listen(int __fd, int __backlog);
int getsockname(int __fd, struct sockaddr* __addr, unsigned int* __len);
int getpeername(int __fd, struct sockaddr* __addr, unsigned int* __len);
int setsockopt(int __fd, int __level, int __option, const void* __value, unsigned int __len);
int getsockopt(int __fd, int __level, int __option, void* __value, unsigned int* __len);

#ifdef __cplusplus
}
#endif

#endif
`;

// Minimal <netdb.h> for the wasi sysroot (which does not ship one), resolved
// through -idirafter so a real sysroot netdb.h would always win.
const CPP_KERNEL_NETDB_HEADER_SOURCE = String.raw`#ifndef _NETDB_H
#define _NETDB_H

#include <netinet/in.h>
#include <sys/socket.h>

#ifdef __cplusplus
extern "C" {
#endif

struct addrinfo {
  int ai_flags;
  int ai_family;
  int ai_socktype;
  int ai_protocol;
  socklen_t ai_addrlen;
  struct sockaddr* ai_addr;
  char* ai_canonname;
  struct addrinfo* ai_next;
};

#define AI_PASSIVE 0x01
#define AI_CANONNAME 0x02
#define AI_NUMERICHOST 0x04
#define AI_NUMERICSERV 0x400

#define EAI_BADFLAGS -1
#define EAI_NONAME -2
#define EAI_AGAIN -3
#define EAI_FAIL -4
#define EAI_FAMILY -6
#define EAI_SOCKTYPE -7
#define EAI_SERVICE -8
#define EAI_MEMORY -10
#define EAI_SYSTEM -11

int getaddrinfo(const char* __node, const char* __service, const struct addrinfo* __hints, struct addrinfo** __out);
void freeaddrinfo(struct addrinfo* __info);
const char* gai_strerror(int __code);

#ifdef __cplusplus
}
#endif

#endif
`;

const CPP_KERNEL_SOCKET_SHIM_SOURCE = String.raw`#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

#ifdef __cplusplus
extern "C" {
#endif

__attribute__((import_module("tracecode_kernel"), import_name("sock_open")))
int __tracecode_sock_open(int domain, int type);
__attribute__((import_module("tracecode_kernel"), import_name("sock_connect")))
int __tracecode_sock_connect(int fd, unsigned int ip, int port);
__attribute__((import_module("tracecode_kernel"), import_name("sock_bind")))
int __tracecode_sock_bind(int fd, unsigned int ip, int port);
__attribute__((import_module("tracecode_kernel"), import_name("sock_listen")))
int __tracecode_sock_listen(int fd, int backlog);
__attribute__((import_module("tracecode_kernel"), import_name("sock_port")))
int __tracecode_sock_port(int fd);
__attribute__((import_module("tracecode_kernel"), import_name("sock_resolve")))
int __tracecode_sock_resolve(const char* host, unsigned int length);

static int __tracecode_sock_errno(int rc) {
  if (rc < 0) {
    errno = -rc;
    return -1;
  }
  return rc;
}

static int __tracecode_sockaddr_in(const struct sockaddr* addr, unsigned int len, unsigned int* ip, int* port) {
  const struct sockaddr_in* v4;
  if (addr == 0 || len < (unsigned int)sizeof(struct sockaddr_in) || addr->sa_family != AF_INET) return -1;
  v4 = (const struct sockaddr_in*)addr;
  *ip = ntohl(v4->sin_addr.s_addr);
  *port = (int)ntohs(v4->sin_port);
  return 0;
}

int socket(int domain, int type, int protocol) {
  (void)protocol;
  return __tracecode_sock_errno(__tracecode_sock_open(domain, type));
}

int connect(int fd, const struct sockaddr* addr, unsigned int len) {
  unsigned int ip;
  int port;
  if (__tracecode_sockaddr_in(addr, len, &ip, &port) != 0) {
    errno = EAFNOSUPPORT;
    return -1;
  }
  return __tracecode_sock_errno(__tracecode_sock_connect(fd, ip, port));
}

int bind(int fd, const struct sockaddr* addr, unsigned int len) {
  unsigned int ip;
  int port;
  if (__tracecode_sockaddr_in(addr, len, &ip, &port) != 0) {
    errno = EAFNOSUPPORT;
    return -1;
  }
  return __tracecode_sock_errno(__tracecode_sock_bind(fd, ip, port));
}

int listen(int fd, int backlog) {
  return __tracecode_sock_errno(__tracecode_sock_listen(fd, backlog));
}

int getsockname(int fd, struct sockaddr* addr, unsigned int* len) {
  struct sockaddr_in v4;
  int port = __tracecode_sock_port(fd);
  if (port < 0) {
    errno = -port;
    return -1;
  }
  if (addr == 0 || len == 0 || *len < (unsigned int)sizeof(struct sockaddr_in)) {
    errno = EINVAL;
    return -1;
  }
  memset(&v4, 0, sizeof(v4));
  v4.sin_family = AF_INET;
  v4.sin_port = htons((unsigned short)port);
  v4.sin_addr.s_addr = htonl(0x7f000001u);
  memcpy(addr, &v4, sizeof(v4));
  *len = (unsigned int)sizeof(v4);
  return 0;
}

int getpeername(int fd, struct sockaddr* addr, unsigned int* len) {
  return getsockname(fd, addr, len);
}

int setsockopt(int fd, int level, int option, const void* value, unsigned int len) {
  (void)fd;
  (void)level;
  (void)option;
  (void)value;
  (void)len;
  return 0;
}

int getsockopt(int fd, int level, int option, void* value, unsigned int* len) {
  (void)fd;
  (void)level;
  (void)option;
  if (value != 0 && len != 0 && *len >= (unsigned int)sizeof(int)) {
    memset(value, 0, sizeof(int));
    *len = (unsigned int)sizeof(int);
  }
  return 0;
}

struct __tracecode_addrinfo_storage {
  struct addrinfo info;
  struct sockaddr_in address;
};

int getaddrinfo(const char* node, const char* service, const struct addrinfo* hints, struct addrinfo** out) {
  struct __tracecode_addrinfo_storage* storage;
  unsigned int ip = 0x7f000001u;
  int port = 0;
  if (out == 0) return EAI_FAIL;
  *out = 0;
  if (service != 0 && *service != 0) {
    if (*service >= '0' && *service <= '9') port = atoi(service);
    else if (strcmp(service, "http") == 0 || strcmp(service, "ws") == 0) port = 80;
    else if (strcmp(service, "https") == 0 || strcmp(service, "wss") == 0) port = 443;
    else return EAI_SERVICE;
  }
  if (node != 0 && *node != 0) {
    unsigned int numeric = (unsigned int)inet_addr(node);
    if (numeric != 0xffffffffu) {
      ip = ntohl(numeric);
    } else {
      int token = __tracecode_sock_resolve(node, (unsigned int)strlen(node));
      if (token <= 0) return EAI_NONAME;
      ip = (198u << 24) | (18u << 16) | (unsigned int)token;
    }
  } else if (hints != 0 && (hints->ai_flags & AI_PASSIVE) != 0) {
    ip = 0;
  }
  storage = (struct __tracecode_addrinfo_storage*)malloc(sizeof(struct __tracecode_addrinfo_storage));
  if (storage == 0) return EAI_MEMORY;
  memset(storage, 0, sizeof(*storage));
  storage->address.sin_family = AF_INET;
  storage->address.sin_port = htons((unsigned short)port);
  storage->address.sin_addr.s_addr = htonl(ip);
  storage->info.ai_family = AF_INET;
  storage->info.ai_socktype = (hints != 0 && hints->ai_socktype != 0) ? hints->ai_socktype : SOCK_STREAM;
  storage->info.ai_addrlen = (socklen_t)sizeof(struct sockaddr_in);
  storage->info.ai_addr = (struct sockaddr*)&storage->address;
  *out = &storage->info;
  return 0;
}

void freeaddrinfo(struct addrinfo* info) {
  free(info);
}

const char* gai_strerror(int code) {
  (void)code;
  return "hostname resolution failed";
}

#ifdef __cplusplus
}
#endif
`;

function cppProjectHasFileNamed(files, filename) {
  return files.some((file) => {
    const path = String(file?.path || '').replace(/\\/g, '/');
    return path === filename || path.endsWith(`/${filename}`);
  });
}

function projectWithCppKernelNetworkShims(project) {
  const files = Array.isArray(project?.files) ? project.files : [];
  const additions = [];
  if (!cppProjectHasFileNamed(files, CPP_KERNEL_SOCKET_HEADER_FILENAME)) {
    additions.push({ path: CPP_KERNEL_SOCKET_HEADER_FILENAME, contents: CPP_KERNEL_SOCKET_HEADER_SOURCE });
  }
  if (!cppProjectHasFileNamed(files, CPP_KERNEL_SOCKET_SHIM_FILENAME)) {
    additions.push({ path: CPP_KERNEL_SOCKET_SHIM_FILENAME, contents: CPP_KERNEL_SOCKET_SHIM_SOURCE });
  }
  if (!cppProjectHasFileNamed(files, CPP_KERNEL_NETDB_HEADER_FILENAME)) {
    additions.push({ path: CPP_KERNEL_NETDB_HEADER_FILENAME, contents: CPP_KERNEL_NETDB_HEADER_SOURCE });
  }
  if (additions.length === 0) return project;
  return {
    ...(project && typeof project === 'object' ? project : {}),
    files: [...files, ...additions],
  };
}

function cppProjectArgsWithKernelNetwork(args, project) {
  const files = Array.isArray(project?.files) ? project.files : [];
  const injected = [];
  if (!cppProjectHasFileNamed(files, CPP_KERNEL_SOCKET_HEADER_FILENAME)) {
    injected.push('-include', CPP_KERNEL_SOCKET_HEADER_FILENAME);
  }
  injected.push('-idirafter', '.');
  const linking = !args.some((arg) => arg === '-c' || arg === '-S' || arg === '-E');
  if (linking && !cppProjectHasFileNamed(files, CPP_KERNEL_SOCKET_SHIM_FILENAME)) {
    injected.push(CPP_KERNEL_SOCKET_SHIM_FILENAME);
  }
  return [...injected, ...args];
}

function compileProjectOutsideMainWorker(request) {
  const payload = {
    assets: configuredAssets,
    project: projectWithCppKernelNetworkShims(request.project),
    cwd: requestCwdRelative(request),
    args: cppProjectArgsWithKernelNetwork(projectCompileArgs(request), request.project),
    compilerCommand: projectCompilerCommand(request),
    sourceInput: request?.code || '',
    includePaths: projectCompileIncludePaths(request),
    workspaceOutputPath: projectCompileWorkspaceOutputPath(request),
    standard: CPP_STANDARD,
    stackSize: CPP_PROGRAM_STACK_SIZE,
  };
  if (canUseExternalCompilerHost()) {
    return requestExternalCompilePayload(payload);
  }
  return runCompilerWorkerPayload(payload);
}

function projectCompilerCommand(request) {
  const command = String(request?.options?.compilerCommand || 'clang++');
  return command === 'clang' || command === 'gcc' || command === 'cc' ? 'clang' : 'clang++';
}

function projectPathBytes(file) {
  return file?.encoding === 'base64'
    ? decodeBase64(String(file.contents || ''))
    : encodeUtf8(String(file?.contents || ''));
}

function projectKernelDevices(project) {
  const entries = Array.isArray(project?.kernelDevices) ? project.kernelDevices : [];
  const devices = new Map();
  for (const entry of entries) {
    const path = normalizeRuntimeKernelDeviceReference(entry?.path || '');
    if (!path) continue;
    const inputDevice = normalizeRuntimeKernelDeviceReference(entry?.inputDevice || '') || path;
    const outputDevice = normalizeRuntimeKernelDeviceReference(entry?.outputDevice || '') || path;
    devices.set(path, {
      path,
      readable: entry?.readable === true,
      writable: entry?.writable === true,
      inputDevice: entry?.readable === true ? inputDevice : '',
      outputDevice: entry?.writable === true ? outputDevice : '',
    });
  }
  return devices;
}

function standaloneKernelDevices() {
  return new Map([
    ['/dev/null', { path: '/dev/null', readable: true, writable: true, inputDevice: '/dev/null', outputDevice: '/dev/null' }],
    ['/dev/stdin', { path: '/dev/stdin', readable: true, writable: false, inputDevice: '/dev/stdin', outputDevice: '' }],
    ['/dev/stdout', { path: '/dev/stdout', readable: false, writable: true, inputDevice: '', outputDevice: '/dev/stdout' }],
    ['/dev/stderr', { path: '/dev/stderr', readable: false, writable: true, inputDevice: '', outputDevice: '/dev/stderr' }],
    ['/dev/tty', { path: '/dev/tty', readable: true, writable: true, inputDevice: '/dev/stdin', outputDevice: '/dev/stdout' }],
  ]);
}

function wasiKernelDevices(options) {
  return options.kernelDevices instanceof Map ? options.kernelDevices : standaloneKernelDevices();
}

function projectKernelVirtualFiles(project) {
  const files = Array.isArray(project?.kernelFiles) ? project.kernelFiles : [];
  return files
    .filter((file) => {
      if (!file || typeof file.path !== 'string') return false;
      const path = normalizePath(file.path);
      return path.startsWith('/') && !isRuntimeDeviceNamespacePath(path);
    })
    .map((file) => ({
      path: normalizePath(file.path),
      contents: projectPathBytes(file),
    }));
}

function projectFromContext(context) {
  return context?.project && typeof context.project === 'object' ? context.project : context;
}

function normalizeProjectRoot(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!raw || !raw.startsWith('/')) return '';
  return raw || '/';
}

function projectWorkspaceRoots(context) {
  const project = projectFromContext(context) || {};
  const roots = [];
  for (const value of [project.workspaceRoot, project.cwd, project.workspaceAlias, '/workspace']) {
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

function relativeProjectPath(pathname, context) {
  const raw = String(pathname || '').replace(/\\/g, '/');
  const stripped = stripProjectWorkspaceRoot(context, raw);
  const withoutWorkspace = stripped === null ? raw.replace(/^\/+/, '') : stripped;
  const parts = [];
  for (const part of withoutWorkspace.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`Project path escapes workspace: ${pathname}`);
    parts.push(part);
  }
  return parts.join('/');
}

function relativeProjectOperandPath(pathname, context) {
  const raw = String(pathname || '').replace(/\\/g, '/');
  const stripped = stripProjectWorkspaceRoot(context, raw);
  const withoutWorkspace = stripped === null ? raw.replace(/^\/+/, '') : stripped;
  const parts = [];
  for (const part of withoutWorkspace.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) throw new Error(`Project path escapes workspace: ${pathname}`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function requestCwdRelative(request) {
  const defaultRoot = projectWorkspaceRoots(request)[0] || '/workspace';
  const cwd = String(request?.cwd || defaultRoot).replace(/\\/g, '/');
  if (!cwd.startsWith('/')) return relativeProjectOperandPath(cwd, request);
  const stripped = stripProjectWorkspaceRoot(request, cwd);
  if (stripped !== null) {
    return relativeProjectPath(stripped, request);
  }
  throw new Error(`Project cwd must stay inside the workspace: ${cwd}`);
}

function resolveProjectRequestPath(request, value, fallback = '') {
  const text = String(value || fallback);
  if (!text || text === '<compile>' || text === '<project>') return fallback;
  if (text.startsWith('/')) {
    const stripped = stripProjectWorkspaceRoot(request, text);
    if (stripped === null) throw new Error(`Project path escapes workspace: ${text}`);
    return relativeProjectPath(stripped, request);
  }
  const cwd = requestCwdRelative(request);
  return relativeProjectOperandPath(cwd ? `${cwd}/${text}` : text, request);
}

function projectPathRelativeToWorkspace(request, value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.startsWith('/')) {
    const stripped = stripProjectWorkspaceRoot(request, text);
    if (stripped === null) throw new Error(`Project path escapes workspace: ${text}`);
    return relativeProjectPath(stripped, request);
  }
  const cwd = requestCwdRelative(request);
  return relativeProjectOperandPath(cwd ? `${cwd}/${text}` : text, request);
}

function projectCompilerPathArg(request, value) {
  const text = String(value || '');
  const path = projectPathRelativeToWorkspace(request, text);
  const cwd = requestCwdRelative(request);
  if (cwd && (path === cwd || path.startsWith(`${cwd}/`))) {
    return path === cwd ? '.' : path.slice(cwd.length + 1);
  }
  return path;
}

function projectCompilerIncludePathArg(request, value) {
  const text = String(value || '');
  if (!text) return text;
  projectPathRelativeToWorkspace(request, text);
  return '.';
}

function projectCompilerLibraryPathArg(request, value) {
  const text = String(value || '');
  if (!text) return text;
  projectPathRelativeToWorkspace(request, text);
  return '.';
}

function projectCompilerSourcePathArg(request, value) {
  const text = String(value || '');
  if (text && !text.startsWith('/')) {
    projectPathRelativeToWorkspace(request, text);
    if (text.includes('../')) return basename(text);
    return text;
  }
  return projectCompilerPathArg(request, text);
}

function projectCompilerOutputPathArg(request, value) {
  const mapped = projectCompilerPathArg(request, value);
  const index = mapped.lastIndexOf('/');
  return index >= 0 ? mapped.slice(index + 1) || 'a.out' : mapped || 'a.out';
}

function projectCompilerLinkerArtifactPathArg(request, value) {
  const mapped = projectCompilerPathArg(request, value);
  const index = mapped.lastIndexOf('/');
  return index >= 0 ? mapped.slice(index + 1) || mapped : mapped;
}

function projectEnvPathList(request, name) {
  const raw = request?.env && typeof request.env[name] === 'string' ? request.env[name] : '';
  return raw
    .split(/[:;]/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function projectCompileEnvIncludePaths(request) {
  const paths = [
    ...projectEnvPathList(request, 'CPATH'),
  ];
  if (projectCompilerCommand(request) === 'clang') {
    paths.push(...projectEnvPathList(request, 'C_INCLUDE_PATH'));
  } else {
    paths.push(...projectEnvPathList(request, 'CPLUS_INCLUDE_PATH'));
  }
  return paths;
}

function projectCompileEnvLibraryPaths(request) {
  return projectEnvPathList(request, 'LIBRARY_PATH');
}

function projectCompileIncludePaths(request) {
  const args = Array.isArray(request?.args) && request.args.length > 0
    ? request.args.map(String)
    : [request?.scriptPath || 'main.cpp'];
  const includePaths = projectCompileEnvIncludePaths(request).map((path) => resolveProjectRequestPath(request, path, path));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-I' || arg === '-isystem') {
      const value = args[index + 1];
      if (typeof value === 'string') {
        includePaths.push(resolveProjectRequestPath(request, value, value));
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('-I') && arg.length > 2 && !arg.startsWith('-include')) {
      includePaths.push(resolveProjectRequestPath(request, arg.slice(2), arg.slice(2)));
      continue;
    }
    if (arg.startsWith('-isystem') && arg.length > '-isystem'.length) {
      includePaths.push(resolveProjectRequestPath(request, arg.slice('-isystem'.length), arg.slice('-isystem'.length)));
    }
  }
  return [...new Set(includePaths.filter(Boolean))];
}

function projectCompileWorkspaceOutputPath(request) {
  const args = Array.isArray(request?.args) && request.args.length > 0
    ? request.args.map(String)
    : [request?.scriptPath || 'main.cpp'];
  const outputIndex = args.indexOf('-o');
  const cwd = requestCwdRelative(request);
  if (outputIndex < 0) {
    const inlineOutputArg = args.find((arg) => arg.startsWith('-o') && arg.length > 2);
    if (inlineOutputArg) {
      const inlineValue = inlineOutputArg.slice(2);
      if (inlineValue.startsWith('/')) {
        const stripped = stripProjectWorkspaceRoot(request, inlineValue);
        if (stripped === null) throw new Error(`Project path escapes workspace: ${inlineValue}`);
        return relativeProjectPath(stripped, request);
      }
      return relativeProjectOperandPath(cwd ? `${cwd}/${inlineValue}` : inlineValue, request);
    }
    return relativeProjectOperandPath(cwd ? `${cwd}/a.out` : 'a.out', request);
  }
  const value = args[outputIndex + 1] || 'a.out';
  if (value.startsWith('/')) {
    const stripped = stripProjectWorkspaceRoot(request, value);
    if (stripped === null) throw new Error(`Project path escapes workspace: ${value}`);
    return relativeProjectPath(stripped, request);
  }
  return relativeProjectOperandPath(cwd ? `${cwd}/${value}` : value, request);
}

function projectCompileArgs(request) {
  const args = Array.isArray(request?.args) && request.args.length > 0
    ? request.args.map(String)
    : [request?.scriptPath || 'main.cpp'];
  const cwd = requestCwdRelative(request);
  const mapped = [];
  for (const path of projectCompileEnvIncludePaths(request)) {
    mapped.push('-I', projectCompilerIncludePathArg(request, path));
  }
  for (const path of projectCompileEnvLibraryPaths(request)) {
    mapped.push('-L', projectCompilerLibraryPathArg(request, path));
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-o') {
      mapped.push(arg);
      const value = args[index + 1];
      if (typeof value === 'string') {
        mapped.push(projectCompilerOutputPathArg(request, value));
        index += 1;
      }
      continue;
    }
    if (arg === '-I' || arg === '-isystem') {
      mapped.push(arg);
      const value = args[index + 1];
      if (typeof value === 'string') {
        mapped.push(projectCompilerIncludePathArg(request, value));
        index += 1;
      }
      continue;
    }
    if (arg === '-L') {
      mapped.push(arg);
      const value = args[index + 1];
      if (typeof value === 'string') {
        mapped.push(projectCompilerLibraryPathArg(request, value));
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('-I') && arg.length > 2 && !arg.startsWith('-include')) {
      mapped.push('-I.');
      projectPathRelativeToWorkspace(request, arg.slice(2));
      continue;
    }
    if (arg.startsWith('-L') && arg.length > 2) {
      mapped.push('-L.');
      projectPathRelativeToWorkspace(request, arg.slice(2));
      continue;
    }
    if (arg.startsWith('-isystem') && arg.length > '-isystem'.length) {
      mapped.push('-isystem.');
      projectPathRelativeToWorkspace(request, arg.slice('-isystem'.length));
      continue;
    }
    if (arg.startsWith('-o') && arg.length > 2) {
      mapped.push('-o', projectCompilerOutputPathArg(request, arg.slice(2)));
      continue;
    }
    if (/^(?:[^-].*\.(?:c|cc|cpp|cxx|h|hpp|hh))$/i.test(arg)) {
      mapped.push(projectCompilerSourcePathArg(request, arg));
      continue;
    }
    if (/^\/.*\.(?:a|lib|o|obj)$/i.test(arg) && stripProjectWorkspaceRoot(request, arg) !== null) {
      mapped.push(projectCompilerLinkerArtifactPathArg(request, arg));
      continue;
    }
    mapped.push(arg);
  }
  if (!mapped.includes('-o')) {
    mapped.push('-o', relativeProjectOperandPath(cwd ? `${cwd}/a.out` : 'a.out'));
  }
  return mapped;
}

function createProjectRuntimeFs(project) {
  const fs = new InMemoryFileSystem();
  for (const directory of project?.directories || []) {
    const path = relativeProjectPath(directory, project);
    if (path) fs.addDirectory(`/${path}`);
  }
  for (const file of project?.files || []) {
    const path = relativeProjectPath(file.path, project);
    if (path) fs.addFile(`/${path}`, projectPathBytes(file));
  }
  for (const file of projectKernelVirtualFiles(project)) {
    fs.addReadOnlyFile(file.path, file.contents);
  }
  return fs;
}

function snapshotProjectFs(fs) {
  const files = new Map();
  for (const [path, bytes] of fs.files.entries()) {
    if (isRuntimeProcPath(path)) continue;
    const relativePath = relativeProjectPath(path);
    if (relativePath) files.set(relativePath, cloneBytes(bytes));
  }
  const directories = new Set();
  for (const path of fs.dirs) {
    if (path === '/' || isRuntimeProcPath(path)) continue;
    const relativePath = relativeProjectPath(path);
    if (relativePath) directories.add(relativePath);
  }
  return { files, directories };
}

function encodeProjectFileChange(path, bytes) {
  const text = decodeUtf8(bytes);
  if (arraysEqual(encodeUtf8(text), bytes)) {
    return { path, contents: text };
  }
  return { path, contents: encodeBase64(bytes), encoding: 'base64' };
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function diffProjectFs(before, fs) {
  const after = snapshotProjectFs(fs);
  const changes = [];
  for (const path of [...after.directories].sort()) {
    if (before.directories.has(path)) {
      before.directories.delete(path);
      continue;
    }
    changes.push({ path, directory: true });
  }
  for (const [path, bytes] of [...after.files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const oldBytes = before.files.get(path);
    before.files.delete(path);
    if (oldBytes && arraysEqual(oldBytes, bytes)) continue;
    changes.push(encodeProjectFileChange(path, bytes));
  }
  for (const path of [...before.files.keys()].sort()) {
    changes.push({ path, deleted: true });
  }
  for (const path of [...before.directories].sort((left, right) => right.length - left.length || left.localeCompare(right))) {
    changes.push({ path, directory: true, deleted: true });
  }
  return changes;
}

function cppUserFacingDiagnosticFile(request) {
  try {
    const scriptPath = projectPathRelativeToWorkspace(request, request?.scriptPath || '');
    return scriptPath || 'main.cpp';
  } catch {
    return basename(String(request?.scriptPath || 'main.cpp')) || 'main.cpp';
  }
}

function sanitizeCppProjectDiagnostics(value, request) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const userFile = cppUserFacingDiagnosticFile(request);
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\/tmp\/TraceCodeDriver\.cpp/g, userFile)
    .replace(/\bTraceCodeDriver\.cpp\b/g, userFile)
    .split('\n')
    .filter((line) => {
      const lowered = line.toLowerCase();
      return !(
        lowered.includes('tracecode_runtime.hpp') ||
        lowered.includes('tracecode_statvfs.c') ||
        lowered.includes('tracecode_socket.c') ||
        lowered.includes('tracecode_socket.h') ||
        lowered.includes('/tracecode_runtime.hpp') ||
        lowered.includes('tracecode::')
      );
    })
    .join('\n');
}

function createProjectEventBridge(messageId, sanitizeOutput) {
  const budget = createProjectEventBudget('C++');
  const eventStdout = [];
  const eventStderr = [];

  function postBudgetedEvent(payload) {
    const budgetedPayload = budget.apply(payload);
    if (!budgetedPayload) return;
    if (budgetedPayload.type === 'output' && typeof budgetedPayload.data === 'string') {
      const outputBuffer = budgetedPayload.stream === 'stderr' ? eventStderr : eventStdout;
      outputBuffer.push(budgetedPayload.data);
    }
    postProjectEvent(messageId, budgetedPayload);
  }

  return {
    output(stream, data, device, outputDevice) {
      if (!data) return;
      const outputData = typeof sanitizeOutput === 'function' ? sanitizeOutput(stream, data) : data;
      if (!outputData) return;
      const resolvedOutputDevice = outputDevice || (stream === 'stderr' ? '/dev/stderr' : '/dev/stdout');
      postBudgetedEvent({
        type: 'output',
        stream,
        device: resolvedOutputDevice,
        ...(device && device !== resolvedOutputDevice ? { sourceDevice: device } : {}),
        data: outputData,
      });
    },
    fileChange(change) {
      postBudgetedEvent({ type: 'file-change', phase: 'live', change });
    },
    fileBytesChange(path, bytes) {
      if (!budget.reserveLiveFileChangeSize(path, bytes?.byteLength ?? 0)) return;
      postProjectEvent(messageId, { type: 'file-change', phase: 'live', change: encodeProjectFileChange(path, bytes) });
    },
    applyResultOutputBudget(result) {
      if (!result) return;
      if (budget.truncatedOutputStreams.has('stdout')) {
        result.stdout = eventStdout.join('');
      }
      if (budget.truncatedOutputStreams.has('stderr')) {
        result.stderr = eventStderr.join('');
      }
    },
  };
}

function emitProjectResultOutputEvents(events, result) {
  if (!events || !result) return;
  if (typeof result.stdout === 'string' && result.stdout.length > 0) {
    events.output('stdout', result.stdout);
  }
  if (typeof result.stderr === 'string' && result.stderr.length > 0) {
    events.output('stderr', result.stderr);
  }
  events.applyResultOutputBudget?.(result);
}

async function handleProjectCpp(request, messageId) {
  const events = createProjectEventBridge(messageId, (stream, data) =>
    stream === 'stderr' ? sanitizeCppProjectDiagnostics(data, request) : data
  );
  if (request?.source === 'compile') {
    const startedAt = now();
    const compileResult = await compileProjectOutsideMainWorker(request);
    if (!compileResult.success) {
      const stderr = sanitizeCppProjectDiagnostics(
        [compileResult.stderr, compileResult.error].filter(Boolean).join('\n').trim(),
        request
      );
      const failureResult = {
        stdout: compileResult.stdout || '',
        stderr: stderr ? `${stderr}\n` : 'C++ compilation failed.\n',
        exitCode: 1,
      };
      emitProjectResultOutputEvents(events, failureResult);
      return failureResult;
    }
    const outputPath = relativeProjectPath(compileResult.outputPath || 'a.out', request) || 'a.out';
    const programBytes = new Uint8Array(compileResult.programBuffer);
    const result = {
      stdout: compileResult.stdout || '',
      stderr: sanitizeCppProjectDiagnostics(compileResult.stderr || '', request),
      exitCode: 0,
      files: [encodeProjectFileChange(outputPath, programBytes)],
      timings: {
        compileMs: compileResult.compileMs,
        totalMs: elapsedMs(startedAt),
      },
    };
    emitProjectResultOutputEvents(events, result);
    return result;
  }

  const fs = createProjectRuntimeFs(request?.project);
  const before = snapshotProjectFs(fs);
  fs.setFileChangeObserver((change) => {
    const relativePath = relativeProjectPath(change.path, request?.project);
    if (!relativePath) return;
    if (change.directory) {
      events.fileChange({ path: relativePath, directory: true, ...(change.deleted ? { deleted: true } : {}) });
      return;
    }
    if (change.deleted) {
      events.fileChange({ path: relativePath, deleted: true });
      return;
    }
    events.fileBytesChange(relativePath, change.bytes);
  });
  const executablePath = `/${resolveProjectRequestPath(request, request?.scriptPath || './a.out', 'a.out')}`;
  if (!fs.isFile(executablePath)) {
    return {
      stdout: '',
      stderr: `${request?.scriptPath || './a.out'}: executable not found\n`,
      exitCode: 127,
    };
  }
  const startedAt = now();
  const module = await WebAssembly.compile(fs.readFile(executablePath));
  const kernelHttp = new CppKernelHttpSyncBridge(messageId);
  let program;
  try {
    program = await runWasi(module, [basename(executablePath), ...(request?.args || []).map(String)], fs, {
      cwd: `/${requestCwdRelative(request)}`,
      stdinPipe: request?.stdinPipe,
      env: request?.env || { USER: 'tracecode' },
      kernelDevices: projectKernelDevices(request?.project),
      kernelHttp,
      outputBudget: createProjectOutputByteBudget(),
      onOutput: (stream, data, device, outputDevice) => events.output(stream, data, device, outputDevice),
    });
  } finally {
    kernelHttp.closeAll();
  }
  const result = {
    stdout: program.stdout,
    stderr: sanitizeCppProjectDiagnostics(program.stderr, request),
    exitCode: program.exitCode,
    files: diffProjectFs(before, fs),
    timings: {
      runMs: elapsedMs(startedAt),
      totalMs: elapsedMs(startedAt),
    },
  };
  events.applyResultOutputBudget(result);
  return result;
}

async function compileAndRun(source, functionName, inputs, options = {}) {
  const start = now();
  emitRequestProgress('compile-and-run:start', { tracing: Boolean(options.tracing) });
  if (canUseEphemeralCompilerWorker()) {
    try {
      return await compileAndRunWithExternalCompiler(source, functionName, inputs, start, {
        ...options,
        timings: {
          ...(options.timings && typeof options.timings === 'object' ? options.timings : {}),
          toolchainLoadMs: 0,
        },
      });
    } catch {
      // Fall through to the in-worker compiler path when nested workers are not
      // available or an older deployment is missing the compiler worker asset.
    }
  }

  const toolchainStartedAt = now();
  emitRequestProgress('toolchain-load:start', { tracing: Boolean(options.tracing) });
  const toolchain = await loadToolchain();
  emitRequestProgress('toolchain-load:complete', { tracing: Boolean(options.tracing) });
  const timings = {
    ...(options.timings && typeof options.timings === 'object' ? options.timings : {}),
    toolchainLoadMs: elapsedMs(toolchainStartedAt),
  };
  if (toolchain.compiler === 'yowasp') {
    return compileAndRunWithYowasp(toolchain, source, functionName, inputs, start, {
      ...options,
      timings,
    });
  }
  const fs = toolchain.baseFs.clone();
  const resourceDir = findClangResourceDir(fs);
  const preparedDriverSource = typeof options.preparedDriverSource === 'string' ? options.preparedDriverSource : null;
  const stdinText = typeof options.stdinText === 'string' ? options.stdinText : JSON.stringify(inputs || {});
  const scriptRequest = !preparedDriverSource && isScriptExecutionRequest(functionName, options);
  const signature = scriptRequest
    ? { line: 1 }
    : options.executionStyle === 'ops-class'
    ? { line: 1 }
    : parseMethodSignature(source, functionName, {
        parameterCount: Object.keys(inputs || {}).length,
        inputNames: Object.keys(inputs || {}),
      });
  let driverSource = preparedDriverSource;
  if (!driverSource) {
    const driverStartedAt = now();
    emitRequestProgress('driver-build:start', { tracing: Boolean(options.tracing) });
    driverSource = scriptRequest
      ? buildScriptDriverSource(source, options)
      : options.executionStyle === 'ops-class'
      ? buildOpsClassDriverSource(source, functionName, inputs || {}, options)
      : buildDriverSource(source, functionName, inputs || {}, options);
    timings.driverBuildMs = elapsedMs(driverStartedAt);
    emitRequestProgress('driver-build:complete', { tracing: Boolean(options.tracing) });
  }

  fs.addDirectory('/tmp');
  fs.addFile('/tmp/TraceCodeDriver.cpp', driverSource);

  const cacheKey = getProgramCacheKey(toolchain.compiler, driverSource);
  let programModule = getCachedProgramModule(cacheKey);
  if (programModule) {
    timings.compileCacheHit = true;
    timings.compileMs = 0;
    timings.linkMs = 0;
    timings.wasmCompileMs = 0;
  } else {
    timings.compileCacheHit = false;
    const clangArgs = [
      'clang',
      '-cc1',
      '-triple',
      'wasm32-unknown-wasi',
      '-emit-obj',
      '-disable-free',
      '-isysroot',
      '/',
      '-internal-isystem',
      '/include/c++/v1',
      '-internal-isystem',
      '/include',
      '-internal-isystem',
      `${resourceDir}/include`,
      '-ferror-limit',
      '19',
      '-fmessage-length',
      '120',
      `-std=${CPP_STANDARD}`,
      '-O0',
      '-o',
      '/tmp/program.o',
      '-x',
      'c++',
      '/tmp/TraceCodeDriver.cpp',
    ];

    try {
      const compileStartedAt = now();
      emitRequestProgress('compile:start', { tracing: Boolean(options.tracing) });
      await runTool(toolchain.clangModule, fs, clangArgs);
      timings.compileMs = elapsedMs(compileStartedAt);
      emitRequestProgress('compile:complete', { tracing: Boolean(options.tracing), compileMs: timings.compileMs });
    } catch (error) {
      const diagnostics = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim();
      return compileFailureResult(diagnostics, 'C++ compilation failed.', start, {
        generatedSource: options?.traceOptions?.includeGeneratedSource ? driverSource : undefined,
        diagnosticStage: options.tracing ? 'trace-driver-compile' : 'driver-compile',
        timings,
      });
    }

    const libDir = fs.isDirectory('/lib/wasm32-wasi') ? '/lib/wasm32-wasi' : '/lib';
    const crt1 = fs.isFile(`${libDir}/crt1.o`) ? `${libDir}/crt1.o` : '/lib/wasm32-wasi/crt1.o';
    const lldArgs = [
      'wasm-ld',
      '--no-threads',
      '--export-dynamic',
      '-z',
      `stack-size=${CPP_PROGRAM_STACK_SIZE}`,
      `-L${libDir}`,
      crt1,
      '/tmp/program.o',
      '-lc',
      '-lc++',
      '-lc++abi',
      ...(fs.isFile(`${libDir}/libcanvas.a`) ? ['-lcanvas'] : []),
      '-o',
      '/tmp/program.wasm',
    ];

    try {
      const linkStartedAt = now();
      emitRequestProgress('link:start', { tracing: Boolean(options.tracing) });
      await runTool(toolchain.lldModule, fs, lldArgs);
      timings.linkMs = elapsedMs(linkStartedAt);
      emitRequestProgress('link:complete', { tracing: Boolean(options.tracing), linkMs: timings.linkMs });
    } catch (error) {
      const diagnostics = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim();
      return compileFailureResult(diagnostics, 'C++ linking failed.', start, {
        generatedSource: options?.traceOptions?.includeGeneratedSource ? driverSource : undefined,
        diagnosticStage: 'driver-link',
        timings,
      });
    }

    const wasmCompileStartedAt = now();
    emitRequestProgress('wasm-compile:start', { tracing: Boolean(options.tracing) });
    programModule = await WebAssembly.compile(fs.readFile('/tmp/program.wasm'));
    timings.wasmCompileMs = elapsedMs(wasmCompileStartedAt);
    emitRequestProgress('wasm-compile:complete', { tracing: Boolean(options.tracing), wasmCompileMs: timings.wasmCompileMs });
    storeProgramModule(cacheKey, programModule);
  }

  try {
    const runStartedAt = now();
    emitRequestProgress('program-run:start', { tracing: Boolean(options.tracing) });
    const program = await runWasi(programModule, ['program.wasm'], fs, {
      stdinBytes: staticStdinBytesFromText(stdinText),
    });
    timings.runMs = elapsedMs(runStartedAt);
    emitRequestProgress('program-run:complete', { tracing: Boolean(options.tracing), runMs: timings.runMs, exitCode: program.exitCode });
    let parsed;
    try {
      parsed = parseProgramStdout(program.stdout, {
        tracing: options.tracing,
        defaultLine: signature.line,
        allowMissingResult: options.tracing,
      });
    } catch (parseError) {
      return programOutputParseFailureResult(parseError, program, signature, start, timings, options);
    }
    if (scriptRequest && options.tracing) {
      parsed.events = normalizeScriptTraceEvents(parsed.events, scriptLineCount(source));
    }
    const programTimedOut = options.tracing && program.exitCode === 124;
    const runtimeTimedOut = !options.tracing && program.exitCode === 124;
    const baseResult = {
      success: program.exitCode === 0 && !programTimedOut,
      output: parsed.output,
      error: program.exitCode === 0 ? undefined : program.stderr || `C++ program exited with code ${program.exitCode}`,
      consoleOutput: [...parsed.consoleOutput, ...program.stderr.split(/\r?\n/).filter(Boolean)],
      executionTimeMs: elapsedMs(start),
      timings: { ...timings, totalMs: elapsedMs(start) },
      ...(runtimeTimedOut ? { timeoutReason: 'client-timeout', diagnosticStage: 'runtime' } : {}),
    };
    if (!options.tracing) return baseResult;
    if (options.batchTrace === true) {
      const inputBatch = Array.isArray(options.inputBatch) ? options.inputBatch : [];
      const batchTraceResult = cppBatchTraceResultsFromParsedOutput(parsed, source, inputBatch, timings, start, options);
      if (program.exitCode !== 0 || programTimedOut) {
        return {
          ...batchTraceResult,
          success: false,
          error: programTimedOut ? 'C++ trace budget exceeded.' : (program.stderr || `C++ program exited with code ${program.exitCode}`),
        };
      }
      return batchTraceResult;
    }
    const finalizedTrace = finalizeRuntimeTrace(parsed.events, { ...(options.traceOptions || {}), sourceCode: source });
    const { trace } = finalizedTrace;
    const runtimeTraceLimitExceeded = finalizedTrace.traceLimitExceeded || Boolean(parsed.traceStatus?.traceLimitExceeded) || programTimedOut;
    const droppedEventCount = (finalizedTrace.droppedEventCount || 0) + (Number(parsed.traceStatus?.droppedEventCount) || 0);
    const timeoutReason = timeoutReasonForParsedTrace(parsed);
    return {
      ...baseResult,
      ...(programTimedOut ? { error: 'C++ trace budget exceeded.' } : {}),
      trace,
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
      traceLimitExceeded: runtimeTraceLimitExceeded,
      ...(runtimeTraceLimitExceeded ? { timeoutReason } : {}),
      ...(runtimeTraceLimitExceeded ? { droppedEventCount } : {}),
    };
  } catch (error) {
    if (options.tracing) {
      const trace = finalizeRuntimeTrace(
        [{ kind: 'exception', line: signature.line, message: error instanceof Error ? error.message : String(error) }],
        { ...(options.traceOptions || {}), sourceCode: source }
      ).trace;
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        trace,
        consoleOutput: [],
        executionTimeMs: elapsedMs(start),
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
        timings: { ...timings, totalMs: elapsedMs(start) },
      };
    }
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      executionTimeMs: elapsedMs(start),
      timings: { ...timings, totalMs: elapsedMs(start) },
    };
  }
}

async function compileAndRunWithExternalCompiler(source, functionName, inputs, start, options = {}) {
  const timings = {
    ...(options.timings && typeof options.timings === 'object' ? options.timings : {}),
  };
  const preparedDriverSource = typeof options.preparedDriverSource === 'string' ? options.preparedDriverSource : null;
  const stdinText = typeof options.stdinText === 'string' ? options.stdinText : JSON.stringify(inputs || {});
  const scriptRequest = !preparedDriverSource && isScriptExecutionRequest(functionName, options);
  const signature = scriptRequest
    ? { line: 1 }
    : options.executionStyle === 'ops-class'
    ? { line: 1 }
    : parseMethodSignature(source, functionName, {
        parameterCount: Object.keys(inputs || {}).length,
        inputNames: Object.keys(inputs || {}),
      });
  let driverSource = preparedDriverSource;
  if (!driverSource) {
    const driverStartedAt = now();
    emitRequestProgress('driver-build:start', { tracing: Boolean(options.tracing), compiler: 'external' });
    const rawDriverSource = scriptRequest
      ? buildScriptDriverSource(source, options)
      : options.executionStyle === 'ops-class'
      ? buildOpsClassDriverSource(source, functionName, inputs || {}, options)
      : buildDriverSource(source, functionName, inputs || {}, options);
    driverSource = rawDriverSource.replace(
      '#include "/tracecode_runtime.hpp"',
      '#include "tracecode_runtime.hpp"'
    );
    timings.driverBuildMs = elapsedMs(driverStartedAt);
    emitRequestProgress('driver-build:complete', { tracing: Boolean(options.tracing), compiler: 'external' });
  }
  driverSource = driverSource.replace(
    '#include "/tracecode_runtime.hpp"',
    '#include "tracecode_runtime.hpp"'
  );

  const cacheKey = getProgramCacheKey('yowasp-worker', driverSource);
  let programModule = getCachedProgramModule(cacheKey);
  if (programModule) {
    timings.compileCacheHit = true;
    timings.compileMs = 0;
    timings.compilerWorkerMs = 0;
    timings.wasmCompileMs = 0;
  } else {
    timings.compileCacheHit = false;
    const compilerStartedAt = now();
    emitRequestProgress('external-compile:start', { tracing: Boolean(options.tracing) });
    const compileResult = await compileDriverOutsideMainWorker(driverSource);
    timings.externalCompileMs = elapsedMs(compilerStartedAt);
    emitRequestProgress('external-compile:complete', {
      tracing: Boolean(options.tracing),
      externalCompileMs: timings.externalCompileMs,
      success: Boolean(compileResult.success),
    });
    timings.compilerWorkerMs = timings.externalCompileMs;
    timings.compileMs = Number.isFinite(Number(compileResult.compileMs))
      ? Number(compileResult.compileMs)
      : timings.compilerWorkerMs;
    if (compileResult.timings && typeof compileResult.timings === 'object') {
      Object.assign(timings, compileResult.timings);
    }

    if (!compileResult.success) {
      const diagnostics = [compileResult.stderr, compileResult.stdout, compileResult.error]
        .filter(Boolean)
        .join('\n')
        .trim();
      return compileFailureResult(diagnostics, 'C++ compilation failed.', start, {
        generatedSource: options?.traceOptions?.includeGeneratedSource ? driverSource : undefined,
        diagnosticStage: options.tracing ? 'trace-driver-compile' : 'driver-compile',
        timings,
      });
    }

    if (!(compileResult.programBuffer instanceof ArrayBuffer)) {
      return {
        success: false,
        output: null,
        error: 'C++ compiler worker did not return program.wasm.',
        consoleOutput: [],
        executionTimeMs: elapsedMs(start),
        timings: { ...timings, totalMs: elapsedMs(start) },
      };
    }

    const wasmCompileStartedAt = now();
    emitRequestProgress('wasm-compile:start', { tracing: Boolean(options.tracing), compiler: 'external' });
    programModule = await WebAssembly.compile(new Uint8Array(compileResult.programBuffer));
    timings.wasmCompileMs = elapsedMs(wasmCompileStartedAt);
    emitRequestProgress('wasm-compile:complete', {
      tracing: Boolean(options.tracing),
      compiler: 'external',
      wasmCompileMs: timings.wasmCompileMs,
    });
    storeProgramModule(cacheKey, programModule);
  }

  try {
    const runStartedAt = now();
    emitRequestProgress('program-run:start', { tracing: Boolean(options.tracing), compiler: 'external' });
    const program = await runWasi(programModule, ['program.wasm'], new InMemoryFileSystem(), {
      stdinBytes: staticStdinBytesFromText(stdinText),
    });
    timings.runMs = elapsedMs(runStartedAt);
    emitRequestProgress('program-run:complete', {
      tracing: Boolean(options.tracing),
      compiler: 'external',
      runMs: timings.runMs,
      exitCode: program.exitCode,
    });
    let parsed;
    try {
      parsed = parseProgramStdout(program.stdout, {
        tracing: options.tracing,
        defaultLine: signature.line,
        allowMissingResult: options.tracing,
      });
    } catch (parseError) {
      return programOutputParseFailureResult(parseError, program, signature, start, timings, options);
    }
    if (scriptRequest && options.tracing) {
      parsed.events = normalizeScriptTraceEvents(parsed.events, scriptLineCount(source));
    }
    const programTimedOut = options.tracing && program.exitCode === 124;
    const runtimeTimedOut = !options.tracing && program.exitCode === 124;
    const baseResult = {
      success: program.exitCode === 0 && !programTimedOut,
      output: parsed.output,
      error: program.exitCode === 0 ? undefined : program.stderr || `C++ program exited with code ${program.exitCode}`,
      consoleOutput: [...parsed.consoleOutput, ...program.stderr.split(/\r?\n/).filter(Boolean)],
      executionTimeMs: elapsedMs(start),
      timings: { ...timings, totalMs: elapsedMs(start) },
      ...(runtimeTimedOut ? { timeoutReason: 'client-timeout', diagnosticStage: 'runtime' } : {}),
    };
    if (!options.tracing) return baseResult;
    if (options.batchTrace === true) {
      const inputBatch = Array.isArray(options.inputBatch) ? options.inputBatch : [];
      const batchTraceResult = cppBatchTraceResultsFromParsedOutput(parsed, source, inputBatch, timings, start, options);
      if (program.exitCode !== 0 || programTimedOut) {
        return {
          ...batchTraceResult,
          success: false,
          error: programTimedOut ? 'C++ trace budget exceeded.' : (program.stderr || `C++ program exited with code ${program.exitCode}`),
        };
      }
      return batchTraceResult;
    }
    const finalizedTrace = finalizeRuntimeTrace(parsed.events, { ...(options.traceOptions || {}), sourceCode: source });
    const { trace } = finalizedTrace;
    const runtimeTraceLimitExceeded = finalizedTrace.traceLimitExceeded || Boolean(parsed.traceStatus?.traceLimitExceeded) || programTimedOut;
    const droppedEventCount = (finalizedTrace.droppedEventCount || 0) + (Number(parsed.traceStatus?.droppedEventCount) || 0);
    const timeoutReason = timeoutReasonForParsedTrace(parsed);
    return {
      ...baseResult,
      ...(programTimedOut ? { error: 'C++ trace budget exceeded.' } : {}),
      trace,
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
      traceLimitExceeded: runtimeTraceLimitExceeded,
      ...(runtimeTraceLimitExceeded ? { timeoutReason } : {}),
      ...(runtimeTraceLimitExceeded ? { droppedEventCount } : {}),
    };
  } catch (error) {
    if (options.tracing) {
      const trace = finalizeRuntimeTrace(
        [{ kind: 'exception', line: signature.line, message: error instanceof Error ? error.message : String(error) }],
        { ...(options.traceOptions || {}), sourceCode: source }
      ).trace;
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        trace,
        consoleOutput: [],
        executionTimeMs: elapsedMs(start),
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
        timings: { ...timings, totalMs: elapsedMs(start) },
      };
    }
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      executionTimeMs: elapsedMs(start),
      timings: { ...timings, totalMs: elapsedMs(start) },
    };
  }
}

async function compileAndRunWithYowasp(toolchain, source, functionName, inputs, start, options = {}) {
  const timings = {
    ...(options.timings && typeof options.timings === 'object' ? options.timings : {}),
  };
  const preparedDriverSource = typeof options.preparedDriverSource === 'string' ? options.preparedDriverSource : null;
  const stdinText = typeof options.stdinText === 'string' ? options.stdinText : JSON.stringify(inputs || {});
  const scriptRequest = !preparedDriverSource && isScriptExecutionRequest(functionName, options);
  const signature = scriptRequest
    ? { line: 1 }
    : options.executionStyle === 'ops-class'
    ? { line: 1 }
    : parseMethodSignature(source, functionName, {
        parameterCount: Object.keys(inputs || {}).length,
        inputNames: Object.keys(inputs || {}),
      });
  let driverSource = preparedDriverSource;
  if (!driverSource) {
    const driverStartedAt = now();
    emitRequestProgress('driver-build:start', { tracing: Boolean(options.tracing), compiler: 'yowasp' });
    const rawDriverSource = scriptRequest
      ? buildScriptDriverSource(source, options)
      : options.executionStyle === 'ops-class'
      ? buildOpsClassDriverSource(source, functionName, inputs || {}, options)
      : buildDriverSource(source, functionName, inputs || {}, options);
    driverSource = rawDriverSource.replace(
      '#include "/tracecode_runtime.hpp"',
      '#include "tracecode_runtime.hpp"'
    );
    timings.driverBuildMs = elapsedMs(driverStartedAt);
    emitRequestProgress('driver-build:complete', { tracing: Boolean(options.tracing), compiler: 'yowasp' });
  }
  driverSource = driverSource.replace(
    '#include "/tracecode_runtime.hpp"',
    '#include "tracecode_runtime.hpp"'
  );
  const stdoutChunks = [];
  const stderrChunks = [];
  const collect = (chunks) => (bytes) => {
    if (bytes) chunks.push(bytes);
  };

  const cacheKey = getProgramCacheKey(toolchain.compiler, driverSource);
  let programModule = getCachedProgramModule(cacheKey);
  if (programModule) {
    timings.compileCacheHit = true;
    timings.compileMs = 0;
    timings.wasmCompileMs = 0;
  } else {
    timings.compileCacheHit = false;
    let files;
    try {
      const compileStartedAt = now();
      emitRequestProgress('yowasp-compile:start', { tracing: Boolean(options.tracing) });
      files = await toolchain.runClang(
        ['clang++', 'TraceCodeDriver.cpp', `-std=${CPP_STANDARD}`, '-O0', '-fno-exceptions', `-Wl,-z,stack-size=${CPP_PROGRAM_STACK_SIZE}`, '-o', 'program.wasm'],
        {
          'TraceCodeDriver.cpp': driverSource,
          'tracecode_runtime.hpp': toolchain.runtimeHeader,
        },
        {
          stdout: collect(stdoutChunks),
          stderr: collect(stderrChunks),
          fetchProgress: () => {},
        }
      );
      timings.compileMs = elapsedMs(compileStartedAt);
      emitRequestProgress('yowasp-compile:complete', { tracing: Boolean(options.tracing), compileMs: timings.compileMs });
    } catch (error) {
      const stdout = decodeUtf8(concatBytes(stdoutChunks));
      const stderr = decodeUtf8(concatBytes(stderrChunks));
      const diagnostics = [stderr, stdout, error instanceof Error ? error.message : String(error)]
        .filter(Boolean)
        .join('\n')
        .trim();
      return compileFailureResult(diagnostics, 'C++ compilation failed.', start, {
        generatedSource: options?.traceOptions?.includeGeneratedSource ? driverSource : undefined,
        diagnosticStage: options.tracing ? 'trace-driver-compile' : 'driver-compile',
        timings,
      });
    }

    const programBytes = files?.['program.wasm'];
    if (!(programBytes instanceof Uint8Array)) {
      return {
        success: false,
        output: null,
        error: 'C++ compilation did not produce program.wasm.',
        consoleOutput: [],
        executionTimeMs: elapsedMs(start),
        timings: { ...timings, totalMs: elapsedMs(start) },
      };
    }

    const wasmCompileStartedAt = now();
    emitRequestProgress('wasm-compile:start', { tracing: Boolean(options.tracing), compiler: 'yowasp' });
    programModule = await WebAssembly.compile(programBytes);
    timings.wasmCompileMs = elapsedMs(wasmCompileStartedAt);
    emitRequestProgress('wasm-compile:complete', {
      tracing: Boolean(options.tracing),
      compiler: 'yowasp',
      wasmCompileMs: timings.wasmCompileMs,
    });
    storeProgramModule(cacheKey, programModule);
  }

  try {
    const runStartedAt = now();
    emitRequestProgress('program-run:start', { tracing: Boolean(options.tracing), compiler: 'yowasp' });
    const program = await runWasi(programModule, ['program.wasm'], new InMemoryFileSystem(), {
      stdinBytes: staticStdinBytesFromText(stdinText),
    });
    timings.runMs = elapsedMs(runStartedAt);
    emitRequestProgress('program-run:complete', {
      tracing: Boolean(options.tracing),
      compiler: 'yowasp',
      runMs: timings.runMs,
      exitCode: program.exitCode,
    });
    let parsed;
    try {
      parsed = parseProgramStdout(program.stdout, {
        tracing: options.tracing,
        defaultLine: signature.line,
        allowMissingResult: options.tracing,
      });
    } catch (parseError) {
      return programOutputParseFailureResult(parseError, program, signature, start, timings, options);
    }
    if (scriptRequest && options.tracing) {
      parsed.events = normalizeScriptTraceEvents(parsed.events, scriptLineCount(source));
    }
    const programTimedOut = options.tracing && program.exitCode === 124;
    const runtimeTimedOut = !options.tracing && program.exitCode === 124;
    const baseResult = {
      success: program.exitCode === 0 && !programTimedOut,
      output: parsed.output,
      error: program.exitCode === 0 ? undefined : program.stderr || `C++ program exited with code ${program.exitCode}`,
      consoleOutput: [...parsed.consoleOutput, ...program.stderr.split(/\r?\n/).filter(Boolean)],
      executionTimeMs: elapsedMs(start),
      timings: { ...timings, totalMs: elapsedMs(start) },
      ...(runtimeTimedOut ? { timeoutReason: 'client-timeout', diagnosticStage: 'runtime' } : {}),
    };
    if (!options.tracing) return baseResult;
    const finalizedTrace = finalizeRuntimeTrace(parsed.events, { ...(options.traceOptions || {}), sourceCode: source });
    const { trace } = finalizedTrace;
    const runtimeTraceLimitExceeded = finalizedTrace.traceLimitExceeded || Boolean(parsed.traceStatus?.traceLimitExceeded) || programTimedOut;
    const droppedEventCount = (finalizedTrace.droppedEventCount || 0) + (Number(parsed.traceStatus?.droppedEventCount) || 0);
    const timeoutReason = timeoutReasonForParsedTrace(parsed);
    return {
      ...baseResult,
      ...(programTimedOut ? { error: 'C++ trace budget exceeded.' } : {}),
      trace,
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
      traceLimitExceeded: runtimeTraceLimitExceeded,
      ...(runtimeTraceLimitExceeded ? { timeoutReason } : {}),
      ...(runtimeTraceLimitExceeded ? { droppedEventCount } : {}),
    };
  } catch (error) {
    if (options.tracing) {
      const trace = finalizeRuntimeTrace(
        [{ kind: 'exception', line: signature.line, message: error instanceof Error ? error.message : String(error) }],
        { ...(options.traceOptions || {}), sourceCode: source }
      ).trace;
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        trace,
        consoleOutput: [],
        executionTimeMs: elapsedMs(start),
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
        timings: { ...timings, totalMs: elapsedMs(start) },
      };
    }
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      executionTimeMs: elapsedMs(start),
      timings: { ...timings, totalMs: elapsedMs(start) },
    };
  }
}

async function warmToolchain() {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      const result = await compileAndRun(CPP_WARMUP_SOURCE, 'add', { a: 1, b: 2 }, {
        executionStyle: 'solution-method',
      });
      if (!result?.success || result.output !== 3) {
        throw new Error(result?.error || 'C++ toolchain warmup failed.');
      }
      return result.timings || {};
    })();
    warmupPromise.catch(() => {
      warmupPromise = null;
    });
  }

  return warmupPromise;
}

async function handleInit(payload) {
  const start = now();
  configuredAssets = payload && payload.assets ? payload.assets : null;
  toolchainPromise = null;
  warmupPromise = null;
  programCache = new Map();
  resetCompilerWorker();
  const totalMs = elapsedMs(start);
  return {
    success: true,
    loadTimeMs: totalMs,
    timings: {
      totalMs,
      toolchainLoadMs: 0,
      warmupMs: 0,
    },
  };
}

async function handleWarmup(payload) {
  if (payload && payload.assets) {
    configuredAssets = payload.assets;
  }
  const start = now();
  let toolchainLoadMs = 0;
  if (!canUseEphemeralCompilerWorker()) {
    const toolchainStartedAt = now();
    await loadToolchain();
    toolchainLoadMs = elapsedMs(toolchainStartedAt);
  }
  const warmupStartedAt = now();
  const warmupTimings = await warmToolchain();
  const warmupMs = elapsedMs(warmupStartedAt);
  const reportedToolchainLoadMs =
    toolchainLoadMs ||
    (typeof warmupTimings.toolchainLoadMs === 'number' ? warmupTimings.toolchainLoadMs : 0);
  const totalMs = elapsedMs(start);
  return {
    success: true,
    loadTimeMs: totalMs,
    timings: {
      totalMs,
      toolchainLoadMs: reportedToolchainLoadMs,
      warmupMs,
      ...(typeof warmupTimings.compileMs === 'number' ? { compileMs: warmupTimings.compileMs } : {}),
      ...(typeof warmupTimings.externalCompileMs === 'number' ? { externalCompileMs: warmupTimings.externalCompileMs } : {}),
      ...(typeof warmupTimings.compilerWorkerMs === 'number' ? { compilerWorkerMs: warmupTimings.compilerWorkerMs } : {}),
      ...(typeof warmupTimings.pchMs === 'number' ? { pchMs: warmupTimings.pchMs } : {}),
      ...(typeof warmupTimings.pchCacheHit === 'boolean' ? { pchCacheHit: warmupTimings.pchCacheHit } : {}),
      ...(typeof warmupTimings.pchFallback === 'boolean' ? { pchFallback: warmupTimings.pchFallback } : {}),
      ...(typeof warmupTimings.wasmCompileMs === 'number' ? { wasmCompileMs: warmupTimings.wasmCompileMs } : {}),
      ...(typeof warmupTimings.runMs === 'number' ? { runMs: warmupTimings.runMs } : {}),
    },
  };
}

async function handleCompileRun(payload) {
  const source = payload && typeof payload.code === 'string' ? payload.code : '';
  const functionName = payload && typeof payload.functionName === 'string' ? payload.functionName : '';

  if (!source.trim()) {
    return {
      success: false,
      output: null,
      error: 'C++ source is empty.',
      consoleOutput: [],
    };
  }

  if (!functionName.trim() && payload?.executionStyle !== 'function') {
    return {
      success: false,
      output: null,
      error: 'C++ named execution requires a function name.',
      consoleOutput: [],
    };
  }

  try {
    return await compileAndRun(source, functionName, payload?.inputs || {}, {
      executionStyle: payload?.executionStyle || 'solution-method',
    });
  } catch (error) {
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
    };
  }
}

function cppBatchIsolationReason(source) {
  const text = stripComments(String(source ?? ''));
  if (/\b(?:static|thread_local)\b/.test(text)) {
    return 'static-storage';
  }
  if (cppHasFileScopeMutableDeclaration(text)) {
    return 'file-scope-state';
  }
  return '';
}

function cppHasFileScopeMutableDeclaration(source) {
  let depth = 0;
  let statement = '';

  const considerStatement = (rawStatement) => {
    const normalized = rawStatement
      .replace(/#[^\n]*(?:\n|$)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return false;
    if (/^(?:using|typedef|template|class|struct|enum|namespace|extern\s+"C")\b/.test(normalized)) return false;
    if (/\b(?:const|constexpr)\b/.test(normalized)) return false;
    if (/\(/.test(normalized)) return false;
    if (/^(?:return|if|for|while|switch|do|break|continue)\b/.test(normalized)) return false;
    return /^(?:inline\s+|volatile\s+|mutable\s+|unsigned\s+|signed\s+|long\s+|short\s+)*[A-Za-z_:][A-Za-z0-9_:<>,\s*&]*\s+[*&\s]*[A-Za-z_][A-Za-z0-9_]*(?:\s*(?:=|,|\[|;))/.test(normalized);
  };

  for (const char of source) {
    if (depth === 0) {
      statement += char;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && char === ';') {
      if (considerStatement(statement)) return true;
      statement = '';
    }
  }

  return false;
}

function cppOpsClassBatchIsolationReason(inputBatch) {
  if (!Array.isArray(inputBatch) || inputBatch.length <= 1) return '';
  const firstOperations = Array.isArray(inputBatch[0]?.operations)
    ? inputBatch[0].operations
    : Array.isArray(inputBatch[0]?.ops)
      ? inputBatch[0].ops
      : [];
  for (let caseIndex = 1; caseIndex < inputBatch.length; caseIndex += 1) {
    const operations = Array.isArray(inputBatch[caseIndex]?.operations)
      ? inputBatch[caseIndex].operations
      : Array.isArray(inputBatch[caseIndex]?.ops)
        ? inputBatch[caseIndex].ops
        : [];
    if (operations.length !== firstOperations.length) {
      return 'heterogeneous-ops-class';
    }
    for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
      if (operations[operationIndex] !== firstOperations[operationIndex]) {
        return 'heterogeneous-ops-class';
      }
    }
  }
  return '';
}

async function handleCompileRunBatch(payload) {
  const startedAt = now();
  const source = payload && typeof payload.code === 'string' ? payload.code : '';
  const functionName = payload && typeof payload.functionName === 'string' ? payload.functionName : '';
  const executionStyle = payload?.executionStyle || 'solution-method';
  const inputBatch = Array.isArray(payload?.inputBatch)
    ? payload.inputBatch.map((inputs) => (inputs && typeof inputs === 'object' ? inputs : {}))
    : [];
  const baseTimings = () => ({ totalMs: elapsedMs(startedAt) });
  const failedBatchResult = (message) => ({
    success: false,
    results: [],
    error: message,
    consoleOutput: [],
    timings: baseTimings(),
  });

  if (!source.trim()) {
    return failedBatchResult('C++ source is empty.');
  }

  if (inputBatch.length === 0) {
    return failedBatchResult('C++ batch execution requires a non-empty inputBatch array.');
  }

  if (!functionName.trim() && executionStyle !== 'function') {
    return failedBatchResult('C++ named execution requires a function name.');
  }

  if (!functionName.trim() && executionStyle === 'function') {
    // Script-style C++ has no stable per-case input contract today, so keep its
    // existing per-case behavior instead of pretending it is compile-once batch.
    const results = [];
    for (const inputs of inputBatch) {
      results.push(await handleCompileRun({ ...payload, inputs }));
    }
    return {
      success: results.every((result) => result.success === true),
      results,
      consoleOutput: results.flatMap((result) => result.consoleOutput ?? []),
      timings: { ...baseTimings(), batchMode: 'per-case-fallback', batchFallbackReason: 'script-without-function-name' },
    };
  }

  const isolationReason = executionStyle === 'ops-class'
    ? (cppOpsClassBatchIsolationReason(inputBatch) || cppBatchIsolationReason(source))
    : cppBatchIsolationReason(source);
  if (isolationReason) {
    const results = [];
    for (const inputs of inputBatch) {
      results.push(await handleCompileRun({ ...payload, inputs, executionStyle }));
    }
    const success = results.every((result) => result.success === true);
    return {
      success,
      results,
      consoleOutput: results.flatMap((result) => result.consoleOutput ?? []),
      ...(success ? {} : { error: results.find((result) => result.success !== true)?.error ?? 'C++ batch execution failed.' }),
      timings: {
        ...baseTimings(),
        batchMode: 'per-case-fallback',
        batchCaseCount: inputBatch.length,
        batchFallbackReason: isolationReason,
      },
    };
  }

  let preparedDriverSource;
  try {
    preparedDriverSource = executionStyle === 'ops-class'
      ? buildOpsClassBatchDriverSource(source, functionName, inputBatch, { executionStyle })
      : buildBatchDriverSource(source, functionName, inputBatch, { executionStyle });
  } catch (error) {
    return failedBatchResult(error instanceof Error ? error.message : String(error));
  }

  const batchTimings = (timings = {}) => ({
    ...timings,
    totalMs: elapsedMs(startedAt),
    batchMode: 'compile-once',
    batchCaseCount: inputBatch.length,
  });

  const failedBatchEntries = (result) => inputBatch.map(() => ({
    success: false,
    output: null,
    error: result?.error ?? 'C++ batch execution failed.',
    consoleOutput: result?.consoleOutput ?? [],
    timings: result?.timings ?? {},
  }));

  const result = await compileAndRun(source, functionName, {}, {
    executionStyle,
    preparedDriverSource,
    stdinText: JSON.stringify(inputBatch),
  });

  if (!result?.success) {
    return {
      success: false,
      results: failedBatchEntries(result),
      consoleOutput: result?.consoleOutput ?? [],
      error: result?.error ?? 'C++ batch execution failed.',
      timings: batchTimings(result?.timings),
    };
  }

  if (!Array.isArray(result.output) || result.output.length !== inputBatch.length) {
    const error = `C++ batch driver returned ${Array.isArray(result.output) ? result.output.length : 'non-array'} results for ${inputBatch.length} cases.`;
    return {
      success: false,
      results: failedBatchEntries({ ...result, error }),
      consoleOutput: result.consoleOutput ?? [],
      error,
      timings: batchTimings(result.timings),
    };
  }

  const results = result.output.map((output, index) => ({
    success: true,
    output,
    consoleOutput: index === 0 ? (result.consoleOutput ?? []) : [],
    executionTimeMs: index === 0 ? result.executionTimeMs : 0,
    timings: index === 0
      ? { ...(result.timings ?? {}), batchCaseIndex: index }
      : { runMs: 0, totalMs: 0, compileCacheHit: true, batchCaseIndex: index },
  }));
  return {
    success: true,
    results,
    consoleOutput: result.consoleOutput ?? [],
    timings: batchTimings(result.timings),
  };
}

async function handleExecuteTraceBatch(payload) {
  const startedAt = now();
  const source = payload && typeof payload.code === 'string' ? payload.code : '';
  const functionName = payload && typeof payload.functionName === 'string' ? payload.functionName : '';
  const executionStyle = payload?.executionStyle || 'solution-method';
  const inputBatch = Array.isArray(payload?.inputBatch)
    ? payload.inputBatch.map((inputs) => (inputs && typeof inputs === 'object' ? inputs : {}))
    : [];
  const baseTimings = () => ({ totalMs: elapsedMs(startedAt), batchMode: 'per-case-fallback', batchCaseCount: inputBatch.length });
  const failedTrace = (message) => {
    const trace = finalizeRuntimeTrace([{ kind: 'exception', line: 1, message }]).trace;
    return {
      success: false,
      output: null,
      error: message,
      trace,
      executionTimeMs: 0,
      consoleOutput: [],
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
    };
  };
  const failedBatchResult = (message) => ({
    success: false,
    results: inputBatch.map(() => failedTrace(message)),
    error: message,
    consoleOutput: [],
    timings: baseTimings(),
  });

  if (!source.trim()) {
    return failedBatchResult('C++ source is empty.');
  }

  if (inputBatch.length === 0) {
    return {
      success: false,
      results: [],
      error: 'C++ trace batch execution requires a non-empty inputBatch array.',
      consoleOutput: [],
      timings: baseTimings(),
    };
  }

  if (!functionName.trim() && executionStyle !== 'function') {
    return failedBatchResult('C++ named tracing requires a function name.');
  }

  const fallbackPerCase = async (reason) => {
    const results = [];
    for (const inputs of inputBatch) {
      results.push(await handleExecuteWithTracing({
        ...payload,
        inputs,
        executionStyle,
      }));
    }
    const success = results.every((result) => result.success === true);
    return {
      success,
      results,
      consoleOutput: results.flatMap((result) => result.consoleOutput ?? []),
      ...(success ? {} : { error: results.find((result) => result.success !== true)?.error ?? 'C++ trace batch execution failed.' }),
      timings: {
        ...baseTimings(),
        batchFallbackReason: reason,
      },
    };
  };

  if (!functionName.trim() && executionStyle === 'function') {
    return fallbackPerCase('script-without-function-name');
  }

  if (executionStyle === 'ops-class') {
    return fallbackPerCase('ops-class-trace-batch-unsupported');
  }

  const isolationReason = cppBatchIsolationReason(source);
  if (isolationReason) {
    return fallbackPerCase(isolationReason);
  }

  let preparedDriverSource;
  try {
    preparedDriverSource = buildBatchDriverSource(source, functionName, inputBatch, {
      executionStyle,
      tracing: true,
      traceOptions: payload?.options || {},
    });
  } catch (error) {
    return failedBatchResult(error instanceof Error ? error.message : String(error));
  }

  const result = await compileAndRun(source, functionName, {}, {
    executionStyle,
    tracing: true,
    traceOptions: payload?.options || {},
    preparedDriverSource,
    stdinText: JSON.stringify(inputBatch),
    batchTrace: true,
    inputBatch,
  });

  if (!Array.isArray(result?.results)) {
    const diagnostics = [
      result?.error,
      ...(Array.isArray(result?.consoleOutput) ? result.consoleOutput : []),
      ...(Array.isArray(result?.trace?.events)
        ? result.trace.events.map((event) => event?.message || event?.reason).filter(Boolean)
        : []),
    ].filter((line) => typeof line === 'string' && line.trim().length > 0);
    const message = diagnostics[0] ?? `C++ trace batch execution failed (${result ? `result keys: ${Object.keys(result).join(', ')}` : 'no result'}).`;
    const trace = result?.trace ?? finalizeRuntimeTrace([{ kind: 'exception', line: 1, message }], {
      ...(payload?.options || {}),
      sourceCode: source,
    }).trace;
    return {
      success: false,
      results: inputBatch.map((_, index) => ({
        success: false,
        output: null,
        error: message,
        trace,
        consoleOutput: index === 0 ? (result?.consoleOutput ?? []) : [],
        executionTimeMs: index === 0 ? (result?.executionTimeMs ?? elapsedMs(startedAt)) : 0,
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
        timings: index === 0 ? (result?.timings ?? baseTimings()) : { runMs: 0, totalMs: 0, compileCacheHit: true, batchCaseIndex: index },
      })),
      error: message,
      consoleOutput: result?.consoleOutput ?? [],
      timings: {
        ...(result?.timings ?? {}),
        totalMs: elapsedMs(startedAt),
        batchMode: 'compile-once-trace',
        batchCaseCount: inputBatch.length,
      },
    };
  }

  return {
    ...result,
    timings: {
      ...(result.timings ?? {}),
      totalMs: elapsedMs(startedAt),
      batchMode: result.timings?.batchMode ?? 'compile-once-trace',
      batchCaseCount: inputBatch.length,
    },
  };
}

async function handleExecuteWithTracing(payload) {
  const source = payload && typeof payload.code === 'string' ? payload.code : '';
  const functionName = payload && typeof payload.functionName === 'string' ? payload.functionName : '';

  if (!source.trim()) {
    const trace = finalizeRuntimeTrace([{ kind: 'exception', line: 1, message: 'C++ source is empty.' }]).trace;
    return {
      success: false,
      output: null,
      error: 'C++ source is empty.',
      trace,
      executionTimeMs: 0,
      consoleOutput: [],
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
    };
  }

  if (!functionName.trim() && payload?.executionStyle !== 'function') {
    const trace = finalizeRuntimeTrace([
      { kind: 'exception', line: 1, message: 'C++ named tracing requires a function name.' },
    ]).trace;
    return {
      success: false,
      output: null,
      error: 'C++ named tracing requires a function name.',
      trace,
      executionTimeMs: 0,
      consoleOutput: [],
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
    };
  }

  try {
    const result = await compileAndRun(source, functionName, payload?.inputs || {}, {
      tracing: true,
      traceOptions: payload?.options || {},
      executionStyle: payload?.executionStyle || 'solution-method',
    });
    if (result.trace) return result;
    const trace = finalizeRuntimeTrace([{ kind: 'exception', line: result.errorLine || 1, message: result.error || 'C++ tracing failed.' }]).trace;
    return {
      ...result,
      trace,
      executionTimeMs: result.executionTimeMs || 0,
      consoleOutput: result.consoleOutput || [],
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
    };
  } catch (error) {
    const trace = finalizeRuntimeTrace([
      { kind: 'exception', line: 1, message: error instanceof Error ? error.message : String(error) },
    ]).trace;
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      trace,
      executionTimeMs: 0,
      consoleOutput: [],
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
    };
  }
}

function isInterviewTimeoutResult(result) {
  const normalized = String(result?.error ?? '').toLowerCase();
  const timeoutReason = result?.timeoutReason ?? '';
  return (
    timeoutReason === 'trace-limit' ||
    timeoutReason === 'line-limit' ||
    timeoutReason === 'single-line-limit' ||
    timeoutReason === 'client-timeout' ||
    normalized.includes('timed out') ||
    normalized.includes('trace budget') ||
    normalized.includes('trace-limit') ||
    normalized.includes('line-limit') ||
    normalized.includes('infinite loop')
  );
}

async function handleExecuteCodeInterview(payload) {
  const source = payload && typeof payload.code === 'string' ? payload.code : '';
  const functionName = payload && typeof payload.functionName === 'string' ? payload.functionName : '';

  if (!source.trim()) {
    return {
      success: false,
      output: null,
      error: 'C++ source is empty.',
      consoleOutput: [],
    };
  }

  if (!functionName.trim() && payload?.executionStyle !== 'function') {
    return {
      success: false,
      output: null,
      error: 'C++ named interview execution requires a function name.',
      consoleOutput: [],
    };
  }

  try {
    const result = await compileAndRun(source, functionName, payload?.inputs || {}, {
      tracing: true,
      traceOptions: {
        maxTraceSteps: DEFAULT_INTERVIEW_MAX_TRACE_STEPS,
        maxLineEvents: DEFAULT_INTERVIEW_MAX_LINE_EVENTS,
        maxSingleLineHits: DEFAULT_INTERVIEW_MAX_SINGLE_LINE_HITS,
        ...(payload?.options && typeof payload.options === 'object' ? payload.options : {}),
      },
      executionStyle: payload?.executionStyle || 'solution-method',
    });

    if (result.traceLimitExceeded && isInterviewTimeoutResult(result)) {
      return {
        success: false,
        output: null,
        error: 'Time Limit Exceeded',
        ...(isTraceTimeoutReason(result.timeoutReason) ? { timeoutReason: result.timeoutReason } : {}),
        diagnosticStage: 'interview',
        consoleOutput: result.consoleOutput || [],
        timings: result.timings,
      };
    }

    if (!result.success) {
      if (isInterviewTimeoutResult(result)) {
        return {
          success: false,
          output: null,
          error: 'Time Limit Exceeded',
          ...(isTraceTimeoutReason(result.timeoutReason) ? { timeoutReason: result.timeoutReason } : {}),
          diagnosticStage: 'interview',
          consoleOutput: result.consoleOutput || [],
          timings: result.timings,
        };
      }
      return {
        success: false,
        output: null,
        error: result.error || 'C++ interview execution failed.',
        ...(result.errorLine !== undefined ? { errorLine: result.errorLine } : {}),
        consoleOutput: result.consoleOutput || [],
        timings: result.timings,
      };
    }

    return {
      success: true,
      output: result.output,
      consoleOutput: result.consoleOutput || [],
      timings: result.timings,
    };
  } catch {
    return {
      success: false,
      output: null,
      error: 'Time Limit Exceeded',
      timeoutReason: 'client-timeout',
      diagnosticStage: 'interview',
      consoleOutput: [],
    };
  }
}

self.onmessage = (event) => {
  const { id, type, payload, requestId, protocolToken } = event.data || {};
  if (type === 'compile-response') {
    const pending = pendingExternalCompiles.get(String(requestId || ''));
    if (!pending) return;
    if (protocolToken !== pending.protocolToken) return;
    pendingExternalCompiles.delete(String(requestId));
    clearTimeout(pending.timeoutId);
    if (payload?.success === false && payload?.error) {
      pending.resolve(payload);
      return;
    }
    pending.resolve(payload || {});
    return;
  }

  if (!id) return;
  if (typeof protocolToken !== 'string') {
    trustedCppWorkerPostMessage({
      id,
      type: 'error',
      payload: { error: 'Missing C++ worker protocol token.' },
    });
    return;
  }
  clearIdleTimer();
  applyWorkerOptions(payload);
  queuedTasks += 1;

  queue = queue
    .catch(() => {})
    .then(async () => {
      activeRequestId = id;
      activeRequestProtocolToken = protocolToken;
      activeRequestStartedAt = now();
      emitRequestProgress('request-start', { type });
      let result;
      try {
        result =
          type === 'init'
            ? await handleInit(payload)
            : type === 'warmup'
              ? await handleWarmup(payload)
            : type === 'compile-run'
              ? await handleCompileRun(payload)
              : type === 'compile-run-batch'
              ? await handleCompileRunBatch(payload)
              : type === 'execute-project-cpp'
                ? await withRuntimeUserAuthorityLockdown(
                    () => handleProjectCpp(payload, id),
                    {
                      scope: self,
                      mode: payload?.projectUserAuthorityMode ?? 'temporary',
                    }
                  )
              : type === 'execute-with-tracing'
                ? await handleExecuteWithTracing(payload)
                : type === 'execute-trace-batch'
                  ? await handleExecuteTraceBatch(payload)
                : type === 'execute-code-interview'
                  ? await handleExecuteCodeInterview(payload)
                  : await Promise.reject(new Error(`Unknown C++ worker message: ${type}`));
      } finally {
        emitRequestProgress('request-complete', { type });
      }

      postSuccess(id, type, result, payload?.traceEventTransport);
    })
    .catch((error) => {
      emitRuntimeDiagnostic('error', 'worker-request-failed', 'C++ worker request failed.', {
        type,
        message: error instanceof Error ? error.message : String(error),
      });
      postFailure(id, error);
    })
    .finally(() => {
      activeRequestId = null;
      activeRequestProtocolToken = null;
      activeRequestStartedAt = 0;
      queuedTasks = Math.max(0, queuedTasks - 1);
      if (queuedTasks === 0) resetIdleTimer();
    });
};

emitRuntimeDiagnostic('info', 'worker-ready', 'C++ worker is ready.');
trustedCppWorkerPostMessage({ type: 'worker-ready' });

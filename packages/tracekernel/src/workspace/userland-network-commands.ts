import {
  runtimeHttpBodyBytes,
  type RuntimeCommandResult,
  type RuntimeKernelHttpRequest,
  type RuntimeKernelHttpResponse,
} from '@tracecode/runtime-contracts';
import type { CommandContext } from 'just-bash/browser';
import { CURL_PROTOCOLS, resolveCurlUrl } from './curl-url';
import {
  decodeCommandStdin,
} from './arg-parsers';
import { commandEnv } from './language-commands';
import {
  dirname,
  resolveWorkspaceContextPath,
} from './paths';
import {
  formatPingLatency,
  type HostResolution,
} from './http-state';
import { decodeUtf8 } from './fs-observed';

interface CurlDispatchOptions {
  timeoutMs?: number;
  timeoutBody?: string;
}

export interface WorkspaceNetworkCommandsOptions {
  cwd: string;
  resolveHost(hostname: string): HostResolution;
  dispatchHttpRequest(
    request: RuntimeKernelHttpRequest,
    context: CommandContext,
    options: CurlDispatchOptions
  ): Promise<RuntimeKernelHttpResponse>;
}

function httpHeaderValue(
  headers: Record<string, string> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const normalizedName = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === normalizedName) return value;
  }
  return undefined;
}

function curlErrorResult(
  response: RuntimeKernelHttpResponse
): RuntimeCommandResult | undefined {
  const error = response.error;
  if (!error) return undefined;
  if (error.code === 'EINVAL') {
    return {
      stdout: '',
      stderr: 'curl: (3) URL malformed\n',
      exitCode: 3,
    };
  }
  if (error.code === 'EPROTONOSUPPORT') {
    const protocol =
      /Protocol "([^"]+)"/.exec(error.message)?.[1] ??
      /'([^']+)'/.exec(error.message)?.[1] ??
      'unknown';
    return {
      stdout: '',
      stderr:
        `curl: (1) Protocol "${protocol}" not supported\n`,
      exitCode: 1,
    };
  }
  if (error.code === 'ETIMEDOUT') {
    return {
      stdout: '',
      stderr: response.body?.startsWith('curl: (28)')
        ? response.body
        : 'curl: (28) Operation timed out\n',
      exitCode: 28,
    };
  }
  if (error.code === 'ENOTFOUND') {
    const host =
      /\s([^\s:]+)(?::\d+)?$/.exec(error.message)?.[1] ??
      'unknown';
    return {
      stdout: '',
      stderr: `curl: (6) Could not resolve host: ${host}\n`,
      exitCode: 6,
    };
  }
  if (
    error.code === 'EACCES' ||
    error.code === 'EHOSTBLOCKED' ||
    error.code === 'EHOSTUNREACH' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ECONNRESET' ||
    error.code === 'ENETUNREACH' ||
    error.code === 'EAGAIN' ||
    error.code === 'ERATELIMIT'
  ) {
    if (response.body?.startsWith('curl: (7)')) {
      return {
        stdout: '',
        stderr: response.body,
        exitCode: 7,
      };
    }
    const message = error.message
      .replace(/^[A-Z][A-Z0-9_]*:\s*/, '')
      .replace(/^tracekernel:\s*/, '');
    return {
      stdout: '',
      stderr: `curl: (7) ${message}\n`,
      exitCode: 7,
    };
  }
  return undefined;
}

/**
 * Network-facing command presentation over the workspace HTTP transport.
 *
 * Listener ownership, request accounting, external policy, and journaling stay
 * behind the injected dispatcher. This boundary only translates familiar CLI
 * commands into that transport contract.
 */
export class WorkspaceNetworkCommands {
  private readonly cwd: string;
  private readonly resolveHost: (hostname: string) => HostResolution;
  private readonly dispatchHttpRequest: (
    request: RuntimeKernelHttpRequest,
    context: CommandContext,
    options: CurlDispatchOptions
  ) => Promise<RuntimeKernelHttpResponse>;

  constructor(options: WorkspaceNetworkCommandsOptions) {
    this.cwd = options.cwd;
    this.resolveHost = options.resolveHost;
    this.dispatchHttpRequest = options.dispatchHttpRequest;
  }

  async curl(
    args: readonly string[],
    context: CommandContext
  ): Promise<RuntimeCommandResult> {
    let method: string | undefined;
    let body: string | undefined;
    let includeHeaders = false;
    let headOnly = false;
    let failOnHttpError = false;
    let appendDataToQuery = false;
    let outputPath: string | undefined;
    let timeoutMs: number | undefined;
    let verbose = false;
    let silent = false;
    let showError = false;
    let followLocation = false;
    let writeOut: string | undefined;
    let failWithBody = false;
    const headers: Record<string, string> = {};
    const rawHeaders: Array<[string, string]> = [];
    const urls: string[] = [];
    const addHeader = (header: string): void => {
      const separator = header.indexOf(':');
      if (separator === -1) return;
      const name = header.slice(0, separator).trim();
      if (!name) return;
      const value = header.slice(separator + 1).trim();
      headers[name.toLowerCase()] = value;
      rawHeaders.push([name, value]);
    };
    const appendBody = (data: string): void => {
      body = body === undefined ? data : `${body}&${data}`;
    };

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? '';
      if (arg === '--silent') {
        silent = true;
        continue;
      }
      if (arg === '--show-error') {
        showError = true;
        continue;
      }
      if (arg === '--location') {
        followLocation = true;
        continue;
      }
      if (arg === '--insecure') continue;
      if (/^-[sSfLiIkv]+$/.test(arg)) {
        for (const flag of arg.slice(1)) {
          if (flag === 's') silent = true;
          else if (flag === 'S') showError = true;
          else if (flag === 'f') failOnHttpError = true;
          else if (flag === 'i') includeHeaders = true;
          else if (flag === 'I') {
            method ??= 'HEAD';
            includeHeaders = true;
            headOnly = true;
          } else if (flag === 'v') verbose = true;
          else if (flag === 'L') followLocation = true;
        }
        continue;
      }
      if (arg === '-v' || arg === '--verbose') {
        verbose = true;
        continue;
      }
      if (arg === '-i' || arg === '--include') {
        includeHeaders = true;
        continue;
      }
      if (arg === '-I' || arg === '--head') {
        method ??= 'HEAD';
        includeHeaders = true;
        headOnly = true;
        continue;
      }
      if (arg === '-f' || arg === '--fail') {
        failOnHttpError = true;
        continue;
      }
      if (arg === '--fail-with-body') {
        failOnHttpError = true;
        failWithBody = true;
        continue;
      }
      if (arg === '-G' || arg === '--get') {
        appendDataToQuery = true;
        continue;
      }
      if (arg === '-o' || arg === '--output') {
        const next = args[++index];
        if (!next) {
          return {
            stdout: '',
            stderr:
              'curl: option requires an argument -- o\n',
            exitCode: 2,
          };
        }
        outputPath = next;
        continue;
      }
      if (arg.startsWith('--output=')) {
        outputPath = arg.slice('--output='.length);
        if (!outputPath) {
          return {
            stdout: '',
            stderr:
              'curl: option requires an argument -- output\n',
            exitCode: 2,
          };
        }
        continue;
      }
      if (arg === '-w' || arg === '--write-out') {
        const next = args[++index];
        if (next === undefined) {
          return {
            stdout: '',
            stderr:
              'curl: option requires an argument -- w\n',
            exitCode: 2,
          };
        }
        writeOut = next;
        continue;
      }
      if (arg.startsWith('--write-out=')) {
        writeOut = arg.slice('--write-out='.length);
        continue;
      }
      if (
        arg === '--max-time' ||
        arg === '--connect-timeout'
      ) {
        const next = args[++index];
        if (!next) {
          return {
            stdout: '',
            stderr:
              'curl: option requires an argument -- max-time\n',
            exitCode: 2,
          };
        }
        const seconds = Number(next);
        if (!Number.isFinite(seconds) || seconds < 0) {
          return {
            stdout: '',
            stderr: `curl: invalid --max-time value: ${next}\n`,
            exitCode: 2,
          };
        }
        timeoutMs = Math.max(1, Math.ceil(seconds * 1000));
        continue;
      }
      if (
        arg.startsWith('--max-time=') ||
        arg.startsWith('--connect-timeout=')
      ) {
        const value = arg.slice(arg.indexOf('=') + 1);
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0) {
          return {
            stdout: '',
            stderr:
              `curl: invalid --${
                arg.startsWith('--max-time=')
                  ? 'max-time'
                  : 'connect-timeout'
              } value: ${value}\n`,
            exitCode: 2,
          };
        }
        timeoutMs = Math.max(1, Math.ceil(seconds * 1000));
        continue;
      }
      if (arg === '-X' || arg === '--request') {
        const next = args[++index];
        if (!next) {
          return {
            stdout: '',
            stderr:
              'curl: option requires an argument -- X\n',
            exitCode: 2,
          };
        }
        method = next.toUpperCase();
        headOnly = method === 'HEAD';
        continue;
      }
      if (arg.startsWith('-X') && arg.length > 2) {
        method = arg.slice(2).toUpperCase();
        headOnly = method === 'HEAD';
        continue;
      }
      if (arg === '-H' || arg === '--header') {
        const next = args[++index];
        if (!next) {
          return {
            stdout: '',
            stderr:
              'curl: option requires an argument -- H\n',
            exitCode: 2,
          };
        }
        addHeader(next);
        continue;
      }
      if (arg.startsWith('--header=')) {
        addHeader(arg.slice('--header='.length));
        continue;
      }
      if (arg === '--json' || arg.startsWith('--json=')) {
        const next = arg === '--json'
          ? args[++index]
          : arg.slice('--json='.length);
        if (next === undefined) {
          return {
            stdout: '',
            stderr:
              'curl: option requires an argument -- json\n',
            exitCode: 2,
          };
        }
        appendBody(next);
        method ??= 'POST';
        headers['content-type'] ??= 'application/json';
        headers.accept ??= 'application/json';
        continue;
      }
      if (
        arg === '-d' ||
        arg === '--data' ||
        arg === '--data-raw' ||
        arg === '--data-binary'
      ) {
        const next = args[++index];
        if (next === undefined) {
          return {
            stdout: '',
            stderr:
              'curl: option requires an argument -- d\n',
            exitCode: 2,
          };
        }
        appendBody(next);
        method ??= 'POST';
        headers['content-type'] ??=
          'application/x-www-form-urlencoded';
        continue;
      }
      if (arg.startsWith('-d') && arg.length > 2) {
        appendBody(arg.slice(2));
        method ??= 'POST';
        headers['content-type'] ??=
          'application/x-www-form-urlencoded';
        continue;
      }
      if (
        arg.startsWith('--data=') ||
        arg.startsWith('--data-raw=')
      ) {
        appendBody(arg.slice(arg.indexOf('=') + 1));
        method ??= 'POST';
        headers['content-type'] ??=
          'application/x-www-form-urlencoded';
        continue;
      }
      if (arg.startsWith('-')) {
        return {
          stdout: '',
          stderr: `curl: unsupported option: ${arg}\n`,
          exitCode: 2,
        };
      }
      urls.push(arg);
    }

    if (urls.length !== 1) {
      return {
        stdout: '',
        stderr:
          urls.length === 0
            ? 'curl: no URL specified\n'
            : 'curl: (2) multiple URLs are not supported\n',
        exitCode: 2,
      };
    }
    const resolved = resolveCurlUrl(urls[0]!);
    if (!(resolved.scheme in CURL_PROTOCOLS)) {
      return {
        stdout: '',
        stderr:
          `curl: (1) Protocol "${resolved.scheme}" ` +
          'not supported\n',
        exitCode: 1,
      };
    }
    let url: URL;
    try {
      url = new URL(resolved.url);
    } catch {
      return {
        stdout: '',
        stderr: `curl: (3) URL rejected: ${urls[0]}\n`,
        exitCode: 3,
      };
    }
    if (appendDataToQuery && body !== undefined) {
      const params = new URLSearchParams(body);
      for (const [name, value] of params) {
        url.searchParams.append(name, value);
      }
      body = undefined;
      if (method === undefined || method === 'POST') method = 'GET';
    }

    let effectiveUrl = url;
    let effectiveMethod = method ?? 'GET';
    let effectiveBody = body;
    let response!: RuntimeKernelHttpResponse;
    let request!: RuntimeKernelHttpRequest;
    let redirectCount = 0;
    const credentialOrigin = effectiveUrl.origin;
    while (true) {
      const requestHeaders = { ...headers };
      let requestRawHeaders = [...rawHeaders];
      if (effectiveUrl.origin !== credentialOrigin) {
        delete requestHeaders.authorization;
        delete requestHeaders.cookie;
        delete requestHeaders['proxy-authorization'];
        requestRawHeaders = requestRawHeaders.filter(
          ([name]) =>
            ![
              'authorization',
              'cookie',
              'proxy-authorization',
            ].includes(name.toLowerCase())
        );
      }
      request = {
        method: effectiveMethod,
        url: effectiveUrl.toString(),
        path: `${effectiveUrl.pathname}${effectiveUrl.search}`,
        headers: requestHeaders,
        ...(requestRawHeaders.length > 0
          ? { rawHeaders: requestRawHeaders }
          : {}),
        ...(effectiveBody !== undefined
          ? { body: effectiveBody }
          : {}),
      };
      response = await this.dispatchHttpRequest(
        request,
        context,
        timeoutMs === undefined
          ? {}
          : {
              timeoutMs,
              timeoutBody:
                `curl: (28) Operation timed out after ` +
                `${timeoutMs} milliseconds\n`,
            }
      );
      const kernelError = curlErrorResult(response);
      if (kernelError) {
        return silent && !showError
          ? { ...kernelError, stderr: '' }
          : kernelError;
      }
      if (
        response.status === 0 &&
        response.body?.startsWith('curl: (28)')
      ) {
        return {
          stdout: '',
          stderr:
            silent && !showError
              ? ''
              : response.body ??
                'curl: (28) Operation timed out\n',
          exitCode: 28,
        };
      }
      if (response.status === 0) {
        return {
          stdout: '',
          stderr:
            silent && !showError
              ? ''
              : response.body ?? 'curl: connection failed\n',
          exitCode: 7,
        };
      }
      const location = httpHeaderValue(
        response.headers,
        'location'
      );
      if (
        !followLocation ||
        !location ||
        ![301, 302, 303, 307, 308].includes(response.status)
      ) {
        break;
      }
      redirectCount += 1;
      if (redirectCount > 20) {
        return {
          stdout: '',
          stderr:
            silent && !showError
              ? ''
              : 'curl: (47) Maximum (20) redirects followed\n',
          exitCode: 47,
        };
      }
      try {
        effectiveUrl = new URL(location, effectiveUrl);
      } catch {
        return {
          stdout: '',
          stderr:
            silent && !showError
              ? ''
              : 'curl: (3) The redirect target URL could ' +
                `not be parsed: ${location}\n`,
          exitCode: 3,
        };
      }
      if (
        effectiveMethod !== 'HEAD' &&
        (response.status === 303 ||
          ([301, 302].includes(response.status) &&
            effectiveMethod === 'POST'))
      ) {
        effectiveMethod = 'GET';
        effectiveBody = undefined;
      }
    }

    const responseHeaders = includeHeaders
      ? [
          `HTTP/1.1 ${response.status}`,
          ...Object.entries(response.headers ?? {}).map(
            ([name, value]) => `${name}: ${value}`
          ),
          '',
          '',
        ].join('\n')
      : '';
    const responseBodyBytes = headOnly
      ? new Uint8Array()
      : runtimeHttpBodyBytes(response);
    const responseBody =
      decodeUtf8(responseBodyBytes) ??
      new TextDecoder().decode(responseBodyBytes);
    const outputBody = `${responseHeaders}${responseBody}`;
    const writeOutText =
      writeOut === undefined
        ? ''
        : writeOut
            .replace(
              /%\{http_code\}/g,
              String(response.status).padStart(3, '0')
            )
            .replace(
              /%\{url_effective\}/g,
              effectiveUrl.toString()
            )
            .replace(
              /%\{size_download\}/g,
              String(responseBodyBytes.byteLength)
            )
            .replace(
              /%\{content_type\}/g,
              response.headers?.['content-type'] ?? ''
            )
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t');
    const verboseOutput = verbose
      ? [
          `* Connected to ${effectiveUrl.hostname} ` +
            `(${effectiveUrl.hostname}) port ${
              effectiveUrl.port ||
              (effectiveUrl.protocol === 'https:' ? '443' : '80')
            }`,
          `> ${request.method} ${request.path} HTTP/1.1`,
          `> Host: ${effectiveUrl.host}`,
          ...rawHeaders.map(
            ([name, value]) => `> ${name}: ${value}`
          ),
          '>',
          `< HTTP/1.1 ${response.status}`,
          ...Object.entries(response.headers ?? {}).map(
            ([name, value]) => `< ${name}: ${value}`
          ),
          '<',
        ].join('\n') + '\n'
      : '';

    if (failOnHttpError && response.status >= 400) {
      return {
        stdout:
          `${failWithBody ? outputBody : ''}${writeOutText}`,
        stderr:
          `${verboseOutput}${
            silent && !showError
              ? ''
              : 'curl: (22) The requested URL returned ' +
                `error: ${response.status}\n`
          }`,
        exitCode: 22,
      };
    }
    if (outputPath !== undefined) {
      try {
        if (outputPath !== '/dev/null') {
          const absoluteOutputPath = resolveWorkspaceContextPath(
            context,
            this.cwd,
            outputPath,
            'curl output path'
          );
          const parent = await context.fs.stat(
            dirname(absoluteOutputPath)
          );
          if (!parent.isDirectory) {
            throw new Error('Output parent is not a directory');
          }
          await context.fs.writeFile(
            absoluteOutputPath,
            responseHeaders ? outputBody : responseBodyBytes
          );
        }
      } catch {
        return {
          stdout: '',
          stderr:
            silent && !showError
              ? ''
              : 'curl: (23) Failed writing received data ' +
                'to disk/application\n',
          exitCode: 23,
        };
      }
      return {
        stdout: writeOutText,
        stderr: verboseOutput,
        exitCode: 0,
      };
    }
    return {
      stdout: `${outputBody}${writeOutText}`,
      stderr: verboseOutput,
      exitCode: 0,
    };
  }

  ping(args: readonly string[]): RuntimeCommandResult {
    let count = 3;
    const hosts: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? '';
      if (arg === '-c') {
        const next = args[++index];
        if (!next) {
          return {
            stdout: '',
            stderr:
              'ping: option requires an argument -- c\n',
            exitCode: 2,
          };
        }
        const parsed = Number(next);
        if (!Number.isInteger(parsed) || parsed < 1) {
          return {
            stdout: '',
            stderr: `ping: invalid count: ${next}\n`,
            exitCode: 2,
          };
        }
        count = parsed;
        continue;
      }
      if (arg.startsWith('-c') && arg.length > 2) {
        const value = arg.slice(2);
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          return {
            stdout: '',
            stderr: `ping: invalid count: ${value}\n`,
            exitCode: 2,
          };
        }
        count = parsed;
        continue;
      }
      if (arg.startsWith('-')) {
        return {
          stdout: '',
          stderr: `ping: unsupported option: ${arg}\n`,
          exitCode: 2,
        };
      }
      hosts.push(arg);
    }
    if (hosts.length !== 1) {
      return {
        stdout: '',
        stderr:
          hosts.length === 0
            ? 'ping: missing host operand\n'
            : 'ping: multiple hosts are not supported\n',
        exitCode: 2,
      };
    }
    const host = hosts[0]!;
    const resolution = this.resolveHost(host);
    if (!resolution.reachable) {
      return {
        stdout: '',
        stderr:
          `ping: cannot resolve ${host}: Unknown host\n`,
        exitCode: 68,
      };
    }
    const latency = formatPingLatency(resolution.latencyMs);
    const lines = [
      `PING ${host} (${resolution.ip}): 56 data bytes`,
      ...Array.from(
        { length: count },
        (_value, seq) =>
          `64 bytes from ${resolution.ip}: icmp_seq=${seq} ` +
          `ttl=64 time=${latency} ms`
      ),
      `--- ${host} ping statistics ---`,
      `${count} packets transmitted, ${count} received, ` +
        '0% packet loss',
      `round-trip min/avg/max = ` +
        `${latency}/${latency}/${latency} ms`,
    ];
    return {
      stdout: `${lines.join('\n')}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  async wget(
    args: readonly string[],
    context: CommandContext
  ): Promise<RuntimeCommandResult> {
    let outputDocument: string | undefined;
    let spider = false;
    let quiet = false;
    let url: string | undefined;
    const curlArgs: string[] = ['-L'];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '-q' || arg === '--quiet') {
        quiet = true;
      } else if (arg === '--spider') {
        spider = true;
      } else if (
        arg === '-O' ||
        arg === '--output-document'
      ) {
        outputDocument = args[index + 1];
        if (outputDocument === undefined) {
          return {
            stdout: '',
            stderr:
              'wget: option requires an argument -- O\n',
            exitCode: 2,
          };
        }
        index += 1;
      } else if (arg.startsWith('--output-document=')) {
        outputDocument = arg.slice(
          '--output-document='.length
        );
      } else if (arg.startsWith('-O') && arg.length > 2) {
        outputDocument = arg.slice(2);
      } else if (arg === '-T' || arg === '--timeout') {
        const timeout = args[index + 1];
        if (timeout === undefined) {
          return {
            stdout: '',
            stderr:
              'wget: option requires an argument -- T\n',
            exitCode: 2,
          };
        }
        curlArgs.push('--max-time', timeout);
        index += 1;
      } else if (arg.startsWith('--timeout=')) {
        curlArgs.push(
          '--max-time',
          arg.slice('--timeout='.length)
        );
      } else if (arg === '--header') {
        const header = args[index + 1];
        if (header === undefined) {
          return {
            stdout: '',
            stderr:
              'wget: option requires an argument -- header\n',
            exitCode: 2,
          };
        }
        curlArgs.push('--header', header);
        index += 1;
      } else if (arg.startsWith('--header=')) {
        curlArgs.push(
          '--header',
          arg.slice('--header='.length)
        );
      } else if (arg === '--post-data') {
        const data = args[index + 1];
        if (data === undefined) {
          return {
            stdout: '',
            stderr:
              'wget: option requires an argument -- post-data\n',
            exitCode: 2,
          };
        }
        curlArgs.push('--data', data);
        index += 1;
      } else if (arg.startsWith('--post-data=')) {
        curlArgs.push(
          '--data',
          arg.slice('--post-data='.length)
        );
      } else if (arg === '--') {
        if (args[index + 1] !== undefined) {
          url = args[++index];
        }
      } else if (arg === '-qO-' || arg === '-O-') {
        quiet ||= arg.startsWith('-q');
        outputDocument = '-';
      } else if (arg.startsWith('-')) {
        return {
          stdout: '',
          stderr: `wget: unrecognized option '${arg}'\n`,
          exitCode: 2,
        };
      } else if (!url) {
        url = arg;
      } else {
        return {
          stdout: '',
          stderr:
            'wget: multiple URLs are not supported in ' +
            'one invocation\n',
          exitCode: 2,
        };
      }
    }
    if (!url) {
      return {
        stdout: '',
        stderr: 'wget: missing URL\n',
        exitCode: 1,
      };
    }
    if (quiet) curlArgs.push('--silent');
    if (spider) {
      curlArgs.push('--head', '--fail');
      outputDocument = '-';
    }
    if (outputDocument === undefined) {
      try {
        const parsed = new URL(url);
        outputDocument =
          parsed.pathname.split('/').filter(Boolean).pop() ||
          'index.html';
      } catch {
        return {
          stdout: '',
          stderr: `wget: invalid URL '${url}'\n`,
          exitCode: 1,
        };
      }
    }
    if (outputDocument !== '-') {
      curlArgs.push('--output', outputDocument);
    }
    curlArgs.push(url);
    if (!context.exec) {
      return {
        stdout: '',
        stderr: 'wget: HTTP transport is unavailable\n',
        exitCode: 1,
      };
    }
    return context.exec('curl', {
      cwd: context.cwd,
      env: commandEnv(context),
      replaceEnv: true,
      stdin: decodeCommandStdin(context.stdin),
      stdinKind: 'bytes',
      signal: context.signal,
      args: curlArgs,
    });
  }
}

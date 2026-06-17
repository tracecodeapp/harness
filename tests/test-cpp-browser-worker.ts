#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runCommand, waitForHttp } from './example-app-smoke';
import { createRuntimeCommandStdinPipeFromText } from '../packages/harness-core/src/runtime-project';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

interface CppProjectWorkerFile {
  path: string;
  contents?: string;
  encoding?: string;
  directory?: true;
  deleted?: true;
}

interface CppProjectWorkerResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  files?: CppProjectWorkerFile[];
  events?: Array<{
    type: string;
    stream?: 'stdout' | 'stderr';
    device?: string;
    sourceDevice?: string;
    data?: string;
    phase?: string;
    change?: CppProjectWorkerFile;
  }>;
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-browser-'));
  const workersRoot = join(tempRoot, 'workers');
  const port = 5200 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;

  await runCommand('pnpm', ['exec', 'tsx', 'src/cli.ts', 'sync-assets', workersRoot], process.cwd());
  await writeFile(join(tempRoot, 'index.html'), '<!doctype html><title>C++ worker smoke</title>', 'utf8');

  const server = spawn('python3', ['-c', [
    'from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler',
    'import os',
    'class Handler(SimpleHTTPRequestHandler):',
    '    def end_headers(self):',
    '        self.send_header("Cross-Origin-Opener-Policy", "same-origin")',
    '        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")',
    '        super().end_headers()',
    `os.chdir(${JSON.stringify(tempRoot)})`,
    `ThreadingHTTPServer(("127.0.0.1", ${port}), Handler).serve_forever()`,
  ].join('\n')], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk) => process.stdout.write(String(chunk)));
  server.stderr?.on('data', (chunk) => process.stderr.write(String(chunk)));

  const browser = await chromium.launch({ headless: true });
  try {
    await waitForHttp(origin, 30_000);
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    await page.goto(origin);

    const results = await page.evaluate(`(async () => {
      const worker = new Worker('/workers/cpp-worker.js', { type: 'module' });
      let nextId = 0;
      const pending = new Map();
      const createRuntimeCommandStdinPipeFromText = (text) => {
        const encoded = new TextEncoder().encode(text);
        const capacity = Math.max(65536, encoded.byteLength + 1);
        const buffer = new SharedArrayBuffer(12 + capacity);
        const header = new Int32Array(buffer, 0, 3);
        new Uint8Array(buffer, 12).set(encoded);
        Atomics.store(header, 1, encoded.byteLength % capacity);
        Atomics.store(header, 2, 1);
        return { buffer };
      };
      const traceKernelProcFiles = [
        { path: '/proc/kernel/info', contents: '{\\n  "name": "tracekernel"\\n}\\n' },
        { path: '/proc/self/mountinfo', contents: '26 0 0:3 / /proc rw,nosuid,nodev,noexec - tracefs tracekernel:proc rw\\n' },
        { path: '/tracekernel/custom', contents: 'custom-kernel-file\\n' },
      ];
      const traceKernelDevices = [
        { path: '/dev/stdin', readable: true, writable: false, inputDevice: '/dev/stdin' },
        { path: '/dev/null', readable: true, writable: true, inputDevice: '/dev/null', outputDevice: '/dev/null' },
        { path: '/dev/stdout', readable: false, writable: true, outputDevice: '/dev/stdout' },
        { path: '/dev/stderr', readable: false, writable: true, outputDevice: '/dev/stderr' },
        { path: '/dev/tty', readable: true, writable: true, inputDevice: '/dev/stdin', outputDevice: '/dev/stderr' },
        { path: '/dev/log', readable: false, writable: true, outputDevice: '/dev/stderr' },
        { path: '/dev/capture', readable: false, writable: true, outputDevice: '/dev/capture' },
        { path: '/dev/tee', readable: false, writable: true, outputDevice: '/dev/capture' },
        { path: '/dev/custom-in', readable: true, writable: false, inputDevice: '/dev/stdin' },
        { path: '/dev/bad-output', readable: false, writable: true, outputDevice: '/tmp/not-a-device' },
      ];

      const compileInFrame = (payload) =>
        new Promise((resolve, reject) => {
          const iframe = document.createElement('iframe');
          const frameToken = 'tracecode-frame-token-' + (++nextId);
          iframe.src = '/workers/cpp-compiler-frame.html?tracecodeFrameToken=' + encodeURIComponent(frameToken);
          iframe.style.display = 'none';
          document.body.appendChild(iframe);
          const requestId = 'frame-' + (++nextId);
          const frameProtocolToken = 'cpp-frame-token-' + requestId;
          let timeoutId;
          const cleanup = () => {
            clearTimeout(timeoutId);
            window.removeEventListener('message', onFrameMessage);
            iframe.remove();
          };
          const onFrameMessage = (event) => {
            if (event.source !== iframe.contentWindow) return;
            if (event.data?.frameToken !== frameToken) return;
            if (event.data?.type === 'frame-ready') {
              iframe.contentWindow.postMessage({ id: requestId, type: 'compile', frameToken, payload, protocolToken: frameProtocolToken }, location.origin);
              return;
            }
            if (event.data?.id !== requestId) return;
            if (event.data?.protocolToken !== frameProtocolToken) return;
            cleanup();
            resolve(event.data.payload);
          };
          window.addEventListener('message', onFrameMessage);
          timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error('C++ compiler frame timed out'));
          }, 120_000);
        });

      worker.onmessage = (event) => {
        const { id, type, payload, requestId, protocolToken } = event.data;
        if (type === 'worker-ready') return;
        if (type === 'compile-request') {
          if (![...pending.values()].some((request) => request.protocolToken === protocolToken)) return;
          compileInFrame(payload).then((result) => {
            const transfer = result?.programBuffer instanceof ArrayBuffer ? [result.programBuffer] : [];
            worker.postMessage({ type: 'compile-response', requestId, protocolToken, payload: result }, transfer);
          }).catch((error) => {
            worker.postMessage({
              type: 'compile-response',
              requestId,
              protocolToken,
              payload: { success: false, error: error instanceof Error ? error.message : String(error) },
            });
          });
          return;
        }
        if (!id) return;
        const request = pending.get(id);
        if (!request) return;
        if (protocolToken !== request.protocolToken) return;
        if (type === 'project-event') {
          request.events.push(payload);
          return;
        }
        if (type === 'runtime-progress') {
          request.progress.push(payload);
          return;
        }
        pending.delete(id);
        clearTimeout(request.timeoutId);
        if (type === 'error') {
          request.reject(new Error(request.label + ': ' + String((payload && payload.error) || 'C++ worker error')));
        } else {
          request.resolve({ ...payload, events: request.events, progress: request.progress });
        }
      };
      worker.onerror = (event) => {
        for (const request of pending.values()) {
          clearTimeout(request.timeoutId);
          request.reject(new Error(event.message || 'C++ worker error'));
        }
        pending.clear();
      };

      const send = (type, payload) =>
        new Promise((resolve, reject) => {
          const id = String(++nextId);
          const protocolToken = 'cpp-test-token-' + id;
          const label = [
            type,
            payload?.source,
            payload?.scriptPath,
            Array.isArray(payload?.args) ? payload.args.join(' ') : '',
          ].filter(Boolean).join(' ');
          const timeoutId = setTimeout(() => {
            pending.delete(id);
            reject(new Error(label + ': C++ worker request timed out'));
          }, 180_000);
          pending.set(id, { resolve, reject, events: [], progress: [], label, protocolToken, timeoutId });
          const requestPayload = (() => {
            if (type !== 'execute-project-cpp' || payload?.source !== 'run' || !payload?.project || payload.project.kernelDevices !== undefined) {
              return payload;
            }
            const { noKernelDevicesForTest, ...project } = payload.project;
            if (noKernelDevicesForTest) return { ...payload, project };
            return { ...payload, project: { ...project, kernelDevices: traceKernelDevices } };
          })();
          worker.postMessage({ id, type, payload: requestPayload, protocolToken });
        });

      const decodeBase64 = (value) => {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      };

      const encodeBase64 = (bytes) => {
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      };

      const archiveHeader = (name, size) => {
        const field = (value, width) => String(value).slice(0, width).padEnd(width, ' ');
        return [
          field(name.endsWith('/') ? name : name + '/', 16),
          field('0', 12),
          field('0', 6),
          field('0', 6),
          field('100644', 8),
          field(size, 10),
          '\`\\n',
        ].join('');
      };

      const createArchiveBase64 = (name, contentsBase64) => {
        const contents = decodeBase64(contentsBase64);
        const header = new TextEncoder().encode('!<arch>\\n' + archiveHeader(name, contents.length));
        const padding = contents.length % 2 === 0 ? 0 : 1;
        const archive = new Uint8Array(header.length + contents.length + padding);
        archive.set(header, 0);
        archive.set(contents, header.length);
        if (padding) archive[archive.length - 1] = 10;
        return encodeBase64(archive);
      };

      await send('init', {
        assets: {
          compilerBundleUrl: '/workers/vendor/cpp/yowasp/bundle.js',
          compilerFrameEnabled: true,
          clangWasmUrl: '/workers/vendor/cpp/clang.wasm',
          lldWasmUrl: '/workers/vendor/cpp/lld.wasm',
          sysrootUrl: '/workers/vendor/cpp/sysroot.tar',
          runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
        },
      });
      const warmup = await send('warmup', {});

      const add = await send('compile-run', {
        code: 'class Solution { public: int add(int a, int b) { return a + b; } };',
        functionName: 'add',
        inputs: { a: 2, b: 3 },
      });
      const cachedAdd = await send('compile-run', {
        code: 'class Solution { public: int add(int a, int b) { return a + b; } };',
        functionName: 'add',
        inputs: { a: 5, b: 6 },
      });
      const twoSum = await send('compile-run', {
        code: 'class Solution { public: vector<int> twoSum(vector<int>& nums, int target) { unordered_map<int,int> seen; for (int i=0;i<nums.size();++i){ int c=target-nums[i]; if(seen.count(c)) return {seen[c],i}; seen[nums[i]]=i;} return {}; } };',
        functionName: 'twoSum',
        inputs: { nums: [2, 7, 11, 15], target: 9 },
      });
      const syntaxError = await send('compile-run', {
        code: [
          'class Solution {',
          'public:',
          '  int add(int a, int b) {',
          '    return a + ;',
          '  }',
          '};',
        ].join('\\n'),
        functionName: 'add',
        inputs: { a: 2, b: 3 },
      });
      const projectFiles = [
        {
          path: 'src/main.cpp',
          contents: [
            '#include "helper.hpp"',
            '#include <cstdlib>',
            '#include <cstdio>',
            '#include <dirent.h>',
            '#include <fcntl.h>',
            '#include <fstream>',
            '#include <iostream>',
            '#include <string>',
            '#include <sys/stat.h>',
            '#include <sys/statvfs.h>',
            '#include <time.h>',
            '#include <unistd.h>',
            'int main(int argc, char** argv) {',
            '  FILE* stdin_device = std::fopen("/dev/stdin", "r");',
            '  char device_line[64] = {0};',
            '  if (stdin_device) { std::fgets(device_line, sizeof(device_line), stdin_device); std::fclose(stdin_device); }',
            '  std::string line(device_line);',
            '  if (!line.empty() && line.back() == 10) line.pop_back();',
            '  std::cout << helper_value() << "\\\\n";',
            '  std::cout << line << "\\\\n";',
            '  std::string stdio_line;',
            '  std::getline(std::cin, stdio_line);',
            '  std::cout << stdio_line << "\\\\n";',
            '  std::cout << (std::getenv("MODE") ? std::getenv("MODE") : "") << "\\\\n";',
            '  std::cout << (argc > 2 ? std::string(argv[1]) + "," + argv[2] : "") << "\\\\n";',
            '  std::cout << line << "\\\\n";',
            '  FILE* custom_in_device = std::fopen("/dev/custom-in", "r");',
            '  char custom_device_line[64] = {0};',
            '  if (custom_in_device) { std::fgets(custom_device_line, sizeof(custom_device_line), custom_in_device); std::fclose(custom_in_device); }',
            '  std::string custom_line(custom_device_line);',
            '  if (!custom_line.empty() && custom_line.back() == 10) custom_line.pop_back();',
            '  std::cout << custom_line << "\\\\n";',
            '  std::ifstream proc_info("/proc/kernel/info");',
            '  std::string proc_text((std::istreambuf_iterator<char>(proc_info)), std::istreambuf_iterator<char>());',
            '  std::cout << (proc_text.find("\\\\"name\\\\": \\\\"tracekernel\\\\"") != std::string::npos ? "proc-info" : "proc-missing") << "\\\\n";',
            '  DIR* proc_kernel = opendir("/proc/kernel");',
            '  bool saw_info = false;',
            '  if (proc_kernel) { while (dirent* entry = readdir(proc_kernel)) { if (std::string(entry->d_name) == "info") saw_info = true; } closedir(proc_kernel); }',
            '  std::cout << (saw_info ? "info" : "missing") << "\\\\n";',
            '  std::ofstream proc_write("/proc/kernel/info");',
            '  std::cout << (proc_write ? "proc-write:ok" : "proc-write:blocked") << "\\\\n";',
            '  std::ifstream custom_kernel_info("/tracekernel/custom");',
            '  std::string custom_kernel_text((std::istreambuf_iterator<char>(custom_kernel_info)), std::istreambuf_iterator<char>());',
            '  std::cout << custom_kernel_text;',
            '  std::ofstream custom_kernel_write("/tracekernel/custom");',
            '  std::cout << (custom_kernel_write ? "custom-kernel-write:ok" : "custom-kernel-write:blocked") << "\\\\n";',
            '  std::cout << (mkdir("/tracekernel/new", 0777) == 0 ? "custom-kernel-mkdir:ok" : "custom-kernel-mkdir:blocked") << "\\\\n";',
            '  std::ofstream custom_kernel_create("/tracekernel/new.txt");',
            '  std::cout << (custom_kernel_create ? "custom-kernel-create:ok" : "custom-kernel-create:blocked") << "\\\\n";',
            '  timespec blocked_times[2] = {};',
            '  blocked_times[0].tv_nsec = UTIME_NOW;',
            '  blocked_times[1].tv_nsec = UTIME_NOW;',
            '  std::cout << (utimensat(AT_FDCWD, "/proc/kernel/info", blocked_times, 0) == 0 ? "proc-utime:ok" : "proc-utime:blocked") << "\\\\n";',
            '  std::cout << (utimensat(AT_FDCWD, "/tracekernel/custom", blocked_times, 0) == 0 ? "custom-kernel-utime:ok" : "custom-kernel-utime:blocked") << "\\\\n";',
            '  DIR* dev_dir = opendir("/dev");',
            '  bool saw_stdin = false;',
            '  bool saw_null = false;',
            '  bool saw_stdout = false;',
            '  bool saw_log = false;',
            '  bool saw_custom_in = false;',
            '  if (dev_dir) { while (dirent* entry = readdir(dev_dir)) { std::string name(entry->d_name); if (name == "stdin") saw_stdin = true; if (name == "null") saw_null = true; if (name == "stdout") saw_stdout = true; if (name == "log") saw_log = true; if (name == "custom-in") saw_custom_in = true; } closedir(dev_dir); }',
            '  std::cout << (saw_stdin && saw_null && saw_stdout && saw_log && saw_custom_in ? "dev-list:ok" : "dev-list:missing") << "\\\\n";',
            '  struct stat dev_stat = {};',
            '  struct stat stdout_stat = {};',
            '  bool dev_stat_ok = stat("/dev", &dev_stat) == 0 && stat("/dev/stdout", &stdout_stat) == 0;',
            '  std::cout << (dev_stat_ok && S_ISDIR(dev_stat.st_mode) && !S_ISDIR(stdout_stat.st_mode) ? "dev-stat:ok" : "dev-stat:bad") << "\\\\n";',
            '  struct statvfs root_vfs = {};',
            '  struct statvfs dev_vfs = {};',
            '  struct statvfs proc_vfs = {};',
            '  bool statvfs_ok = statvfs(".", &root_vfs) == 0 && statvfs("/dev/stdout", &dev_vfs) == 0 && statvfs("/proc/kernel/info", &proc_vfs) == 0;',
            '  std::cout << (statvfs_ok && root_vfs.f_bsize > 0 && dev_vfs.f_bsize == root_vfs.f_bsize && proc_vfs.f_blocks == root_vfs.f_blocks ? "statvfs:ok" : "statvfs:bad") << "\\\\n";',
            '  std::cout << (statvfs("/dev/missing", &dev_vfs) == 0 ? "statvfs-dev-missing:ok" : "statvfs-dev-missing:blocked") << "\\\\n";',
            '  std::cout << (statvfs("/proc/missing", &proc_vfs) == 0 ? "statvfs-proc-missing:ok" : "statvfs-proc-missing:blocked") << "\\\\n";',
            '  int stdout_stat_fd = open("/dev/stdout", O_WRONLY);',
            '  struct stat stdout_fd_stat = {};',
            '  bool stdout_fd_stat_ok = stdout_stat_fd >= 0 && fstat(stdout_stat_fd, &stdout_fd_stat) == 0;',
            '  if (stdout_stat_fd >= 0) close(stdout_stat_fd);',
            '  std::cout << (stdout_fd_stat_ok && !S_ISDIR(stdout_fd_stat.st_mode) ? "dev-fstat:ok" : "dev-fstat:bad") << "\\\\n";',
            '  std::ifstream stdout_read("/dev/stdout");',
            '  std::cout << (stdout_read ? "dev-stdout-read:ok" : "dev-stdout-read:blocked") << "\\\\n";',
            '  std::ifstream null_read("/dev/null");',
            '  std::string null_contents((std::istreambuf_iterator<char>(null_read)), std::istreambuf_iterator<char>());',
            '  std::cout << "dev-null:" << null_contents.size() << "\\\\n";',
            '  std::cout << (std::remove("/dev/stdout") == 0 ? "dev-unlink:ok" : "dev-unlink:blocked") << "\\\\n";',
            '  std::cout << (utimensat(AT_FDCWD, "/dev/stdout", blocked_times, 0) == 0 ? "dev-utime:ok" : "dev-utime:blocked") << "\\\\n";',
            '  std::ofstream("rename-device-source.txt") << "blocked\\\\n";',
            '  std::cout << (std::rename("rename-device-source.txt", "/dev/stdout") == 0 ? "dev-rename:ok" : "dev-rename:blocked") << "\\\\n";',
            '  std::remove("rename-device-source.txt");',
            '  std::ofstream("rename-kernel-source.txt") << "blocked\\\\n";',
            '  std::cout << (std::rename("rename-kernel-source.txt", "/tracekernel/renamed") == 0 ? "custom-kernel-rename:ok" : "custom-kernel-rename:blocked") << "\\\\n";',
            '  std::remove("rename-kernel-source.txt");',
            '  FILE* stdout_device = std::fopen("/dev/stdout", "w");',
            '  if (stdout_device) { std::fputs("device-out\\\\n", stdout_device); std::fclose(stdout_device); }',
            '  FILE* stderr_device = std::fopen("/dev/stderr", "w");',
            '  if (stderr_device) { std::fputs("device-err\\\\n", stderr_device); std::fclose(stderr_device); }',
            '  FILE* tty_device = std::fopen("/dev/tty", "w");',
            '  if (tty_device) { std::fputs("tty-device\\\\n", tty_device); std::fclose(tty_device); }',
            '  FILE* log_device = std::fopen("/dev/log", "w");',
            '  if (log_device) { std::fputs("log-device\\\\n", log_device); std::fclose(log_device); }',
            '  FILE* null_device = std::fopen("/dev/null", "w");',
            '  if (null_device) { std::fputs("null-device\\\\n", null_device); std::fclose(null_device); }',
            '  FILE* capture_device = std::fopen("/dev/capture", "w");',
            '  if (capture_device) { std::fputs("capture-device\\\\n", capture_device); std::fclose(capture_device); }',
            '  FILE* tee_device = std::fopen("/dev/tee", "w");',
            '  if (tee_device) { std::fputs("tee-device\\\\n", tee_device); std::fclose(tee_device); }',
            '  FILE* bad_output_device = std::fopen("/dev/bad-output", "w");',
            '  if (bad_output_device) { std::fputs("bad-output-device\\\\n", bad_output_device); std::fclose(bad_output_device); }',
            '  std::ofstream("generated.txt") << helper_value() << "\\\\n";',
            '  std::ofstream bytes("bytes.bin", std::ios::binary);',
            '  char raw[2] = {0, static_cast<char>(255)};',
            '  bytes.write(raw, 2);',
            '  int patch_fd = open("patched.txt", O_CREAT | O_WRONLY, 0644);',
            '  if (patch_fd >= 0) { write(patch_fd, "abcd", 4); pwrite(patch_fd, "XY", 2, 1); close(patch_fd); }',
            '  int truncate_fd = open("truncated.txt", O_CREAT | O_WRONLY, 0644);',
            '  if (truncate_fd >= 0) { write(truncate_fd, "abcdef", 6); ftruncate(truncate_fd, 3); close(truncate_fd); }',
            '  int readonly_seed_fd = open("readonly-fd.txt", O_CREAT | O_WRONLY, 0644);',
            '  if (readonly_seed_fd >= 0) { write(readonly_seed_fd, "original\\\\n", 9); close(readonly_seed_fd); }',
            '  int readonly_fd = open("readonly-fd.txt", O_RDONLY);',
            '  int readonly_pwrite_result = -1;',
            '  int readonly_truncate_result = -1;',
            '  if (readonly_fd >= 0) { readonly_pwrite_result = pwrite(readonly_fd, "X", 1, 0); readonly_truncate_result = ftruncate(readonly_fd, 4); close(readonly_fd); }',
            '  std::ifstream readonly_file("readonly-fd.txt");',
            '  std::string readonly_contents((std::istreambuf_iterator<char>(readonly_file)), std::istreambuf_iterator<char>());',
            '  std::cout << (readonly_pwrite_result < 0 && readonly_truncate_result < 0 && readonly_contents == "original\\\\n" ? "readonly-fd-mutation:blocked" : "readonly-fd-mutation:changed") << "\\\\n";',
            '  int allocated_fd = open("allocated.bin", O_CREAT | O_RDWR, 0644);',
            '  if (allocated_fd >= 0) { posix_fallocate(allocated_fd, 0, 4); write(allocated_fd, "hi", 2); close(allocated_fd); }',
            '  std::cout << "before-live\\\\n" << std::flush;',
            '  std::ofstream multi("multi.txt");',
            '  multi << "one";',
            '  multi.flush();',
            '  std::cout << "after-multi-one\\\\n" << std::flush;',
            '  multi << "two\\\\n";',
            '  multi.close();',
            '  int zero_fd = open("zero.txt", O_CREAT | O_WRONLY, 0644);',
            '  if (zero_fd >= 0) { write(zero_fd, "nonzero", 7); ftruncate(zero_fd, 0); close(zero_fd); }',
            '  int empty_fd = open("empty-open.txt", O_CREAT | O_TRUNC | O_WRONLY, 0644);',
            '  if (empty_fd >= 0) { close(empty_fd); }',
            '  std::ofstream("metadata-only.txt") << "metadata\\\\n";',
            '  timespec metadata_times[2] = {};',
            '  metadata_times[0].tv_nsec = UTIME_NOW;',
            '  metadata_times[1].tv_nsec = UTIME_NOW;',
            '  std::cout << (utimensat(AT_FDCWD, "metadata-only.txt", metadata_times, 0) == 0 ? "metadata-utime:ok" : "metadata-utime:blocked") << "\\\\n";',
            '  int metadata_fd = open("metadata-only.txt", O_RDONLY);',
            '  int metadata_futimens_result = -1;',
            '  if (metadata_fd >= 0) { metadata_futimens_result = futimens(metadata_fd, metadata_times); close(metadata_fd); }',
            '  std::cout << (metadata_futimens_result == 0 ? "metadata-futimens:ok" : "metadata-futimens:blocked") << "\\\\n";',
            '  int missing_remove_result = std::remove("missing-delete.txt");',
            '  std::cout << (missing_remove_result == 0 ? "missing-remove:ok" : "missing-remove:blocked") << "\\\\n";',
            '  int mkdir_missing_parent_result = mkdir("missing-parent/child", 0777);',
            '  std::cout << (mkdir_missing_parent_result == 0 ? "mkdir-missing-parent:ok" : "mkdir-missing-parent:blocked") << "\\\\n";',
            '  int open_missing_parent_fd = open("missing-open/file.txt", O_CREAT | O_WRONLY, 0644);',
            '  std::cout << (open_missing_parent_fd >= 0 ? "open-missing-parent:ok" : "open-missing-parent:blocked") << "\\\\n";',
            '  if (open_missing_parent_fd >= 0) close(open_missing_parent_fd);',
            '  std::ofstream("rename-parent-source.txt") << "blocked\\\\n";',
            '  std::cout << (std::rename("rename-parent-source.txt", "missing-rename/child.txt") == 0 ? "rename-missing-parent:ok" : "rename-missing-parent:blocked") << "\\\\n";',
            '  std::remove("rename-parent-source.txt");',
            '  mkdir("existing-dir", 0777);',
            '  std::ofstream("rename-file-source.txt") << "blocked\\\\n";',
            '  std::cout << (std::rename("rename-file-source.txt", "existing-dir") == 0 ? "rename-file-onto-dir:ok" : "rename-file-onto-dir:blocked") << "\\\\n";',
            '  std::remove("rename-file-source.txt");',
            '  mkdir("open-dir", 0777);',
            '  int open_dir_write_fd = open("open-dir", O_WRONLY);',
            '  std::cout << (open_dir_write_fd >= 0 ? "open-dir-write:ok" : "open-dir-write:blocked") << "\\\\n";',
            '  if (open_dir_write_fd >= 0) close(open_dir_write_fd);',
            '  int open_dir_truncate_fd = open("open-dir", O_TRUNC | O_WRONLY);',
            '  std::cout << (open_dir_truncate_fd >= 0 ? "open-dir-truncate:ok" : "open-dir-truncate:blocked") << "\\\\n";',
            '  if (open_dir_truncate_fd >= 0) close(open_dir_truncate_fd);',
            '  mkdir("rename-dir-onto-file", 0777);',
            '  std::ofstream("rename-dir-target.txt") << "target\\\\n";',
            '  std::cout << (std::rename("rename-dir-onto-file", "rename-dir-target.txt") == 0 ? "rename-dir-onto-file:ok" : "rename-dir-onto-file:blocked") << "\\\\n";',
            '  mkdir("rename-dir-existing-source", 0777);',
            '  std::ofstream("rename-dir-existing-source/child.txt") << "source\\\\n";',
            '  mkdir("rename-dir-existing-target", 0777);',
            '  int rename_dir_existing_result = std::rename("rename-dir-existing-source", "rename-dir-existing-target");',
            '  std::ifstream rename_dir_existing_child("rename-dir-existing-source/child.txt");',
            '  std::string rename_dir_existing_text((std::istreambuf_iterator<char>(rename_dir_existing_child)), std::istreambuf_iterator<char>());',
            '  std::cout << (rename_dir_existing_result != 0 && rename_dir_existing_text == "source\\\\n" ? "rename-dir-existing:blocked" : "rename-dir-existing:changed") << "\\\\n";',
            '  mkdir("rename-dir-desc", 0777);',
            '  mkdir("rename-dir-desc/child", 0777);',
            '  std::ofstream("rename-dir-desc/child/value.txt") << "desc\\\\n";',
            '  int rename_dir_desc_result = std::rename("rename-dir-desc", "rename-dir-desc/child/moved");',
            '  std::ifstream rename_dir_desc_file("rename-dir-desc/child/value.txt");',
            '  std::string rename_dir_desc_text((std::istreambuf_iterator<char>(rename_dir_desc_file)), std::istreambuf_iterator<char>());',
            '  std::cout << (rename_dir_desc_result != 0 && rename_dir_desc_text == "desc\\\\n" ? "rename-dir-descendant:blocked" : "rename-dir-descendant:changed") << "\\\\n";',
            '  mkdir("unlink-dir", 0777);',
            '  int unlink_dir_result = unlink("unlink-dir");',
            '  std::cout << (unlink_dir_result == 0 ? "unlink-dir:ok" : "unlink-dir:blocked") << "\\\\n";',
            '  rmdir("unlink-dir");',
            '  std::ofstream("link-source.txt") << "linked\\\\n";',
            '  char readlink_buffer[64] = {0};',
            '  int link_result = link("link-source.txt", "link-hard.txt");',
            '  int readlink_result = readlink("link-source.txt", readlink_buffer, sizeof(readlink_buffer));',
            '  int symlink_result = symlink("link-source.txt", "link-symlink.txt");',
            '  int link_proc_result = link("/proc/kernel/info", "link-proc.txt");',
            '  int link_missing_parent_result = link("link-source.txt", "missing-link/child.txt");',
            '  int symlink_dev_result = symlink("link-source.txt", "/dev/stdout");',
            '  std::ifstream link_hard("link-hard.txt");',
            '  std::string link_hard_text((std::istreambuf_iterator<char>(link_hard)), std::istreambuf_iterator<char>());',
            '  std::cout << (link_result == 0 && link_hard_text == "linked\\\\n" ? "link-hard:ok" : "link-hard:blocked") << "\\\\n";',
            '  std::cout << (readlink_result < 0 ? "readlink:blocked" : "readlink:ok") << "\\\\n";',
            '  std::cout << (symlink_result < 0 ? "symlink:blocked" : "symlink:ok") << "\\\\n";',
            '  std::cout << (link_proc_result < 0 ? "link-proc:blocked" : "link-proc:ok") << "\\\\n";',
            '  std::cout << (link_missing_parent_result < 0 ? "link-missing-parent:blocked" : "link-missing-parent:ok") << "\\\\n";',
            '  std::cout << (symlink_dev_result < 0 ? "symlink-dev:blocked" : "symlink-dev:ok") << "\\\\n";',
            '  std::ofstream("dev/local.txt") << "local-dev\\\\n";',
            '  std::ifstream local_dev_file("dev/local.txt");',
            '  std::string local_dev_text((std::istreambuf_iterator<char>(local_dev_file)), std::istreambuf_iterator<char>());',
            '  std::cout << (local_dev_text == "local-dev\\\\n" ? "local-dev-path:ok" : "local-dev-path:blocked") << "\\\\n";',
            '  mkdir("scratch", 0777);',
            '  std::ofstream("scratch/transient.txt") << "gone\\\\n";',
            '  std::remove("scratch/transient.txt");',
            '  int rmdir_result = rmdir("scratch");',
            '  DIR* scratch_dir = opendir("scratch");',
            '  std::cout << (rmdir_result == 0 && !scratch_dir ? "rmdir:gone" : "rmdir:still") << "\\\\n";',
            '  if (scratch_dir) closedir(scratch_dir);',
            '  mkdir("persist-dir", 0777);',
            '  rmdir("stale-dir");',
            '  mkdir("rename-dir", 0777);',
            '  std::rename("rename-dir", "renamed-dir");',
            '  rmdir("renamed-dir");',
            '  int rename_self_file_result = std::rename("self-rename-file.txt", "self-rename-file.txt");',
            '  std::ifstream self_rename_file("self-rename-file.txt");',
            '  std::string self_rename_file_text((std::istreambuf_iterator<char>(self_rename_file)), std::istreambuf_iterator<char>());',
            '  std::cout << (rename_self_file_result == 0 && self_rename_file_text == "self-file\\\\n" ? "rename-self-file:ok" : "rename-self-file:changed") << "\\\\n";',
            '  int rename_self_dir_result = std::rename("self-rename-dir", "self-rename-dir");',
            '  std::ifstream self_rename_dir_file("self-rename-dir/child.txt");',
            '  std::string self_rename_dir_text((std::istreambuf_iterator<char>(self_rename_dir_file)), std::istreambuf_iterator<char>());',
            '  std::cout << (rename_self_dir_result == 0 && self_rename_dir_text == "self-dir\\\\n" ? "rename-self-dir:ok" : "rename-self-dir:changed") << "\\\\n";',
            '  std::ofstream("rename-source.txt") << "moved\\\\n";',
            '  std::rename("rename-source.txt", "renamed.txt");',
            '  std::remove("stale.txt");',
            '  return 0;',
            '}',
            '',
          ].join('\\n'),
        },
        { path: 'src/helper.hpp', contents: 'int helper_value();\\n' },
        { path: 'src/helper.cpp', contents: '#include "helper.hpp"\\nint helper_value() { return 42; }\\n' },
        { path: 'src/dev/.keep', contents: '' },
        {
          path: 'src/absolute_main.cpp',
          contents: [
            '#include <answer.hpp>',
            '#include <iostream>',
            'int main() {',
            '  std::cout << absolute_answer() << "\\\\n";',
            '  return 0;',
            '}',
            '',
          ].join('\\n'),
        },
        { path: 'include/answer.hpp', contents: 'inline int absolute_answer() { return 99; }\\n' },
        {
          path: 'envinclude/env_answer.hpp',
          contents: 'inline int env_answer() { return 2026; }\\n',
        },
        {
          path: 'cppinclude/cpp_answer.hpp',
          contents: 'inline int cpp_answer() { return 2028; }\\n',
        },
        {
          path: 'cinclude/c_answer.h',
          contents: '#define C_ANSWER 2027\\n',
        },
        {
          path: 'src/env_include_main.cpp',
          contents: '#include <env_answer.hpp>\\n#include <iostream>\\nint main() { std::cout << env_answer() << "\\\\n"; }\\n',
        },
        {
          path: 'src/cplus_include_main.cpp',
          contents: '#include <cpp_answer.hpp>\\n#include <iostream>\\nint main() { std::cout << cpp_answer() << "\\\\n"; }\\n',
        },
        {
          path: 'src/env_c_include_main.c',
          contents: '#include <c_answer.h>\\n#include <stdio.h>\\nint main(void) { printf("%d\\\\n", C_ANSWER); return 0; }\\n',
        },
        { path: 'src/link_main.cpp', contents: '#include <iostream>\\nint linked_value();\\nint main() { std::cout << linked_value() << "\\\\n"; }\\n' },
        { path: 'src/linked.cpp', contents: 'int linked_value() { return 1234; }\\n' },
        { path: 'src/plain.c', contents: '#include <stdio.h>\\nint main(void) { printf("plain-c\\\\n"); return 0; }\\n' },
        {
          path: 'src/empty_dir_main.cpp',
          contents: '#include <dirent.h>\\n#include <iostream>\\n#include <string>\\nint main() { DIR* child = opendir("empty/child"); std::cout << (child ? "dir" : "missing") << "\\\\n"; if (child) closedir(child); DIR* parent = opendir("empty"); bool saw = false; if (parent) { while (dirent* entry = readdir(parent)) { if (std::string(entry->d_name) == "child") saw = true; } closedir(parent); } std::cout << (saw ? "child" : "missing") << "\\\\n"; }\\n',
        },
        {
          path: 'src/no_device_main.cpp',
          contents: [
            '#include <cstdio>',
            '#include <fstream>',
            '#include <iostream>',
            'int main() {',
            '  std::cout << "fd-stdout" << "\\\\n";',
            '  std::cerr << "fd-stderr" << "\\\\n";',
            '  FILE* stdout_device = std::fopen("/dev/stdout", "w");',
            '  std::cout << (stdout_device ? "dev-stdout:ok" : "dev-stdout:blocked") << "\\\\n";',
            '  if (stdout_device) { std::fputs("invented\\\\n", stdout_device); std::fclose(stdout_device); }',
            '  std::ifstream stdout_read("/dev/stdout");',
            '  std::cout << (stdout_read ? "dev-stdout-read:ok" : "dev-stdout-read:blocked") << "\\\\n";',
            '  return 0;',
            '}',
            '',
          ].join('\\n'),
        },
        {
          path: 'src/custom_input_only_main.cpp',
          contents: [
            '#include <cstdio>',
            '#include <dirent.h>',
            '#include <iostream>',
            '#include <string>',
            'int main() {',
            '  FILE* custom_in = std::fopen("/dev/custom-in", "r");',
            '  char custom_line[64] = {0};',
            '  if (custom_in) { std::fgets(custom_line, sizeof(custom_line), custom_in); std::fclose(custom_in); }',
            '  DIR* dev_dir = opendir("/dev");',
            '  bool saw_custom = false;',
            '  bool saw_stdin = false;',
            '  bool saw_nested = false;',
            '  if (dev_dir) { while (dirent* entry = readdir(dev_dir)) { std::string name(entry->d_name); if (name == "custom-in") saw_custom = true; if (name == "stdin") saw_stdin = true; if (name == "nested/device") saw_nested = true; } closedir(dev_dir); }',
            '  std::cout << custom_line;',
            '  std::cout << (saw_custom && !saw_stdin && !saw_nested ? "custom-only:ok" : "custom-only:bad") << "\\\\n";',
            '  return 0;',
            '}',
            '',
          ].join('\\n'),
        },
        { path: 'build/.keep', contents: '' },
        { path: 'src/stale.txt', contents: 'delete me\\n' },
        { path: 'src/self-rename-file.txt', contents: 'self-file\\n' },
        { path: 'src/self-rename-dir/child.txt', contents: 'self-dir\\n' },
      ];
      const projectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: 'main.cpp',
        args: ['-v', 'main.cpp', 'helper.cpp', '-o', 'a.out'],
        cwd: '/workspace/src',
        env: {},
        project: { files: projectFiles },
      });
      const projectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: './a.out',
        args: ['alpha', 'beta'],
        cwd: '/workspace/src',
        env: { MODE: 'browser-cpp-project' },
        stdinPipe: createRuntimeCommandStdinPipeFromText('from-dev\\nfrom-stdio\\nfrom-custom\\n'),
        project: { files: [...projectFiles, ...(projectCompile.files || [])], directories: ['src/stale-dir'], kernelFiles: traceKernelProcFiles, kernelDevices: traceKernelDevices },
      });
      const projectDeviceLeakRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: './a.out',
        args: ['alpha', 'beta'],
        cwd: '/workspace/src',
        env: { MODE: 'browser-cpp-project' },
        stdinPipe: createRuntimeCommandStdinPipeFromText('from-dev\\nfrom-stdio\\nfrom-custom\\n'),
        project: {
          files: [...projectFiles, ...(projectCompile.files || [])],
          kernelFiles: traceKernelProcFiles,
          kernelDevices: traceKernelDevices.filter((device) => device.path !== '/dev/log'),
        },
      });
      const absoluteProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/absolute_main.cpp',
        args: ['/workspace/src/absolute_main.cpp', '-I', '/workspace/include', '-isystem/workspace/include', '-o', '/workspace/out/absolute-app'],
        cwd: '/workspace/src',
        env: {},
        project: { files: projectFiles },
      });
      const absoluteProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/absolute-app',
        args: [],
        cwd: '/workspace/src',
        env: { MODE: 'browser-cpp-absolute' },
        stdinPipe: createRuntimeCommandStdinPipeFromText('absolute-stdin\\n'),
        project: { files: [...projectFiles, ...(absoluteProjectCompile.files || [])] },
      });
      const inlineAbsoluteIncludeCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/absolute_main.cpp',
        args: ['/workspace/src/absolute_main.cpp', '-I/workspace/include', '-o', '/workspace/out/inline-include-app'],
        cwd: '/workspace/src',
        env: {},
        project: { files: projectFiles },
      });
      const inlineAbsoluteIncludeRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/inline-include-app',
        args: [],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, ...(inlineAbsoluteIncludeCompile.files || [])] },
      });
      const canonicalProject = {
        cwd: '/home/ada/weather-api',
        workspaceRoot: '/home/ada/weather-api',
        workspaceAlias: '/workspace',
        files: projectFiles,
      };
      const canonicalProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/home/ada/weather-api/src/absolute_main.cpp',
        args: [
          '/home/ada/weather-api/src/absolute_main.cpp',
          '-I',
          '/home/ada/weather-api/include',
          '-isystem/home/ada/weather-api/include',
          '-o',
          '/home/ada/weather-api/out/canonical-app',
        ],
        cwd: '/home/ada/weather-api/src',
        env: { CPATH: '/home/ada/weather-api/include' },
        project: canonicalProject,
      });
      const canonicalProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/home/ada/weather-api/out/canonical-app',
        args: [],
        cwd: '/home/ada/weather-api/src',
        env: {},
        project: { ...canonicalProject, files: [...projectFiles, ...(canonicalProjectCompile.files || [])] },
      });
      let outsideCwdError = '';
      try {
        await send('execute-project-cpp', {
          source: 'compile',
          scriptPath: 'main.cpp',
          args: ['main.cpp', '-o', 'bad-app'],
          cwd: '/outside',
          env: {},
          project: { files: projectFiles },
        });
      } catch (error) {
        outsideCwdError = error instanceof Error ? error.message : String(error);
      }
      let outsideIncludeArgError = '';
      try {
        await send('execute-project-cpp', {
          source: 'compile',
          scriptPath: 'main.cpp',
          args: ['main.cpp', '-I', '/outside/include', '-o', 'bad-app'],
          cwd: '/workspace/src',
          env: {},
          project: { files: projectFiles },
        });
      } catch (error) {
        outsideIncludeArgError = error instanceof Error ? error.message : String(error);
      }
      let outsideRelativeIncludeArgError = '';
      try {
        await send('execute-project-cpp', {
          source: 'compile',
          scriptPath: 'main.cpp',
          args: ['main.cpp', '-I', '../outside/include', '-o', 'bad-app'],
          cwd: '/workspace',
          env: {},
          project: { files: projectFiles },
        });
      } catch (error) {
        outsideRelativeIncludeArgError = error instanceof Error ? error.message : String(error);
      }
      let outsideLibraryArgError = '';
      try {
        await send('execute-project-cpp', {
          source: 'compile',
          scriptPath: 'main.cpp',
          args: ['main.cpp', '-L', '/outside/lib', '-o', 'bad-app'],
          cwd: '/workspace/src',
          env: {},
          project: { files: projectFiles },
        });
      } catch (error) {
        outsideLibraryArgError = error instanceof Error ? error.message : String(error);
      }
      let outsideLibraryEnvError = '';
      try {
        await send('execute-project-cpp', {
          source: 'compile',
          scriptPath: 'main.cpp',
          args: ['main.cpp', '-o', 'bad-app'],
          cwd: '/workspace/src',
          env: { LIBRARY_PATH: '/outside/lib' },
          project: { files: projectFiles },
        });
      } catch (error) {
        outsideLibraryEnvError = error instanceof Error ? error.message : String(error);
      }
      const stdinProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '<stdin>',
        code: '#include <iostream>\\nint main() { std::cout << "stdin-cpp" << "\\\\n"; }\\n',
        args: ['-x', 'c++', '-', '-o', '/workspace/out/stdin-app'],
        cwd: '/workspace/src',
        env: {},
        project: { files: projectFiles },
      });
      const stdinProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/stdin-app',
        args: [],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, ...(stdinProjectCompile.files || [])] },
      });
      const cProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/plain.c',
        args: ['/workspace/src/plain.c', '-o', '/workspace/out/plain-c'],
        cwd: '/workspace/src',
        env: {},
        project: { files: projectFiles },
        options: { compilerCommand: 'gcc' },
      });
      const cProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/plain-c',
        args: [],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, ...(cProjectCompile.files || [])] },
      });
      const emptyDirectoryCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/empty_dir_main.cpp',
        args: ['/workspace/src/empty_dir_main.cpp', '-o', '/workspace/out/empty-dir-app'],
        cwd: '/workspace/src',
        env: {},
        project: { files: projectFiles, directories: ['empty/child'] },
      });
      const emptyDirectoryRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/empty-dir-app',
        args: [],
        cwd: '/workspace',
        env: {},
        project: { files: [...projectFiles, ...(emptyDirectoryCompile.files || [])], directories: ['empty/child'] },
      });
      const noDeviceManifestCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/no_device_main.cpp',
        args: ['/workspace/src/no_device_main.cpp', '-o', '/workspace/out/no-device-app'],
        cwd: '/workspace/src',
        env: {},
        project: { files: projectFiles },
      });
      const noDeviceManifestRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/no-device-app',
        args: [],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, ...(noDeviceManifestCompile.files || [])], noKernelDevicesForTest: true },
      });
      const customInputOnlyCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/custom_input_only_main.cpp',
        args: ['/workspace/src/custom_input_only_main.cpp', '-o', '/workspace/out/custom-input-only-app'],
        cwd: '/workspace/src',
        env: {},
        project: { files: projectFiles },
      });
      const customInputOnlyRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/custom-input-only-app',
        args: [],
        cwd: '/workspace/src',
        env: {},
        stdinPipe: createRuntimeCommandStdinPipeFromText('only-stdin\\n'),
        project: {
          files: [...projectFiles, ...(customInputOnlyCompile.files || [])],
          kernelDevices: [
            { path: '/dev/custom-in', readable: true, writable: false, inputDevice: '/dev/stdin' },
            { path: '/dev/nested/device', readable: true, writable: false, inputDevice: '/dev/stdin' },
          ],
        },
      });
      const objectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/linked.cpp',
        args: ['-c', '/workspace/src/linked.cpp', '-o', '/workspace/lib/linked.o'],
        cwd: '/workspace/src',
        env: {},
        project: { files: projectFiles },
      });
      const linkProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/link_main.cpp',
        args: ['/workspace/src/link_main.cpp', '/workspace/lib/linked.o', '-o', '/workspace/out/linked-app'],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, ...(objectCompile.files || [])] },
      });
      const linkProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/linked-app',
        args: [],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, ...(objectCompile.files || []), ...(linkProjectCompile.files || [])] },
      });
      const relativeParentCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '../src/link_main.cpp',
        args: ['../src/link_main.cpp', '../src/linked.cpp', '-o', '../out/relative-parent-app'],
        cwd: '/workspace/build',
        env: {},
        project: { files: projectFiles },
      });
      const relativeParentRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/relative-parent-app',
        args: [],
        cwd: '/workspace/build',
        env: {},
        project: { files: [...projectFiles, ...(relativeParentCompile.files || [])] },
      });
      const objectFile = (objectCompile.files || []).find((file) => file.path === 'lib/linked.o' && file.encoding === 'base64');
      const archiveFile = {
        path: 'lib/liblinked.a',
        contents: createArchiveBase64('linked.o', objectFile?.contents || ''),
        encoding: 'base64',
      };
      const libraryProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/link_main.cpp',
        args: ['/workspace/src/link_main.cpp', '-L', '/workspace/lib', '-llinked', '-o', '/workspace/out/library-app'],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, archiveFile] },
      });
      const libraryProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/library-app',
        args: [],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, archiveFile, ...(libraryProjectCompile.files || [])] },
      });
      const inlineLibraryProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/link_main.cpp',
        args: ['/workspace/src/link_main.cpp', '-L/workspace/lib', '-llinked', '-o', '/workspace/out/inline-library-app'],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, archiveFile] },
      });
      const inlineLibraryProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/inline-library-app',
        args: [],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, archiveFile, ...(inlineLibraryProjectCompile.files || [])] },
      });
      const envIncludeProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/env_include_main.cpp',
        args: ['/workspace/src/env_include_main.cpp', '-o', '/workspace/out/env-include-app'],
        cwd: '/workspace/src',
        env: { CPATH: '/workspace/envinclude' },
        project: { files: projectFiles },
      });
      const envIncludeProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/env-include-app',
        args: [],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, ...(envIncludeProjectCompile.files || [])] },
      });
      const cplusIncludeProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/cplus_include_main.cpp',
        args: ['/workspace/src/cplus_include_main.cpp', '-o', '/workspace/out/cplus-include-app'],
        cwd: '/workspace/src',
        env: { CPLUS_INCLUDE_PATH: '/workspace/cppinclude' },
        project: { files: projectFiles },
      });
      const cplusIncludeProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/cplus-include-app',
        args: [],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, ...(cplusIncludeProjectCompile.files || [])] },
      });
      const cwdRelativeEnvIncludeProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '../src/env_include_main.cpp',
        args: ['../src/env_include_main.cpp', '-o', '../out/cwd-env-include-app'],
        cwd: '/workspace/build',
        env: { CPATH: '../envinclude' },
        project: { files: projectFiles },
      });
      const cwdRelativeEnvIncludeProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/cwd-env-include-app',
        args: [],
        cwd: '/workspace/build',
        env: {},
        project: { files: [...projectFiles, ...(cwdRelativeEnvIncludeProjectCompile.files || [])] },
      });
      const cIncludeProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/env_c_include_main.c',
        args: ['/workspace/src/env_c_include_main.c', '-o', '/workspace/out/env-c-include-app'],
        cwd: '/workspace/src',
        env: { C_INCLUDE_PATH: '/workspace/cinclude' },
        project: { files: projectFiles },
        options: { compilerCommand: 'cc' },
      });
      const cIncludeProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/env-c-include-app',
        args: [],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, ...(cIncludeProjectCompile.files || [])] },
      });
      const envLibraryProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '/workspace/src/link_main.cpp',
        args: ['/workspace/src/link_main.cpp', '-llinked', '-o', '/workspace/out/env-library-app'],
        cwd: '/workspace/src',
        env: { LIBRARY_PATH: '/workspace/lib' },
        project: { files: [...projectFiles, archiveFile] },
      });
      const envLibraryProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/env-library-app',
        args: [],
        cwd: '/workspace/src',
        env: {},
        project: { files: [...projectFiles, archiveFile, ...(envLibraryProjectCompile.files || [])] },
      });
      const cwdRelativeEnvLibraryProjectCompile = await send('execute-project-cpp', {
        source: 'compile',
        scriptPath: '../src/link_main.cpp',
        args: ['../src/link_main.cpp', '-llinked', '-o', '../out/cwd-env-library-app'],
        cwd: '/workspace/build',
        env: { LIBRARY_PATH: '../lib' },
        project: { files: [...projectFiles, archiveFile] },
      });
      const cwdRelativeEnvLibraryProjectRun = await send('execute-project-cpp', {
        source: 'run',
        scriptPath: '/workspace/out/cwd-env-library-app',
        args: [],
        cwd: '/workspace/build',
        env: {},
        project: { files: [...projectFiles, archiveFile, ...(cwdRelativeEnvLibraryProjectCompile.files || [])] },
      });
      const traced = await send('execute-with-tracing', {
        code: 'class Solution { public: int add(int a, int b) { return a + b; } };',
        functionName: 'add',
        inputs: { a: 2, b: 3 },
        options: {},
      });
      const script = await send('execute-with-tracing', {
        code: [
          'vector<int> nums = {2, 7, 11, 15};',
          'int target = 9;',
          'vector<int> result;',
          'unordered_map<int, int> seen;',
          'for (int i = 0; i < nums.size(); ++i) {',
          '  int complement = target - nums[i];',
          '  if (seen.count(complement)) {',
          '    result = {seen[complement], i};',
          '    break;',
          '  }',
          '  seen[nums[i]] = i;',
          '}',
        ].join('\\n'),
        functionName: '',
        inputs: {},
        executionStyle: 'function',
        options: {},
      });
      const interview = await send('execute-code-interview', {
        code: 'class Solution { public: int add(int a, int b) { return a + b; } };',
        functionName: 'add',
        inputs: { a: 2, b: 3 },
        executionStyle: 'solution-method',
      });

      worker.terminate();
      return {
        warmup,
        add,
        cachedAdd,
        twoSum,
        syntaxError,
        projectCompile,
        projectRun,
        projectDeviceLeakRun,
        absoluteProjectCompile,
        absoluteProjectRun,
        inlineAbsoluteIncludeCompile,
        inlineAbsoluteIncludeRun,
        canonicalProjectCompile,
        canonicalProjectRun,
        outsideCwdError,
        outsideIncludeArgError,
        outsideRelativeIncludeArgError,
        outsideLibraryArgError,
        outsideLibraryEnvError,
        stdinProjectCompile,
        stdinProjectRun,
        cProjectCompile,
        cProjectRun,
        emptyDirectoryCompile,
        emptyDirectoryRun,
        noDeviceManifestCompile,
        noDeviceManifestRun,
        customInputOnlyCompile,
        customInputOnlyRun,
        objectCompile,
        linkProjectCompile,
        linkProjectRun,
        relativeParentCompile,
        relativeParentRun,
        libraryProjectCompile,
        libraryProjectRun,
        inlineLibraryProjectCompile,
        inlineLibraryProjectRun,
        envIncludeProjectCompile,
        envIncludeProjectRun,
        cplusIncludeProjectCompile,
        cplusIncludeProjectRun,
        cwdRelativeEnvIncludeProjectCompile,
        cwdRelativeEnvIncludeProjectRun,
        cIncludeProjectCompile,
        cIncludeProjectRun,
        envLibraryProjectCompile,
        envLibraryProjectRun,
        cwdRelativeEnvLibraryProjectCompile,
        cwdRelativeEnvLibraryProjectRun,
        traced,
        script,
        interview,
      };
    })()`);

    const warmup = results.warmup as { success?: boolean; timings?: { toolchainLoadMs?: number; compilerWorkerMs?: number; externalCompileMs?: number } };
    const add = results.add as { success?: boolean; output?: unknown; error?: string; timings?: { compilerWorkerMs?: number } };
    const cachedAdd = results.cachedAdd as { success?: boolean; output?: unknown; timings?: { compileCacheHit?: boolean } };
    const twoSum = results.twoSum as { success?: boolean; output?: unknown; error?: string };
    const syntaxError = results.syntaxError as { success?: boolean; error?: string; errorLine?: number };
    const projectCompile = results.projectCompile as CppProjectWorkerResponse;
    const projectRun = results.projectRun as CppProjectWorkerResponse;
    const projectDeviceLeakRun = results.projectDeviceLeakRun as CppProjectWorkerResponse;
    const absoluteProjectCompile = results.absoluteProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const absoluteProjectRun = results.absoluteProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const inlineAbsoluteIncludeCompile = results.inlineAbsoluteIncludeCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const inlineAbsoluteIncludeRun = results.inlineAbsoluteIncludeRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const canonicalProjectCompile = results.canonicalProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const canonicalProjectRun = results.canonicalProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const outsideCwdError = results.outsideCwdError as string;
    const outsideIncludeArgError = results.outsideIncludeArgError as string;
    const outsideRelativeIncludeArgError = results.outsideRelativeIncludeArgError as string;
    const outsideLibraryArgError = results.outsideLibraryArgError as string;
    const outsideLibraryEnvError = results.outsideLibraryEnvError as string;
    const stdinProjectCompile = results.stdinProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const stdinProjectRun = results.stdinProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const cProjectCompile = results.cProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const cProjectRun = results.cProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const emptyDirectoryCompile = results.emptyDirectoryCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const emptyDirectoryRun = results.emptyDirectoryRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const noDeviceManifestCompile = results.noDeviceManifestCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const noDeviceManifestRun = results.noDeviceManifestRun as CppProjectWorkerResponse;
    const customInputOnlyCompile = results.customInputOnlyCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const customInputOnlyRun = results.customInputOnlyRun as CppProjectWorkerResponse;
    const objectCompile = results.objectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const linkProjectCompile = results.linkProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const linkProjectRun = results.linkProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const relativeParentCompile = results.relativeParentCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const relativeParentRun = results.relativeParentRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const libraryProjectCompile = results.libraryProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const libraryProjectRun = results.libraryProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const inlineLibraryProjectCompile = results.inlineLibraryProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const inlineLibraryProjectRun = results.inlineLibraryProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const envIncludeProjectCompile = results.envIncludeProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const envIncludeProjectRun = results.envIncludeProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const cplusIncludeProjectCompile = results.cplusIncludeProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const cplusIncludeProjectRun = results.cplusIncludeProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const cwdRelativeEnvIncludeProjectCompile = results.cwdRelativeEnvIncludeProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const cwdRelativeEnvIncludeProjectRun = results.cwdRelativeEnvIncludeProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const cIncludeProjectCompile = results.cIncludeProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const cIncludeProjectRun = results.cIncludeProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const envLibraryProjectCompile = results.envLibraryProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const envLibraryProjectRun = results.envLibraryProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const cwdRelativeEnvLibraryProjectCompile = results.cwdRelativeEnvLibraryProjectCompile as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const cwdRelativeEnvLibraryProjectRun = results.cwdRelativeEnvLibraryProjectRun as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      files?: Array<{ path: string; contents?: string; encoding?: string; deleted?: true }>;
    };
    const traced = results.traced as { success?: boolean; output?: unknown; trace?: { events?: Array<{ kind?: string; value?: unknown }> } };
    const script = results.script as { success?: boolean; output?: unknown; trace?: { events?: Array<{ kind?: string; function?: string }> } };
    const interview = results.interview as { success?: boolean; output?: unknown; trace?: unknown };
    assertCondition(warmup.success === true, `C++ browser warmup failed: ${JSON.stringify(warmup)}`);
    assertCondition(
      warmup.timings?.toolchainLoadMs === 0 && typeof warmup.timings?.compilerWorkerMs === 'number' && warmup.timings.compilerWorkerMs > 0,
      `C++ browser warmup should compile outside the main worker without loading the main toolchain: ${JSON.stringify(warmup)}`
    );
    assertCondition(add.success === true && add.output === 5, `C++ browser add failed: ${JSON.stringify(add)}`);
    assertCondition(
      cachedAdd.success === true && cachedAdd.output === 11 && cachedAdd.timings?.compileCacheHit === true,
      `C++ browser repeated add should hit compile cache: ${JSON.stringify(cachedAdd)}`
    );
    assertCondition(
      twoSum.success === true && JSON.stringify(twoSum.output) === JSON.stringify([0, 1]),
      `C++ browser twoSum failed: ${JSON.stringify(twoSum)}`
    );
    assertCondition(
      syntaxError.success === false && syntaxError.errorLine === 4,
      `C++ browser syntax error did not map to user line 4: ${JSON.stringify(syntaxError)}`
    );
    assertCondition(
      projectCompile.exitCode === 0 && projectCompile.files?.some((file) => file.path === 'src/a.out' && file.encoding === 'base64'),
      `C++ browser project compile should emit a.out: ${JSON.stringify(projectCompile)}`
    );
    assertCondition(
      projectCompile.stderr?.length > 0 &&
        projectCompile.events
          ?.filter((event) => event.type === 'output' && event.stream === 'stderr' && event.device === '/dev/stderr')
          .map((event) => event.data)
          .join('') === projectCompile.stderr,
      `C++ browser project compile should emit compiler stderr events: ${JSON.stringify(projectCompile)}`
    );
    assertCondition(projectRun.exitCode === 0, `C++ browser project run should exit successfully: ${JSON.stringify(projectRun)}`);
    assertCondition(
        projectRun.stdout?.includes('42\n') === true &&
        projectRun.stdout?.includes('from-dev\n') === true &&
        projectRun.stdout?.includes('\nbrowser-cpp-project\nalpha,beta\nfrom-dev\n\nproc-info\n') === true &&
        projectRun.stdout?.includes('from-stdio') !== true &&
        projectRun.stdout?.includes('from-custom') !== true &&
        projectRun.stdout?.includes('proc-info\ninfo\nproc-write:blocked\n') === true &&
        projectRun.stdout?.includes('custom-kernel-file\ncustom-kernel-write:blocked\ncustom-kernel-mkdir:blocked\ncustom-kernel-create:blocked\n') === true &&
        projectRun.stdout?.includes('proc-utime:blocked\ncustom-kernel-utime:blocked\n') === true &&
        projectRun.stdout?.includes('dev-list:ok\ndev-stat:ok\nstatvfs:ok\nstatvfs-dev-missing:blocked\nstatvfs-proc-missing:blocked\ndev-fstat:ok\ndev-stdout-read:blocked\ndev-null:0\ndev-unlink:blocked\ndev-utime:blocked\ndev-rename:blocked\ncustom-kernel-rename:blocked\n') === true &&
        projectRun.stdout?.includes('readonly-fd-mutation:blocked\n') === true &&
        projectRun.stdout?.includes('missing-remove:blocked\nmkdir-missing-parent:blocked\nopen-missing-parent:blocked\nrename-missing-parent:blocked\nrename-file-onto-dir:blocked\nopen-dir-write:blocked\nopen-dir-truncate:blocked\nrename-dir-onto-file:blocked\nrename-dir-existing:blocked\nrename-dir-descendant:blocked\nunlink-dir:blocked\nlink-hard:ok\nreadlink:blocked\nsymlink:blocked\nlink-proc:blocked\nlink-missing-parent:blocked\nsymlink-dev:blocked\nlocal-dev-path:ok\n') === true &&
        projectRun.stdout?.includes('device-out\ncapture-device\ntee-device\n') === true,
      `C++ browser project run should preserve stdout/stdin/env/argv/proc reads: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.stderr === 'device-err\ntty-device\nlog-device\n',
      `C++ browser project run should route /dev/stderr writes: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.events?.some((event) => event.type === 'output' && event.device === '/dev/null') !== true,
      `C++ browser project run should discard /dev/null writes without output events: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events
        ?.filter((event) => event.type === 'output' && event.stream === 'stdout')
        .map((event) => event.data)
        .join('') === projectRun.stdout,
      `C++ browser project run should stream stdout events: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events
        ?.filter((event) => event.type === 'output' && event.stream === 'stderr' && event.device === '/dev/stderr')
        .map((event) => event.data)
        .join('') === projectRun.stderr,
      `C++ browser project run should stream stderr events: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'output' &&
        event.stream === 'stderr' &&
        event.device === '/dev/stderr' &&
        event.sourceDevice === '/dev/tty' &&
        event.data === 'tty-device\n'
      )) === true,
      `C++ browser project run should preserve output source device: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'output' &&
        event.stream === 'stderr' &&
        event.device === '/dev/stderr' &&
        event.sourceDevice === '/dev/log' &&
        event.data === 'log-device\n'
      )) === true,
      `C++ browser project run should support manifest-provided custom output devices: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.device === '/dev/capture' &&
        event.sourceDevice === undefined &&
        event.data === 'capture-device\n'
      )) === true &&
        projectRun.events?.some((event) => (
          event.type === 'output' &&
          event.stream === 'stdout' &&
          event.device === '/dev/capture' &&
          event.sourceDevice === '/dev/tee' &&
          event.data === 'tee-device\n'
        )) === true,
      `C++ browser project run should preserve custom stdout output devices: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.device === '/dev/bad-output' &&
        event.sourceDevice === undefined &&
        event.data === 'bad-output-device\n'
      )) === true,
      `C++ browser project run should fall back to source device for invalid outputDevice references: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectDeviceLeakRun.exitCode === 0 &&
        projectDeviceLeakRun.stderr?.includes('log-device\n') !== true &&
        projectDeviceLeakRun.events?.some((event) => event.type === 'output' && event.sourceDevice === '/dev/log') !== true,
      `C++ browser project run should not leak manifest-provided devices between requests: ${JSON.stringify(projectDeviceLeakRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/generated.txt' && file.contents === '42\n') === true,
      `C++ browser project run should return generated text file: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/bytes.bin' && file.encoding === 'base64' && file.contents === 'AP8=') === true,
      `C++ browser project run should return generated binary file: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/patched.txt' && file.contents === 'aXYd') === true,
      `C++ browser project run should return fd_pwrite mutations: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/truncated.txt' && file.contents === 'abc') === true,
      `C++ browser project run should return ftruncate mutations: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/readonly-fd.txt' && file.contents === 'original\n') === true,
      `C++ browser project run should not mutate files through read-only descriptors: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/allocated.bin' && file.contents === 'hi\0\0') === true,
      `C++ browser project run should return posix_fallocate mutations: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/link-hard.txt' && file.contents === 'linked\n') === true,
      `C++ browser project run should persist hard-link snapshots: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/link-symlink.txt' || file.path === 'src/link-proc.txt') !== true,
      `C++ browser project run should not persist unsupported symlinks or kernel hard links: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/dev/local.txt' && file.contents === 'local-dev\n') === true,
      `C++ browser project run should preserve relative dev/ file mutations as project files: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/existing-dir' && file.directory === true) === true &&
        projectRun.files?.some((file) => file.path === 'src/existing-dir' && file.contents !== undefined) !== true,
      `C++ browser project run should not persist a file over an existing directory rename target: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/multi.txt' && file.contents === 'onetwo\n') === true,
      `C++ browser project run should return final multi-write contents: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/zero.txt' && file.contents === '') === true,
      `C++ browser project run should return zero-length ftruncate contents: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/empty-open.txt' && file.contents === '') === true,
      `C++ browser project run should return zero-byte open-created files: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.stdout?.includes('rmdir:gone\n') === true,
      `C++ browser project run should remove directories through WASI rmdir: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.stdout?.includes('rename-self-file:ok\nrename-self-dir:ok\n') === true,
      `C++ browser project run should treat self-renames as no-op mutations: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/self-rename-file.txt' || file.path.startsWith('src/self-rename-dir/')) !== true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          (event.change?.path === 'src/self-rename-file.txt' || event.change?.path?.startsWith('src/self-rename-dir/'))
        )) !== true,
      `C++ browser project run should not emit final or live mutations for self-renames: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.stdout?.includes('metadata-utime:ok\nmetadata-futimens:ok\n') === true,
      `C++ browser project run should allow path and fd metadata-only mutations on workspace files: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/persist-dir' && file.directory === true) === true &&
        projectRun.files?.some((file) => file.path === 'src/stale-dir' && file.directory === true && file.deleted === true) === true,
      `C++ browser project run should return final directory mutations: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/renamed.txt' && file.contents === 'moved\n') === true &&
        projectRun.files?.some((file) => file.path === 'src/rename-source.txt' && file.deleted === true) !== true,
      `C++ browser project run should return renamed file contents without reporting transient creates: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path === 'src/stale.txt' && file.deleted === true) === true,
      `C++ browser project run should return deleted files: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/generated.txt' &&
        event.change.contents === '42\n'
      )) === true,
      `C++ browser project run should stream live text mutations: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/bytes.bin' &&
        event.change.contents === 'AP8=' &&
        event.change.encoding === 'base64'
      )) === true,
      `C++ browser project run should stream live binary mutations: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/patched.txt' &&
        event.change.contents === 'aXYd'
      )) === true,
      `C++ browser project run should stream live fd_pwrite mutations: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/truncated.txt' &&
        event.change.contents === 'abc'
      )) === true,
      `C++ browser project run should stream live ftruncate mutations: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/readonly-fd.txt' &&
        event.change.contents === 'original\n'
      )) === true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'src/readonly-fd.txt' &&
          event.change.contents !== '' &&
          event.change.contents !== 'original\n'
        )) !== true,
      `C++ browser project run should stream only the allowed read-only fd seed write: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/allocated.bin' &&
        event.change.contents === '\0\0\0\0'
      )) === true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'src/allocated.bin' &&
          event.change.contents === 'hi\0\0'
      )) === true,
      `C++ browser project run should stream live posix_fallocate mutations before final diff: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      (projectRun.events || []).filter((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/metadata-only.txt' &&
        event.change.contents === 'metadata\n'
      )).length >= 3,
      `C++ browser project run should stream live path and fd metadata-only mutations: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/multi.txt' &&
        event.change.contents === 'one'
      )) === true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'src/multi.txt' &&
          event.change.contents === 'onetwo\n'
        )) === true,
      `C++ browser project run should stream multiple writes as live mutations: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/zero.txt' &&
        event.change.contents === ''
      )) === true,
      `C++ browser project run should stream zero-length ftruncate mutations: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/empty-open.txt' &&
        event.change.contents === ''
      )) === true,
      `C++ browser project run should stream zero-byte open-created files: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/missing-delete.txt' &&
        event.change.deleted === true
      )) !== true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'src/unlink-dir' &&
          event.change.deleted === true &&
          event.change.directory !== true
        )) !== true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'src/existing-dir' &&
          event.change.contents !== undefined
        )) !== true,
      `C++ browser project run should not stream failed unlink or file-over-directory rename mutations: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.files?.some((file) => file.path.startsWith('src/missing-parent/') || file.path.startsWith('src/missing-open/') || file.path.startsWith('src/missing-rename/') || file.path.startsWith('src/missing-link/')) !== true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          (
            event.change?.path.startsWith('src/missing-parent/') ||
            event.change?.path.startsWith('src/missing-open/') ||
            event.change?.path.startsWith('src/missing-rename/') ||
            event.change?.path.startsWith('src/missing-link/')
          )
        )) !== true,
      `C++ browser project run should not create or stream mutations below missing parents: ${JSON.stringify(projectRun)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/scratch' &&
        event.change.directory === true
      )) === true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'src/scratch' &&
          event.change.directory === true &&
          event.change.deleted === true
        )) === true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'src/rename-dir' &&
          event.change.directory === true
        )) === true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'src/rename-dir' &&
          event.change.directory === true &&
          event.change.deleted === true
        )) === true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'src/renamed-dir' &&
          event.change.directory === true
        )) === true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'src/renamed-dir' &&
          event.change.directory === true &&
          event.change.deleted === true
        )) === true,
      `C++ browser project run should stream live directory mutations: ${JSON.stringify(projectRun.events)}`
    );
    {
      const events = projectRun.events || [];
      const beforeLiveOutput = events.findIndex((event) => event.type === 'output' && event.stream === 'stdout' && event.data?.includes('before-live\n'));
      const firstMultiWrite = events.findIndex((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/multi.txt' &&
        event.change.contents === 'one'
      ));
      const afterLiveOutput = events.findIndex((event) => event.type === 'output' && event.stream === 'stdout' && event.data?.includes('after-multi-one\n'));
      assertCondition(
        beforeLiveOutput >= 0 &&
          firstMultiWrite > beforeLiveOutput &&
          afterLiveOutput > firstMultiWrite,
        `C++ browser project run should preserve stdout/file-change event ordering: ${JSON.stringify(events)}`
      );
    }
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/renamed.txt' &&
        event.change.contents === 'moved\n'
      )) === true &&
        projectRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'src/rename-source.txt' &&
          event.change.deleted === true
        )) === true,
      `C++ browser project run should stream live rename mutations: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      projectRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'src/stale.txt' &&
        event.change.deleted === true
      )) === true,
      `C++ browser project run should stream live deletions: ${JSON.stringify(projectRun.events)}`
    );
    assertCondition(
      absoluteProjectCompile.exitCode === 0 &&
        absoluteProjectCompile.files?.some((file) => file.path === 'out/absolute-app' && file.encoding === 'base64'),
      `C++ browser project compile should handle absolute /workspace output paths outside cwd: ${JSON.stringify(absoluteProjectCompile)}`
    );
    assertCondition(
      absoluteProjectRun.exitCode === 0 && absoluteProjectRun.stdout === '99\n',
      `C++ browser project run should execute absolute /workspace executable paths: ${JSON.stringify(absoluteProjectRun)}`
    );
    assertCondition(
      inlineAbsoluteIncludeCompile.exitCode === 0 &&
        inlineAbsoluteIncludeCompile.files?.some((file) => file.path === 'out/inline-include-app' && file.encoding === 'base64'),
      `C++ browser project compile should handle inline absolute -I/workspace include paths: ${JSON.stringify(inlineAbsoluteIncludeCompile)}`
    );
    assertCondition(
      inlineAbsoluteIncludeRun.exitCode === 0 && inlineAbsoluteIncludeRun.stdout === '99\n',
      `C++ browser project run should execute inline absolute include output: ${JSON.stringify(inlineAbsoluteIncludeRun)}`
    );
    assertCondition(
      canonicalProjectCompile.exitCode === 0 &&
        canonicalProjectCompile.files?.some((file) => file.path === 'out/canonical-app' && file.encoding === 'base64'),
      `C++ browser project compile should honor canonical /home workspace roots: ${JSON.stringify(canonicalProjectCompile)}`
    );
    assertCondition(
      canonicalProjectRun.exitCode === 0 && canonicalProjectRun.stdout === '99\n',
      `C++ browser project run should execute canonical /home workspace paths: ${JSON.stringify(canonicalProjectRun)}`
    );
    assertCondition(
      outsideCwdError.includes('Project cwd must stay inside the workspace'),
      `C++ browser project runner should reject cwd outside the workspace: ${outsideCwdError}`
    );
    assertCondition(
      outsideIncludeArgError.includes('Project path escapes workspace: /outside/include'),
      `C++ browser project runner should reject include args outside the workspace: ${outsideIncludeArgError}`
    );
    assertCondition(
      outsideRelativeIncludeArgError.includes('Project path escapes workspace: ../outside/include'),
      `C++ browser project runner should reject relative include args outside the workspace: ${outsideRelativeIncludeArgError}`
    );
    assertCondition(
      outsideLibraryArgError.includes('Project path escapes workspace: /outside/lib'),
      `C++ browser project runner should reject library args outside the workspace: ${outsideLibraryArgError}`
    );
    assertCondition(
      outsideLibraryEnvError.includes('Project path escapes workspace: /outside/lib'),
      `C++ browser project runner should reject LIBRARY_PATH entries outside the workspace: ${outsideLibraryEnvError}`
    );
    assertCondition(
      stdinProjectCompile.exitCode === 0 &&
        stdinProjectCompile.files?.some((file) => file.path === 'out/stdin-app' && file.encoding === 'base64'),
      `C++ browser project compile should support source from stdin: ${JSON.stringify(stdinProjectCompile)}`
    );
    assertCondition(
      stdinProjectRun.exitCode === 0 && stdinProjectRun.stdout === 'stdin-cpp\n',
      `C++ browser project run should execute stdin-compiled output: ${JSON.stringify(stdinProjectRun)}`
    );
    assertCondition(
      cProjectCompile.exitCode === 0 && cProjectCompile.files?.some((file) => file.path === 'out/plain-c' && file.encoding === 'base64'),
      `C++ browser project compile should support gcc C compiler alias: ${JSON.stringify(cProjectCompile)}`
    );
    assertCondition(
      cProjectRun.exitCode === 0 && cProjectRun.stdout === 'plain-c\n',
      `C++ browser project run should execute gcc-built C output: ${JSON.stringify(cProjectRun)}`
    );
    assertCondition(
      emptyDirectoryCompile.exitCode === 0 && emptyDirectoryCompile.files?.some((file) => file.path === 'out/empty-dir-app' && file.encoding === 'base64'),
      `C++ browser project compile should emit empty-directory smoke binary: ${JSON.stringify(emptyDirectoryCompile)}`
    );
    assertCondition(
      emptyDirectoryRun.exitCode === 0 && emptyDirectoryRun.stdout === 'dir\nchild\n',
      `C++ browser project run should materialize project directories: ${JSON.stringify(emptyDirectoryRun)}`
    );
    assertCondition(
      noDeviceManifestCompile.exitCode === 0 && noDeviceManifestCompile.files?.some((file) => file.path === 'out/no-device-app' && file.encoding === 'base64'),
      `C++ browser project compile should emit no-device-manifest smoke binary: ${JSON.stringify(noDeviceManifestCompile)}`
    );
    assertCondition(
      noDeviceManifestRun.exitCode === 0 &&
        noDeviceManifestRun.stdout === 'fd-stdout\ndev-stdout:blocked\ndev-stdout-read:blocked\n' &&
        noDeviceManifestRun.stderr === 'fd-stderr\n',
      `C++ browser project run should preserve inherited stdio without inventing /dev devices: ${JSON.stringify(noDeviceManifestRun)}`
    );
    assertCondition(
      noDeviceManifestRun.events
        ?.filter((event) => event.type === 'output' && event.stream === 'stdout' && event.device === '/dev/stdout')
        .every((event) => event.sourceDevice === undefined) === true &&
        noDeviceManifestRun.events
          ?.filter((event) => event.type === 'output' && event.stream === 'stderr' && event.device === '/dev/stderr')
          .every((event) => event.sourceDevice === undefined) === true,
      `C++ browser project direct stdio events should not report a redundant sourceDevice: ${JSON.stringify(noDeviceManifestRun.events)}`
    );
    assertCondition(
      customInputOnlyCompile.exitCode === 0 && customInputOnlyCompile.files?.some((file) => file.path === 'out/custom-input-only-app' && file.encoding === 'base64'),
      `C++ browser project compile should emit custom-input-only smoke binary: ${JSON.stringify(customInputOnlyCompile)}`
    );
    assertCondition(
      customInputOnlyRun.exitCode === 0 && customInputOnlyRun.stdout === 'only-stdin\ncustom-only:ok\n',
      `C++ browser project run should read custom input devices without exposing /dev/stdin: ${JSON.stringify(customInputOnlyRun)}`
    );
    assertCondition(
      objectCompile.exitCode === 0 && objectCompile.files?.some((file) => file.path === 'lib/linked.o' && file.encoding === 'base64'),
      `C++ browser project compile should emit object files outside cwd: ${JSON.stringify(objectCompile)}`
    );
    assertCondition(
      linkProjectCompile.exitCode === 0 && linkProjectCompile.files?.some((file) => file.path === 'out/linked-app' && file.encoding === 'base64'),
      `C++ browser project compile should link absolute workspace object inputs: ${JSON.stringify(linkProjectCompile)}`
    );
    assertCondition(
      linkProjectRun.exitCode === 0 && linkProjectRun.stdout === '1234\n',
      `C++ browser project run should execute linked output: ${JSON.stringify(linkProjectRun)}`
    );
    assertCondition(
      relativeParentCompile.exitCode === 0 && relativeParentCompile.files?.some((file) => file.path === 'out/relative-parent-app' && file.encoding === 'base64'),
      `C++ browser project compile should accept relative parent source and output paths inside the workspace: ${JSON.stringify(relativeParentCompile)}`
    );
    assertCondition(
      relativeParentRun.exitCode === 0 && relativeParentRun.stdout === '1234\n',
      `C++ browser project run should execute relative-parent compiled output: ${JSON.stringify(relativeParentRun)}`
    );
    assertCondition(
      libraryProjectCompile.exitCode === 0 && libraryProjectCompile.files?.some((file) => file.path === 'out/library-app' && file.encoding === 'base64'),
      `C++ browser project compile should resolve -L /workspace library archives: ${JSON.stringify(libraryProjectCompile)}`
    );
    assertCondition(
      libraryProjectRun.exitCode === 0 && libraryProjectRun.stdout === '1234\n',
      `C++ browser project run should execute -l linked output: ${JSON.stringify(libraryProjectRun)}`
    );
    assertCondition(
      inlineLibraryProjectCompile.exitCode === 0 && inlineLibraryProjectCompile.files?.some((file) => file.path === 'out/inline-library-app' && file.encoding === 'base64'),
      `C++ browser project compile should resolve inline -L/workspace library archives: ${JSON.stringify(inlineLibraryProjectCompile)}`
    );
    assertCondition(
      inlineLibraryProjectRun.exitCode === 0 && inlineLibraryProjectRun.stdout === '1234\n',
      `C++ browser project run should execute inline -L linked output: ${JSON.stringify(inlineLibraryProjectRun)}`
    );
    assertCondition(
      envIncludeProjectCompile.exitCode === 0 && envIncludeProjectCompile.files?.some((file) => file.path === 'out/env-include-app' && file.encoding === 'base64'),
      `C++ browser project compile should honor CPATH include directories: ${JSON.stringify(envIncludeProjectCompile)}`
    );
    assertCondition(
      envIncludeProjectRun.exitCode === 0 && envIncludeProjectRun.stdout === '2026\n',
      `C++ browser project run should execute CPATH-built output: ${JSON.stringify(envIncludeProjectRun)}`
    );
    assertCondition(
      cplusIncludeProjectCompile.exitCode === 0 && cplusIncludeProjectCompile.files?.some((file) => file.path === 'out/cplus-include-app' && file.encoding === 'base64'),
      `C++ browser project compile should honor CPLUS_INCLUDE_PATH directories: ${JSON.stringify(cplusIncludeProjectCompile)}`
    );
    assertCondition(
      cplusIncludeProjectRun.exitCode === 0 && cplusIncludeProjectRun.stdout === '2028\n',
      `C++ browser project run should execute CPLUS_INCLUDE_PATH-built output: ${JSON.stringify(cplusIncludeProjectRun)}`
    );
    assertCondition(
      cwdRelativeEnvIncludeProjectCompile.exitCode === 0 && cwdRelativeEnvIncludeProjectCompile.files?.some((file) => file.path === 'out/cwd-env-include-app' && file.encoding === 'base64'),
      `C++ browser project compile should honor cwd-relative CPATH include directories: ${JSON.stringify(cwdRelativeEnvIncludeProjectCompile)}`
    );
    assertCondition(
      cwdRelativeEnvIncludeProjectRun.exitCode === 0 && cwdRelativeEnvIncludeProjectRun.stdout === '2026\n',
      `C++ browser project run should execute cwd-relative CPATH-built output: ${JSON.stringify(cwdRelativeEnvIncludeProjectRun)}`
    );
    assertCondition(
      cIncludeProjectCompile.exitCode === 0 && cIncludeProjectCompile.files?.some((file) => file.path === 'out/env-c-include-app' && file.encoding === 'base64'),
      `C++ browser project compile should honor C_INCLUDE_PATH for cc C compiler alias: ${JSON.stringify(cIncludeProjectCompile)}`
    );
    assertCondition(
      cIncludeProjectRun.exitCode === 0 && cIncludeProjectRun.stdout === '2027\n',
      `C++ browser project run should execute C_INCLUDE_PATH-built C output: ${JSON.stringify(cIncludeProjectRun)}`
    );
    assertCondition(
      envLibraryProjectCompile.exitCode === 0 && envLibraryProjectCompile.files?.some((file) => file.path === 'out/env-library-app' && file.encoding === 'base64'),
      `C++ browser project compile should honor LIBRARY_PATH archives: ${JSON.stringify(envLibraryProjectCompile)}`
    );
    assertCondition(
      envLibraryProjectRun.exitCode === 0 && envLibraryProjectRun.stdout === '1234\n',
      `C++ browser project run should execute LIBRARY_PATH-linked output: ${JSON.stringify(envLibraryProjectRun)}`
    );
    assertCondition(
      cwdRelativeEnvLibraryProjectCompile.exitCode === 0 && cwdRelativeEnvLibraryProjectCompile.files?.some((file) => file.path === 'out/cwd-env-library-app' && file.encoding === 'base64'),
      `C++ browser project compile should honor cwd-relative LIBRARY_PATH archives: ${JSON.stringify(cwdRelativeEnvLibraryProjectCompile)}`
    );
    assertCondition(
      cwdRelativeEnvLibraryProjectRun.exitCode === 0 && cwdRelativeEnvLibraryProjectRun.stdout === '1234\n',
      `C++ browser project run should execute cwd-relative LIBRARY_PATH-linked output: ${JSON.stringify(cwdRelativeEnvLibraryProjectRun)}`
    );
    assertCondition(traced.success === true && traced.output === 5, `C++ browser tracing failed: ${JSON.stringify(traced)}`);
    assertCondition(
      traced.trace?.events?.some((event) => event.kind === 'call') &&
        traced.trace?.events?.some((event) => event.kind === 'return' && event.value === 5),
      `C++ browser tracing should include call and return events: ${JSON.stringify(traced)}`
    );
    assertCondition(
      script.success === true && JSON.stringify(script.output) === JSON.stringify([0, 1]),
      `C++ browser script tracing failed: ${JSON.stringify(script)}`
    );
    assertCondition(
      script.trace?.events?.some((event) => event.kind === 'call' && event.function === '<script>'),
      `C++ browser script tracing should include a script call event: ${JSON.stringify(script)}`
    );
    assertCondition(
      interview.success === true && interview.output === 5 && !('trace' in interview),
      `C++ browser interview execution should return non-trace output: ${JSON.stringify(interview)}`
    );
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  console.log('PASS: C++ browser worker compiles and runs code');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

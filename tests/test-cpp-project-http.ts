#!/usr/bin/env npx tsx

// End-to-end C++ TraceKernel HTTP test in Node:
// - the real cpp-worker.js runs inside a node:worker_threads worker (via vm),
//   so its Atomics.wait-based sync HTTP bridge blocks a real separate thread;
// - the real CppWorkerClient drives it through a Worker shim;
// - project compiles run through the external-compiler-host path, serviced by
//   the real cpp-compiler-worker.js compile logic with the local @yowasp/clang
//   toolchain (which also proves tracecode_http.hpp is injected and compiles);
// - a stub RuntimeKernelHttpBridge stands in for the workspace kernel.

import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { Worker as NodeWorker } from 'node:worker_threads';
import { CppWorkerClient } from '../packages/harness-browser/src/cpp-worker-client';
import { createBrowserCppProjectRunner } from '../packages/harness-cpp/src/project-browser';
import { createBrowserJavaScriptProjectRunner } from '../packages/harness-javascript/src/project-browser';
import { createRuntimeWorkspace } from '../packages/harness-project/src/index';
import type {
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpHandler,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpRequest,
} from '../packages/harness-core/src/runtime-project';
import {
  createRuntimeCommandStdinPipeFromText,
} from '../packages/harness-core/src/runtime-project';

const EXTERNAL_COMPILER_URL = 'http://tracecode-cpp-test.invalid/compile';

const CPP_TKFS_PROGRAM = [
  '#include <fstream>',
  '#include <iostream>',
  '#include <iterator>',
  '#include <string>',
  'int main() {',
  '  std::ifstream input("seed.txt", std::ios::binary);',
  '  std::string seed((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());',
  '  std::ofstream output("generated.txt", std::ios::binary | std::ios::trunc);',
  '  output << "kernel-write";',
  '  output.close();',
  '  std::string line;',
  '  std::getline(std::cin, line);',
  '  std::cout << seed << "stdin:" << line << "\\n";',
  '  std::cerr << "kernel-stderr\\n";',
  '  return 0;',
  '}',
  '',
].join('\n');

const CPP_TK_TCP_PROGRAM = [
  '#include <arpa/inet.h>',
  '#include <fcntl.h>',
  '#include <netinet/in.h>',
  '#include <poll.h>',
  '#include <sys/socket.h>',
  '#include <unistd.h>',
  '#include <cerrno>',
  '#include <cstdio>',
  '#include <cstring>',
  'int main() {',
  '  int server = socket(AF_INET, SOCK_STREAM, 0);',
  '  sockaddr_in address {};',
  '  address.sin_family = AF_INET;',
  '  address.sin_port = htons(41234);',
  '  address.sin_addr.s_addr = inet_addr("127.0.0.1");',
  '  int bindResult = bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address));',
  '  int bindErrno = errno;',
  '  int listenResult = bindResult == 0 ? listen(server, 4) : -1;',
  '  int listenErrno = errno;',
  '  if (bindResult != 0 || listenResult != 0) { std::printf("bind:%d:%d listen:%d:%d\\n", bindResult, bindErrno, listenResult, listenErrno); return 1; }',
  '  pollfd listener_poll = { server, POLLIN, 0 };',
  '  if (poll(&listener_poll, 1, 0) != 0) return 8;',
  '  if (fcntl(server, F_SETFL, O_NONBLOCK) != 0) return 12;',
  '  errno = 0;',
  '  if (accept(server, nullptr, nullptr) != -1 || errno != EAGAIN) return 13;',
  '  if (fcntl(server, F_SETFL, 0) != 0) return 14;',
  '  int pending = socket(AF_INET, SOCK_STREAM, 0);',
  '  if (fcntl(pending, F_SETFL, O_NONBLOCK) != 0) return 18;',
  '  errno = 0;',
  '  int pending_connect = connect(pending, reinterpret_cast<sockaddr*>(&address), sizeof(address));',
  '  if (pending_connect != -1 || errno != EINPROGRESS) return 19;',
  '  pollfd pending_poll = { pending, POLLOUT, 0 };',
  '  if (poll(&pending_poll, 1, 1000) != 1 || (pending_poll.revents & POLLOUT) == 0 || (pending_poll.revents & POLLERR) != 0) return 20;',
  '  int pending_error = -1;',
  '  unsigned int pending_error_length = sizeof(pending_error);',
  '  if (getsockopt(pending, SOL_SOCKET, SO_ERROR, &pending_error, &pending_error_length) != 0 || pending_error != 0) return 21;',
  '  int pending_peer = accept(server, nullptr, nullptr);',
  '  if (pending_peer < 0) return 22;',
  '  close(pending_peer);',
  '  close(pending);',
  '  int client = socket(AF_INET, SOCK_STREAM, 0);',
  '  if (connect(client, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) return 2;',
  '  if (poll(&listener_poll, 1, 1000) != 1 || (listener_poll.revents & POLLIN) == 0) return 9;',
  '  int peer = accept(server, nullptr, nullptr);',
  '  if (peer < 0) return 3;',
  '  if (fcntl(peer, F_SETFL, O_NONBLOCK) != 0) return 15;',
  '  char empty_request = 0;',
  '  errno = 0;',
  '  if (recv(peer, &empty_request, 1, 0) != -1 || errno != EAGAIN) return 16;',
  '  if (fcntl(peer, F_SETFL, 0) != 0) return 17;',
  '  pollfd client_poll = { client, POLLOUT, 0 };',
  '  if (poll(&client_poll, 1, 0) != 1 || (client_poll.revents & POLLOUT) == 0) return 10;',
  '  if (send(client, "ping", 4, 0) != 4) return 4;',
  '  pollfd peer_poll = { peer, POLLIN, 0 };',
  '  if (poll(&peer_poll, 1, 1000) != 1 || (peer_poll.revents & POLLIN) == 0) return 11;',
  '  char request[5] = {};',
  '  if (recv(peer, request, 4, 0) != 4) return 5;',
  '  if (send(peer, "pong", 4, 0) != 4) return 6;',
  '  char response[5] = {};',
  '  if (recv(client, response, 4, 0) != 4) return 7;',
  '  std::printf("%s:%s\\n", request, response);',
  '  close(peer); close(client); close(server);',
  '  return 0;',
  '}',
  '',
].join('\n');

const CPP_WATCHDOG_CONTROL_PROGRAM = [
  '#include "tracekernel.h"',
  '#include <cstdio>',
  'int main() {',
  '  tracekernel_watchdog_status first {};',
  '  tracekernel_watchdog_status petted {};',
  '  tracekernel_watchdog_status disarmed {};',
  '  if (tracekernel_watchdog_arm(5000, TRACEKERNEL_WATCHDOG_SIGKILL) != 0) return 1;',
  '  if (tracekernel_watchdog_get_status(&first) != 0) return 2;',
  '  if (tracekernel_watchdog_pet() != 0) return 3;',
  '  if (tracekernel_watchdog_get_status(&petted) != 0) return 4;',
  '  if (tracekernel_watchdog_disarm() != 0) return 5;',
  '  if (tracekernel_watchdog_get_status(&disarmed) != 0) return 6;',
  '  const bool valid = first.armed == 1 && first.timeout_ms == 5000 &&',
  '    first.signal == TRACEKERNEL_WATCHDOG_SIGKILL && first.deadline_at_ms > 0 &&',
  '    petted.armed == 1 && petted.deadline_at_ms >= first.deadline_at_ms &&',
  '    disarmed.armed == 0;',
  '  std::printf("watchdog:%s\\n", valid ? "pass" : "fail");',
  '  return valid ? 0 : 7;',
  '}',
  '',
].join('\n');

const CPP_WATCHDOG_EXPIRY_PROGRAM = [
  '#include "tracekernel.h"',
  '#include <cstdint>',
  'int main() {',
  '  if (tracekernel_watchdog_arm(40, TRACEKERNEL_WATCHDOG_SIGKILL) != 0) return 1;',
  '  volatile std::uint64_t counter = 0;',
  '  for (;;) ++counter;',
  '}',
  '',
].join('\n');

const CPP_TERMINAL_WINDOW_SIZE_PROGRAM = [
  '#include <sys/ioctl.h>',
  '#include <unistd.h>',
  '#include <cstdio>',
  'int main() {',
  '  winsize initial {};',
  '  if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &initial) != 0) return 1;',
  '  winsize resized { 66, 166, 0, 0 };',
  '  if (ioctl(STDIN_FILENO, TIOCSWINSZ, &resized) != 0) return 2;',
  '  winsize observed {};',
  '  if (ioctl(STDERR_FILENO, TIOCGWINSZ, &observed) != 0) return 3;',
  '  const bool valid = initial.ws_row == 55 && initial.ws_col == 144 &&',
  '    initial.ws_xpixel == 0 && initial.ws_ypixel == 0 &&',
  '    observed.ws_row == 66 && observed.ws_col == 166;',
  '  std::printf("terminal-size:%s:%u:%u:%u:%u\\n",',
  '    valid ? "pass" : "fail",',
  '    initial.ws_row, initial.ws_col, observed.ws_row, observed.ws_col);',
  '  return valid ? 0 : 4;',
  '}',
  '',
].join('\n');

const CPP_CROSS_LANGUAGE_FS_PROGRAM = [
  '#include <fcntl.h>',
  '#include <sys/stat.h>',
  '#include <unistd.h>',
  '#include <chrono>',
  '#include <cerrno>',
  '#include <cstdio>',
  '#include <cstring>',
  '#include <string>',
  '',
  'static bool wait_for(const char* path) {',
  '  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);',
  '  struct stat info {};',
  '  while (std::chrono::steady_clock::now() < deadline) {',
  '    if (stat(path, &info) == 0) return true;',
  '  }',
  '  return false;',
  '}',
  '',
  'static bool write_all(const char* path, const char* value) {',
  '  const int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);',
  '  if (fd < 0) return false;',
  '  const size_t length = std::strlen(value);',
  '  const bool ok = write(fd, value, length) == static_cast<ssize_t>(length);',
  '  close(fd);',
  '  return ok;',
  '}',
  '',
  'int main(int argc, char** argv) {',
  '  const std::string mode = argc > 1 ? argv[1] : "";',
  '  if (mode == "watch-js") {',
  '    const int fd = open("cpp-watches.txt", O_RDONLY);',
  '    if (fd < 0 || !write_all("cpp-ready.txt", "ready")) return 10;',
  '    if (!wait_for("js-done.txt")) return 11;',
  '    char buffer[64] = {};',
  '    const ssize_t count = pread(fd, buffer, sizeof(buffer) - 1, 0);',
  '    close(fd);',
  '    if (count < 0) return 12;',
  '    std::printf("cpp-observed:%s\\n", buffer);',
  '    return 0;',
  '  }',
  '  if (mode == "write-js") {',
  '    if (!wait_for("js-ready.txt")) return 20;',
  '    if (!write_all("js-watches.txt", "from-cpp")) return 21;',
  '    if (!write_all("cpp-done.txt", "done")) return 22;',
  '    std::printf("cpp-wrote\\n");',
  '    return 0;',
  '  }',
  '  return 2;',
  '}',
  '',
].join('\n');

const CPP_SPAWN_JAVASCRIPT_PROGRAM = [
  '#include <cstdlib>',
  '#include <fstream>',
  '#include <iostream>',
  '#include <iterator>',
  '#include <string>',
  'int main() {',
  '  const int status = std::system("node cpp-child.js");',
  '  std::ifstream input("cpp-child-owned.txt", std::ios::binary);',
  '  std::string child((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());',
  '  std::cout << "spawn:" << status << ":" << child << "\\n";',
  '  return status == 0 && !child.empty() ? 0 : 1;',
  '}',
  '',
].join('\n');

const CPP_CHILD_PROGRAM = [
  '#include <fstream>',
  '#include <vector>',
  'int main() {',
  '  std::vector<unsigned char> childMemory(1024 * 1024, 0xa5);',
  '  std::ofstream output("cpp-child-process.txt", std::ios::binary | std::ios::trunc);',
  '  output << (childMemory.front() == 0xa5 && childMemory.back() == 0xa5 ? "from-cpp-child" : "child-memory-failed");',
  '  return output.good() ? 0 : 1;',
  '}',
  '',
].join('\n');

const CPP_SPAWN_CPP_PROGRAM = [
  '#include <cstdlib>',
  '#include <fstream>',
  '#include <iostream>',
  '#include <iterator>',
  '#include <string>',
  '#include <vector>',
  'static int parent_global = 0x13579;',
  'int main() {',
  '  std::vector<int> parentMemory { 11, 22, 33, 44 };',
  '  int parentStack = 0x2468;',
  '  const int status = std::system("./cpp-child.out");',
  '  std::ifstream input("cpp-child-process.txt", std::ios::binary);',
  '  std::string child((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());',
  '  std::cout << "cpp-spawn:" << status << ":" << child << "\\n";',
  '  const bool memoryIsolated = parent_global == 0x13579 && parentStack == 0x2468 &&',
  '    parentMemory == std::vector<int>({ 11, 22, 33, 44 });',
  '  return status == 0 && child == "from-cpp-child" && memoryIsolated ? 0 : 1;',
  '}',
  '',
].join('\n');

const CPP_POSIX_PROCESS_GROUP_PROGRAM = [
  '#include <signal.h>',
  '#include <spawn.h>',
  '#include <sys/select.h>',
  '#include <sys/stat.h>',
  '#include <sys/wait.h>',
  '#include <unistd.h>',
  '#include <chrono>',
  '#include <cerrno>',
  '#include <cstdio>',
  '#include <fstream>',
  '#include <string>',
  '',
  'static bool wait_for(const char* path, int milliseconds) {',
  '  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(milliseconds);',
  '  struct stat info {};',
  '  while (std::chrono::steady_clock::now() < deadline) {',
  '    if (stat(path, &info) == 0) return true;',
  '  }',
  '  return false;',
  '}',
  '',
  'int main() {',
  '  errno = 0;',
  '  if (setsid() != -1 || errno != EPERM) return 19;',
  '  posix_spawnattr_t attributes {};',
  '  if (posix_spawnattr_init(&attributes) != 0) return 10;',
  '  if (posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSID) != 0) return 11;',
  '  char command[] = "node";',
  '  char script[] = "cpp-group-leader.js";',
  '  char* child_argv[] = { command, script, nullptr };',
  '  char environment[] = "CPP_GROUP_ENV=kernel";',
  '  char* child_envp[] = { environment, nullptr };',
  '  pid_t child = -1;',
  '  const int spawn_result = posix_spawn(&child, command, nullptr, &attributes, child_argv, child_envp);',
  '  posix_spawnattr_destroy(&attributes);',
  '  if (spawn_result != 0 || child <= 0 || child == getpid()) return 12;',
  '  if (getpgid(child) != child || getsid(child) != child) return 22;',
  '  int pending_status = -1;',
  '  if (waitpid(-1, &pending_status, WNOHANG) != 0 || pending_status != -1) return 18;',
  '  if (!wait_for("cpp-group-ready.txt", 20000)) return 13;',
  '  std::ifstream ready("cpp-group-ready.txt");',
  '  pid_t leader = -1;',
  '  pid_t descendant = -1;',
  '  char separator = 0;',
  '  ready >> leader >> separator >> descendant;',
  '  if (!ready || separator != \':\' || leader != child || descendant <= 0 || descendant == child) return 14;',
  '  if (killpg(child, SIGHUP) != 0) return 15;',
  '  int status = 0;',
  '  if (waitpid(-child, &status, 0) != child) return 16;',
  '  if (!WIFSIGNALED(status) || WTERMSIG(status) != SIGHUP) return 17;',
  '  char wait_script[] = "cpp-wait-child.js";',
  '  char* wait_argv[] = { command, wait_script, nullptr };',
  '  pid_t wait_child = -1;',
  '  if (posix_spawn(&wait_child, command, nullptr, nullptr, wait_argv, nullptr) != 0) return 20;',
  '  status = 0;',
  '  if (waitpid(0, &status, 0) != wait_child || !WIFEXITED(status) || WEXITSTATUS(status) != 42) return 21;',
  '  const auto settle = std::chrono::steady_clock::now() + std::chrono::milliseconds(600);',
  '  while (std::chrono::steady_clock::now() < settle) {}',
  '  struct stat survived {};',
  '  if (stat("cpp-group-survived.txt", &survived) == 0) return 18;',
  '  std::printf("posix-group:%d:%d:%d:%d:%d\\n",',
  '    static_cast<int>(getpid()),',
  '    static_cast<int>(getppid()),',
  '    static_cast<int>(getpgrp()),',
  '    static_cast<int>(getsid(0)),',
  '    static_cast<int>(child));',
  '  return 0;',
  '}',
  '',
].join('\n');

const CPP_POSIX_DESCRIPTOR_ACTION_PROGRAM = [
  '#include <fcntl.h>',
  '#include <poll.h>',
  '#include <spawn.h>',
  '#include <sys/wait.h>',
  '#include <unistd.h>',
  '#include <cerrno>',
  '#include <fstream>',
  '#include <iostream>',
  '#include <iterator>',
  '#include <string>',
  'int main() {',
  '  int pipe_descriptors[2] = { -1, -1 };',
  '  if (pipe2(pipe_descriptors, O_CLOEXEC | O_NONBLOCK) != 0) return 20;',
  '  const int pipe_flags = fcntl(pipe_descriptors[0], F_GETFD);',
  '  if ((pipe_flags & FD_CLOEXEC) == 0) return 21;',
  '  if ((fcntl(pipe_descriptors[0], F_GETFL) & O_NONBLOCK) == 0) return 25;',
  '  char empty_probe = 0;',
  '  errno = 0;',
  '  if (read(pipe_descriptors[0], &empty_probe, 1) != -1 || errno != EAGAIN) return 26;',
  '  pollfd empty_poll[2] = {',
  '    { pipe_descriptors[0], POLLIN, 0 },',
  '    { pipe_descriptors[1], POLLOUT, 0 },',
  '  };',
  '  const int empty_poll_count = poll(empty_poll, 2, 0);',
  '  if (empty_poll_count != 1 || empty_poll[0].revents != 0 || (empty_poll[1].revents & POLLOUT) == 0) {',
  '    std::cerr << "poll-empty:" << empty_poll_count << ":" << empty_poll[0].revents << ":" << empty_poll[1].revents << ":" << errno << ":" << sizeof(pollfd) << ":" << POLLIN << ":" << POLLOUT << ":" << pipe_descriptors[0] << ":" << pipe_descriptors[1] << "\\n";',
  '    return 27;',
  '  }',
  '  fd_set empty_select_read;',
  '  fd_set empty_select_write;',
  '  FD_ZERO(&empty_select_read);',
  '  FD_ZERO(&empty_select_write);',
  '  FD_SET(pipe_descriptors[0], &empty_select_read);',
  '  FD_SET(pipe_descriptors[1], &empty_select_write);',
  '  timeval zero_timeout { 0, 0 };',
  '  if (select(pipe_descriptors[1] + 1, &empty_select_read, &empty_select_write, nullptr, &zero_timeout) != 1 ||',
  '      FD_ISSET(pipe_descriptors[0], &empty_select_read) ||',
  '      !FD_ISSET(pipe_descriptors[1], &empty_select_write)) return 31;',
  '  const int duplicate_writer = dup3(pipe_descriptors[1], 30, O_CLOEXEC);',
  '  if (duplicate_writer != 30 || (fcntl(duplicate_writer, F_GETFD) & FD_CLOEXEC) == 0) return 22;',
  '  const char pipe_payload[] = "through-kernel-pipe";',
  '  if (write(duplicate_writer, pipe_payload, sizeof(pipe_payload) - 1) != sizeof(pipe_payload) - 1) return 23;',
  '  close(pipe_descriptors[1]);',
  '  close(duplicate_writer);',
  '  pollfd readable_poll = { pipe_descriptors[0], POLLIN, 0 };',
  '  const int readable_poll_count = poll(&readable_poll, 1, 1000);',
  '  if (readable_poll_count != 1 || (readable_poll.revents & POLLIN) == 0 || (readable_poll.revents & POLLHUP) == 0) {',
  '    std::cerr << "poll-readable:" << readable_poll_count << ":" << readable_poll.revents << ":" << POLLIN << ":" << POLLHUP << ":" << POLLERR << ":" << POLLNVAL << "\\n";',
  '    return 28;',
  '  }',
  '  fd_set readable_select;',
  '  FD_ZERO(&readable_select);',
  '  FD_SET(pipe_descriptors[0], &readable_select);',
  '  timeval readable_timeout { 1, 0 };',
  '  if (select(pipe_descriptors[0] + 1, &readable_select, nullptr, nullptr, &readable_timeout) != 1 ||',
  '      !FD_ISSET(pipe_descriptors[0], &readable_select)) return 32;',
  '  pollfd invalid_poll = { 999999, POLLIN, 0 };',
  '  if (poll(&invalid_poll, 1, 1000) != 1 || (invalid_poll.revents & POLLNVAL) == 0) return 29;',
  '  fd_set invalid_select;',
  '  FD_ZERO(&invalid_select);',
  '  FD_SET(99, &invalid_select);',
  '  timeval invalid_timeout { 0, 0 };',
  '  errno = 0;',
  '  if (select(100, &invalid_select, nullptr, nullptr, &invalid_timeout) != -1 || errno != EBADF) return 33;',
  '  char pipe_result[32] = {};',
  '  const int pipe_read = read(pipe_descriptors[0], pipe_result, sizeof(pipe_result));',
  '  close(pipe_descriptors[0]);',
  '  if (pipe_read != sizeof(pipe_payload) - 1 || std::string(pipe_result, pipe_read) != pipe_payload) return 24;',
  '  const int output = open("cpp-posix-fd.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);',
  '  if (output < 0 || output == 9) return 10;',
  '  if (fcntl(output, F_SETFD, FD_CLOEXEC) != 0) return 17;',
  '  if ((fcntl(output, F_GETFD) & FD_CLOEXEC) == 0) return 18;',
  '  posix_spawn_file_actions_t actions {};',
  '  if (posix_spawn_file_actions_init(&actions) != 0) return 11;',
  '  if (posix_spawn_file_actions_adddup2(&actions, output, 9) != 0) return 12;',
  '  if (posix_spawn_file_actions_addclose(&actions, output) != 0) return 13;',
  '  char command[] = "node";',
  '  char script[] = "cpp-fd-child.js";',
  '  char* child_argv[] = { command, script, nullptr };',
  '  pid_t child = -1;',
  '  const int spawn_result = posix_spawn(&child, command, &actions, nullptr, child_argv, nullptr);',
  '  posix_spawn_file_actions_destroy(&actions);',
  '  if (spawn_result != 0 || child <= 0) return 14;',
  '  int status = 0;',
  '  if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return 15;',
  '  close(output);',
  '  std::ifstream input("cpp-posix-fd.txt", std::ios::binary);',
  '  std::string contents((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());',
  '  std::cout << "posix-fd:" << contents << "\\n";',
  '  return contents == "through-inherited-fd" ? 0 : 16;',
  '}',
  '',
].join('\n');

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function base64FromString(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function stringFromBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

const WORKER_BOOTSTRAP = String.raw`
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const repoRoot = workerData.repoRoot;
const sharedKernelPolicySource = (await readFile(repoRoot + '/workers/shared/runtime-kernel-policy.js', 'utf8'))
  .replace(/\bexport\s+/g, '');
const workerSource = (await readFile(repoRoot + '/workers/cpp/cpp-worker.js', 'utf8')).replace(
  /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/,
  ''
);

const readAsset = async (url) => {
  const pathname = String(url).replace('file://', '');
  const data = await readFile(pathname);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    text: async () => data.toString('utf8'),
  };
};

const sandbox = {
  console,
  URL,
  TextEncoder,
  TextDecoder,
  WebAssembly,
  Date,
  performance,
  ArrayBuffer,
  SharedArrayBuffer,
  Atomics,
  DataView,
  Uint8Array,
  Int32Array,
  BigInt,
  Map,
  Set,
  WeakMap,
  Error,
  TypeError,
  RangeError,
  JSON,
  Object,
  Array,
  Boolean,
  String,
  Number,
  Math,
  RegExp,
  Promise,
  Blob,
  Headers,
  Response,
  atob,
  btoa,
  setTimeout,
  clearTimeout,
  queueMicrotask,
  globalThis: null,
  self: null,
  location: new URL(pathToFileURL(repoRoot + '/workers/cpp/cpp-worker.js').href),
  postMessage: (message) => parentPort.postMessage(message),
  fetch: readAsset,
  crypto: globalThis.crypto,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);
const script = new vm.Script(
  sharedKernelPolicySource + '\n' +
    'const isRuntimeDeviceDirectory = isRuntimeKernelDeviceDirectory;\n' +
    'const isRuntimeDeviceNamespacePath = isRuntimeKernelDeviceNamespacePath;\n' +
    'const isRuntimeProcPath = isRuntimeKernelProcPath;\n' +
    workerSource,
  {
    importModuleDynamically(specifier) {
      return import(specifier);
    },
  }
);
await script.runInContext(context);

parentPort.on('message', (message) => {
  sandbox.onmessage?.({ data: message });
});
`;

const JAVASCRIPT_WORKER_BOOTSTRAP = String.raw`
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

globalThis.self = globalThis;
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
self.postMessage = globalThis.postMessage;

const queued = [];
parentPort.on('message', (message) => {
  if (typeof self.onmessage === 'function') {
    self.onmessage({ data: message });
  } else {
    queued.push(message);
  }
});

await import(pathToFileURL(workerData.workerPath).href);
for (const message of queued.splice(0)) {
  self.onmessage?.({ data: message });
}
`;

interface CompileHost {
  compileProject(payload: unknown): Promise<{
    success?: boolean;
    error?: string;
    stdout?: string;
    stderr?: string;
    programBuffer?: ArrayBuffer;
  }>;
}

async function createCompileHost(): Promise<CompileHost> {
  const compilerSource = await readFile('workers/cpp/cpp-compiler-worker.js', 'utf8');
  const sandbox: Record<string, unknown> = {
    console,
    URL,
    TextEncoder,
    TextDecoder,
    WebAssembly,
    Date,
    performance,
    ArrayBuffer,
    DataView,
    Uint8Array,
    BigInt,
    Map,
    Set,
    Error,
    TypeError,
    JSON,
    Object,
    Array,
    String,
    Number,
    Math,
    RegExp,
    Promise,
    Blob,
    Headers,
    Response,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    globalThis: null,
    self: null,
    location: new URL(pathToFileURL(join(process.cwd(), 'workers/cpp/cpp-compiler-worker.js')).href),
    postMessage: () => {},
    fetch: async (url: string) => {
      const pathname = String(url).replace('file://', '');
      const data = await readFile(pathname);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        text: async () => data.toString('utf8'),
      };
    },
    crypto: globalThis.crypto,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  const script = new vm.Script(
    `${compilerSource}\nglobalThis.__tracecodeCompileProject = compileProjectWithYowasp;`,
    {
      importModuleDynamically(specifier: string) {
        return import(specifier);
      },
    }
  );
  script.runInContext(context);
  const compileProject = (sandbox as { __tracecodeCompileProject?: (payload: unknown) => Promise<never> }).__tracecodeCompileProject;
  if (typeof compileProject !== 'function') {
    throw new Error('cpp-compiler-worker.js did not expose compileProjectWithYowasp');
  }
  return { compileProject };
}

// Plain POSIX sockets only — no TraceCode-specific API. The program performs
// a loopback HTTP request, a named-host request through getaddrinfo, and then
// serves two HTTP requests from a hand-rolled socket server.
const CPP_HTTP_PROGRAM = [
  '#include <arpa/inet.h>',
  '#include <netdb.h>',
  '#include <netinet/in.h>',
  '#include <sys/socket.h>',
  '#include <unistd.h>',
  '#include <cstdio>',
  '#include <cstdlib>',
  '#include <cstring>',
  '#include <string>',
  '',
  'static std::string http_exchange(int fd, const std::string& request) {',
  '  const char* data = request.c_str();',
  '  size_t remaining = request.size();',
  '  while (remaining > 0) {',
  '    ssize_t sent = send(fd, data, remaining, 0);',
  '    if (sent <= 0) return "";',
  '    data += sent;',
  '    remaining -= (size_t)sent;',
  '  }',
  '  std::string response;',
  '  char buffer[512];',
  '  while (true) {',
  '    ssize_t got = recv(fd, buffer, sizeof(buffer), 0);',
  '    if (got <= 0) break;',
  '    response.append(buffer, (size_t)got);',
  '  }',
  '  return response;',
  '}',
  '',
  'static std::string status_line(const std::string& response) {',
  '  size_t end = response.find("\\r\\n");',
  '  return end == std::string::npos ? response : response.substr(0, end);',
  '}',
  '',
  'static std::string body_of(const std::string& response) {',
  '  size_t split = response.find("\\r\\n\\r\\n");',
  '  return split == std::string::npos ? std::string() : response.substr(split + 4);',
  '}',
  '',
  'int main() {',
  '  int fd = socket(AF_INET, SOCK_STREAM, 0);',
  '  sockaddr_in loopback {};',
  '  loopback.sin_family = AF_INET;',
  '  loopback.sin_port = htons(3300);',
  '  loopback.sin_addr.s_addr = inet_addr("127.0.0.1");',
  '  if (connect(fd, reinterpret_cast<sockaddr*>(&loopback), sizeof(loopback)) != 0) {',
  '    std::printf("connect-failed\\n");',
  '    return 1;',
  '  }',
  '  std::string response = http_exchange(fd,',
  '    "POST /echo?x=1 HTTP/1.1\\r\\n"',
  '    "Host: localhost:3300\\r\\n"',
  '    "X-Cpp: yes\\r\\n"',
  '    "Content-Length: 8\\r\\n"',
  '    "\\r\\n"',
  '    "cpp-body");',
  '  close(fd);',
  '  std::printf("loopback:%s:%s\\n", status_line(response).c_str(), body_of(response).c_str());',
  '',
  '  addrinfo hints {};',
  '  hints.ai_family = AF_INET;',
  '  hints.ai_socktype = SOCK_STREAM;',
  '  addrinfo* resolved = nullptr;',
  '  if (getaddrinfo("api.example.com", "http", &hints, &resolved) != 0 || resolved == nullptr) {',
  '    std::printf("resolve-failed\\n");',
  '    return 1;',
  '  }',
  '  int external = socket(resolved->ai_family, resolved->ai_socktype, 0);',
  '  if (connect(external, resolved->ai_addr, resolved->ai_addrlen) != 0) {',
  '    std::printf("external-connect-failed\\n");',
  '    return 1;',
  '  }',
  '  freeaddrinfo(resolved);',
  '  std::string externalResponse = http_exchange(external,',
  '    "GET /status HTTP/1.1\\r\\nHost: api.example.com\\r\\n\\r\\n");',
  '  close(external);',
  '  std::printf("external:%s:%s\\n", status_line(externalResponse).c_str(), body_of(externalResponse).c_str());',
  '',
  '  int server = socket(AF_INET, SOCK_STREAM, 0);',
  '  sockaddr_in bindAddress {};',
  '  bindAddress.sin_family = AF_INET;',
  '  bindAddress.sin_port = htons(3999);',
  '  bindAddress.sin_addr.s_addr = htonl(INADDR_ANY);',
  '  if (bind(server, reinterpret_cast<sockaddr*>(&bindAddress), sizeof(bindAddress)) != 0) {',
  '    std::printf("bind-failed\\n");',
  '    return 1;',
  '  }',
  '  if (listen(server, 4) != 0) {',
  '    std::printf("listen-failed\\n");',
  '    return 1;',
  '  }',
  '  sockaddr_in boundAddress {};',
  '  unsigned int boundLength = sizeof(boundAddress);',
  '  getsockname(server, reinterpret_cast<sockaddr*>(&boundAddress), &boundLength);',
  '  std::printf("listening:%d\\n", (int)ntohs(boundAddress.sin_port));',
  '',
  '  for (int index = 0; index < 2; index += 1) {',
  '    int conn = accept(server, nullptr, nullptr);',
  '    if (conn < 0) {',
  '      std::printf("accept-failed\\n");',
  '      return 1;',
  '    }',
  '    std::string request;',
  '    char buffer[512];',
  '    while (true) {',
  '      size_t headEnd = request.find("\\r\\n\\r\\n");',
  '      if (headEnd != std::string::npos) {',
  '        size_t contentLength = 0;',
  '        size_t marker = request.find("Content-Length:");',
  '        if (marker == std::string::npos) marker = request.find("content-length:");',
  '        if (marker != std::string::npos) contentLength = (size_t)atoi(request.c_str() + marker + 15);',
  '        if (request.size() >= headEnd + 4 + contentLength) break;',
  '      }',
  '      ssize_t got = recv(conn, buffer, sizeof(buffer), 0);',
  '      if (got <= 0) break;',
  '      request.append(buffer, (size_t)got);',
  '    }',
  '    std::string requestLine = request.substr(0, request.find("\\r\\n"));',
  '    std::string xreq;',
  '    size_t xreqAt = request.find("x-req: ");',
  '    if (xreqAt != std::string::npos) {',
  '      size_t lineEnd = request.find("\\r\\n", xreqAt);',
  '      xreq = request.substr(xreqAt + 7, lineEnd - xreqAt - 7);',
  '    }',
  '    std::string requestBody = body_of(request);',
  '    std::printf("request:%s:%s:%s\\n", requestLine.c_str(), xreq.c_str(), requestBody.c_str());',
  '    std::string responseBody = "reply-" + std::to_string(index) + ":" + xreq;',
  '    char head[256];',
  '    std::snprintf(head, sizeof(head),',
  '      "HTTP/1.1 %d OK\\r\\nContent-Type: text/plain\\r\\nX-Cpp-Server: ok\\r\\nContent-Length: %d\\r\\n\\r\\n",',
  '      200 + index, (int)responseBody.size());',
  '    std::string reply = std::string(head) + responseBody;',
  '    send(conn, reply.c_str(), reply.size(), 0);',
  '    close(conn);',
  '  }',
  '  close(server);',
  '  std::printf("done\\n");',
  '  return 0;',
  '}',
  '',
].join('\n');

async function main(): Promise<void> {
  // vm dynamic import (used to load the @yowasp/clang bundle) requires
  // --experimental-vm-modules; re-exec once with the flag so worker threads
  // inherit it through execArgv.
  if (
    !process.execArgv.includes('--experimental-vm-modules') &&
    !(process.env.NODE_OPTIONS ?? '').includes('--experimental-vm-modules')
  ) {
    execFileSync(
      process.execPath,
      ['--experimental-vm-modules', '--import', 'tsx', fileURLToPath(import.meta.url)],
      { cwd: process.cwd(), stdio: 'inherit', maxBuffer: 32 * 1024 * 1024 }
    );
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-http-'));
  const bootstrapPath = join(tempRoot, 'cpp-worker-thread.mjs');
  const javascriptBootstrapPath = join(tempRoot, 'javascript-worker-thread.mjs');
  await writeFile(bootstrapPath, WORKER_BOOTSTRAP, 'utf8');
  await writeFile(javascriptBootstrapPath, JAVASCRIPT_WORKER_BOOTSTRAP, 'utf8');

  const compileHost = await createCompileHost();
  const originalFetch = globalThis.fetch;
  const nodeWorkers: NodeWorker[] = [];

  class WorkerShim {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    private readonly worker: NodeWorker;

    constructor(url: string | URL, _options?: unknown) {
      const isJavaScriptWorker = String(url).includes('javascript-project-worker');
      this.worker = new NodeWorker(
        isJavaScriptWorker ? javascriptBootstrapPath : bootstrapPath,
        {
          workerData: isJavaScriptWorker
            ? { workerPath: join(process.cwd(), 'workers/javascript/javascript-project-worker.js') }
            : { repoRoot: process.cwd() },
        }
      );
      nodeWorkers.push(this.worker);
      this.worker.on('message', (data) => this.onmessage?.({ data }));
      this.worker.on('error', (error) => {
        this.onerror?.({ message: error instanceof Error ? error.message : String(error) });
      });
    }

    postMessage(message: unknown, transfer?: Transferable[]): void {
      this.worker.postMessage(message, transfer as import('node:worker_threads').TransferListItem[]);
    }

    terminate(): void {
      void this.worker.terminate();
    }
  }

  const previousWorker = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = WorkerShim;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === EXTERNAL_COMPILER_URL) {
      const payload = JSON.parse(String(init?.body ?? '{}')) as unknown;
      const result = await compileHost.compileProject(payload);
      if (result?.success && result.programBuffer instanceof ArrayBuffer) {
        return new Response(result.programBuffer, {
          status: 200,
          headers: { 'content-type': 'application/wasm' },
        });
      }
      return new Response(JSON.stringify(result ?? { success: false, error: 'C++ test compile failed' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(input as never, init);
  }) as typeof fetch;

  const cppClientOptions = {
    workerUrl: 'cpp-worker.js',
    debug: false,
    clangWasmUrl: 'file:///missing/clang.wasm',
    lldWasmUrl: 'file:///missing/lld.wasm',
    sysrootUrl: 'file:///missing/sysroot.tar',
    runtimeHeaderUrl: pathToFileURL(join(process.cwd(), 'workers/cpp/tracecode_runtime.hpp')).href,
    compilerBundleUrl: pathToFileURL(join(process.cwd(), 'node_modules/@yowasp/clang/gen/bundle.js')).href,
    externalCompilerUrl: EXTERNAL_COMPILER_URL,
  };
  const client = new CppWorkerClient(cppClientOptions);
  const nestedCppClient = new CppWorkerClient(cppClientOptions);
  const cppClientLeases = [client, nestedCppClient].map((workerClient) => ({
    workerClient,
    active: false,
  }));
  const pooledCppClient = {
    async executeProjectCpp(
      request: Parameters<CppWorkerClient['executeProjectCpp']>[0],
      timeoutMs?: number,
      onEvent?: Parameters<CppWorkerClient['executeProjectCpp']>[2],
      signal?: AbortSignal
    ) {
      const lease = cppClientLeases.find((candidate) => !candidate.active);
      assertCondition(lease !== undefined, 'C++ test worker pool exhausted');
      lease.active = true;
      try {
        return await lease.workerClient.executeProjectCpp(request, timeoutMs, onEvent, signal);
      } finally {
        lease.active = false;
      }
    },
  };

  try {
    const projectFiles = [{ path: 'main.cpp', contents: CPP_HTTP_PROGRAM }];
    const compileResult = await client.executeProjectCpp({
      code: '',
      source: 'compile',
      scriptPath: 'main.cpp',
      args: ['main.cpp', '-o', 'a.out'],
      cwd: '/workspace',
      env: {},
      project: { files: projectFiles },
    }, 300_000);
    assertCondition(
      compileResult.exitCode === 0,
      `plain BSD-socket C++ program should compile against the wasi sysroot with injected shims: ${JSON.stringify({
        exitCode: compileResult.exitCode,
        stdout: compileResult.stdout,
        stderr: compileResult.stderr,
      })}`
    );
    const compiledFiles = compileResult.files ?? [];
    assertCondition(
      compiledFiles.some((file) => file.path === 'a.out'),
      `C++ socket compile should emit a.out: ${JSON.stringify(compiledFiles.map((file) => file.path))}`
    );
    console.log('PASS: plain POSIX socket code compiles in C++ project mode without any TraceCode API');

    const tkfsWorkspace = await createRuntimeWorkspace({
      files: [
        { path: 'tkfs.cpp', contents: CPP_TKFS_PROGRAM },
        { path: 'seed.txt', contents: 'kernel-read\n' },
      ],
      cppRunner: createBrowserCppProjectRunner(client, { timeoutMs: 120_000 }),
    });
    try {
      const tkfsCompile = await tkfsWorkspace.runCommand('clang++ tkfs.cpp -o a.out');
      assertCondition(
        tkfsCompile.exitCode === 0,
        `C++ TKFS fixture should compile: ${JSON.stringify(tkfsCompile)}`
      );
      const tkfsRun = await tkfsWorkspace.runCommand('./a.out', {
        stdinPipe: createRuntimeCommandStdinPipeFromText('kernel-stdin\n'),
      });
      assertCondition(
        tkfsRun.exitCode === 0 &&
          tkfsRun.stdout === 'kernel-read\nstdin:kernel-stdin\n' &&
          tkfsRun.stderr === 'kernel-stderr\n' &&
          await tkfsWorkspace.readFile('generated.txt') === 'kernel-write',
        `C++ WASI should use the authoritative TraceKernel filesystem and stdio descriptors: ${JSON.stringify({
          run: tkfsRun,
          snapshot: await tkfsWorkspace.snapshot(),
        })}`
      );
      assertCondition(
        (tkfsRun.files ?? []).length === 0,
        `kernel-backed C++ mutations should not be replayed as snapshot diffs: ${JSON.stringify(tkfsRun.files)}`
      );
    } finally {
      tkfsWorkspace.dispose();
    }
    console.log('PASS: C++ WASI filesystem calls use TraceKernel-owned descriptors');

    const javascriptRunner = createBrowserJavaScriptProjectRunner({
      workerUrl: 'javascript-project-worker.js',
      workerFactory: (url, options) => new WorkerShim(url, options),
      workerIsolation: 'per-command',
      timeoutMs: 120_000,
    });
    const crossLanguageWorkspace = await createRuntimeWorkspace({
      files: [
        { path: 'cross-language.cpp', contents: CPP_CROSS_LANGUAGE_FS_PROGRAM },
        { path: 'spawn-javascript.cpp', contents: CPP_SPAWN_JAVASCRIPT_PROGRAM },
        { path: 'cpp-child.cpp', contents: CPP_CHILD_PROGRAM },
        { path: 'spawn-cpp.cpp', contents: CPP_SPAWN_CPP_PROGRAM },
        { path: 'posix-process-group.cpp', contents: CPP_POSIX_PROCESS_GROUP_PROGRAM },
        { path: 'posix-descriptor-action.cpp', contents: CPP_POSIX_DESCRIPTOR_ACTION_PROGRAM },
        { path: 'watchdog-control.cpp', contents: CPP_WATCHDOG_CONTROL_PROGRAM },
        { path: 'watchdog-expiry.cpp', contents: CPP_WATCHDOG_EXPIRY_PROGRAM },
        { path: 'terminal-window-size.cpp', contents: CPP_TERMINAL_WINDOW_SIZE_PROGRAM },
        { path: 'cpp-watches.txt', contents: 'before-js' },
        { path: 'js-watches.txt', contents: 'before-cpp' },
        {
          path: 'cpp-child.js',
          contents: [
            'const fs = require("node:fs");',
            'fs.writeFileSync("cpp-child-owned.txt", `${process.ppid}:${process.pid}`);',
            '',
          ].join('\n'),
        },
        {
          path: 'cpp-fd-child.js',
          contents: [
            'const fs = require("node:fs");',
            'fs.writeSync(9, "through-inherited-fd");',
            'fs.closeSync(9);',
            '',
          ].join('\n'),
        },
        {
          path: 'cpp-group-leader.js',
          contents: [
            'const fs = require("node:fs");',
            'const { spawn } = require("node:child_process");',
            'if (process.env.CPP_GROUP_ENV !== "kernel") throw new Error("posix_spawn envp was not forwarded");',
            'const descendant = spawn("node", ["cpp-group-descendant.js"], { stdio: "inherit" });',
            'fs.writeFileSync("cpp-group-ready.txt", `${process.pid}:${descendant.pid}`);',
            'setInterval(() => {}, 1000);',
            '',
          ].join('\n'),
        },
        {
          path: 'cpp-group-descendant.js',
          contents: [
            'const fs = require("node:fs");',
            'setTimeout(() => fs.writeFileSync("cpp-group-survived.txt", "bad"), 300);',
            'setInterval(() => {}, 1000);',
            '',
          ].join('\n'),
        },
        {
          path: 'cpp-wait-child.js',
          contents: 'process.exit(42);\n',
        },
        {
          path: 'js-spawn-cpp.js',
          contents: [
            'const fs = require("node:fs");',
            'const { spawn } = require("node:child_process");',
            'try { fs.unlinkSync("cpp-child-process.txt"); } catch (error) {',
            '  if (error.code !== "ENOENT") throw error;',
            '}',
            'const child = spawn("./cpp-child.out", [], { stdio: "inherit" });',
            'child.on("close", (code) => {',
            '  const contents = fs.readFileSync("cpp-child-process.txt", "utf8");',
            '  console.log(`js-cpp-spawn:${code}:${contents}:${process.pid}:${child.pid}`);',
            '});',
            '',
          ].join('\n'),
        },
        {
          path: 'js-writer.js',
          contents: [
            'const fs = require("node:fs");',
            'const deadline = Date.now() + 20_000;',
            'while (!fs.existsSync("cpp-ready.txt") && Date.now() < deadline) {}',
            'if (!fs.existsSync("cpp-ready.txt")) throw new Error("C++ reader did not become ready");',
            'fs.writeFileSync("cpp-watches.txt", "from-js");',
            'fs.writeFileSync("js-done.txt", "done");',
            'console.log("js-wrote");',
            '',
          ].join('\n'),
        },
        {
          path: 'js-watcher.js',
          contents: [
            'const fs = require("node:fs");',
            'const fd = fs.openSync("js-watches.txt", "r");',
            'fs.writeFileSync("js-ready.txt", "ready");',
            'const deadline = Date.now() + 20_000;',
            'while (!fs.existsSync("cpp-done.txt") && Date.now() < deadline) {}',
            'if (!fs.existsSync("cpp-done.txt")) throw new Error("C++ writer did not finish");',
            'const buffer = Buffer.alloc(64);',
            'const count = fs.readSync(fd, buffer, 0, buffer.length, 0);',
            'fs.closeSync(fd);',
            'console.log(`js-observed:${buffer.subarray(0, count).toString("utf8")}`);',
            '',
          ].join('\n'),
        },
      ],
      cppRunner: createBrowserCppProjectRunner(pooledCppClient, { timeoutMs: 120_000 }),
      nodeRunner: javascriptRunner,
    });
    try {
      const crossLanguageCompile = await crossLanguageWorkspace.runCommand(
        'clang++ cross-language.cpp -o a.out'
      );
      assertCondition(
        crossLanguageCompile.exitCode === 0,
        `cross-language C++ fixture should compile: ${JSON.stringify(crossLanguageCompile)}`
      );

      const [cppWatching, javascriptWriting] = await Promise.all([
        crossLanguageWorkspace.runCommand('./a.out watch-js'),
        crossLanguageWorkspace.runCommand('node js-writer.js'),
      ]);
      assertCondition(
        cppWatching.exitCode === 0 &&
          cppWatching.stdout === 'cpp-observed:from-js\n' &&
          javascriptWriting.exitCode === 0 &&
          javascriptWriting.stdout === 'js-wrote\n',
        `an already-open C++ descriptor should observe a JavaScript mutation: ${JSON.stringify({
          cppWatching,
          javascriptWriting,
        })}`
      );

      const [javascriptWatching, cppWriting] = await Promise.all([
        crossLanguageWorkspace.runCommand('node js-watcher.js'),
        crossLanguageWorkspace.runCommand('./a.out write-js'),
      ]);
      assertCondition(
        javascriptWatching.exitCode === 0 &&
          javascriptWatching.stdout === 'js-observed:from-cpp\n' &&
          cppWriting.exitCode === 0 &&
          cppWriting.stdout === 'cpp-wrote\n',
        `an already-open JavaScript descriptor should observe a C++ mutation: ${JSON.stringify({
          javascriptWatching,
          cppWriting,
        })}`
      );

      const kernelEvents = await crossLanguageWorkspace.readFile('/proc/tracekernel/events');
      assertCondition(
        kernelEvents.includes('./a.out watch-js') &&
          kernelEvents.includes('node js-writer.js') &&
          kernelEvents.includes('node js-watcher.js') &&
          kernelEvents.includes('./a.out write-js'),
        `the shared kernel should own all four process lifecycles: ${JSON.stringify(kernelEvents)}`
      );
      assertCondition(
        (cppWatching.files ?? []).length === 0 &&
          (javascriptWriting.files ?? []).length === 0 &&
          (javascriptWatching.files ?? []).length === 0 &&
          (cppWriting.files ?? []).length === 0,
        'cross-language mutations should be authoritative syscalls, not returned snapshot diffs'
      );

      const spawnCompile = await crossLanguageWorkspace.runCommand(
        'clang++ spawn-javascript.cpp -o a.out'
      );
      assertCondition(
        spawnCompile.exitCode === 0,
        `C++ process fixture should compile with the kernel process shim: ${JSON.stringify(spawnCompile)}`
      );
      const spawnExecutable = (await crossLanguageWorkspace.snapshot()).files.find(
        (file) => file.path === 'a.out'
      );
      assertCondition(spawnExecutable !== undefined, 'C++ process fixture should emit a.out');
      const spawnExecutableBytes = spawnExecutable.encoding === 'base64'
        ? Buffer.from(spawnExecutable.contents, 'base64')
        : Buffer.from(spawnExecutable.contents, 'utf8');
      const spawnImports = WebAssembly.Module.imports(
        await WebAssembly.compile(spawnExecutableBytes)
      );
      assertCondition(
        spawnImports.some(
          (item) => item.module === 'tracecode_kernel' && item.name === 'proc_system'
        ),
        `C++ process fixture should import TraceKernel proc_system: ${JSON.stringify(spawnImports)}`
      );
      const spawnedJavaScript = await crossLanguageWorkspace.runCommand('./a.out');
      const spawnEventsAfterRun = await crossLanguageWorkspace.readFile('/proc/tracekernel/events');
      const childIdentity = /^spawn:0:(\d+):(\d+)\n$/.exec(spawnedJavaScript.stdout);
      assertCondition(
        spawnedJavaScript.exitCode === 0 &&
          childIdentity !== null &&
          childIdentity[1] !== childIdentity[2] &&
          await crossLanguageWorkspace.readFile('cpp-child-owned.txt') ===
            `${childIdentity[1]}:${childIdentity[2]}`,
        `C++ system() should spawn and wait for a distinct JavaScript process over TraceKernel: ${JSON.stringify({
          result: spawnedJavaScript,
          events: spawnEventsAfterRun,
        })}`
      );
      const spawnEvents = spawnEventsAfterRun;
      const eventRows = spawnEvents.trim().split('\n').slice(1).map((line) => {
        const [seq, time, type, pid, detail] = line.split('\t');
        return {
          seq,
          time,
          type,
          pid: Number(pid),
          detail: detail ? JSON.parse(detail) as { command?: string; ppid?: number } : {},
        };
      });
      const parentStart = eventRows.find(
        (event) =>
          event.type === 'process-start' &&
          event.detail.command === './a.out' &&
          event.pid === Number(childIdentity[1])
      );
      const childStart = eventRows.find(
        (event) => event.type === 'process-start' && event.detail.command === 'node cpp-child.js'
      );
      assertCondition(
        parentStart !== undefined &&
          childStart !== undefined &&
          childStart.detail.ppid === parentStart.pid &&
          childStart.pid === Number(childIdentity[2]) &&
          childStart.detail.ppid === Number(childIdentity[1]) &&
          eventRows.some((event) => event.type === 'process-reap' && event.pid === childStart.pid),
        `TraceKernel should own the C++-created JavaScript child hierarchy through reap: ${JSON.stringify({
          parentStart,
          childStart,
          events: eventRows.filter((event) => event.pid === childStart?.pid),
        })}`
      );

      const cppChildCompile = await crossLanguageWorkspace.runCommand(
        'clang++ cpp-child.cpp -o cpp-child.out'
      );
      assertCondition(
        cppChildCompile.exitCode === 0,
        `nested C++ child should compile: ${JSON.stringify(cppChildCompile)}`
      );
      const cppParentCompile = await crossLanguageWorkspace.runCommand(
        'clang++ spawn-cpp.cpp -o a.out'
      );
      assertCondition(
        cppParentCompile.exitCode === 0,
        `nested C++ parent should compile: ${JSON.stringify(cppParentCompile)}`
      );
      const spawnedCpp = await crossLanguageWorkspace.runCommand('./a.out');
      const cppSpawnSnapshot = await crossLanguageWorkspace.snapshot();
      const cppSpawnKernelEvents = await crossLanguageWorkspace.readFile('/proc/tracekernel/events');
      assertCondition(
        spawnedCpp.exitCode === 0 &&
          spawnedCpp.stdout === 'cpp-spawn:0:from-cpp-child\n' &&
          await crossLanguageWorkspace.readFile('cpp-child-process.txt') === 'from-cpp-child',
        `C++ should spawn and wait for C++ on a separate worker lease: ${JSON.stringify({
          result: spawnedCpp,
          files: cppSpawnSnapshot.files.map((file) => file.path),
          events: cppSpawnKernelEvents,
        })}`
      );
      const cppSpawnEvents = cppSpawnKernelEvents;
      const cppEventRows = cppSpawnEvents.trim().split('\n').slice(1).map((line) => {
        const [, , type, pid, detail] = line.split('\t');
        return {
          type,
          pid: Number(pid),
          detail: detail ? JSON.parse(detail) as { command?: string; ppid?: number } : {},
        };
      });
      const cppChildStart = cppEventRows.find(
        (event) => event.type === 'process-start' && event.detail.command === './cpp-child.out'
      );
      const cppParentStart = cppEventRows.find(
        (event) =>
          event.type === 'process-start' &&
          event.detail.command === './a.out' &&
          cppChildStart?.detail.ppid === event.pid
      );
      assertCondition(
        cppParentStart !== undefined &&
          cppChildStart !== undefined &&
          cppChildStart.pid !== cppParentStart.pid &&
          cppEventRows.some(
            (event) => event.type === 'process-reap' && event.pid === cppChildStart.pid
          ),
        `TraceKernel should own nested C++ hierarchy and reap: ${JSON.stringify({
          cppParentStart,
          cppChildStart,
        })}`
      );

      const javascriptSpawnedCpp = await crossLanguageWorkspace.runCommand(
        'node js-spawn-cpp.js'
      );
      const javascriptCppIdentity =
        /^js-cpp-spawn:0:from-cpp-child:(\d+):(\d+)\n$/.exec(javascriptSpawnedCpp.stdout);
      assertCondition(
        javascriptSpawnedCpp.exitCode === 0 &&
          javascriptCppIdentity !== null &&
          javascriptCppIdentity[1] !== javascriptCppIdentity[2],
        `JavaScript should spawn and wait for C++ through TraceKernel: ${JSON.stringify(
          javascriptSpawnedCpp
        )}`
      );
      const reverseEvents = await crossLanguageWorkspace.readFile('/proc/tracekernel/events');
      const reverseRows = reverseEvents.trim().split('\n').slice(1).map((line) => {
        const [, , type, pid, detail] = line.split('\t');
        return {
          type,
          pid: Number(pid),
          detail: detail ? JSON.parse(detail) as { command?: string; ppid?: number } : {},
        };
      });
      const javascriptParentStart = reverseRows.find(
        (event) =>
          event.type === 'process-start' &&
          event.detail.command === 'node js-spawn-cpp.js' &&
          event.pid === Number(javascriptCppIdentity[1])
      );
      const reverseCppChildStart = reverseRows.find(
        (event) =>
          event.type === 'process-start' &&
          event.detail.command === './cpp-child.out' &&
          event.pid === Number(javascriptCppIdentity[2])
      );
      assertCondition(
        javascriptParentStart !== undefined &&
          reverseCppChildStart !== undefined &&
          reverseCppChildStart.detail.ppid === javascriptParentStart.pid &&
          reverseRows.some(
            (event) =>
              event.type === 'process-reap' &&
              event.pid === reverseCppChildStart.pid
          ),
        `TraceKernel should own the JavaScript-created C++ hierarchy through reap: ${JSON.stringify({
          javascriptParentStart,
          reverseCppChildStart,
        })}`
      );

      const posixProcessCompile = await crossLanguageWorkspace.runCommand(
        'clang++ posix-process-group.cpp -o a.out'
      );
      assertCondition(
        posixProcessCompile.exitCode === 0,
        `C++ POSIX process-group fixture should compile: ${JSON.stringify(posixProcessCompile)}`
      );
      const posixExecutable = (await crossLanguageWorkspace.snapshot()).files.find(
        (file) => file.path === 'a.out'
      );
      assertCondition(posixExecutable !== undefined, 'C++ POSIX process fixture should emit a.out');
      const posixExecutableBytes = posixExecutable.encoding === 'base64'
        ? Buffer.from(posixExecutable.contents, 'base64')
        : Buffer.from(posixExecutable.contents, 'utf8');
      const posixImports = WebAssembly.Module.imports(
        await WebAssembly.compile(posixExecutableBytes)
      );
      for (const name of ['proc_spawn', 'proc_wait', 'proc_kill', 'proc_identity']) {
        assertCondition(
          posixImports.some(
            (item) => item.module === 'tracecode_kernel' && item.name === name
          ),
          `C++ POSIX process fixture should import ${name}: ${JSON.stringify(posixImports)}`
        );
      }
      const posixProcessRun = await crossLanguageWorkspace.runCommand('./a.out');
      const posixIdentity =
        /^posix-group:(\d+):(\d+):(\d+):(\d+):(\d+)\n$/.exec(posixProcessRun.stdout);
      assertCondition(
        posixProcessRun.exitCode === 0 &&
          posixIdentity !== null &&
          posixIdentity[1] !== posixIdentity[2] &&
          posixIdentity[1] === posixIdentity[3] &&
          Number(posixIdentity[4]) > 0 &&
          posixIdentity[1] !== posixIdentity[5],
        `C++ posix_spawn, waitpid, identity, and killpg should stay kernel-owned: ${JSON.stringify(
          posixProcessRun
        )}`
      );
      assertCondition(
        !(await crossLanguageWorkspace.snapshot()).files.some(
          (file) => file.path === 'cpp-group-survived.txt'
        ),
        'one C++ killpg call should terminate the JavaScript leader and descendant'
      );

      const posixDescriptorCompile = await crossLanguageWorkspace.runCommand(
        'clang++ posix-descriptor-action.cpp -o a.out'
      );
      assertCondition(
        posixDescriptorCompile.exitCode === 0,
        `C++ POSIX descriptor-action fixture should compile: ${JSON.stringify(
          posixDescriptorCompile
        )}`
      );
      const posixDescriptorRun = await crossLanguageWorkspace.runCommand('./a.out');
      assertCondition(
        posixDescriptorRun.exitCode === 0 &&
          posixDescriptorRun.stdout === 'posix-fd:through-inherited-fd\n' &&
          await crossLanguageWorkspace.readFile('cpp-posix-fd.txt') ===
            'through-inherited-fd',
        `C++ posix_spawn file actions should remap a kernel fd into a JavaScript child: ${JSON.stringify(
          posixDescriptorRun
        )}`
      );

      const terminalWindowSizeCompile = await crossLanguageWorkspace.runCommand(
        'clang++ terminal-window-size.cpp -o a.out'
      );
      assertCondition(
        terminalWindowSizeCompile.exitCode === 0,
        `C++ terminal window-size fixture should compile: ${JSON.stringify(
          terminalWindowSizeCompile
        )}`
      );
      const terminalWindowExecutable = (
        await crossLanguageWorkspace.snapshot()
      ).files.find((file) => file.path === 'a.out');
      assertCondition(
        terminalWindowExecutable !== undefined,
        'C++ terminal window-size fixture should emit a.out'
      );
      const terminalWindowBytes = terminalWindowExecutable.encoding === 'base64'
        ? Buffer.from(terminalWindowExecutable.contents, 'base64')
        : Buffer.from(terminalWindowExecutable.contents, 'utf8');
      const terminalWindowImports = WebAssembly.Module.imports(
        await WebAssembly.compile(terminalWindowBytes)
      );
      for (const name of ['proc_tcgetwinsize', 'proc_tcsetwinsize']) {
        assertCondition(
          terminalWindowImports.some(
            (item) =>
              item.module === 'tracecode_kernel' &&
              item.name === name
          ),
          `ordinary C++ ioctl should import ${name}: ${JSON.stringify(
            terminalWindowImports
          )}`
        );
      }
      const terminalSession = crossLanguageWorkspace.createTerminalSession();
      terminalSession.resize(144, 55);
      const terminalWindowSizeRun = await terminalSession.run('./a.out');
      assertCondition(
        terminalWindowSizeRun.exitCode === 0 &&
          terminalWindowSizeRun.stdout ===
            'terminal-size:pass:55:144:66:166\n',
        `C++ TIOCGWINSZ/TIOCSWINSZ should use the kernel terminal: ${JSON.stringify(
          terminalWindowSizeRun
        )}`
      );

      const watchdogControlCompile = await crossLanguageWorkspace.runCommand(
        'clang++ watchdog-control.cpp -o a.out'
      );
      assertCondition(
        watchdogControlCompile.exitCode === 0,
        `C++ TraceKernel watchdog controls should compile: ${JSON.stringify(watchdogControlCompile)}`
      );
      const watchdogExecutable = (await crossLanguageWorkspace.snapshot()).files.find(
        (file) => file.path === 'a.out'
      );
      assertCondition(watchdogExecutable !== undefined, 'C++ watchdog fixture should emit a.out');
      const watchdogExecutableBytes = watchdogExecutable.encoding === 'base64'
        ? Buffer.from(watchdogExecutable.contents, 'base64')
        : Buffer.from(watchdogExecutable.contents, 'utf8');
      const watchdogImports = WebAssembly.Module.imports(
        await WebAssembly.compile(watchdogExecutableBytes)
      );
      assertCondition(
        watchdogImports.some(
          (item) =>
            item.module === 'tracecode_kernel' &&
            item.name === 'proc_watchdog'
        ),
        `C++ watchdog controls should import the TraceKernel ABI: ${JSON.stringify(watchdogImports)}`
      );
      const watchdogControl = await crossLanguageWorkspace.runCommand('./a.out');
      assertCondition(
        watchdogControl.exitCode === 0 &&
          watchdogControl.stdout === 'watchdog:pass\n',
        `C++ watchdog arm, status, pet, and disarm should stay kernel-owned: ${JSON.stringify(watchdogControl)}`
      );

      const watchdogExpiryCompile = await crossLanguageWorkspace.runCommand(
        'clang++ watchdog-expiry.cpp -o a.out'
      );
      assertCondition(
        watchdogExpiryCompile.exitCode === 0,
        `C++ watchdog expiry fixture should compile: ${JSON.stringify(watchdogExpiryCompile)}`
      );
      const watchdogExpiry = await crossLanguageWorkspace.runCommand('./a.out');
      assertCondition(
        watchdogExpiry.exitCode === 137 &&
          watchdogExpiry.error?.detail?.signal === 'SIGKILL',
        `C++ watchdog expiry should terminate the process through TraceKernel: ${JSON.stringify(watchdogExpiry)}`
      );
    } finally {
      crossLanguageWorkspace.dispose();
      javascriptRunner.dispose?.();
    }
    console.log('PASS: C++ process, isolation, and watchdog controls use TraceKernel');

    const tcpWorkspace = await createRuntimeWorkspace({
      files: [{ path: 'tcp.cpp', contents: CPP_TK_TCP_PROGRAM }],
      cppRunner: createBrowserCppProjectRunner(client, { timeoutMs: 120_000 }),
    });
    try {
      const tcpCompile = await tcpWorkspace.runCommand('clang++ tcp.cpp -o a.out');
      assertCondition(
        tcpCompile.exitCode === 0,
        `C++ TraceKernel TCP fixture should compile: ${JSON.stringify(tcpCompile)}`
      );
      const tcpRun = await tcpWorkspace.runCommand('./a.out');
      assertCondition(
        tcpRun.exitCode === 0 && tcpRun.stdout === 'ping:pong\n',
        `C++ BSD sockets should use TraceKernel TCP byte streams: ${JSON.stringify(tcpRun)}`
      );
    } finally {
      tcpWorkspace.dispose();
    }
    console.log('PASS: C++ BSD sockets use TraceKernel TCP descriptors');

    const dispatched: Array<RuntimeKernelHttpRequest & { timeoutMs?: number }> = [];
    let listenerHandler: RuntimeKernelHttpHandler | undefined;
    let listenerOptions: RuntimeKernelHttpListenOptions | undefined;
    let listenerClosed = false;
    const kernelHttp: RuntimeKernelHttpBridge = {
      listen(options, handler) {
        listenerOptions = options;
        listenerHandler = handler;
        return {
          id: 'cpp-e2e-listener',
          info: {
            id: 'cpp-e2e-listener',
            pid: 0,
            host: options.host ?? '127.0.0.1',
            port: options.port,
            protocol: 'http',
            startedAt: '2026-07-02T00:00:00.000Z',
          },
          close() {
            listenerClosed = true;
          },
        };
      },
      async dispatch(request, options) {
        dispatched.push({ ...request, ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
        return {
          status: 209,
          headers: { 'x-echo': request.headers?.['x-cpp'] ?? '' },
          body: `dispatch:${request.method}:${request.path}:${request.body !== undefined ? stringFromBase64(request.body) : ''}`,
        };
      },
    };

    const runPromise = client.executeProjectCpp({
      code: '',
      source: 'run',
      scriptPath: './a.out',
      args: [],
      cwd: '/workspace',
      env: {},
      project: { files: [...projectFiles, ...compiledFiles] as import('../packages/harness-core/src/runtime-project').RuntimeFile[] },
      kernelHttp,
    }, 120_000);

    const listenerReady = (async () => {
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        if (listenerHandler) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('C++ program did not register a TraceKernel HTTP listener in time');
    })();
    await Promise.race([listenerReady, runPromise.then((result) => {
      throw new Error(`C++ program exited before registering a listener: ${JSON.stringify(result)}`);
    })]);

    const firstResponse = await listenerHandler!({
      method: 'POST',
      url: 'http://127.0.0.1:3999/task?id=1',
      path: '/task?id=1',
      headers: { 'x-req': 'one' },
      body: 'payload-1',
    });
    const secondResponse = await listenerHandler!({
      method: 'GET',
      url: 'http://127.0.0.1:3999/status',
      path: '/status',
      headers: { 'x-req': 'two' },
    });
    const runResult = await runPromise;

    assertCondition(
      runResult.exitCode === 0,
      `C++ HTTP program should exit cleanly: ${JSON.stringify({ exitCode: runResult.exitCode, stdout: runResult.stdout, stderr: runResult.stderr })}`
    );
    const expectedStdout = [
      'loopback:HTTP/1.1 209:dispatch:POST:/echo?x=1:cpp-body',
      'external:HTTP/1.1 209:dispatch:GET:/status:',
      'listening:3999',
      'request:POST /task?id=1 HTTP/1.1:one:payload-1',
      'request:GET /status HTTP/1.1:two:',
      'done',
      '',
    ].join('\n');
    assertCondition(
      runResult.stdout === expectedStdout,
      `C++ socket program stdout mismatch:\n--- expected ---\n${expectedStdout}\n--- actual ---\n${runResult.stdout}\n--- stderr ---\n${runResult.stderr}`
    );
    console.log('PASS: C++ programs speak HTTP over plain sockets and observe host responses');

    assertCondition(dispatched.length === 2, `C++ program should dispatch two outbound requests: ${JSON.stringify(dispatched)}`);
    const loopbackRequest = dispatched[0]!;
    assertCondition(
      loopbackRequest.method === 'POST' &&
        loopbackRequest.url === 'http://127.0.0.1:3300/echo?x=1' &&
        loopbackRequest.path === '/echo?x=1' &&
        loopbackRequest.headers?.['x-cpp'] === 'yes' &&
        loopbackRequest.headers?.['host'] === 'localhost:3300' &&
        loopbackRequest.bodyEncoding === 'base64' &&
        loopbackRequest.body === base64FromString('cpp-body'),
      `C++ loopback socket request should carry method/url/headers/body through the bridge: ${JSON.stringify(loopbackRequest)}`
    );
    const externalRequest = dispatched[1]!;
    assertCondition(
      externalRequest.method === 'GET' &&
        externalRequest.url === 'http://api.example.com/status' &&
        externalRequest.path === '/status' &&
        externalRequest.body === undefined,
      `getaddrinfo-resolved request should carry the hostname into the bridge URL: ${JSON.stringify(externalRequest)}`
    );
    console.log('PASS: BSD-socket requests reach the host RuntimeKernelHttpBridge intact (loopback and named hosts)');

    assertCondition(
      listenerOptions?.port === 3999 && (listenerOptions?.host ?? '127.0.0.1') === '127.0.0.1',
      `C++ listener should register host/port with the bridge: ${JSON.stringify(listenerOptions)}`
    );
    assertCondition(
      firstResponse.status === 200 &&
        firstResponse.bodyEncoding === 'base64' &&
        firstResponse.body === base64FromString('reply-0:one') &&
        firstResponse.rawHeaders?.some(([name, value]) => name.toLowerCase() === 'x-cpp-server' && value === 'ok') === true,
      `first C++ server response mismatch: ${JSON.stringify(firstResponse)}`
    );
    assertCondition(
      secondResponse.status === 201 &&
        secondResponse.bodyEncoding === 'base64' &&
        secondResponse.body === base64FromString('reply-1:two'),
      `second C++ server response mismatch: ${JSON.stringify(secondResponse)}`
    );
    assertCondition(listenerClosed, 'closing the C++ server socket should close the host listener handle');
    console.log('PASS: hand-rolled C++ socket server serves sequential requests over the sync bridge');
  } finally {
    client.terminate();
    nestedCppClient.terminate();
    globalThis.fetch = originalFetch;
    if (previousWorker === undefined) {
      delete (globalThis as { Worker?: unknown }).Worker;
    } else {
      (globalThis as { Worker?: unknown }).Worker = previousWorker;
    }
    await Promise.all(nodeWorkers.map((worker) => worker.terminate().catch(() => {})));
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await test('cpp project http', main);

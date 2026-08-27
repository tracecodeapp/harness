var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// packages/tracekernel/src/watch.ts
var WATCH_FRAME_MAGIC = Uint8Array.from([84, 75, 87, 49]);
var WATCH_FRAME_HEADER_BYTES = 9;
var WATCH_MAX_PATH_BYTES = 16 * 1024;
function decodeTraceKernelWatchEvent(frame) {
  if (frame.byteLength < WATCH_FRAME_HEADER_BYTES || WATCH_FRAME_MAGIC.some((byte, index) => frame[index] !== byte)) {
    throw Object.assign(new Error("EPROTO: invalid TraceKernel watch frame"), {
      code: "EPROTO"
    });
  }
  const type = frame[4];
  if (type !== 1 && type !== 2 && type !== 3 && type !== 4 && type !== 5) {
    throw Object.assign(
      new Error(`EPROTO: invalid TraceKernel watch event type ${type}`),
      { code: "EPROTO" }
    );
  }
  const pathLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength
  ).getUint32(5, true);
  if (pathLength > WATCH_MAX_PATH_BYTES || frame.byteLength !== WATCH_FRAME_HEADER_BYTES + pathLength) {
    throw Object.assign(new Error("EPROTO: invalid TraceKernel watch frame length"), {
      code: "EPROTO"
    });
  }
  return Object.freeze({
    eventType: type === 1 ? "change" : type === 2 || type === 4 || type === 5 ? "rename" : "overflow",
    ...type === 4 ? { entryOperation: "create" } : type === 5 ? { entryOperation: "delete" } : {},
    path: new TextDecoder().decode(frame.subarray(WATCH_FRAME_HEADER_BYTES))
  });
}

// packages/tracekernel/src/transport/wire/protocol.ts
var TRACEKERNEL_SYSCALL_WIRE_VERSION = 1;
var FRAME_MAGIC = 1414222592 | TRACEKERNEL_SYSCALL_WIRE_VERSION;
var FRAME_REQUEST = 1;
var FRAME_RESPONSE = 2;
var TRACEKERNEL_SYSCALL_OPERATION_CODES = Object.freeze({
  open: 1,
  read: 2,
  write: 3,
  close: 4,
  dup: 5,
  stat: 6,
  readdir: 7,
  mkdir: 8,
  rmdir: 9,
  unlink: 10,
  rename: 11,
  readFile: 12,
  writeFile: 13,
  fstat: 14,
  ftruncate: 15,
  link: 16,
  symlink: 17,
  readlink: 18,
  lstat: 19,
  realpath: 20,
  socket: 21,
  bind: 22,
  listen: 23,
  accept: 24,
  connect: 25,
  send: 26,
  recv: 27,
  shutdown: 28,
  getsockname: 29,
  getpeername: 30,
  pipe: 31,
  spawn: 32,
  wait: 33,
  kill: 34,
  watch: 35,
  watchdog: 36,
  dup2: 37,
  fcntl: 38,
  setsid: 39,
  setpgid: 40,
  dup3: 41,
  poll: 42,
  getsockopt: 43,
  identity: 44,
  isatty: 45,
  tcgetpgrp: 46,
  tcsetpgrp: 47,
  seek: 48,
  processInfo: 49,
  processList: 50,
  environment: 51,
  tcgetwinsize: 52,
  tcsetwinsize: 53
});
var OP_CODES = TRACEKERNEL_SYSCALL_OPERATION_CODES;
var OPERATIONS_BY_CODE = new Map(
  Object.entries(OP_CODES).map(([operation, code]) => [
    code,
    operation
  ])
);
var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder("utf-8", { fatal: true });
var SYSCALL_ERROR_CODES = /* @__PURE__ */ new Set([
  "E2BIG",
  "EAGAIN",
  "EADDRINUSE",
  "EACCES",
  "EAFNOSUPPORT",
  "EALREADY",
  "EBADF",
  "EBUSY",
  "ECHILD",
  "ELOOP",
  "ENAMETOOLONG",
  "EMFILE",
  "EEXIST",
  "ECONNREFUSED",
  "EDESTADDRREQ",
  "EINPROGRESS",
  "EISCONN",
  "EISDIR",
  "EINVAL",
  "EIO",
  "ENOENT",
  "ENOSYS",
  "ENOTDIR",
  "ENOTCONN",
  "ENOTEMPTY",
  "ENOTTY",
  "EPERM",
  "EPIPE",
  "EPROTO",
  "EOPNOTSUPP",
  "EROFS",
  "ESRCH"
]);
var TraceKernelTransportError = class extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
  name = "TraceKernelTransportError";
};
var BinaryFrameWriter = class {
  bytes = new Uint8Array(256);
  view = new DataView(this.bytes.buffer);
  offset = 0;
  u8(value) {
    this.ensure(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }
  u32(value) {
    this.ensure(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }
  i32(value) {
    this.ensure(4);
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }
  f64(value) {
    this.ensure(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }
  string(value) {
    this.byteArray(textEncoder.encode(value));
  }
  byteArray(value) {
    this.u32(value.byteLength);
    this.ensure(value.byteLength);
    this.bytes.set(value, this.offset);
    this.offset += value.byteLength;
  }
  finish() {
    return this.bytes.slice(0, this.offset);
  }
  ensure(additionalBytes) {
    const required = this.offset + additionalBytes;
    if (required <= this.bytes.byteLength) return;
    let capacity = this.bytes.byteLength;
    while (capacity < required) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.bytes);
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }
};
var BinaryFrameReader = class {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  view;
  offset = 0;
  u8() {
    this.ensure(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }
  u32() {
    this.ensure(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }
  i32() {
    this.ensure(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }
  f64() {
    this.ensure(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }
  string() {
    return textDecoder.decode(this.byteArray());
  }
  byteArray() {
    const length = this.u32();
    this.ensure(length);
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  done() {
    if (this.offset !== this.bytes.byteLength) {
      throw new TraceKernelTransportError(
        "EPROTO",
        `binary frame contains ${this.bytes.byteLength - this.offset} trailing bytes`
      );
    }
  }
  ensure(length) {
    if (length < 0 || this.offset + length > this.bytes.byteLength) {
      throw new TraceKernelTransportError("EPROTO", "truncated binary syscall frame");
    }
  }
};
function writeFramePrefix(writer, kind) {
  writer.u32(FRAME_MAGIC);
  writer.u8(kind);
}
function readFramePrefix(reader, expectedKind) {
  if (reader.u32() !== FRAME_MAGIC || reader.u8() !== expectedKind) {
    throw new TraceKernelTransportError("EPROTO", "invalid binary syscall frame header");
  }
}
function writeOperation(writer, operation) {
  writer.u8(OP_CODES[operation]);
}
function readOperation(reader) {
  const code = reader.u8();
  const operation = OPERATIONS_BY_CODE.get(code);
  if (!operation) {
    throw new TraceKernelTransportError("EPROTO", `unknown syscall operation code ${code}`);
  }
  return operation;
}

// packages/tracekernel/src/transport/wire/filesystem-codec.ts
function readStat(reader) {
  const path = reader.string();
  const kindCode = reader.u8();
  if (kindCode !== 1 && kindCode !== 2 && kindCode !== 3) {
    throw new TraceKernelTransportError(
      "EPROTO",
      `invalid stat kind ${kindCode}`
    );
  }
  return Object.freeze({
    path,
    kind: kindCode === 1 ? "file" : kindCode === 2 ? "directory" : "symlink",
    inode: reader.f64(),
    nlink: reader.f64(),
    mode: reader.u32(),
    size: reader.f64(),
    generation: reader.f64(),
    createdAt: reader.f64(),
    modifiedAt: reader.f64(),
    changedAt: reader.f64()
  });
}
function encodeFilesystemRequest(writer, request) {
  switch (request.op) {
    case "open": {
      writer.string(request.path);
      const access = request.options?.access === "write" ? 2 : request.options?.access === "read-write" ? 3 : request.options?.access === "read" ? 1 : 0;
      writer.u8(access);
      writer.u8(
        (request.options?.create ? 1 : 0) | (request.options?.exclusive ? 2 : 0) | (request.options?.truncate ? 4 : 0) | (request.options?.append ? 8 : 0)
      );
      break;
    }
    case "read":
      writer.i32(request.fd);
      writer.u32(request.maxBytes);
      writer.u8(request.position === void 0 ? 0 : 1);
      if (request.position !== void 0) writer.f64(request.position);
      break;
    case "write":
      writer.i32(request.fd);
      writer.byteArray(request.bytes);
      writer.u8(request.position === void 0 ? 0 : 1);
      if (request.position !== void 0) writer.f64(request.position);
      break;
    case "seek":
      writer.i32(request.fd);
      writer.f64(request.offset);
      writer.u8(
        request.whence === "set" ? 1 : request.whence === "current" ? 2 : 3
      );
      break;
    case "close":
    case "dup":
    case "fstat":
      writer.i32(request.fd);
      break;
    case "dup2":
      writer.i32(request.fd);
      writer.i32(request.targetFd);
      break;
    case "dup3":
      writer.i32(request.fd);
      writer.i32(request.targetFd);
      writer.u8(request.closeOnExec ? 1 : 0);
      break;
    case "fcntl":
      writer.i32(request.fd);
      writer.u8(
        request.action === "get-close-on-exec" ? 1 : request.action === "set-close-on-exec" ? 2 : request.action === "get-nonblocking" ? 3 : 4
      );
      if (request.action === "set-close-on-exec") {
        writer.u8(request.closeOnExec ? 1 : 0);
      } else if (request.action === "set-nonblocking") {
        writer.u8(request.nonblocking ? 1 : 0);
      }
      break;
    case "ftruncate":
      writer.i32(request.fd);
      writer.f64(request.length);
      break;
    case "stat":
    case "lstat":
    case "realpath":
    case "readdir":
    case "rmdir":
    case "unlink":
    case "readFile":
      writer.string(request.path);
      break;
    case "mkdir":
      writer.string(request.path);
      writer.u8(
        (request.options?.recursive ? 1 : 0) | (request.options?.mode === void 0 ? 0 : 2)
      );
      if (request.options?.mode !== void 0) writer.u32(request.options.mode);
      break;
    case "rename":
      writer.string(request.sourcePath);
      writer.string(request.destinationPath);
      break;
    case "link":
      writer.string(request.existingPath);
      writer.string(request.newPath);
      break;
    case "symlink":
      writer.string(request.target);
      writer.string(request.linkPath);
      break;
    case "readlink":
      writer.string(request.path);
      break;
    case "writeFile":
      writer.string(request.path);
      writer.byteArray(request.bytes);
      break;
    default:
      return false;
  }
  return true;
}
function decodeFilesystemResult(reader, operation) {
  let value;
  switch (operation) {
    case "open":
    case "dup":
    case "dup2":
      value = { op: operation, fd: reader.i32() };
      break;
    case "dup3": {
      const fd2 = reader.i32();
      const closeOnExec = reader.u8();
      if (closeOnExec > 1) {
        throw new TraceKernelTransportError(
          "EPROTO",
          "Invalid dup3 close-on-exec result"
        );
      }
      value = { op: "dup3", fd: fd2, closeOnExec: closeOnExec === 1 };
      break;
    }
    case "fcntl": {
      const closeOnExec = reader.u8();
      const nonblocking = reader.u8();
      if (closeOnExec > 1 || nonblocking > 1) {
        throw new TraceKernelTransportError(
          "EPROTO",
          `invalid descriptor flag result ${closeOnExec}:${nonblocking}`
        );
      }
      value = {
        op: "fcntl",
        closeOnExec: closeOnExec === 1,
        nonblocking: nonblocking === 1
      };
      break;
    }
    case "read":
      value = { op: "read", bytes: reader.byteArray() };
      break;
    case "write":
      value = { op: "write", bytesWritten: reader.u32() };
      break;
    case "seek":
      value = { op: "seek", offset: reader.f64() };
      break;
    case "stat":
      value = { op: "stat", stat: readStat(reader) };
      break;
    case "lstat":
      value = { op: "lstat", stat: readStat(reader) };
      break;
    case "fstat":
      value = { op: "fstat", stat: readStat(reader) };
      break;
    case "realpath":
      value = { op: "realpath", path: reader.string() };
      break;
    case "readlink":
      value = { op: "readlink", target: reader.string() };
      break;
    case "readdir": {
      const length = reader.u32();
      const entries = [];
      for (let index = 0; index < length; index += 1) {
        const name = reader.string();
        const kindCode = reader.u8();
        if (kindCode !== 1 && kindCode !== 2 && kindCode !== 3) {
          throw new TraceKernelTransportError("EPROTO", `invalid directory entry kind ${kindCode}`);
        }
        entries.push(Object.freeze({
          name,
          kind: kindCode === 1 ? "file" : kindCode === 2 ? "directory" : "symlink",
          inode: reader.f64()
        }));
      }
      value = { op: "readdir", entries: Object.freeze(entries) };
      break;
    }
    case "readFile":
      value = {
        op: "readFile",
        cacheGeneration: reader.i32(),
        bytes: reader.byteArray()
      };
      break;
    case "close":
    case "mkdir":
    case "rmdir":
    case "unlink":
    case "link":
    case "symlink":
    case "rename":
    case "writeFile":
    case "ftruncate":
      value = { op: operation };
      break;
    default:
      return void 0;
  }
  return value;
}

// packages/tracekernel/src/transport/wire/network-codec.ts
var SOCKET_ERROR_CODES = /* @__PURE__ */ new Set([
  "EADDRINUSE",
  "EAFNOSUPPORT",
  "EALREADY",
  "EBADF",
  "ECONNREFUSED",
  "EDESTADDRREQ",
  "EINPROGRESS",
  "EISCONN",
  "EINVAL",
  "ENOTCONN",
  "EOPNOTSUPP"
]);
function writeAddress(writer, address) {
  writer.string(address.host);
  writer.u32(address.port);
}
function readAddress(reader) {
  return Object.freeze({
    host: reader.string(),
    port: reader.u32()
  });
}
function encodeNetworkRequest(writer, request) {
  switch (request.op) {
    case "socket":
      break;
    case "bind":
    case "connect":
      writer.i32(request.fd);
      writeAddress(writer, request.address);
      break;
    case "listen":
      writer.i32(request.fd);
      writer.u8(
        (request.options?.backlog === void 0 ? 0 : 1) | (request.options?.capacityChunks === void 0 ? 0 : 2)
      );
      if (request.options?.backlog !== void 0) writer.u32(request.options.backlog);
      if (request.options?.capacityChunks !== void 0) {
        writer.u32(request.options.capacityChunks);
      }
      break;
    case "accept":
    case "getsockname":
    case "getpeername":
      writer.i32(request.fd);
      break;
    case "getsockopt":
      writer.i32(request.fd);
      writer.u8(request.option === "error" ? 1 : 0);
      break;
    case "send":
      writer.i32(request.fd);
      writer.byteArray(request.bytes);
      break;
    case "recv":
      writer.i32(request.fd);
      writer.u32(request.maxBytes);
      break;
    case "shutdown":
      writer.i32(request.fd);
      writer.u8(request.how === "read" ? 1 : request.how === "write" ? 2 : 3);
      break;
    default:
      return false;
  }
  return true;
}
function decodeNetworkResult(reader, operation) {
  let value;
  switch (operation) {
    case "socket":
      value = { op: operation, fd: reader.i32() };
      break;
    case "bind":
      value = { op: "bind", address: readAddress(reader) };
      break;
    case "accept":
      value = {
        op: "accept",
        fd: reader.i32(),
        localAddress: readAddress(reader),
        remoteAddress: readAddress(reader)
      };
      break;
    case "connect":
      value = {
        op: "connect",
        localAddress: readAddress(reader),
        remoteAddress: readAddress(reader)
      };
      break;
    case "send":
      value = { op: "send", bytesWritten: reader.u32() };
      break;
    case "recv":
      value = { op: "recv", bytes: reader.byteArray() };
      break;
    case "getsockname":
    case "getpeername":
      value = { op: operation, address: readAddress(reader) };
      break;
    case "getsockopt": {
      const hasError = reader.u8();
      if (hasError > 1) {
        throw new TraceKernelTransportError(
          "EPROTO",
          `invalid socket error presence flag ${hasError}`
        );
      }
      const error = hasError === 1 ? reader.string() : void 0;
      if (error !== void 0 && !SOCKET_ERROR_CODES.has(error)) {
        throw new TraceKernelTransportError(
          "EPROTO",
          `invalid socket error code ${JSON.stringify(error)}`
        );
      }
      value = {
        op: "getsockopt",
        ...error === void 0 ? {} : { error }
      };
      break;
    }
    case "listen":
    case "shutdown":
      value = { op: operation };
      break;
    default:
      return void 0;
  }
  return value;
}

// packages/tracekernel/src/transport/wire/process-codec.ts
function traceKernelSignalCode(signal) {
  switch (signal) {
    case "SIGINT":
      return 1;
    case "SIGTERM":
      return 2;
    case "SIGKILL":
      return 3;
    case "SIGHUP":
      return 4;
    case "SIGQUIT":
      return 5;
    case "SIGWINCH":
      return 6;
  }
}
function readTraceKernelSignal(reader, context) {
  const code = reader.u8();
  switch (code) {
    case 1:
      return "SIGINT";
    case 2:
      return "SIGTERM";
    case 3:
      return "SIGKILL";
    case 4:
      return "SIGHUP";
    case 5:
      return "SIGQUIT";
    case 6:
      return "SIGWINCH";
    default:
      throw new TraceKernelTransportError(
        "EPROTO",
        `invalid ${context} signal code ${code}`
      );
  }
}
function readTraceKernelTerminatingSignal(reader, context) {
  const signal = readTraceKernelSignal(reader, context);
  if (signal === "SIGWINCH") {
    throw new TraceKernelTransportError(
      "EPROTO",
      `${context} cannot use non-terminating signal SIGWINCH.`
    );
  }
  return signal;
}
function readProcessPhase(reader) {
  const code = reader.u8();
  if (code < 1 || code > 5) {
    throw new TraceKernelTransportError(
      "EPROTO",
      `invalid process phase code ${code}`
    );
  }
  return code === 1 ? "created" : code === 2 ? "starting" : code === 3 ? "running" : code === 4 ? "exiting" : "exited";
}
function readProcessInfo(reader) {
  const pid = reader.i32();
  const ppid = reader.i32();
  const pgid = reader.i32();
  const sid = reader.i32();
  const phase = readProcessPhase(reader);
  const runtime = reader.string();
  const command = reader.string();
  const argumentCount = reader.u32();
  const args = [];
  for (let index = 0; index < argumentCount; index += 1) {
    args.push(reader.string());
  }
  const hasStartedAt = reader.u8();
  if (hasStartedAt > 1) {
    throw new TraceKernelTransportError(
      "EPROTO",
      `invalid process start-time flag ${hasStartedAt}`
    );
  }
  return Object.freeze({
    pid,
    ppid,
    pgid,
    sid,
    phase,
    runtime,
    command,
    args: Object.freeze(args),
    ...hasStartedAt ? { startedAt: reader.f64() } : {}
  });
}
function writeSpawnStdioMode(writer, mode) {
  writer.u8(
    mode === void 0 ? 0 : mode === "pipe" ? 1 : mode === "inherit" ? 2 : 3
  );
}
function encodeProcessRequest(writer, request) {
  switch (request.op) {
    case "pipe":
      writer.u32(request.options?.capacityChunks ?? 0);
      writer.u8(request.options?.closeOnExec === true ? 1 : 0);
      writer.u8(request.options?.nonblocking === true ? 1 : 0);
      break;
    case "watch":
      writer.string(request.path);
      writer.u8(request.options?.recursive === true ? 1 : 0);
      writer.u32(request.options?.capacityEvents ?? 0);
      break;
    case "watchdog":
      writer.u8(
        request.action === "arm" ? 1 : request.action === "pet" ? 2 : request.action === "disarm" ? 3 : 4
      );
      writer.u8(request.timeoutMs === void 0 ? 0 : 1);
      if (request.timeoutMs !== void 0) writer.u32(request.timeoutMs);
      writer.u8(
        request.signal === void 0 ? 0 : request.signal === "SIGTERM" ? 1 : 2
      );
      break;
    case "spawn": {
      writer.string(request.runtime);
      writer.string(request.command);
      writer.u32(request.args?.length ?? 0);
      for (const arg of request.args ?? []) writer.string(arg);
      writer.u8(request.cwd === void 0 ? 0 : 1);
      if (request.cwd !== void 0) writer.string(request.cwd);
      const environment = Object.entries(request.env ?? {});
      writer.u32(environment.length);
      for (const [name, value] of environment) {
        writer.string(name);
        writer.string(value);
      }
      writer.u8(
        request.inheritDescriptors === "all" ? 1 : request.inheritDescriptors === void 0 ? 0 : 2
      );
      if (request.inheritDescriptors !== void 0 && request.inheritDescriptors !== "all") {
        writer.u32(request.inheritDescriptors.length);
        for (const fd2 of request.inheritDescriptors) writer.i32(fd2);
      }
      writer.u8(request.processGroupId === void 0 ? 0 : 1);
      if (request.processGroupId !== void 0) writer.i32(request.processGroupId);
      writer.u8(request.sessionId === void 0 ? 0 : 1);
      if (request.sessionId !== void 0) writer.i32(request.sessionId);
      writeSpawnStdioMode(writer, request.stdio?.stdin);
      writeSpawnStdioMode(writer, request.stdio?.stdout);
      writeSpawnStdioMode(writer, request.stdio?.stderr);
      writer.u32(request.descriptorActions?.length ?? 0);
      for (const action of request.descriptorActions ?? []) {
        writer.u8(action.op === "dup2" ? 1 : 2);
        writer.i32(action.fd);
        if (action.op === "dup2") writer.i32(action.targetFd);
      }
      writer.u32(request.descriptorMappings?.length ?? 0);
      for (const mapping of request.descriptorMappings ?? []) {
        writer.i32(mapping.parentFd);
        writer.i32(mapping.childFd);
      }
      break;
    }
    case "wait":
      writer.i32(request.pid);
      writer.u8(request.noHang ? 1 : 0);
      break;
    case "identity":
    case "processInfo":
      writer.u8(request.pid === void 0 ? 0 : 1);
      if (request.pid !== void 0) writer.i32(request.pid);
      break;
    case "processList":
    case "environment":
      break;
    case "kill":
      writer.i32(request.pid);
      writer.u8(traceKernelSignalCode(request.signal));
      break;
    case "setsid":
      break;
    case "setpgid":
      writer.i32(request.pid);
      writer.i32(request.pgid);
      break;
    case "isatty":
    case "tcgetpgrp":
    case "tcgetwinsize":
      writer.i32(request.fd);
      break;
    case "tcsetpgrp":
      writer.i32(request.fd);
      writer.i32(request.pgid);
      break;
    case "tcsetwinsize":
      writer.i32(request.fd);
      writer.u32(request.rows);
      writer.u32(request.columns);
      break;
    case "poll":
      writer.u32(request.entries.length);
      for (const entry of request.entries) {
        writer.i32(entry.fd);
        writer.u8((entry.read ? 1 : 0) | (entry.write ? 2 : 0));
      }
      writer.u8(request.timeoutMs === void 0 ? 0 : 1);
      if (request.timeoutMs !== void 0) writer.f64(request.timeoutMs);
      break;
    default:
      return false;
  }
  return true;
}
function decodeProcessResult(reader, operation) {
  let value;
  switch (operation) {
    case "pipe":
      value = {
        op: "pipe",
        readFd: reader.i32(),
        writeFd: reader.i32()
      };
      break;
    case "watch":
      value = { op: "watch", fd: reader.i32() };
      break;
    case "watchdog": {
      const armed = reader.u8();
      if (armed > 1) {
        throw new TraceKernelTransportError(
          "EPROTO",
          `invalid watchdog armed flag ${armed}`
        );
      }
      if (!armed) {
        value = { op: "watchdog", armed: false };
        break;
      }
      const timeoutMs = reader.u32();
      const deadlineAt = reader.f64();
      const signalCode = reader.u8();
      if (signalCode !== 1 && signalCode !== 2) {
        throw new TraceKernelTransportError(
          "EPROTO",
          `invalid watchdog response signal ${signalCode}`
        );
      }
      value = {
        op: "watchdog",
        armed: true,
        timeoutMs,
        deadlineAt,
        signal: signalCode === 2 ? "SIGKILL" : "SIGTERM"
      };
      break;
    }
    case "spawn": {
      const pid = reader.i32();
      const hasStdin = reader.u8();
      if (hasStdin > 1) {
        throw new TraceKernelTransportError("EPROTO", `invalid spawn stdin fd flag ${hasStdin}`);
      }
      const stdinFd = hasStdin ? reader.i32() : void 0;
      const hasStdout = reader.u8();
      if (hasStdout > 1) {
        throw new TraceKernelTransportError("EPROTO", `invalid spawn stdout fd flag ${hasStdout}`);
      }
      const stdoutFd = hasStdout ? reader.i32() : void 0;
      const hasStderr = reader.u8();
      if (hasStderr > 1) {
        throw new TraceKernelTransportError("EPROTO", `invalid spawn stderr fd flag ${hasStderr}`);
      }
      const stderrFd = hasStderr ? reader.i32() : void 0;
      const stdio = stdinFd === void 0 && stdoutFd === void 0 && stderrFd === void 0 ? void 0 : Object.freeze({
        ...stdinFd === void 0 ? {} : { stdinFd },
        ...stdoutFd === void 0 ? {} : { stdoutFd },
        ...stderrFd === void 0 ? {} : { stderrFd }
      });
      value = {
        op: "spawn",
        pid,
        ...stdio === void 0 ? {} : { stdio }
      };
      break;
    }
    case "wait": {
      const pid = reader.i32();
      const completed = reader.u8();
      if (completed > 1) {
        throw new TraceKernelTransportError(
          "EPROTO",
          `invalid wait completion flag ${completed}`
        );
      }
      if (!completed) {
        value = { op: "wait", pid };
        break;
      }
      const terminationCode = reader.u8();
      if (terminationCode < 1 || terminationCode > 3) {
        throw new TraceKernelTransportError(
          "EPROTO",
          `invalid process termination code ${terminationCode}`
        );
      }
      const exitCode = reader.i32();
      if (terminationCode === 1) {
        value = {
          op: "wait",
          pid,
          termination: { kind: "exit", exitCode }
        };
      } else if (terminationCode === 2) {
        value = {
          op: "wait",
          pid,
          termination: {
            kind: "signal",
            signal: readTraceKernelTerminatingSignal(reader, "termination"),
            exitCode
          }
        };
      } else {
        value = {
          op: "wait",
          pid,
          termination: {
            kind: "failure",
            exitCode,
            message: reader.string()
          }
        };
      }
      break;
    }
    case "poll": {
      const length = reader.u32();
      const entries = [];
      for (let index = 0; index < length; index += 1) {
        const fd2 = reader.i32();
        const events = reader.u8();
        if ((events & ~31) !== 0) {
          throw new TraceKernelTransportError(
            "EPROTO",
            `invalid poll result mask ${events}`
          );
        }
        entries.push({
          fd: fd2,
          read: (events & 1) !== 0,
          write: (events & 2) !== 0,
          hangup: (events & 4) !== 0,
          error: (events & 8) !== 0,
          invalid: (events & 16) !== 0
        });
      }
      value = { op: "poll", entries };
      break;
    }
    case "setsid":
      value = { op: "setsid", sid: reader.i32(), pgid: reader.i32() };
      break;
    case "setpgid":
      value = { op: "setpgid", pgid: reader.i32() };
      break;
    case "isatty": {
      const isTerminal = reader.u8();
      if (isTerminal > 1) {
        throw new TraceKernelTransportError(
          "EPROTO",
          `invalid isatty result ${isTerminal}`
        );
      }
      value = { op: "isatty", isTerminal: isTerminal === 1 };
      break;
    }
    case "tcgetpgrp":
    case "tcsetpgrp":
      value = { op: operation, pgid: reader.i32() };
      break;
    case "tcgetwinsize":
    case "tcsetwinsize":
      value = {
        op: operation,
        rows: reader.u32(),
        columns: reader.u32()
      };
      break;
    case "identity":
      value = {
        op: "identity",
        pid: reader.i32(),
        ppid: reader.i32(),
        pgid: reader.i32(),
        sid: reader.i32()
      };
      break;
    case "processInfo":
      value = {
        op: "processInfo",
        process: readProcessInfo(reader)
      };
      break;
    case "processList": {
      const processCount = reader.u32();
      const processes = [];
      for (let index = 0; index < processCount; index += 1) {
        processes.push(readProcessInfo(reader));
      }
      value = {
        op: "processList",
        processes: Object.freeze(processes)
      };
      break;
    }
    case "environment": {
      const entryCount = reader.u32();
      const env = {};
      for (let index = 0; index < entryCount; index += 1) {
        env[reader.string()] = reader.string();
      }
      value = {
        op: "environment",
        env: Object.freeze(env)
      };
      break;
    }
    case "kill":
      value = { op: operation };
      break;
    default:
      return void 0;
  }
  return value;
}

// packages/tracekernel/src/transport/wire.ts
function encodeTraceKernelSyscallRequest(request) {
  const writer = new BinaryFrameWriter();
  writeFramePrefix(writer, FRAME_REQUEST);
  writeOperation(writer, request.op);
  if (!encodeProcessRequest(writer, request) && !encodeNetworkRequest(writer, request) && !encodeFilesystemRequest(writer, request)) {
    throw new TraceKernelTransportError(
      "ENOSYS",
      `cannot encode unknown syscall request ${JSON.stringify(request)}`
    );
  }
  return writer.finish();
}
function decodeTraceKernelSyscallResult(bytes) {
  const reader = new BinaryFrameReader(bytes);
  readFramePrefix(reader, FRAME_RESPONSE);
  const success = reader.u8();
  if (success > 1) {
    throw new TraceKernelTransportError(
      "EPROTO",
      `invalid syscall result status ${success}`
    );
  }
  if (success === 0) {
    const code = reader.string();
    if (!SYSCALL_ERROR_CODES.has(code)) {
      throw new TraceKernelTransportError(
        "EPROTO",
        `unknown syscall error code ${code}`
      );
    }
    const result = {
      ok: false,
      error: {
        code,
        message: reader.string()
      }
    };
    reader.done();
    return result;
  }
  const operation = readOperation(reader);
  const value = decodeProcessResult(reader, operation) ?? decodeNetworkResult(reader, operation) ?? decodeFilesystemResult(reader, operation);
  if (value === void 0) {
    throw new TraceKernelTransportError(
      "ENOSYS",
      `cannot decode unsupported syscall result ${operation}`
    );
  }
  reader.done();
  return { ok: true, value };
}

// packages/tracekernel/src/transport/shared-channel.ts
var SHARED_HEADER_INTS = 8;
var SHARED_HEADER_BYTES = SHARED_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
var STATE_INDEX = 0;
var REQUEST_LENGTH_INDEX = 1;
var RESPONSE_LENGTH_INDEX = 2;
var SEQUENCE_INDEX = 3;
var STATE_IDLE = 0;
var STATE_REQUEST = 1;
var STATE_RESPONSE = 3;
var STATE_CLOSED = 4;
var STATE_WRITING = 5;
function validateSharedChannel(channel) {
  if (!(channel.buffer instanceof SharedArrayBuffer) || channel.byteCapacity < 256 || channel.buffer.byteLength !== SHARED_HEADER_BYTES + channel.byteCapacity) {
    throw new TraceKernelTransportError("EPROTO", "invalid shared syscall channel");
  }
  return {
    header: new Int32Array(channel.buffer, 0, SHARED_HEADER_INTS),
    payload: new Uint8Array(channel.buffer, SHARED_HEADER_BYTES)
  };
}
var TraceKernelSharedSyscallClient = class {
  constructor(channel, signalHost, options = {}) {
    this.channel = channel;
    this.signalHost = signalHost;
    const views = validateSharedChannel(channel);
    this.header = views.header;
    this.payload = views.payload;
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 2e4));
  }
  header;
  payload;
  timeoutMs;
  closed = false;
  callCount = 0;
  get calls() {
    return this.callCount;
  }
  dispatchSync(request) {
    if (this.closed) {
      throw new TraceKernelTransportError("ECLOSED", "shared syscall channel is closed");
    }
    const frame = encodeTraceKernelSyscallRequest(request);
    if (frame.byteLength > this.payload.byteLength) {
      throw new TraceKernelTransportError(
        "E2BIG",
        `request frame requires ${frame.byteLength} bytes; capacity is ${this.payload.byteLength}`
      );
    }
    if (Atomics.compareExchange(
      this.header,
      STATE_INDEX,
      STATE_IDLE,
      STATE_WRITING
    ) !== STATE_IDLE) {
      if (Atomics.load(this.header, STATE_INDEX) === STATE_CLOSED) {
        this.closed = true;
        throw new TraceKernelTransportError("ECLOSED", "shared syscall channel is closed");
      }
      throw new TraceKernelTransportError("EBUSY", "shared syscall channel already has an active call");
    }
    this.payload.set(frame);
    Atomics.store(this.header, REQUEST_LENGTH_INDEX, frame.byteLength);
    Atomics.store(this.header, RESPONSE_LENGTH_INDEX, 0);
    Atomics.add(this.header, SEQUENCE_INDEX, 1);
    Atomics.store(this.header, STATE_INDEX, STATE_REQUEST);
    this.callCount += 1;
    try {
      this.signalHost();
    } catch (error) {
      Atomics.store(this.header, STATE_INDEX, STATE_IDLE);
      throw error;
    }
    const startedAt = Date.now();
    while (true) {
      const state = Atomics.load(this.header, STATE_INDEX);
      if (state === STATE_RESPONSE) break;
      if (state === STATE_CLOSED) {
        this.closed = true;
        throw new TraceKernelTransportError("ECLOSED", "shared syscall channel closed while waiting");
      }
      const remaining = this.timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        this.close();
        throw new TraceKernelTransportError("ETIMEDOUT", "synchronous syscall timed out");
      }
      try {
        Atomics.wait(this.header, STATE_INDEX, state, remaining);
      } catch {
        this.close();
        throw new TraceKernelTransportError(
          "ENOSYS",
          "synchronous Atomics.wait is only available in a dedicated worker"
        );
      }
    }
    const responseLength = Atomics.load(this.header, RESPONSE_LENGTH_INDEX);
    if (responseLength < 0 || responseLength > this.payload.byteLength) {
      this.close();
      throw new TraceKernelTransportError("EPROTO", "host returned an invalid response length");
    }
    const responseFrame = this.payload.slice(0, responseLength);
    Atomics.store(this.header, REQUEST_LENGTH_INDEX, 0);
    Atomics.store(this.header, RESPONSE_LENGTH_INDEX, 0);
    Atomics.store(this.header, STATE_INDEX, STATE_IDLE);
    Atomics.notify(this.header, STATE_INDEX);
    return decodeTraceKernelSyscallResult(responseFrame);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    Atomics.store(this.header, STATE_INDEX, STATE_CLOSED);
    Atomics.notify(this.header, STATE_INDEX);
  }
};

// packages/tracekernel/src/transport/runtime-file-client.ts
var TraceKernelSharedGenerationSource = class {
  generation;
  constructor(buffer) {
    if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== Int32Array.BYTES_PER_ELEMENT) {
      throw new TraceKernelTransportError("EPROTO", "invalid TKFS generation buffer");
    }
    this.generation = new Int32Array(buffer);
  }
  current() {
    return Atomics.load(this.generation, 0);
  }
};
var TraceKernelRuntimeSyscallError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  // Runtime code should observe the same public error identity as a native
  // Node syscall. The concrete bridge class remains available to hosts for
  // `instanceof` checks, but its stack must not expose TraceKernel internals.
  name = "Error";
};
var TraceKernelRuntimeFileClient = class {
  constructor(transport, options = {}) {
    this.transport = transport;
    this.options = options;
    this.maxCacheEntries = Math.max(0, Math.floor(options.maxCacheEntries ?? 256));
    this.maxCacheBytes = Math.max(0, Math.floor(options.maxCacheBytes ?? 16 * 1024 * 1024));
  }
  cache = /* @__PURE__ */ new Map();
  maxCacheEntries;
  maxCacheBytes;
  cacheBytes = 0;
  cacheHitCount = 0;
  cacheMissCount = 0;
  get cacheHits() {
    return this.cacheHitCount;
  }
  get cacheMisses() {
    return this.cacheMissCount;
  }
  identity() {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "identity" }),
      "identity"
    );
  }
  isatty(fd2) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "isatty", fd: fd2 }),
      "isatty"
    ).isTerminal;
  }
  tcgetpgrp(fd2) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "tcgetpgrp", fd: fd2 }),
      "tcgetpgrp"
    ).pgid;
  }
  tcsetpgrp(fd2, pgid) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "tcsetpgrp", fd: fd2, pgid }),
      "tcsetpgrp"
    ).pgid;
  }
  tcgetwinsize(fd2) {
    const value = this.expectSuccess(
      this.transport.dispatchSync({ op: "tcgetwinsize", fd: fd2 }),
      "tcgetwinsize"
    );
    return { rows: value.rows, columns: value.columns };
  }
  tcsetwinsize(fd2, rows, columns) {
    const value = this.expectSuccess(
      this.transport.dispatchSync({
        op: "tcsetwinsize",
        fd: fd2,
        rows,
        columns
      }),
      "tcsetwinsize"
    );
    return { rows: value.rows, columns: value.columns };
  }
  socket() {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "socket" }),
      "socket"
    ).fd;
  }
  bind(fd2, address) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "bind", fd: fd2, address }),
      "bind"
    ).address;
  }
  listen(fd2, options) {
    this.expectSuccess(
      this.transport.dispatchSync({ op: "listen", fd: fd2, options }),
      "listen"
    );
  }
  accept(fd2) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "accept", fd: fd2 }),
      "accept"
    );
  }
  connect(fd2, address) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "connect", fd: fd2, address }),
      "connect"
    );
  }
  send(fd2, bytes) {
    return this.expectSuccess(
      this.transport.dispatchSync({
        op: "send",
        fd: fd2,
        bytes: Uint8Array.from(bytes)
      }),
      "send"
    ).bytesWritten;
  }
  recv(fd2, maxBytes) {
    return Uint8Array.from(this.expectSuccess(
      this.transport.dispatchSync({ op: "recv", fd: fd2, maxBytes }),
      "recv"
    ).bytes);
  }
  shutdown(fd2, how) {
    this.expectSuccess(
      this.transport.dispatchSync({ op: "shutdown", fd: fd2, how }),
      "shutdown"
    );
  }
  getsockname(fd2) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "getsockname", fd: fd2 }),
      "getsockname"
    ).address;
  }
  getpeername(fd2) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "getpeername", fd: fd2 }),
      "getpeername"
    ).address;
  }
  socketError(fd2) {
    return this.expectSuccess(
      this.transport.dispatchSync({
        op: "getsockopt",
        fd: fd2,
        option: "error"
      }),
      "getsockopt"
    ).error;
  }
  open(path, options) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "open", path, options }),
      "open"
    ).fd;
  }
  read(fd2, maxBytes, position) {
    return Uint8Array.from(this.expectSuccess(
      this.transport.dispatchSync({
        op: "read",
        fd: fd2,
        maxBytes,
        ...position === void 0 ? {} : { position }
      }),
      "read"
    ).bytes);
  }
  write(fd2, bytes, position) {
    return this.expectSuccess(
      this.transport.dispatchSync({
        op: "write",
        fd: fd2,
        bytes: Uint8Array.from(bytes),
        ...position === void 0 ? {} : { position }
      }),
      "write"
    ).bytesWritten;
  }
  seek(fd2, offset, whence) {
    return this.expectSuccess(
      this.transport.dispatchSync({
        op: "seek",
        fd: fd2,
        offset,
        whence
      }),
      "seek"
    ).offset;
  }
  closeDescriptor(fd2) {
    this.expectSuccess(
      this.transport.dispatchSync({ op: "close", fd: fd2 }),
      "close"
    );
  }
  dup(fd2) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "dup", fd: fd2 }),
      "dup"
    ).fd;
  }
  dup2(fd2, targetFd) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "dup2", fd: fd2, targetFd }),
      "dup2"
    ).fd;
  }
  getCloseOnExec(fd2) {
    return this.expectSuccess(
      this.transport.dispatchSync({
        op: "fcntl",
        fd: fd2,
        action: "get-close-on-exec"
      }),
      "fcntl"
    ).closeOnExec;
  }
  setCloseOnExec(fd2, closeOnExec) {
    this.expectSuccess(
      this.transport.dispatchSync({
        op: "fcntl",
        fd: fd2,
        action: "set-close-on-exec",
        closeOnExec
      }),
      "fcntl"
    );
  }
  fstat(fd2) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "fstat", fd: fd2 }),
      "fstat"
    ).stat;
  }
  ftruncate(fd2, length) {
    this.expectSuccess(
      this.transport.dispatchSync({ op: "ftruncate", fd: fd2, length }),
      "ftruncate"
    );
  }
  readFile(path) {
    const generation = this.options.generation?.current();
    const cached = this.cache.get(path);
    if (generation !== void 0 && cached?.generation === generation) {
      this.cache.delete(path);
      this.cache.set(path, cached);
      this.cacheHitCount += 1;
      return Uint8Array.from(cached.bytes);
    }
    this.cacheMissCount += 1;
    const result = this.transport.dispatchSync({ op: "readFile", path });
    const value = this.expectSuccess(result, "readFile");
    const bytes = Uint8Array.from(value.bytes);
    if (this.options.generation && this.options.generation.current() === value.cacheGeneration) {
      this.cacheRead(path, value.cacheGeneration, bytes);
    }
    return Uint8Array.from(bytes);
  }
  writeFile(path, bytes) {
    const result = this.transport.dispatchSync({
      op: "writeFile",
      path,
      bytes: Uint8Array.from(bytes)
    });
    this.expectSuccess(result, "writeFile");
    this.removeCached(path);
  }
  stat(path) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "stat", path }),
      "stat"
    ).stat;
  }
  lstat(path) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "lstat", path }),
      "lstat"
    ).stat;
  }
  realpath(path) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "realpath", path }),
      "realpath"
    ).path;
  }
  readdir(path) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "readdir", path }),
      "readdir"
    ).entries;
  }
  mkdir(path, options) {
    this.expectSuccess(
      this.transport.dispatchSync({ op: "mkdir", path, options }),
      "mkdir"
    );
  }
  rmdir(path) {
    this.expectSuccess(
      this.transport.dispatchSync({ op: "rmdir", path }),
      "rmdir"
    );
  }
  unlink(path) {
    this.expectSuccess(
      this.transport.dispatchSync({ op: "unlink", path }),
      "unlink"
    );
    this.removeCached(path);
  }
  link(existingPath, newPath) {
    this.expectSuccess(
      this.transport.dispatchSync({ op: "link", existingPath, newPath }),
      "link"
    );
    this.removeCached(newPath);
  }
  symlink(target, linkPath) {
    this.expectSuccess(
      this.transport.dispatchSync({ op: "symlink", target, linkPath }),
      "symlink"
    );
    this.removeCached(linkPath);
  }
  readlink(path) {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: "readlink", path }),
      "readlink"
    ).target;
  }
  rename(sourcePath, destinationPath) {
    this.expectSuccess(
      this.transport.dispatchSync({
        op: "rename",
        sourcePath,
        destinationPath
      }),
      "rename"
    );
    this.removeCached(sourcePath);
    this.removeCached(destinationPath);
  }
  clearCache() {
    this.cache.clear();
    this.cacheBytes = 0;
  }
  expectSuccess(result, operation) {
    if (!result.ok) {
      throw new TraceKernelRuntimeSyscallError(result.error.code, result.error.message);
    }
    if (result.value.op !== operation) {
      throw new TraceKernelTransportError(
        "EPROTO",
        `expected ${operation} response, received ${result.value.op}`
      );
    }
    return result.value;
  }
  cacheRead(path, generation, bytes) {
    if (this.maxCacheEntries === 0 || this.maxCacheBytes === 0 || bytes.byteLength > this.maxCacheBytes) {
      return;
    }
    this.removeCached(path);
    while (this.cache.size >= this.maxCacheEntries || this.cacheBytes + bytes.byteLength > this.maxCacheBytes) {
      const oldest = this.cache.keys().next().value;
      if (oldest === void 0) break;
      this.removeCached(oldest);
    }
    const stored = Uint8Array.from(bytes);
    this.cache.set(path, { generation, bytes: stored });
    this.cacheBytes += stored.byteLength;
  }
  removeCached(path) {
    const cached = this.cache.get(path);
    if (!cached) return;
    this.cache.delete(path);
    this.cacheBytes -= cached.bytes.byteLength;
  }
};

// package.json
var package_default = {
  name: "@tracecode/harness",
  version: "0.17.0",
  license: "AGPL-3.0-only",
  homepage: "https://tracecode.app",
  repository: {
    type: "git",
    url: "https://github.com/tracecodeapp/harness.git"
  },
  publishConfig: {
    access: "public"
  },
  packageManager: "pnpm@10.4.1",
  type: "module",
  files: [
    "dist",
    "!dist/**/*.map",
    "workers",
    "runtime-assets.lock.json",
    "!workers/java/.build",
    "!workers/java/.build/**",
    "!workers/java/src",
    "!workers/java/src/**",
    "!workers/javascript/javascript-libraries-entry.js",
    "!workers/vendor/csharp/.stamp",
    "!workers/vendor/csharp-compiler",
    "!workers/vendor/csharp-compiler/**",
    "!workers/vendor/csharp-role-artifacts",
    "!workers/vendor/csharp-role-artifacts/**",
    "!workers/vendor/java-rewriter.jar",
    "!workers/vendor/javaparser-core-3.25.10.jar",
    "!workers/vendor/jdk.compiler-17.jar",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md"
  ],
  bin: {
    "tracecode-harness": "./dist/cli.cjs"
  },
  browser: {
    zlib: "./dist/zlib-browser-shim.js",
    "node:zlib": "./dist/zlib-browser-shim.js"
  },
  exports: {
    "./tracekernel": {
      types: "./dist/tracekernel.d.ts",
      import: "./dist/tracekernel.js",
      require: "./dist/tracekernel.cjs",
      default: "./dist/tracekernel.js"
    },
    "./judge": {
      types: "./dist/judge.d.ts",
      import: "./dist/judge.js",
      require: "./dist/judge.cjs",
      default: "./dist/judge.js"
    },
    "./package.json": "./package.json"
  },
  scripts: {
    prepublishOnly: "pnpm release:check && pnpm test:runtime-assets-lock && pnpm build && pnpm release:check && pnpm test:runtime-assets-lock",
    "release:check": "node scripts/check-publish-safety.mjs",
    "release:root": "pnpm release:check && pnpm publish . --access public",
    "version:sync": "node scripts/sync-workspace-versions.mjs",
    "version:check": "node scripts/sync-workspace-versions.mjs --check",
    build: "pnpm generate:runtime-info && pnpm generate:python-harness && pnpm generate:kernel-policy && pnpm generate:typescript-project-libs && pnpm generate:javascript-project-worker && pnpm generate:tracekernel-syscall-client && pnpm generate:tracekernel-local-java-host && pnpm generate:java-helper && pnpm sync:package-assets && pnpm generate:runtime-assets-lock && pnpm generate:runtime-open-source-info && pnpm build:tracekernel && pnpm exec tsup --config tsup.runtime-contracts.config.ts && pnpm build:browser-host && pnpm exec tsup && pnpm rewrite:root-declarations && pnpm --dir packages/judge build",
    "rewrite:root-declarations": "node scripts/rewrite-root-declaration-imports.mjs",
    "build:browser-host": "pnpm exec tsup --config tsup.browser-host.config.ts",
    "build:tracekernel": "pnpm exec tsup --config tsup.tracekernel.config.ts",
    "generate:runtime-info": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/generate-runtime-language-info.ts",
    "generate:traceclr-profile": "node scripts/generate-traceclr-algorithm-profile.mjs",
    "audit:traceclr-corpus": "node scripts/audit-traceclr-corpus.mjs",
    "build:traceclr-product-corpus": "node scripts/create-traceclr-product-corpus.mjs",
    "check:traceclr-profile": "node --test tests/test-traceclr-algorithm-profile.mjs tests/test-traceclr-profile-policy.mjs && node --import tsx tests/test-traceclr-wire-codec.ts",
    "check:traceclr-product-profile": "node scripts/generate-traceclr-algorithm-profile.mjs --check && pnpm check:traceclr-profile",
    "build:traceclr-wire-probe": "dotnet build tools/TraceCode.TraceClrWireProbe/TraceCode.TraceClrWireProbe.csproj -c Release && dotnet build tools/TraceCode.TraceClrHostileProbe/TraceCode.TraceClrHostileProbe.csproj -c Release && dotnet publish packages/runtime-csharp/dotnet/TraceCode.CSharpAlgorithmRunner/TraceCode.CSharpAlgorithmRunner.csproj -c Release",
    "test:traceclr-wire-browser": "pnpm build:traceclr-wire-probe && TRACECODE_TRACECLR_BROWSER_ENGINE=chromium node --import tsx tests/test-traceclr-wire-runner-browser.ts && TRACECODE_TRACECLR_BROWSER_ENGINE=firefox node --import tsx tests/test-traceclr-wire-runner-browser.ts && TRACECODE_TRACECLR_BROWSER_ENGINE=webkit node --import tsx tests/test-traceclr-wire-runner-browser.ts",
    "bench:traceclr-tiers": "pnpm build:traceclr-wire-probe && pnpm materialize:csharp-role-assets && node --import tsx scripts/benchmark-traceclr-runtime-tiers.ts",
    "bench:traceclr-tiers:matrix": "pnpm build:traceclr-wire-probe && pnpm materialize:csharp-role-assets && for engine in chromium firefox webkit; do TRACECODE_TRACECLR_BROWSER_ENGINE=$engine node --import tsx scripts/benchmark-traceclr-runtime-tiers.ts || exit; done",
    "generate:runtime-open-source-info": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/generate-runtime-open-source-info.ts",
    "generate:python-harness": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/generate-python-harness-artifacts.ts",
    "build:python-runtime-snapshot": "node --import tsx scripts/build-python-runtime-snapshot.ts",
    "generate:runtime-assets-lock": "node --import tsx scripts/generate-runtime-assets-lock.mjs",
    "generate:typescript-project-libs": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/generate-typescript-project-libs.ts",
    "generate:javascript-project-worker": "pnpm exec esbuild packages/runtime-javascript/src/project-browser-worker.ts --bundle --format=esm --platform=browser --target=es2022 --outfile=workers/javascript/javascript-project-worker.js && node scripts/normalize-generated-worker-paths.mjs workers/javascript/javascript-project-worker.js",
    "generate:tracekernel-syscall-client": "pnpm exec esbuild packages/runtime-java/src/tracekernel-syscall-client-worker.ts --bundle --format=iife --platform=browser --target=es2022 --outfile=workers/shared/tracekernel-syscall-client.js && node scripts/normalize-generated-worker-paths.mjs workers/shared/tracekernel-syscall-client.js",
    "generate:tracekernel-local-java-host": "pnpm exec esbuild packages/runtime-java/src/tracekernel-local-java-host.ts --bundle --format=esm --platform=browser --target=es2022 --outfile=workers/shared/tracekernel-local-java-host.js && node scripts/normalize-generated-worker-paths.mjs workers/shared/tracekernel-local-java-host.js",
    "generate:java-helper": "node scripts/build-java-browser-helper.mjs",
    "generate:kernel-policy": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/generate-runtime-kernel-policy-classic.ts",
    "sync:package-assets": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/sync-language-package-assets.ts",
    "import:cpp-conformance": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/import-cpp-conformance-fixtures.ts",
    "import:java-conformance": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/import-java-conformance-fixtures.ts",
    "import:python-conformance": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/import-python-conformance-fixtures.ts",
    "import:csharp-conformance": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/import-csharp-conformance-fixtures.ts",
    "import:javascript-conformance": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/import-javascript-conformance-fixtures.ts --language javascript",
    "import:typescript-conformance": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/import-javascript-conformance-fixtures.ts --language typescript",
    "update:csharp-runtime": "bash scripts/update-csharp-wasm-runtime.sh",
    "materialize:csharp-role-assets": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/csharp-role-artifacts.ts materialize",
    "verify:csharp-role-assets": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/csharp-role-artifacts.ts verify",
    typecheck: "pnpm typecheck:root && pnpm typecheck:packages && pnpm typecheck:tests",
    "typecheck:root": "pnpm exec tsc -p tsconfig.root.json --noEmit",
    "typecheck:tests": "pnpm exec tsc -p tsconfig.tests.json --noEmit",
    "typecheck:packages": "pnpm exec tsc -p packages/tracekernel/tsconfig.json --noEmit && pnpm exec tsc -p packages/runtime-contracts/tsconfig.json --noEmit && pnpm exec tsc -p packages/judge/tsconfig.json --noEmit && pnpm exec tsc -p packages/runtime-browser/tsconfig.json --noEmit && pnpm exec tsc -p packages/runtime-python/tsconfig.json --noEmit && pnpm exec tsc -p packages/runtime-javascript/tsconfig.json --noEmit && pnpm exec tsc -p packages/runtime-java/tsconfig.json --noEmit && pnpm exec tsc -p packages/runtime-csharp/tsconfig.json --noEmit && pnpm exec tsc -p packages/runtime-cpp/tsconfig.json --noEmit && pnpm exec tsc -p packages/runtime-native/tsconfig.json --noEmit && pnpm exec tsc -p packages/runtime-sql/tsconfig.json --noEmit",
    "test:judge": "pnpm --dir packages/judge test",
    "test:judge:browser": "pnpm materialize:csharp-role-assets && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-browser-project-judge.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-browser-algorithm-batch.ts",
    "test:tracekernel": "pnpm build:tracekernel && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-public-package.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-lifecycle.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-execution-scope-reset.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-runtime-recovery.ts && pnpm test:tracekernel-capabilities && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-watchdog.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-descriptors.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-terminal.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-watch.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-vfs.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-tkfs-backing.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-namespace.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-network.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-adversarial-teardown.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-workspace-processes.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-workspace-job-control.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-http1.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-http-tcp.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-syscalls.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-transport.ts",
    "test:tracekernel-capabilities": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-controlled-runtime.ts",
    "test:tracekernel:browser": "pnpm generate:javascript-project-worker && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-javascript-stdio.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-javascript-browser.ts",
    "test:tracekernel:python-browser": "pnpm sync:package-assets && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-python-browser.ts",
    "test:tracekernel:cpp-browser": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-cpp-project-http.ts",
    "test:tracekernel:csharp-browser": "pnpm sync:package-assets && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-csharp-browser.ts",
    "test:tracekernel:tracejvm-browser": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-tracejvm-browser.ts",
    "test:tracekernel:soak:bounded": "TRACECODE_TRACEKERNEL_SOAK_PROFILE=bounded pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-soak.ts",
    "test:tracekernel:soak:extended": "TRACECODE_TRACEKERNEL_SOAK_PROFILE=extended pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-soak.ts",
    "test:tracekernel:kernelization:bounded": "node scripts/test-tracekernel-kernelization.mjs --profile=bounded",
    "test:tracekernel:kernelization:full": "node scripts/test-tracekernel-kernelization.mjs --profile=full",
    "test:tracekernel:kernelization:tracejvm": "node scripts/test-tracekernel-kernelization.mjs --profile=tracejvm",
    "test:tracekernel:kernelization:artifacts": "node scripts/test-tracekernel-kernelization.mjs --profile=artifacts",
    "test:tracekernel:physical": "node scripts/run-tracekernel-physical.mjs",
    "test:tracekernel:physical:check": "node scripts/run-tracekernel-physical.mjs --check=webkit",
    "test:smoke": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-harness-workspace-smoke.ts",
    "test:packaged-surface": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-packaged-surface.ts",
    "test:publish-safety": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-publish-safety.ts",
    "test:bundle-gates": "node scripts/check-browser-project-bundle.mjs",
    "test:browser-runtime-host": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-host-artifact-cache.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-worker-session-core.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-browser-provider-registry.ts && TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx --test tests/test-browser-worker-lifecycle-policy.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-browser-runtime-host.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-browser-execution-host.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-browser-runtime-assets.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-browser-runtime-asset-plumbing.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-browser-runtime-environment.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-browser-trace-event-transport.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-runtime-authority-lockdown.ts",
    "test:asset-sync": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-asset-sync.ts",
    "test:language-packages": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-language-package-surface.ts",
    "test:example-app": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-example-app.ts",
    "test:java-example-app": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-java-example-app.ts",
    "test:project-ide-example": "pnpm --dir examples/project-ide build",
    "test:project-terminal-example": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-project-terminal-example.ts",
    "test:example-app-packaged": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-example-app-packaged.ts",
    "test:java-example-app-packaged": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-java-example-app-packaged.ts",
    "test:standalone-boundary": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-standalone-boundary.ts",
    "test:trace-adapters": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-trace-adapters.ts",
    "test:python-sync": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/generate-python-harness-artifacts.ts --check && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-harness-sync.ts",
    "test:kernel-policy-sync": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/generate-runtime-kernel-policy-classic.ts --check",
    "test:typescript-project-libs-sync": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/generate-typescript-project-libs.ts --check",
    "test:java-sync": "pnpm generate:java-helper --check && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-java-harness-sync.ts",
    "test:python-runtime": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-runtime.ts",
    "test:python-prepared-provider": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-runtime-image.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-prepared-provider.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-on-demand-tracing.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-prepared-provider-browser.ts",
    "test:java-runtime": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-java-runtime.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-java-project-filesystem.ts && node --import tsx --test tests/test-java-jar-manifest.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-java-project-provider.ts && TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx --test tests/test-java-prepared-provider.ts tests/test-java-algorithm-isolation-classifier.ts",
    "test:java-prepared-provider": "TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx --test tests/test-java-prepared-provider.ts tests/test-java-algorithm-isolation-classifier.ts && pnpm test:java-prepared-provider:browser",
    "test:java-prepared-provider:browser": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-java-prepared-provider-browser.ts",
    "test:tracejvm-semantic-trace": "node --import tsx tests/test-tracejvm-semantic-trace-matrix.ts",
    "test:csharp-runtime": "pnpm check:traceclr-profile && pnpm exec tsx --tsconfig tsconfig.base.json scripts/validate-csharp-runtime-role-assets.ts && TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx --test tests/test-csharp-role-artifacts.ts tests/test-csharp-managed-assembly-packs.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-csharp-runtime.ts && TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx --test tests/test-csharp-prepared-provider.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-csharp-project-fs-parity.ts",
    "test:csharp-role-assets": "pnpm materialize:csharp-role-assets && TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx --test tests/test-csharp-role-artifacts.ts tests/test-csharp-managed-assembly-packs.ts && pnpm exec tsx --tsconfig tsconfig.base.json scripts/validate-csharp-runtime-role-assets.ts",
    "test:csharp-worker-browser": "pnpm materialize:csharp-role-assets && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-csharp-worker-client-http.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-csharp-worker-browser.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-csharp-worker-lifecycle-browser.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-csharp-prepared-boundary-browser.ts",
    "test:csharp-worker-browser-matrix": "pnpm materialize:csharp-role-assets && for engine in chromium firefox webkit; do TSX_TSCONFIG_PATH=tsconfig.base.json TRACECODE_CSHARP_BROWSER_SMOKE=1 TRACECODE_CSHARP_BROWSER_ENGINE=$engine node --import tsx tests/test-csharp-worker-browser.ts && TSX_TSCONFIG_PATH=tsconfig.base.json TRACECODE_CSHARP_BROWSER_ENGINE=$engine node --import tsx tests/test-csharp-prepared-boundary-browser.ts || exit; done",
    "test:cpp-conformance": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-cpp-conformance.ts",
    "test:cpp-rewriter": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-cpp-rewriter.ts",
    "test:cpp-prepared-lifecycle": "TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx --test tests/test-cpp-compiler-lifecycle.ts",
    "test:cpp-browser-worker": "pnpm run test:tracecc && pnpm run test:tracecc-browser",
    "test:js-runtime": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-javascript-runtime.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-javascript-worker-lifecycle.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-javascript-authority-browser.ts",
    "test:project": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-project-workspace.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-journal.ts && pnpm run test:tracekernel-hardening && pnpm run test:process-resource-limits && pnpm run test:external-http",
    "test:tracekernel-hardening": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracekernel-hardening.ts",
    "test:process-resource-limits": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-process-resource-limits.ts",
    "test:external-http": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-runtime-external-http.ts",
    "test:python-harness-sync": "pnpm run test:python-sync",
    "test:java-harness-sync": "pnpm run test:java-sync",
    "test:javascript-runtime": "pnpm run test:js-runtime",
    "test:python-browser-worker": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-browser-worker.ts",
    "test:python-module-worker": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-module-worker.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-module-worker-protocol.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-configured-package-failure.ts",
    "test:python-module-worker-browser": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-module-worker-browser.ts",
    "test:browser-terminal-fidelity": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-browser-terminal-fidelity.ts",
    "test:project-browser": "pnpm run test:tracekernel-hardening && pnpm run test:external-http && pnpm run test:browser-terminal-fidelity && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-runtime-authority-lockdown.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-javascript-authority-browser.ts",
    "test:kernel-storage-browser": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-kernel-storage-browser.ts",
    "test:kernel-storage-browser-matrix": "TRACECODE_KERNEL_STORAGE_ENGINES=chromium,firefox,webkit pnpm run test:kernel-storage-browser",
    "test:project-browser-matrix": "node scripts/test-browser-project-provider-matrix.mjs",
    "test:project-live-fs-browser": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-project-live-fs-browser.ts",
    "test:project-live-fs-browser-matrix": "TRACECODE_PROJECT_LIVE_FS_ENGINES=chromium,firefox,webkit pnpm run test:project-live-fs-browser",
    "test:python-worker-client-http": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-worker-client-http.ts",
    "test:runtime-contract": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-runtime-contract.ts",
    "test:runtime-execution-judge": "TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx --test tests/test-runtime-execution-judge.ts",
    "test:prepared-provider-release-gate": "TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx --test tests/test-prepared-provider-release-gate.ts",
    "test:contracts-public-surface": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-runtime-contracts-public-surface.ts",
    "test:python-public-surface": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-public-surface.ts",
    "test:java-public-surface": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-java-public-surface.ts",
    "test:csharp-public-surface": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-csharp-public-surface.ts",
    "test:cpp-public-surface": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-cpp-public-surface.ts",
    "test:tracecc": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracecc-runtime-assets.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracecc-compiler-service.ts && pnpm exec tsx --tsconfig tsconfig.base.json tests/test-cpp-tracecc-client-contract.ts",
    "test:tracecc-browser": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-tracecc-browser-runtime.ts",
    "prepare:tracecc-assets": "node --import tsx scripts/prepare-tracecc-runtime-assets.mts",
    "test:native-harness": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-native-harness.ts",
    "test:native-python-serialization-limit": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-native-python-serialization-limit.ts",
    "test:runtime-info-sync": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/generate-runtime-language-info.ts --check && pnpm exec tsx --tsconfig tsconfig.base.json scripts/generate-runtime-open-source-info.ts --check && pnpm test:runtime-open-source-info && pnpm test:runtime-notices",
    "test:runtime-open-source-info": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-runtime-open-source-info.ts",
    "test:runtime-notices": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-runtime-notices.ts",
    "test:runtime-assets-lock": "node --import tsx scripts/generate-runtime-assets-lock.mjs --check && node tests/test-runtime-assets-lock.mjs",
    "test:runtime-trace-parity": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-runtime-trace-parity.ts",
    "test:runtime-trace-fixtures": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-runtime-trace-fixtures.ts",
    "report:runtime-trace-known-gaps": "pnpm exec tsx --tsconfig tsconfig.base.json tests/report-runtime-trace-known-gaps.ts",
    "local:test:runtime-trace-final300-compile": "pnpm exec tsx --tsconfig tsconfig.base.json tests/mine-runtime-trace-corpus.ts --limit=300 --fail-on-failure --report=reports/runtime-v4-final300-compile-gate.json",
    "local:build:runtime-trace-tc83": "pnpm exec tsx --tsconfig tsconfig.base.json tests/build-runtime-trace-tc83-corpus.ts",
    "local:test:runtime-trace-tc83-smoke": "pnpm local:build:runtime-trace-tc83 && pnpm exec tsx --tsconfig tsconfig.base.json tests/mine-runtime-trace-corpus.ts --corpus=reports/runtime-trace-tc83-corpus.json --source-root=/Users/obinnanwachukwu/Code/algoflow --limit=83 --jobs=8 --worker-timeout-ms=180000 --max-trace-steps=10000 --loose-any-valid-output --fail-on-failure --report=reports/runtime-trace-tc83-smoke.json",
    "local:mine:runtime-trace-tc83-parity": "pnpm local:build:runtime-trace-tc83 && pnpm exec tsx --tsconfig tsconfig.base.json tests/mine-runtime-trace-corpus.ts --corpus=reports/runtime-trace-tc83-corpus.json --source-root=/Users/obinnanwachukwu/Code/algoflow --limit=83 --jobs=8 --worker-timeout-ms=180000 --max-trace-steps=10000 --loose-any-valid-output --reference-language=javascript --comparison-languages=typescript,java --compare-runtime-facts --include-signature-diffs --report=reports/runtime-trace-tc83-parity.json",
    "local:test:cpp-algoflow-smoke": "pnpm exec tsx --tsconfig tsconfig.base.json tests/mine-cpp-algoflow-corpus.ts --sample=two-sum,map-sum-pairs,range-frequency-queries,binary-tree-tilt --loose-any-valid-output --fail-on-failure --report=reports/cpp-algoflow-smoke.json",
    "local:mine:cpp-algoflow-corpus": "pnpm exec tsx --tsconfig tsconfig.base.json tests/mine-cpp-algoflow-corpus.ts --limit=50 --max-stored-events=10000 --loose-any-valid-output --report=reports/cpp-algoflow-corpus.json",
    "local:mine:cpp-algoflow-corpus:isolated": "pnpm exec tsx --tsconfig tsconfig.base.json tests/mine-cpp-algoflow-corpus.ts --limit=0 --no-trace --jobs=4 --batch-size=16 --worker-timeout-ms=600000 --max-stored-events=10000 --loose-any-valid-output --compare-languages=javascript,typescript,python,java --report=reports/cpp-algoflow-corpus-isolated.json",
    "test:test-suite-runner": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-test-suite-runner.ts",
    "test:ci": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/run-test-suite.ts --ci",
    test: "pnpm exec tsx --tsconfig tsconfig.base.json scripts/run-test-suite.ts --all",
    "mine:runtime-trace-final300": "pnpm exec tsx --tsconfig tsconfig.base.json tests/mine-runtime-trace-corpus.ts",
    "mine:runtime-trace-final300:parallel": "pnpm exec tsx --tsconfig tsconfig.base.json tests/mine-runtime-trace-corpus.ts --jobs=8",
    "test:runtime-raw-emission-contract": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-runtime-raw-emission-contract.ts",
    "test:sql-trace": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-sql-trace.ts",
    "test:sql-trace-fixtures": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-sql-trace-fixtures.ts",
    "test:sql-package-surface": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-sql-package-surface.ts",
    "test:sql-browser-example": "pnpm exec tsx --tsconfig tsconfig.base.json tests/test-sql-browser-example.ts",
    "test:runtime-trace-fixtures:raw-strict": "TRACECODE_STRICT_RAW_EMISSION_PARITY=1 TRACECODE_RUNTIME_TRACE_LANGUAGES=python,javascript,typescript,java,csharp pnpm exec tsx --tsconfig tsconfig.base.json tests/test-runtime-trace-fixtures.ts",
    "test:runtime-trace": "pnpm test:runtime-trace-fixtures:raw-strict && pnpm test:runtime-raw-emission-contract && pnpm report:runtime-trace-known-gaps",
    "mine:runtime-trace-corpus": "pnpm exec tsx --tsconfig tsconfig.base.json tests/mine-runtime-trace-corpus.ts",
    "mine:runtime-trace-corpus:parallel": "pnpm exec tsx --tsconfig tsconfig.base.json tests/mine-runtime-trace-corpus.ts --jobs=8",
    "bench:browser-project-runtimes": "pnpm exec tsx --tsconfig tsconfig.base.json scripts/benchmark-browser-project-runtimes.ts",
    "bench:tracekernel-seekable-output": "node --import tsx scripts/benchmark-tracekernel-seekable-output.mts",
    "check:browser-project-performance": "node scripts/check-browser-project-performance.mjs"
  },
  devDependencies: {
    "@tracecode/runtime-contracts": "workspace:^",
    "@tracecode/tracekernel": "workspace:^",
    "@types/node": "^20.0.0",
    esbuild: "0.27.3",
    "just-bash": "3.1.0",
    playwright: "^1.53.2",
    pyodide: "^0.29.0",
    tsup: "^8.5.0",
    tsx: "^4.21.0",
    typescript: "^5.0.0"
  },
  pnpm: {
    overrides: {
      dompurify: "3.4.1",
      picomatch: "4.0.4",
      postcss: "8.5.10"
    },
    patchedDependencies: {
      "just-bash@3.1.0": "patches/just-bash@3.1.0.patch"
    }
  },
  dependencies: {
    "@datastructures-js/binary-search-tree": "5.4.0",
    "@datastructures-js/deque": "1.0.8",
    "@datastructures-js/graph": "5.3.1",
    "@datastructures-js/heap": "4.3.7",
    "@datastructures-js/linked-list": "6.1.4",
    "@datastructures-js/priority-queue": "6.3.5",
    "@datastructures-js/queue": "4.3.0",
    "@datastructures-js/set": "4.2.2",
    "@datastructures-js/stack": "3.1.6",
    "@datastructures-js/trie": "4.2.3",
    "@tracecode/tracecc": "0.1.0",
    "@tracecode/tracejvm": "0.4.1",
    effect: "3.22.0",
    fflate: "0.8.3",
    lodash: "4.17.21",
    typescript: "^5.0.0"
  }
};

// packages/runtime-contracts/src/harness-version.ts
var TRACECODE_HARNESS_VERSION = package_default.version;

// packages/runtime-contracts/src/generated/runtime-language-info-data.ts
var LANGUAGE_RUNTIME_INFOS = Object.freeze(
  Object.assign(/* @__PURE__ */ Object.create(null), {
    "python": {
      "language": "python",
      "displayName": "Python",
      "versionLabel": "Python 3.13.2",
      "executionPlatform": {
        "name": "TraceKernel",
        "version": "0.17.0"
      },
      "description": "Python 3.13.2 runs in TraceKernel's isolated Python runtime.\n\nCommon algorithm helpers are imported automatically, including array, bisect, collections, functools, heapq, itertools. Other standard-library modules can be imported normally.\n\nOptional third-party packages are consumer-owned runtime assets and are available only when declared by the TraceKernel runtime manifest.",
      "runtime": {
        "name": "Python",
        "version": "3.13.2",
        "detail": "Runs in TraceKernel's isolated Python runtime."
      },
      "defaultImports": [
        "array",
        "bisect",
        "collections",
        "functools",
        "heapq",
        "itertools",
        "operator",
        "re",
        "string",
        "typing"
      ]
    },
    "javascript": {
      "language": "javascript",
      "displayName": "JavaScript",
      "versionLabel": "JavaScript (ECMAScript 2023)",
      "executionPlatform": {
        "name": "TraceKernel",
        "version": "0.17.0"
      },
      "runtime": {
        "name": "TraceKernel JavaScript runtime",
        "detail": "Runs in an isolated TraceKernel worker; Node.js is not required for execution."
      },
      "libraries": [
        {
          "name": "lodash",
          "version": "4.17.21",
          "importName": "lodash",
          "globalName": "_"
        },
        {
          "name": "@datastructures-js/binary-search-tree",
          "version": "5.4.0",
          "importName": "@datastructures-js/binary-search-tree"
        },
        {
          "name": "@datastructures-js/deque",
          "version": "1.0.8",
          "importName": "@datastructures-js/deque"
        },
        {
          "name": "@datastructures-js/graph",
          "version": "5.3.1",
          "importName": "@datastructures-js/graph"
        },
        {
          "name": "@datastructures-js/heap",
          "version": "4.3.7",
          "importName": "@datastructures-js/heap"
        },
        {
          "name": "@datastructures-js/linked-list",
          "version": "6.1.4",
          "importName": "@datastructures-js/linked-list"
        },
        {
          "name": "@datastructures-js/priority-queue",
          "version": "6.3.5",
          "importName": "@datastructures-js/priority-queue"
        },
        {
          "name": "@datastructures-js/queue",
          "version": "4.3.0",
          "importName": "@datastructures-js/queue"
        },
        {
          "name": "@datastructures-js/set",
          "version": "4.2.2",
          "importName": "@datastructures-js/set"
        },
        {
          "name": "@datastructures-js/stack",
          "version": "3.1.6",
          "importName": "@datastructures-js/stack"
        },
        {
          "name": "@datastructures-js/trie",
          "version": "4.2.3",
          "importName": "@datastructures-js/trie"
        }
      ],
      "standard": "ECMAScript 2023-compatible syntax in TraceKernel's JavaScript runtime.",
      "description": `JavaScript runs in TraceKernel's isolated JavaScript runtime with ECMAScript 2023-compatible syntax.

Lodash 4.17.21 is available as both lodash and _.

The @datastructures-js packages are bundled for common algorithm data structures. Queue, Stack, Deque, Heap, PriorityQueue, MinPriorityQueue, and MaxPriorityQueue are available globally.

Bundled @datastructures-js versions:

"@datastructures-js/binary-search-tree": "5.4.0"
"@datastructures-js/deque": "1.0.8"
"@datastructures-js/graph": "5.3.1"
"@datastructures-js/heap": "4.3.7"
"@datastructures-js/linked-list": "6.1.4"
"@datastructures-js/priority-queue": "6.3.5"
"@datastructures-js/queue": "4.3.0"
"@datastructures-js/set": "4.2.2"
"@datastructures-js/stack": "3.1.6"
"@datastructures-js/trie": "4.2.3"

Binary Search Tree, Trie, and Graph are bundled too, but are not exposed globally because those names can collide with problem definitions. Import or require the matching package when you need one.`
    },
    "typescript": {
      "language": "typescript",
      "displayName": "TypeScript",
      "versionLabel": "TypeScript 5.9.3",
      "executionPlatform": {
        "name": "TraceKernel",
        "version": "0.17.0"
      },
      "description": `TypeScript 5.9.3 is compiled with the TypeScript compiler and executed by TraceKernel's JavaScript runtime.

Compiler options: --target ES2020 --module None --strict false --esModuleInterop

Lodash 4.17.21 is available as both lodash and _.

The @datastructures-js packages are bundled for common algorithm data structures. Queue, Stack, Deque, Heap, PriorityQueue, MinPriorityQueue, and MaxPriorityQueue are available globally.

Bundled @datastructures-js versions:

"@datastructures-js/binary-search-tree": "5.4.0"
"@datastructures-js/deque": "1.0.8"
"@datastructures-js/graph": "5.3.1"
"@datastructures-js/heap": "4.3.7"
"@datastructures-js/linked-list": "6.1.4"
"@datastructures-js/priority-queue": "6.3.5"
"@datastructures-js/queue": "4.3.0"
"@datastructures-js/set": "4.2.2"
"@datastructures-js/stack": "3.1.6"
"@datastructures-js/trie": "4.2.3"

Binary Search Tree, Trie, and Graph are bundled too, but are not exposed globally because those names can collide with problem definitions. Import or require the matching package when you need one.

The compiled output runs on the same TraceKernel execution lane as JavaScript submissions.`,
      "runtime": {
        "name": "TraceKernel JavaScript runtime",
        "detail": "TypeScript is compiled before execution and runs on TraceKernel's JavaScript runtime."
      },
      "compiler": {
        "name": "TypeScript",
        "version": "5.9.3"
      },
      "standard": "Transpiles to JavaScript for TraceKernel's JavaScript runtime.",
      "libraries": [
        {
          "name": "lodash",
          "version": "4.17.21",
          "importName": "lodash",
          "globalName": "_"
        },
        {
          "name": "@datastructures-js/binary-search-tree",
          "version": "5.4.0",
          "importName": "@datastructures-js/binary-search-tree"
        },
        {
          "name": "@datastructures-js/deque",
          "version": "1.0.8",
          "importName": "@datastructures-js/deque"
        },
        {
          "name": "@datastructures-js/graph",
          "version": "5.3.1",
          "importName": "@datastructures-js/graph"
        },
        {
          "name": "@datastructures-js/heap",
          "version": "4.3.7",
          "importName": "@datastructures-js/heap"
        },
        {
          "name": "@datastructures-js/linked-list",
          "version": "6.1.4",
          "importName": "@datastructures-js/linked-list"
        },
        {
          "name": "@datastructures-js/priority-queue",
          "version": "6.3.5",
          "importName": "@datastructures-js/priority-queue"
        },
        {
          "name": "@datastructures-js/queue",
          "version": "4.3.0",
          "importName": "@datastructures-js/queue"
        },
        {
          "name": "@datastructures-js/set",
          "version": "4.2.2",
          "importName": "@datastructures-js/set"
        },
        {
          "name": "@datastructures-js/stack",
          "version": "3.1.6",
          "importName": "@datastructures-js/stack"
        },
        {
          "name": "@datastructures-js/trie",
          "version": "4.2.3",
          "importName": "@datastructures-js/trie"
        }
      ]
    },
    "java": {
      "language": "java",
      "displayName": "Java",
      "versionLabel": "Java 23",
      "executionPlatform": {
        "name": "TraceKernel",
        "version": "0.17.0"
      },
      "description": "Java 23 is compiled with javac 23 and executed by the Java runtime on TraceKernel.\n\nCommon imports are added automatically: java.util.*, java.io.*, java.math.*, java.util.stream.*, javafx.util.Pair.",
      "runtime": {
        "name": "TraceKernel Java runtime",
        "version": "23",
        "detail": "Runs through the Java runtime on TraceKernel."
      },
      "compiler": {
        "name": "javac",
        "version": "23"
      },
      "defaultImports": [
        "java.util.*",
        "java.io.*",
        "java.math.*",
        "java.util.stream.*",
        "javafx.util.Pair"
      ],
      "libraries": [
        {
          "name": "JavaParser",
          "version": "3.25.10",
          "detail": "Used internally for Java source rewriting."
        },
        {
          "name": "javafx.util.Pair",
          "detail": "Small compatibility Pair class bundled with the Java helper jar."
        }
      ]
    },
    "csharp": {
      "language": "csharp",
      "displayName": "C#",
      "versionLabel": "C# 14",
      "executionPlatform": {
        "name": "TraceKernel",
        "version": "0.17.0"
      },
      "description": "C# 14 source is compiled and executed by TraceKernel's isolated C# runtime.\n\nCommon namespaces are imported automatically: System, System.Collections, System.Collections.Generic, System.IO, System.Linq, System.Numerics, System.Text, System.Text.RegularExpressions.",
      "runtime": {
        "name": "C#",
        "detail": "Runs in TraceKernel's isolated C# runtime."
      },
      "compiler": {
        "name": "C# compiler",
        "version": "C# 14"
      },
      "standard": "C# 14",
      "defaultImports": [
        "System",
        "System.Collections",
        "System.Collections.Generic",
        "System.IO",
        "System.Linq",
        "System.Numerics",
        "System.Text",
        "System.Text.RegularExpressions"
      ]
    },
    "cpp": {
      "language": "cpp",
      "displayName": "C++",
      "versionLabel": "C++23",
      "executionPlatform": {
        "name": "TraceKernel",
        "version": "0.17.0"
      },
      "description": "C++ source is compiled using the C++23 standard.\n\nSubmissions compile to WebAssembly and run in TraceKernel's WASI execution lane. The compiler currently uses -O0 and -fno-exceptions, with a fixed program stack size.\n\nCommon standard library headers are included automatically, including <algorithm>, <array>, <bitset>, <climits>, <cmath>, <cstdint>, <functional>, <limits>, <numeric>, <sstream>, <tuple>, <vector>, <unordered_map>, <unordered_set> and more.",
      "runtime": {
        "name": "TraceKernel WASI runtime",
        "detail": "Compiled to WebAssembly and executed in TraceKernel's WASI runtime."
      },
      "compiler": {
        "name": "C++ compiler",
        "version": "C++23"
      },
      "standard": "C++23",
      "defaultImports": [
        "<algorithm>",
        "<array>",
        "<bitset>",
        "<climits>",
        "<cmath>",
        "<cstdint>",
        "<functional>",
        "<limits>",
        "<numeric>",
        "<sstream>",
        "<tuple>",
        "<vector>",
        "<unordered_map>",
        "<unordered_set>",
        "<map>",
        "<set>",
        "<deque>",
        "<queue>",
        "<stack>",
        "<utility>",
        "<string>",
        "<span>",
        "<ranges>",
        "<concepts>",
        "<any>",
        "<bit>",
        "<cctype>",
        "<cerrno>",
        "<cfloat>",
        "<charconv>",
        "<chrono>",
        "<cinttypes>",
        "<compare>",
        "<complex>",
        "<cstddef>",
        "<cstdio>",
        "<cstdlib>",
        "<cstring>",
        "<exception>",
        "<expected>",
        "<forward_list>",
        "<initializer_list>",
        "<iomanip>",
        "<ios>",
        "<iostream>",
        "<iterator>",
        "<list>",
        "<memory>",
        "<numbers>",
        "<optional>",
        "<random>",
        "<ratio>",
        "<regex>",
        "<stdexcept>",
        "<string_view>",
        "<type_traits>",
        "<typeindex>",
        "<typeinfo>",
        "<valarray>",
        "<variant>",
        "<version>",
        "<tracecode_socket.h>",
        "<tracecode_process.h>",
        "<tracecode_ioctl.h>"
      ],
      "libraries": [
        {
          "name": "C++ standard library and WASI libc",
          "detail": "Provided by the configured browser compiler resources."
        }
      ]
    }
  })
);
var RUNTIME_COMMAND_VERSIONS = Object.freeze(
  Object.assign(/* @__PURE__ */ Object.create(null), {
    "dotnet": "10.0.10",
    "clang++": "22.0.0"
  })
);

// packages/runtime-contracts/src/runtime-language-info.ts
var NODE_RUNTIME_COMPAT_VERSION = "22.0.0";
var SUPPORTED_LANGUAGE_RUNTIME_INFOS = Object.freeze(
  Object.values(LANGUAGE_RUNTIME_INFOS)
);
function getLanguageRuntimeInfo(language) {
  const info = Object.prototype.hasOwnProperty.call(LANGUAGE_RUNTIME_INFOS, language) ? LANGUAGE_RUNTIME_INFOS[language] : void 0;
  if (!info) {
    throw new Error(`Runtime info for language "${language}" is not implemented yet.`);
  }
  return info;
}

// packages/runtime-contracts/src/runtime-command-internal.ts
var RUNTIME_SIGNAL_EXIT_CODES = /* @__PURE__ */ new Map([
  ["SIGHUP", 1],
  ["SIGINT", 2],
  ["SIGQUIT", 3],
  ["SIGKILL", 9],
  ["SIGTERM", 15]
]);
function runtimeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function isRuntimeAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}
function isRuntimeTimeoutError(error) {
  const message = runtimeErrorMessage(error).toLowerCase();
  return message.includes("timed out") || message.includes("timeout");
}
var textEncoder2 = new TextEncoder();
function runtimeFileChangeByteSize(change) {
  let size = textEncoder2.encode(change.path).byteLength;
  if (change.symlink === true) {
    return size + textEncoder2.encode(change.target).byteLength;
  }
  const file = change;
  if (file.contents !== void 0) {
    size += file.encoding === "base64" ? Math.ceil(file.contents.length * 3 / 4) : textEncoder2.encode(file.contents).byteLength;
  }
  return size;
}

// packages/runtime-contracts/src/runtime-command.ts
var RUNTIME_STDIN_PIPE_HEADER_INTS = 3;
var RUNTIME_STDIN_PIPE_HEADER_BYTES = RUNTIME_STDIN_PIPE_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
var RUNTIME_STDIN_PIPE_READ_INDEX = 0;
var RUNTIME_STDIN_PIPE_WRITE_INDEX = 1;
var RUNTIME_STDIN_PIPE_CLOSED_INDEX = 2;
var RUNTIME_STDIN_PIPE_DEFAULT_CAPACITY = 64 * 1024;
function runtimeCommandStdinPipeState(pipe) {
  return {
    header: new Int32Array(pipe.buffer, 0, RUNTIME_STDIN_PIPE_HEADER_INTS),
    bytes: new Uint8Array(pipe.buffer, RUNTIME_STDIN_PIPE_HEADER_BYTES)
  };
}
function runtimeCommandStdinPipeAvailable(state) {
  const readIndex = Atomics.load(state.header, RUNTIME_STDIN_PIPE_READ_INDEX);
  const writeIndex = Atomics.load(state.header, RUNTIME_STDIN_PIPE_WRITE_INDEX);
  const capacity = state.bytes.byteLength;
  return readIndex <= writeIndex ? writeIndex - readIndex : capacity - readIndex + writeIndex;
}
function runtimeCommandStdinPipeClosed(pipe) {
  const { header } = runtimeCommandStdinPipeState(pipe);
  return Atomics.load(header, RUNTIME_STDIN_PIPE_CLOSED_INDEX) !== 0;
}
function runtimeCommandStdinPipeRemainingBytes(pipe) {
  return runtimeCommandStdinPipeAvailable(runtimeCommandStdinPipeState(pipe));
}
function readRuntimeCommandStdinPipeBytes(pipe, maxLength = RUNTIME_STDIN_PIPE_DEFAULT_CAPACITY) {
  const state = runtimeCommandStdinPipeState(pipe);
  const available = runtimeCommandStdinPipeAvailable(state);
  if (available <= 0 || maxLength <= 0) return new Uint8Array();
  const readIndex = Atomics.load(state.header, RUNTIME_STDIN_PIPE_READ_INDEX);
  const capacity = state.bytes.byteLength;
  const length = Math.min(Math.floor(maxLength), available);
  const out = new Uint8Array(length);
  const firstLength = Math.min(length, capacity - readIndex);
  out.set(state.bytes.subarray(readIndex, readIndex + firstLength), 0);
  if (firstLength < length) {
    out.set(state.bytes.subarray(0, length - firstLength), firstLength);
  }
  Atomics.store(state.header, RUNTIME_STDIN_PIPE_READ_INDEX, (readIndex + length) % capacity);
  Atomics.notify(state.header, RUNTIME_STDIN_PIPE_READ_INDEX);
  return out;
}
function runtimeAbortSignalName(signal, fallback = "SIGTERM") {
  const reason = signal?.reason;
  const raw = typeof reason?.signal === "string" && reason.signal.trim() ? reason.signal.trim() : fallback;
  const normalized = raw.toUpperCase().startsWith("SIG") ? raw.toUpperCase() : `SIG${raw.toUpperCase()}`;
  return RUNTIME_SIGNAL_EXIT_CODES.has(normalized) ? normalized : fallback;
}
function runtimeSignalExitCode(signalName) {
  const normalized = signalName.toUpperCase().startsWith("SIG") ? signalName.toUpperCase() : `SIG${signalName.toUpperCase()}`;
  return 128 + (RUNTIME_SIGNAL_EXIT_CODES.get(normalized) ?? RUNTIME_SIGNAL_EXIT_CODES.get("SIGTERM"));
}
function createRuntimeProjectIoBridge(onEvent) {
  return {
    output: (stream, data, device, sourceDevice) => {
      const outputDevice = device ?? (stream === "stdout" ? "/dev/stdout" : "/dev/stderr");
      onEvent?.({
        type: "output",
        stream,
        device: outputDevice,
        ...sourceDevice && sourceDevice !== outputDevice ? { sourceDevice } : {},
        data
      });
    },
    fileChange: (change, phase = "live") => {
      onEvent?.({ type: "file-change", change, phase });
    },
    status: (phase, message, detail) => {
      onEvent?.({
        type: "status",
        phase,
        message,
        ...detail ? { detail } : {}
      });
    }
  };
}
function runtimeFileChangePath(change) {
  return change.path;
}
function normalizeRuntimeFileChangePath(path) {
  if (typeof path !== "string") {
    throw Object.assign(new Error("EINVAL: TraceKernel file-change path must be a string"), { code: "EINVAL" });
  }
  if (path.includes("\0")) {
    throw Object.assign(new Error("EINVAL: TraceKernel file-change path must not contain NUL bytes"), { code: "EINVAL" });
  }
  const normalized = path.replace(/\\/g, "/");
  if (normalized.trim().length === 0) {
    throw Object.assign(new Error("EINVAL: TraceKernel file-change path must not be empty"), { code: "EINVAL" });
  }
  if (normalized.startsWith("/")) {
    throw Object.assign(new Error(`EACCES: TraceKernel file-change path must be relative: ${path}`), { code: "EACCES" });
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw Object.assign(new Error(`EACCES: TraceKernel file-change path must not include a drive prefix: ${path}`), { code: "EACCES" });
  }
  const parts = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      throw Object.assign(new Error(`EACCES: TraceKernel file-change path must not escape the workspace: ${path}`), { code: "EACCES" });
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change path must point to an entry: ${path}`), { code: "EINVAL" });
  }
  return parts.join("/");
}
function normalizeRuntimeFileChange(change) {
  if (!change || typeof change !== "object") {
    throw Object.assign(new Error("EINVAL: TraceKernel file-change must be an object"), { code: "EINVAL" });
  }
  const path = normalizeRuntimeFileChangePath(change.path);
  const directory = change.directory;
  const symlink = change.symlink;
  const target = change.target;
  const deleted = change.deleted;
  const contents = change.contents;
  const encoding = change.encoding;
  const mode = change.mode;
  const atimeMs = change.atimeMs;
  const mtimeMs = change.mtimeMs;
  const metadata = {
    ...mode !== void 0 ? { mode: normalizeRuntimeFileMode(mode, path) } : {},
    ...atimeMs !== void 0 ? { atimeMs: normalizeRuntimeFileTimestamp(atimeMs, path, "atimeMs") } : {},
    ...mtimeMs !== void 0 ? { mtimeMs: normalizeRuntimeFileTimestamp(mtimeMs, path, "mtimeMs") } : {}
  };
  if (directory !== void 0 && directory !== true) {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change directory flag must be true: ${path}`), { code: "EINVAL" });
  }
  if (symlink !== void 0 && symlink !== true) {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change symlink flag must be true: ${path}`), { code: "EINVAL" });
  }
  if (deleted !== void 0 && deleted !== true) {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change deleted flag must be true: ${path}`), { code: "EINVAL" });
  }
  if (encoding !== void 0 && encoding !== "base64") {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change encoding is unsupported: ${path}`), { code: "EINVAL" });
  }
  if (symlink === true) {
    if (directory !== void 0 || deleted !== void 0 || contents !== void 0 || encoding !== void 0) {
      throw Object.assign(new Error(`EINVAL: TraceKernel symlink file-change must only include a target: ${path}`), { code: "EINVAL" });
    }
    if (Object.keys(metadata).length > 0) {
      throw Object.assign(new Error(`EINVAL: TraceKernel symlink file-change metadata is unsupported: ${path}`), { code: "EINVAL" });
    }
    if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
      throw Object.assign(new Error(`EINVAL: TraceKernel symlink file-change target is invalid: ${path}`), { code: "EINVAL" });
    }
    return { path, symlink: true, target };
  }
  if (target !== void 0) {
    throw Object.assign(new Error(`EINVAL: TraceKernel non-symlink file-change must not include a target: ${path}`), { code: "EINVAL" });
  }
  if (directory === true) {
    if (contents !== void 0 || encoding !== void 0) {
      throw Object.assign(new Error(`EINVAL: TraceKernel directory file-change must not include contents: ${path}`), { code: "EINVAL" });
    }
    if (deleted === true && Object.keys(metadata).length > 0) {
      throw Object.assign(new Error(`EINVAL: TraceKernel deleted directory file-change must not include metadata: ${path}`), { code: "EINVAL" });
    }
    return { path, directory: true, ...metadata, ...deleted === true ? { deleted: true } : {} };
  }
  if (deleted === true) {
    if (contents !== void 0 || encoding !== void 0) {
      throw Object.assign(new Error(`EINVAL: TraceKernel delete file-change must not include contents: ${path}`), { code: "EINVAL" });
    }
    if (Object.keys(metadata).length > 0) {
      throw Object.assign(new Error(`EINVAL: TraceKernel delete file-change metadata is unsupported: ${path}`), { code: "EINVAL" });
    }
    return { path, deleted: true };
  }
  if (typeof contents !== "string") {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change contents must be a string: ${path}`), { code: "EINVAL" });
  }
  return { path, contents, ...encoding === "base64" ? { encoding } : {}, ...metadata };
}
function normalizeRuntimeFileMode(value, path) {
  if (!Number.isInteger(value) || value < 0 || value > 4095) {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change mode is invalid: ${path}`), { code: "EINVAL" });
  }
  return value;
}
function normalizeRuntimeFileTimestamp(value, path, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change ${field} is invalid: ${path}`), { code: "EINVAL" });
  }
  return value;
}
function filterRuntimeCommandResultFiles(result, shouldFilter) {
  if (!result.files?.length) return result;
  const files = result.files.filter((change) => !shouldFilter(change));
  if (files.length === result.files.length) return result;
  if (files.length > 0) return { ...result, files };
  const { files: _files, ...rest } = result;
  return rest;
}
var RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES = 1024 * 1024;
var RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES = 1024;
var RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES = 4 * 1024 * 1024;
var RUNTIME_PROJECT_MAX_FINAL_DIFF_FILE_BYTES = 16 * 1024 * 1024;
var RUNTIME_PROJECT_MAX_FINAL_DIFF_BYTES = 32 * 1024 * 1024;
var runtimeProjectTextEncoder = new TextEncoder();
function runtimeProjectUtf8Bytes(value) {
  return runtimeProjectTextEncoder.encode(value).byteLength;
}
function runtimeProjectTruncateUtf8(value, maxBytes) {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const nextBytes = runtimeProjectUtf8Bytes(char);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    end += char.length;
  }
  return value.slice(0, end);
}
var RUNTIME_PROJECT_HIDDEN_COMMAND_ACCESS_REGISTRY = /* @__PURE__ */ Symbol.for(
  // This global registry key is a runtime protocol identifier, not a package import.
  // Keep it stable so mixed bundles share one authority registry during upgrades.
  "@tracecode/harness-core/runtimeProjectHiddenCommandAccesses"
);
var runtimeProjectHiddenCommandAccesses = (() => {
  const globalRegistry = globalThis;
  globalRegistry[RUNTIME_PROJECT_HIDDEN_COMMAND_ACCESS_REGISTRY] ??= /* @__PURE__ */ new WeakSet();
  return globalRegistry[RUNTIME_PROJECT_HIDDEN_COMMAND_ACCESS_REGISTRY];
})();

// packages/runtime-contracts/src/runtime-command-bridge.ts
function runtimeProjectInfrastructureFailure(error, signal) {
  const diagnostic = runtimeErrorMessage(error);
  const aborted = isRuntimeAbortError(error) || signal?.aborted;
  if (aborted) {
    const signalName = runtimeAbortSignalName(signal);
    const signalCode = RUNTIME_SIGNAL_EXIT_CODES.get(signalName) ?? RUNTIME_SIGNAL_EXIT_CODES.get("SIGTERM");
    return {
      stdout: "",
      stderr: "",
      exitCode: 128 + signalCode,
      error: {
        code: "EINTR",
        errno: 4,
        syscall: "wait4",
        message: "Process interrupted by signal",
        detail: {
          signal: signalName,
          signalCode,
          diagnostic
        }
      }
    };
  }
  if (isRuntimeTimeoutError(error)) {
    return {
      stdout: "",
      stderr: "",
      exitCode: 124,
      error: {
        code: "ETIMEDOUT",
        errno: 110,
        message: "Process timed out",
        detail: { diagnostic }
      }
    };
  }
  return {
    stdout: "",
    stderr: "",
    exitCode: runtimeSignalExitCode("SIGKILL"),
    error: {
      code: "EIO",
      errno: 5,
      message: "Runtime process terminated unexpectedly",
      detail: {
        signal: "SIGKILL",
        signalCode: RUNTIME_SIGNAL_EXIT_CODES.get("SIGKILL"),
        diagnostic
      }
    }
  };
}
var RuntimeProjectOutputTracker = class {
  stdoutStreamed = "";
  stderrStreamed = "";
  observe(event) {
    if (event.type !== "output") return;
    if (event.stream === "stdout") this.stdoutStreamed += event.data;
    if (event.stream === "stderr") this.stderrStreamed += event.data;
  }
  emitMissingFinalOutput(result, output) {
    this.emitMissingStreamOutput("stdout", result.stdout, this.stdoutStreamed, output);
    this.emitMissingStreamOutput("stderr", result.stderr, this.stderrStreamed, output);
  }
  /**
   * Return a complete final transcript when a command also emitted live output events.
   *
   * Nested commands can be interrupted after streaming output but before their parent has copied
   * that output into its returned result. In that case the returned value is a shorter prefix of
   * the transcript already shown in the terminal. Treating it as new output replays that prefix.
   */
  completeFinalOutput(result) {
    return {
      stdout: this.completeStreamOutput(result.stdout, this.stdoutStreamed),
      stderr: this.completeStreamOutput(result.stderr, this.stderrStreamed)
    };
  }
  completeStreamOutput(finalOutput, streamedOutput) {
    if (!streamedOutput) return finalOutput;
    if (!finalOutput) return streamedOutput;
    if (finalOutput.includes(streamedOutput)) return finalOutput;
    if (streamedOutput.includes(finalOutput)) return streamedOutput;
    const maximumOverlap = Math.min(streamedOutput.length, finalOutput.length);
    for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
      if (streamedOutput.endsWith(finalOutput.slice(0, overlap))) {
        return `${streamedOutput}${finalOutput.slice(overlap)}`;
      }
    }
    return `${streamedOutput}${finalOutput}`;
  }
  emitMissingStreamOutput(stream, finalOutput, streamedOutput, output) {
    if (!finalOutput) return;
    if (!streamedOutput) {
      output(stream, finalOutput);
      return;
    }
    if (finalOutput.startsWith(streamedOutput)) {
      const suffix = finalOutput.slice(streamedOutput.length);
      if (suffix) output(stream, suffix);
    }
  }
};
async function awaitRuntimeAbortable(promise, signal) {
  if (!signal) return { aborted: false, value: await promise };
  if (signal.aborted) return { aborted: true };
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ aborted: false, value });
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
var RuntimeProjectEventQueue = class {
  queue = Promise.resolve();
  failure = null;
  enqueue(event, options) {
    const execution = this.queue.then(async () => {
      if (this.failure) return;
      if (options.signal?.aborted) return;
      if (event.type !== "file-change") {
        options.emit(event);
        return;
      }
      const change = normalizeRuntimeFileChange(event.change);
      const phase = event.phase ?? "live";
      if (options.signal?.aborted) return;
      const applied = await awaitRuntimeAbortable(
        options.applyFileChange(change, phase, { signal: options.signal }),
        options.signal
      );
      if (!("value" in applied)) return;
      const shouldEmit = applied.value;
      if (options.signal?.aborted) return;
      if (shouldEmit === false) return;
      options.emit({
        ...event,
        change,
        phase,
        actor: event.actor ?? options.actor
      });
    });
    this.queue = execution.catch((error) => {
      this.failure ??= { error };
    });
  }
  async flush() {
    const pending = this.queue;
    await pending;
    const failure = this.failure;
    this.failure = null;
    if (failure) throw failure.error;
  }
};
var RuntimeProjectLiveIoController = class {
  constructor(options) {
    this.options = options;
    this.eventQueue = options.applyFileChange ? new RuntimeProjectEventQueue() : null;
    this.abortInputSignal = options.signal;
    if (options.signal?.aborted) {
      this.abortController.abort();
    } else if (options.signal) {
      this.abortInputListener = () => this.abortController.abort();
      options.signal.addEventListener("abort", this.abortInputListener, { once: true });
    }
  }
  outputTracker = new RuntimeProjectOutputTracker();
  eventQueue;
  abortController = new AbortController();
  abortInputSignal;
  abortInputListener;
  appliedFileChanges = /* @__PURE__ */ new Map();
  outputBytes = { stdout: 0, stderr: 0 };
  truncatedOutputStreams = /* @__PURE__ */ new Set();
  liveFileChangeCount = 0;
  liveFileChangeBytes = 0;
  pendingFileChanges = 0;
  closed = false;
  emit(event) {
    const budgetedEvent = this.applyEventBudgets(event);
    if (!budgetedEvent) return;
    this.outputTracker.observe(budgetedEvent);
    this.options.onEvent?.(budgetedEvent);
  }
  handleRuntimeEvent(event) {
    if (this.closed || this.abortController.signal.aborted) return;
    if (event.type === "file-change") {
      event = { ...event, change: normalizeRuntimeFileChange(event.change) };
    }
    if (event.type === "file-change" && !this.eventQueue) this.recordLiveFileChangeBudget(event.change);
    if (event.type !== "file-change" && this.pendingFileChanges === 0) {
      this.emit(event);
      return;
    }
    if (!this.eventQueue) {
      this.emit(event);
      return;
    }
    if (event.type === "file-change") this.pendingFileChanges += 1;
    this.eventQueue.enqueue(event, {
      actor: this.options.actor,
      signal: this.abortController.signal,
      applyFileChange: async (change, phase, applyOptions) => {
        try {
          if (this.abortController.signal.aborted) return false;
          if (phase === "live") this.recordLiveFileChangeBudget(change);
          if (this.abortController.signal.aborted) return false;
          const shouldEmit = await this.options.applyFileChange?.(change, phase, applyOptions);
          if (this.abortController.signal.aborted) return false;
          this.appliedFileChanges.set(runtimeFileChangePath(change), JSON.stringify(change));
          return shouldEmit;
        } finally {
          this.pendingFileChanges = Math.max(0, this.pendingFileChanges - 1);
        }
      },
      emit: (nextEvent) => this.emit(nextEvent)
    });
  }
  close() {
    this.closed = true;
    if (this.abortInputSignal && this.abortInputListener) {
      this.abortInputSignal.removeEventListener("abort", this.abortInputListener);
    }
  }
  applyEventBudgets(event) {
    if (event.type !== "output") return event;
    if (this.truncatedOutputStreams.has(event.stream)) return null;
    const used = this.outputBytes[event.stream];
    const remaining = RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES - used;
    const bytes = runtimeProjectUtf8Bytes(event.data);
    if (bytes <= remaining) {
      this.outputBytes[event.stream] = used + bytes;
      return event;
    }
    this.truncatedOutputStreams.add(event.stream);
    const marker = `
[${event.stream} output truncated after ${RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]
`;
    const truncated = `${runtimeProjectTruncateUtf8(event.data, Math.max(0, remaining))}${marker}`;
    this.outputBytes[event.stream] = RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES + runtimeProjectUtf8Bytes(marker);
    return truncated ? { ...event, data: truncated } : null;
  }
  recordLiveFileChangeBudget(change) {
    this.liveFileChangeCount += 1;
    if (this.liveFileChangeCount > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES) {
      throw Object.assign(new Error("EMSGSIZE: TraceKernel live file-change count limit exceeded"), { code: "EMSGSIZE" });
    }
    const size = runtimeFileChangeByteSize(change);
    if (size > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES) {
      throw Object.assign(new Error("EMSGSIZE: TraceKernel live file-change size limit exceeded"), { code: "EMSGSIZE" });
    }
    this.liveFileChangeBytes += size;
    if (this.liveFileChangeBytes > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES) {
      throw Object.assign(new Error("EMSGSIZE: TraceKernel live file-change byte limit exceeded"), { code: "EMSGSIZE" });
    }
  }
  async flush() {
    await this.eventQueue?.flush();
  }
  filterAppliedResultFiles(result) {
    if (this.appliedFileChanges.size === 0) return result;
    const appliedFileChanges = new Map(this.appliedFileChanges);
    this.appliedFileChanges.clear();
    return filterRuntimeCommandResultFiles(result, (change) => {
      const normalized = normalizeRuntimeFileChange(change);
      return appliedFileChanges.get(runtimeFileChangePath(normalized)) === JSON.stringify(normalized);
    });
  }
  emitMissingFinalOutput(result, output) {
    this.outputTracker.emitMissingFinalOutput(result, output);
  }
};

// packages/runtime-contracts/src/runtime-kernel-paths.ts
var RUNTIME_KERNEL_DEVICE_ENTRIES = ["fd/0", "fd/1", "fd/2", "null", "stderr", "stdin", "stdout", "tty"];
function runtimeKernelReadonlyFileErrorMessage(path, operation) {
  return `EROFS: readonly project file, ${operation} '${path}'`;
}
function createRuntimeKernelReadonlyFileError(path, operation) {
  return Object.assign(new Error(runtimeKernelReadonlyFileErrorMessage(path, operation)), { code: "EROFS" });
}
function normalizeRuntimeAbsolutePath(path) {
  const raw = path.replace(/\\/g, "/");
  if (!raw.startsWith("/")) return null;
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`.replace(/\/+$/, "") || "/";
}
function normalizeRuntimeProcPath(path) {
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized === null) return null;
  return normalized === "/proc" || normalized.startsWith("/proc/") ? normalized : null;
}
function normalizeRuntimeDevicePath(path) {
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized === null) return null;
  if (normalized === "/dev") return "/dev";
  if (normalized === "/dev/stdin" || normalized === "/dev/stdout" || normalized === "/dev/stderr" || normalized === "/dev/fd/0" || normalized === "/dev/fd/1" || normalized === "/dev/fd/2" || normalized === "/dev/null" || normalized === "/dev/tty") {
    return normalized;
  }
  return null;
}
function normalizeRuntimeKernelManifestDevicePath(path) {
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized === null || normalized === "/dev" || !normalized.startsWith("/dev/")) return null;
  return normalized.slice("/dev/".length).length > 0 ? normalized : null;
}
var RUNTIME_KERNEL_IDENTITY_FILE_NAMES = [
  "group",
  "hostname",
  "hosts",
  "nsswitch.conf",
  "os-release",
  "passwd",
  "shells"
];
function isRuntimeKernelIdentityNamespacePath(path) {
  const normalized = normalizeRuntimeAbsolutePath(path);
  return normalized === "/etc" || normalized?.startsWith("/etc/") === true;
}
function runtimeKernelIdentityDirEntries(path) {
  return normalizeRuntimeAbsolutePath(path) === "/etc" ? [...RUNTIME_KERNEL_IDENTITY_FILE_NAMES] : null;
}
function runtimeKernelIdentityEntryKind(path) {
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized === "/etc") return "directory";
  return normalized && RUNTIME_KERNEL_IDENTITY_FILE_NAMES.some((name) => normalized === "/etc/" + name) ? "file" : null;
}
function quoteOsReleaseValue(value) {
  return '"' + value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"') + '"';
}
function readRuntimeKernelIdentityFile(path, info) {
  const normalized = normalizeRuntimeAbsolutePath(path);
  const username = info.user.username;
  const hostname = info.host.hostname;
  if (normalized === "/etc/os-release") {
    return [
      'NAME="TraceKernel"',
      "ID=tracekernel",
      "VERSION_ID=" + quoteOsReleaseValue(info.version),
      "PRETTY_NAME=" + quoteOsReleaseValue("TraceKernel " + info.version),
      ""
    ].join("\n");
  }
  if (normalized === "/etc/passwd") {
    return [
      "root:x:0:0:root:/root:/bin/sh",
      username + ":x:1000:1000:TraceKernel " + username + ":" + info.home + ":/bin/bash",
      ""
    ].join("\n");
  }
  if (normalized === "/etc/group") {
    return [
      "root:x:0:",
      username + ":x:1000:" + username,
      ""
    ].join("\n");
  }
  if (normalized === "/etc/hostname") return hostname + "\n";
  if (normalized === "/etc/hosts") {
    return "127.0.0.1 localhost " + hostname + "\n::1 localhost " + hostname + "\n";
  }
  if (normalized === "/etc/nsswitch.conf") {
    return "passwd: files\ngroup: files\nhosts: files dns\n";
  }
  if (normalized === "/etc/shells") return "/bin/sh\n/bin/bash\n";
  if (normalized === "/etc") {
    throw Object.assign(new Error("EISDIR: illegal operation on a directory, read '" + path + "'"), { code: "EISDIR" });
  }
  throw Object.assign(new Error("ENOENT: no such file or directory, open '" + path + "'"), { code: "ENOENT" });
}
function classifyRuntimeKernelVirtualPath(path) {
  const procPath = normalizeRuntimeProcPath(path);
  if (procPath !== null) return { kind: "proc", path: procPath };
  const identityPath = normalizeRuntimeAbsolutePath(path);
  if (identityPath && isRuntimeKernelIdentityNamespacePath(identityPath)) {
    return { kind: "identity", path: identityPath };
  }
  const devicePath = normalizeRuntimeDevicePath(path);
  if (devicePath === "/dev") return { kind: "device-directory", path: devicePath };
  if (devicePath !== null) return { kind: "device", path: devicePath };
  const normalized = normalizeRuntimeAbsolutePath(path);
  if (normalized?.startsWith("/dev/") === true) return { kind: "device-namespace", path: normalized };
  return null;
}
function runtimeDeviceCanRead(device) {
  return device === "/dev/stdin" || device === "/dev/fd/0" || device === "/dev/tty" || device === "/dev/null";
}
function runtimeDeviceCanWrite(device) {
  return device === "/dev/stdout" || device === "/dev/fd/1" || device === "/dev/stderr" || device === "/dev/fd/2" || device === "/dev/tty" || device === "/dev/null";
}
function runtimeDeviceInputSource(device) {
  if (!runtimeDeviceCanRead(device)) return null;
  return device === "/dev/null" ? "/dev/null" : "/dev/stdin";
}
function runtimeDeviceOutputTarget(device) {
  if (!runtimeDeviceCanWrite(device)) return null;
  if (device === "/dev/null") return "/dev/null";
  if (device === "/dev/fd/1") return "/dev/stdout";
  if (device === "/dev/fd/2") return "/dev/stderr";
  return device === "/dev/tty" ? "/dev/stdout" : device;
}
function runtimeKernelDeviceInfo(devices, device) {
  const entries = devices ?? runtimeKernelVirtualDevices();
  return entries.find((entry) => normalizeRuntimeKernelManifestDevicePath(entry.path) === device) ?? null;
}
function normalizeDeviceReference(value) {
  if (!value) return null;
  return normalizeRuntimeKernelManifestDevicePath(value);
}
function runtimeKernelDeviceInputSource(devices, device) {
  const info = runtimeKernelDeviceInfo(devices, device);
  if (!info?.readable) return null;
  return normalizeDeviceReference(info.inputDevice) ?? device;
}
function runtimeKernelDeviceInputRoute(devices, device) {
  const inputDevice = devices ? runtimeKernelDeviceInputSource(devices, device) : runtimeDeviceInputSource(device);
  if (!inputDevice || inputDevice === "/dev/null") return null;
  return {
    inputDevice,
    ...device !== inputDevice ? { sourceDevice: device } : {}
  };
}
function runtimeKernelDeviceOutputTarget(devices, device) {
  const info = runtimeKernelDeviceInfo(devices, device);
  if (!info?.writable) return null;
  return normalizeDeviceReference(info.outputDevice) ?? device;
}
function runtimeKernelDeviceOutputRoute(devices, device) {
  const outputDevice = devices ? runtimeKernelDeviceOutputTarget(devices, device) : runtimeDeviceOutputTarget(device);
  if (!outputDevice || outputDevice === "/dev/null") return null;
  return {
    outputDevice,
    stream: outputDevice === "/dev/stderr" ? "stderr" : "stdout",
    ...device !== outputDevice ? { sourceDevice: device } : {}
  };
}
function runtimeDeviceDirEntries(path, devices) {
  const directoryPath = path === "/dev" ? "/dev" : normalizeRuntimeKernelManifestDevicePath(path);
  if (!directoryPath) return null;
  const entries = devices ?? runtimeKernelVirtualDevices();
  const prefix = directoryPath === "/dev" ? "/dev/" : `${directoryPath}/`;
  const names = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    const devicePath = normalizeRuntimeKernelManifestDevicePath(entry.path);
    if (!devicePath?.startsWith(prefix)) continue;
    const remainder = devicePath.slice(prefix.length);
    const [name] = remainder.split("/");
    if (name) names.add(name);
  }
  if (directoryPath !== "/dev" && names.size === 0) return null;
  return Array.from(names).sort();
}
function runtimeDeviceEntryKind(path, devices) {
  if (path === "/dev") return "directory";
  const devicePath = normalizeRuntimeKernelManifestDevicePath(path);
  if (devicePath && devices && runtimeKernelDeviceInfo(devices, devicePath)) return "file";
  if (devicePath && runtimeDeviceDirEntries(devicePath, devices)) return "directory";
  return "file";
}
function runtimeDeviceStat(path, devices) {
  const kind = runtimeDeviceEntryKind(path, devices);
  const isDirectory = kind === "directory";
  return {
    isFile: !isDirectory,
    isDirectory,
    isCharacterDevice: !isDirectory,
    mode: isDirectory ? 493 : 438,
    size: 0,
    uid: 0,
    gid: 0,
    owner: "root",
    group: "root"
  };
}
function runtimeKernelVirtualDevices() {
  return RUNTIME_KERNEL_DEVICE_ENTRIES.map((name) => {
    const path = `/dev/${name}`;
    const inputDevice = runtimeDeviceInputSource(path) ?? void 0;
    const outputDevice = runtimeDeviceOutputTarget(path) ?? void 0;
    return {
      path,
      readable: inputDevice !== void 0,
      writable: outputDevice !== void 0,
      ...inputDevice ? { inputDevice } : {},
      ...outputDevice ? { outputDevice } : {}
    };
  });
}

// packages/runtime-contracts/src/runtime-kernel-proc.ts
function runtimeProcInfoJson(info) {
  return `${JSON.stringify(info, null, 2)}
`;
}
function publicRuntimeKernelInfo(info) {
  const workspaceRoot = "/workspace";
  const home = "/home/user";
  const workspaceName = "workspace";
  return {
    name: info.name,
    version: info.version,
    user: {
      id: "user",
      username: "user",
      home
    },
    host: {
      hostname: "tracevm",
      osName: "tracekernel"
    },
    workspace: {
      id: workspaceName,
      name: workspaceName,
      root: workspaceRoot,
      startedAt: "1970-01-01T00:00:00.000Z"
    },
    home,
    cwd: workspaceRoot,
    workspaceRoot
  };
}
function runtimeMountInfoField(value) {
  return value.replace(/\\/g, "\\134").replace(/ /g, "\\040").replace(/\t/g, "\\011").replace(/\n/g, "\\012");
}
function runtimeKernelMounts(info) {
  const workspaceName = `name=${info.workspace.name}`;
  const mounts = [
    {
      id: 20,
      parentId: 0,
      device: "0:0",
      root: "/",
      target: "/",
      type: "tracefs",
      source: "tracekernel:system",
      options: ["ro", "relatime"],
      superOptions: ["ro"]
    },
    {
      id: 21,
      parentId: 20,
      device: "0:6",
      root: "/",
      target: "/tmp",
      type: "tracefs",
      source: "tracekernel:tmp",
      options: ["rw", "nosuid", "nodev"],
      superOptions: ["rw", "mode=1777"]
    },
    {
      id: 22,
      parentId: 20,
      device: "0:7",
      root: "/",
      target: "/var/tmp",
      type: "tracefs",
      source: "tracekernel:var-tmp",
      options: ["rw", "nosuid", "nodev"],
      superOptions: ["rw", "mode=1777"]
    },
    {
      id: 24,
      parentId: 20,
      device: "0:1",
      root: "/",
      target: info.workspaceRoot,
      type: "tracefs",
      source: "tracekernel:workspace",
      options: ["rw", "relatime"],
      superOptions: ["rw", workspaceName]
    },
    {
      id: 25,
      parentId: 20,
      device: "0:2",
      root: "/",
      target: "/dev",
      type: "tracefs",
      source: "tracekernel:dev",
      options: ["rw", "nosuid"],
      superOptions: ["rw", "mode=755"]
    },
    {
      id: 26,
      parentId: 20,
      device: "0:3",
      root: "/",
      target: "/proc",
      type: "traceproc",
      source: "tracekernel:proc",
      options: ["ro", "nosuid", "nodev", "noexec"],
      superOptions: ["ro"]
    },
    {
      id: 28,
      parentId: 20,
      device: "0:4",
      root: "/",
      target: "/tracekernel",
      type: "tracefs",
      source: "tracekernel:control",
      options: ["ro", "nosuid", "nodev", "noexec"],
      superOptions: ["ro"]
    },
    {
      id: 29,
      parentId: 20,
      device: "0:5",
      root: "/",
      target: "/skills",
      type: "tracefs",
      source: "tracekernel:skills",
      options: ["ro", "nosuid", "nodev", "noexec"],
      superOptions: ["ro"]
    }
  ];
  if (info.workspaceAlias && info.workspaceAlias !== info.workspaceRoot) {
    mounts.splice(1, 0, {
      id: 27,
      parentId: 20,
      device: "0:1",
      root: "/",
      target: info.workspaceAlias,
      type: "tracefs",
      source: "tracekernel:workspace",
      options: ["rw", "relatime"],
      superOptions: ["rw", workspaceName],
      optionalFields: [`alias=${info.workspaceRoot}`]
    });
  }
  return mounts;
}
function runtimeProcMountInfo(info) {
  return runtimeKernelMounts(info).map((mount) => [
    mount.id,
    mount.parentId,
    mount.device,
    runtimeMountInfoField(mount.root),
    runtimeMountInfoField(mount.target),
    mount.options.join(","),
    ...(mount.optionalFields ?? []).map(runtimeMountInfoField),
    "-",
    mount.type,
    runtimeMountInfoField(mount.source),
    mount.superOptions.map(runtimeMountInfoField).join(",")
  ].join(" ")).join("\n") + "\n";
}
function runtimeProcMounts(info) {
  return runtimeKernelMounts(info).map((mount) => [
    runtimeMountInfoField(mount.source),
    runtimeMountInfoField(mount.target),
    mount.type,
    mount.options.map(runtimeMountInfoField).join(","),
    "0",
    "0"
  ].join(" ")).join("\n") + "\n";
}
function runtimeProcKernelVersion(info) {
  return `${info.name} ${info.version}
`;
}
function runtimeProcDirEntries(path) {
  if (path === "/proc") return ["kernel", "mounts", "self"];
  if (path === "/proc/kernel") return ["info", "version"];
  if (path === "/proc/self") return ["mountinfo"];
  return null;
}
function runtimeProcEntryKind(path) {
  if (runtimeProcDirEntries(path)) return "directory";
  if (path === "/proc/kernel/info" || path === "/proc/kernel/version" || path === "/proc/mounts" || path === "/proc/self/mountinfo") return "file";
  return null;
}
function runtimeKernelIdentityStat(path, info) {
  const kind = runtimeKernelIdentityEntryKind(path);
  if (!kind) return null;
  const isDirectory = kind === "directory";
  const content = isDirectory ? "" : readRuntimeKernelIdentityFile(path, info);
  return {
    isFile: !isDirectory,
    isDirectory,
    isCharacterDevice: false,
    mode: isDirectory ? 493 : 420,
    size: new TextEncoder().encode(content).byteLength,
    uid: 0,
    gid: 0,
    owner: "root",
    group: "root"
  };
}
function readRuntimeProcFile(path, info) {
  if (path === "/proc/kernel/info") return runtimeProcInfoJson(info);
  if (path === "/proc/kernel/version") return runtimeProcKernelVersion(info);
  if (path === "/proc/mounts") return runtimeProcMounts(info);
  if (path === "/proc/self/mountinfo") return runtimeProcMountInfo(info);
  if (runtimeProcDirEntries(path)) {
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), { code: "EISDIR" });
  }
  throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
}
function readPublicRuntimeProcFile(path, info) {
  return readRuntimeProcFile(path, publicRuntimeKernelInfo(info));
}
function runtimeProcStat(path, info) {
  const kind = runtimeProcEntryKind(path);
  if (!kind) return null;
  const isDirectory = kind === "directory";
  return {
    isFile: !isDirectory,
    isDirectory,
    isCharacterDevice: false,
    mode: isDirectory ? 365 : 292,
    size: isDirectory ? 0 : new TextEncoder().encode(readRuntimeProcFile(path, info)).byteLength,
    uid: 0,
    gid: 0,
    owner: "root",
    group: "root"
  };
}

// packages/runtime-contracts/src/runtime-kernel-filesystem.ts
function runtimeKernelWriteTarget(path, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "proc" || virtualPath.kind === "identity") {
    return { kind: "error", reason: "proc-read-only", path: virtualPath.path };
  }
  if (virtualPath.kind === "device-directory") {
    return { kind: "error", reason: "device-directory", path: virtualPath.path };
  }
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    if (device && !runtimeKernelDeviceInfo(devices, device) && runtimeDeviceDirEntries(device, devices)) {
      return { kind: "error", reason: "device-directory", path: device };
    }
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: "error", reason: "device-not-found", path: virtualPath.path };
    }
    const outputDevice2 = runtimeKernelDeviceOutputTarget(devices, device);
    if (!outputDevice2) {
      return { kind: "error", reason: "device-read-only", path: virtualPath.path };
    }
    return { kind: "device", device, outputDevice: outputDevice2 };
  }
  const outputDevice = devices ? runtimeKernelDeviceOutputTarget(devices, virtualPath.path) : runtimeDeviceOutputTarget(virtualPath.path);
  if (!outputDevice) {
    return { kind: "error", reason: "device-read-only", path: virtualPath.path };
  }
  return { kind: "device", device: virtualPath.path, outputDevice };
}
function runtimeKernelWriteErrorCode(reason) {
  if (reason === "proc-read-only") return "EROFS";
  if (reason === "device-directory") return "EISDIR";
  if (reason === "device-read-only") return "EBADF";
  return "ENOENT";
}
function runtimeKernelWriteFsErrorMessage(path, target, operation = "open") {
  const code = runtimeKernelWriteErrorCode(target.reason);
  if (code === "EROFS") return `EROFS: read-only file system, ${operation} '${path}'`;
  if (code === "EBADF") return `EBADF: bad file descriptor, write`;
  if (code === "EISDIR") return `EISDIR: illegal operation on a directory, ${operation} '${path}'`;
  return `ENOENT: no such file or directory, ${operation} '${path}'`;
}
function runtimeKernelMutationTarget(path, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "proc" || virtualPath.kind === "identity") {
    return { kind: "error", reason: "proc-read-only", path: virtualPath.path };
  }
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    if (device && !runtimeKernelDeviceInfo(devices, device) && runtimeDeviceDirEntries(device, devices)) {
      return { kind: "error", reason: "device-read-only", path: device };
    }
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: "error", reason: "device-not-found", path: virtualPath.path };
    }
    return { kind: "error", reason: "device-read-only", path: virtualPath.path };
  }
  if (virtualPath.kind === "device" && devices && !runtimeKernelDeviceInfo(devices, virtualPath.path)) {
    return { kind: "error", reason: "device-not-found", path: virtualPath.path };
  }
  return { kind: "error", reason: "device-read-only", path: virtualPath.path };
}
function runtimeKernelMutationErrorCode(reason) {
  return reason === "device-not-found" ? "ENOENT" : "EROFS";
}
function runtimeKernelMutationFsErrorMessage(path, target, operation, destination) {
  const suffix = destination === void 0 ? `${operation} '${path}'` : `${operation} '${path}' -> '${destination}'`;
  const code = runtimeKernelMutationErrorCode(target.reason);
  if (code === "ENOENT") return `ENOENT: no such file or directory, ${suffix}`;
  return `EROFS: read-only file system, ${suffix}`;
}
function runtimeKernelMetadataTarget(path, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "proc" || virtualPath.kind === "identity") {
    return { kind: "error", reason: "proc-read-only", path: virtualPath.path };
  }
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    if (device && !runtimeKernelDeviceInfo(devices, device) && runtimeDeviceDirEntries(device, devices)) {
      return { kind: "ignored-device", path: device };
    }
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: "error", reason: "device-not-found", path: virtualPath.path };
    }
    return { kind: "ignored-device", path: device };
  }
  if (virtualPath.kind === "device" && devices && !runtimeKernelDeviceInfo(devices, virtualPath.path)) {
    return { kind: "error", reason: "device-not-found", path: virtualPath.path };
  }
  return { kind: "ignored-device", path: virtualPath.path };
}
function runtimeKernelMetadataErrorCode(reason) {
  return reason === "proc-read-only" ? "EROFS" : "ENOENT";
}
function runtimeKernelAccessTarget(path, request = {}, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    const info = device ? runtimeKernelDeviceInfo(devices, device) : null;
    if (device && !info && runtimeDeviceDirEntries(device, devices)) {
      return request.write || request.execute ? { kind: "denied", reason: "permission-denied", path: device } : { kind: "allowed", path: device };
    }
    if (!device || !info) return { kind: "denied", reason: "not-found", path: virtualPath.path };
    return request.read && !info.readable || request.write && !info.writable || request.execute ? { kind: "denied", reason: "permission-denied", path: device } : { kind: "allowed", path: device };
  }
  if (virtualPath.kind === "device-directory") {
    return request.write || request.execute ? { kind: "denied", reason: "permission-denied", path: virtualPath.path } : { kind: "allowed", path: virtualPath.path };
  }
  if (virtualPath.kind === "device") {
    const info = devices ? runtimeKernelDeviceInfo(devices, virtualPath.path) : null;
    if (devices && !info) return { kind: "denied", reason: "not-found", path: virtualPath.path };
    const readable = info ? info.readable : runtimeDeviceCanRead(virtualPath.path);
    const writable = info ? info.writable : runtimeDeviceCanWrite(virtualPath.path);
    return request.read && !readable || request.write && !writable || request.execute ? { kind: "denied", reason: "permission-denied", path: virtualPath.path } : { kind: "allowed", path: virtualPath.path };
  }
  const readonlyEntryKind = virtualPath.kind === "identity" ? runtimeKernelIdentityEntryKind(virtualPath.path) : runtimeProcEntryKind(virtualPath.path);
  if (!readonlyEntryKind) {
    return { kind: "denied", reason: "not-found", path: virtualPath.path };
  }
  return request.write || request.execute ? { kind: "denied", reason: "permission-denied", path: virtualPath.path } : { kind: "allowed", path: virtualPath.path };
}
function runtimeKernelOpenTarget(path, request = {}, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    const info = device ? runtimeKernelDeviceInfo(devices, device) : null;
    if (device && !info && runtimeDeviceDirEntries(device, devices)) {
      return { kind: "error", reason: "is-directory", path: device };
    }
    if (!device || !info) return { kind: "error", reason: "not-found", path: virtualPath.path };
    return {
      kind: "device",
      device,
      readable: info.readable && request.readable === true,
      writable: info.writable && request.writable === true
    };
  }
  if (virtualPath.kind === "device-directory") {
    return { kind: "error", reason: "is-directory", path: virtualPath.path };
  }
  if (virtualPath.kind === "device") {
    const info = devices ? runtimeKernelDeviceInfo(devices, virtualPath.path) : null;
    if (devices && !info) return { kind: "error", reason: "not-found", path: virtualPath.path };
    return {
      kind: "device",
      device: virtualPath.path,
      readable: info ? info.readable && request.readable === true : runtimeDeviceCanRead(virtualPath.path) && request.readable === true,
      writable: info ? info.writable && request.writable === true : runtimeDeviceCanWrite(virtualPath.path) && request.writable === true
    };
  }
  const entryKind = virtualPath.kind === "identity" ? runtimeKernelIdentityEntryKind(virtualPath.path) : runtimeProcEntryKind(virtualPath.path);
  if (!entryKind) {
    return { kind: "error", reason: "not-found", path: virtualPath.path };
  }
  if (entryKind === "directory") {
    return { kind: "error", reason: "is-directory", path: virtualPath.path };
  }
  if (request.writable || request.create || request.truncate || request.exclusive) {
    return { kind: "error", reason: "read-only", path: virtualPath.path };
  }
  return { kind: "proc-file", path: virtualPath.path, readable: true, writable: false };
}
function runtimeKernelOpenErrorCode(reason) {
  if (reason === "is-directory") return "EISDIR";
  if (reason === "read-only") return "EROFS";
  return "ENOENT";
}
function runtimeKernelOpenErrorMessage(path, target, operation = "open") {
  const code = runtimeKernelOpenErrorCode(target.reason);
  if (code === "EROFS") return `EROFS: read-only file system, ${operation} '${path}'`;
  if (code === "EISDIR") return `EISDIR: illegal operation on a directory, ${operation} '${path}'`;
  return `ENOENT: no such file or directory, ${operation} '${path}'`;
}
function runtimeKernelReadTarget(path, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    const info = device ? runtimeKernelDeviceInfo(devices, device) : null;
    if (device && !info && runtimeDeviceDirEntries(device, devices)) {
      return { kind: "device-directory", path: device };
    }
    if (!device || !info) return { kind: "error", reason: "not-found", path: virtualPath.path };
    return info.readable ? { kind: "device-file", path: device } : { kind: "error", reason: "permission-denied", path: virtualPath.path };
  }
  if (virtualPath.kind === "device-directory") return virtualPath;
  if (virtualPath.kind === "device") {
    const info = devices ? runtimeKernelDeviceInfo(devices, virtualPath.path) : null;
    if (devices && !info) return { kind: "error", reason: "not-found", path: virtualPath.path };
    const readable = info ? info.readable : runtimeDeviceCanRead(virtualPath.path);
    return readable ? { kind: "device-file", path: virtualPath.path } : { kind: "error", reason: "permission-denied", path: virtualPath.path };
  }
  const kind = virtualPath.kind === "identity" ? runtimeKernelIdentityEntryKind(virtualPath.path) : runtimeProcEntryKind(virtualPath.path);
  if (kind === "file") return { kind: "proc-file", path: virtualPath.path };
  if (kind === "directory") return { kind: "proc-directory", path: virtualPath.path };
  return { kind: "error", reason: "not-found", path: virtualPath.path };
}
function runtimeKernelFileReadTarget(path, devices) {
  const readTarget = runtimeKernelReadTarget(path, devices);
  if (readTarget.kind === "device-file" || readTarget.kind === "proc-file" || readTarget.kind === "workspace") {
    return readTarget;
  }
  if (readTarget.kind === "device-directory" || readTarget.kind === "proc-directory") {
    return { kind: "error", reason: "is-directory", path: readTarget.path };
  }
  return readTarget;
}
function runtimeKernelFileReadErrorCode(reason) {
  if (reason === "permission-denied") return "EBADF";
  return reason === "is-directory" ? "EISDIR" : "ENOENT";
}
function runtimeKernelFileReadFsErrorMessage(path, target, operation = "open") {
  const code = runtimeKernelFileReadErrorCode(target.reason);
  if (code === "EBADF") return `EBADF: bad file descriptor, ${operation} '${path}'`;
  if (code === "EISDIR") return `EISDIR: illegal operation on a directory, ${operation} '${path}'`;
  return `ENOENT: no such file or directory, ${operation} '${path}'`;
}
function runtimeKernelStatTarget(path, info, devices) {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: "workspace" };
  if (virtualPath.kind === "device-directory") {
    return { kind: "stat", path: virtualPath.path, stat: runtimeDeviceStat(virtualPath.path, devices) };
  }
  if (virtualPath.kind === "device-namespace") {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      if (device && runtimeDeviceDirEntries(device, devices)) {
        return { kind: "stat", path: device, stat: runtimeDeviceStat(device, devices) };
      }
      return { kind: "error", reason: "not-found", path: virtualPath.path };
    }
    return { kind: "stat", path: device, stat: runtimeDeviceStat(device, devices) };
  }
  if (virtualPath.kind === "device") {
    if (devices && !runtimeKernelDeviceInfo(devices, virtualPath.path)) {
      return { kind: "error", reason: "not-found", path: virtualPath.path };
    }
    return { kind: "stat", path: virtualPath.path, stat: runtimeDeviceStat(virtualPath.path, devices) };
  }
  const stat = virtualPath.kind === "identity" ? runtimeKernelIdentityStat(virtualPath.path, info) : runtimeProcStat(virtualPath.path, info);
  return stat ? { kind: "stat", path: virtualPath.path, stat } : { kind: "error", reason: "not-found", path: virtualPath.path };
}
function runtimeKernelDirectoryTarget(path, devices) {
  const readTarget = runtimeKernelReadTarget(path, devices);
  if (readTarget.kind === "workspace") return readTarget;
  if (readTarget.kind === "device-directory") {
    return {
      kind: "directory",
      path: readTarget.path,
      entries: (runtimeDeviceDirEntries(readTarget.path, devices) ?? []).map((name) => ({
        name,
        kind: runtimeDeviceEntryKind(`${readTarget.path === "/dev" ? "/dev" : readTarget.path}/${name}`, devices)
      }))
    };
  }
  if (readTarget.kind === "proc-directory") {
    const identityEntries = runtimeKernelIdentityDirEntries(readTarget.path);
    return {
      kind: "directory",
      path: readTarget.path,
      entries: (identityEntries ?? runtimeProcDirEntries(readTarget.path) ?? []).map((name) => ({
        name,
        kind: identityEntries ? runtimeKernelIdentityEntryKind(readTarget.path + "/" + name) ?? "file" : runtimeProcEntryKind(readTarget.path + "/" + name) ?? "file"
      }))
    };
  }
  if (readTarget.kind === "device-file" || readTarget.kind === "proc-file") {
    return { kind: "error", reason: "not-directory", path: readTarget.path };
  }
  if (readTarget.reason === "permission-denied") {
    return { kind: "error", reason: "not-directory", path: readTarget.path };
  }
  return { kind: "error", reason: "not-found", path: readTarget.path };
}
function runtimeKernelDirectoryErrorCode(reason) {
  return reason === "not-directory" ? "ENOTDIR" : "ENOENT";
}
function runtimeKernelCopyTarget(source, destination, devices) {
  const sourceTarget = runtimeKernelReadTarget(source, devices);
  const writeTarget = runtimeKernelWriteTarget(destination, devices);
  if (sourceTarget.kind === "device-file" || sourceTarget.kind === "proc-file" || writeTarget.kind === "device" || writeTarget.kind === "error") {
    return { kind: "file-copy" };
  }
  if (sourceTarget.kind === "device-directory" || sourceTarget.kind === "proc-directory") {
    return { kind: "error", reason: "source-directory", path: sourceTarget.path };
  }
  if (sourceTarget.kind === "error") {
    return { kind: "error", reason: "source-not-found", path: sourceTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelCopyErrorCode(reason) {
  return reason === "source-directory" ? "EISDIR" : "ENOENT";
}
function runtimeKernelCopyErrorMessage(source, destination, target, operation = "cp") {
  const code = runtimeKernelCopyErrorCode(target.reason);
  if (code === "EISDIR") return `EISDIR: illegal operation on a directory, ${operation} '${source}'`;
  return `ENOENT: no such file or directory, ${operation} '${source}' -> '${destination}'`;
}
function runtimeKernelFileCopyTarget(source, destination, devices) {
  const writeTarget = runtimeKernelWriteTarget(destination, devices);
  if (writeTarget.kind === "error") {
    return { kind: "error", side: "destination", reason: writeTarget.reason, path: writeTarget.path };
  }
  const sourceTarget = runtimeKernelFileReadTarget(source, devices);
  if (sourceTarget.kind === "error") {
    return { kind: "error", side: "source", reason: sourceTarget.reason, path: sourceTarget.path };
  }
  if (writeTarget.kind === "device") {
    return { kind: "device-destination", device: writeTarget.device, outputDevice: writeTarget.outputDevice, source: sourceTarget };
  }
  if (sourceTarget.kind === "device-file" || sourceTarget.kind === "proc-file") {
    return { kind: "virtual-source", source: sourceTarget };
  }
  return { kind: "workspace" };
}
function runtimeKernelFileCopyErrorCode(target) {
  return target.side === "destination" ? runtimeKernelWriteErrorCode(target.reason) : runtimeKernelFileReadErrorCode(target.reason);
}
function runtimeKernelFileCopyErrorMessage(source, destination, target, operation = "copyfile") {
  const code = runtimeKernelFileCopyErrorCode(target);
  const suffix = `${operation} '${source}' -> '${destination}'`;
  if (code === "EROFS") return `EROFS: read-only file system, ${suffix}`;
  if (code === "EBADF") return `EBADF: bad file descriptor, ${suffix}`;
  if (code === "EISDIR") return `EISDIR: illegal operation on a directory, ${suffix}`;
  return `ENOENT: no such file or directory, ${suffix}`;
}
function runtimeKernelLinkTarget(source, destination, devices) {
  const sourceTarget = runtimeKernelMutationTarget(source, devices);
  if (sourceTarget.kind === "error") {
    return { kind: "error", side: "source", reason: sourceTarget.reason, path: sourceTarget.path };
  }
  const destinationTarget = runtimeKernelMutationTarget(destination, devices);
  if (destinationTarget.kind === "error") {
    return { kind: "error", side: "destination", reason: destinationTarget.reason, path: destinationTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelLinkErrorCode(reason) {
  return runtimeKernelMutationErrorCode(reason);
}
function runtimeKernelRenameTarget(source, destination, devices) {
  const sourceTarget = runtimeKernelMutationTarget(source, devices);
  if (sourceTarget.kind === "error") {
    return { kind: "error", side: "source", reason: sourceTarget.reason, path: sourceTarget.path };
  }
  const destinationTarget = runtimeKernelMutationTarget(destination, devices);
  if (destinationTarget.kind === "error") {
    return { kind: "error", side: "destination", reason: destinationTarget.reason, path: destinationTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelRenameErrorCode(reason) {
  return runtimeKernelMutationErrorCode(reason);
}
function runtimeKernelSymlinkTarget(linkPath, devices) {
  const linkTarget = runtimeKernelMutationTarget(linkPath, devices);
  if (linkTarget.kind === "error") {
    return { kind: "error", reason: linkTarget.reason, path: linkTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelSymlinkErrorCode(reason) {
  return runtimeKernelMutationErrorCode(reason);
}
function runtimeKernelRemoveTarget(path, devices) {
  const removeTarget = runtimeKernelMutationTarget(path, devices);
  if (removeTarget.kind === "error") {
    return { kind: "error", reason: removeTarget.reason, path: removeTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelRemoveErrorCode(reason) {
  return runtimeKernelMutationErrorCode(reason);
}
function runtimeKernelMkdirTarget(path, devices) {
  const mkdirTarget = runtimeKernelMutationTarget(path, devices);
  if (mkdirTarget.kind === "error") {
    return { kind: "error", reason: mkdirTarget.reason, path: mkdirTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelMkdirErrorCode(reason) {
  return runtimeKernelMutationErrorCode(reason);
}
function runtimeKernelTruncateTarget(path, devices) {
  const truncateTarget = runtimeKernelMutationTarget(path, devices);
  if (truncateTarget.kind === "error") {
    return { kind: "error", reason: truncateTarget.reason, path: truncateTarget.path };
  }
  return { kind: "workspace" };
}
function runtimeKernelTruncateErrorCode(reason) {
  return runtimeKernelMutationErrorCode(reason);
}

// packages/runtime-javascript/src/kernel/path-normalization.ts
function normalizeProjectPath(path) {
  const cleaned = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/workspace\//, "");
  const parts = [];
  for (const part of cleaned.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}
function dirname(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}
function workspaceCwdPath(request) {
  const projectCwd = request.project.cwd ?? "/workspace";
  if (request.cwd === projectCwd) return "";
  if (request.cwd.startsWith(`${projectCwd}/`)) {
    return normalizeProjectPath(request.cwd.slice(projectCwd.length + 1));
  }
  throw new Error(`Project cwd must stay inside the workspace: ${request.cwd}`);
}

// node_modules/fflate/esm/browser.js
var browser_exports = {};
__export(browser_exports, {
  AsyncCompress: () => AsyncGzip,
  AsyncDecompress: () => AsyncDecompress,
  AsyncDeflate: () => AsyncDeflate,
  AsyncGunzip: () => AsyncGunzip,
  AsyncGzip: () => AsyncGzip,
  AsyncInflate: () => AsyncInflate,
  AsyncUnzipInflate: () => AsyncUnzipInflate,
  AsyncUnzlib: () => AsyncUnzlib,
  AsyncZipDeflate: () => AsyncZipDeflate,
  AsyncZlib: () => AsyncZlib,
  Compress: () => Gzip,
  DecodeUTF8: () => DecodeUTF8,
  Decompress: () => Decompress,
  Deflate: () => Deflate,
  EncodeUTF8: () => EncodeUTF8,
  FlateErrorCode: () => FlateErrorCode,
  Gunzip: () => Gunzip,
  Gzip: () => Gzip,
  Inflate: () => Inflate,
  Unzip: () => Unzip,
  UnzipInflate: () => UnzipInflate,
  UnzipPassThrough: () => UnzipPassThrough,
  Unzlib: () => Unzlib,
  Zip: () => Zip,
  ZipDeflate: () => ZipDeflate,
  ZipPassThrough: () => ZipPassThrough,
  Zlib: () => Zlib,
  compress: () => gzip,
  compressSync: () => gzipSync,
  decompress: () => decompress,
  decompressSync: () => decompressSync,
  deflate: () => deflate,
  deflateSync: () => deflateSync,
  gunzip: () => gunzip,
  gunzipSync: () => gunzipSync,
  gzip: () => gzip,
  gzipSync: () => gzipSync,
  inflate: () => inflate,
  inflateSync: () => inflateSync,
  strFromU8: () => strFromU8,
  strToU8: () => strToU8,
  unzip: () => unzip,
  unzipSync: () => unzipSync,
  unzlib: () => unzlib,
  unzlibSync: () => unzlibSync,
  zip: () => zip,
  zipSync: () => zipSync,
  zlib: () => zlib,
  zlibSync: () => zlibSync
});
var ch2 = {};
var wk = (function(c, id, msg, transfer, cb) {
  var w = new Worker(ch2[id] || (ch2[id] = URL.createObjectURL(new Blob([
    c + ';addEventListener("error",function(e){e=e.error;postMessage({$e$:[e.message,e.code,e.stack]})})'
  ], { type: "text/javascript" }))));
  w.onmessage = function(e) {
    var d = e.data, ed = d.$e$;
    if (ed) {
      var err2 = new Error(ed[0]);
      err2["code"] = ed[1];
      err2.stack = ed[2];
      cb(err2, null);
    } else
      cb(null, d);
  };
  w.postMessage(msg, transfer);
  return w;
});
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (; i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1; i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flm = /* @__PURE__ */ hMap(flt, 9, 0);
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var FlateErrorCode = {
  UnexpectedEOF: 0,
  InvalidBlockType: 1,
  InvalidLengthLiteral: 2,
  InvalidDistance: 3,
  StreamFinished: 4,
  NoStreamHandler: 5,
  InvalidHeader: 6,
  NoCallback: 7,
  InvalidUTF8: 8,
  ExtraFieldTooLong: 9,
  InvalidDate: 10,
  FilenameTooLong: 11,
  StreamFinishing: 12,
  InvalidZipData: 13,
  UnknownCompressionMethod: 14
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0; i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var wbits = function(d, p, v) {
  v <<= p & 7;
  var o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
};
var wbits16 = function(d, p, v) {
  v <<= p & 7;
  var o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
  d[o + 2] |= v >> 16;
};
var hTree = function(d, mb) {
  var t = [];
  for (var i = 0; i < d.length; ++i) {
    if (d[i])
      t.push({ s: i, f: d[i] });
  }
  var s = t.length;
  var t2 = t.slice();
  if (!s)
    return { t: et, l: 0 };
  if (s == 1) {
    var v = new u8(t[0].s + 1);
    v[t[0].s] = 1;
    return { t: v, l: 1 };
  }
  t.sort(function(a, b) {
    return a.f - b.f;
  });
  t.push({ s: -1, f: 25001 });
  var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
  t[0] = { s: -1, f: l.f + r.f, l, r };
  while (i1 != s - 1) {
    l = t[t[i0].f < t[i2].f ? i0++ : i2++];
    r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
    t[i1++] = { s: -1, f: l.f + r.f, l, r };
  }
  var maxSym = t2[0].s;
  for (var i = 1; i < s; ++i) {
    if (t2[i].s > maxSym)
      maxSym = t2[i].s;
  }
  var tr = new u16(maxSym + 1);
  var mbt = ln(t[i1 - 1], tr, 0);
  if (mbt > mb) {
    var i = 0, dt = 0;
    var lft = mbt - mb, cst = 1 << lft;
    t2.sort(function(a, b) {
      return tr[b.s] - tr[a.s] || a.f - b.f;
    });
    for (; i < s; ++i) {
      var i2_1 = t2[i].s;
      if (tr[i2_1] > mb) {
        dt += cst - (1 << mbt - tr[i2_1]);
        tr[i2_1] = mb;
      } else
        break;
    }
    dt >>= lft;
    while (dt > 0) {
      var i2_2 = t2[i].s;
      if (tr[i2_2] < mb)
        dt -= 1 << mb - tr[i2_2]++ - 1;
      else
        ++i;
    }
    for (; i >= 0 && dt; --i) {
      var i2_3 = t2[i].s;
      if (tr[i2_3] == mb) {
        --tr[i2_3];
        ++dt;
      }
    }
    mbt = mb;
  }
  return { t: new u8(tr), l: mbt };
};
var ln = function(n, l, d) {
  return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
};
var lc = function(c) {
  var s = c.length;
  while (s && !c[--s])
    ;
  var cl = new u16(++s);
  var cli = 0, cln = c[0], cls = 1;
  var w = function(v) {
    cl[cli++] = v;
  };
  for (var i = 1; i <= s; ++i) {
    if (c[i] == cln && i != s)
      ++cls;
    else {
      if (!cln && cls > 2) {
        for (; cls > 138; cls -= 138)
          w(32754);
        if (cls > 2) {
          w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
          cls = 0;
        }
      } else if (cls > 3) {
        w(cln), --cls;
        for (; cls > 6; cls -= 6)
          w(8304);
        if (cls > 2)
          w(cls - 3 << 5 | 8208), cls = 0;
      }
      while (cls--)
        w(cln);
      cls = 1;
      cln = c[i];
    }
  }
  return { c: cl.subarray(0, cli), n: s };
};
var clen = function(cf, cl) {
  var l = 0;
  for (var i = 0; i < cl.length; ++i)
    l += cf[i] * cl[i];
  return l;
};
var wfblk = function(out, pos, dat) {
  var s = dat.length;
  var o = shft(pos + 2);
  out[o] = s & 255;
  out[o + 1] = s >> 8;
  out[o + 2] = out[o] ^ 255;
  out[o + 3] = out[o + 1] ^ 255;
  for (var i = 0; i < s; ++i)
    out[o + i + 4] = dat[i];
  return (o + 4 + s) * 8;
};
var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
  wbits(out, p++, final);
  ++lf[256];
  var _a2 = hTree(lf, 15), dlt = _a2.t, mlb = _a2.l;
  var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
  var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
  var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
  var lcfreq = new u16(19);
  for (var i = 0; i < lclt.length; ++i)
    ++lcfreq[lclt[i] & 31];
  for (var i = 0; i < lcdt.length; ++i)
    ++lcfreq[lcdt[i] & 31];
  var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
  var nlcc = 19;
  for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
    ;
  var flen = bl + 5 << 3;
  var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
  var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
  if (bs >= 0 && flen <= ftlen && flen <= dtlen)
    return wfblk(out, p, dat.subarray(bs, bs + bl));
  var lm, ll, dm, dl;
  wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
  if (dtlen < ftlen) {
    lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
    var llm = hMap(lct, mlcb, 0);
    wbits(out, p, nlc - 257);
    wbits(out, p + 5, ndc - 1);
    wbits(out, p + 10, nlcc - 4);
    p += 14;
    for (var i = 0; i < nlcc; ++i)
      wbits(out, p + 3 * i, lct[clim[i]]);
    p += 3 * nlcc;
    var lcts = [lclt, lcdt];
    for (var it = 0; it < 2; ++it) {
      var clct = lcts[it];
      for (var i = 0; i < clct.length; ++i) {
        var len = clct[i] & 31;
        wbits(out, p, llm[len]), p += lct[len];
        if (len > 15)
          wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
      }
    }
  } else {
    lm = flm, ll = flt, dm = fdm, dl = fdt;
  }
  for (var i = 0; i < li; ++i) {
    var sym = syms[i];
    if (sym > 255) {
      var len = sym >> 18 & 31;
      wbits16(out, p, lm[len + 257]), p += ll[len + 257];
      if (len > 7)
        wbits(out, p, sym >> 23 & 31), p += fleb[len];
      var dst = sym & 31;
      wbits16(out, p, dm[dst]), p += dl[dst];
      if (dst > 3)
        wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
    } else {
      wbits16(out, p, lm[sym]), p += ll[sym];
    }
  }
  wbits16(out, p, lm[256]);
  return p + ll[256];
};
var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
var et = /* @__PURE__ */ new u8(0);
var dflt = function(dat, lvl, plvl, pre, post, st) {
  var s = st.z || dat.length;
  var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
  var w = o.subarray(pre, o.length - post);
  var lst = st.l;
  var pos = (st.r || 0) & 7;
  if (lvl) {
    if (pos)
      w[0] = st.r >> 3;
    var opt = deo[lvl - 1];
    var n = opt >> 13, c = opt & 8191;
    var msk_1 = (1 << plvl) - 1;
    var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
    var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
    var hsh = function(i2) {
      return (dat[i2] ^ dat[i2 + 1] << bs1_1 ^ dat[i2 + 2] << bs2_1) & msk_1;
    };
    var syms = new i32(25e3);
    var lf = new u16(288), df = new u16(32);
    var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
    for (; i + 2 < s; ++i) {
      var hv = hsh(i);
      var imod = i & 32767, pimod = head[hv];
      prev[imod] = pimod;
      head[hv] = imod;
      if (wi <= i) {
        var rem = s - i;
        if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
          pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
          li = lc_1 = eb = 0, bs = i;
          for (var j = 0; j < 286; ++j)
            lf[j] = 0;
          for (var j = 0; j < 30; ++j)
            df[j] = 0;
        }
        var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
        if (rem > 2 && hv == hsh(i - dif)) {
          var maxn = Math.min(n, rem) - 1;
          var maxd = Math.min(32767, i);
          var ml = Math.min(258, rem);
          while (dif <= maxd && --ch_1 && imod != pimod) {
            if (dat[i + l] == dat[i + l - dif]) {
              var nl = 0;
              for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl)
                ;
              if (nl > l) {
                l = nl, d = dif;
                if (nl > maxn)
                  break;
                var mmd = Math.min(dif, nl - 2);
                var md = 0;
                for (var j = 0; j < mmd; ++j) {
                  var ti = i - dif + j & 32767;
                  var pti = prev[ti];
                  var cd = ti - pti & 32767;
                  if (cd > md)
                    md = cd, pimod = ti;
                }
              }
            }
            imod = pimod, pimod = prev[imod];
            dif += imod - pimod & 32767;
          }
        }
        if (d) {
          syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
          var lin = revfl[l] & 31, din = revfd[d] & 31;
          eb += fleb[lin] + fdeb[din];
          ++lf[257 + lin];
          ++df[din];
          wi = i + l;
          ++lc_1;
        } else {
          syms[li++] = dat[i];
          ++lf[dat[i]];
        }
      }
    }
    for (i = Math.max(i, wi); i < s; ++i) {
      syms[li++] = dat[i];
      ++lf[dat[i]];
    }
    pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
    if (!lst) {
      st.r = pos & 7 | w[pos / 8 | 0] << 3;
      pos -= 7;
      st.h = head, st.p = prev, st.i = i, st.w = wi;
    }
  } else {
    for (var i = st.w || 0; i < s + lst; i += 65535) {
      var e = i + 65535;
      if (e >= s) {
        w[pos / 8 | 0] = lst;
        e = s;
      }
      pos = wfblk(w, pos + 1, dat.subarray(i, e));
    }
    st.i = s;
  }
  return slc(o, 0, pre + shft(pos) + post);
};
var crct = /* @__PURE__ */ (function() {
  var t = new Int32Array(256);
  for (var i = 0; i < 256; ++i) {
    var c = i, k = 9;
    while (--k)
      c = (c & 1 && -306674912) ^ c >>> 1;
    t[i] = c;
  }
  return t;
})();
var crc = function() {
  var c = -1;
  return {
    p: function(d) {
      var cr = c;
      for (var i = 0; i < d.length; ++i)
        cr = crct[cr & 255 ^ d[i]] ^ cr >>> 8;
      c = cr;
    },
    d: function() {
      return ~c;
    }
  };
};
var adler = function() {
  var a = 1, b = 0;
  return {
    p: function(d) {
      var n = a, m = b;
      var l = d.length | 0;
      for (var i = 0; i != l; ) {
        var e = Math.min(i + 2655, l);
        for (; i < e; ++i)
          m += n += d[i];
        n = (n & 65535) + 15 * (n >> 16), m = (m & 65535) + 15 * (m >> 16);
      }
      a = n, b = m;
    },
    d: function() {
      a %= 65521, b %= 65521;
      return (a & 255) << 24 | (a & 65280) << 8 | (b & 255) << 8 | b >> 8;
    }
  };
};
var dopt = function(dat, opt, pre, post, st) {
  if (!st) {
    st = { l: 1 };
    if (opt.dictionary) {
      var dict = opt.dictionary.subarray(-32768);
      var newDat = new u8(dict.length + dat.length);
      newDat.set(dict);
      newDat.set(dat, dict.length);
      dat = newDat;
      st.w = dict.length;
    }
  }
  return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
};
var mrg = function(a, b) {
  var o = {};
  for (var k in a)
    o[k] = a[k];
  for (var k in b)
    o[k] = b[k];
  return o;
};
var wcln = function(fn, fnStr, td2) {
  var dt = fn();
  var st = fn.toString();
  var ks = st.slice(st.indexOf("[") + 1, st.lastIndexOf("]")).replace(/\s+/g, "").split(",");
  for (var i = 0; i < dt.length; ++i) {
    var v = dt[i], k = ks[i];
    if (typeof v == "function") {
      fnStr += ";" + k + "=";
      var st_1 = v.toString();
      if (v.prototype) {
        if (st_1.indexOf("[native code]") != -1) {
          var spInd = st_1.indexOf(" ", 8) + 1;
          fnStr += st_1.slice(spInd, st_1.indexOf("(", spInd));
        } else {
          fnStr += st_1;
          for (var t in v.prototype)
            fnStr += ";" + k + ".prototype." + t + "=" + v.prototype[t].toString();
        }
      } else
        fnStr += st_1;
    } else
      td2[k] = v;
  }
  return fnStr;
};
var ch = [];
var cbfs = function(v) {
  var tl = [];
  for (var k in v) {
    if (v[k].buffer) {
      tl.push((v[k] = new v[k].constructor(v[k])).buffer);
    }
  }
  return tl;
};
var wrkr = function(fns, init, id, cb) {
  if (!ch[id]) {
    var fnStr = "", td_1 = {}, m = fns.length - 1;
    for (var i = 0; i < m; ++i)
      fnStr = wcln(fns[i], fnStr, td_1);
    ch[id] = { c: wcln(fns[m], fnStr, td_1), e: td_1 };
  }
  var td2 = mrg({}, ch[id].e);
  return wk(ch[id].c + ";onmessage=function(e){for(var k in e.data)self[k]=e.data[k];onmessage=" + init.toString() + "}", id, td2, cbfs(td2), cb);
};
var bInflt = function() {
  return [u8, u16, i32, fleb, fdeb, clim, fl, fd, flrm, fdrm, rev, ec, hMap, max, bits, bits16, shft, slc, err, inflt, inflateSync, pbf, gopt];
};
var bDflt = function() {
  return [u8, u16, i32, fleb, fdeb, clim, revfl, revfd, flm, flt, fdm, fdt, rev, deo, et, hMap, wbits, wbits16, hTree, ln, lc, clen, wfblk, wblk, shft, slc, dflt, dopt, deflateSync, pbf];
};
var gze = function() {
  return [gzh, gzhl, wbytes, crc, crct];
};
var guze = function() {
  return [gzs, gzl];
};
var zle = function() {
  return [zlh, wbytes, adler];
};
var zule = function() {
  return [zls];
};
var pbf = function(msg) {
  return postMessage(msg, [msg.buffer]);
};
var gopt = function(o) {
  return o && {
    out: o.size && new u8(o.size),
    dictionary: o.dictionary
  };
};
var cbify = function(dat, opts, fns, init, id, cb) {
  var w = wrkr(fns, init, id, function(err2, dat2) {
    w.terminate();
    cb(err2, dat2);
  });
  w.postMessage([dat, opts], opts.consume ? [dat.buffer] : []);
  return function() {
    w.terminate();
  };
};
var astrm = function(strm) {
  strm.ondata = function(dat, final) {
    return postMessage([dat, final], [dat.buffer]);
  };
  return function(ev) {
    if (ev.data[0]) {
      strm.push(ev.data[0], ev.data[1]);
      postMessage([ev.data[0].length]);
    } else
      strm.flush(ev.data[1]);
  };
};
var astrmify = function(fns, strm, opts, init, id, flush, ext) {
  var t;
  var w = wrkr(fns, init, id, function(err2, dat) {
    if (err2)
      w.terminate(), strm.ondata.call(strm, err2);
    else if (!Array.isArray(dat))
      ext(dat);
    else if (dat.length == 1) {
      strm.queuedSize -= dat[0];
      if (strm.ondrain)
        strm.ondrain(dat[0]);
    } else {
      if (dat[1])
        w.terminate();
      strm.ondata.call(strm, err2, dat[0], dat[1]);
    }
  });
  w.postMessage(opts);
  strm.queuedSize = 0;
  strm.push = function(d, f) {
    if (!strm.ondata)
      err(5);
    if (t)
      strm.ondata(err(4, 0, 1), null, !!f);
    strm.queuedSize += d.length;
    w.postMessage([d, t = f], d.buffer instanceof ArrayBuffer ? [d.buffer] : []);
  };
  strm.terminate = function() {
    w.terminate();
  };
  if (flush) {
    strm.flush = function(sync) {
      w.postMessage([0, sync]);
    };
  }
};
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
var wbytes = function(d, b, v) {
  for (; v; ++b)
    d[b] = v, v >>>= 8;
};
var gzh = function(c, o) {
  var fn = o.filename;
  c[0] = 31, c[1] = 139, c[2] = 8, c[8] = o.level < 2 ? 4 : o.level == 9 ? 2 : 0, c[9] = 3;
  if (o.mtime != 0)
    wbytes(c, 4, Math.floor(new Date(o.mtime || Date.now()) / 1e3));
  if (fn) {
    c[3] = 8;
    for (var i = 0; i <= fn.length; ++i)
      c[i + 10] = fn.charCodeAt(i);
  }
};
var gzs = function(d) {
  if (d[0] != 31 || d[1] != 139 || d[2] != 8)
    err(6, "invalid gzip data");
  var flg = d[3];
  var st = 10;
  if (flg & 4)
    st += (d[10] | d[11] << 8) + 2;
  for (var zs = (flg >> 3 & 1) + (flg >> 4 & 1); zs > 0; zs -= !d[st++])
    ;
  return st + (flg & 2);
};
var gzl = function(d) {
  var l = d.length;
  return (d[l - 4] | d[l - 3] << 8 | d[l - 2] << 16 | d[l - 1] << 24) >>> 0;
};
var gzhl = function(o) {
  return 10 + (o.filename ? o.filename.length + 1 : 0);
};
var zlh = function(c, o) {
  var lv = o.level, fl2 = lv == 0 ? 0 : lv < 6 ? 1 : lv == 9 ? 3 : 2;
  c[0] = 120, c[1] = fl2 << 6 | (o.dictionary && 32);
  c[1] |= 31 - (c[0] << 8 | c[1]) % 31;
  if (o.dictionary) {
    var h = adler();
    h.p(o.dictionary);
    wbytes(c, 2, h.d());
  }
};
var zls = function(d, dict) {
  if ((d[0] & 15) != 8 || d[0] >> 4 > 7 || (d[0] << 8 | d[1]) % 31)
    err(6, "invalid zlib data");
  if ((d[1] >> 5 & 1) == +!dict)
    err(6, "invalid zlib data: " + (d[1] & 32 ? "need" : "unexpected") + " dictionary");
  return (d[1] >> 3 & 4) + 2;
};
function StrmOpt(opts, cb) {
  if (typeof opts == "function")
    cb = opts, opts = {};
  this.ondata = cb;
  return opts;
}
var Deflate = /* @__PURE__ */ (function() {
  function Deflate2(opts, cb) {
    if (typeof opts == "function")
      cb = opts, opts = {};
    this.ondata = cb;
    this.o = opts || {};
    this.s = { l: 0, i: 32768, w: 32768, z: 32768 };
    this.b = new u8(98304);
    if (this.o.dictionary) {
      var dict = this.o.dictionary.subarray(-32768);
      this.b.set(dict, 32768 - dict.length);
      this.s.i = 32768 - dict.length;
    }
  }
  Deflate2.prototype.p = function(c, f) {
    this.ondata(dopt(c, this.o, 0, 0, this.s), f);
  };
  Deflate2.prototype.push = function(chunk, final) {
    if (!this.ondata)
      err(5);
    if (this.s.l)
      err(4);
    var endLen = chunk.length + this.s.z;
    if (endLen > this.b.length) {
      if (endLen > 2 * this.b.length - 32768) {
        var newBuf = new u8(endLen & -32768);
        newBuf.set(this.b.subarray(0, this.s.z));
        this.b = newBuf;
      }
      var split = this.b.length - this.s.z;
      this.b.set(chunk.subarray(0, split), this.s.z);
      this.s.z = this.b.length;
      this.p(this.b, false);
      this.b.set(this.b.subarray(-32768));
      this.b.set(chunk.subarray(split), 32768);
      this.s.z = chunk.length - split + 32768;
      this.s.i = 32766, this.s.w = 32768;
    } else {
      this.b.set(chunk, this.s.z);
      this.s.z += chunk.length;
    }
    this.s.l = final & 1;
    if (this.s.z > this.s.w + 8191 || final) {
      this.p(this.b, final || false);
      this.s.w = this.s.i, this.s.i -= 2;
    }
    if (final) {
      this.s = this.o = {};
      this.b = et;
    }
  };
  Deflate2.prototype.flush = function(sync) {
    if (!this.ondata)
      err(5);
    if (this.s.l)
      err(4);
    this.p(this.b, false);
    this.s.w = this.s.i, this.s.i -= 2;
    if (sync) {
      var c = new u8(6);
      c[0] = this.s.r >> 3;
      var ep = wfblk(c, this.s.r, et);
      this.s.r = 0;
      this.ondata(c.subarray(0, ep >> 3), false);
    }
  };
  return Deflate2;
})();
var AsyncDeflate = /* @__PURE__ */ (function() {
  function AsyncDeflate2(opts, cb) {
    astrmify([
      bDflt,
      function() {
        return [astrm, Deflate];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Deflate(ev.data);
      onmessage = astrm(strm);
    }, 6, 1);
  }
  return AsyncDeflate2;
})();
function deflate(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bDflt
  ], function(ev) {
    return pbf(deflateSync(ev.data[0], ev.data[1]));
  }, 0, cb);
}
function deflateSync(data, opts) {
  return dopt(data, opts || {}, 0, 0);
}
var Inflate = /* @__PURE__ */ (function() {
  function Inflate2(opts, cb) {
    if (typeof opts == "function")
      cb = opts, opts = {};
    this.ondata = cb;
    var dict = opts && opts.dictionary && opts.dictionary.subarray(-32768);
    this.s = { i: 0, b: dict ? dict.length : 0 };
    this.o = new u8(32768);
    this.p = new u8(0);
    if (dict)
      this.o.set(dict);
  }
  Inflate2.prototype.e = function(c) {
    if (!this.ondata)
      err(5);
    if (this.d)
      err(4);
    if (!this.p.length)
      this.p = c;
    else if (c.length) {
      var n = new u8(this.p.length + c.length);
      n.set(this.p), n.set(c, this.p.length), this.p = n;
    }
  };
  Inflate2.prototype.c = function(final) {
    this.s.i = +(this.d = final || false);
    var bts = this.s.b;
    var dt = inflt(this.p, this.s, this.o);
    this.ondata(slc(dt, bts, this.s.b), this.d);
    this.o = slc(dt, this.s.b - 32768), this.s.b = this.o.length;
    this.p = slc(this.p, this.s.p / 8 | 0), this.s.p &= 7;
  };
  Inflate2.prototype.push = function(chunk, final) {
    this.e(chunk), this.c(final);
  };
  return Inflate2;
})();
var AsyncInflate = /* @__PURE__ */ (function() {
  function AsyncInflate2(opts, cb) {
    astrmify([
      bInflt,
      function() {
        return [astrm, Inflate];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Inflate(ev.data);
      onmessage = astrm(strm);
    }, 7, 0);
  }
  return AsyncInflate2;
})();
function inflate(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bInflt
  ], function(ev) {
    return pbf(inflateSync(ev.data[0], gopt(ev.data[1])));
  }, 1, cb);
}
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var Gzip = /* @__PURE__ */ (function() {
  function Gzip2(opts, cb) {
    this.c = crc();
    this.l = 0;
    this.v = 1;
    Deflate.call(this, opts, cb);
  }
  Gzip2.prototype.push = function(chunk, final) {
    this.c.p(chunk);
    this.l += chunk.length;
    Deflate.prototype.push.call(this, chunk, final);
  };
  Gzip2.prototype.p = function(c, f) {
    var raw = dopt(c, this.o, this.v && gzhl(this.o), f && 8, this.s);
    if (this.v)
      gzh(raw, this.o), this.v = 0;
    if (f)
      wbytes(raw, raw.length - 8, this.c.d()), wbytes(raw, raw.length - 4, this.l);
    this.ondata(raw, f);
  };
  Gzip2.prototype.flush = function(sync) {
    Deflate.prototype.flush.call(this, sync);
  };
  return Gzip2;
})();
var AsyncGzip = /* @__PURE__ */ (function() {
  function AsyncGzip2(opts, cb) {
    astrmify([
      bDflt,
      gze,
      function() {
        return [astrm, Deflate, Gzip];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Gzip(ev.data);
      onmessage = astrm(strm);
    }, 8, 1);
  }
  return AsyncGzip2;
})();
function gzip(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bDflt,
    gze,
    function() {
      return [gzipSync];
    }
  ], function(ev) {
    return pbf(gzipSync(ev.data[0], ev.data[1]));
  }, 2, cb);
}
function gzipSync(data, opts) {
  if (!opts)
    opts = {};
  var c = crc(), l = data.length;
  c.p(data);
  var d = dopt(data, opts, gzhl(opts), 8), s = d.length;
  return gzh(d, opts), wbytes(d, s - 8, c.d()), wbytes(d, s - 4, l), d;
}
var Gunzip = /* @__PURE__ */ (function() {
  function Gunzip2(opts, cb) {
    this.v = 1;
    this.r = 0;
    Inflate.call(this, opts, cb);
  }
  Gunzip2.prototype.push = function(chunk, final) {
    Inflate.prototype.e.call(this, chunk);
    this.r += chunk.length;
    if (this.v) {
      var p = this.p.subarray(this.v - 1);
      var s = p.length > 3 ? gzs(p) : 4;
      if (s > p.length) {
        if (!final)
          return;
      } else if (this.v > 1 && this.onmember) {
        this.onmember(this.r - p.length);
      }
      this.p = p.subarray(s), this.v = 0;
    }
    Inflate.prototype.c.call(this, 0);
    if (this.s.f && !this.s.l) {
      this.v = shft(this.s.p) + 9;
      this.s = { i: 0 };
      this.o = new u8(0);
      this.push(new u8(0), final);
    } else if (final) {
      Inflate.prototype.c.call(this, final);
    }
  };
  return Gunzip2;
})();
var AsyncGunzip = /* @__PURE__ */ (function() {
  function AsyncGunzip2(opts, cb) {
    var _this = this;
    astrmify([
      bInflt,
      guze,
      function() {
        return [astrm, Inflate, Gunzip];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Gunzip(ev.data);
      strm.onmember = function(offset) {
        return postMessage(offset);
      };
      onmessage = astrm(strm);
    }, 9, 0, function(offset) {
      return _this.onmember && _this.onmember(offset);
    });
  }
  return AsyncGunzip2;
})();
function gunzip(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bInflt,
    guze,
    function() {
      return [gunzipSync];
    }
  ], function(ev) {
    return pbf(gunzipSync(ev.data[0], ev.data[1]));
  }, 3, cb);
}
function gunzipSync(data, opts) {
  var st = gzs(data);
  if (st + 8 > data.length)
    err(6, "invalid gzip data");
  return inflt(data.subarray(st, -8), { i: 2 }, opts && opts.out || new u8(gzl(data)), opts && opts.dictionary);
}
var Zlib = /* @__PURE__ */ (function() {
  function Zlib2(opts, cb) {
    this.c = adler();
    this.v = 1;
    Deflate.call(this, opts, cb);
  }
  Zlib2.prototype.push = function(chunk, final) {
    this.c.p(chunk);
    Deflate.prototype.push.call(this, chunk, final);
  };
  Zlib2.prototype.p = function(c, f) {
    var raw = dopt(c, this.o, this.v && (this.o.dictionary ? 6 : 2), f && 4, this.s);
    if (this.v)
      zlh(raw, this.o), this.v = 0;
    if (f)
      wbytes(raw, raw.length - 4, this.c.d());
    this.ondata(raw, f);
  };
  Zlib2.prototype.flush = function(sync) {
    Deflate.prototype.flush.call(this, sync);
  };
  return Zlib2;
})();
var AsyncZlib = /* @__PURE__ */ (function() {
  function AsyncZlib2(opts, cb) {
    astrmify([
      bDflt,
      zle,
      function() {
        return [astrm, Deflate, Zlib];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Zlib(ev.data);
      onmessage = astrm(strm);
    }, 10, 1);
  }
  return AsyncZlib2;
})();
function zlib(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bDflt,
    zle,
    function() {
      return [zlibSync];
    }
  ], function(ev) {
    return pbf(zlibSync(ev.data[0], ev.data[1]));
  }, 4, cb);
}
function zlibSync(data, opts) {
  if (!opts)
    opts = {};
  var a = adler();
  a.p(data);
  var d = dopt(data, opts, opts.dictionary ? 6 : 2, 4);
  return zlh(d, opts), wbytes(d, d.length - 4, a.d()), d;
}
var Unzlib = /* @__PURE__ */ (function() {
  function Unzlib2(opts, cb) {
    Inflate.call(this, opts, cb);
    this.v = opts && opts.dictionary ? 2 : 1;
  }
  Unzlib2.prototype.push = function(chunk, final) {
    Inflate.prototype.e.call(this, chunk);
    if (this.v) {
      if (this.p.length < 6 && !final)
        return;
      this.p = this.p.subarray(zls(this.p, this.v - 1)), this.v = 0;
    }
    if (final) {
      if (this.p.length < 4)
        err(6, "invalid zlib data");
      this.p = this.p.subarray(0, -4);
    }
    Inflate.prototype.c.call(this, final);
  };
  return Unzlib2;
})();
var AsyncUnzlib = /* @__PURE__ */ (function() {
  function AsyncUnzlib2(opts, cb) {
    astrmify([
      bInflt,
      zule,
      function() {
        return [astrm, Inflate, Unzlib];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Unzlib(ev.data);
      onmessage = astrm(strm);
    }, 11, 0);
  }
  return AsyncUnzlib2;
})();
function unzlib(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bInflt,
    zule,
    function() {
      return [unzlibSync];
    }
  ], function(ev) {
    return pbf(unzlibSync(ev.data[0], gopt(ev.data[1])));
  }, 5, cb);
}
function unzlibSync(data, opts) {
  return inflt(data.subarray(zls(data, opts && opts.dictionary), -4), { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var Decompress = /* @__PURE__ */ (function() {
  function Decompress2(opts, cb) {
    this.o = StrmOpt.call(this, opts, cb) || {};
    this.G = Gunzip;
    this.I = Inflate;
    this.Z = Unzlib;
  }
  Decompress2.prototype.i = function() {
    var _this = this;
    this.s.ondata = function(dat, final) {
      _this.ondata(dat, final);
    };
  };
  Decompress2.prototype.push = function(chunk, final) {
    if (!this.ondata)
      err(5);
    if (!this.s) {
      if (this.p && this.p.length) {
        var n = new u8(this.p.length + chunk.length);
        n.set(this.p), n.set(chunk, this.p.length);
      } else
        this.p = chunk;
      if (this.p.length > 2) {
        this.s = this.p[0] == 31 && this.p[1] == 139 && this.p[2] == 8 ? new this.G(this.o) : (this.p[0] & 15) != 8 || this.p[0] >> 4 > 7 || (this.p[0] << 8 | this.p[1]) % 31 ? new this.I(this.o) : new this.Z(this.o);
        this.i();
        this.s.push(this.p, final);
        this.p = null;
      }
    } else
      this.s.push(chunk, final);
  };
  return Decompress2;
})();
var AsyncDecompress = /* @__PURE__ */ (function() {
  function AsyncDecompress2(opts, cb) {
    Decompress.call(this, opts, cb);
    this.queuedSize = 0;
    this.G = AsyncGunzip;
    this.I = AsyncInflate;
    this.Z = AsyncUnzlib;
  }
  AsyncDecompress2.prototype.i = function() {
    var _this = this;
    this.s.ondata = function(err2, dat, final) {
      _this.ondata(err2, dat, final);
    };
    this.s.ondrain = function(size) {
      _this.queuedSize -= size;
      if (_this.ondrain)
        _this.ondrain(size);
    };
  };
  AsyncDecompress2.prototype.push = function(chunk, final) {
    this.queuedSize += chunk.length;
    Decompress.prototype.push.call(this, chunk, final);
  };
  return AsyncDecompress2;
})();
function decompress(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return data[0] == 31 && data[1] == 139 && data[2] == 8 ? gunzip(data, opts, cb) : (data[0] & 15) != 8 || data[0] >> 4 > 7 || (data[0] << 8 | data[1]) % 31 ? inflate(data, opts, cb) : unzlib(data, opts, cb);
}
function decompressSync(data, opts) {
  return data[0] == 31 && data[1] == 139 && data[2] == 8 ? gunzipSync(data, opts) : (data[0] & 15) != 8 || data[0] >> 4 > 7 || (data[0] << 8 | data[1]) % 31 ? inflateSync(data, opts) : unzlibSync(data, opts);
}
var fltn = function(d, p, t, o) {
  for (var k in d) {
    var val = d[k], n = p + k, op = o;
    if (Array.isArray(val))
      op = mrg(o, val[1]), val = val[0];
    if (ArrayBuffer.isView(val))
      t[n] = [val, op];
    else {
      t[n += "/"] = [new u8(0), op];
      fltn(val, n, t, o);
    }
  }
};
var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
var dutf8 = function(d) {
  for (var r = "", i = 0; ; ) {
    var c = d[i++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i + eb > d.length)
      return { s: r, r: slc(d, i - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
  }
};
var DecodeUTF8 = /* @__PURE__ */ (function() {
  function DecodeUTF82(cb) {
    this.ondata = cb;
    if (tds)
      this.t = new TextDecoder();
    else
      this.p = et;
  }
  DecodeUTF82.prototype.push = function(chunk, final) {
    if (!this.ondata)
      err(5);
    final = !!final;
    if (this.t) {
      this.ondata(this.t.decode(chunk, { stream: true }), final);
      if (final) {
        if (this.t.decode().length)
          err(8);
        this.t = null;
      }
      return;
    }
    if (!this.p)
      err(4);
    var dat = new u8(this.p.length + chunk.length);
    dat.set(this.p);
    dat.set(chunk, this.p.length);
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (final) {
      if (r.length)
        err(8);
      this.p = null;
    } else
      this.p = r;
    this.ondata(s, final);
  };
  return DecodeUTF82;
})();
var EncodeUTF8 = /* @__PURE__ */ (function() {
  function EncodeUTF82(cb) {
    this.ondata = cb;
  }
  EncodeUTF82.prototype.push = function(chunk, final) {
    if (!this.ondata)
      err(5);
    if (this.d)
      err(4);
    this.ondata(strToU8(chunk), this.d = final || false);
  };
  return EncodeUTF82;
})();
function strToU8(str, latin1) {
  if (latin1) {
    var ar_1 = new u8(str.length);
    for (var i = 0; i < str.length; ++i)
      ar_1[i] = str.charCodeAt(i);
    return ar_1;
  }
  if (te)
    return te.encode(str);
  var l = str.length;
  var ar = new u8(str.length + (str.length >> 1));
  var ai = 0;
  var w = function(v) {
    ar[ai++] = v;
  };
  for (var i = 0; i < l; ++i) {
    if (ai + 5 > ar.length) {
      var n = new u8(ai + 8 + (l - i << 1));
      n.set(ar);
      ar = n;
    }
    var c = str.charCodeAt(i);
    if (c < 128 || latin1)
      w(c);
    else if (c < 2048)
      w(192 | c >> 6), w(128 | c & 63);
    else if (c > 55295 && c < 57344)
      c = 65536 + (c & 1023 << 10) | str.charCodeAt(++i) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
    else
      w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
  }
  return slc(ar, 0, ai);
}
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i = 0; i < dat.length; i += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (r.length)
      err(8);
    return s;
  }
}
var dbf = function(l) {
  return l == 1 ? 3 : l < 6 ? 2 : l == 9 ? 1 : 0;
};
var slzh = function(d, b) {
  return b + 30 + b2(d, b + 26) + b2(d, b + 28);
};
var zh = function(d, b, z) {
  var fnl = b2(d, b + 28), efl = b2(d, b + 30), fn = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl;
  var _a2 = z64hs(d, es, efl, z, b4(d, b + 20), b4(d, b + 24), b4(d, b + 42)), sc = _a2[0], su = _a2[1], off = _a2[2];
  return [b2(d, b + 10), sc, su, fn, es + efl + b2(d, b + 32), off];
};
var z64hs = function(d, b, l, z, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  var nf = nsc + nsu + noff;
  if (z && nf) {
    for (; b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
var exfl = function(ex) {
  var le = 0;
  if (ex) {
    for (var k in ex) {
      var l = ex[k].length;
      if (l > 65535)
        err(9);
      le += l + 4;
    }
  }
  return le;
};
var wzh = function(d, b, f, fn, u, c, ce, co) {
  var fl2 = fn.length, ex = f.extra, col = co && co.length;
  var exl = exfl(ex);
  wbytes(d, b, ce != null ? 33639248 : 67324752), b += 4;
  if (ce != null)
    d[b++] = 20, d[b++] = f.os;
  d[b] = 20, b += 2;
  d[b++] = f.flag << 1 | (c < 0 && 8), d[b++] = u && 8;
  d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
  var dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
  if (y < 0 || y > 119)
    err(10);
  wbytes(d, b, y << 25 | dt.getMonth() + 1 << 21 | dt.getDate() << 16 | dt.getHours() << 11 | dt.getMinutes() << 5 | dt.getSeconds() >> 1), b += 4;
  if (c != -1) {
    wbytes(d, b, f.crc);
    wbytes(d, b + 4, c < 0 ? -c - 2 : c);
    wbytes(d, b + 8, f.size);
  }
  wbytes(d, b + 12, fl2);
  wbytes(d, b + 14, exl), b += 16;
  if (ce != null) {
    wbytes(d, b, col);
    wbytes(d, b + 6, f.attrs);
    wbytes(d, b + 10, ce), b += 14;
  }
  d.set(fn, b);
  b += fl2;
  if (exl) {
    for (var k in ex) {
      var exf = ex[k], l = exf.length;
      wbytes(d, b, +k);
      wbytes(d, b + 2, l);
      d.set(exf, b + 4), b += 4 + l;
    }
  }
  if (col)
    d.set(co, b), b += col;
  return b;
};
var wzf = function(o, b, c, d, e) {
  wbytes(o, b, 101010256);
  wbytes(o, b + 8, c);
  wbytes(o, b + 10, c);
  wbytes(o, b + 12, d);
  wbytes(o, b + 16, e);
};
var ZipPassThrough = /* @__PURE__ */ (function() {
  function ZipPassThrough2(filename) {
    this.filename = filename;
    this.c = crc();
    this.size = 0;
    this.compression = 0;
  }
  ZipPassThrough2.prototype.process = function(chunk, final) {
    this.ondata(null, chunk, final);
  };
  ZipPassThrough2.prototype.push = function(chunk, final) {
    if (!this.ondata)
      err(5);
    this.c.p(chunk);
    this.size += chunk.length;
    if (final)
      this.crc = this.c.d();
    this.process(chunk, final || false);
  };
  return ZipPassThrough2;
})();
var ZipDeflate = /* @__PURE__ */ (function() {
  function ZipDeflate2(filename, opts) {
    var _this = this;
    if (!opts)
      opts = {};
    ZipPassThrough.call(this, filename);
    this.d = new Deflate(opts, function(dat, final) {
      _this.ondata(null, dat, final);
    });
    this.compression = 8;
    this.flag = dbf(opts.level);
  }
  ZipDeflate2.prototype.process = function(chunk, final) {
    try {
      this.d.push(chunk, final);
    } catch (e) {
      this.ondata(e, null, final);
    }
  };
  ZipDeflate2.prototype.push = function(chunk, final) {
    ZipPassThrough.prototype.push.call(this, chunk, final);
  };
  return ZipDeflate2;
})();
var AsyncZipDeflate = /* @__PURE__ */ (function() {
  function AsyncZipDeflate2(filename, opts) {
    var _this = this;
    if (!opts)
      opts = {};
    ZipPassThrough.call(this, filename);
    this.d = new AsyncDeflate(opts, function(err2, dat, final) {
      _this.ondata(err2, dat, final);
    });
    this.compression = 8;
    this.flag = dbf(opts.level);
    this.terminate = this.d.terminate;
  }
  AsyncZipDeflate2.prototype.process = function(chunk, final) {
    this.d.push(chunk, final);
  };
  AsyncZipDeflate2.prototype.push = function(chunk, final) {
    ZipPassThrough.prototype.push.call(this, chunk, final);
  };
  return AsyncZipDeflate2;
})();
var Zip = /* @__PURE__ */ (function() {
  function Zip2(cb) {
    this.ondata = cb;
    this.u = [];
    this.d = 1;
  }
  Zip2.prototype.add = function(file) {
    var _this = this;
    if (!this.ondata)
      err(5);
    if (this.d & 2)
      this.ondata(err(4 + (this.d & 1) * 8, 0, 1), null, false);
    else {
      var f = strToU8(file.filename), fl_1 = f.length;
      var com = file.comment, o = com && strToU8(com);
      var u = fl_1 != file.filename.length || o && com.length != o.length;
      var hl_1 = fl_1 + exfl(file.extra) + 30;
      if (fl_1 > 65535)
        this.ondata(err(11, 0, 1), null, false);
      var header = new u8(hl_1);
      wzh(header, 0, file, f, u, -1);
      var chks_1 = [header];
      var pAll_1 = function() {
        for (var _i = 0, chks_2 = chks_1; _i < chks_2.length; _i++) {
          var chk = chks_2[_i];
          _this.ondata(null, chk, false);
        }
        chks_1 = [];
      };
      var tr_1 = this.d;
      this.d = 0;
      var ind_1 = this.u.length;
      var uf_1 = mrg(file, {
        f,
        u,
        o,
        t: function() {
          if (file.terminate)
            file.terminate();
        },
        r: function() {
          pAll_1();
          if (tr_1) {
            var nxt = _this.u[ind_1 + 1];
            if (nxt)
              nxt.r();
            else
              _this.d = 1;
          }
          tr_1 = 1;
        }
      });
      var cl_1 = 0;
      file.ondata = function(err2, dat, final) {
        if (err2) {
          _this.ondata(err2, dat, final);
          _this.terminate();
        } else {
          cl_1 += dat.length;
          chks_1.push(dat);
          if (final) {
            var dd = new u8(16);
            wbytes(dd, 0, 134695760);
            wbytes(dd, 4, file.crc);
            wbytes(dd, 8, cl_1);
            wbytes(dd, 12, file.size);
            chks_1.push(dd);
            uf_1.c = cl_1, uf_1.b = hl_1 + cl_1 + 16, uf_1.crc = file.crc, uf_1.size = file.size;
            if (tr_1)
              uf_1.r();
            tr_1 = 1;
          } else if (tr_1)
            pAll_1();
        }
      };
      this.u.push(uf_1);
    }
  };
  Zip2.prototype.end = function() {
    var _this = this;
    if (this.d & 2) {
      this.ondata(err(4 + (this.d & 1) * 8, 0, 1), null, true);
      return;
    }
    if (this.d)
      this.e();
    else
      this.u.push({
        r: function() {
          if (!(_this.d & 1))
            return;
          _this.u.splice(-1, 1);
          _this.e();
        },
        t: function() {
        }
      });
    this.d = 3;
  };
  Zip2.prototype.e = function() {
    var bt = 0, l = 0, tl = 0;
    for (var _i = 0, _a2 = this.u; _i < _a2.length; _i++) {
      var f = _a2[_i];
      tl += 46 + f.f.length + exfl(f.extra) + (f.o ? f.o.length : 0);
    }
    var out = new u8(tl + 22);
    for (var _b2 = 0, _c = this.u; _b2 < _c.length; _b2++) {
      var f = _c[_b2];
      wzh(out, bt, f, f.f, f.u, -f.c - 2, l, f.o);
      bt += 46 + f.f.length + exfl(f.extra) + (f.o ? f.o.length : 0), l += f.b;
    }
    wzf(out, bt, this.u.length, tl, l);
    this.ondata(null, out, true);
    this.d = 2;
  };
  Zip2.prototype.terminate = function() {
    for (var _i = 0, _a2 = this.u; _i < _a2.length; _i++) {
      var f = _a2[_i];
      f.t();
    }
    this.d = 2;
  };
  return Zip2;
})();
function zip(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  var r = {};
  fltn(data, "", r, opts);
  var k = Object.keys(r);
  var lft = k.length, o = 0, tot = 0;
  var slft = lft, files = new Array(lft);
  var term = [];
  var tAll = function() {
    for (var i2 = 0; i2 < term.length; ++i2)
      term[i2]();
  };
  var cbd = function(a, b) {
    mt(function() {
      cb(a, b);
    });
  };
  mt(function() {
    cbd = cb;
  });
  var cbf = function() {
    var out = new u8(tot + 22), oe = o, cdl = tot - o;
    tot = 0;
    for (var i2 = 0; i2 < slft; ++i2) {
      var f = files[i2];
      try {
        var l = f.c.length;
        wzh(out, tot, f, f.f, f.u, l);
        var badd = 30 + f.f.length + exfl(f.extra);
        var loc = tot + badd;
        out.set(f.c, loc);
        wzh(out, o, f, f.f, f.u, l, tot, f.m), o += 16 + badd + (f.m ? f.m.length : 0), tot = loc + l;
      } catch (e) {
        return cbd(e, null);
      }
    }
    wzf(out, o, files.length, cdl, oe);
    cbd(null, out);
  };
  if (!lft)
    cbf();
  var _loop_1 = function(i2) {
    var fn = k[i2];
    var _a2 = r[fn], file = _a2[0], p = _a2[1];
    var c = crc(), size = file.length;
    c.p(file);
    var f = strToU8(fn), s = f.length;
    var com = p.comment, m = com && strToU8(com), ms = m && m.length;
    var exl = exfl(p.extra);
    var compression = p.level == 0 ? 0 : 8;
    var cbl = function(e, d) {
      if (e) {
        tAll();
        cbd(e, null);
      } else {
        var l = d.length;
        files[i2] = mrg(p, {
          size,
          crc: c.d(),
          c: d,
          f,
          m,
          u: s != fn.length || m && com.length != ms,
          compression
        });
        o += 30 + s + exl + l;
        tot += 76 + 2 * (s + exl) + (ms || 0) + l;
        if (!--lft)
          cbf();
      }
    };
    if (s > 65535)
      cbl(err(11, 0, 1), null);
    if (!compression)
      cbl(null, file);
    else if (size < 16e4) {
      try {
        cbl(null, deflateSync(file, p));
      } catch (e) {
        cbl(e, null);
      }
    } else
      term.push(deflate(file, p, cbl));
  };
  for (var i = 0; i < slft; ++i) {
    _loop_1(i);
  }
  return tAll;
}
function zipSync(data, opts) {
  if (!opts)
    opts = {};
  var r = {};
  var files = [];
  fltn(data, "", r, opts);
  var o = 0;
  var tot = 0;
  for (var fn in r) {
    var _a2 = r[fn], file = _a2[0], p = _a2[1];
    var compression = p.level == 0 ? 0 : 8;
    var f = strToU8(fn), s = f.length;
    var com = p.comment, m = com && strToU8(com), ms = m && m.length;
    var exl = exfl(p.extra);
    if (s > 65535)
      err(11);
    var d = compression ? deflateSync(file, p) : file, l = d.length;
    var c = crc();
    c.p(file);
    files.push(mrg(p, {
      size: file.length,
      crc: c.d(),
      c: d,
      f,
      m,
      u: s != fn.length || m && com.length != ms,
      o,
      compression
    }));
    o += 30 + s + exl + l;
    tot += 76 + 2 * (s + exl) + (ms || 0) + l;
  }
  var out = new u8(tot + 22), oe = o, cdl = tot - o;
  for (var i = 0; i < files.length; ++i) {
    var f = files[i];
    wzh(out, f.o, f, f.f, f.u, f.c.length);
    var badd = 30 + f.f.length + exfl(f.extra);
    out.set(f.c, f.o + badd);
    wzh(out, o, f, f.f, f.u, f.c.length, f.o, f.m), o += 16 + badd + (f.m ? f.m.length : 0);
  }
  wzf(out, o, files.length, cdl, oe);
  return out;
}
var UnzipPassThrough = /* @__PURE__ */ (function() {
  function UnzipPassThrough2() {
  }
  UnzipPassThrough2.prototype.push = function(chunk, final) {
    this.ondata(null, chunk, final);
  };
  UnzipPassThrough2.compression = 0;
  return UnzipPassThrough2;
})();
var UnzipInflate = /* @__PURE__ */ (function() {
  function UnzipInflate2() {
    var _this = this;
    this.i = new Inflate(function(dat, final) {
      _this.ondata(null, dat, final);
    });
  }
  UnzipInflate2.prototype.push = function(chunk, final) {
    try {
      this.i.push(chunk, final);
    } catch (e) {
      this.ondata(e, null, final);
    }
  };
  UnzipInflate2.compression = 8;
  return UnzipInflate2;
})();
var AsyncUnzipInflate = /* @__PURE__ */ (function() {
  function AsyncUnzipInflate2(_, sz) {
    var _this = this;
    if (sz < 32e4) {
      this.i = new Inflate(function(dat, final) {
        _this.ondata(null, dat, final);
      });
    } else {
      this.i = new AsyncInflate(function(err2, dat, final) {
        _this.ondata(err2, dat, final);
      });
      this.terminate = this.i.terminate;
    }
  }
  AsyncUnzipInflate2.prototype.push = function(chunk, final) {
    if (this.i.terminate)
      chunk = slc(chunk, 0);
    this.i.push(chunk, final);
  };
  AsyncUnzipInflate2.compression = 8;
  return AsyncUnzipInflate2;
})();
var Unzip = /* @__PURE__ */ (function() {
  function Unzip2(cb) {
    this.onfile = cb;
    this.k = [];
    this.o = {
      0: UnzipPassThrough
    };
    this.p = et;
  }
  Unzip2.prototype.push = function(chunk, final) {
    var _this = this;
    if (!this.onfile)
      err(5);
    if (!this.p)
      err(4);
    if (this.c > 0) {
      var len = Math.min(this.c, chunk.length);
      var toAdd = chunk.subarray(0, len);
      this.c -= len;
      if (this.d)
        this.d.push(toAdd, !this.c);
      else
        this.k[0].push(toAdd);
      chunk = chunk.subarray(len);
      if (chunk.length)
        return this.push(chunk, final);
    } else {
      var f = 0, i = 0, is = void 0, buf = void 0;
      if (!this.p.length)
        buf = chunk;
      else if (!chunk.length)
        buf = this.p;
      else {
        buf = new u8(this.p.length + chunk.length);
        buf.set(this.p), buf.set(chunk, this.p.length);
      }
      var l = buf.length, oc = this.c, add = oc && this.d;
      var _loop_2 = function() {
        var sig = b4(buf, i);
        if (sig == 67324752) {
          f = 1, is = i;
          this_1.d = null;
          this_1.c = 0;
          var bf = b2(buf, i + 6), cmp_1 = b2(buf, i + 8), u = bf & 2048, dd = bf & 8, fnl = b2(buf, i + 26), es = b2(buf, i + 28);
          if (l > i + 30 + fnl + es) {
            var chks_3 = [];
            this_1.k.unshift(chks_3);
            f = 2;
            var lsc = b4(buf, i + 18), lsu = b4(buf, i + 22);
            var fn_1 = strFromU8(buf.subarray(i + 30, i += 30 + fnl), !u);
            var _a2 = z64hs(buf, i, es, 2, lsc, lsu, 0), sc_1 = _a2[0], su_1 = _a2[1], z64 = _a2[3];
            if (dd)
              sc_1 = -1 - z64;
            i += es;
            this_1.c = sc_1;
            var d_1;
            var file_1 = {
              name: fn_1,
              compression: cmp_1,
              start: function() {
                if (!file_1.ondata)
                  err(5);
                if (!sc_1)
                  file_1.ondata(null, et, true);
                else {
                  var ctr = _this.o[cmp_1];
                  if (!ctr)
                    file_1.ondata(err(14, "unknown compression type " + cmp_1, 1), null, false);
                  d_1 = sc_1 < 0 ? new ctr(fn_1) : new ctr(fn_1, sc_1, su_1);
                  d_1.ondata = function(err2, dat3, final2) {
                    file_1.ondata(err2, dat3, final2);
                  };
                  for (var _i = 0, chks_4 = chks_3; _i < chks_4.length; _i++) {
                    var dat2 = chks_4[_i];
                    d_1.push(dat2, false);
                  }
                  if (_this.k[0] == chks_3 && _this.c)
                    _this.d = d_1;
                  else
                    d_1.push(et, true);
                }
              },
              terminate: function() {
                if (d_1 && d_1.terminate)
                  d_1.terminate();
              }
            };
            if (sc_1 >= 0)
              file_1.size = sc_1, file_1.originalSize = su_1;
            this_1.onfile(file_1);
          }
          return "break";
        } else if (oc) {
          if (sig == 134695760) {
            is = i += 12 + (oc == -2 && 8), f = 3, this_1.c = 0;
            return "break";
          } else if (sig == 33639248) {
            is = i -= 4, f = 3, this_1.c = 0;
            return "break";
          }
        }
      };
      var this_1 = this;
      for (; i < l - 4; ++i) {
        var state_1 = _loop_2();
        if (state_1 === "break")
          break;
      }
      this.p = et;
      if (oc < 0) {
        var dat = f ? buf.subarray(0, is - 12 - (oc == -2 && 8) - (b4(buf, is - 16) == 134695760 && 4)) : buf.subarray(0, i);
        if (add)
          add.push(dat, !!f);
        else
          this.k[+(f == 2)].push(dat);
      }
      if (f & 2)
        return this.push(buf.subarray(i), final);
      this.p = buf.subarray(i);
    }
    if (final) {
      if (this.c)
        err(13);
      this.p = null;
    }
  };
  Unzip2.prototype.register = function(decoder) {
    this.o[decoder.compression] = decoder;
  };
  return Unzip2;
})();
var mt = typeof queueMicrotask == "function" ? queueMicrotask : typeof setTimeout == "function" ? setTimeout : function(fn) {
  fn();
};
function unzip(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  var term = [];
  var tAll = function() {
    for (var i2 = 0; i2 < term.length; ++i2)
      term[i2]();
  };
  var files = {};
  var cbd = function(a, b) {
    mt(function() {
      cb(a, b);
    });
  };
  mt(function() {
    cbd = cb;
  });
  var e = data.length - 22;
  for (; b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558) {
      cbd(err(13, 0, 1), null);
      return tAll;
    }
  }
  ;
  var lft = b2(data, e + 8);
  if (lft) {
    var c = lft;
    var o = b4(data, e + 16);
    var z = b4(data, e - 20) == 117853008;
    if (z) {
      var ze = b4(data, e - 12);
      z = b4(data, ze) == 101075792;
      if (z) {
        c = lft = b4(data, ze + 32);
        o = b4(data, ze + 48);
      }
    }
    var fltr = opts && opts.filter;
    var _loop_3 = function(i2) {
      var _a2 = zh(data, o, z), c_1 = _a2[0], sc = _a2[1], su = _a2[2], fn = _a2[3], no = _a2[4], off = _a2[5], b = slzh(data, off);
      o = no;
      var cbl = function(e2, d) {
        if (e2) {
          tAll();
          cbd(e2, null);
        } else {
          if (d)
            files[fn] = d;
          if (!--lft)
            cbd(null, files);
        }
      };
      if (!fltr || fltr({
        name: fn,
        size: sc,
        originalSize: su,
        compression: c_1
      })) {
        if (!c_1)
          cbl(null, slc(data, b, b + sc));
        else if (c_1 == 8) {
          var infl = data.subarray(b, b + sc);
          if (su < 524288 || sc > 0.8 * su) {
            try {
              cbl(null, inflateSync(infl, { out: new u8(su) }));
            } catch (e2) {
              cbl(e2, null);
            }
          } else
            term.push(inflate(infl, { size: su }, cbl));
        } else
          cbl(err(14, "unknown compression type " + c_1, 1), null);
      } else
        cbl(null, null);
    };
    for (var i = 0; i < c; ++i) {
      _loop_3(i);
    }
  } else
    cbd(null, {});
  return tAll;
}
function unzipSync(data, opts) {
  var files = {};
  var e = data.length - 22;
  for (; b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558)
      err(13);
  }
  ;
  var c = b2(data, e + 8);
  if (!c)
    return {};
  var o = b4(data, e + 16);
  var z = b4(data, e - 20) == 117853008;
  if (z) {
    var ze = b4(data, e - 12);
    z = b4(data, ze) == 101075792;
    if (z) {
      c = b4(data, ze + 32);
      o = b4(data, ze + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i = 0; i < c; ++i) {
    var _a2 = zh(data, o, z), c_2 = _a2[0], sc = _a2[1], su = _a2[2], fn = _a2[3], no = _a2[4], off = _a2[5], b = slzh(data, off);
    o = no;
    if (!fltr || fltr({
      name: fn,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn] = slc(data, b, b + sc);
      else if (c_2 == 8)
        files[fn] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
      else
        err(14, "unknown compression type " + c_2);
    }
  }
  return files;
}

// packages/runtime-javascript/src/internal/encoding.ts
var textEncoder3 = new TextEncoder();
var textDecoder2 = new TextDecoder();
var fflateRecord = browser_exports;
var fflate = typeof fflateRecord.gzipSync === "function" ? browser_exports : fflateRecord.default;
function utf8Bytes(value) {
  return textEncoder3.encode(value);
}
function base64ToBytes(value) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}
function bytesToBase64(value) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value).toString("base64");
  }
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}
function fileBytes(file) {
  return file.encoding === "base64" ? base64ToBytes(file.contents) : utf8Bytes(file.contents);
}
function byteEqual(left, right) {
  if (!left || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
function bytesToRuntimeFile(path, contents) {
  const text = textDecoder2.decode(contents);
  if (byteEqual(utf8Bytes(text), contents)) {
    return { path, contents: text };
  }
  return { path, contents: bytesToBase64(contents), encoding: "base64" };
}
function bytesFromNodeValue(value) {
  if (typeof value === "string") return utf8Bytes(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (Array.isArray(value)) return new Uint8Array(value.map((item) => Number(item) & 255));
  return utf8Bytes(String(value));
}
function requestedEncodingFromOptions(options) {
  if (typeof options === "string") return options;
  return typeof options?.encoding === "string" ? options.encoding : void 0;
}
function bytesFromFsWriteValue(value, options) {
  const encoding = requestedEncodingFromOptions(options);
  if (typeof value === "string" && typeof encoding === "string") {
    return BrowserBuffer.from(value, encoding);
  }
  return bytesFromNodeValue(value);
}
function browserBufferFromBytes(value) {
  return BrowserBuffer.from(value);
}
function textFromBytes(bytes) {
  return textDecoder2.decode(bytes);
}
function bytesToRuntimeHttpBody(bytes) {
  const text = textDecoder2.decode(bytes);
  return byteEqual(utf8Bytes(text), bytes) ? { body: text } : { body: bytesToBase64(bytes), bodyEncoding: "base64" };
}
function bytesFromRuntimeHttpBody(message) {
  if (message.body === void 0) return new Uint8Array();
  return message.bodyEncoding === "base64" ? base64ToBytes(message.body) : utf8Bytes(message.body);
}
function concatBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
function bytesToHex(value) {
  return Array.from(value).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(value) {
  const normalized = value.trim();
  const bytes = new Uint8Array(Math.ceil(normalized.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2).padEnd(2, "0"), 16) & 255;
  }
  return bytes;
}
var BrowserBuffer = class _BrowserBuffer extends Uint8Array {
  static from(value, encodingOrMapfn, thisArg) {
    if (typeof value === "string") {
      const encoding = typeof encodingOrMapfn === "string" ? encodingOrMapfn : void 0;
      if (encoding === "base64") return new _BrowserBuffer(base64ToBytes(value));
      if (encoding === "hex") return new _BrowserBuffer(hexToBytes(value));
      if (encoding === "latin1" || encoding === "binary") {
        return new _BrowserBuffer(Array.from(value, (char) => char.charCodeAt(0) & 255));
      }
      return new _BrowserBuffer(utf8Bytes(value));
    }
    if (typeof encodingOrMapfn === "function" && value != null) {
      return new _BrowserBuffer(Array.from(value, encodingOrMapfn, thisArg));
    }
    return new _BrowserBuffer(bytesFromNodeValue(value));
  }
  static alloc(size, fill = 0) {
    const bytes = new _BrowserBuffer(Math.max(0, Number(size) || 0));
    bytes.fill(Number(fill) & 255);
    return bytes;
  }
  static isBuffer(value) {
    return value instanceof _BrowserBuffer;
  }
  static concat(values) {
    const totalLength = values.reduce((sum, value) => sum + value.byteLength, 0);
    const bytes = new _BrowserBuffer(totalLength);
    let offset = 0;
    for (const value of values) {
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    return bytes;
  }
  static byteLength(value, encoding) {
    if (typeof value === "string") return _BrowserBuffer.from(value, encoding).byteLength;
    return bytesFromNodeValue(value).byteLength;
  }
  toString(encoding = "utf8") {
    if (encoding === "base64") return bytesToBase64(this);
    if (encoding === "hex") return bytesToHex(this);
    if (encoding === "latin1" || encoding === "binary") {
      return Array.from(this, (byte) => String.fromCharCode(byte)).join("");
    }
    return textFromBytes(this);
  }
};
function createZlibApi() {
  return {
    gzipSync: (input) => browserBufferFromBytes(fflate.gzipSync(bytesFromNodeValue(input))),
    gunzipSync: (input) => browserBufferFromBytes(fflate.gunzipSync(bytesFromNodeValue(input))),
    deflateSync: (input) => browserBufferFromBytes(fflate.deflateSync(bytesFromNodeValue(input))),
    inflateSync: (input) => browserBufferFromBytes(fflate.inflateSync(bytesFromNodeValue(input)))
  };
}

// packages/runtime-javascript/src/kernel/process-control.ts
function processArgvForRequest(request) {
  const executable = "/usr/local/bin/node";
  if (request.source === "argument") {
    return [executable, ...request.args];
  }
  if (request.source === "stdin") {
    return [executable, "-", ...request.args];
  }
  const requestedScriptPath = request.scriptPath || "<anonymous>";
  const scriptPath = requestedScriptPath.startsWith("/") ? requestedScriptPath : `${request.project.workspaceRoot ?? request.project.cwd ?? "/workspace"}/${normalizeProjectPath([
    workspaceCwdPath(request),
    requestedScriptPath
  ].filter(Boolean).join("/"))}`;
  return [executable, scriptPath, ...request.args];
}
function createTraceKernelApi(executionState) {
  const dispatchWatchdog = (request) => {
    if (!executionState.kernelSyscalls) {
      throw Object.assign(
        new Error("ENOSYS: TraceKernel process controls are unavailable"),
        { code: "ENOSYS" }
      );
    }
    const result = executionState.kernelSyscalls.dispatchSync(request);
    if (result.ok === false) {
      throw Object.assign(new Error(result.error.message), {
        code: result.error.code
      });
    }
    if (result.value.op !== "watchdog") {
      throw Object.assign(
        new Error(`EPROTO: expected watchdog response, received ${result.value.op}`),
        { code: "EPROTO" }
      );
    }
    return Object.freeze({
      armed: result.value.armed,
      ...result.value.timeoutMs === void 0 ? {} : { timeoutMs: result.value.timeoutMs },
      ...result.value.signal === void 0 ? {} : { signal: result.value.signal },
      ...result.value.deadlineAt === void 0 ? {} : { deadlineAt: result.value.deadlineAt }
    });
  };
  const dispatchTerminal = (request) => {
    const operation = request.op;
    if (!executionState.kernelSyscalls) {
      throw Object.assign(
        new Error("ENOSYS: TraceKernel terminal controls are unavailable"),
        { code: "ENOSYS" }
      );
    }
    const result = executionState.kernelSyscalls.dispatchSync(request);
    if (result.ok === false) {
      throw Object.assign(new Error(result.error.message), {
        code: result.error.code
      });
    }
    if (result.value.op !== operation) {
      throw Object.assign(
        new Error(
          `EPROTO: expected ${operation} response, received ${result.value.op}`
        ),
        { code: "EPROTO" }
      );
    }
    return result.value;
  };
  return Object.freeze({
    watchdog: Object.freeze({
      arm: (timeoutMs, options = {}) => dispatchWatchdog({
        op: "watchdog",
        action: "arm",
        timeoutMs,
        ...options.signal ? { signal: options.signal } : {}
      }),
      pet: () => dispatchWatchdog({
        op: "watchdog",
        action: "pet"
      }),
      disarm: () => dispatchWatchdog({
        op: "watchdog",
        action: "disarm"
      }),
      status: () => dispatchWatchdog({
        op: "watchdog",
        action: "status"
      })
    }),
    terminal: Object.freeze({
      isatty: (fd2) => dispatchTerminal({ op: "isatty", fd: fd2 }).isTerminal,
      foregroundProcessGroup: (fd2 = 0) => dispatchTerminal({ op: "tcgetpgrp", fd: fd2 }).pgid,
      setForegroundProcessGroup: (pgid, fd2 = 0) => dispatchTerminal({ op: "tcsetpgrp", fd: fd2, pgid }).pgid,
      windowSize: (fd2 = 0) => {
        const size = dispatchTerminal({ op: "tcgetwinsize", fd: fd2 });
        return Object.freeze({ rows: size.rows, columns: size.columns });
      },
      setWindowSize: (rows, columns, fd2 = 0) => {
        const size = dispatchTerminal({
          op: "tcsetwinsize",
          fd: fd2,
          rows,
          columns
        });
        return Object.freeze({ rows: size.rows, columns: size.columns });
      }
    })
  });
}

// packages/runtime-javascript/src/kernel/workspace-paths.ts
function workspacePathInputToString(path) {
  if (path instanceof URL) {
    if (path.protocol !== "file:") {
      throw new TypeError("The URL must be of scheme file");
    }
    return decodeURIComponent(path.pathname);
  }
  return String(path);
}
function runtimeWriteTarget(path, devices) {
  if (typeof path === "number") return null;
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: "error", reason: "proc-read-only", path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelWriteTarget(raw, devices);
}
function runtimeMetadataTarget(path, devices) {
  if (typeof path === "number") return null;
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: "error", reason: "proc-read-only", path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelMetadataTarget(raw, devices);
}
function runtimeAccessTarget(path, mode, devices, procSnapshot) {
  if (typeof path === "number") return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? "/proc";
    return (mode & 2) !== 0 ? { kind: "denied", reason: "permission-denied", path: procPath } : { kind: "allowed", path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) {
    return (mode & 2) !== 0 ? { kind: "denied", reason: "permission-denied", path: readonlyPath } : { kind: "denied", reason: "not-found", path: readonlyPath };
  }
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelAccessTarget(raw, {
    read: (mode & 4) !== 0,
    write: (mode & 2) !== 0,
    execute: (mode & 1) !== 0
  }, devices);
}
function runtimeOpenTarget(path, request, devices, procSnapshot) {
  if (typeof path === "number") return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? "/proc";
    if (procKind === "directory") return { kind: "error", reason: "is-directory", path: procPath };
    if (request?.writable || request?.create || request?.truncate || request?.exclusive) {
      return { kind: "error", reason: "read-only", path: procPath };
    }
    return { kind: "proc-file", path: procPath, readable: true, writable: false };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) {
    return request?.writable || request?.create || request?.truncate || request?.exclusive ? { kind: "error", reason: "read-only", path: readonlyPath } : { kind: "error", reason: "not-found", path: readonlyPath };
  }
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelOpenTarget(raw, request, devices);
}
function runtimeReadTarget(path, devices, procSnapshot) {
  if (typeof path === "number") return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? "/proc";
    return procKind === "file" ? { kind: "proc-file", path: procPath } : { kind: "proc-directory", path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: "error", reason: "not-found", path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelReadTarget(raw, devices);
}
function runtimeFileReadTarget(path, devices, procSnapshot) {
  if (typeof path === "number") return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? "/proc";
    return procKind === "file" ? { kind: "proc-file", path: procPath } : { kind: "error", reason: "is-directory", path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: "error", reason: "not-found", path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelFileReadTarget(raw, devices);
}
function runtimeCopyTarget(source, destination, devices, procSnapshot) {
  if (typeof source === "number" || typeof destination === "number") return null;
  const sourceKind = browserProcEntryKind(procSnapshot, source);
  const destinationReadonlyPath = browserReadonlyKernelNamespacePath(destination);
  if (sourceKind === "file" || destinationReadonlyPath) return { kind: "file-copy" };
  if (sourceKind === "directory") return { kind: "error", reason: "source-directory", path: normalizeBrowserProcPath(source) ?? String(source) };
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelCopyTarget(sourceRaw, destinationRaw, devices);
}
function runtimeFileCopyTarget(source, destination, devices, procSnapshot) {
  if (typeof source === "number" || typeof destination === "number") return null;
  const destinationReadonlyPath = browserReadonlyKernelNamespacePath(destination);
  if (destinationReadonlyPath) {
    return { kind: "error", side: "destination", reason: "proc-read-only", path: destinationReadonlyPath };
  }
  const sourceKind = browserProcEntryKind(procSnapshot, source);
  if (sourceKind) {
    const sourcePath = normalizeBrowserProcPath(source) ?? String(source);
    if (sourceKind === "directory") {
      return { kind: "error", side: "source", reason: "is-directory", path: sourcePath };
    }
    const writeTarget = runtimeWriteTarget(destination, devices);
    if (writeTarget?.kind === "error") {
      return { kind: "error", side: "destination", reason: writeTarget.reason, path: writeTarget.path };
    }
    if (writeTarget?.kind === "device") {
      return {
        kind: "device-destination",
        device: writeTarget.device,
        outputDevice: writeTarget.outputDevice,
        source: { kind: "proc-file", path: sourcePath }
      };
    }
    return { kind: "virtual-source", source: { kind: "proc-file", path: sourcePath } };
  }
  const sourceReadonlyPath = browserReadonlyKernelNamespacePath(source);
  if (sourceReadonlyPath) {
    return { kind: "error", side: "source", reason: "not-found", path: sourceReadonlyPath };
  }
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelFileCopyTarget(sourceRaw, destinationRaw, devices);
}
function runtimeLinkTarget(source, destination, devices) {
  if (typeof source === "number" || typeof destination === "number") return null;
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelLinkTarget(sourceRaw, destinationRaw, devices);
}
function runtimeRenameTarget(source, destination, devices) {
  if (typeof source === "number" || typeof destination === "number") return null;
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelRenameTarget(sourceRaw, destinationRaw, devices);
}
function runtimeSymlinkTarget(linkPath, devices) {
  if (typeof linkPath === "number") return null;
  const raw = workspacePathInputToString(linkPath).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelSymlinkTarget(raw, devices);
}
function runtimeRemoveTarget(path, devices) {
  if (typeof path === "number") return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelRemoveTarget(raw, devices);
}
function runtimeMkdirTarget(path, devices) {
  if (typeof path === "number") return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelMkdirTarget(raw, devices);
}
function runtimeTruncateTarget(path, devices) {
  if (typeof path === "number") return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelTruncateTarget(raw, devices);
}
function runtimeDirectoryTarget(path, devices, procSnapshot) {
  if (typeof path === "number") return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? "/proc";
    return procKind === "directory" ? { kind: "directory", path: procPath, entries: [...procSnapshot?.directories.get(procPath) ?? []] } : { kind: "error", reason: "not-directory", path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: "error", reason: "not-found", path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelDirectoryTarget(raw, devices);
}
function runtimeStatTarget(path, info, devices, procSnapshot) {
  if (typeof path === "number") return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? "/proc";
    const contents = procKind === "file" ? browserProcFileContents(procSnapshot, procPath, info) : "";
    return {
      kind: "stat",
      path: procPath,
      stat: {
        isFile: procKind === "file",
        isDirectory: procKind === "directory",
        isCharacterDevice: false,
        mode: procKind === "directory" ? 365 : 292,
        size: textEncoder3.encode(contents).byteLength
      }
    };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: "error", reason: "not-found", path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return runtimeKernelStatTarget(raw, info, devices);
}
function throwRuntimeWriteTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelWriteErrorCode(target.reason) });
}
function throwRuntimeMetadataTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelMetadataErrorCode(target.reason) });
}
function throwRuntimeReadTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelFileReadErrorCode(target.reason) });
}
function throwRuntimeLinkTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelLinkErrorCode(target.reason) });
}
function throwRuntimeRenameTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelRenameErrorCode(target.reason) });
}
function throwRuntimeSymlinkTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelSymlinkErrorCode(target.reason) });
}
function throwRuntimeRemoveTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelRemoveErrorCode(target.reason) });
}
function throwRuntimeMkdirTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelMkdirErrorCode(target.reason) });
}
function throwRuntimeTruncateTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelTruncateErrorCode(target.reason) });
}
function throwRuntimeDirectoryTargetError(target, message) {
  throw Object.assign(new Error(message), { code: runtimeKernelDirectoryErrorCode(target.reason) });
}
function normalizeAbsoluteWorkspaceRoot(path) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.startsWith("/") ? normalized || "/" : `/${normalized}`;
}
function createWorkspacePathContext(project) {
  return {
    root: normalizeAbsoluteWorkspaceRoot(project.workspaceRoot ?? project.cwd ?? "/workspace"),
    ...project.workspaceAlias ? { alias: normalizeAbsoluteWorkspaceRoot(project.workspaceAlias) } : {}
  };
}
function fallbackKernelInfo(project, workspace) {
  const root = workspace.root;
  const parts = root.split("/").filter(Boolean);
  const workspaceName = parts.at(-1) ?? "workspace";
  const username = parts.length >= 2 && parts[0] === "home" ? parts[1] ?? "user" : "user";
  const home = parts.length >= 2 && parts[0] === "home" ? `/${parts.slice(0, 2).join("/")}` : dirname(root) || root;
  const startedAt = (/* @__PURE__ */ new Date(0)).toISOString();
  return {
    name: "tracekernel",
    version: TRACECODE_HARNESS_VERSION,
    user: {
      id: username,
      username,
      home
    },
    host: {
      hostname: "tracevm",
      osName: "tracekernel"
    },
    workspace: {
      id: `${workspaceName}-${startedAt.replace(/[:.]/g, "-")}`,
      name: workspaceName,
      root,
      startedAt
    },
    home,
    cwd: project.cwd ?? root,
    workspaceRoot: root,
    ...workspace.alias ? { workspaceAlias: workspace.alias } : {}
  };
}
function normalizeBrowserProcPath(path) {
  if (typeof path === "number") return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return raw === "/proc" || raw.startsWith("/proc/") || raw === "/skills" || raw.startsWith("/skills/") || raw === "/etc" || raw.startsWith("/etc/") ? raw : null;
}
function browserReadonlyKernelNamespacePath(path) {
  if (typeof path === "number") return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return raw === "/skills" || raw.startsWith("/skills/") || raw === "/etc" || raw.startsWith("/etc/") ? raw : null;
}
function createBrowserProcSnapshot(kernelFiles, request) {
  const files = /* @__PURE__ */ new Map();
  const directoryEntries = /* @__PURE__ */ new Map();
  const ensureDirectory = (path) => {
    if (!directoryEntries.has(path)) directoryEntries.set(path, /* @__PURE__ */ new Map());
    if (path === "/") return;
    const parent = dirname(path);
    if (parent && parent !== path) {
      ensureDirectory(parent);
      const name = path.slice(parent === "/" ? 1 : parent.length + 1);
      directoryEntries.get(parent)?.set(name, { name, kind: "directory" });
    }
  };
  const addFile = (path, contents) => {
    const normalized = normalizeBrowserProcPath(path);
    if (!normalized) return;
    files.set(normalized, contents);
    const parent = dirname(normalized);
    ensureDirectory(parent);
    const name = normalized.slice(parent === "/" ? 1 : parent.length + 1);
    directoryEntries.get(parent)?.set(name, { name, kind: "file" });
  };
  ensureDirectory("/skills");
  for (const file of kernelFiles ?? []) addFile(file.path, file.contents);
  if (request?.process) {
    const argv = processArgvForRequest(request);
    const command = argv.join(" ");
    const status = [
      `Name:	${(request.scriptPath || "node").split("/").at(-1) || "node"}`,
      "State:	R (running)",
      `Pid:	${request.process.pid}`,
      `PPid:	${request.process.ppid}`,
      `PGid:	${request.process.pgid}`,
      `Sid:	${request.process.sid}`,
      "FDSize:	3",
      "Uid:	1000	1000	1000	1000",
      "Gid:	1000	1000	1000	1000",
      `Command:	${command}`,
      ""
    ].join("\n");
    const cmdline = `${argv.join("\0")}\0`;
    for (const root of ["/proc/self", `/proc/${request.process.pid}`]) {
      addFile(`${root}/status`, status);
      addFile(`${root}/cmdline`, cmdline);
    }
  }
  const directories = /* @__PURE__ */ new Map();
  for (const [path, entries] of directoryEntries) {
    if (path === "/" || !(path === "/proc" || path.startsWith("/proc/") || path === "/skills" || path.startsWith("/skills/") || path === "/etc" || path.startsWith("/etc/"))) continue;
    directories.set(path, [...entries.values()].sort((left, right) => left.name.localeCompare(right.name)));
  }
  return { files, directories };
}
function browserProcEntryKind(snapshot, path) {
  const normalized = normalizeBrowserProcPath(path);
  if (!normalized || !snapshot) return null;
  if (snapshot.files.has(normalized)) return "file";
  if (snapshot.directories.has(normalized)) return "directory";
  return null;
}
function browserProcFileContents(snapshot, path, info) {
  const contents = snapshot?.files.get(path);
  return contents !== void 0 ? contents : readPublicRuntimeProcFile(path, info);
}
function workspaceRelativeFromAbsolutePath(rawPath, workspace) {
  const raw = normalizeAbsoluteWorkspaceRoot(rawPath);
  if (raw === workspace.root) return "";
  if (raw.startsWith(`${workspace.root}/`)) return raw.slice(workspace.root.length + 1);
  if (workspace.alias && raw === workspace.alias) return "";
  if (workspace.alias && raw.startsWith(`${workspace.alias}/`)) return raw.slice(workspace.alias.length + 1);
  return null;
}
function normalizeWorkspaceEntryPath(path, basePath = "", allowRoot = false, workspace = { root: "/workspace" }) {
  const rawInput = workspacePathInputToString(path);
  const raw = rawInput.replace(/\\/g, "/");
  const workspaceRelative = raw.startsWith("/") ? workspaceRelativeFromAbsolutePath(raw, workspace) : null;
  const withBase = workspaceRelative !== null ? workspaceRelative : raw.startsWith("/") ? raw : basePath ? `${basePath}/${raw}` : raw;
  const cleaned = withBase.replace(/\\/g, "/").replace(/^\.\//, "");
  if (cleaned.startsWith("/") || /^[A-Za-z]:\//.test(cleaned)) {
    throw new Error(`Path must be inside workspace: ${rawInput}`);
  }
  const parts = [];
  for (const part of cleaned.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) {
        throw new Error(`Path must not escape workspace: ${rawInput}`);
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  if (parts.length === 0) {
    if (allowRoot) return "";
    throw new Error(`Path must point to a file: ${rawInput}`);
  }
  return parts.join("/");
}
function assertSafeWorkspaceFilePath(path, basePath = "", workspace = { root: "/workspace" }) {
  return normalizeWorkspaceEntryPath(path, basePath, false, workspace);
}

// packages/runtime-javascript/src/modules/resolution.ts
function workspaceFilename(path, workspaceRoot = "/workspace") {
  const normalized = normalizeProjectPath(path);
  return normalized ? `${workspaceRoot}/${normalized}` : workspaceRoot;
}
function workspaceFileUrl(path, workspaceRoot = "/workspace") {
  return `file://${workspaceFilename(path, workspaceRoot).split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}
function relativeWorkspacePath(from, to) {
  const fromParts = normalizeProjectPath(from).split("/").filter(Boolean);
  const toParts = normalizeProjectPath(to).split("/").filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common += 1;
  }
  return [
    ...fromParts.slice(common).map(() => ".."),
    ...toParts.slice(common)
  ].join("/") || ".";
}
function workspaceDirname(path, workspaceRoot = "/workspace") {
  const normalizedDir = dirname(normalizeProjectPath(path));
  return normalizedDir ? `${workspaceRoot}/${normalizedDir}` : workspaceRoot;
}
function joinModulePath(parentPath, specifier) {
  const parentDir = dirname(parentPath);
  const joined = `${parentDir}/${specifier}`.replace(/^\//, "");
  const parts = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}
function moduleFileCandidates(path) {
  const normalized = normalizeProjectPath(path);
  const candidates = [normalized];
  if (!/\.(?:cjs|js|json|mjs)$/.test(normalized)) {
    candidates.push(`${normalized}.js`, `${normalized}.json`, `${normalized}.mjs`, `${normalized}.cjs`);
  }
  return candidates;
}
function parsePackageJson(modules, path) {
  const normalized = normalizeProjectPath(path);
  const packageJson = modules.get(normalized ? `${normalized}/package.json` : "package.json");
  if (!packageJson) return null;
  try {
    return JSON.parse(packageJson);
  } catch {
    return null;
  }
}
function manifestDeclaresDependency(manifest, dependency) {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = manifest[field];
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies) && dependency in dependencies) {
      return true;
    }
  }
  return false;
}
function projectDeclaresDependency(modules, dependency) {
  for (const path of modules.keys()) {
    if (!path.endsWith("package.json")) continue;
    const directory = dirname(path);
    const manifest = parsePackageJson(modules, directory);
    if (manifest && manifestDeclaresDependency(manifest, dependency)) return true;
  }
  return false;
}
function packageExportTarget(value, condition) {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (!value || typeof value !== "object") return null;
  const record = value;
  return packageExportTarget(record[condition], condition) ?? packageExportTarget(record.node, condition) ?? packageExportTarget(record.default, condition) ?? packageExportTarget(condition === "require" ? record.import : record.require, condition);
}
function packageMainCandidates(modules, path, condition) {
  const normalized = normalizeProjectPath(path);
  const parsed = parsePackageJson(modules, normalized);
  if (!parsed) return [];
  const candidates = [];
  const exportsTarget = packageExportTarget(parsed.exports, condition);
  if (exportsTarget) {
    candidates.push(...moduleFileCandidates(`${normalized}/${exportsTarget}`));
  }
  if (parsed.exports && typeof parsed.exports === "object" && !Array.isArray(parsed.exports)) {
    const dotTarget = packageExportTarget(parsed.exports["."], condition);
    if (dotTarget) {
      candidates.push(...moduleFileCandidates(`${normalized}/${dotTarget}`));
    }
  }
  if (typeof parsed.module === "string" && parsed.module.trim().length > 0) {
    candidates.push(...moduleFileCandidates(`${normalized}/${parsed.module}`));
  }
  if (typeof parsed.main === "string" && parsed.main.trim().length > 0) {
    candidates.push(...moduleFileCandidates(`${normalized}/${parsed.main}`));
  }
  return candidates;
}
function packageSpecifierParts(specifier) {
  const parts = normalizeProjectPath(specifier).split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0]?.startsWith("@")) {
    if (parts.length < 2) return null;
    return {
      packageName: `${parts[0]}/${parts[1]}`,
      subpath: parts.length > 2 ? `./${parts.slice(2).join("/")}` : "."
    };
  }
  return {
    packageName: parts[0] ?? "",
    subpath: parts.length > 1 ? `./${parts.slice(1).join("/")}` : "."
  };
}
function packageExportCandidates(modules, specifier, condition) {
  const parsedSpecifier = packageLocationForSpecifier(specifier);
  if (!parsedSpecifier) return [];
  const packageRoot = parsedSpecifier.packageRoot;
  const parsed = parsePackageJson(modules, packageRoot);
  if (!parsed?.exports) return [];
  const exportTarget = parsedSpecifier.subpath === "." ? packageExportTarget(parsed.exports, condition) : typeof parsed.exports === "object" && !Array.isArray(parsed.exports) ? packageExportTarget(parsed.exports[parsedSpecifier.subpath], condition) : null;
  if (!exportTarget) {
    return [];
  }
  return moduleFileCandidates(`${packageRoot}/${exportTarget}`);
}
function packageLocationForSpecifier(specifier) {
  const normalized = normalizeProjectPath(specifier);
  const parts = normalized.split("/").filter(Boolean);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex !== -1) {
    const packageStart = nodeModulesIndex + 1;
    const first = parts[packageStart];
    if (!first) return null;
    const packageLength = first.startsWith("@") ? 2 : 1;
    const packageParts = parts.slice(packageStart, packageStart + packageLength);
    if (packageParts.length !== packageLength || packageParts.some((part) => !part)) return null;
    const packageRoot = parts.slice(0, packageStart + packageLength).join("/");
    const subpathParts = parts.slice(packageStart + packageLength);
    return {
      packageRoot,
      subpath: subpathParts.length > 0 ? `./${subpathParts.join("/")}` : "."
    };
  }
  const parsedSpecifier = packageSpecifierParts(normalized);
  if (!parsedSpecifier) return null;
  return {
    packageRoot: `node_modules/${parsedSpecifier.packageName}`,
    subpath: parsedSpecifier.subpath
  };
}
function moduleCandidates(modules, path, condition) {
  const normalized = normalizeProjectPath(path);
  return [
    ...packageExportCandidates(modules, normalized, condition),
    ...moduleFileCandidates(normalized),
    ...packageMainCandidates(modules, normalized, condition),
    `${normalized}/index.js`,
    `${normalized}/index.json`
  ];
}
function nodePathEntries(request, cwdPath, workspace) {
  const rawNodePath = request.env.NODE_PATH;
  if (typeof rawNodePath !== "string" || rawNodePath.trim().length === 0) {
    return [];
  }
  return rawNodePath.split(":").map((entry) => entry.trim()).filter(Boolean).map((entry) => normalizeWorkspaceEntryPath(entry, cwdPath, true, workspace)).filter((entry, index, entries) => entries.indexOf(entry) === index);
}
function packageTypeForPath(modules, path) {
  const normalized = normalizeProjectPath(path);
  const parts = normalized.split("/");
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const directory = parts.slice(0, index).join("/");
    const parsed = parsePackageJson(modules, directory);
    if (typeof parsed?.type === "string") return parsed.type;
  }
  return null;
}
function isEsmModule(modules, path) {
  const normalized = normalizeProjectPath(path);
  if (normalized.endsWith(".mjs")) return true;
  if (normalized.endsWith(".cjs") || normalized.endsWith(".json")) return false;
  return normalized.endsWith(".js") && packageTypeForPath(modules, normalized) === "module";
}
function toRequireBinding(specifier) {
  return `require(${JSON.stringify(specifier)})`;
}
function toDynamicImportBinding(specifier) {
  return `__import(${JSON.stringify(specifier)})`;
}
function transformDynamicImports(code) {
  return code.replace(
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    (_match, _quote, specifier) => toDynamicImportBinding(specifier)
  );
}
function defaultImportBinding(name, specifier, index) {
  const moduleName = `__tracecode_esm_default_${index}`;
  return [
    `const ${moduleName} = ${toRequireBinding(specifier)};`,
    `const ${name} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`
  ].join(" ");
}
function transformNamedBindings(bindings) {
  return bindings.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [importedName, localName] = part.split(/\s+as\s+/).map((value) => value.trim());
    return localName ? `${importedName}: ${localName}` : importedName;
  }).join(", ");
}
function namedExportAssignments(bindings, moduleName) {
  return bindings.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [localName, exportedName] = part.split(/\s+as\s+/).map((value) => value.trim());
    const targetName = exportedName ?? localName;
    const source = moduleName ? `${moduleName}.${localName}` : localName;
    return `exports.${targetName} = ${source};`;
  }).join(" ");
}
function transformStaticEsmToCommonJs(code, importMetaUrl) {
  let defaultImportIndex = 0;
  let reExportIndex = 0;
  return transformDynamicImports(code).replace(
    /\bimport\.meta\.url\b/g,
    JSON.stringify(importMetaUrl ?? "file:///workspace/[eval]")
  ).replace(
    /^\s*export\s+\*\s+from\s+(['"])([^'"]+)\1\s*;?\s*$/gm,
    (_match, _quote, specifier) => {
      const moduleName = `__tracecode_esm_reexport_${reExportIndex++}`;
      return `const ${moduleName} = ${toRequireBinding(specifier)}; for (const __tracecode_key of Object.keys(${moduleName})) { if (__tracecode_key !== "default") exports[__tracecode_key] = ${moduleName}[__tracecode_key]; }`;
    }
  ).replace(
    /^\s*export\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
    (_match, namedExports, _quote, specifier) => {
      const moduleName = `__tracecode_esm_reexport_${reExportIndex++}`;
      return `const ${moduleName} = ${toRequireBinding(specifier)}; ${namedExportAssignments(namedExports, moduleName)}`;
    }
  ).replace(
    /^\s*import\s+([\w$]+)\s*,\s*\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/gm,
    (_match, defaultName, namespaceName, _quote, specifier) => {
      const required = toRequireBinding(specifier);
      const moduleName = `__tracecode_esm_default_${defaultImportIndex++}`;
      return `const ${namespaceName} = ${required}; const ${moduleName} = ${namespaceName}; const ${defaultName} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`;
    }
  ).replace(
    /^\s*import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/gm,
    (_match, defaultName, namedImports, _quote, specifier) => {
      const required = toRequireBinding(specifier);
      const moduleName = `__tracecode_esm_default_${defaultImportIndex++}`;
      return `const ${moduleName} = ${required}; const { ${transformNamedBindings(namedImports)} } = ${moduleName}; const ${defaultName} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`;
    }
  ).replace(
    /^\s*import\s+\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
    (_match, namespaceName, _quote, specifier) => `const ${namespaceName} = ${toRequireBinding(specifier)};`
  ).replace(
    /\bimport\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;?/g,
    (_match, namedImports, _quote, specifier) => `const { ${transformNamedBindings(namedImports)} } = ${toRequireBinding(specifier)};`
  ).replace(
    /^\s*import\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
    (_match, defaultName, _quote, specifier) => defaultImportBinding(defaultName, specifier, defaultImportIndex++)
  ).replace(
    /^\s*import\s+(['"])([^'"]+)\1\s*;?\s*$/gm,
    (_match, _quote, specifier) => `${toRequireBinding(specifier)};`
  ).replace(
    /^\s*export\s+function\s+([\w$]+)\s*\(/gm,
    (_match, name) => `exports.${name} = function ${name}(`
  ).replace(
    /^\s*export\s+class\s+([\w$]+)\s*/gm,
    (_match, name) => `exports.${name} = class ${name} `
  ).replace(
    /^\s*export\s+(const|let|var)\s+([\w$]+)\s*=/gm,
    (_match, declaration, name) => `${declaration} ${name} = exports.${name} =`
  ).replace(
    /^\s*export\s+default\s+/gm,
    "exports.default = "
  ).replace(
    /^\s*export\s+\{([^}]+)\}\s*;?\s*$/gm,
    (_match, namedExports) => namedExportAssignments(namedExports)
  );
}
function resolveModulePath(modules, specifier, parentPath, nodePathSearchEntries = [], condition = "require") {
  const basePaths = specifier.startsWith(".") ? [joinModulePath(parentPath, specifier)] : [
    ...nodeModulesSearchPaths(parentPath, specifier),
    specifier,
    ...nodePathSearchEntries.map((entry) => entry ? `${entry}/${specifier}` : specifier)
  ];
  for (const basePath of basePaths) {
    for (const candidate of moduleCandidates(modules, basePath, condition)) {
      if (modules.has(candidate)) return candidate;
    }
  }
  throw new Error(`Cannot find module '${specifier}'`);
}
function nodeModulesSearchPaths(parentPath, specifier) {
  const parentDirectory = dirname(normalizeProjectPath(parentPath));
  const parts = parentDirectory ? parentDirectory.split("/").filter(Boolean) : [];
  const paths = [];
  for (let index = parts.length; index >= 0; index -= 1) {
    const directory = parts.slice(0, index).join("/");
    paths.push(directory ? `${directory}/node_modules/${specifier}` : `node_modules/${specifier}`);
  }
  return paths;
}
function moduleSearchPaths(parentPath, workspaceRoot = "/workspace") {
  return nodeModulesSearchPaths(parentPath, "").map((path) => workspaceFilename(path.replace(/\/$/, ""), workspaceRoot));
}
function formatConsoleValues(values) {
  return values.map((value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack ?? value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ");
}
function formatBrowserJavaScriptErrorForStderr(error) {
  if (error instanceof Error) {
    const text = typeof error.stack === "string" && error.stack.trim() ? error.stack : error.message;
    return `${text.trimEnd()}
`;
  }
  return `${String(error)}
`;
}
function isBrowserJavaScriptUserStackFrame(line, sourcePath) {
  return line.includes(sourcePath) || line.includes("/workspace/");
}
function isBrowserJavaScriptInternalStackFrame(line) {
  return line.includes("/@fs/") || line.includes("/packages/harness-") || line.includes("/dist/browser/project.js") || line.includes("/workers/javascript-project-worker.js") || line.includes("javascript-project-worker.js:") || line.includes("blob:") || line.includes("runBrowserJavaScriptProjectRequest") || line.includes("executeEntrypoint") || line.includes("executeModule") || line.includes("resolveModulePath") || line.includes("requireModule") || line.includes("createHttpApi") || line.includes("registerHttpListener") || line.includes("at new Function") || line.includes("at new AsyncFunction");
}
function sanitizeBrowserJavaScriptStack(error, sourcePath) {
  if (!(error instanceof Error) || typeof error.stack !== "string" || !error.stack.trim()) {
    return error;
  }
  const mappedStack = error.stack.replace(
    /\(eval at [^,]+ \([^)]*\), <anonymous>:(\d+):(\d+)\)/g,
    (_match, line, column) => `(${sourcePath}:${Math.max(1, Number(line) - 2)}:${column})`
  );
  const stackLines = mappedStack.split("\n");
  const lines = [stackLines[0] ?? error.message];
  for (const line of stackLines.slice(1)) {
    if (isBrowserJavaScriptUserStackFrame(line, sourcePath)) {
      lines.push(line);
      continue;
    }
    if (isBrowserJavaScriptInternalStackFrame(line)) continue;
  }
  if (lines.length === 1) lines.push(`    at ${sourcePath}:1:1`);
  Object.defineProperty(error, "stack", {
    configurable: true,
    value: lines.join("\n")
  });
  return error;
}

// packages/runtime-javascript/src/browser/worker-client.ts
function requireModulesForRequest(request) {
  return Array.isArray(request.options?.require) ? request.options.require.filter((item) => typeof item === "string") : [];
}

// packages/runtime-javascript/src/modules/constructors.ts
var AsyncFunction = Object.getPrototypeOf(async function noop() {
}).constructor;
var BrowserFunction = Function;

// packages/runtime-javascript/src/kernel/filesystem-identity.ts
function inodeForPath(path) {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

// packages/runtime-javascript/src/kernel/stdio.ts
function createReadableStdinDevice(readBytes, remainingBytes, isClosed = () => true, schedulePoll = (callback, delay) => setTimeout(callback, delay), terminal, kernelIsTerminal) {
  let encoding;
  let flowScheduled = false;
  let pollScheduled = false;
  let destroyed = false;
  let ended = false;
  let readableFlowing = null;
  let rawMode = false;
  const dataListeners = [];
  const endListeners = [];
  const formatChunk = (chunk) => encoding ? chunk.toString(encoding) : chunk;
  const read = (size) => {
    if (remainingBytes() <= 0) {
      ended = isClosed();
      return null;
    }
    const requested = typeof size === "number" && size >= 0 ? Math.floor(size) : void 0;
    const chunk = BrowserBuffer.from(readBytes(requested));
    if (remainingBytes() <= 0) ended = isClosed();
    return formatChunk(chunk);
  };
  const scheduleFlow = () => {
    if (flowScheduled) return;
    if (readableFlowing === false) return;
    flowScheduled = true;
    queueMicrotask(() => {
      if (destroyed) return;
      const chunk = read();
      if (chunk !== null) {
        for (const listener of dataListeners) listener(chunk);
        if (ended) {
          for (const listener of endListeners) listener();
        } else {
          flowScheduled = false;
          scheduleFlow();
        }
        return;
      }
      if (!isClosed()) {
        flowScheduled = false;
        if (!pollScheduled) {
          pollScheduled = true;
          schedulePoll(() => {
            pollScheduled = false;
            scheduleFlow();
          }, 8);
        }
        return;
      }
      ended = true;
      for (const listener of endListeners) listener();
    });
  };
  const on = (event, listener) => {
    if (event === "data") {
      dataListeners.push(listener);
      if (readableFlowing === null) readableFlowing = true;
      scheduleFlow();
    } else if (event === "end") {
      endListeners.push(listener);
      scheduleFlow();
    }
    return stream;
  };
  const removeListener = (event, listener) => {
    const listeners = event === "data" ? dataListeners : event === "end" ? endListeners : null;
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    }
    return stream;
  };
  const stream = {
    fd: 0,
    readable: true,
    isTTY: kernelIsTerminal ?? terminal?.isTTY === true,
    get isRaw() {
      return rawMode;
    },
    setRawMode: (enabled = true) => {
      rawMode = Boolean(enabled);
      return stream;
    },
    get readableEnded() {
      return ended;
    },
    get readableEncoding() {
      return encoding ?? null;
    },
    get readableFlowing() {
      return readableFlowing;
    },
    get readableLength() {
      return Math.max(0, remainingBytes());
    },
    setEncoding: (nextEncoding) => {
      encoding = nextEncoding;
      return stream;
    },
    read,
    on,
    addListener: on,
    removeListener,
    off: removeListener,
    once: (event, listener) => {
      const wrapped = (chunk) => {
        removeListener(event, wrapped);
        listener(chunk);
      };
      return stream.on(event, wrapped);
    },
    destroy: () => {
      destroyed = true;
      return stream;
    },
    get destroyed() {
      return destroyed;
    },
    resume: () => {
      readableFlowing = true;
      scheduleFlow();
      return stream;
    },
    pause: () => {
      readableFlowing = false;
      return stream;
    },
    [Symbol.asyncIterator]: async function* () {
      const chunk = read();
      if (chunk !== null) yield chunk;
    }
  };
  return stream;
}

// packages/runtime-javascript/src/node-compat/assert.ts
var BrowserAssertionError = class extends Error {
  code = "ERR_ASSERTION";
  actual;
  expected;
  operator;
  generatedMessage;
  constructor(options = {}) {
    const operator = options.operator ?? "fail";
    const generatedMessage = options.message === void 0;
    super(options.message ?? `Assertion failed: ${operator}`);
    this.name = "AssertionError";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = operator;
    this.generatedMessage = generatedMessage;
  }
};
function browserDeepStrictEqual(left, right, seen = /* @__PURE__ */ new WeakMap()) {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const seenRight = seen.get(left);
  if (seenRight) return seenRight === right;
  seen.set(left, right);
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime());
  }
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false;
    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return byteEqual(leftBytes, rightBytes);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => browserDeepStrictEqual(value, right[index], seen));
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
    for (const [key, value] of left.entries()) {
      if (!right.has(key) || !browserDeepStrictEqual(value, right.get(key), seen)) return false;
    }
    return true;
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false;
    return [...left].every((value) => right.has(value));
  }
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.propertyIsEnumerable.call(right, key) && browserDeepStrictEqual(left[key], right[key], seen));
}
function createAssertApi() {
  const fail = (message) => {
    throw new BrowserAssertionError({ message, operator: "fail" });
  };
  const assert = ((value, message) => {
    if (!value) throw new BrowserAssertionError({ actual: value, expected: true, message, operator: "==" });
  });
  const strictEqual = (actual, expected, message) => {
    if (!Object.is(actual, expected)) throw new BrowserAssertionError({ actual, expected, message, operator: "strictEqual" });
  };
  const notStrictEqual = (actual, expected, message) => {
    if (Object.is(actual, expected)) throw new BrowserAssertionError({ actual, expected, message, operator: "notStrictEqual" });
  };
  const deepStrictEqual = (actual, expected, message) => {
    if (!browserDeepStrictEqual(actual, expected)) throw new BrowserAssertionError({ actual, expected, message, operator: "deepStrictEqual" });
  };
  const notDeepStrictEqual = (actual, expected, message) => {
    if (browserDeepStrictEqual(actual, expected)) throw new BrowserAssertionError({ actual, expected, message, operator: "notDeepStrictEqual" });
  };
  const match = (actual, expected, message) => {
    if (!(expected instanceof RegExp)) throw new TypeError('The "regexp" argument must be an instance of RegExp');
    if (!expected.test(String(actual))) throw new BrowserAssertionError({ actual, expected, message, operator: "match" });
  };
  const doesNotMatch = (actual, expected, message) => {
    if (!(expected instanceof RegExp)) throw new TypeError('The "regexp" argument must be an instance of RegExp');
    if (expected.test(String(actual))) throw new BrowserAssertionError({ actual, expected, message, operator: "doesNotMatch" });
  };
  const throws = (fn, expected, message) => {
    try {
      fn();
    } catch (error) {
      if (expected instanceof RegExp && !expected.test(error instanceof Error ? error.message : String(error))) {
        throw new BrowserAssertionError({ actual: error, expected, message, operator: "throws" });
      }
      if (typeof expected === "function" && !expected(error)) {
        throw new BrowserAssertionError({ actual: error, expected, message, operator: "throws" });
      }
      return error;
    }
    throw new BrowserAssertionError({ actual: void 0, expected, message, operator: "throws" });
  };
  const rejects = async (fn, expected, message) => {
    try {
      await (typeof fn === "function" ? fn() : fn);
    } catch (error) {
      if (expected instanceof RegExp && !expected.test(error instanceof Error ? error.message : String(error))) {
        throw new BrowserAssertionError({ actual: error, expected, message, operator: "rejects" });
      }
      if (typeof expected === "function" && !expected(error)) {
        throw new BrowserAssertionError({ actual: error, expected, message, operator: "rejects" });
      }
      return error;
    }
    throw new BrowserAssertionError({ actual: void 0, expected, message, operator: "rejects" });
  };
  Object.assign(assert, {
    AssertionError: BrowserAssertionError,
    fail,
    ok: assert,
    equal: strictEqual,
    notEqual: notStrictEqual,
    strictEqual,
    notStrictEqual,
    deepEqual: deepStrictEqual,
    notDeepEqual: notDeepStrictEqual,
    deepStrictEqual,
    notDeepStrictEqual,
    match,
    doesNotMatch,
    throws,
    rejects
  });
  return assert;
}

// packages/runtime-javascript/src/node-compat/events-util.ts
var BrowserEventEmitter = class {
  listeners = /* @__PURE__ */ new Map();
  on(eventName, listener) {
    const entries = this.listeners.get(eventName) ?? [];
    entries.push(listener);
    this.listeners.set(eventName, entries);
    return this;
  }
  addListener(eventName, listener) {
    return this.on(eventName, listener);
  }
  once(eventName, listener) {
    const wrapped = (...args) => {
      this.off(eventName, wrapped);
      listener(...args);
    };
    return this.on(eventName, wrapped);
  }
  off(eventName, listener) {
    const entries = this.listeners.get(eventName);
    if (!entries) return this;
    const index = entries.indexOf(listener);
    if (index !== -1) entries.splice(index, 1);
    if (entries.length === 0) this.listeners.delete(eventName);
    return this;
  }
  removeListener(eventName, listener) {
    return this.off(eventName, listener);
  }
  emit(eventName, ...args) {
    const entries = [...this.listeners.get(eventName) ?? []];
    if (entries.length === 0) {
      if (eventName === "error") throw args[0] instanceof Error ? args[0] : new Error(String(args[0] ?? "Unhandled error"));
      return false;
    }
    for (const listener of entries) listener(...args);
    return true;
  }
  listenerCount(eventName) {
    return this.listeners.get(eventName)?.length ?? 0;
  }
  removeAllListeners(eventName) {
    if (eventName === void 0) this.listeners.clear();
    else this.listeners.delete(eventName);
    return this;
  }
};
function createEventsApi() {
  return {
    EventEmitter: BrowserEventEmitter,
    once: (emitter, eventName) => new Promise((resolve, reject) => {
      emitter.once(eventName, (...args) => resolve(args));
      if (eventName !== "error") emitter.once("error", reject);
    })
  };
}
function createUtilApi() {
  const inspect = (value) => {
    if (typeof value === "string") return `'${value}'`;
    if (value instanceof Error) return value.stack ?? value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const promisify = (fn) => (...args) => new Promise((resolve, reject) => {
    fn(...args, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  const callbackify = (fn) => (...args) => {
    const callback = args.pop();
    if (typeof callback !== "function") throw new TypeError("Callback must be a function");
    fn(...args).then((value) => callback(null, value), (error) => callback(error));
  };
  return {
    inspect,
    format: (...args) => args.map((arg) => typeof arg === "string" ? arg : inspect(arg)).join(" "),
    promisify,
    callbackify,
    TextEncoder,
    TextDecoder,
    types: {
      isDate: (value) => value instanceof Date,
      isMap: (value) => value instanceof Map,
      isSet: (value) => value instanceof Set,
      isRegExp: (value) => value instanceof RegExp,
      isUint8Array: (value) => value instanceof Uint8Array
    }
  };
}

// packages/runtime-javascript/src/node-compat/network/shared.ts
function createListenerMap() {
  const listeners = /* @__PURE__ */ new Map();
  const on = (event, listener) => {
    const next = listeners.get(event) ?? [];
    next.push(listener);
    listeners.set(event, next);
    return api;
  };
  const removeListener = (event, listener) => {
    const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener);
    if (next.length === 0) listeners.delete(event);
    else listeners.set(event, next);
    return api;
  };
  const emit = (event, ...args) => {
    const current = listeners.get(event) ?? [];
    for (const listener of current) listener(...args);
    return current.length > 0;
  };
  const api = {
    on,
    addListener: on,
    removeListener,
    off: removeListener,
    once: (event, listener) => {
      const wrapped = (...args) => {
        removeListener(event, wrapped);
        listener(...args);
      };
      return on(event, wrapped);
    },
    emit
  };
  return api;
}
function createIncomingMessage(request) {
  const events = createListenerMap();
  let encoding;
  let bodyRead = false;
  let bodyScheduled = false;
  let readableEnded = false;
  const bodyBytes = bytesFromRuntimeHttpBody(request);
  const rawHeaders = request.rawHeaders ? request.rawHeaders.flatMap(([name, value]) => [name, value]) : Object.entries(request.headers ?? {}).flatMap(([name, value]) => [name, value]);
  const formatBody = () => encoding ? BrowserBuffer.from(bodyBytes).toString(encoding) : BrowserBuffer.from(bodyBytes);
  const scheduleBody = () => {
    if (bodyScheduled) return;
    bodyScheduled = true;
    queueMicrotask(() => {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        events.emit("data", formatBody());
      }
      readableEnded = true;
      events.emit("end");
    });
  };
  const message = {
    method: request.method,
    url: request.path,
    headers: request.headers ?? {},
    rawHeaders,
    signal: request.signal,
    httpVersion: "1.1",
    complete: true,
    get readableEnded() {
      return readableEnded;
    },
    socket: { remoteAddress: "127.0.0.1" },
    setEncoding: (nextEncoding) => {
      encoding = nextEncoding;
      return message;
    },
    read: () => {
      if (bodyRead) return null;
      bodyRead = true;
      readableEnded = true;
      return formatBody();
    },
    on: (event, listener) => {
      events.on(event, listener);
      if (event === "data" || event === "end") scheduleBody();
      return message;
    },
    addListener: (event, listener) => message.on(event, listener),
    once: (event, listener) => {
      events.once(event, listener);
      if (event === "data" || event === "end") scheduleBody();
      return message;
    },
    removeListener: events.removeListener,
    off: events.removeListener,
    [Symbol.asyncIterator]: async function* () {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        readableEnded = true;
        yield formatBody();
      }
    }
  };
  return message;
}
function createServerResponse(resolve) {
  const events = createListenerMap();
  const headers = {};
  const headerEntries = /* @__PURE__ */ new Map();
  const chunks = [];
  let ended = false;
  const setHeaderValue = (name, value) => {
    const key = String(name).toLowerCase();
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    const text = values.join(", ");
    headers[key] = text;
    headerEntries.set(key, { name: String(name), values });
  };
  const responseRawHeaders = () => {
    const result = [];
    for (const entry of headerEntries.values()) {
      for (const value of entry.values) result.push([entry.name, value]);
    }
    return result;
  };
  const response = {
    statusCode: 200,
    statusMessage: "OK",
    headersSent: false,
    writableEnded: false,
    setHeader: (name, value) => {
      setHeaderValue(name, value);
      return response;
    },
    getHeader: (name) => headers[String(name).toLowerCase()],
    getHeaders: () => ({ ...headers }),
    hasHeader: (name) => Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()),
    removeHeader: (name) => {
      const key = String(name).toLowerCase();
      delete headers[key];
      headerEntries.delete(key);
    },
    flushHeaders: () => {
      response.headersSent = true;
    },
    writeHead: (statusCode, reasonOrHeaders, maybeHeaders) => {
      response.statusCode = Number(statusCode) || 200;
      response.headersSent = true;
      const nextHeaders = typeof reasonOrHeaders === "object" && reasonOrHeaders !== null ? reasonOrHeaders : maybeHeaders;
      for (const [name, value] of Object.entries(nextHeaders ?? {})) setHeaderValue(name, value);
      return response;
    },
    write: (chunk, encoding, callback) => {
      chunks.push(bytesFromFsWriteValue(chunk, typeof encoding === "string" ? encoding : void 0));
      const done = typeof encoding === "function" ? encoding : callback;
      done?.();
      return true;
    },
    end: (chunk, encoding, callback) => {
      if (ended) return response;
      if (chunk !== void 0 && chunk !== null) response.write(chunk, typeof encoding === "string" ? encoding : void 0);
      ended = true;
      response.writableEnded = true;
      const done = typeof encoding === "function" ? encoding : callback;
      done?.();
      events.emit("finish");
      events.emit("close");
      const bodyBytes = concatBytes(chunks);
      const rawHeaders = responseRawHeaders();
      resolve({
        status: response.statusCode,
        headers,
        ...rawHeaders.length > 0 ? { rawHeaders } : {},
        ...bytesToRuntimeHttpBody(bodyBytes)
      });
      return response;
    },
    on: events.on,
    addListener: events.addListener,
    once: events.once,
    removeListener: events.removeListener,
    off: events.off,
    emit: events.emit
  };
  return response;
}
var HTTP_STATUS_CODES = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  404: "Not Found",
  500: "Internal Server Error"
};
function createClientIncomingMessage(response) {
  const events = createListenerMap();
  let encoding;
  let bodyRead = false;
  let bodyScheduled = false;
  let readableEnded = false;
  const bodyBytes = bytesFromRuntimeHttpBody(response);
  const formatBody = () => encoding ? BrowserBuffer.from(bodyBytes).toString(encoding) : BrowserBuffer.from(bodyBytes);
  const scheduleBody = () => {
    if (bodyScheduled) return;
    bodyScheduled = true;
    queueMicrotask(() => {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        events.emit("data", formatBody());
      }
      readableEnded = true;
      events.emit("end");
    });
  };
  const message = {
    statusCode: response.status,
    statusMessage: HTTP_STATUS_CODES[response.status] ?? "",
    headers: response.headers ?? {},
    rawHeaders: response.rawHeaders ? response.rawHeaders.flatMap(([name, value]) => [name, value]) : Object.entries(response.headers ?? {}).flatMap(([name, value]) => [name, value]),
    httpVersion: "1.1",
    complete: true,
    get readableEnded() {
      return readableEnded;
    },
    setEncoding: (nextEncoding) => {
      encoding = nextEncoding;
      return message;
    },
    read: () => {
      if (bodyRead) return null;
      bodyRead = true;
      readableEnded = true;
      return formatBody();
    },
    on: (event, listener) => {
      events.on(event, listener);
      if (event === "data" || event === "end") scheduleBody();
      return message;
    },
    addListener: (event, listener) => message.on(event, listener),
    once: (event, listener) => {
      events.once(event, listener);
      if (event === "data" || event === "end") scheduleBody();
      return message;
    },
    removeListener: events.removeListener,
    off: events.removeListener,
    [Symbol.asyncIterator]: async function* () {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        readableEnded = true;
        yield formatBody();
      }
    }
  };
  return message;
}
function headersFromHttpOptions(headers) {
  const result = {};
  if (!headers || typeof headers !== "object") return result;
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      result[String(entry[0]).toLowerCase()] = String(entry[1]);
    }
    return result;
  }
  if (typeof headers.forEach === "function") {
    headers.forEach((value, name) => {
      result[String(name).toLowerCase()] = String(value);
    });
    return result;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) result[name.toLowerCase()] = value.map(String).join(", ");
    else if (value !== void 0) result[name.toLowerCase()] = String(value);
  }
  return result;
}
function bodyToHttpBody(body) {
  if (body === void 0 || body === null) return void 0;
  if (typeof body === "string") return { body };
  if (body instanceof URLSearchParams) return { body: body.toString() };
  if (body instanceof ArrayBuffer) return bytesToRuntimeHttpBody(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) return bytesToRuntimeHttpBody(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  return { body: String(body) };
}
function normalizeHttpClientRequest(args) {
  const callback = args.find((arg) => typeof arg === "function");
  const parts = args.filter((arg) => typeof arg !== "function");
  const first = parts[0];
  const second = parts[1];
  const urlInput = typeof first === "string" || first instanceof URL ? first : void 0;
  const options = urlInput !== void 0 ? second : first;
  const baseUrl = urlInput !== void 0 ? new URL(urlInput) : void 0;
  const optionHost = typeof options?.hostname === "string" ? options.hostname : typeof options?.host === "string" ? options.host : void 0;
  const protocol = String(options?.protocol ?? baseUrl?.protocol ?? "http:");
  const hostname = optionHost ?? baseUrl?.hostname ?? "localhost";
  const port = options?.port !== void 0 ? String(options.port) : baseUrl?.port;
  const path = String(options?.path ?? `${baseUrl?.pathname ?? "/"}${baseUrl?.search ?? ""}`);
  const url = new URL(`${protocol}//${hostname}${port ? `:${port}` : ""}${path.startsWith("/") ? path : `/${path}`}`);
  return {
    ...callback ? { callback } : {},
    headers: headersFromHttpOptions(options?.headers),
    method: String(options?.method ?? "GET").toUpperCase(),
    ...typeof options?.signal === "object" && options?.signal !== null ? { signal: options.signal } : {},
    ...options?.timeout !== void 0 && Number.isFinite(Number(options.timeout)) ? { timeoutMs: Math.max(0, Number(options.timeout)) } : {},
    url
  };
}
function runtimeKernelNetworkCause(response, url) {
  const code = response.error?.code || "ECONNREFUSED";
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const message = code === "EPROTONOSUPPORT" ? response.error?.message.replace(/^EPROTONOSUPPORT:\s*/, "") || `Protocol "${url.protocol.replace(/:$/, "")}" not supported` : code === "EAGAIN" || code === "ERATELIMIT" ? "Resource temporarily unavailable" : `connect ${code} ${url.hostname}:${port}`;
  return Object.assign(new Error(message), {
    code,
    ...code.startsWith("EHOST") || code === "ECONNREFUSED" ? { address: url.hostname, port: Number(port) } : {}
  });
}
function runtimeKernelFetchError(response, url) {
  const cause = runtimeKernelNetworkCause(response, url);
  return Object.assign(new TypeError("fetch failed"), { cause });
}
async function dispatchBrowserNetworkSyscall(kernelNetwork, request) {
  if (!kernelNetwork) {
    throw Object.assign(
      new Error("ENOSYS: network subsystem is unavailable"),
      { code: "ENOSYS" }
    );
  }
  const result = await kernelNetwork.dispatch(request);
  if (result.ok === false) {
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code
    });
  }
  return result.value;
}

// packages/runtime-javascript/src/node-compat/network/net.ts
function normalizeNetConnectArgs(args) {
  const callback = args.find((value) => typeof value === "function");
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    const options = first;
    return {
      port: Number(options.port),
      host: typeof options.host === "string" ? options.host : "127.0.0.1",
      ...callback ? { callback } : {}
    };
  }
  return {
    port: Number(first),
    host: typeof args[1] === "string" ? args[1] : "127.0.0.1",
    ...callback ? { callback } : {}
  };
}
function createNetApi(kernelNetwork, signal) {
  const activeSockets = /* @__PURE__ */ new Set();
  const activeServers = /* @__PURE__ */ new Set();
  const closeWaiters = [];
  let activeWorkError = null;
  const notifyCloseWaiters = () => {
    if (activeSockets.size > 0 || activeServers.size > 0) return;
    while (closeWaiters.length > 0) {
      const waiter = closeWaiters.shift();
      if (!waiter) continue;
      if (activeWorkError) waiter.reject(activeWorkError);
      else waiter.resolve();
    }
  };
  function createSocket(existingFd) {
    const events = createListenerMap();
    let fd2 = existingFd;
    let destroyed = false;
    let connected = false;
    let readableEnded = false;
    let writableEnded = false;
    let paused = false;
    let resumeReader;
    let encoding;
    let localAddress;
    let remoteAddress;
    let writeTail = Promise.resolve();
    let onFinalClose;
    const removeActive = () => {
      if (!activeSockets.delete(socket)) return;
      onFinalClose?.();
      notifyCloseWaiters();
    };
    const closeDescriptor = async () => {
      const closingFd = fd2;
      fd2 = void 0;
      if (closingFd === void 0) return;
      try {
        await dispatchBrowserNetworkSyscall(kernelNetwork, {
          op: "close",
          fd: closingFd
        });
      } catch (error) {
        if (error?.code !== "EBADF") throw error;
      }
    };
    const fail = (error) => {
      const cause = error instanceof Error ? error : new Error(String(error));
      try {
        if (!events.emit("error", cause)) activeWorkError ??= cause;
      } catch (listenerError) {
        activeWorkError ??= listenerError instanceof Error ? listenerError : new Error(String(listenerError));
      }
    };
    const finishClose = async (error) => {
      if (destroyed) return;
      destroyed = true;
      resumeReader?.();
      resumeReader = void 0;
      try {
        await closeDescriptor();
      } catch (closeError) {
        error ??= closeError;
      }
      if (error) fail(error);
      events.emit("close", Boolean(error));
      removeActive();
    };
    const receive = async () => {
      while (!destroyed && fd2 !== void 0) {
        try {
          if (paused) {
            await new Promise((resolve) => {
              resumeReader = resolve;
            });
            resumeReader = void 0;
            if (destroyed) return;
          }
          const result = await dispatchBrowserNetworkSyscall(kernelNetwork, {
            op: "recv",
            fd: fd2,
            maxBytes: 64 * 1024
          });
          if (result.bytes.byteLength === 0) {
            readableEnded = true;
            events.emit("end");
            await writeTail;
            if (!writableEnded && fd2 !== void 0) {
              writableEnded = true;
              await dispatchBrowserNetworkSyscall(kernelNetwork, {
                op: "shutdown",
                fd: fd2,
                how: "write"
              });
            }
            await finishClose();
            return;
          }
          const chunk = BrowserBuffer.from(result.bytes);
          events.emit(
            "data",
            encoding ? chunk.toString(encoding) : chunk
          );
        } catch (error) {
          if (!destroyed) await finishClose(error);
          return;
        }
      }
    };
    const attach = (nextFd, nextLocalAddress, nextRemoteAddress, emitConnect) => {
      fd2 = nextFd;
      localAddress = nextLocalAddress;
      remoteAddress = nextRemoteAddress;
      connected = true;
      activeSockets.add(socket);
      if (emitConnect) events.emit("connect");
      void receive();
    };
    const socket = {
      connecting: false,
      get destroyed() {
        return destroyed;
      },
      get readableEnded() {
        return readableEnded;
      },
      get writableEnded() {
        return writableEnded;
      },
      get remoteAddress() {
        return remoteAddress?.host;
      },
      get remotePort() {
        return remoteAddress?.port;
      },
      get remoteFamily() {
        return remoteAddress ? "IPv4" : void 0;
      },
      address: () => localAddress ? { address: localAddress.host, port: localAddress.port, family: "IPv4" } : {},
      connect: (...args) => {
        const options = normalizeNetConnectArgs(args);
        if (options.callback) events.once("connect", options.callback);
        socket.connecting = true;
        activeSockets.add(socket);
        void (async () => {
          try {
            const created = await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: "socket"
            });
            fd2 = created.fd;
            const connection = await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: "connect",
              fd: fd2,
              address: { host: options.host, port: options.port }
            });
            socket.connecting = false;
            attach(
              fd2,
              connection.localAddress,
              connection.remoteAddress,
              true
            );
          } catch (error) {
            socket.connecting = false;
            await finishClose(error);
          }
        })();
        return socket;
      },
      write: (chunk, encodingOrCallback, callback) => {
        const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : typeof callback === "function" ? callback : void 0;
        const bytes = typeof chunk === "string" ? BrowserBuffer.from(
          chunk,
          typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8"
        ) : BrowserBuffer.from(bytesFromNodeValue(chunk));
        writeTail = writeTail.then(async () => {
          if (destroyed || fd2 === void 0 || !connected) {
            throw Object.assign(new Error("ENOTCONN: socket is not connected"), {
              code: "ENOTCONN"
            });
          }
          await dispatchBrowserNetworkSyscall(kernelNetwork, {
            op: "send",
            fd: fd2,
            bytes
          });
        });
        void writeTail.then(
          () => writeCallback?.(),
          (error) => {
            writeCallback?.(error instanceof Error ? error : new Error(String(error)));
            void finishClose(error);
          }
        );
        return true;
      },
      end: (chunk, encodingOrCallback, callback) => {
        const endCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : typeof callback === "function" ? callback : void 0;
        if (chunk !== void 0) socket.write(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : void 0);
        writeTail = writeTail.then(async () => {
          if (fd2 !== void 0 && !writableEnded) {
            writableEnded = true;
            await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: "shutdown",
              fd: fd2,
              how: "write"
            });
          }
          events.emit("finish");
          endCallback?.();
          if (readableEnded) await finishClose();
        });
        void writeTail.catch((error) => finishClose(error));
        return socket;
      },
      destroy: (error) => {
        void finishClose(error);
        return socket;
      },
      setEncoding: (nextEncoding) => {
        encoding = nextEncoding;
        return socket;
      },
      setNoDelay: () => socket,
      setKeepAlive: () => socket,
      pause: () => {
        paused = true;
        return socket;
      },
      resume: () => {
        paused = false;
        resumeReader?.();
        resumeReader = void 0;
        return socket;
      },
      on: events.on,
      addListener: events.addListener,
      once: events.once,
      removeListener: events.removeListener,
      off: events.off,
      emit: events.emit,
      _attach: attach,
      _setOnFinalClose: (listener) => {
        onFinalClose = listener;
      }
    };
    return socket;
  }
  function createServer(connectionListener) {
    const events = createListenerMap();
    const connections = /* @__PURE__ */ new Set();
    let fd2;
    let listening = false;
    let closing = false;
    let boundAddress;
    const maybeFinishClose = () => {
      if (!closing || connections.size > 0 || fd2 !== void 0) return;
      activeServers.delete(server);
      events.emit("close");
      notifyCloseWaiters();
    };
    const recordServerError = (error) => {
      const cause = error instanceof Error ? error : new Error(String(error));
      try {
        if (!events.emit("error", cause)) activeWorkError ??= cause;
      } catch (listenerError) {
        activeWorkError ??= listenerError instanceof Error ? listenerError : new Error(String(listenerError));
      }
    };
    const acceptLoop = async () => {
      while (listening && fd2 !== void 0) {
        try {
          const accepted = await dispatchBrowserNetworkSyscall(kernelNetwork, {
            op: "accept",
            fd: fd2
          });
          if (!listening) {
            await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: "close",
              fd: accepted.fd
            });
            continue;
          }
          const socket = createSocket(accepted.fd);
          connections.add(socket);
          socket._setOnFinalClose(() => {
            connections.delete(socket);
            maybeFinishClose();
          });
          socket._attach(
            accepted.fd,
            accepted.localAddress,
            accepted.remoteAddress,
            false
          );
          events.emit("connection", socket);
        } catch (error) {
          if (listening) {
            recordServerError(error);
            closing = true;
            listening = false;
            const closingFd = fd2;
            fd2 = void 0;
            if (closingFd !== void 0) {
              await dispatchBrowserNetworkSyscall(kernelNetwork, {
                op: "close",
                fd: closingFd
              }).catch(() => void 0);
            }
          }
          break;
        }
      }
      maybeFinishClose();
    };
    const server = {
      get listening() {
        return listening;
      },
      listen: (...args) => {
        const callback = args.find((value) => typeof value === "function");
        const first = args[0];
        const options = typeof first === "object" && first !== null ? first : {
          port: first,
          host: typeof args[1] === "string" ? args[1] : void 0,
          backlog: void 0
        };
        activeServers.add(server);
        void (async () => {
          try {
            const created = await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: "socket"
            });
            fd2 = created.fd;
            boundAddress = await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: "bind",
              fd: fd2,
              address: {
                host: typeof options.host === "string" ? options.host : "127.0.0.1",
                port: Number(options.port)
              }
            }).then((result) => result.address);
            await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: "listen",
              fd: fd2,
              options: {
                ...Number.isFinite(Number(options.backlog)) ? { backlog: Number(options.backlog) } : {}
              }
            });
            listening = true;
            events.emit("listening");
            callback?.();
            void acceptLoop();
          } catch (error) {
            recordServerError(error);
            closing = true;
            if (fd2 !== void 0) {
              const closingFd = fd2;
              fd2 = void 0;
              await dispatchBrowserNetworkSyscall(kernelNetwork, {
                op: "close",
                fd: closingFd
              }).catch(() => void 0);
            }
            maybeFinishClose();
          }
        })();
        return server;
      },
      close: (callback) => {
        if (callback) events.once("close", callback);
        closing = true;
        listening = false;
        const closingFd = fd2;
        fd2 = void 0;
        if (closingFd !== void 0) {
          void dispatchBrowserNetworkSyscall(kernelNetwork, {
            op: "close",
            fd: closingFd
          }).then(maybeFinishClose, (error) => {
            recordServerError(error);
            maybeFinishClose();
          });
        } else {
          queueMicrotask(maybeFinishClose);
        }
        return server;
      },
      address: () => boundAddress ? { address: boundAddress.host, port: boundAddress.port, family: "IPv4" } : null,
      getConnections: (callback) => {
        queueMicrotask(() => callback(null, connections.size));
      },
      on: events.on,
      addListener: events.addListener,
      once: events.once,
      removeListener: events.removeListener,
      off: events.off,
      emit: events.emit
    };
    if (connectionListener) server.on("connection", connectionListener);
    return server;
  }
  const closeAll = () => {
    for (const server of [...activeServers]) server.close();
    for (const socket of [...activeSockets]) socket.destroy();
  };
  signal?.addEventListener("abort", closeAll, { once: true });
  const connect = (...args) => createSocket().connect(...args);
  const Socket = function Socket2() {
    return createSocket();
  };
  const Server = function Server2(connectionListener) {
    return createServer(connectionListener);
  };
  return {
    module: {
      createServer,
      connect,
      createConnection: connect,
      Socket,
      Server,
      isIP: (input) => input === "127.0.0.1" || input === "0.0.0.0" ? 4 : 0,
      isIPv4: (input) => input === "127.0.0.1" || input === "0.0.0.0",
      isIPv6: () => false
    },
    hasActiveWork: () => activeSockets.size > 0 || activeServers.size > 0 || activeWorkError !== null,
    waitForClose: () => activeSockets.size === 0 && activeServers.size === 0 ? activeWorkError ? Promise.reject(activeWorkError) : Promise.resolve() : new Promise((resolve, reject) => closeWaiters.push({ resolve, reject })),
    closeAll
  };
}

// packages/runtime-javascript/src/node-compat/network/http.ts
function createHttpApi(kernelHttp, signal) {
  const activeHandles = /* @__PURE__ */ new Set();
  const activeClientAborters = /* @__PURE__ */ new Set();
  let activeClientRequests = 0;
  let activeWorkError = null;
  const closeWaiters = [];
  const notifyCloseWaiters = () => {
    if (activeHandles.size > 0 || activeClientRequests > 0) return;
    while (closeWaiters.length > 0) {
      const waiter = closeWaiters.shift();
      if (!waiter) continue;
      if (activeWorkError) waiter.reject(activeWorkError);
      else waiter.resolve();
    }
  };
  const closeHandle = (handle) => {
    if (!activeHandles.delete(handle)) return;
    handle.close();
    notifyCloseWaiters();
  };
  const closeAll = () => {
    for (const handle of [...activeHandles]) closeHandle(handle);
    for (const abortClient of [...activeClientAborters]) abortClient();
  };
  signal?.addEventListener("abort", closeAll, { once: true });
  const createServer = (requestListener) => {
    const events = createListenerMap();
    let handle = null;
    const server = {
      listening: false,
      listen: (...args) => {
        if (!kernelHttp) throw Object.assign(new Error("ENOSYS: network subsystem is unavailable"), { code: "ENOSYS" });
        const port = typeof args[0] === "number" || typeof args[0] === "string" ? Number(args[0]) : 80;
        const host = typeof args[1] === "string" ? args[1] : void 0;
        const callback = args.find((arg) => typeof arg === "function");
        const listenerHandle = kernelHttp.listen({ port, ...host ? { host } : {} }, async (request2) => {
          const incoming = createIncomingMessage(request2);
          const responsePromise = new Promise((resolve) => {
            const response = createServerResponse(resolve);
            let handled = false;
            try {
              handled = events.emit("request", incoming, response);
            } catch (error) {
              if (!response.writableEnded) {
                response.statusCode = 500;
                response.end(error instanceof Error ? error.message : String(error));
              }
              return;
            }
            if (!handled && !response.writableEnded) {
              response.statusCode = 404;
              response.end("");
            }
          });
          return responsePromise;
        });
        handle = listenerHandle;
        activeHandles.add(listenerHandle);
        const markListening = () => {
          if (handle !== listenerHandle) return;
          server.listening = true;
          events.emit("listening");
          callback?.();
        };
        if (listenerHandle.ready) {
          void listenerHandle.ready.then(markListening, (cause) => {
            if (handle !== listenerHandle) return;
            server.listening = false;
            const error = cause instanceof Error ? cause : new Error(String(cause));
            try {
              if (!events.emit("error", error)) activeWorkError ??= error;
            } catch (unhandledError) {
              activeWorkError ??= unhandledError instanceof Error ? unhandledError : new Error(String(unhandledError));
            }
            closeHandle(listenerHandle);
            if (handle === listenerHandle) handle = null;
          });
        } else {
          markListening();
        }
        return server;
      },
      close: (callback) => {
        if (handle) closeHandle(handle);
        handle = null;
        server.listening = false;
        events.emit("close");
        callback?.();
        return server;
      },
      address: () => handle ? { address: handle.info.host, port: handle.info.port, family: "IPv4" } : null,
      on: events.on,
      addListener: events.addListener,
      once: events.once,
      removeListener: events.removeListener,
      off: events.off,
      emit: events.emit
    };
    if (requestListener) server.on("request", requestListener);
    return server;
  };
  const request = (...args) => {
    const events = createListenerMap();
    const chunks = [];
    const headers = {};
    let ended = false;
    let destroyed = false;
    let timeoutMs;
    let timeoutCallback;
    let activeAbortClientRequest;
    let requestOptions;
    try {
      requestOptions = normalizeHttpClientRequest(args);
      Object.assign(headers, requestOptions.headers);
      timeoutMs = requestOptions.timeoutMs;
    } catch (error) {
      requestOptions = {
        headers,
        method: "GET",
        url: new URL("http://localhost/")
      };
      queueMicrotask(() => events.emit("error", error));
    }
    const clientRequest = {
      destroyed: false,
      writableEnded: false,
      setTimeout: (milliseconds, callback) => {
        timeoutMs = Math.max(0, Number(milliseconds) || 0);
        timeoutCallback = callback;
        if (callback) events.once("timeout", callback);
        return clientRequest;
      },
      setHeader: (name, value) => {
        headers[String(name).toLowerCase()] = String(value);
        return clientRequest;
      },
      getHeader: (name) => headers[String(name).toLowerCase()],
      getHeaders: () => ({ ...headers }),
      hasHeader: (name) => Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()),
      removeHeader: (name) => {
        delete headers[String(name).toLowerCase()];
      },
      write: (chunk, encoding, callback) => {
        if (destroyed) return false;
        chunks.push(bytesFromFsWriteValue(chunk, typeof encoding === "string" ? encoding : void 0));
        const done = typeof encoding === "function" ? encoding : callback;
        done?.();
        return true;
      },
      end: (chunk, encoding, callback) => {
        if (ended || destroyed) return clientRequest;
        if (chunk !== void 0 && chunk !== null) clientRequest.write(chunk, typeof encoding === "string" ? encoding : void 0);
        ended = true;
        clientRequest.writableEnded = true;
        const done = typeof encoding === "function" ? encoding : callback;
        done?.();
        if (!kernelHttp) {
          activeClientRequests += 1;
          queueMicrotask(() => {
            events.emit("error", Object.assign(new Error("ENOSYS: network subsystem is unavailable"), { code: "ENOSYS" }));
            activeClientRequests -= 1;
            notifyCloseWaiters();
          });
          return clientRequest;
        }
        const body = bytesToRuntimeHttpBody(concatBytes(chunks));
        const rawHeaders = Object.entries(headers);
        activeClientRequests += 1;
        let active = true;
        let timeoutHandle;
        let requestAbortListener;
        const dispatchAbortController = new AbortController();
        const finishClientRequest = () => {
          if (!active) return;
          active = false;
          activeAbortClientRequest = void 0;
          if (timeoutHandle !== void 0) globalThis.clearTimeout(timeoutHandle);
          if (requestAbortListener) requestOptions.signal?.removeEventListener?.("abort", requestAbortListener);
          activeClientAborters.delete(abortClientRequest);
          queueMicrotask(() => {
            queueMicrotask(() => {
              activeClientRequests -= 1;
              notifyCloseWaiters();
            });
          });
        };
        const abortClientRequest = (error) => {
          if (destroyed) return;
          destroyed = true;
          clientRequest.destroyed = true;
          if (!dispatchAbortController.signal.aborted) dispatchAbortController.abort();
          if (error) events.emit("error", error);
          events.emit("close");
          finishClientRequest();
        };
        activeAbortClientRequest = abortClientRequest;
        activeClientAborters.add(abortClientRequest);
        if (requestOptions.signal) {
          requestAbortListener = () => abortClientRequest(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
          requestOptions.signal.addEventListener?.("abort", requestAbortListener, { once: true });
          if (requestOptions.signal.aborted) requestAbortListener();
        }
        if (!destroyed && timeoutMs !== void 0) {
          timeoutHandle = globalThis.setTimeout(() => {
            events.emit("timeout");
            abortClientRequest(Object.assign(new Error(`ETIMEDOUT: request timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
          }, timeoutMs);
        }
        void kernelHttp.dispatch({
          method: requestOptions.method,
          url: requestOptions.url.toString(),
          path: `${requestOptions.url.pathname}${requestOptions.url.search}`,
          headers,
          ...rawHeaders.length > 0 ? { rawHeaders } : {},
          ...chunks.length > 0 ? body : {}
        }, {
          signal: dispatchAbortController.signal
        }).then((response) => {
          if (destroyed) return;
          if (response.status === 0) {
            events.emit("error", runtimeKernelNetworkCause(response, requestOptions.url));
            finishClientRequest();
            return;
          }
          const incoming = createClientIncomingMessage(response);
          requestOptions.callback?.(incoming);
          events.emit("response", incoming);
          finishClientRequest();
        }, (error) => {
          if (!destroyed) events.emit("error", error);
          finishClientRequest();
        });
        return clientRequest;
      },
      abort: () => {
        clientRequest.destroy();
        events.emit("abort");
      },
      destroy: (error) => {
        if (activeAbortClientRequest) {
          activeAbortClientRequest(error);
          return clientRequest;
        }
        if (destroyed) return clientRequest;
        destroyed = true;
        clientRequest.destroyed = true;
        if (error) events.emit("error", error);
        events.emit("close");
        return clientRequest;
      },
      on: events.on,
      addListener: events.addListener,
      once: events.once,
      removeListener: events.removeListener,
      off: events.off,
      emit: events.emit
    };
    return clientRequest;
  };
  const get = (...args) => {
    const clientRequest = request(...args);
    clientRequest.end();
    return clientRequest;
  };
  const httpsRequest = (...args) => {
    const first = args[0];
    if (typeof first === "string" || first instanceof URL) return request(...args);
    const options = first && typeof first === "object" ? { ...first, protocol: first.protocol ?? "https:" } : { protocol: "https:" };
    return request(options, ...args.slice(1));
  };
  const httpsGet = (...args) => {
    const clientRequest = httpsRequest(...args);
    clientRequest.end();
    return clientRequest;
  };
  class TraceKernelHeaders {
    headerValues = /* @__PURE__ */ new Map();
    constructor(init) {
      const record = headersFromHttpOptions(init);
      for (const [name, value] of Object.entries(record)) this.set(name, value);
    }
    append(name, value) {
      const key = String(name).toLowerCase();
      const current = this.headerValues.get(key);
      this.headerValues.set(key, current === void 0 ? String(value) : `${current}, ${String(value)}`);
    }
    delete(name) {
      this.headerValues.delete(String(name).toLowerCase());
    }
    entries() {
      return this.headerValues.entries();
    }
    forEach(callback) {
      for (const [name, value] of this.headerValues) callback(value, name, this);
    }
    get(name) {
      return this.headerValues.get(String(name).toLowerCase()) ?? null;
    }
    has(name) {
      return this.headerValues.has(String(name).toLowerCase());
    }
    keys() {
      return this.headerValues.keys();
    }
    set(name, value) {
      this.headerValues.set(String(name).toLowerCase(), String(value));
    }
    values() {
      return this.headerValues.values();
    }
    toRecord() {
      return Object.fromEntries(this.headerValues);
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  }
  class TraceKernelRequest {
    headers;
    method;
    signal;
    url;
    bodyPayload;
    constructor(input, init) {
      const sourceRequest = input instanceof TraceKernelRequest ? input : null;
      const source = input;
      const inputUrl = typeof input === "string" || input instanceof URL ? String(input) : String(sourceRequest?.url ?? source.url ?? "");
      this.url = inputUrl;
      this.method = String(init?.method ?? sourceRequest?.method ?? source.method ?? "GET").toUpperCase();
      this.headers = new TraceKernelHeaders(sourceRequest?.headers ?? source.headers);
      const initHeaders = new TraceKernelHeaders(init?.headers);
      initHeaders.forEach((value, name) => this.headers.set(name, value));
      this.bodyPayload = init && Object.prototype.hasOwnProperty.call(init, "body") ? bodyToHttpBody(init.body) : sourceRequest?.bodyForDispatch() ?? (source.bodyEncoding === "base64" ? { body: String(source.body ?? ""), bodyEncoding: "base64" } : bodyToHttpBody(source.body));
      const initSignal = init?.signal;
      this.signal = initSignal && typeof initSignal === "object" ? initSignal : sourceRequest?.signal ?? source.signal;
    }
    async text() {
      return textFromBytes(bytesFromRuntimeHttpBody(this.bodyPayload ?? {}));
    }
    bodyForDispatch() {
      return this.bodyPayload;
    }
  }
  class TraceKernelResponse {
    headers;
    ok;
    redirected = false;
    status;
    statusText;
    type = "basic";
    url;
    bodyBytes;
    used = false;
    constructor(bodyOrResponse = "", initOrUrl) {
      const kernelResponse = typeof initOrUrl === "string" && bodyOrResponse !== null && typeof bodyOrResponse === "object" && "status" in bodyOrResponse ? bodyOrResponse : null;
      const init = !kernelResponse && initOrUrl && typeof initOrUrl === "object" ? initOrUrl : {};
      const status = kernelResponse ? kernelResponse.status : Math.trunc(Number(init.status ?? 200)) || 200;
      this.status = status;
      this.statusText = HTTP_STATUS_CODES[status] ?? "";
      this.ok = status >= 200 && status < 300;
      this.headers = new TraceKernelHeaders(kernelResponse ? kernelResponse.headers : init.headers);
      this.bodyBytes = kernelResponse ? bytesFromRuntimeHttpBody(kernelResponse) : bytesFromRuntimeHttpBody(bodyToHttpBody(bodyOrResponse) ?? {});
      this.url = typeof initOrUrl === "string" ? initOrUrl : "";
    }
    get bodyUsed() {
      return this.used;
    }
    consume() {
      if (this.used) throw new TypeError("Body has already been consumed.");
      this.used = true;
      return new Uint8Array(this.bodyBytes);
    }
    async arrayBuffer() {
      const bytes = this.consume();
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return buffer;
    }
    clone() {
      if (this.used) throw new TypeError("Body has already been consumed.");
      return new TraceKernelResponse({
        status: this.status,
        headers: this.headers.toRecord(),
        ...bytesToRuntimeHttpBody(this.bodyBytes)
      }, this.url);
    }
    async json() {
      return JSON.parse(textFromBytes(this.consume()));
    }
    async text() {
      return textFromBytes(this.consume());
    }
  }
  const fetch = async (input, init) => {
    if (!kernelHttp) throw Object.assign(new Error("ENOSYS: network subsystem is unavailable"), { code: "ENOSYS" });
    const request2 = new TraceKernelRequest(input, init);
    const url = new URL(request2.url);
    const body = request2.bodyForDispatch();
    const headers = request2.headers.toRecord();
    const rawHeaders = Object.entries(headers);
    activeClientRequests += 1;
    let active = true;
    let abortListener;
    let rejectFetch;
    const dispatchAbortController = new AbortController();
    const finishFetch = () => {
      if (!active) return;
      active = false;
      if (abortListener) request2.signal?.removeEventListener?.("abort", abortListener);
      activeClientAborters.delete(abortFetch);
      globalThis.setTimeout(() => {
        activeClientRequests -= 1;
        notifyCloseWaiters();
      }, 0);
    };
    const abortFetch = () => {
      if (!dispatchAbortController.signal.aborted) dispatchAbortController.abort();
      rejectFetch?.(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
      finishFetch();
    };
    activeClientAborters.add(abortFetch);
    return new Promise((resolve, reject) => {
      rejectFetch = reject;
      if (request2.signal) {
        abortListener = abortFetch;
        request2.signal.addEventListener?.("abort", abortListener, { once: true });
        if (request2.signal.aborted) {
          abortFetch();
          return;
        }
      }
      if (!active) return;
      void kernelHttp.dispatch({
        method: request2.method,
        url: url.toString(),
        path: `${url.pathname}${url.search}`,
        headers,
        ...rawHeaders.length > 0 ? { rawHeaders } : {},
        ...body !== void 0 ? body : {}
      }, {
        signal: dispatchAbortController.signal
      }).then((response) => {
        if (!active) return;
        if (response.status === 0) {
          reject(runtimeKernelFetchError(response, url));
          finishFetch();
          return;
        }
        resolve(new TraceKernelResponse(response, url.toString()));
        finishFetch();
      }, (error) => {
        if (!active) return;
        reject(error);
        finishFetch();
      });
    });
  };
  return {
    module: {
      createServer,
      request,
      get,
      Server: function Server(requestListener) {
        return createServer(requestListener);
      },
      STATUS_CODES: HTTP_STATUS_CODES
    },
    httpsModule: {
      request: httpsRequest,
      get: httpsGet,
      STATUS_CODES: HTTP_STATUS_CODES
    },
    fetch,
    Headers: TraceKernelHeaders,
    Request: TraceKernelRequest,
    Response: TraceKernelResponse,
    // A completed asynchronous operation with an unhandled failure is still
    // process work. Keep it visible until waitForClose reports the failure;
    // otherwise the quiescence loop can observe zero handles and incorrectly
    // return exit 0 before propagating an EADDRINUSE or client error.
    hasActiveWork: () => activeHandles.size > 0 || activeClientRequests > 0 || activeWorkError !== null,
    waitForClose: () => activeHandles.size === 0 && activeClientRequests === 0 ? activeWorkError ? Promise.reject(activeWorkError) : Promise.resolve() : new Promise((resolve, reject) => closeWaiters.push({ resolve, reject })),
    closeAll
  };
}

// packages/runtime-javascript/src/node-compat/child-process.ts
function createChildProcessApi(executionState, eventLoopApi, request) {
  const runtimeForCommand = (command) => {
    const name = command.split("/").at(-1)?.toLowerCase() ?? command.toLowerCase();
    if (name === "node" || name === "nodejs") return "javascript";
    if (name === "python" || name === "python3") return "python";
    if (name === "java") return "java";
    if (name === "dotnet") return "csharp";
    return "cpp";
  };
  const normalizeInvocation = (command, argsOrOptions, maybeOptions) => {
    if (typeof command !== "string" || command.length === 0) {
      throw Object.assign(
        new TypeError('The "file" argument must be of type string and non-empty'),
        { code: "ERR_INVALID_ARG_TYPE" }
      );
    }
    const args = Array.isArray(argsOrOptions) ? argsOrOptions.map((arg) => String(arg)) : [];
    const options = Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions;
    if (options?.stdio !== void 0 && !Array.isArray(options.stdio) && options.stdio !== "pipe" && options.stdio !== "inherit" && options.stdio !== "ignore") {
      throw Object.assign(
        new TypeError(
          'The "stdio" option must be "pipe", "inherit", "ignore", or an array'
        ),
        { code: "ERR_INVALID_ARG_VALUE" }
      );
    }
    return {
      command,
      args,
      options: options ?? {}
    };
  };
  const stdioPlan = (stdio, fallback) => {
    if (!Array.isArray(stdio)) {
      const mode = stdio ?? fallback;
      return {
        stdio: { stdin: mode, stdout: mode, stderr: mode },
        descriptorMappings: [],
        hasPipe: mode === "pipe"
      };
    }
    const modes = {};
    const descriptorMappings = [];
    let hasPipe = false;
    const length = Math.max(3, stdio.length);
    for (let childFd = 0; childFd < length; childFd += 1) {
      const entry = stdio[childFd] ?? (childFd < 3 ? "pipe" : "ignore");
      if (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0) {
        descriptorMappings.push({ parentFd: entry, childFd });
        continue;
      }
      if (entry !== "pipe" && entry !== "inherit" && entry !== "ignore") {
        throw Object.assign(
          new TypeError(`Unsupported stdio entry at index ${childFd}`),
          { code: entry === "ipc" ? "ENOSYS" : "ERR_INVALID_ARG_VALUE" }
        );
      }
      if (childFd < 3) {
        modes[childFd === 0 ? "stdin" : childFd === 1 ? "stdout" : "stderr"] = entry;
      } else if (entry === "inherit") {
        descriptorMappings.push({ parentFd: childFd, childFd });
      } else if (entry === "pipe") {
        throw Object.assign(
          new Error("ENOSYS: piped stdio descriptors above fd 2 are not implemented"),
          { code: "ENOSYS" }
        );
      }
      if (entry === "pipe") hasPipe = true;
    }
    return { stdio: modes, descriptorMappings, hasPipe };
  };
  const syncDispatch = (syscall) => {
    if (!executionState.kernelSyscalls) {
      throw Object.assign(
        new Error("ENOSYS: child-process subsystem is unavailable"),
        { code: "ENOSYS" }
      );
    }
    const result = executionState.kernelSyscalls.dispatchSync(syscall);
    if (result.ok === false) {
      throw Object.assign(new Error(result.error.message), {
        code: result.error.code
      });
    }
    return result.value;
  };
  const asyncDispatch = (syscall) => dispatchBrowserNetworkSyscall(
    executionState.kernelNetwork,
    syscall
  );
  class BrowserChildReadable extends BrowserEventEmitter {
    constructor(fd2) {
      super();
      this.fd = fd2;
      this.completion = eventLoopApi.track(this.pump());
      void this.completion.catch((error) => {
        if (!this.closed) this.emit("error", error);
      });
    }
    readable = true;
    encoding;
    closed = false;
    completion;
    setEncoding(encoding) {
      this.encoding = encoding;
      return this;
    }
    pipe(destination) {
      this.on("data", (chunk) => destination.write(chunk));
      this.on("end", () => destination.end?.());
      return destination;
    }
    pause() {
      return this;
    }
    resume() {
      return this;
    }
    destroy() {
      if (this.closed) return this;
      this.closed = true;
      void eventLoopApi.track(
        asyncDispatch({ op: "close", fd: this.fd }).catch(() => void 0)
      );
      return this;
    }
    async pump() {
      try {
        while (!this.closed) {
          const result = await asyncDispatch({
            op: "read",
            fd: this.fd,
            maxBytes: 16 * 1024
          });
          if (result.bytes.byteLength === 0) break;
          const chunk = BrowserBuffer.from(result.bytes);
          this.emit(
            "data",
            this.encoding ? chunk.toString(this.encoding) : chunk
          );
        }
        if (!this.closed) this.emit("end");
      } finally {
        if (!this.closed) {
          this.closed = true;
          await asyncDispatch({ op: "close", fd: this.fd }).catch(() => void 0);
          this.emit("close");
        }
      }
    }
  }
  class BrowserChildWritable extends BrowserEventEmitter {
    constructor(fd2) {
      super();
      this.fd = fd2;
    }
    writable = true;
    ended = false;
    closed = false;
    queuedBytes = 0;
    tail = Promise.resolve();
    write(chunk, encodingOrCallback, callback) {
      const completion = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (this.ended) {
        const error = Object.assign(new Error("write after end"), {
          code: "ERR_STREAM_WRITE_AFTER_END"
        });
        globalThis.queueMicrotask(() => {
          completion?.(error);
          this.emit("error", error);
        });
        return false;
      }
      const bytes = BrowserBuffer.isBuffer(chunk) ? Uint8Array.from(chunk) : typeof chunk === "string" ? BrowserBuffer.from(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : void 0) : Uint8Array.from(bytesFromNodeValue(chunk));
      this.queuedBytes += bytes.byteLength;
      const belowHighWaterMark = this.queuedBytes < 64 * 1024;
      this.tail = this.tail.then(async () => {
        try {
          await asyncDispatch({ op: "write", fd: this.fd, bytes });
          completion?.(null);
        } catch (error) {
          completion?.(error instanceof Error ? error : new Error(String(error)));
          this.emit("error", error);
        } finally {
          const wasBackpressured = this.queuedBytes >= 64 * 1024;
          this.queuedBytes = Math.max(0, this.queuedBytes - bytes.byteLength);
          if (wasBackpressured && this.queuedBytes < 64 * 1024) {
            this.emit("drain");
          }
        }
      });
      void eventLoopApi.track(this.tail.catch(() => void 0));
      return belowHighWaterMark;
    }
    end(chunkOrCallback, encodingOrCallback, callback) {
      const chunk = typeof chunkOrCallback === "function" ? void 0 : chunkOrCallback;
      const completion = typeof chunkOrCallback === "function" ? chunkOrCallback : typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (chunk !== void 0) {
        this.write(
          chunk,
          typeof encodingOrCallback === "string" ? encodingOrCallback : void 0
        );
      }
      if (this.ended) return this;
      this.ended = true;
      const closing = this.tail.then(async () => {
        if (!this.closed) {
          this.closed = true;
          await asyncDispatch({ op: "close", fd: this.fd }).catch(() => void 0);
        }
        this.emit("finish");
        this.emit("close");
        completion?.();
      });
      this.tail = closing;
      void eventLoopApi.track(closing);
      return this;
    }
    destroy() {
      if (this.closed) return this;
      this.ended = true;
      const closing = this.tail.finally(async () => {
        if (!this.closed) {
          this.closed = true;
          await asyncDispatch({ op: "close", fd: this.fd }).catch(() => void 0);
          this.emit("close");
        }
      });
      this.tail = closing;
      void eventLoopApi.track(closing);
      return this;
    }
  }
  class BrowserChildProcess extends BrowserEventEmitter {
    pid;
    stdin;
    stdout;
    stderr;
    stdio;
    connected = false;
    exitCode = null;
    signalCode = null;
    killed = false;
    refControl;
    constructor(pid, stdio, signal) {
      super();
      this.pid = pid;
      this.stdin = stdio?.stdinFd === void 0 ? null : new BrowserChildWritable(stdio.stdinFd);
      this.stdout = stdio?.stdoutFd === void 0 ? null : new BrowserChildReadable(stdio.stdoutFd);
      this.stderr = stdio?.stderrFd === void 0 ? null : new BrowserChildReadable(stdio.stderrFd);
      this.stdio = [this.stdin, this.stdout, this.stderr];
      if (signal) {
        const abort = () => this.kill("SIGTERM");
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
    }
    kill(signal = "SIGTERM") {
      if (this.exitCode !== null || this.signalCode !== null) return false;
      syncDispatch({
        op: "kill",
        pid: this.pid,
        signal
      });
      this.killed = true;
      return true;
    }
    ref() {
      this.refControl?.ref();
      return this;
    }
    unref() {
      this.refControl?.unref();
      return this;
    }
    attachRefControl(control) {
      this.refControl = control;
    }
  }
  const spawn = (command, argsOrOptions, maybeOptions) => {
    const invocation = normalizeInvocation(command, argsOrOptions, maybeOptions);
    const plan = stdioPlan(invocation.options.stdio, "pipe");
    const spawned = syncDispatch({
      op: "spawn",
      runtime: runtimeForCommand(invocation.command),
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.options.cwd ?? request.cwd,
      env: Object.fromEntries(
        Object.entries(invocation.options.env ?? request.env).filter(([, value]) => value !== void 0).map(([name, value]) => [name, String(value)])
      ),
      ...invocation.options.detached ? { processGroupId: 0, sessionId: 0 } : {},
      ...plan.descriptorMappings.length > 0 ? { descriptorMappings: plan.descriptorMappings } : {},
      stdio: plan.stdio
    });
    const child = new BrowserChildProcess(
      spawned.pid,
      spawned.stdio,
      invocation.options.signal
    );
    globalThis.queueMicrotask(() => child.emit("spawn"));
    const waitHandle = eventLoopApi.trackRefable(
      asyncDispatch({ op: "wait", pid: spawned.pid }).then(
        async (waited) => {
          const termination = waited.termination;
          if (!termination) {
            throw Object.assign(
              new Error("EPROTO: blocking child wait returned a running process"),
              { code: "EPROTO" }
            );
          }
          if (termination.kind === "signal") {
            child.signalCode = termination.signal;
          } else {
            child.exitCode = termination.exitCode;
          }
          child.emit(
            "exit",
            child.exitCode,
            child.signalCode
          );
          await Promise.all([
            child.stdout?.completion,
            child.stderr?.completion
          ]);
          child.emit(
            "close",
            child.exitCode,
            child.signalCode
          );
        },
        (error) => {
          if (executionState.cancelled) return;
          child.emit("error", error);
          child.emit("close", null, null);
        }
      )
    );
    child.attachRefControl(waitHandle);
    void waitHandle.completion;
    return child;
  };
  const spawnSync = (command, argsOrOptions, maybeOptions) => {
    const invocation = normalizeInvocation(command, argsOrOptions, maybeOptions);
    const plan = stdioPlan(invocation.options.stdio, "ignore");
    if (plan.hasPipe) {
      throw Object.assign(
        new Error("ENOSYS: synchronous piped child stdio requires a nonblocking host capture path"),
        { code: "ENOSYS" }
      );
    }
    const spawned = syncDispatch({
      op: "spawn",
      runtime: runtimeForCommand(invocation.command),
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.options.cwd ?? request.cwd,
      env: Object.fromEntries(
        Object.entries(invocation.options.env ?? request.env).filter(([, value]) => value !== void 0).map(([name, value]) => [name, String(value)])
      ),
      ...invocation.options.detached ? { processGroupId: 0, sessionId: 0 } : {},
      ...plan.descriptorMappings.length > 0 ? { descriptorMappings: plan.descriptorMappings } : {},
      stdio: plan.stdio
    });
    const waited = syncDispatch({ op: "wait", pid: spawned.pid });
    const termination = waited.termination;
    if (!termination) {
      throw Object.assign(
        new Error("EPROTO: blocking child wait returned a running process"),
        { code: "EPROTO" }
      );
    }
    return {
      pid: spawned.pid,
      output: [null, BrowserBuffer.alloc(0), BrowserBuffer.alloc(0)],
      stdout: BrowserBuffer.alloc(0),
      stderr: BrowserBuffer.alloc(0),
      status: termination.kind === "signal" ? null : termination.exitCode,
      signal: termination.kind === "signal" ? termination.signal : null
    };
  };
  return {
    ChildProcess: BrowserChildProcess,
    spawn,
    spawnSync
  };
}

// packages/runtime-javascript/src/node-compat/crypto.ts
function createCryptoApi() {
  const randomFill = (target) => {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi?.getRandomValues) {
      cryptoApi.getRandomValues(target);
      return target;
    }
    for (let index = 0; index < target.length; index += 1) {
      target[index] = Math.floor(Math.random() * 256);
    }
    return target;
  };
  return {
    randomUUID: () => globalThis.crypto?.randomUUID?.() ?? `${bytesToHex(randomFill(new Uint8Array(4)))}-${bytesToHex(randomFill(new Uint8Array(2)))}-4${bytesToHex(randomFill(new Uint8Array(2))).slice(1)}-8${bytesToHex(randomFill(new Uint8Array(2))).slice(1)}-${bytesToHex(randomFill(new Uint8Array(6)))}`,
    randomBytes: (size) => browserBufferFromBytes(randomFill(new Uint8Array(Math.max(0, Math.floor(Number(size) || 0))))),
    getRandomValues: (array) => randomFill(array)
  };
}

// packages/runtime-javascript/src/node-compat/event-loop.ts
function createBrowserEventLoopApi(executionState) {
  const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
  const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const hostQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
  let nextTimerId = 1;
  let pendingTimerWork = Promise.resolve();
  let timerError;
  let pendingExternalWork = 0;
  const timers = /* @__PURE__ */ new Map();
  const recordTimerWork = (work) => {
    pendingTimerWork = Promise.allSettled([pendingTimerWork, work]).then(() => void 0);
  };
  const runTimerCallback = (callback, args) => {
    const work = Promise.resolve().then(() => callback(...args)).then(
      () => void 0,
      (error) => {
        timerError ??= error;
      }
    );
    recordTimerWork(work);
  };
  const setTrackedTimeout = (callback, delay, ...args) => {
    const id = nextTimerId++;
    const handle = hostSetTimeout(() => {
      timers.delete(id);
      if (executionState.cancelled) return;
      runTimerCallback(callback, args);
    }, Math.max(0, Number(delay) || 0));
    timers.set(id, { handle, interval: false });
    return id;
  };
  const clearTrackedTimeout = (id) => {
    if (typeof id !== "number") return;
    const timer = timers.get(id);
    if (!timer) return;
    hostClearTimeout(timer.handle);
    timers.delete(id);
  };
  const setTrackedInterval = (callback, delay, ...args) => {
    const id = nextTimerId++;
    const run = () => {
      if (!timers.has(id) || executionState.cancelled) return;
      runTimerCallback(callback, args);
      const timer = timers.get(id);
      if (!timer) return;
      timer.handle = hostSetTimeout(run, Math.max(0, Number(delay) || 0));
    };
    const handle = hostSetTimeout(run, Math.max(0, Number(delay) || 0));
    timers.set(id, { handle, interval: true });
    return id;
  };
  const setTrackedImmediate = (callback, ...args) => setTrackedTimeout(callback, 0, ...args);
  const drain = async () => {
    await new Promise((resolve) => hostSetTimeout(resolve, 0));
    while (!executionState.cancelled && (timers.size > 0 || pendingExternalWork > 0)) {
      await new Promise((resolve) => hostSetTimeout(resolve, 0));
      await pendingTimerWork;
      if (timerError !== void 0) throw timerError;
      if ([...timers.values()].some((timer) => timer.interval)) {
        await new Promise((resolve) => hostSetTimeout(resolve, 0));
      }
    }
    if (!executionState.cancelled) await pendingTimerWork;
    if (timerError !== void 0) throw timerError;
  };
  const clearAll = () => {
    for (const timer of timers.values()) {
      hostClearTimeout(timer.handle);
    }
    timers.clear();
    pendingExternalWork = 0;
  };
  const track = (work) => {
    pendingExternalWork += 1;
    return work.finally(() => {
      pendingExternalWork = Math.max(0, pendingExternalWork - 1);
    });
  };
  const trackRefable = (work) => {
    let referenced = true;
    let settled = false;
    pendingExternalWork += 1;
    const completion = work.finally(() => {
      settled = true;
      if (referenced) {
        pendingExternalWork = Math.max(0, pendingExternalWork - 1);
      }
    });
    return {
      completion,
      ref() {
        if (settled || referenced) return;
        referenced = true;
        pendingExternalWork += 1;
      },
      unref() {
        if (settled || !referenced) return;
        referenced = false;
        pendingExternalWork = Math.max(0, pendingExternalWork - 1);
      }
    };
  };
  return {
    setTimeout: setTrackedTimeout,
    clearTimeout: clearTrackedTimeout,
    setInterval: setTrackedInterval,
    clearInterval: clearTrackedTimeout,
    setImmediate: setTrackedImmediate,
    clearImmediate: clearTrackedTimeout,
    queueMicrotask: hostQueueMicrotask,
    track,
    trackRefable,
    drain,
    clearAll
  };
}

// packages/runtime-javascript/src/node-compat/path-os.ts
function createPathApi(getCwd, workspaceRoot) {
  const normalizePath = (value) => {
    const raw = String(value).replace(/\\/g, "/");
    const isAbsolute2 = raw.startsWith("/");
    const parts = [];
    for (const part of raw.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        const previous = parts[parts.length - 1];
        if (previous && previous !== "..") {
          parts.pop();
        } else if (!isAbsolute2) {
          parts.push("..");
        }
      } else {
        parts.push(part);
      }
    }
    const normalized = parts.join("/");
    if (isAbsolute2) return normalized ? `/${normalized}` : "/";
    return normalized || ".";
  };
  const cwdAbsolutePath = () => {
    const cwd = getCwd();
    return cwd ? `${workspaceRoot}/${cwd}` : workspaceRoot;
  };
  const isAbsolute = (path) => String(path).startsWith("/");
  const normalize = (path) => normalizePath(path);
  const join = (...parts) => normalizePath(parts.filter((part) => String(part).length > 0).join("/"));
  const resolve = (...parts) => {
    const rawParts = parts.map((part) => String(part)).filter((part) => part.length > 0);
    let resolved = "";
    for (let index = rawParts.length - 1; index >= 0; index -= 1) {
      resolved = resolved ? `${rawParts[index]}/${resolved}` : rawParts[index] ?? "";
      if (resolved.startsWith("/")) return normalizePath(resolved);
    }
    return normalizePath(`${cwdAbsolutePath()}/${resolved}`);
  };
  const dirnameApi = (path) => {
    const normalized = normalizePath(path);
    if (normalized === "/") return "/";
    const withoutTrailingSlash = normalized.replace(/\/+$/, "");
    const index = withoutTrailingSlash.lastIndexOf("/");
    if (index === -1) return ".";
    if (index === 0) return "/";
    return withoutTrailingSlash.slice(0, index);
  };
  const basename = (path, suffix) => {
    const normalized = normalizePath(path).replace(/\/+$/, "");
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
  };
  const extname = (path) => {
    const base = basename(path);
    const index = base.lastIndexOf(".");
    if (index <= 0) return "";
    return base.slice(index);
  };
  const relative = (from, to) => {
    const fromParts = resolve(from).split("/").filter(Boolean);
    const toParts = resolve(to).split("/").filter(Boolean);
    let common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
      common += 1;
    }
    return [
      ...fromParts.slice(common).map(() => ".."),
      ...toParts.slice(common)
    ].join("/") || "";
  };
  const parse = (path) => {
    const normalized = normalizePath(path);
    const root = normalized.startsWith("/") ? "/" : "";
    const dir = dirnameApi(normalized);
    const base = basename(normalized);
    const ext = extname(base);
    const name = ext ? base.slice(0, -ext.length) : base;
    return {
      root,
      dir: dir === "." ? "" : dir,
      base,
      ext,
      name
    };
  };
  const format = (pathObject) => {
    const dir = pathObject.dir || pathObject.root || "";
    const base = pathObject.base ?? `${pathObject.name ?? ""}${pathObject.ext ?? ""}`;
    if (!dir) return base;
    if (dir === "/") return `/${base}`;
    return `${dir}/${base}`;
  };
  const api = {
    sep: "/",
    delimiter: ":",
    normalize,
    join,
    resolve,
    dirname: dirnameApi,
    basename,
    extname,
    isAbsolute,
    relative,
    parse,
    format
  };
  return { ...api, posix: api };
}
function inferWorkspaceHome(workspaceRoot) {
  const parts = workspaceRoot.split("/").filter(Boolean);
  if (parts.length >= 3 && parts[0] === "home") {
    return `/${parts.slice(0, 2).join("/")}`;
  }
  const parent = dirname(workspaceRoot);
  return parent || workspaceRoot;
}
function workspaceUsername(workspaceHome) {
  const parts = workspaceHome.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "browser";
}
function createOsApi(workspaceRoot, kernelInfo) {
  const home = inferWorkspaceHome(workspaceRoot);
  const cpuCount = Math.max(1, Math.min(8, Math.floor(globalThis.navigator?.hardwareConcurrency ?? 2)));
  const cpu = () => ({
    model: "Virtual CPU",
    speed: 2400,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
  });
  return {
    EOL: "\n",
    devNull: "/dev/null",
    arch: () => "x64",
    availableParallelism: () => cpuCount,
    cpus: () => Array.from({ length: cpuCount }, cpu),
    endianness: () => "LE",
    freemem: () => 6 * 1024 * 1024 * 1024,
    homedir: () => home,
    hostname: () => kernelInfo.host.hostname,
    loadavg: () => [0, 0, 0],
    machine: () => "x86_64",
    networkInterfaces: () => ({}),
    platform: () => "tracekernel",
    release: () => kernelInfo.version,
    tmpdir: () => "/tmp",
    totalmem: () => 8 * 1024 * 1024 * 1024,
    type: () => "tracekernel",
    uptime: () => 0,
    version: () => kernelInfo.version,
    userInfo: () => ({
      username: workspaceUsername(home),
      uid: 1e3,
      gid: 1e3,
      shell: "/bin/bash",
      homedir: home
    })
  };
}

// packages/runtime-javascript/src/node-compat/streams.ts
var streamInternalCloseListeners = /* @__PURE__ */ new WeakMap();
function setStreamInternalCloseListeners(stream, listeners) {
  streamInternalCloseListeners.set(stream, listeners);
}
function addStreamInternalCloseListener(stream, listener) {
  if (typeof stream !== "object" && typeof stream !== "function" || stream === null) return;
  streamInternalCloseListeners.get(stream)?.add(listener);
}
function createStreamApi() {
  class PassThrough extends BrowserEventEmitter {
    ended = false;
    write(chunk) {
      if (this.ended) throw new Error("write after end");
      this.emit("data", BrowserBuffer.isBuffer(chunk) ? chunk : BrowserBuffer.from(chunk));
      return true;
    }
    end(chunk) {
      if (chunk !== void 0) this.write(chunk);
      this.ended = true;
      this.emit("end");
      this.emit("finish");
      return this;
    }
    pipe(destination) {
      this.on("data", (chunk) => destination.write(chunk));
      this.on("end", () => destination.end?.());
      return destination;
    }
  }
  return {
    Stream: BrowserEventEmitter,
    Readable: PassThrough,
    Writable: PassThrough,
    Duplex: PassThrough,
    Transform: PassThrough,
    PassThrough
  };
}

// packages/runtime-javascript/src/node-compat/timers.ts
function createTimersPromisesApi(eventLoopApi) {
  return {
    setTimeout: (delay, value) => new Promise((resolve) => {
      eventLoopApi.setTimeout(() => resolve(value), delay);
    }),
    setImmediate: (value) => new Promise((resolve) => {
      eventLoopApi.setImmediate(() => resolve(value));
    })
  };
}

// packages/runtime-javascript/src/node-compat/url.ts
function createUrlApi() {
  return {
    URL,
    URLSearchParams,
    domainToASCII: (domain) => {
      try {
        return new URL(`http://${domain}`).hostname;
      } catch {
        return "";
      }
    },
    domainToUnicode: (domain) => {
      try {
        return new URL(`http://${domain}`).hostname;
      } catch {
        return "";
      }
    },
    fileURLToPath: (value) => {
      const url = value instanceof URL ? value : new URL(value);
      if (url.protocol !== "file:") {
        throw new TypeError("The URL must be of scheme file");
      }
      return decodeURIComponent(url.pathname);
    },
    pathToFileURL: (path) => new URL(`file://${path.startsWith("/") ? path : `/${path}`}`)
  };
}

// packages/runtime-javascript/src/browser/request-state.ts
function createBrowserJavaScriptRequestState(request, options, executionState) {
  const stdout = [];
  const stderr = [];
  const liveIo = new RuntimeProjectLiveIoController({
    applyFileChange: options.applyFileChange ? async (change, phase, applyOptions) => {
      if (executionState.cancelled) return false;
      return options.applyFileChange?.(change, phase, applyOptions);
    } : void 0,
    onEvent: (event) => {
      if (!executionState.cancelled) request.onEvent?.(event);
    },
    signal: executionState.abortController.signal
  });
  const emitRuntimeEvent = (event) => {
    liveIo.handleRuntimeEvent(event);
  };
  const io = createRuntimeProjectIoBridge(emitRuntimeEvent);
  const workspacePathContext = createWorkspacePathContext(request.project);
  const workspaceRoot = workspacePathContext.root;
  const kernelInfo = request.project.kernel ?? fallbackKernelInfo(request.project, workspacePathContext);
  const kernelDevices = request.project.kernelDevices;
  const procSnapshot = createBrowserProcSnapshot(request.project.kernelFiles, request);
  const cwdPath = workspaceCwdPath(request);
  const hiddenFiles = Array.from(new Set(
    (request.project.hiddenFiles ?? []).map((path) => normalizeWorkspaceEntryPath(path, "", false, workspacePathContext))
  ));
  const hiddenNamespaces = /* @__PURE__ */ new Set();
  for (const hiddenPath of hiddenFiles) {
    if (!hiddenPath) continue;
    hiddenNamespaces.add(hiddenPath);
    const parts = hiddenPath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      hiddenNamespaces.add(parts.slice(0, index).join("/"));
    }
  }
  const isHiddenNamespacePath = (path) => Boolean(path) && Array.from(hiddenNamespaces).some((hiddenPath) => path === hiddenPath || path.startsWith(`${hiddenPath}/`));
  const isHiddenProjectPath = (path) => isHiddenNamespacePath(path) || hiddenFiles.some((hiddenPath) => hiddenPath.startsWith(`${path}/`));
  const readonlyFiles = new Set(
    (request.project.readonlyFiles ?? []).map((path) => normalizeWorkspaceEntryPath(path, "", false, workspacePathContext))
  );
  io.status("process-start", "Starting browser Node", {
    command: "node",
    args: processArgvForRequest(request).slice(2),
    cwd: request.cwd
  });
  const visibleProjectFiles = request.project.files.filter(
    (file) => !isHiddenProjectPath(assertSafeWorkspaceFilePath(file.path, "", workspacePathContext))
  );
  const visibleProjectSymlinks = (request.project.symlinks ?? []).filter(
    (symlink) => !isHiddenProjectPath(assertSafeWorkspaceFilePath(symlink.path, "", workspacePathContext))
  );
  const modules = new Map(
    visibleProjectFiles.filter((file) => file.encoding !== "base64").map((file) => [
      assertSafeWorkspaceFilePath(file.path, "", workspacePathContext),
      file.contents.startsWith("#!") ? file.contents.replace(/^#![^\r\n]*(?:\r?\n|$)/, (line) => line.replace(/[^\r\n]/g, " ")) : file.contents
    ])
  );
  const virtualTextFiles = /* @__PURE__ */ new Map();
  const virtualTypeScriptPackagePaths = [
    "node_modules/typescript/package.json",
    "node_modules/typescript/index.js"
  ];
  const hasTypeScriptPackage = Array.from(modules.keys()).some((path) => path.startsWith("node_modules/typescript/"));
  const canExposeVirtualTypeScriptPackage = virtualTypeScriptPackagePaths.every((path) => !isHiddenProjectPath(path));
  if (!hasTypeScriptPackage && canExposeVirtualTypeScriptPackage && projectDeclaresDependency(modules, "typescript")) {
    const version = getLanguageRuntimeInfo("typescript").compiler?.version ?? "5.9.3";
    virtualTextFiles.set("node_modules/typescript/package.json", JSON.stringify({
      name: "typescript",
      version,
      main: "index.js"
    }, null, 2) + "\n");
    virtualTextFiles.set("node_modules/typescript/index.js", [
      `const version = ${JSON.stringify(version)};`,
      "module.exports = {",
      "  version,",
      '  versionMajorMinor: version.split(".").slice(0, 2).join("."),',
      "};",
      ""
    ].join("\n"));
  }
  for (const [path, contents] of virtualTextFiles) {
    modules.set(path, contents);
  }
  const fileStore = new Map(
    visibleProjectFiles.map((file) => [assertSafeWorkspaceFilePath(file.path, "", workspacePathContext), fileBytes(file)])
  );
  const symlinkStore = new Map(
    visibleProjectSymlinks.map((symlink) => [
      assertSafeWorkspaceFilePath(symlink.path, "", workspacePathContext),
      symlink.target
    ])
  );
  for (const [path, contents] of virtualTextFiles) {
    fileStore.set(path, textEncoder3.encode(contents));
  }
  const initialVisibleBytes = visibleProjectFiles.reduce((total, file) => total + fileBytes(file).byteLength, 0) + visibleProjectSymlinks.reduce((total, symlink) => total + utf8Bytes(symlink.target).byteLength, 0);
  const initialVisibleEntries = /* @__PURE__ */ new Set([
    ...visibleProjectFiles.map((file) => assertSafeWorkspaceFilePath(file.path, "", workspacePathContext)),
    ...visibleProjectSymlinks.map((symlink) => assertSafeWorkspaceFilePath(symlink.path, "", workspacePathContext)),
    ...(request.project.directories ?? []).map(
      (directory) => normalizeWorkspaceEntryPath(directory, "", true, workspacePathContext)
    ).filter(Boolean)
  ]);
  const unmodeledStorageBytes = Math.max(0, (request.project.storage?.usedBytes ?? initialVisibleBytes) - initialVisibleBytes);
  const unmodeledStorageEntries = Math.max(
    0,
    (request.project.storage?.usedEntries ?? initialVisibleEntries.size) - initialVisibleEntries.size
  );
  const virtualStorageEntries = /* @__PURE__ */ new Set();
  for (const path of virtualTextFiles.keys()) {
    virtualStorageEntries.add(path);
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join("/");
      if (!initialVisibleEntries.has(directory)) virtualStorageEntries.add(directory);
    }
  }
  const directoryStore = /* @__PURE__ */ new Set([""]);
  for (const filePath of fileStore.keys()) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directoryStore.add(parts.slice(0, index).join("/"));
    }
  }
  for (const symlinkPath of symlinkStore.keys()) {
    const parts = symlinkPath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directoryStore.add(parts.slice(0, index).join("/"));
    }
  }
  for (const directory of request.project.directories ?? []) {
    const directoryPath = normalizeWorkspaceEntryPath(directory, "", true, workspacePathContext);
    if (!directoryPath) continue;
    if (isHiddenProjectPath(directoryPath)) continue;
    const parts = directoryPath.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      directoryStore.add(parts.slice(0, index).join("/"));
    }
  }
  const projectDirectoryMetadata = new Map(
    (request.project.directoryMetadata ?? []).map((directory) => [
      normalizeWorkspaceEntryPath(directory.path, "", true, workspacePathContext),
      directory
    ])
  );
  let fsTimestampMs = Math.max(1, ...visibleProjectFiles.map((file) => file.mtimeMs ?? 1));
  const createEntryMetadata = (mode, timestamps = {}) => ({
    atimeMs: timestamps.atimeMs ?? timestamps.mtimeMs ?? fsTimestampMs,
    birthtimeMs: timestamps.mtimeMs ?? fsTimestampMs,
    ctimeMs: timestamps.mtimeMs ?? fsTimestampMs,
    gid: 1e3,
    mode,
    mtimeMs: timestamps.mtimeMs ?? fsTimestampMs,
    uid: 1e3
  });
  const entryMetadata = new Map(
    visibleProjectFiles.map((file) => {
      const filePath = assertSafeWorkspaceFilePath(file.path, "", workspacePathContext);
      return [filePath, createEntryMetadata(32768 | (file.mode ?? 420), file)];
    })
  );
  for (const symlinkPath of symlinkStore.keys()) {
    entryMetadata.set(symlinkPath, createEntryMetadata(41471));
  }
  for (const path of virtualTextFiles.keys()) {
    entryMetadata.set(path, createEntryMetadata(33188));
  }
  for (const directoryPath of directoryStore) {
    if (!entryMetadata.has(directoryPath)) {
      const metadata = projectDirectoryMetadata.get(directoryPath);
      entryMetadata.set(directoryPath, createEntryMetadata(
        16384 | (metadata?.mode ?? 493),
        { atimeMs: metadata?.atimeMs, mtimeMs: metadata?.mtimeMs }
      ));
    }
  }
  const touchEntryMetadata = (path) => {
    fsTimestampMs += 1;
    const previous = entryMetadata.get(path);
    entryMetadata.set(path, {
      atimeMs: previous?.atimeMs ?? fsTimestampMs,
      birthtimeMs: previous?.birthtimeMs ?? fsTimestampMs,
      ctimeMs: fsTimestampMs,
      gid: previous?.gid ?? 1e3,
      mode: previous?.mode,
      mtimeMs: fsTimestampMs,
      uid: previous?.uid ?? 1e3
    });
  };
  const updateEntryMetadata = (path, update) => {
    fsTimestampMs += 1;
    const previous = entryMetadata.get(path) ?? createEntryMetadata();
    entryMetadata.set(path, {
      ...previous,
      ...update,
      ctimeMs: fsTimestampMs
    });
  };
  const deleteEntryMetadata = (path) => {
    fsTimestampMs += 1;
    entryMetadata.delete(path);
  };
  const runtimeFileForPath = (path, bytes) => {
    const metadata = entryMetadata.get(path);
    return {
      ...bytesToRuntimeFile(path, bytes),
      ...metadata?.mode !== void 0 ? { mode: metadata.mode & 4095 } : {},
      ...metadata ? { atimeMs: metadata.atimeMs, mtimeMs: metadata.mtimeMs } : {}
    };
  };
  const hardLinkGroups = /* @__PURE__ */ new Map();
  const hardLinkGroupForPath = (path) => hardLinkGroups.get(path) ?? /* @__PURE__ */ new Set([path]);
  const setHardLinkGroup = (paths) => {
    const group = new Set(paths);
    for (const path of group) hardLinkGroups.set(path, group);
    return group;
  };
  const linkPaths = (source, destination) => {
    setHardLinkGroup([...hardLinkGroupForPath(source), destination]);
  };
  const unlinkPathFromHardLinks = (path) => {
    const group = hardLinkGroups.get(path);
    if (!group) return;
    group.delete(path);
    hardLinkGroups.delete(path);
    if (group.size <= 1) {
      for (const remaining of group) hardLinkGroups.delete(remaining);
      return;
    }
    for (const remaining of group) hardLinkGroups.set(remaining, group);
  };
  const moveHardLinkPath = (oldPath, newPath) => {
    const group = hardLinkGroups.get(oldPath);
    if (!group) return;
    group.delete(oldPath);
    group.add(newPath);
    hardLinkGroups.delete(oldPath);
    for (const path of group) hardLinkGroups.set(path, group);
  };
  const linkedInodeForPath = (path) => {
    const group = hardLinkGroups.get(path);
    return inodeForPath(group ? [...group].sort((left, right) => left.localeCompare(right))[0] ?? path : path);
  };
  const resolveStoredSymlinkPath = (path, followFinal = true) => {
    let current = path;
    for (let depth = 0; depth < 40; depth += 1) {
      const parts = current.split("/").filter(Boolean);
      const limit = followFinal ? parts.length : Math.max(0, parts.length - 1);
      let linkIndex = -1;
      let linkPath = "";
      for (let index = 0; index < limit; index += 1) {
        const candidate = parts.slice(0, index + 1).join("/");
        if (symlinkStore.has(candidate)) {
          linkIndex = index;
          linkPath = candidate;
          break;
        }
      }
      if (linkIndex === -1) return current;
      const target = symlinkStore.get(linkPath);
      const targetPath = normalizeWorkspaceEntryPath(target, dirname(linkPath), true, workspacePathContext);
      const suffix = parts.slice(linkIndex + 1).join("/");
      current = suffix ? normalizeWorkspaceEntryPath(`${targetPath}/${suffix}`, "", true, workspacePathContext) : targetPath;
    }
    throw Object.assign(new Error(`ELOOP: too many symbolic links encountered, stat '${path}'`), { code: "ELOOP" });
  };
  const resolveWorkspaceEntryPath = (path, followFinal = true) => resolveStoredSymlinkPath(
    normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext),
    followFinal
  );
  const originalFiles = new Map(fileStore);
  const originalSymlinks = new Map(symlinkStore);
  const originalDirectoryMetadata = new Map(
    [...directoryStore].map((path) => [path, { ...entryMetadata.get(path) ?? createEntryMetadata(16877) }])
  );
  const cache = /* @__PURE__ */ new Map();
  const requireCache = {};
  const symlinkModuleAliases = /* @__PURE__ */ new Set();
  const refreshSymlinkModuleAliases = () => {
    for (const alias of symlinkModuleAliases) {
      modules.delete(alias);
      cache.delete(alias);
      delete requireCache[workspaceFilename(alias, workspaceRoot)];
    }
    symlinkModuleAliases.clear();
    for (const linkPath of symlinkStore.keys()) {
      let resolved;
      try {
        resolved = resolveStoredSymlinkPath(linkPath);
      } catch {
        continue;
      }
      const linkedModule = modules.get(resolved);
      if (linkedModule !== void 0 && !fileStore.has(linkPath)) {
        modules.set(linkPath, linkedModule);
        symlinkModuleAliases.add(linkPath);
      }
      const prefix = `${resolved}/`;
      for (const [modulePath, contents] of [...modules.entries()]) {
        if (!modulePath.startsWith(prefix) || symlinkModuleAliases.has(modulePath)) continue;
        const alias = `${linkPath}/${modulePath.slice(prefix.length)}`;
        if (fileStore.has(alias)) continue;
        modules.set(alias, contents);
        symlinkModuleAliases.add(alias);
      }
    }
  };
  let mainModule;
  const kernelStdioAvailability = /* @__PURE__ */ new Map();
  const tryWriteKernelStdio = (fd2, bytes) => {
    if (kernelStdioAvailability.get(fd2) === false || !executionState.kernelSyscalls) {
      return false;
    }
    const result = executionState.kernelSyscalls.dispatchSync({
      op: "write",
      fd: fd2,
      bytes
    });
    if (result.ok === true) {
      kernelStdioAvailability.set(fd2, true);
      return true;
    }
    if (result.error.code === "EBADF") {
      kernelStdioAvailability.set(fd2, false);
      return false;
    }
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code
    });
  };
  const emitOutput = (stream, data, device, sourceDevice) => {
    if (stream === "stdout") {
      stdout.push(data);
    } else {
      stderr.push(data);
    }
    io.output(stream, data, device, sourceDevice);
  };
  const writeDevice = (device, data) => {
    const route = runtimeKernelDeviceOutputRoute(kernelDevices, device);
    if (!route) {
      if (runtimeKernelDeviceOutputTarget(kernelDevices, device) === "/dev/null") return;
      throw Object.assign(new Error("EBADF: bad file descriptor, write"), { code: "EBADF" });
    }
    if (tryWriteKernelStdio(
      route.stream === "stdout" ? 1 : 2,
      new TextEncoder().encode(data)
    )) return;
    emitOutput(route.stream, data, route.outputDevice, route.sourceDevice);
  };
  let kernelStdinClosed = false;
  const readDeviceBytes = (device, size) => {
    const inputRoute = runtimeKernelDeviceInputRoute(kernelDevices, device);
    if (!inputRoute) return new Uint8Array();
    if (executionState.kernelSyscalls) {
      if (kernelStdinClosed) return new Uint8Array();
      const result = executionState.kernelSyscalls.dispatchSync({
        op: "read",
        fd: 0,
        maxBytes: Math.max(0, Math.floor(size ?? 16 * 1024))
      });
      if (result.ok === false) {
        throw Object.assign(new Error(result.error.message), {
          code: result.error.code
        });
      }
      if (result.value.op !== "read") {
        throw Object.assign(
          new Error(`EPROTO: expected read response, received ${result.value.op}`),
          { code: "EPROTO" }
        );
      }
      if (result.value.bytes.byteLength === 0) kernelStdinClosed = true;
      return result.value.bytes;
    }
    if (request.stdinPipe) {
      return readRuntimeCommandStdinPipeBytes(request.stdinPipe, size);
    }
    return new Uint8Array();
  };
  const remainingDeviceBytes = (device) => runtimeKernelDeviceInputRoute(kernelDevices, device) ? executionState.kernelSyscalls ? kernelStdinClosed ? 0 : 1 : request.stdinPipe ? runtimeCommandStdinPipeRemainingBytes(request.stdinPipe) : 0 : 0;
  const deviceInputClosed = (device) => runtimeKernelDeviceInputRoute(kernelDevices, device) ? executionState.kernelSyscalls ? kernelStdinClosed : request.stdinPipe ? runtimeCommandStdinPipeClosed(request.stdinPipe) : true : true;
  const readDevice = (device) => textFromBytes(readDeviceBytes(device));
  const kernelDescriptorIsTerminal = (fd2) => {
    if (!executionState.kernelSyscalls) {
      return request.terminal?.isTTY === true;
    }
    const result = executionState.kernelSyscalls.dispatchSync({
      op: "isatty",
      fd: fd2
    });
    return result.ok && result.value.op === "isatty" && result.value.isTerminal;
  };
  const kernelDescriptorWindowSize = (fd2) => {
    if (!executionState.kernelSyscalls) {
      return {
        rows: request.terminal?.rows,
        columns: request.terminal?.columns
      };
    }
    const result = executionState.kernelSyscalls.dispatchSync({
      op: "tcgetwinsize",
      fd: fd2
    });
    if (result.ok === false) {
      if (result.error.code === "ENOTTY") return {};
      throw Object.assign(new Error(result.error.message), {
        code: result.error.code
      });
    }
    if (result.value.op !== "tcgetwinsize") {
      throw Object.assign(
        new Error(
          `EPROTO: expected tcgetwinsize response, received ${result.value.op}`
        ),
        { code: "EPROTO" }
      );
    }
    return {
      rows: result.value.rows,
      columns: result.value.columns
    };
  };
  const consoleApi = {
    log: (...values) => {
      writeDevice("/dev/stdout", `${formatConsoleValues(values)}
`);
    },
    error: (...values) => {
      writeDevice("/dev/stderr", `${formatConsoleValues(values)}
`);
    }
  };
  const createWritableDevice = (device, fd2) => {
    const listeners = /* @__PURE__ */ new Map();
    let destroyed = false;
    let closed = false;
    let bytesWritten = 0;
    let writableEnded = false;
    let writableFinished = false;
    const on = (event, listener) => {
      const next = listeners.get(event) ?? [];
      next.push(listener);
      listeners.set(event, next);
    };
    const removeListener = (event, listener) => {
      const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener);
      if (next.length === 0) listeners.delete(event);
      else listeners.set(event, next);
    };
    const emit = (event, ...args) => {
      const current = listeners.get(event) ?? [];
      for (const listener of current) listener(...args);
      return current.length > 0;
    };
    const stream = {
      fd: fd2,
      writable: true,
      isTTY: kernelDescriptorIsTerminal(fd2),
      get columns() {
        return kernelDescriptorWindowSize(fd2).columns;
      },
      get rows() {
        return kernelDescriptorWindowSize(fd2).rows;
      },
      getWindowSize: () => {
        const size = kernelDescriptorWindowSize(fd2);
        return [size.columns, size.rows];
      },
      getColorDepth: () => request.terminal?.colorLevel === 3 ? 24 : request.terminal?.colorLevel === 2 ? 8 : request.terminal?.colorLevel === 1 ? 4 : 1,
      hasColors: () => (request.terminal?.colorLevel ?? 0) > 0,
      get closed() {
        return closed;
      },
      get bytesWritten() {
        return bytesWritten;
      },
      get writableEnded() {
        return writableEnded;
      },
      get writableFinished() {
        return writableFinished;
      },
      write: (value, encoding, callback) => {
        const bytes = bytesFromFsWriteValue(value, typeof encoding === "string" ? encoding : void 0);
        if (!tryWriteKernelStdio(fd2 === 1 ? 1 : 2, bytes)) {
          writeDevice(device, textFromBytes(bytes));
        }
        bytesWritten += bytes.byteLength;
        const done = typeof encoding === "function" ? encoding : callback;
        done?.(null);
        return true;
      },
      end: (value, encoding, callback) => {
        if (value !== void 0 && value !== null) {
          stream.write(value, typeof encoding === "string" ? encoding : void 0);
        }
        writableEnded = true;
        const done = typeof encoding === "function" ? encoding : callback;
        queueMicrotask(() => {
          done?.();
          writableFinished = true;
          emit("finish");
          closed = true;
          emit("close");
        });
        return stream;
      },
      on: (event, listener) => {
        on(event, listener);
        return stream;
      },
      addListener: (event, listener) => {
        on(event, listener);
        return stream;
      },
      removeListener: (event, listener) => {
        removeListener(event, listener);
        return stream;
      },
      off: (event, listener) => {
        removeListener(event, listener);
        return stream;
      },
      emit,
      destroy: (error) => {
        if (destroyed) return stream;
        destroyed = true;
        queueMicrotask(() => {
          if (error) emit("error", error);
          closed = true;
          emit("close");
        });
        return stream;
      },
      close: (callback) => {
        if (callback) stream.once("close", callback);
        return stream.destroy();
      },
      get destroyed() {
        return destroyed;
      },
      once: (event, listener) => {
        const wrapped = (...args) => {
          removeListener(event, wrapped);
          listener(...args);
        };
        on(event, wrapped);
        return stream;
      }
    };
    return stream;
  };
  const eventLoopApi = createBrowserEventLoopApi(executionState);
  const stdinDevice = createReadableStdinDevice(
    (size) => readDeviceBytes("/dev/stdin", size),
    () => remainingDeviceBytes("/dev/stdin"),
    () => deviceInputClosed("/dev/stdin"),
    eventLoopApi.setTimeout,
    request.terminal,
    kernelDescriptorIsTerminal(0)
  );
  const nodeVersion = NODE_RUNTIME_COMPAT_VERSION;
  const processListeners = /* @__PURE__ */ new Map();
  const addProcessListener = (event, listener) => {
    if (event === "SIGKILL" || event === "SIGSTOP") {
      throw Object.assign(new Error(`uv_signal_start EINVAL`), { code: "EINVAL", errno: -22, syscall: "uv_signal_start" });
    }
    const next = processListeners.get(event) ?? [];
    next.push(listener);
    processListeners.set(event, next);
  };
  const removeProcessListener = (event, listener) => {
    const next = (processListeners.get(event) ?? []).filter((candidate) => candidate !== listener);
    if (next.length === 0) processListeners.delete(event);
    else processListeners.set(event, next);
  };
  const emitProcessEvent = (event, ...args) => {
    const current = [...processListeners.get(event) ?? []];
    for (const listener of current) listener(...args);
    return current.length > 0;
  };
  executionState.dispatchSignal = (signal) => {
    const handled = emitProcessEvent(signal, signal);
    if (handled) executionState.handledSignal = signal;
    return handled;
  };
  const processApi = {
    argv: processArgvForRequest(request),
    execArgv: [],
    execPath: "/usr/local/bin/node",
    env: request.env,
    version: `v${nodeVersion}`,
    versions: { node: nodeVersion },
    release: { name: "node" },
    platform: "tracekernel",
    arch: "x64",
    pid: request.process?.pid ?? 1,
    get ppid() {
      if (!executionState.kernelSyscalls) {
        return request.process?.ppid ?? 0;
      }
      const result = executionState.kernelSyscalls.dispatchSync({
        op: "identity"
      });
      if (result.ok === false) {
        throw Object.assign(new Error(result.error.message), {
          code: result.error.code
        });
      }
      if (result.value.op !== "identity") {
        throw Object.assign(
          new Error("EPROTO: identity syscall returned the wrong result"),
          { code: "EPROTO" }
        );
      }
      return result.value.ppid;
    },
    title: "node",
    exitCode: void 0,
    cwd: () => request.cwd,
    kill: (pid, signal = "SIGTERM") => {
      if (!Number.isSafeInteger(pid)) {
        throw Object.assign(
          new TypeError('The "pid" argument must be a safe integer'),
          { code: "ERR_INVALID_ARG_TYPE" }
        );
      }
      if (signal !== "SIGHUP" && signal !== "SIGINT" && signal !== "SIGQUIT" && signal !== "SIGTERM" && signal !== "SIGWINCH" && signal !== "SIGKILL") {
        throw Object.assign(
          new TypeError(`Unknown signal: ${String(signal)}`),
          { code: "ERR_UNKNOWN_SIGNAL" }
        );
      }
      if (!executionState.kernelSyscalls) {
        throw Object.assign(
          new Error("ENOSYS: TraceKernel process controls are unavailable"),
          { code: "ENOSYS" }
        );
      }
      const result = executionState.kernelSyscalls.dispatchSync({
        op: "kill",
        pid,
        signal
      });
      if (result.ok === false) {
        throw Object.assign(new Error(result.error.message), {
          code: result.error.code
        });
      }
      return true;
    },
    nextTick: (callback, ...args) => {
      globalThis.queueMicrotask(() => callback(...args));
    },
    on: (event, listener) => {
      addProcessListener(event, listener);
      return processApi;
    },
    addListener: (event, listener) => {
      addProcessListener(event, listener);
      return processApi;
    },
    once: (event, listener) => {
      const wrapped = (...args) => {
        removeProcessListener(event, wrapped);
        listener(...args);
      };
      addProcessListener(event, wrapped);
      return processApi;
    },
    removeListener: (event, listener) => {
      removeProcessListener(event, listener);
      return processApi;
    },
    off: (event, listener) => {
      removeProcessListener(event, listener);
      return processApi;
    },
    removeAllListeners: (event) => {
      if (event === void 0) processListeners.clear();
      else processListeners.delete(event);
      return processApi;
    },
    listeners: (event) => [...processListeners.get(event) ?? []],
    listenerCount: (event) => processListeners.get(event)?.length ?? 0,
    emit: emitProcessEvent,
    stdin: stdinDevice,
    stdout: createWritableDevice("/dev/stdout", 1),
    stderr: createWritableDevice("/dev/stderr", 2),
    exit: (code = 0) => {
      throw Object.assign(new Error(`process.exit(${code})`), {
        exitCode: Number(code) || 0,
        suppressStderr: true
      });
    }
  };
  const nodePathSearchEntries = nodePathEntries(request, cwdPath, workspacePathContext);
  const pathApi = createPathApi(() => cwdPath, workspaceRoot);
  const osApi = createOsApi(workspaceRoot, kernelInfo);
  const urlApi = createUrlApi();
  const assertApi = createAssertApi();
  const eventsApi = createEventsApi();
  const utilApi = createUtilApi();
  const streamApi = createStreamApi();
  const childProcessApi = createChildProcessApi(
    executionState,
    eventLoopApi,
    request
  );
  const traceKernelApi = createTraceKernelApi(executionState);
  const cryptoApi = createCryptoApi();
  const timersPromisesApi = createTimersPromisesApi(eventLoopApi);
  const syncTextModule = (path, bytes) => {
    const text = textFromBytes(bytes);
    if (byteEqual(utf8Bytes(text), bytes)) {
      modules.set(path, text);
    } else {
      modules.delete(path);
    }
  };
  return {
    assertApi,
    cache,
    childProcessApi,
    consoleApi,
    createEntryMetadata,
    cryptoApi,
    cwdPath,
    deleteEntryMetadata,
    directoryStore,
    entryMetadata,
    eventLoopApi,
    eventsApi,
    fileStore,
    hardLinkGroupForPath,
    io,
    isHiddenNamespacePath,
    kernelDevices,
    kernelInfo,
    linkPaths,
    linkedInodeForPath,
    liveIo,
    modules,
    moveHardLinkPath,
    nodePathSearchEntries,
    originalDirectoryMetadata,
    originalFiles,
    originalSymlinks,
    osApi,
    pathApi,
    procSnapshot,
    processApi,
    readDevice,
    readDeviceBytes,
    readonlyFiles,
    refreshSymlinkModuleAliases,
    requireCache,
    resolveStoredSymlinkPath,
    resolveWorkspaceEntryPath,
    runtimeFileForPath,
    stderr,
    stdout,
    streamApi,
    symlinkStore,
    syncTextModule,
    timersPromisesApi,
    touchEntryMetadata,
    traceKernelApi,
    unlinkPathFromHardLinks,
    unmodeledStorageBytes,
    unmodeledStorageEntries,
    updateEntryMetadata,
    urlApi,
    utilApi,
    virtualStorageEntries,
    workspacePathContext,
    workspaceRoot,
    writeDevice,
    get fsTimestampMs() {
      return fsTimestampMs;
    },
    set fsTimestampMs(value) {
      fsTimestampMs = value;
    },
    get mainModule() {
      return mainModule;
    },
    set mainModule(value) {
      mainModule = value;
    }
  };
}

// packages/runtime-javascript/src/kernel/filesystem-state.ts
function createBrowserFileSystemState(requestState, request, executionState) {
  const {
    assertApi,
    cache,
    childProcessApi,
    consoleApi,
    createEntryMetadata,
    cryptoApi,
    cwdPath,
    deleteEntryMetadata,
    directoryStore,
    entryMetadata,
    eventLoopApi,
    eventsApi,
    fileStore,
    hardLinkGroupForPath,
    io,
    isHiddenNamespacePath,
    kernelDevices,
    kernelInfo,
    linkPaths,
    linkedInodeForPath,
    liveIo,
    modules,
    moveHardLinkPath,
    nodePathSearchEntries,
    originalDirectoryMetadata,
    originalFiles,
    originalSymlinks,
    osApi,
    pathApi,
    procSnapshot,
    processApi,
    readDevice,
    readDeviceBytes,
    readonlyFiles,
    refreshSymlinkModuleAliases,
    requireCache,
    resolveStoredSymlinkPath,
    resolveWorkspaceEntryPath,
    runtimeFileForPath,
    stderr,
    stdout,
    streamApi,
    symlinkStore,
    syncTextModule,
    timersPromisesApi,
    touchEntryMetadata,
    traceKernelApi,
    unlinkPathFromHardLinks,
    unmodeledStorageBytes,
    unmodeledStorageEntries,
    updateEntryMetadata,
    urlApi,
    utilApi,
    virtualStorageEntries,
    workspacePathContext,
    workspaceRoot,
    writeDevice
  } = requestState;
  let fsApiBridge;
  const fsWatchers = /* @__PURE__ */ new Set();
  const fsFileWatchers = /* @__PURE__ */ new Set();
  const statForNormalizedPath = (normalized, followFinal = true) => {
    if (!followFinal && symlinkStore.has(normalized)) {
      const target = symlinkStore.get(normalized);
      const metadata2 = entryMetadata.get(normalized) ?? createEntryMetadata(41471);
      return {
        atimeMs: metadata2.atimeMs,
        birthtimeMs: metadata2.birthtimeMs,
        blksize: 4096,
        blocks: Math.ceil(utf8Bytes(target).byteLength / 512),
        ctimeMs: metadata2.ctimeMs,
        dev: 1,
        gid: metadata2.gid,
        ino: inodeForPath(normalized),
        mode: metadata2.mode ?? 41471,
        mtimeMs: metadata2.mtimeMs,
        nlink: 1,
        rdev: 0,
        size: utf8Bytes(target).byteLength,
        uid: metadata2.uid,
        atime: new Date(metadata2.atimeMs),
        birthtime: new Date(metadata2.birthtimeMs),
        ctime: new Date(metadata2.ctimeMs),
        mtime: new Date(metadata2.mtimeMs),
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isFile: () => false,
        isDirectory: () => false,
        isSocket: () => false,
        isSymbolicLink: () => true
      };
    }
    const resolved = resolveStoredSymlinkPath(normalized, followFinal);
    const isFile = fileStore.has(resolved);
    const prefix = resolved ? `${resolved}/` : "";
    const isDirectory = !isFile && (directoryStore.has(resolved) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix)));
    if (!isFile && !isDirectory) return null;
    const metadata = entryMetadata.get(resolved) ?? createEntryMetadata(isDirectory ? 16877 : 33188);
    const size = isFile ? fileStore.get(resolved)?.byteLength ?? 0 : 0;
    const mode = metadata.mode ?? (isDirectory ? 16877 : 33188);
    return {
      atimeMs: metadata.atimeMs,
      birthtimeMs: metadata.birthtimeMs,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      ctimeMs: metadata.ctimeMs,
      dev: 1,
      gid: metadata.gid,
      ino: isFile ? linkedInodeForPath(resolved) : inodeForPath(resolved),
      mode,
      mtimeMs: metadata.mtimeMs,
      nlink: isDirectory ? 2 : hardLinkGroupForPath(resolved).size,
      rdev: 0,
      size,
      uid: metadata.uid,
      atime: new Date(metadata.atimeMs),
      birthtime: new Date(metadata.birthtimeMs),
      ctime: new Date(metadata.ctimeMs),
      mtime: new Date(metadata.mtimeMs),
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isFile: () => isFile,
      isDirectory: () => isDirectory,
      isSocket: () => false,
      isSymbolicLink: () => false
    };
  };
  const statForKernelPath = (path, kernelStat) => {
    const modeType = kernelStat.isDirectory ? 16384 : kernelStat.isCharacterDevice ? 8192 : 32768;
    const mode = modeType | kernelStat.mode;
    return {
      atimeMs: requestState.fsTimestampMs,
      birthtimeMs: requestState.fsTimestampMs,
      blksize: 4096,
      blocks: Math.ceil(kernelStat.size / 512),
      ctimeMs: requestState.fsTimestampMs,
      dev: 1,
      gid: 0,
      ino: inodeForPath(path),
      mode,
      mtimeMs: requestState.fsTimestampMs,
      nlink: kernelStat.isDirectory ? 2 : 1,
      rdev: 0,
      size: kernelStat.size,
      uid: 0,
      atime: new Date(requestState.fsTimestampMs),
      birthtime: new Date(requestState.fsTimestampMs),
      ctime: new Date(requestState.fsTimestampMs),
      mtime: new Date(requestState.fsTimestampMs),
      isBlockDevice: () => false,
      isCharacterDevice: () => kernelStat.isCharacterDevice,
      isFIFO: () => false,
      isFile: () => kernelStat.isFile,
      isDirectory: () => kernelStat.isDirectory,
      isSocket: () => false,
      isSymbolicLink: () => false
    };
  };
  const statForTraceKernelPath = (stat) => {
    const directory = stat.kind === "directory";
    const symbolicLink = stat.kind === "symlink";
    const modeType = directory ? 16384 : symbolicLink ? 40960 : 32768;
    const mode = (stat.mode & 61440) === 0 ? modeType | stat.mode : stat.mode;
    return {
      atimeMs: stat.modifiedAt,
      birthtimeMs: stat.createdAt,
      blksize: 4096,
      blocks: Math.ceil(stat.size / 512),
      ctimeMs: stat.changedAt,
      dev: 1,
      gid: 0,
      ino: stat.inode,
      mode,
      mtimeMs: stat.modifiedAt,
      nlink: stat.nlink,
      rdev: 0,
      size: stat.size,
      uid: 0,
      atime: new Date(stat.modifiedAt),
      birthtime: new Date(stat.createdAt),
      ctime: new Date(stat.changedAt),
      mtime: new Date(stat.modifiedAt),
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isFile: () => !directory && !symbolicLink,
      isDirectory: () => directory,
      isSocket: () => false,
      isSymbolicLink: () => symbolicLink
    };
  };
  const statForKernelTarget = (path, options) => {
    const statTarget = runtimeStatTarget(path, kernelInfo, kernelDevices, procSnapshot);
    if (!statTarget || statTarget.kind === "workspace") return null;
    if (statTarget.kind === "error") {
      if (options?.throwIfNoEntry === false) return void 0;
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
    }
    return statForKernelPath(statTarget.path, statTarget.stat);
  };
  const browserFileSystemStat = (bigint = false) => {
    const blockSize = 4096;
    const capacityBytes = request.project.storage?.capacityBytes ?? 64 * 1024 * 1024;
    const capacityEntries = request.project.storage?.capacityEntries ?? 1e4;
    const visibleBytes = Array.from(fileStore.entries()).reduce(
      (total, [path, bytes]) => total + (virtualStorageEntries.has(path) ? 0 : bytes.byteLength),
      0
    ) + Array.from(symlinkStore.values()).reduce((total, target) => total + utf8Bytes(target).byteLength, 0);
    const visibleEntries = (/* @__PURE__ */ new Set([
      ...Array.from(fileStore.keys()).filter((path) => !virtualStorageEntries.has(path)),
      ...Array.from(symlinkStore.keys()),
      ...Array.from(directoryStore).filter((path) => path !== "" && !virtualStorageEntries.has(path))
    ])).size;
    const usedBytes = Math.min(capacityBytes, unmodeledStorageBytes + visibleBytes);
    const usedEntries = Math.min(capacityEntries, unmodeledStorageEntries + visibleEntries);
    const blocks = Math.ceil(capacityBytes / blockSize);
    const usedBlocks = Math.ceil(usedBytes / blockSize);
    const stats = {
      type: 1953653605,
      bsize: blockSize,
      blocks,
      bfree: Math.max(0, blocks - usedBlocks),
      bavail: Math.max(0, blocks - usedBlocks),
      files: capacityEntries,
      ffree: Math.max(0, capacityEntries - usedEntries)
    };
    if (!bigint) return stats;
    return Object.fromEntries(
      Object.entries(stats).map(([key, value]) => [key, BigInt(value)])
    );
  };
  const browserStatsResult = (stats, options) => {
    if (!options?.bigint) return stats;
    return {
      ...stats,
      atimeMs: BigInt(Math.trunc(stats.atimeMs)),
      birthtimeMs: BigInt(Math.trunc(stats.birthtimeMs)),
      blksize: BigInt(stats.blksize),
      blocks: BigInt(stats.blocks),
      ctimeMs: BigInt(Math.trunc(stats.ctimeMs)),
      dev: BigInt(stats.dev),
      gid: BigInt(stats.gid),
      ino: BigInt(stats.ino),
      mode: BigInt(stats.mode),
      mtimeMs: BigInt(Math.trunc(stats.mtimeMs)),
      nlink: BigInt(stats.nlink),
      rdev: BigInt(stats.rdev),
      size: BigInt(stats.size),
      uid: BigInt(stats.uid)
    };
  };
  const missingFileStat = () => ({
    atime: /* @__PURE__ */ new Date(0),
    atimeMs: 0,
    birthtime: /* @__PURE__ */ new Date(0),
    birthtimeMs: 0,
    blksize: 4096,
    blocks: 0,
    ctime: /* @__PURE__ */ new Date(0),
    ctimeMs: 0,
    dev: 1,
    gid: 0,
    ino: 0,
    mode: 0,
    mtime: /* @__PURE__ */ new Date(0),
    mtimeMs: 0,
    nlink: 0,
    rdev: 0,
    size: 0,
    uid: 0,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isFile: () => false,
    isDirectory: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false
  });
  const watchedFilename = (watcher, changedPath) => {
    if (changedPath === watcher.path) return changedPath.split("/").pop() ?? changedPath;
    const prefix = watcher.path ? `${watcher.path}/` : "";
    if (!changedPath.startsWith(prefix)) return null;
    const relative = changedPath.slice(prefix.length);
    if (!watcher.recursive && relative.includes("/")) return null;
    return relative;
  };
  const emitFsWatch = (watcher, eventType, filename) => {
    if (watcher.closed) return;
    for (const listener of watcher.listeners.get("change") ?? []) listener(eventType, filename);
  };
  const notifyFsWatchers = (eventType, path) => {
    for (const watcher of fsWatchers) {
      if (watcher.kernelFd !== void 0) continue;
      const filename = watchedFilename(watcher, path);
      if (filename !== null) queueMicrotask(() => emitFsWatch(watcher, eventType, filename));
    }
  };
  const notifyWatchFileWatchers = (path) => {
    for (const watcher of fsFileWatchers) {
      if (watcher.path !== path) continue;
      const previous = watcher.previous;
      const current = statForNormalizedPath(path) ?? missingFileStat();
      watcher.previous = current;
      queueMicrotask(() => watcher.listener(current, previous));
    }
  };
  const notifyDirectoryMutation = (path) => {
    notifyFsWatchers("rename", path);
    notifyWatchFileWatchers(path);
  };
  const emitDirectoryCreate = (path) => {
    if (!path) return;
    const metadata = entryMetadata.get(path);
    io.fileChange({
      path,
      directory: true,
      ...metadata?.mode !== void 0 ? { mode: metadata.mode & 4095 } : {},
      ...metadata ? { atimeMs: metadata.atimeMs, mtimeMs: metadata.mtimeMs } : {}
    }, "live");
  };
  const emitDirectoryDelete = (path) => {
    if (!path) return;
    io.fileChange({ path, directory: true, deleted: true }, "live");
  };
  const assertReadonlyFilePath = (normalized, operation) => {
    if (readonlyFiles.has(normalized) || isHiddenNamespacePath(normalized)) {
      throw createRuntimeKernelReadonlyFileError(normalized, operation);
    }
  };
  const setFileBytes = (path, bytes, preservedMetadata) => {
    const linkedPaths = Array.from(hardLinkGroupForPath(path)).filter((linkedPath) => fileStore.has(linkedPath) || linkedPath === path);
    for (const linkedPath of linkedPaths) {
      assertReadonlyFilePath(linkedPath, "write");
    }
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directoryPath = parts.slice(0, index).join("/");
      const existed = directoryStore.has(directoryPath);
      directoryStore.add(directoryPath);
      if (!entryMetadata.has(directoryPath)) touchEntryMetadata(directoryPath);
      if (!existed) emitDirectoryCreate(directoryPath);
    }
    let movedMetadata;
    if (preservedMetadata) {
      requestState.fsTimestampMs += 1;
      movedMetadata = { ...preservedMetadata, ctimeMs: requestState.fsTimestampMs };
    }
    for (const linkedPath of linkedPaths) {
      fileStore.set(linkedPath, bytes);
      if (movedMetadata) entryMetadata.set(linkedPath, { ...movedMetadata });
      else touchEntryMetadata(linkedPath);
      syncTextModule(linkedPath, bytes);
      cache.delete(linkedPath);
      io.fileChange(runtimeFileForPath(linkedPath, bytes), "live");
      notifyFsWatchers("change", linkedPath);
      notifyWatchFileWatchers(linkedPath);
    }
  };
  const createEventTarget = () => {
    const listeners = /* @__PURE__ */ new Map();
    const listenerTarget = (listener) => listener.listener ?? listener;
    const on = (event, listener) => {
      const next = listeners.get(event) ?? [];
      next.push(listener);
      listeners.set(event, next);
    };
    const prependListener = (event, listener) => {
      const next = listeners.get(event) ?? [];
      next.unshift(listener);
      listeners.set(event, next);
    };
    const removeListener = (event, listener) => {
      const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener && listenerTarget(candidate) !== listener);
      if (next.length === 0) listeners.delete(event);
      else listeners.set(event, next);
    };
    const once = (event, listener, prepend = false) => {
      const wrapped = (...args) => {
        removeListener(event, wrapped);
        listener(...args);
      };
      Object.defineProperty(wrapped, "listener", { value: listener });
      if (prepend) prependListener(event, wrapped);
      else on(event, wrapped);
    };
    return {
      emit: (event, ...args) => {
        const current = listeners.get(event) ?? [];
        for (const listener of current) listener(...args);
        return current.length > 0;
      },
      on,
      addListener: on,
      prependListener,
      removeListener,
      off: removeListener,
      once: (event, listener) => once(event, listener),
      prependOnceListener: (event, listener) => once(event, listener, true),
      removeAllListeners: (event) => {
        if (typeof event === "string") listeners.delete(event);
        else listeners.clear();
      },
      listenerCount: (event) => listeners.get(event)?.length ?? 0,
      listeners: (event) => (listeners.get(event) ?? []).map(listenerTarget),
      rawListeners: (event) => [...listeners.get(event) ?? []],
      eventNames: () => [...listeners.keys()]
    };
  };
  const createReadableStream = (bytes, encoding, onClose) => {
    const events = createEventTarget();
    let started = false;
    let closed = false;
    let destroyed = false;
    let ended = false;
    let offset = 0;
    let streamEncoding = encoding;
    let readableFlowing = null;
    const pipeBindings = [];
    const internalCloseListeners = /* @__PURE__ */ new Set();
    const closeStream = () => {
      if (closed) return;
      closed = true;
      onClose?.();
      for (const listener of internalCloseListeners) listener();
      internalCloseListeners.clear();
      events.emit("close");
    };
    const formatChunk = (chunk) => {
      const buffer = BrowserBuffer.from(chunk);
      return streamEncoding ? buffer.toString(streamEncoding) : buffer;
    };
    const readChunk = (size) => {
      if (destroyed || offset >= bytes.byteLength) {
        ended = offset >= bytes.byteLength;
        return null;
      }
      const requested = typeof size === "number" && size >= 0 ? Math.floor(size) : bytes.byteLength - offset;
      const end = Math.min(bytes.byteLength, offset + requested);
      const chunk = bytes.slice(offset, end);
      offset = end;
      if (offset >= bytes.byteLength) ended = true;
      return formatChunk(chunk);
    };
    const scheduleRead = () => {
      if (started) return;
      if (readableFlowing === false) return;
      started = true;
      queueMicrotask(() => {
        if (closed || destroyed) return;
        if (readableFlowing === false) {
          started = false;
          return;
        }
        const chunk = readChunk();
        if (chunk !== null && (typeof chunk !== "string" || chunk.length > 0) && (!(chunk instanceof Uint8Array) || chunk.byteLength > 0)) {
          events.emit("data", chunk);
        }
        events.emit("end");
        closeStream();
      });
    };
    const stream = {
      readable: true,
      get closed() {
        return closed;
      },
      get destroyed() {
        return destroyed;
      },
      get readableEnded() {
        return ended;
      },
      get readableEncoding() {
        return streamEncoding ?? null;
      },
      get readableLength() {
        return Math.max(0, bytes.byteLength - offset);
      },
      get readableFlowing() {
        return readableFlowing;
      },
      setEncoding: (nextEncoding) => {
        streamEncoding = nextEncoding;
        return stream;
      },
      read: (size) => readChunk(size),
      on: (event, listener) => {
        events.on(event, listener);
        if (event === "data") {
          if (readableFlowing === null) readableFlowing = true;
          scheduleRead();
        } else if (event === "end") {
          scheduleRead();
        }
        return stream;
      },
      addListener: (event, listener) => {
        stream.on(event, listener);
        return stream;
      },
      prependListener: (event, listener) => {
        events.prependListener(event, listener);
        if (event === "data") {
          if (readableFlowing === null) readableFlowing = true;
          scheduleRead();
        } else if (event === "end") {
          scheduleRead();
        }
        return stream;
      },
      removeListener: (event, listener) => {
        events.removeListener(event, listener);
        return stream;
      },
      off: (event, listener) => {
        events.off(event, listener);
        return stream;
      },
      emit: (event, ...args) => events.emit(event, ...args),
      once: (event, listener) => {
        events.once(event, listener);
        if (event === "data") {
          if (readableFlowing === null) readableFlowing = true;
          scheduleRead();
        } else if (event === "end") {
          scheduleRead();
        }
        return stream;
      },
      prependOnceListener: (event, listener) => {
        events.prependOnceListener(event, listener);
        if (event === "data") {
          if (readableFlowing === null) readableFlowing = true;
          scheduleRead();
        } else if (event === "end") {
          scheduleRead();
        }
        return stream;
      },
      removeAllListeners: (event) => {
        events.removeAllListeners(event);
        return stream;
      },
      listenerCount: (event) => events.listenerCount(event),
      listeners: (event) => events.listeners(event),
      rawListeners: (event) => events.rawListeners(event),
      eventNames: () => events.eventNames(),
      pause: () => {
        readableFlowing = false;
        return stream;
      },
      resume: () => {
        readableFlowing = true;
        scheduleRead();
        return stream;
      },
      destroy: (error) => {
        if (destroyed) return stream;
        destroyed = true;
        if (error) events.emit("error", error);
        closeStream();
        return stream;
      },
      close: (callback) => {
        if (callback) stream.once("close", callback);
        closeStream();
        return stream;
      },
      pipe: (destination, options) => {
        const onData = (chunk) => destination.write?.(chunk);
        const onEnd = () => {
          if (options?.end !== false) destination.end?.();
        };
        pipeBindings.push({ destination, onData, onEnd });
        events.on("data", onData);
        events.on("end", onEnd);
        destination.emit?.("pipe", stream);
        readableFlowing = true;
        scheduleRead();
        return destination;
      },
      unpipe: (destination) => {
        for (let index = pipeBindings.length - 1; index >= 0; index -= 1) {
          const binding = pipeBindings[index];
          if (!destination || binding.destination === destination) {
            events.removeListener("data", binding.onData);
            events.removeListener("end", binding.onEnd);
            binding.destination.emit?.("unpipe", stream);
            pipeBindings.splice(index, 1);
          }
        }
        return stream;
      }
    };
    setStreamInternalCloseListeners(stream, internalCloseListeners);
    return stream;
  };
  const createWritableStream = (path, options) => {
    const events = createEventTarget();
    const optionFd = typeof options === "object" && typeof options?.fd === "number" ? options.fd : null;
    const encoding = requestedEncodingFromOptions(options);
    const flags = typeof options === "object" && typeof options?.flags === "string" ? options.flags : "w";
    const parsed = parseOpenFlags(flags);
    const openTarget = optionFd === null ? runtimeOpenTarget(path, {
      ...parsed,
      writable: parsed.writable,
      create: parsed.create,
      truncate: parsed.truncate
    }, kernelDevices, procSnapshot) : null;
    if (openTarget?.kind === "error") {
      throw Object.assign(new Error(runtimeKernelOpenErrorMessage(String(path), openTarget)), {
        code: runtimeKernelOpenErrorCode(openTarget.reason)
      });
    }
    const device = openTarget?.kind === "device" ? openTarget.device : null;
    const autoClose = typeof options === "object" && options?.autoClose === false ? false : true;
    if (executionState.kernelFileSystem && optionFd === null && (openTarget === null || openTarget?.kind === "workspace")) {
      const openedFd = fsApiBridge.openSync(path, flags);
      return createWritableStream(null, {
        ...typeof options === "object" && options ? options : {},
        fd: openedFd,
        flags,
        autoClose
      });
    }
    const rawNormalized = device || optionFd !== null ? null : assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
    const normalized = rawNormalized === null ? null : resolveStoredSymlinkPath(rawNormalized);
    if (normalized !== null) {
      assertWorkspaceFileWritePath(normalized, path, "write");
      if (parsed.exclusive && rawNormalized !== null && (fileStore.has(rawNormalized) || symlinkStore.has(rawNormalized) || directoryStore.has(rawNormalized))) {
        throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST" });
      }
      if (!parsed.create && !fileStore.has(normalized)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
      }
    }
    if (normalized !== null && parsed.truncate) {
      setFileBytes(normalized, new Uint8Array());
    }
    let closed = false;
    let destroyed = false;
    let bytesWritten = 0;
    let writableEnded = false;
    let writableFinished = false;
    let writableCorked = 0;
    let writeOffset = typeof options === "object" && typeof options?.start === "number" ? Math.max(0, options.start) : 0;
    const hasExplicitWriteStart = typeof options === "object" && typeof options?.start === "number";
    const internalCloseListeners = /* @__PURE__ */ new Set();
    const writeBytes = (value, writeEncoding) => {
      if (writableEnded) {
        throw Object.assign(new Error("ERR_STREAM_WRITE_AFTER_END: write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
      }
      if (closed || destroyed) {
        throw Object.assign(new Error("ERR_STREAM_DESTROYED: Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" });
      }
      const bytes = bytesFromFsWriteValue(value, writeEncoding ?? encoding);
      if (optionFd !== null) {
        if (hasExplicitWriteStart) {
          writeDescriptorBytes(fileDescriptor(optionFd), bytes, writeOffset);
          writeOffset += bytes.byteLength;
        } else {
          writeDescriptorFileBytes(optionFd, bytes, flags.includes("a"));
        }
        bytesWritten += bytes.byteLength;
        return bytes.byteLength;
      }
      if (device) {
        writeDevice(device, textFromBytes(bytes));
        bytesWritten += bytes.byteLength;
        return bytes.byteLength;
      }
      if (!parsed.writable) {
        throw Object.assign(new Error("EBADF: bad file descriptor, write"), { code: "EBADF" });
      }
      const previous = fileStore.get(normalized ?? "") ?? new Uint8Array();
      const start = parsed.append ? previous.byteLength : writeOffset;
      const next = new Uint8Array(Math.max(previous.byteLength, start + bytes.byteLength));
      next.set(previous, 0);
      next.set(bytes, start);
      setFileBytes(normalized ?? "", next);
      writeOffset = start + bytes.byteLength;
      bytesWritten += bytes.byteLength;
      return bytes.byteLength;
    };
    const closeStream = (emitFinish, done, error) => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => {
        if (error) events.emit("error", error);
        done?.();
        if (autoClose && optionFd !== null) fsApiBridge.closeSync(optionFd);
        for (const listener of internalCloseListeners) listener();
        internalCloseListeners.clear();
        if (emitFinish) {
          writableFinished = true;
          events.emit("finish");
        }
        events.emit("close");
      });
    };
    const stream = {
      writable: true,
      get closed() {
        return closed;
      },
      get destroyed() {
        return destroyed;
      },
      get bytesWritten() {
        return bytesWritten;
      },
      get writableEnded() {
        return writableEnded;
      },
      get writableFinished() {
        return writableFinished;
      },
      get writableLength() {
        return 0;
      },
      get writableNeedDrain() {
        return false;
      },
      get writableCorked() {
        return writableCorked;
      },
      on: (event, listener) => {
        events.on(event, listener);
        return stream;
      },
      addListener: (event, listener) => {
        stream.on(event, listener);
        return stream;
      },
      prependListener: (event, listener) => {
        events.prependListener(event, listener);
        return stream;
      },
      removeListener: (event, listener) => {
        events.removeListener(event, listener);
        return stream;
      },
      off: (event, listener) => {
        events.off(event, listener);
        return stream;
      },
      emit: (event, ...args) => events.emit(event, ...args),
      once: (event, listener) => {
        events.once(event, listener);
        return stream;
      },
      prependOnceListener: (event, listener) => {
        events.prependOnceListener(event, listener);
        return stream;
      },
      removeAllListeners: (event) => {
        events.removeAllListeners(event);
        return stream;
      },
      listenerCount: (event) => events.listenerCount(event),
      listeners: (event) => events.listeners(event),
      rawListeners: (event) => events.rawListeners(event),
      eventNames: () => events.eventNames(),
      cork: () => {
        writableCorked += 1;
      },
      uncork: () => {
        writableCorked = Math.max(0, writableCorked - 1);
      },
      write: (value, writeEncoding, callback) => {
        const done = typeof writeEncoding === "function" ? writeEncoding : callback;
        try {
          writeBytes(value, typeof writeEncoding === "string" ? writeEncoding : void 0);
          done?.(null);
          return true;
        } catch (error) {
          const streamError = error;
          done?.(streamError);
          events.emit("error", streamError);
          return false;
        }
      },
      end: (value, writeEncoding, callback) => {
        const done = typeof writeEncoding === "function" ? writeEncoding : callback;
        if (value !== void 0 && value !== null) {
          try {
            writeBytes(value, typeof writeEncoding === "string" ? writeEncoding : void 0);
          } catch (error) {
            writableEnded = true;
            closeStream(false, void 0, error);
            return stream;
          }
        }
        writableEnded = true;
        closeStream(true, done);
        return stream;
      },
      destroy: (error) => {
        if (destroyed) return stream;
        destroyed = true;
        closeStream(false, void 0, error);
        return stream;
      },
      close: (callback) => {
        if (callback) stream.once("close", callback);
        closeStream(false);
        return stream;
      }
    };
    setStreamInternalCloseListeners(stream, internalCloseListeners);
    return stream;
  };
  const assertStreamRangeInteger = (name, value) => {
    if (value === void 0) return void 0;
    if (!Number.isInteger(value) || Number(value) < 0) {
      throw Object.assign(new RangeError(`The value of "${name}" is out of range.`), { code: "ERR_OUT_OF_RANGE" });
    }
    return Number(value);
  };
  const deleteFile = (path) => {
    const removeTarget = runtimeRemoveTarget(path, kernelDevices);
    if (removeTarget?.kind === "error") {
      const message = removeTarget.reason === "device-not-found" ? `ENOENT: no such file or directory, unlink '${path}'` : `EROFS: read-only file system, unlink '${path}'`;
      throwRuntimeRemoveTargetError(removeTarget, message);
    }
    const normalized = resolveWorkspaceEntryPath(path, false);
    if (executionState.kernelFileSystem) {
      executionState.kernelFileSystem.unlink(normalized);
      return;
    }
    assertReadonlyFilePath(normalized, "delete");
    if (symlinkStore.delete(normalized)) {
      deleteEntryMetadata(normalized);
      io.fileChange({ path: normalized, deleted: true }, "live");
      notifyFsWatchers("rename", normalized);
      notifyWatchFileWatchers(normalized);
      return;
    }
    if (!fileStore.delete(normalized)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, unlink '${path}'`), { code: "ENOENT" });
    }
    detachOpenFileDescriptorsForPath(normalized);
    unlinkPathFromHardLinks(normalized);
    modules.delete(normalized);
    cache.delete(normalized);
    deleteEntryMetadata(normalized);
    io.fileChange({ path: normalized, deleted: true }, "live");
    notifyFsWatchers("rename", normalized);
    notifyWatchFileWatchers(normalized);
  };
  const fsConstants = {
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_RDWR: 2,
    O_CREAT: 64,
    O_EXCL: 128,
    O_TRUNC: 512,
    O_APPEND: 1024,
    O_CLOEXEC: 524288,
    S_IFMT: 61440,
    S_IFREG: 32768,
    S_IFDIR: 16384,
    S_IFLNK: 40960,
    COPYFILE_EXCL: 1,
    COPYFILE_FICLONE: 2,
    COPYFILE_FICLONE_FORCE: 4
  };
  let mkdtempCounter = 0;
  const fileSystemEntryExists = (path) => {
    const accessTarget = runtimeAccessTarget(path, fsConstants.F_OK, kernelDevices, procSnapshot);
    if (accessTarget?.kind === "allowed") return true;
    if (accessTarget?.kind === "denied") return false;
    const readTarget = runtimeReadTarget(path, kernelDevices, procSnapshot);
    if (readTarget?.kind === "device-file" || readTarget?.kind === "device-directory" || readTarget?.kind === "proc-file" || readTarget?.kind === "proc-directory") {
      return true;
    }
    if (readTarget?.kind === "error") return false;
    const normalized = resolveWorkspaceEntryPath(path);
    if (executionState.kernelFileSystem) {
      try {
        executionState.kernelFileSystem.stat(normalized);
        return true;
      } catch {
        return false;
      }
    }
    const prefix = normalized ? `${normalized}/` : "";
    return fileStore.has(normalized) || directoryStore.has(normalized) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix));
  };
  const isWorkspaceDirectoryPath = (normalized) => {
    const prefix = normalized ? `${normalized}/` : "";
    return directoryStore.has(normalized) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix));
  };
  const workspaceFileAncestor = (normalized) => {
    const parts = normalized.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directoryPath = parts.slice(0, index).join("/");
      if (fileStore.has(directoryPath)) return directoryPath;
      if (symlinkStore.has(directoryPath)) {
        const resolved = resolveStoredSymlinkPath(directoryPath);
        if (fileStore.has(resolved)) return directoryPath;
      }
    }
    return null;
  };
  const assertWorkspaceParentDirectoryPath = (normalized, path, syscall) => {
    if (workspaceFileAncestor(normalized) !== null) {
      throw Object.assign(new Error(`ENOTDIR: not a directory, ${syscall} '${path}'`), { code: "ENOTDIR" });
    }
    const parent = dirname(normalized);
    const parentPath = parent === "" ? "" : resolveStoredSymlinkPath(parent);
    if (parentPath && !directoryStore.has(parentPath)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), { code: "ENOENT" });
    }
  };
  const assertWorkspaceFileWritePath = (normalized, path, operation, syscall = operation) => {
    if (!normalized) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, ${syscall} '${path}'`), { code: "EISDIR" });
    }
    assertReadonlyFilePath(normalized, operation);
    assertWorkspaceParentDirectoryPath(normalized, path, syscall);
    if (isWorkspaceDirectoryPath(normalized)) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, ${syscall} '${path}'`), { code: "EISDIR" });
    }
  };
  const assertFileSystemAccess = (path, mode = fsConstants.F_OK) => {
    const requested = Number(mode) || fsConstants.F_OK;
    const accessTarget = runtimeAccessTarget(path, requested, kernelDevices, procSnapshot);
    if (accessTarget?.kind === "allowed") return;
    if (accessTarget?.kind === "denied") {
      const code = accessTarget.reason === "not-found" ? "ENOENT" : "EACCES";
      const reason = accessTarget.reason === "not-found" ? "no such file or directory" : "permission denied";
      throw Object.assign(new Error(`${code}: ${reason}, access '${path}'`), { code });
    }
    const normalized = resolveWorkspaceEntryPath(path);
    let stats;
    if (executionState.kernelFileSystem) {
      stats = statForTraceKernelPath(
        executionState.kernelFileSystem.stat(normalized)
      );
    } else {
      if (workspaceFileAncestor(normalized) !== null) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, access '${path}'`), { code: "ENOTDIR" });
      }
      stats = statForNormalizedPath(normalized);
    }
    if (!stats) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), { code: "ENOENT" });
    }
    const permissionMode = stats.mode & 511;
    const readable = (permissionMode & 292) !== 0;
    const writable = (permissionMode & 146) !== 0;
    const executable = (permissionMode & 73) !== 0;
    if ((requested & fsConstants.R_OK) !== 0 && !readable || (requested & fsConstants.W_OK) !== 0 && !writable || (requested & fsConstants.X_OK) !== 0 && !executable) {
      throw Object.assign(new Error(`EACCES: permission denied, access '${path}'`), { code: "EACCES" });
    }
  };
  const notifyMetadataMutation = (path) => {
    const bytes = fileStore.get(path);
    const metadata = entryMetadata.get(path);
    if (bytes && metadata) {
      io.fileChange({
        ...bytesToRuntimeFile(path, bytes),
        ...metadata.mode !== void 0 ? { mode: metadata.mode & 4095 } : {},
        atimeMs: metadata.atimeMs,
        mtimeMs: metadata.mtimeMs
      }, "live");
    } else if (directoryStore.has(path) && metadata && path !== "") {
      io.fileChange({
        path,
        directory: true,
        ...metadata.mode !== void 0 ? { mode: metadata.mode & 4095 } : {},
        atimeMs: metadata.atimeMs,
        mtimeMs: metadata.mtimeMs
      }, "live");
    }
    notifyFsWatchers("change", path);
    notifyWatchFileWatchers(path);
  };
  const metadataPathForEntry = (path) => {
    const metadataTarget = runtimeMetadataTarget(path, kernelDevices);
    if (metadataTarget?.kind === "ignored-device") return null;
    if (metadataTarget?.kind === "error") {
      const message = metadataTarget.reason === "proc-read-only" ? `EROFS: read-only file system, metadata '${path}'` : `ENOENT: no such file or directory, metadata '${path}'`;
      throwRuntimeMetadataTargetError(metadataTarget, message);
    }
    const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
    if (executionState.kernelFileSystem) {
      return executionState.kernelFileSystem.realpath(normalized);
    }
    if (workspaceFileAncestor(normalized) !== null) {
      throw Object.assign(new Error(`ENOTDIR: not a directory, metadata '${path}'`), { code: "ENOTDIR" });
    }
    if (!fileSystemEntryExists(workspaceFilename(normalized, workspaceRoot))) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
    }
    return normalized;
  };
  const timeToMs = (value) => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return Math.max(0, value * 1e3);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed * 1e3) : requestState.fsTimestampMs;
  };
  const stdioDescriptor = (device, append = false) => ({
    kind: "device",
    device,
    offset: 0,
    readable: runtimeKernelDeviceInputSource(kernelDevices, device) !== null,
    writable: runtimeKernelDeviceOutputTarget(kernelDevices, device) !== null,
    append
  });
  const fileDescriptors = /* @__PURE__ */ new Map([
    [0, stdioDescriptor("/dev/stdin")],
    [1, stdioDescriptor("/dev/stdout", true)],
    [2, stdioDescriptor("/dev/stderr", true)]
  ]);
  for (const inheritedFd of request.process?.descriptors ?? []) {
    const fd2 = Math.floor(Number(inheritedFd));
    if (!Number.isSafeInteger(fd2) || fd2 < 3 || fileDescriptors.has(fd2)) {
      continue;
    }
    fileDescriptors.set(fd2, {
      kind: "kernel",
      kernelFd: fd2,
      offset: 0,
      // The descriptor table remains authoritative for access mode and
      // operation support. The compatibility map must not guess a narrower
      // capability and reject an inherited pipe/socket/file before syscall.
      readable: true,
      writable: true,
      append: false
    });
  }
  let nextFd = 3;
  const workspaceFileDescriptorRecords = () => [...fileDescriptors.values()].filter((entry) => entry.kind === "file");
  const detachOpenFileDescriptorsForPath = (path) => {
    const bytes = fileStore.get(path);
    for (const entry of workspaceFileDescriptorRecords()) {
      if (entry.path !== path) continue;
      entry.bytes = new Uint8Array(bytes ?? entry.bytes ?? new Uint8Array());
      entry.path = void 0;
    }
  };
  const moveOpenFileDescriptorPath = (oldPath, newPath) => {
    for (const entry of workspaceFileDescriptorRecords()) {
      if (entry.path === oldPath) entry.path = newPath;
    }
  };
  const parseOpenFlags = (flags = "r") => {
    if (typeof flags === "number") {
      const access = flags & 3;
      const create2 = (flags & 64) !== 0;
      return {
        readable: access === 0 || access === 2,
        writable: access === 1 || access === 2,
        append: (flags & 1024) !== 0,
        truncate: (flags & 512) !== 0,
        create: create2,
        exclusive: create2 && (flags & 128) !== 0
      };
    }
    const text = String(flags);
    const create = text.startsWith("w") || text.startsWith("a");
    return {
      readable: text.includes("+") || text.startsWith("r"),
      writable: text.includes("+") || create,
      append: text.startsWith("a"),
      truncate: text.startsWith("w"),
      create,
      exclusive: create && text.includes("x")
    };
  };
  const fileDescriptor = (fd2) => {
    const entry = fileDescriptors.get(Number(fd2));
    if (!entry) throw Object.assign(new Error(`EBADF: bad file descriptor, fd ${fd2}`), { code: "EBADF" });
    return entry;
  };
  const descriptorMetadataPath = (fd2, operation) => {
    const entry = fileDescriptor(fd2);
    if (entry.kind === "kernel") {
      throw Object.assign(
        new Error(`ENOSYS: ${operation} is not yet available for TraceKernel descriptors`),
        { code: "ENOSYS" }
      );
    }
    if (entry.kind === "file" && !entry.path) return null;
    const path = entry.kind === "device" ? entry.device ?? "/dev/stdin" : entry.path ?? "";
    const metadataTarget = runtimeKernelMetadataTarget(path, kernelDevices);
    if (metadataTarget.kind === "ignored-device") return null;
    if (metadataTarget.kind === "error") {
      const message = metadataTarget.reason === "proc-read-only" ? `EROFS: read-only file system, ${operation}` : `ENOENT: no such file or directory, ${operation}`;
      throwRuntimeMetadataTargetError(metadataTarget, message);
    }
    return path;
  };
  const descriptorBytes = (entry) => {
    if (entry.kind === "kernel") {
      const kernelFs = executionState.kernelFileSystem;
      const kernelFd = entry.kernelFd;
      const size = kernelFs.fstat(kernelFd).size;
      const chunks = [];
      let offset = 0;
      while (offset < size) {
        const chunk = kernelFs.read(kernelFd, Math.min(256 * 1024, size - offset), offset);
        if (chunk.byteLength === 0) break;
        chunks.push(chunk);
        offset += chunk.byteLength;
      }
      const bytes = new Uint8Array(offset);
      let cursor = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, cursor);
        cursor += chunk.byteLength;
      }
      return bytes;
    }
    if (entry.kind === "device") return utf8Bytes(readDevice(entry.device ?? "/dev/stdin"));
    if (entry.kind === "proc") return utf8Bytes(browserProcFileContents(procSnapshot, entry.path ?? "", kernelInfo));
    if (entry.kind === "directory") {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${entry.path ?? ""}'`), { code: "EISDIR" });
    }
    if (entry.path && fileStore.has(entry.path)) return fileStore.get(entry.path) ?? new Uint8Array();
    return entry.bytes ?? new Uint8Array();
  };
  const readDescriptorFileBytes = (fd2) => {
    const entry = fileDescriptor(fd2);
    if (!entry.readable) throw Object.assign(new Error("EBADF: bad file descriptor, read"), { code: "EBADF" });
    if (entry.kind === "kernel") {
      const chunks = [];
      let length = 0;
      while (true) {
        const chunk = executionState.kernelFileSystem.read(entry.kernelFd, 256 * 1024);
        if (chunk.byteLength === 0) break;
        chunks.push(chunk);
        length += chunk.byteLength;
      }
      const bytes2 = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes2.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes2;
    }
    if (entry.kind === "device") return readDeviceBytes(entry.device ?? "/dev/stdin");
    const source = descriptorBytes(entry);
    const start = entry.offset;
    const bytes = source.slice(start);
    entry.offset = source.byteLength;
    return bytes;
  };
  const writeDescriptorBytes = (entry, bytes, position) => {
    if (!entry.writable) throw Object.assign(new Error("EBADF: bad file descriptor, write"), { code: "EBADF" });
    if (entry.kind === "kernel") {
      executionState.kernelFileSystem.write(
        entry.kernelFd,
        bytes,
        typeof position === "number" ? Math.max(0, position) : void 0
      );
      return;
    }
    if (entry.kind === "device") {
      writeDevice(entry.device ?? "/dev/stdout", textFromBytes(bytes));
      return;
    }
    if (entry.kind === "proc") {
      throw Object.assign(new Error(`EROFS: read-only file system, write '${entry.path ?? "/proc"}'`), { code: "EROFS" });
    }
    const previous = descriptorBytes(entry);
    const start = entry.append ? previous.byteLength : typeof position === "number" ? Math.max(0, position) : entry.offset;
    const next = new Uint8Array(Math.max(previous.byteLength, start + bytes.byteLength));
    next.set(previous, 0);
    next.set(bytes, start);
    entry.bytes = next;
    if (entry.path && fileStore.has(entry.path)) setFileBytes(entry.path, next);
    if (entry.append || position === void 0 || position === null) entry.offset = start + bytes.byteLength;
  };
  const writeDescriptorFileBytes = (fd2, bytes, append = false) => {
    const entry = fileDescriptor(fd2);
    const position = append && entry.kind !== "device" ? descriptorBytes(entry).byteLength : null;
    writeDescriptorBytes(entry, bytes, position);
    if (append && entry.kind !== "device" && typeof position === "number") entry.offset = position + bytes.byteLength;
  };
  const truncateFileBytes = (path, length = 0) => {
    const previous = fileStore.get(path);
    if (!previous) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, truncate '${path}'`), { code: "ENOENT" });
    }
    const size = Math.max(0, Number(length) || 0);
    const next = new Uint8Array(size);
    next.set(previous.slice(0, Math.min(previous.byteLength, size)));
    setFileBytes(path, next);
  };
  const truncateDescriptorBytes = (entry, length = 0) => {
    if (entry.kind === "kernel") {
      executionState.kernelFileSystem.ftruncate(
        entry.kernelFd,
        Math.max(0, Number(length) || 0)
      );
      return;
    }
    if (entry.kind !== "file") {
      if (entry.kind === "device") throw Object.assign(new Error("EINVAL: invalid argument, ftruncate"), { code: "EINVAL" });
      throw Object.assign(new Error(`EROFS: read-only file system, ftruncate '${entry.path ?? ""}'`), { code: "EROFS" });
    }
    const previous = descriptorBytes(entry);
    const size = Math.max(0, Number(length) || 0);
    const next = new Uint8Array(size);
    next.set(previous.slice(0, Math.min(previous.byteLength, size)));
    entry.bytes = next;
    if (entry.path && fileStore.has(entry.path)) setFileBytes(entry.path, next);
    if (entry.offset > size) entry.offset = size;
  };
  const realpathForEntry = (path) => {
    const readTarget = runtimeReadTarget(path, kernelDevices, procSnapshot);
    if (executionState.kernelFileSystem && readTarget?.kind === "workspace") {
      const normalized2 = normalizeWorkspaceEntryPath(
        path,
        cwdPath,
        true,
        workspacePathContext
      );
      return executionState.kernelFileSystem.realpath(normalized2);
    }
    const accessTarget = runtimeAccessTarget(path, 0, kernelDevices, procSnapshot);
    if (accessTarget?.kind === "allowed" && readTarget?.kind !== "workspace") {
      return accessTarget.path;
    }
    if (accessTarget?.kind === "denied") {
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: "ENOENT" });
    }
    if (readTarget?.kind === "device-file" || readTarget?.kind === "proc-file" || readTarget?.kind === "proc-directory") {
      return readTarget.path;
    }
    if (readTarget?.kind === "device-directory") return readTarget.path;
    if (readTarget?.kind === "error") {
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: "ENOENT" });
    }
    const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
    if (workspaceFileAncestor(normalized) !== null) {
      throw Object.assign(new Error(`ENOTDIR: not a directory, realpath '${path}'`), { code: "ENOTDIR" });
    }
    if (!fileSystemEntryExists(workspaceFilename(normalized, workspaceRoot))) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: "ENOENT" });
    }
    return workspaceFilename(normalized, workspaceRoot);
  };
  const copyEntrySync = (source, destination, options = {}) => {
    const copyTarget = runtimeCopyTarget(source, destination, kernelDevices, procSnapshot);
    if (copyTarget?.kind === "file-copy") {
      fsApiBridge.copyFileSync(source, destination);
      return;
    }
    if (copyTarget?.kind === "error") {
      throw Object.assign(new Error(runtimeKernelCopyErrorMessage(String(source), String(destination), copyTarget)), {
        code: runtimeKernelCopyErrorCode(copyTarget.reason)
      });
    }
    const normalizedSource = resolveWorkspaceEntryPath(source, false);
    const normalizedDestination = resolveWorkspaceEntryPath(destination, false);
    const sourcePath = workspaceFilename(normalizedSource, workspaceRoot);
    const destinationPath = workspaceFilename(normalizedDestination, workspaceRoot);
    if (options.filter && !options.filter(sourcePath, destinationPath)) return;
    if (normalizedSource === normalizedDestination) {
      throw Object.assign(new Error(`${source} and dest cannot be the same ${destination}`), {
        code: "ERR_FS_CP_EINVAL"
      });
    }
    const sourceLinkTarget = symlinkStore.get(normalizedSource);
    if (sourceLinkTarget !== void 0) {
      if ((fileStore.has(normalizedDestination) || symlinkStore.has(normalizedDestination) || directoryStore.has(normalizedDestination)) && options.force === false) {
        if (options.errorOnExist) {
          throw Object.assign(new Error(`EEXIST: file already exists, cp '${destination}'`), { code: "EEXIST" });
        }
        return;
      }
      assertWorkspaceParentDirectoryPath(normalizedDestination, destination, "cp");
      if (directoryStore.has(normalizedDestination)) {
        throw Object.assign(new Error(`Cannot overwrite directory ${destination} with non-directory ${source}`), {
          code: "ERR_FS_CP_NON_DIR_TO_DIR"
        });
      }
      if (fileStore.has(normalizedDestination)) deleteFile(destination);
      if (symlinkStore.has(normalizedDestination)) deleteFile(destination);
      symlinkStore.set(normalizedDestination, sourceLinkTarget);
      entryMetadata.set(normalizedDestination, createEntryMetadata(41471));
      io.fileChange({ path: normalizedDestination, symlink: true, target: sourceLinkTarget }, "live");
      notifyFsWatchers("rename", normalizedDestination);
      notifyWatchFileWatchers(normalizedDestination);
      return;
    }
    const sourceBytes = fileStore.get(normalizedSource);
    if (sourceBytes) {
      if (directoryStore.has(normalizedDestination)) {
        throw Object.assign(new Error(`Cannot overwrite directory ${destination} with non-directory ${source}`), {
          code: "ERR_FS_CP_NON_DIR_TO_DIR"
        });
      }
      if (fileStore.has(normalizedDestination) && options.force === false) {
        if (options.errorOnExist) {
          throw Object.assign(new Error(`EEXIST: file already exists, cp '${destination}'`), { code: "EEXIST" });
        }
        return;
      }
      setFileBytes(normalizedDestination, new Uint8Array(sourceBytes));
      return;
    }
    const destinationExists = fileStore.has(normalizedDestination) || directoryStore.has(normalizedDestination);
    if (destinationExists && options.force === false) {
      if (options.errorOnExist) {
        throw Object.assign(new Error(`EEXIST: file already exists, cp '${destination}'`), { code: "EEXIST" });
      }
      return;
    }
    const sourcePrefix = normalizedSource ? `${normalizedSource}/` : "";
    const descendantFiles = Array.from(fileStore.entries()).filter(([filePath]) => filePath.startsWith(sourcePrefix));
    const descendantSymlinks = Array.from(symlinkStore.entries()).filter(([linkPath]) => linkPath.startsWith(sourcePrefix));
    const descendantDirectories = Array.from(directoryStore).filter(
      (directoryPath) => directoryPath === normalizedSource || directoryPath.startsWith(sourcePrefix)
    );
    if (!directoryStore.has(normalizedSource) && descendantFiles.length === 0 && descendantSymlinks.length === 0 && descendantDirectories.length === 0) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, cp '${source}' -> '${destination}'`), { code: "ENOENT" });
    }
    if (!options.recursive) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, cp '${source}'`), { code: "EISDIR" });
    }
    if (normalizedDestination.startsWith(`${normalizedSource}/`)) {
      throw Object.assign(new Error(`Cannot copy ${source}/ to a subdirectory of self ${destination}`), {
        code: "ERR_FS_CP_EINVAL"
      });
    }
    if (fileStore.has(normalizedDestination)) {
      throw Object.assign(new Error(`Cannot overwrite non-directory ${destination} with directory ${source}`), {
        code: "ERR_FS_CP_DIR_TO_NON_DIR"
      });
    }
    const destinationDirectoryExisted = directoryStore.has(normalizedDestination);
    directoryStore.add(normalizedDestination);
    if (!entryMetadata.has(normalizedDestination)) touchEntryMetadata(normalizedDestination);
    if (!destinationDirectoryExisted) emitDirectoryCreate(normalizedDestination);
    for (const directoryPath of descendantDirectories) {
      const relative = directoryPath === normalizedSource ? "" : directoryPath.slice(sourcePrefix.length);
      const nextDirectory = relative ? `${normalizedDestination}/${relative}` : normalizedDestination;
      if (options.filter && !options.filter(workspaceFilename(directoryPath, workspaceRoot), workspaceFilename(nextDirectory, workspaceRoot))) {
        continue;
      }
      const existed = directoryStore.has(nextDirectory);
      directoryStore.add(nextDirectory);
      if (!entryMetadata.has(nextDirectory)) touchEntryMetadata(nextDirectory);
      if (!existed) emitDirectoryCreate(nextDirectory);
    }
    for (const [filePath, bytes] of descendantFiles) {
      const relative = filePath.slice(sourcePrefix.length);
      const nextPath = normalizedDestination ? `${normalizedDestination}/${relative}` : relative;
      if (options.filter && !options.filter(workspaceFilename(filePath, workspaceRoot), workspaceFilename(nextPath, workspaceRoot))) {
        continue;
      }
      setFileBytes(nextPath, new Uint8Array(bytes));
    }
    for (const [linkPath, target] of descendantSymlinks) {
      const relative = linkPath.slice(sourcePrefix.length);
      const nextPath = normalizedDestination ? `${normalizedDestination}/${relative}` : relative;
      if (options.filter && !options.filter(workspaceFilename(linkPath, workspaceRoot), workspaceFilename(nextPath, workspaceRoot))) {
        continue;
      }
      symlinkStore.set(nextPath, target);
      entryMetadata.set(nextPath, createEntryMetadata(41471));
      io.fileChange({ path: nextPath, symlink: true, target }, "live");
    }
  };
  return {
    assertFileSystemAccess,
    assertReadonlyFilePath,
    assertStreamRangeInteger,
    assertWorkspaceFileWritePath,
    assertWorkspaceParentDirectoryPath,
    browserFileSystemStat,
    browserStatsResult,
    copyEntrySync,
    createReadableStream,
    createWritableStream,
    deleteFile,
    descriptorBytes,
    descriptorMetadataPath,
    emitDirectoryCreate,
    emitDirectoryDelete,
    emitFsWatch,
    fileDescriptor,
    fileDescriptors,
    fileSystemEntryExists,
    fsConstants,
    fsFileWatchers,
    fsWatchers,
    isWorkspaceDirectoryPath,
    metadataPathForEntry,
    missingFileStat,
    moveOpenFileDescriptorPath,
    notifyDirectoryMutation,
    notifyFsWatchers,
    notifyMetadataMutation,
    notifyWatchFileWatchers,
    parseOpenFlags,
    readDescriptorFileBytes,
    realpathForEntry,
    setFileBytes,
    statForKernelPath,
    statForKernelTarget,
    statForNormalizedPath,
    statForTraceKernelPath,
    timeToMs,
    truncateDescriptorBytes,
    truncateFileBytes,
    watchedFilename,
    workspaceFileAncestor,
    writeDescriptorBytes,
    writeDescriptorFileBytes,
    attachFsApi(api) {
      fsApiBridge = api;
    },
    get mkdtempCounter() {
      return mkdtempCounter;
    },
    set mkdtempCounter(value) {
      mkdtempCounter = value;
    },
    get nextFd() {
      return nextFd;
    },
    set nextFd(value) {
      nextFd = value;
    }
  };
}

// packages/runtime-javascript/src/kernel/fs-api.ts
function createBrowserFsApi(requestState, filesystemState, request, executionState) {
  const {
    assertApi,
    cache,
    childProcessApi,
    consoleApi,
    createEntryMetadata,
    cryptoApi,
    cwdPath,
    deleteEntryMetadata,
    directoryStore,
    entryMetadata,
    eventLoopApi,
    eventsApi,
    fileStore,
    hardLinkGroupForPath,
    io,
    isHiddenNamespacePath,
    kernelDevices,
    kernelInfo,
    linkPaths,
    linkedInodeForPath,
    liveIo,
    modules,
    moveHardLinkPath,
    nodePathSearchEntries,
    originalDirectoryMetadata,
    originalFiles,
    originalSymlinks,
    osApi,
    pathApi,
    procSnapshot,
    processApi,
    readDevice,
    readDeviceBytes,
    readonlyFiles,
    refreshSymlinkModuleAliases,
    requireCache,
    resolveStoredSymlinkPath,
    resolveWorkspaceEntryPath,
    runtimeFileForPath,
    stderr,
    stdout,
    streamApi,
    symlinkStore,
    syncTextModule,
    timersPromisesApi,
    touchEntryMetadata,
    traceKernelApi,
    unlinkPathFromHardLinks,
    unmodeledStorageBytes,
    unmodeledStorageEntries,
    updateEntryMetadata,
    urlApi,
    utilApi,
    virtualStorageEntries,
    workspacePathContext,
    workspaceRoot,
    writeDevice
  } = requestState;
  const {
    assertFileSystemAccess,
    assertReadonlyFilePath,
    assertStreamRangeInteger,
    assertWorkspaceFileWritePath,
    assertWorkspaceParentDirectoryPath,
    browserFileSystemStat,
    browserStatsResult,
    copyEntrySync,
    createReadableStream,
    createWritableStream,
    deleteFile,
    descriptorBytes,
    descriptorMetadataPath,
    emitDirectoryCreate,
    emitDirectoryDelete,
    emitFsWatch,
    fileDescriptor,
    fileDescriptors,
    fileSystemEntryExists,
    fsConstants,
    fsFileWatchers,
    fsWatchers,
    isWorkspaceDirectoryPath,
    metadataPathForEntry,
    missingFileStat,
    moveOpenFileDescriptorPath,
    notifyDirectoryMutation,
    notifyFsWatchers,
    notifyMetadataMutation,
    notifyWatchFileWatchers,
    parseOpenFlags,
    readDescriptorFileBytes,
    realpathForEntry,
    setFileBytes,
    statForKernelPath,
    statForKernelTarget,
    statForNormalizedPath,
    statForTraceKernelPath,
    timeToMs,
    truncateDescriptorBytes,
    truncateFileBytes,
    watchedFilename,
    workspaceFileAncestor,
    writeDescriptorBytes,
    writeDescriptorFileBytes
  } = filesystemState;
  const fsApi = {
    constants: fsConstants,
    F_OK: fsConstants.F_OK,
    R_OK: fsConstants.R_OK,
    W_OK: fsConstants.W_OK,
    X_OK: fsConstants.X_OK,
    O_RDONLY: fsConstants.O_RDONLY,
    O_WRONLY: fsConstants.O_WRONLY,
    O_RDWR: fsConstants.O_RDWR,
    O_CREAT: fsConstants.O_CREAT,
    O_EXCL: fsConstants.O_EXCL,
    O_TRUNC: fsConstants.O_TRUNC,
    O_APPEND: fsConstants.O_APPEND,
    S_IFMT: fsConstants.S_IFMT,
    S_IFREG: fsConstants.S_IFREG,
    S_IFDIR: fsConstants.S_IFDIR,
    S_IFLNK: fsConstants.S_IFLNK,
    COPYFILE_EXCL: fsConstants.COPYFILE_EXCL,
    COPYFILE_FICLONE: fsConstants.COPYFILE_FICLONE,
    COPYFILE_FICLONE_FORCE: fsConstants.COPYFILE_FICLONE_FORCE,
    accessSync: (path, mode = fsConstants.F_OK) => {
      assertFileSystemAccess(path, mode);
    },
    access: (path, mode, callback) => {
      const done = typeof mode === "function" ? mode : callback;
      try {
        assertFileSystemAccess(path, typeof mode === "number" ? mode : fsConstants.F_OK);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    chmodSync: (path, mode) => {
      const normalized = metadataPathForEntry(path);
      if (normalized !== null) {
        const stats = statForNormalizedPath(normalized);
        const typeMode = stats?.isDirectory() ? 16384 : 32768;
        updateEntryMetadata(normalized, { mode: typeMode | Number(mode) & 4095 });
        notifyMetadataMutation(normalized);
      }
      return void 0;
    },
    chmod: (path, mode, callback) => {
      try {
        fsApi.chmodSync(path, mode);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    chownSync: (path, uid, gid) => {
      const normalized = metadataPathForEntry(path);
      if (normalized !== null) {
        if (Number(uid) !== 1e3 || Number(gid) !== 1e3) {
          throw Object.assign(new Error(`EPERM: operation not permitted, chown '${path}'`), { code: "EPERM" });
        }
      }
      return void 0;
    },
    chown: (path, uid, gid, callback) => {
      try {
        fsApi.chownSync(path, uid, gid);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    utimesSync: (path, atime, mtime) => {
      const normalized = metadataPathForEntry(path);
      if (normalized !== null) {
        updateEntryMetadata(normalized, { atimeMs: timeToMs(atime), mtimeMs: timeToMs(mtime) });
        notifyMetadataMutation(normalized);
      }
      return void 0;
    },
    utimes: (path, atime, mtime, callback) => {
      try {
        fsApi.utimesSync(path, atime, mtime);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    watch: (path, optionsOrListener, listener) => {
      assertFileSystemAccess(path);
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      const listeners = /* @__PURE__ */ new Map();
      const on = (event, callback) => {
        const next = listeners.get(event) ?? [];
        next.push(callback);
        listeners.set(event, next);
      };
      const watcher = {
        path: normalized,
        recursive: typeof optionsOrListener === "object" && optionsOrListener?.recursive === true,
        closed: false,
        listeners
      };
      if (executionState.kernelSyscalls && executionState.kernelNetwork) {
        const watched = executionState.kernelSyscalls.dispatchSync({
          op: "watch",
          path: normalized,
          options: {
            recursive: watcher.recursive
          }
        });
        if (watched.ok === false || watched.value.op !== "watch") {
          const failure = watched.ok === true ? { code: "EPROTO", message: "EPROTO: invalid watch syscall response" } : watched.error;
          throw Object.assign(new Error(failure.message), {
            code: failure.code
          });
        }
        watcher.kernelFd = watched.value.fd;
        void eventLoopApi.track((async () => {
          try {
            while (!watcher.closed) {
              const read = await dispatchBrowserNetworkSyscall(
                executionState.kernelNetwork,
                {
                  op: "read",
                  fd: watcher.kernelFd,
                  maxBytes: 16 * 1024 + 9
                }
              );
              if (read.bytes.byteLength === 0) break;
              const event = decodeTraceKernelWatchEvent(read.bytes);
              if (event.eventType === "overflow") {
                const error = Object.assign(
                  new Error("ENOSPC: TraceKernel filesystem watch queue overflow"),
                  { code: "ENOSPC" }
                );
                for (const errorListener of listeners.get("error") ?? []) {
                  errorListener(error);
                }
                continue;
              }
              const changedPath = workspaceRelativeFromAbsolutePath(
                event.path,
                workspacePathContext
              ) ?? event.path;
              const filename = watchedFilename(watcher, changedPath);
              if (filename !== null) {
                emitFsWatch(watcher, event.eventType, filename);
                notifyWatchFileWatchers(changedPath);
              }
            }
          } catch (error) {
            if (!watcher.closed) {
              const errorListeners = listeners.get("error") ?? [];
              if (errorListeners.length === 0) throw error;
              for (const errorListener of errorListeners) errorListener(error);
            }
          }
        })());
      }
      const initialListener = typeof optionsOrListener === "function" ? optionsOrListener : listener;
      if (initialListener) on("change", initialListener);
      fsWatchers.add(watcher);
      const api = {
        on: (event, callback) => {
          on(event, callback);
          return api;
        },
        once: (event, callback) => {
          const wrapped = (...args) => {
            const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped);
            listeners.set(event, next);
            callback(...args);
          };
          on(event, wrapped);
          return api;
        },
        close: () => {
          if (watcher.closed) return;
          watcher.closed = true;
          fsWatchers.delete(watcher);
          if (watcher.kernelFd !== void 0 && executionState.kernelSyscalls) {
            executionState.kernelSyscalls.dispatchSync({
              op: "close",
              fd: watcher.kernelFd
            });
          }
          for (const closeListener of listeners.get("close") ?? []) closeListener();
        }
      };
      return api;
    },
    watchFile: (path, optionsOrListener, listener) => {
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      const changeListener = typeof optionsOrListener === "function" ? optionsOrListener : listener;
      if (!changeListener) {
        throw new TypeError('The "listener" argument must be of type function');
      }
      const watcher = {
        path: normalized,
        listener: changeListener,
        previous: statForNormalizedPath(normalized) ?? missingFileStat()
      };
      fsFileWatchers.add(watcher);
      const api = {
        ref: () => api,
        unref: () => api,
        close: () => {
          fsFileWatchers.delete(watcher);
        },
        on: (_event, nextListener) => {
          if (typeof nextListener === "function") watcher.listener = nextListener;
          return api;
        },
        addListener: (_event, nextListener) => {
          if (typeof nextListener === "function") watcher.listener = nextListener;
          return api;
        },
        removeListener: () => api
      };
      return api;
    },
    unwatchFile: (path, listener) => {
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      for (const watcher of Array.from(fsFileWatchers)) {
        if (watcher.path === normalized && (!listener || watcher.listener === listener)) {
          fsFileWatchers.delete(watcher);
        }
      }
    },
    openSync: (path, flags = "r") => {
      const parsed = parseOpenFlags(flags);
      const openTarget = runtimeOpenTarget(path, parsed, kernelDevices, procSnapshot);
      const fd2 = filesystemState.nextFd++;
      if (openTarget?.kind === "error") {
        throw Object.assign(new Error(runtimeKernelOpenErrorMessage(String(path), openTarget)), {
          code: runtimeKernelOpenErrorCode(openTarget.reason)
        });
      }
      if (openTarget?.kind === "device") {
        fileDescriptors.set(fd2, {
          kind: "device",
          device: openTarget.device,
          offset: 0,
          readable: openTarget.readable,
          writable: openTarget.writable,
          append: true
        });
        return fd2;
      }
      if (openTarget?.kind === "proc-file") {
        fileDescriptors.set(fd2, {
          kind: "proc",
          path: openTarget.path,
          offset: 0,
          readable: openTarget.readable,
          writable: openTarget.writable,
          append: false
        });
        return fd2;
      }
      const rawNormalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
      const normalized = resolveStoredSymlinkPath(rawNormalized);
      if (executionState.kernelFileSystem) {
        const kernelFd = executionState.kernelFileSystem.open(normalized, {
          access: parsed.readable && parsed.writable ? "read-write" : parsed.writable ? "write" : "read",
          ...parsed.create ? { create: true } : {},
          ...parsed.exclusive ? { exclusive: true } : {},
          ...parsed.truncate ? { truncate: true } : {},
          ...parsed.append ? { append: true } : {}
        });
        executionState.kernelFileSystem.setCloseOnExec(kernelFd, true);
        fileDescriptors.set(fd2, {
          kind: "kernel",
          kernelFd,
          path: normalized,
          offset: 0,
          readable: parsed.readable,
          writable: parsed.writable,
          append: parsed.append
        });
        return fd2;
      }
      if (parsed.exclusive && (fileStore.has(rawNormalized) || symlinkStore.has(rawNormalized) || directoryStore.has(rawNormalized))) {
        throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST" });
      }
      const directoryPrefix = normalized ? `${normalized}/` : "";
      const isDirectory = directoryStore.has(normalized) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(directoryPrefix));
      if (isDirectory) {
        if (parsed.writable || parsed.create || parsed.truncate) {
          throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: "EISDIR" });
        }
        fileDescriptors.set(fd2, {
          kind: "directory",
          path: normalized,
          offset: 0,
          readable: true,
          writable: false,
          append: false
        });
        return fd2;
      }
      if (!fileStore.has(normalized)) {
        if (!parsed.create) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
        }
        assertWorkspaceFileWritePath(normalized, path, "write", "open");
        setFileBytes(normalized, new Uint8Array());
      } else if (parsed.truncate) {
        assertWorkspaceFileWritePath(normalized, path, "truncate", "open");
        setFileBytes(normalized, new Uint8Array());
      }
      fileDescriptors.set(fd2, {
        kind: "file",
        path: normalized,
        bytes: new Uint8Array(fileStore.get(normalized) ?? new Uint8Array()),
        offset: parsed.append ? fileStore.get(normalized)?.byteLength ?? 0 : 0,
        readable: parsed.readable,
        writable: parsed.writable,
        append: parsed.append
      });
      return fd2;
    },
    open: (path, flags, modeOrCallback, callback) => {
      const done = typeof flags === "function" ? flags : typeof modeOrCallback === "function" ? modeOrCallback : callback;
      const openFlags = typeof flags === "function" || flags === void 0 ? "r" : flags;
      try {
        const fd2 = fsApi.openSync(path, openFlags);
        queueMicrotask(() => done?.(null, fd2));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    closeSync: (fd2) => {
      if (Number(fd2) < 3) return void 0;
      const entry = fileDescriptors.get(Number(fd2));
      if (!entry) {
        throw Object.assign(new Error(`EBADF: bad file descriptor, close`), { code: "EBADF" });
      }
      if (entry.kind === "kernel") {
        executionState.kernelFileSystem.closeDescriptor(entry.kernelFd);
      }
      fileDescriptors.delete(Number(fd2));
      return void 0;
    },
    close: (fd2, callback) => {
      try {
        fsApi.closeSync(fd2);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    readSync: (fd2, buffer, offset = 0, length = buffer.byteLength - offset, position) => {
      const entry = fileDescriptor(fd2);
      if (!entry.readable) throw Object.assign(new Error("EBADF: bad file descriptor, read"), { code: "EBADF" });
      if (entry.kind === "kernel") {
        const count2 = Math.max(0, Math.min(length, buffer.byteLength - offset));
        const bytes = executionState.kernelFileSystem.read(
          entry.kernelFd,
          count2,
          typeof position === "number" ? Math.max(0, position) : void 0
        );
        buffer.set(bytes, offset);
        return bytes.byteLength;
      }
      if (entry.kind === "device") {
        const bytes = readDeviceBytes(entry.device ?? "/dev/stdin", Math.max(0, Math.min(length, buffer.byteLength - offset)));
        buffer.set(bytes, offset);
        return bytes.byteLength;
      }
      const source = descriptorBytes(entry);
      const start = typeof position === "number" ? Math.max(0, position) : entry.offset;
      const count = Math.max(0, Math.min(length, source.byteLength - start, buffer.byteLength - offset));
      buffer.set(source.slice(start, start + count), offset);
      if (position === void 0 || position === null) entry.offset = start + count;
      return count;
    },
    read: (fd2, buffer, offsetOrOptions, lengthOrCallback, positionOrCallback, callback) => {
      const options = typeof offsetOrOptions === "object" && offsetOrOptions !== null ? offsetOrOptions : void 0;
      const done = typeof offsetOrOptions === "function" ? offsetOrOptions : typeof lengthOrCallback === "function" ? lengthOrCallback : typeof positionOrCallback === "function" ? positionOrCallback : callback;
      const offset = options?.offset ?? (typeof offsetOrOptions === "number" ? offsetOrOptions : 0);
      const length = options?.length ?? (typeof lengthOrCallback === "number" ? lengthOrCallback : buffer.byteLength - offset);
      let position;
      if (options !== void 0) {
        position = options.position;
      } else if (typeof positionOrCallback === "number") {
        position = positionOrCallback;
      } else {
        position = null;
      }
      try {
        const bytesRead = fsApi.readSync(fd2, buffer, offset, length, position);
        queueMicrotask(() => done?.(null, bytesRead, buffer));
      } catch (error) {
        queueMicrotask(() => done?.(error, void 0, buffer));
      }
    },
    readvSync: (fd2, buffers, position) => {
      let bytesRead = 0;
      let nextPosition = typeof position === "number" ? Math.max(0, position) : position;
      for (const buffer of buffers) {
        if (buffer.byteLength === 0) continue;
        const count = fsApi.readSync(fd2, buffer, 0, buffer.byteLength, nextPosition);
        bytesRead += count;
        if (typeof nextPosition === "number") nextPosition += count;
        if (count === 0) break;
      }
      return bytesRead;
    },
    readv: (fd2, buffers, positionOrCallback, callback) => {
      const done = typeof positionOrCallback === "function" ? positionOrCallback : callback;
      const position = typeof positionOrCallback === "function" ? void 0 : positionOrCallback;
      try {
        const bytesRead = fsApi.readvSync(fd2, buffers, position);
        queueMicrotask(() => done?.(null, bytesRead, buffers));
      } catch (error) {
        queueMicrotask(() => done?.(error, void 0, buffers));
      }
    },
    writeSync: (fd2, value, offsetOrPosition, lengthOrEncoding, position) => {
      let bytes;
      let writePosition = position;
      if (typeof value === "string") {
        bytes = BrowserBuffer.from(value, typeof lengthOrEncoding === "string" ? lengthOrEncoding : void 0);
        writePosition = typeof offsetOrPosition === "number" ? offsetOrPosition : void 0;
      } else {
        const source = bytesFromNodeValue(value);
        const offset = typeof offsetOrPosition === "number" ? offsetOrPosition : 0;
        const length = typeof lengthOrEncoding === "number" ? lengthOrEncoding : source.byteLength - offset;
        bytes = source.slice(offset, offset + length);
      }
      writeDescriptorBytes(fileDescriptor(fd2), bytes, writePosition);
      return bytes.byteLength;
    },
    write: (fd2, value, offsetOrPosition, lengthOrEncoding, positionOrCallback, callback) => {
      const options = typeof offsetOrPosition === "object" && offsetOrPosition !== null ? offsetOrPosition : void 0;
      const done = typeof offsetOrPosition === "function" ? offsetOrPosition : typeof lengthOrEncoding === "function" ? lengthOrEncoding : typeof positionOrCallback === "function" ? positionOrCallback : callback;
      let writePosition;
      if (options !== void 0) {
        writePosition = options.position;
      } else if (typeof positionOrCallback === "number") {
        writePosition = positionOrCallback;
      } else if (positionOrCallback === null) {
        writePosition = null;
      }
      try {
        const written = fsApi.writeSync(
          fd2,
          value,
          options?.offset ?? (typeof offsetOrPosition === "number" ? offsetOrPosition : void 0),
          options?.length ?? options?.encoding ?? (typeof lengthOrEncoding === "number" || typeof lengthOrEncoding === "string" ? lengthOrEncoding : void 0),
          writePosition
        );
        queueMicrotask(() => done?.(null, written, value));
      } catch (error) {
        queueMicrotask(() => done?.(error, void 0, value));
      }
    },
    writevSync: (fd2, buffers, position) => {
      let bytesWritten = 0;
      let nextPosition = typeof position === "number" ? Math.max(0, position) : position;
      for (const buffer of buffers) {
        const written = fsApi.writeSync(fd2, buffer, 0, buffer.byteLength, nextPosition);
        bytesWritten += written;
        if (typeof nextPosition === "number") nextPosition += written;
      }
      return bytesWritten;
    },
    writev: (fd2, buffers, positionOrCallback, callback) => {
      const done = typeof positionOrCallback === "function" ? positionOrCallback : callback;
      const position = typeof positionOrCallback === "function" ? void 0 : positionOrCallback;
      try {
        const bytesWritten = fsApi.writevSync(fd2, buffers, position);
        queueMicrotask(() => done?.(null, bytesWritten, buffers));
      } catch (error) {
        queueMicrotask(() => done?.(error, void 0, buffers));
      }
    },
    fstatSync: (fd2, options) => {
      const entry = fileDescriptor(fd2);
      let stats;
      if (entry.kind === "kernel") {
        stats = statForTraceKernelPath(
          executionState.kernelFileSystem.fstat(entry.kernelFd)
        );
      } else if (entry.kind === "device") {
        const statTarget = runtimeKernelStatTarget(entry.device ?? "/dev/stdin", kernelInfo, kernelDevices);
        stats = statTarget.kind === "stat" ? statForKernelPath(statTarget.path, statTarget.stat) : missingFileStat();
      } else if (entry.kind === "proc") {
        stats = statForKernelTarget(entry.path ?? "") ?? missingFileStat();
      } else if (entry.kind === "directory") {
        stats = statForNormalizedPath(entry.path ?? "") ?? missingFileStat();
      } else {
        stats = entry.path && fileStore.has(entry.path) ? statForNormalizedPath(entry.path) ?? missingFileStat() : {
          ...missingFileStat(),
          size: descriptorBytes(entry).byteLength,
          isFile: () => true,
          isDirectory: () => false
        };
      }
      return browserStatsResult(stats, options);
    },
    fstat: (fd2, optionsOrCallback, callback) => {
      const options = typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback;
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const stats = fsApi.fstatSync(fd2, options);
        queueMicrotask(() => done?.(null, stats));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    fchmodSync: (fd2, mode) => {
      const path = descriptorMetadataPath(fd2, "fchmod");
      if (path !== null) {
        const stats = statForNormalizedPath(path);
        const typeMode = stats?.isDirectory() ? 16384 : 32768;
        updateEntryMetadata(path, { mode: typeMode | Number(mode) & 4095 });
        notifyMetadataMutation(path);
      }
      return void 0;
    },
    fchmod: (fd2, mode, callback) => {
      try {
        fsApi.fchmodSync(fd2, mode);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    fchownSync: (fd2, uid, gid) => {
      const path = descriptorMetadataPath(fd2, "fchown");
      if (path !== null) {
        if (Number(uid) !== 1e3 || Number(gid) !== 1e3) {
          throw Object.assign(new Error("EPERM: operation not permitted, fchown"), { code: "EPERM" });
        }
      }
      return void 0;
    },
    fchown: (fd2, uid, gid, callback) => {
      try {
        fsApi.fchownSync(fd2, uid, gid);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    futimesSync: (fd2, atime, mtime) => {
      const path = descriptorMetadataPath(fd2, "futimes");
      if (path !== null) {
        updateEntryMetadata(path, { atimeMs: timeToMs(atime), mtimeMs: timeToMs(mtime) });
        notifyMetadataMutation(path);
      }
      return void 0;
    },
    futimes: (fd2, atime, mtime, callback) => {
      try {
        fsApi.futimesSync(fd2, atime, mtime);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    ftruncateSync: (fd2, length = 0) => {
      const entry = fileDescriptor(fd2);
      if (!entry.writable) throw Object.assign(new Error("EBADF: bad file descriptor, ftruncate"), { code: "EBADF" });
      truncateDescriptorBytes(entry, length);
      return void 0;
    },
    ftruncate: (fd2, lengthOrCallback, callback) => {
      const done = typeof lengthOrCallback === "function" ? lengthOrCallback : callback;
      try {
        fsApi.ftruncateSync(fd2, typeof lengthOrCallback === "number" ? lengthOrCallback : 0);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    fsyncSync: (fd2) => {
      fileDescriptor(fd2);
      return void 0;
    },
    fsync: (fd2, callback) => {
      try {
        fsApi.fsyncSync(fd2);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    fdatasyncSync: (fd2) => {
      fileDescriptor(fd2);
      return void 0;
    },
    fdatasync: (fd2, callback) => {
      try {
        fsApi.fdatasyncSync(fd2);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    createReadStream: (path, options) => {
      const optionFd = typeof options === "object" && typeof options?.fd === "number" ? options.fd : null;
      const readTarget = optionFd === null ? runtimeFileReadTarget(path, kernelDevices, procSnapshot) : null;
      const requestedEncoding = typeof options === "string" ? options : options?.encoding;
      if (executionState.kernelFileSystem && optionFd === null && (readTarget === null || readTarget?.kind === "workspace")) {
        const flags = typeof options === "object" && options?.flags ? options.flags : "r";
        const autoClose2 = typeof options === "object" && options?.autoClose === false ? false : true;
        const openedFd = fsApi.openSync(path, flags);
        return fsApi.createReadStream(null, {
          ...typeof options === "object" && options ? options : {},
          fd: openedFd,
          flags,
          autoClose: autoClose2
        });
      }
      let sourceBytes;
      if (readTarget?.kind === "device-file") sourceBytes = utf8Bytes(readDevice(readTarget.path));
      else if (readTarget?.kind === "proc-file") sourceBytes = utf8Bytes(browserProcFileContents(procSnapshot, readTarget.path, kernelInfo));
      else if (readTarget?.kind === "error") {
        throwRuntimeReadTargetError(readTarget, runtimeKernelFileReadFsErrorMessage(String(path), readTarget));
      } else if (optionFd !== null) {
        const entry = fileDescriptor(optionFd);
        if (!entry.readable) throw Object.assign(new Error("EBADF: bad file descriptor, read"), { code: "EBADF" });
        if (typeof options === "object" && typeof options?.start === "number") {
          sourceBytes = descriptorBytes(entry);
        } else {
          sourceBytes = readDescriptorFileBytes(optionFd);
        }
      } else {
        const normalized = resolveWorkspaceEntryPath(path);
        if (workspaceFileAncestor(normalized) !== null) {
          throw Object.assign(new Error(`ENOTDIR: not a directory, open '${path}'`), { code: "ENOTDIR" });
        }
        if (isWorkspaceDirectoryPath(normalized)) {
          throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: "EISDIR" });
        }
        sourceBytes = fileStore.get(normalized);
      }
      if (!sourceBytes) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
      }
      const requestedStart = typeof options === "object" ? assertStreamRangeInteger("start", options?.start) : void 0;
      const requestedEnd = typeof options === "object" ? assertStreamRangeInteger("end", options?.end) : void 0;
      if (requestedStart !== void 0 && requestedEnd !== void 0 && requestedEnd < requestedStart) {
        throw Object.assign(new RangeError('The value of "start" is out of range.'), { code: "ERR_OUT_OF_RANGE" });
      }
      const start = requestedStart ?? 0;
      const endInclusive = requestedEnd ?? sourceBytes.byteLength - 1;
      const autoClose = typeof options === "object" && options?.autoClose === false ? false : true;
      return createReadableStream(
        sourceBytes.slice(start, Math.max(start, endInclusive + 1)),
        requestedEncoding,
        autoClose && optionFd !== null ? () => fsApi.closeSync(optionFd) : void 0
      );
    },
    createWriteStream: createWritableStream,
    readFileSync: (path, encoding) => {
      const requestedEncoding = typeof encoding === "string" ? encoding : encoding?.encoding;
      if (typeof path === "number") {
        const bytes2 = BrowserBuffer.from(readDescriptorFileBytes(path));
        return typeof requestedEncoding === "string" ? bytes2.toString(requestedEncoding) : bytes2;
      }
      const readTarget = runtimeFileReadTarget(path, kernelDevices, procSnapshot);
      if (readTarget?.kind === "device-file") {
        const contents = readDevice(readTarget.path);
        if (typeof requestedEncoding === "string") return BrowserBuffer.from(contents).toString(requestedEncoding);
        return BrowserBuffer.from(contents);
      }
      if (readTarget?.kind === "proc-file") {
        const contents = browserProcFileContents(procSnapshot, readTarget.path, kernelInfo);
        if (typeof requestedEncoding === "string") return BrowserBuffer.from(contents).toString(requestedEncoding);
        return BrowserBuffer.from(contents);
      }
      if (readTarget?.kind === "error") {
        throwRuntimeReadTargetError(readTarget, runtimeKernelFileReadFsErrorMessage(String(path), readTarget));
      }
      const normalized = resolveWorkspaceEntryPath(path);
      if (executionState.kernelFileSystem) {
        const fileBytes4 = executionState.kernelFileSystem.readFile(normalized);
        return typeof requestedEncoding === "string" ? BrowserBuffer.from(fileBytes4).toString(requestedEncoding) : BrowserBuffer.from(fileBytes4);
      }
      if (workspaceFileAncestor(normalized) !== null) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, open '${path}'`), { code: "ENOTDIR" });
      }
      if (isWorkspaceDirectoryPath(normalized)) {
        throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: "EISDIR" });
      }
      const bytes = fileStore.get(normalized);
      if (!bytes) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
      }
      if (typeof requestedEncoding === "string") {
        return BrowserBuffer.from(bytes).toString(requestedEncoding);
      }
      return BrowserBuffer.from(bytes);
    },
    readFile: (path, encodingOrCallback, callback) => {
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      try {
        const data = fsApi.readFileSync(path, typeof encodingOrCallback === "function" ? void 0 : encodingOrCallback);
        queueMicrotask(() => done?.(null, data));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    writeFileSync: (path, value, options) => {
      if (typeof path === "number") {
        writeDescriptorFileBytes(path, bytesFromFsWriteValue(value, options));
        return;
      }
      const writeTarget = runtimeWriteTarget(path, kernelDevices);
      if (writeTarget?.kind === "error") {
        throwRuntimeWriteTargetError(writeTarget, runtimeKernelWriteFsErrorMessage(String(path), writeTarget));
      }
      if (writeTarget?.kind === "device") {
        writeDevice(writeTarget.device, textFromBytes(bytesFromFsWriteValue(value, options)));
        return;
      }
      const normalized = resolveWorkspaceEntryPath(path);
      const structuredOptions = typeof options === "object" && options !== null ? options : void 0;
      const usesDefaultReplaceSemantics = (structuredOptions?.flag === void 0 || structuredOptions.flag === "w") && structuredOptions?.mode === void 0;
      if (executionState.kernelFileSystem && usesDefaultReplaceSemantics) {
        executionState.kernelFileSystem.writeFile(
          normalized,
          bytesFromFsWriteValue(value, options)
        );
        return;
      }
      assertWorkspaceFileWritePath(normalized, path, "write", "open");
      setFileBytes(normalized, bytesFromFsWriteValue(value, options));
    },
    writeFile: (path, value, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        fsApi.writeFileSync(path, value, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    appendFileSync: (path, value, options) => {
      if (typeof path === "number") {
        writeDescriptorFileBytes(path, bytesFromFsWriteValue(value, options), fileDescriptor(path).append);
        return;
      }
      const writeTarget = runtimeWriteTarget(path, kernelDevices);
      if (writeTarget?.kind === "error") {
        throwRuntimeWriteTargetError(writeTarget, runtimeKernelWriteFsErrorMessage(String(path), writeTarget));
      }
      if (writeTarget?.kind === "device") {
        writeDevice(writeTarget.device, textFromBytes(bytesFromFsWriteValue(value, options)));
        return;
      }
      const normalized = resolveWorkspaceEntryPath(path);
      assertWorkspaceFileWritePath(normalized, path, "append", "open");
      const previous = fileStore.get(normalized) ?? new Uint8Array();
      const next = bytesFromFsWriteValue(value, options);
      const combined = new Uint8Array(previous.byteLength + next.byteLength);
      combined.set(previous, 0);
      combined.set(next, previous.byteLength);
      setFileBytes(normalized, combined);
    },
    appendFile: (path, value, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        fsApi.appendFileSync(path, value, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    copyFileSync: (source, destination, mode = 0) => {
      const copyTarget = runtimeFileCopyTarget(source, destination, kernelDevices, procSnapshot);
      if (copyTarget?.kind === "error" && copyTarget.side === "destination") {
        throw Object.assign(new Error(runtimeKernelFileCopyErrorMessage(String(source), String(destination), copyTarget)), {
          code: runtimeKernelFileCopyErrorCode(copyTarget)
        });
      }
      let sourceBytes;
      const sourceTarget = copyTarget?.kind === "virtual-source" || copyTarget?.kind === "device-destination" ? copyTarget.source : runtimeFileReadTarget(source, kernelDevices, procSnapshot);
      if (sourceTarget?.kind === "device-file") sourceBytes = utf8Bytes(readDevice(sourceTarget.path));
      else if (sourceTarget?.kind === "proc-file") sourceBytes = utf8Bytes(browserProcFileContents(procSnapshot, sourceTarget.path, kernelInfo));
      else if (copyTarget?.kind === "error" && copyTarget.side === "source") {
        throw Object.assign(new Error(runtimeKernelFileCopyErrorMessage(String(source), String(destination), copyTarget)), {
          code: runtimeKernelFileCopyErrorCode(copyTarget)
        });
      } else if (sourceTarget?.kind === "error") {
        throwRuntimeReadTargetError(sourceTarget, sourceTarget.reason === "is-directory" ? `EISDIR: illegal operation on a directory, copyfile '${source}' -> '${destination}'` : sourceTarget.reason === "permission-denied" ? `EBADF: bad file descriptor, copyfile '${source}' -> '${destination}'` : `ENOENT: no such file or directory, copyfile '${source}' -> '${destination}'`);
      } else sourceBytes = fileStore.get(resolveWorkspaceEntryPath(source));
      if (!sourceBytes) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, copyfile '${source}' -> '${destination}'`), { code: "ENOENT" });
      }
      if (copyTarget?.kind === "device-destination") {
        writeDevice(copyTarget.device, textFromBytes(sourceBytes));
        return;
      }
      const normalizedDestination = resolveWorkspaceEntryPath(destination);
      assertWorkspaceFileWritePath(normalizedDestination, destination, "copy", "copyfile");
      if ((Number(mode) & fsConstants.COPYFILE_EXCL) !== 0 && fileSystemEntryExists(workspaceFilename(normalizedDestination, workspaceRoot))) {
        throw Object.assign(new Error(`EEXIST: file already exists, copyfile '${source}' -> '${destination}'`), { code: "EEXIST" });
      }
      setFileBytes(normalizedDestination, new Uint8Array(sourceBytes));
    },
    copyFile: (source, destination, modeOrCallback, callback) => {
      const done = typeof modeOrCallback === "function" ? modeOrCallback : callback;
      try {
        fsApi.copyFileSync(source, destination, typeof modeOrCallback === "number" ? modeOrCallback : 0);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    linkSync: (existingPath, newPath) => {
      const linkTarget = runtimeLinkTarget(existingPath, newPath, kernelDevices);
      if (linkTarget?.kind === "error") {
        throwRuntimeLinkTargetError(
          linkTarget,
          runtimeKernelMutationFsErrorMessage(String(existingPath), linkTarget, "link", String(newPath))
        );
      }
      const normalizedSource = assertSafeWorkspaceFilePath(existingPath, cwdPath, workspacePathContext);
      const normalizedDestination = assertSafeWorkspaceFilePath(newPath, cwdPath, workspacePathContext);
      if (executionState.kernelFileSystem) {
        executionState.kernelFileSystem.link(normalizedSource, normalizedDestination);
        return;
      }
      const bytes = fileStore.get(normalizedSource);
      if (!bytes) {
        const sourceIsDirectory = directoryStore.has(normalizedSource) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(`${normalizedSource}/`));
        if (sourceIsDirectory) {
          throw Object.assign(new Error(`EPERM: operation not permitted, link '${existingPath}' -> '${newPath}'`), { code: "EPERM" });
        }
        throw Object.assign(new Error(`ENOENT: no such file or directory, link '${existingPath}' -> '${newPath}'`), { code: "ENOENT" });
      }
      assertReadonlyFilePath(normalizedSource, "link");
      if (fileStore.has(normalizedDestination) || directoryStore.has(normalizedDestination)) {
        throw Object.assign(new Error(`EEXIST: file already exists, link '${existingPath}' -> '${newPath}'`), { code: "EEXIST" });
      }
      assertWorkspaceFileWritePath(normalizedDestination, newPath, "link");
      fileStore.set(normalizedDestination, bytes);
      touchEntryMetadata(normalizedDestination);
      linkPaths(normalizedSource, normalizedDestination);
      syncTextModule(normalizedDestination, bytes);
      cache.delete(normalizedDestination);
      io.fileChange(runtimeFileForPath(normalizedDestination, bytes), "live");
      notifyFsWatchers("change", normalizedDestination);
      notifyWatchFileWatchers(normalizedDestination);
    },
    link: (existingPath, newPath, callback) => {
      try {
        fsApi.linkSync(existingPath, newPath);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    symlinkSync: (target, linkPath) => {
      const symlinkTarget = runtimeSymlinkTarget(linkPath, kernelDevices);
      if (symlinkTarget?.kind === "error") {
        throwRuntimeSymlinkTargetError(symlinkTarget, runtimeKernelMutationFsErrorMessage(String(linkPath), symlinkTarget, "symlink"));
      }
      const targetText = workspacePathInputToString(target);
      if (targetText.length === 0) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, symlink '${targetText}' -> '${linkPath}'`), { code: "ENOENT" });
      }
      const normalizedLink = resolveWorkspaceEntryPath(linkPath, false);
      if (executionState.kernelFileSystem) {
        executionState.kernelFileSystem.symlink(targetText, normalizedLink);
        return;
      }
      assertReadonlyFilePath(normalizedLink, "symlink");
      assertWorkspaceParentDirectoryPath(normalizedLink, linkPath, "symlink");
      if (fileStore.has(normalizedLink) || symlinkStore.has(normalizedLink) || directoryStore.has(normalizedLink)) {
        throw Object.assign(new Error(`EEXIST: file already exists, symlink '${targetText}' -> '${linkPath}'`), { code: "EEXIST" });
      }
      symlinkStore.set(normalizedLink, targetText);
      entryMetadata.set(normalizedLink, createEntryMetadata(41471));
      io.fileChange({ path: normalizedLink, symlink: true, target: targetText }, "live");
      notifyFsWatchers("rename", normalizedLink);
      notifyWatchFileWatchers(normalizedLink);
    },
    symlink: (target, linkPath, typeOrCallback, callback) => {
      const done = typeof typeOrCallback === "function" ? typeOrCallback : callback;
      try {
        fsApi.symlinkSync(target, linkPath);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    readlinkSync: (path, options) => {
      const readTarget = runtimeReadTarget(path, kernelDevices, procSnapshot);
      if (readTarget?.kind && readTarget.kind !== "workspace") {
        throw Object.assign(new Error(`EINVAL: invalid argument, readlink '${path}'`), { code: "EINVAL" });
      }
      const normalized = resolveWorkspaceEntryPath(path, false);
      if (executionState.kernelFileSystem) {
        const target2 = executionState.kernelFileSystem.readlink(normalized);
        const encoding2 = typeof options === "string" ? options : options?.encoding;
        return encoding2 === null || encoding2 === "buffer" ? BrowserBuffer.from(target2) : BrowserBuffer.from(target2).toString(encoding2 ?? "utf8");
      }
      const target = symlinkStore.get(normalized);
      if (target === void 0) {
        const exists = fileStore.has(normalized) || directoryStore.has(normalized);
        const code = exists ? "EINVAL" : "ENOENT";
        const reason = exists ? "invalid argument" : "no such file or directory";
        throw Object.assign(new Error(`${code}: ${reason}, readlink '${path}'`), { code });
      }
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding === null || encoding === "buffer" ? BrowserBuffer.from(target) : BrowserBuffer.from(target).toString(encoding ?? "utf8");
    },
    readlink: (path, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const linkString = fsApi.readlinkSync(path, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null, linkString));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    cpSync: (source, destination, options) => {
      copyEntrySync(source, destination, options);
      return void 0;
    },
    cp: (source, destination, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        fsApi.cpSync(source, destination, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    renameSync: (oldPath, newPath) => {
      const renameTarget = runtimeRenameTarget(oldPath, newPath, kernelDevices);
      if (renameTarget?.kind === "error") {
        throwRuntimeRenameTargetError(
          renameTarget,
          runtimeKernelMutationFsErrorMessage(String(oldPath), renameTarget, "rename", String(newPath))
        );
      }
      const normalizedOldPath = resolveWorkspaceEntryPath(oldPath, false);
      const normalizedNewPath = resolveWorkspaceEntryPath(newPath, false);
      if (executionState.kernelFileSystem) {
        executionState.kernelFileSystem.rename(
          normalizedOldPath,
          normalizedNewPath
        );
        return;
      }
      if (normalizedOldPath === normalizedNewPath) {
        const prefix = normalizedOldPath ? `${normalizedOldPath}/` : "";
        if (fileStore.has(normalizedOldPath) || symlinkStore.has(normalizedOldPath) || directoryStore.has(normalizedOldPath) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix)) || Array.from(directoryStore).some((directoryPath) => directoryPath.startsWith(prefix))) {
          return;
        }
        throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`), { code: "ENOENT" });
      }
      const linkTarget = symlinkStore.get(normalizedOldPath);
      if (linkTarget !== void 0) {
        assertReadonlyFilePath(normalizedOldPath, "move");
        assertReadonlyFilePath(normalizedNewPath, "move");
        assertWorkspaceParentDirectoryPath(normalizedNewPath, newPath, "rename");
        if (directoryStore.has(normalizedNewPath)) {
          throw Object.assign(new Error(`EISDIR: illegal operation on a directory, rename '${oldPath}' -> '${newPath}'`), { code: "EISDIR" });
        }
        if (fileStore.has(normalizedNewPath)) deleteFile(newPath);
        if (symlinkStore.has(normalizedNewPath)) deleteFile(newPath);
        symlinkStore.delete(normalizedOldPath);
        deleteEntryMetadata(normalizedOldPath);
        io.fileChange({ path: normalizedOldPath, deleted: true }, "live");
        symlinkStore.set(normalizedNewPath, linkTarget);
        entryMetadata.set(normalizedNewPath, createEntryMetadata(41471));
        io.fileChange({ path: normalizedNewPath, symlink: true, target: linkTarget }, "live");
        notifyFsWatchers("rename", normalizedOldPath);
        notifyWatchFileWatchers(normalizedOldPath);
        notifyFsWatchers("rename", normalizedNewPath);
        notifyWatchFileWatchers(normalizedNewPath);
        return;
      }
      const bytes = fileStore.get(normalizedOldPath);
      if (bytes) {
        const sourceMetadata = entryMetadata.get(normalizedOldPath);
        assertReadonlyFilePath(normalizedOldPath, "move");
        assertWorkspaceFileWritePath(normalizedNewPath, newPath, "move", "rename");
        fileStore.delete(normalizedOldPath);
        moveOpenFileDescriptorPath(normalizedOldPath, normalizedNewPath);
        moveHardLinkPath(normalizedOldPath, normalizedNewPath);
        modules.delete(normalizedOldPath);
        cache.delete(normalizedOldPath);
        deleteEntryMetadata(normalizedOldPath);
        io.fileChange({ path: normalizedOldPath, deleted: true }, "live");
        notifyFsWatchers("rename", normalizedOldPath);
        notifyWatchFileWatchers(normalizedOldPath);
        setFileBytes(normalizedNewPath, bytes, sourceMetadata);
        notifyFsWatchers("rename", normalizedNewPath);
        return;
      }
      const oldPrefix = normalizedOldPath ? `${normalizedOldPath}/` : "";
      const sourceDirectories = Array.from(directoryStore).filter((directoryPath) => directoryPath === normalizedOldPath || directoryPath.startsWith(oldPrefix)).sort((left, right) => left.localeCompare(right));
      const sourceFiles = Array.from(fileStore.entries()).filter(([filePath]) => filePath.startsWith(oldPrefix)).sort(([left], [right]) => left.localeCompare(right));
      const sourceSymlinks = Array.from(symlinkStore.entries()).filter(([linkPath]) => linkPath.startsWith(oldPrefix)).sort(([left], [right]) => left.localeCompare(right));
      const sourceFileMetadata = new Map(
        sourceFiles.map(([filePath]) => [filePath, entryMetadata.get(filePath)])
      );
      const sourceDirectoryMetadata = new Map(
        sourceDirectories.map((directoryPath) => [directoryPath, entryMetadata.get(directoryPath)])
      );
      if (sourceDirectories.length === 0 && sourceFiles.length === 0 && sourceSymlinks.length === 0) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`), { code: "ENOENT" });
      }
      for (const [filePath] of sourceFiles) {
        assertReadonlyFilePath(filePath, "move");
      }
      assertReadonlyFilePath(normalizedNewPath, "move");
      assertWorkspaceParentDirectoryPath(normalizedNewPath, newPath, "rename");
      if (fileStore.has(normalizedNewPath)) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, rename '${oldPath}' -> '${newPath}'`), { code: "ENOTDIR" });
      }
      const existingDestinationFiles = fileStore.has(normalizedNewPath) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(`${normalizedNewPath}/`));
      const existingDestinationSymlinks = symlinkStore.has(normalizedNewPath) || Array.from(symlinkStore.keys()).some((linkPath) => linkPath.startsWith(`${normalizedNewPath}/`));
      const existingDestinationDirectories = directoryStore.has(normalizedNewPath) || Array.from(directoryStore).some((directoryPath) => directoryPath.startsWith(`${normalizedNewPath}/`));
      if (existingDestinationFiles || existingDestinationSymlinks || existingDestinationDirectories) {
        throw Object.assign(new Error(`EEXIST: file already exists, rename '${oldPath}' -> '${newPath}'`), { code: "EEXIST" });
      }
      for (const [filePath] of sourceFiles) {
        fileStore.delete(filePath);
        const relative = filePath.slice(oldPrefix.length);
        const nextPath = normalizedNewPath ? `${normalizedNewPath}/${relative}` : relative;
        moveOpenFileDescriptorPath(filePath, nextPath);
        moveHardLinkPath(filePath, nextPath);
        modules.delete(filePath);
        cache.delete(filePath);
        deleteEntryMetadata(filePath);
        io.fileChange({ path: filePath, deleted: true }, "live");
        notifyFsWatchers("rename", filePath);
        notifyWatchFileWatchers(filePath);
      }
      for (const [linkPath] of sourceSymlinks) {
        symlinkStore.delete(linkPath);
        deleteEntryMetadata(linkPath);
        io.fileChange({ path: linkPath, deleted: true }, "live");
        notifyFsWatchers("rename", linkPath);
        notifyWatchFileWatchers(linkPath);
      }
      for (const directoryPath of [...sourceDirectories].sort((left, right) => right.length - left.length || right.localeCompare(left))) {
        directoryStore.delete(directoryPath);
        deleteEntryMetadata(directoryPath);
        emitDirectoryDelete(directoryPath);
        notifyDirectoryMutation(directoryPath);
      }
      for (const directoryPath of sourceDirectories) {
        const relative = directoryPath === normalizedOldPath ? "" : directoryPath.slice(oldPrefix.length);
        const nextDirectory = relative ? `${normalizedNewPath}/${relative}` : normalizedNewPath;
        const existed = directoryStore.has(nextDirectory);
        directoryStore.add(nextDirectory);
        const metadata = sourceDirectoryMetadata.get(directoryPath);
        if (metadata) {
          requestState.fsTimestampMs += 1;
          entryMetadata.set(nextDirectory, { ...metadata, ctimeMs: requestState.fsTimestampMs });
        } else if (!entryMetadata.has(nextDirectory)) {
          touchEntryMetadata(nextDirectory);
        }
        if (!existed) {
          emitDirectoryCreate(nextDirectory);
          notifyDirectoryMutation(nextDirectory);
        }
      }
      for (const [filePath, fileBytes4] of sourceFiles) {
        const relative = filePath.slice(oldPrefix.length);
        const nextPath = normalizedNewPath ? `${normalizedNewPath}/${relative}` : relative;
        setFileBytes(nextPath, fileBytes4, sourceFileMetadata.get(filePath));
        notifyFsWatchers("rename", nextPath);
      }
      for (const [linkPath, target] of sourceSymlinks) {
        const relative = linkPath.slice(oldPrefix.length);
        const nextPath = normalizedNewPath ? `${normalizedNewPath}/${relative}` : relative;
        symlinkStore.set(nextPath, target);
        entryMetadata.set(nextPath, createEntryMetadata(41471));
        io.fileChange({ path: nextPath, symlink: true, target }, "live");
        notifyFsWatchers("rename", nextPath);
        notifyWatchFileWatchers(nextPath);
      }
    },
    rename: (oldPath, newPath, callback) => {
      try {
        fsApi.renameSync(oldPath, newPath);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    unlinkSync: deleteFile,
    unlink: (path, callback) => {
      try {
        fsApi.unlinkSync(path);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    },
    rmSync: (path, options) => {
      try {
        const removeTarget = runtimeRemoveTarget(path, kernelDevices);
        if (removeTarget?.kind === "error") {
          throwRuntimeRemoveTargetError(removeTarget, runtimeKernelMutationFsErrorMessage(String(path), removeTarget, "rm"));
        }
        const normalized = resolveWorkspaceEntryPath(path, false);
        if (executionState.kernelFileSystem) {
          const removeEntry = (entryPath, recursive) => {
            const stat = executionState.kernelFileSystem.stat(entryPath);
            if (stat.kind === "file") {
              executionState.kernelFileSystem.unlink(entryPath);
              return;
            }
            if (!recursive) {
              throw Object.assign(
                new Error(`ERR_FS_EISDIR: path is a directory, rm '${path}'`),
                { code: "ERR_FS_EISDIR" }
              );
            }
            for (const entry of executionState.kernelFileSystem.readdir(entryPath)) {
              removeEntry(
                entryPath ? `${entryPath.replace(/\/+$/, "")}/${entry.name}` : entry.name,
                true
              );
            }
            executionState.kernelFileSystem.rmdir(entryPath);
          };
          try {
            removeEntry(normalized, options?.recursive === true);
          } catch (error) {
            if (options?.force && error.code === "ENOENT") return;
            throw error;
          }
          return;
        }
        if (fileStore.has(normalized) || symlinkStore.has(normalized)) {
          deleteFile(path);
          return;
        }
        const prefix = normalized ? `${normalized}/` : "";
        assertWorkspaceParentDirectoryPath(normalized, path, "rm");
        const descendantFiles = Array.from(fileStore.keys()).filter((filePath) => filePath.startsWith(prefix));
        const descendantSymlinks = Array.from(symlinkStore.keys()).filter((linkPath) => linkPath.startsWith(prefix));
        const descendantDirectories = Array.from(directoryStore).filter((directoryPath) => directoryPath !== normalized && directoryPath.startsWith(prefix));
        if (directoryStore.has(normalized) || descendantFiles.length > 0 || descendantSymlinks.length > 0 || descendantDirectories.length > 0) {
          if (!options?.recursive) {
            throw Object.assign(new Error(`ERR_FS_EISDIR: path is a directory, rm '${path}'`), { code: "ERR_FS_EISDIR" });
          }
          for (const filePath of descendantFiles) {
            assertReadonlyFilePath(filePath, "delete");
          }
          for (const filePath of descendantFiles) {
            fileStore.delete(filePath);
            modules.delete(filePath);
            cache.delete(filePath);
            deleteEntryMetadata(filePath);
            io.fileChange({ path: filePath, deleted: true }, "live");
            notifyFsWatchers("rename", filePath);
            notifyWatchFileWatchers(filePath);
          }
          for (const linkPath of descendantSymlinks) {
            assertReadonlyFilePath(linkPath, "delete");
            symlinkStore.delete(linkPath);
            deleteEntryMetadata(linkPath);
            io.fileChange({ path: linkPath, deleted: true }, "live");
            notifyFsWatchers("rename", linkPath);
            notifyWatchFileWatchers(linkPath);
          }
          for (const directoryPath of Array.from(directoryStore)) {
            if (directoryPath === normalized || directoryPath.startsWith(prefix)) {
              directoryStore.delete(directoryPath);
              deleteEntryMetadata(directoryPath);
              emitDirectoryDelete(directoryPath);
              notifyDirectoryMutation(directoryPath);
            }
          }
          return;
        }
        if (!options?.force) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, rm '${path}'`), { code: "ENOENT" });
        }
      } catch (error) {
        if (options?.force && error.code === "ENOENT") return;
        throw error;
      }
    },
    rm: (path, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        fsApi.rmSync(path, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    existsSync: (path) => {
      try {
        return fileSystemEntryExists(path);
      } catch {
        return false;
      }
    },
    exists: (path, callback) => {
      queueMicrotask(() => callback?.(fsApi.existsSync(path)));
    },
    readdirSync: (path, options) => {
      const directoryTarget = runtimeDirectoryTarget(path, kernelDevices, procSnapshot);
      const withFileTypes = typeof options === "object" && options?.withFileTypes === true;
      const makeDirent = (name, type, parentPath, characterDevice = false) => ({
        name,
        path: parentPath,
        parentPath,
        isBlockDevice: () => false,
        isCharacterDevice: () => characterDevice,
        isDirectory: () => type === "directory",
        isFIFO: () => false,
        isFile: () => type === "file",
        isSocket: () => false,
        isSymbolicLink: () => type === "symlink"
      });
      if (directoryTarget?.kind === "directory") {
        const names = directoryTarget.entries.map((entry) => entry.name);
        if (!withFileTypes) return names;
        return directoryTarget.entries.map((entry) => makeDirent(
          entry.name,
          entry.kind === "directory" ? "directory" : "file",
          directoryTarget.path,
          directoryTarget.path === "/dev" && entry.kind === "file"
        ));
      }
      if (directoryTarget?.kind === "error") {
        throwRuntimeDirectoryTargetError(directoryTarget, directoryTarget.reason === "not-directory" ? `ENOTDIR: not a directory, scandir '${path}'` : `ENOENT: no such file or directory, scandir '${path}'`);
      }
      const normalized = resolveWorkspaceEntryPath(path);
      if (executionState.kernelFileSystem) {
        const recursive2 = typeof options === "object" && options?.recursive === true;
        const entries2 = [];
        const collectEntries = (directoryPath, relativePrefix) => {
          for (const entry of executionState.kernelFileSystem.readdir(directoryPath)) {
            const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
            entries2.push({ relativePath, kind: entry.kind });
            if (recursive2 && entry.kind === "directory") {
              collectEntries(
                directoryPath ? `${directoryPath.replace(/\/+$/, "")}/${entry.name}` : entry.name,
                relativePath
              );
            }
          }
        };
        collectEntries(normalized, "");
        entries2.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
        if (!withFileTypes) return entries2.map((entry) => entry.relativePath);
        return entries2.map((entry) => {
          const parts = entry.relativePath.split("/");
          const name = parts.pop() ?? entry.relativePath;
          const relativeParent = parts.join("/");
          const parentPath = relativeParent ? normalized ? `${normalized}/${relativeParent}` : relativeParent : normalized;
          return makeDirent(
            name,
            entry.kind,
            workspaceFilename(parentPath, workspaceRoot)
          );
        });
      }
      if (workspaceFileAncestor(normalized) !== null || fileStore.has(normalized)) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, scandir '${path}'`), { code: "ENOTDIR" });
      }
      const prefix = normalized ? `${normalized}/` : "";
      const recursive = typeof options === "object" && options?.recursive === true;
      const makeWorkspaceDirent = (name, type, parentPath = normalized) => makeDirent(name, type, workspaceFilename(parentPath, workspaceRoot));
      if (recursive) {
        const entries2 = /* @__PURE__ */ new Map();
        for (const directoryPath of directoryStore) {
          if (directoryPath === normalized || !directoryPath.startsWith(prefix)) continue;
          const rest = directoryPath.slice(prefix.length);
          if (rest) entries2.set(rest, "directory");
        }
        for (const filePath of fileStore.keys()) {
          if (!filePath.startsWith(prefix)) continue;
          const rest = filePath.slice(prefix.length);
          if (rest) entries2.set(rest, "file");
        }
        for (const linkPath of symlinkStore.keys()) {
          if (!linkPath.startsWith(prefix)) continue;
          const rest = linkPath.slice(prefix.length);
          if (rest) entries2.set(rest, "symlink");
        }
        if (entries2.size === 0 && !fileStore.has(normalized) && !directoryStore.has(normalized)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: "ENOENT" });
        }
        const sortedEntries2 = Array.from(entries2.entries()).sort(([left], [right]) => left.localeCompare(right));
        if (!withFileTypes) return sortedEntries2.map(([name]) => name);
        return sortedEntries2.map(([relativePath, type]) => {
          const parts = relativePath.split("/");
          const name = parts.pop() ?? relativePath;
          const parentPath = parts.length === 0 ? normalized : normalized ? `${normalized}/${parts.join("/")}` : parts.join("/");
          return makeWorkspaceDirent(name, type, parentPath);
        });
      }
      const entries = /* @__PURE__ */ new Map();
      for (const filePath of fileStore.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        if (!rest) continue;
        const [name, ...remaining] = rest.split("/");
        if (!name) continue;
        entries.set(name, remaining.length > 0 ? "directory" : "file");
      }
      for (const directoryPath of directoryStore) {
        if (!directoryPath.startsWith(prefix)) continue;
        const rest = directoryPath.slice(prefix.length);
        if (!rest) continue;
        const name = rest.split("/")[0] ?? rest;
        if (!entries.has(name)) entries.set(name, "directory");
      }
      for (const linkPath of symlinkStore.keys()) {
        if (!linkPath.startsWith(prefix)) continue;
        const rest = linkPath.slice(prefix.length);
        if (!rest) continue;
        const [name, ...remaining] = rest.split("/");
        if (!name) continue;
        entries.set(name, remaining.length > 0 ? "directory" : "symlink");
      }
      if (entries.size === 0 && !fileStore.has(normalized) && !directoryStore.has(normalized)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: "ENOENT" });
      }
      const sortedEntries = Array.from(entries.entries()).sort(([left], [right]) => left.localeCompare(right));
      if (!withFileTypes) return sortedEntries.map(([name]) => name);
      return sortedEntries.map(([name, type]) => makeWorkspaceDirent(name, type));
    },
    readdir: (path, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const entries = fsApi.readdirSync(path, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null, entries));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    opendirSync: (path) => {
      const entries = fsApi.readdirSync(path, { withFileTypes: true });
      let index = 0;
      let closed = false;
      const assertOpen = () => {
        if (closed) throw Object.assign(new Error("ERR_DIR_CLOSED: Directory handle was closed"), { code: "ERR_DIR_CLOSED" });
      };
      const dir = {
        path: fsApi.realpathSync(path),
        readSync: () => {
          assertOpen();
          return entries[index++] ?? null;
        },
        read: (callback) => {
          if (typeof callback !== "function") {
            return new Promise((resolve, reject) => {
              try {
                const entry = dir.readSync();
                queueMicrotask(() => resolve(entry));
              } catch (error) {
                queueMicrotask(() => reject(error));
              }
            });
          }
          try {
            const entry = dir.readSync();
            queueMicrotask(() => callback?.(null, entry));
          } catch (error) {
            queueMicrotask(() => callback?.(error));
          }
        },
        closeSync: () => {
          closed = true;
        },
        close: (callback) => {
          if (typeof callback !== "function") {
            return new Promise((resolve) => {
              closed = true;
              queueMicrotask(resolve);
            });
          }
          closed = true;
          queueMicrotask(() => callback?.(null));
        },
        async *[Symbol.asyncIterator]() {
          while (true) {
            const entry = dir.readSync();
            if (entry === null) break;
            yield entry;
          }
        }
      };
      return dir;
    },
    opendir: (path, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const dir = fsApi.opendirSync(path);
        queueMicrotask(() => done?.(null, dir));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    statSync: (path, options) => {
      const kernelStats = statForKernelTarget(path, options);
      if (kernelStats === void 0) return void 0;
      let stats = kernelStats;
      if (stats === null) {
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        if (executionState.kernelFileSystem) {
          try {
            stats = statForTraceKernelPath(
              executionState.kernelFileSystem.stat(normalized)
            );
          } catch (error) {
            if (options?.throwIfNoEntry === false && error.code === "ENOENT") {
              return void 0;
            }
            throw error;
          }
        } else {
          if (workspaceFileAncestor(normalized) !== null) {
            if (options?.throwIfNoEntry === false) return void 0;
            throw Object.assign(new Error(`ENOTDIR: not a directory, stat '${path}'`), { code: "ENOTDIR" });
          }
          stats = statForNormalizedPath(normalized);
        }
      }
      if (!stats) {
        if (options?.throwIfNoEntry === false) return void 0;
        throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
      }
      return browserStatsResult(stats, options);
    },
    lstatSync: (path, options) => {
      const kernelStats = statForKernelTarget(path, options);
      if (kernelStats === void 0) return void 0;
      let stats = kernelStats;
      if (stats === null) {
        const normalized = resolveWorkspaceEntryPath(path, false);
        if (executionState.kernelFileSystem) {
          try {
            stats = statForTraceKernelPath(
              executionState.kernelFileSystem.lstat(normalized)
            );
          } catch (error) {
            if (options?.throwIfNoEntry === false && error.code === "ENOENT") {
              return void 0;
            }
            throw error;
          }
        } else {
          if (workspaceFileAncestor(normalized) !== null) {
            if (options?.throwIfNoEntry === false) return void 0;
            throw Object.assign(new Error(`ENOTDIR: not a directory, lstat '${path}'`), { code: "ENOTDIR" });
          }
          stats = statForNormalizedPath(normalized, false);
        }
      }
      if (!stats) {
        if (options?.throwIfNoEntry === false) return void 0;
        throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: "ENOENT" });
      }
      return browserStatsResult(stats, options);
    },
    statfsSync: (path, options) => {
      fsApi.statSync(path);
      return browserFileSystemStat(Boolean(options?.bigint));
    },
    stat: (path, optionsOrCallback, callback) => {
      const options = typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback;
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const stats = fsApi.statSync(path, options);
        queueMicrotask(() => done?.(null, stats));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    lstat: (path, optionsOrCallback, callback) => {
      const options = typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback;
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const stats = fsApi.lstatSync(path, options);
        if (stats === void 0 && options?.throwIfNoEntry === false) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: "ENOENT" });
        }
        queueMicrotask(() => done?.(null, stats));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    statfs: (path, optionsOrCallback, callback) => {
      const options = typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback;
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const stats = fsApi.statfsSync(path, options);
        queueMicrotask(() => done?.(null, stats));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    realpathSync: (path, options) => {
      const resolved = realpathForEntry(path);
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding === "buffer" ? BrowserBuffer.from(resolved) : resolved;
    },
    realpath: (path, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const resolved = fsApi.realpathSync(path, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null, resolved));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    truncateSync: (path, length = 0) => {
      const truncateTarget = runtimeTruncateTarget(path, kernelDevices);
      if (truncateTarget?.kind === "error") {
        throwRuntimeTruncateTargetError(truncateTarget, runtimeKernelMutationFsErrorMessage(String(path), truncateTarget, "truncate"));
      }
      const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
      assertWorkspaceFileWritePath(normalized, path, "truncate");
      truncateFileBytes(normalized, length);
      return void 0;
    },
    truncate: (path, lengthOrCallback, callback) => {
      const done = typeof lengthOrCallback === "function" ? lengthOrCallback : callback;
      try {
        fsApi.truncateSync(path, typeof lengthOrCallback === "number" ? lengthOrCallback : 0);
        queueMicrotask(() => done?.(null));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    mkdirSync: (path, options) => {
      const mkdirTarget = runtimeMkdirTarget(path, kernelDevices);
      if (mkdirTarget?.kind === "error") {
        throwRuntimeMkdirTargetError(mkdirTarget, runtimeKernelMutationFsErrorMessage(String(path), mkdirTarget, "mkdir"));
      }
      const rawPath = workspacePathInputToString(path).replace(/\\/g, "/");
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      if (!normalized) return void 0;
      const recursive = typeof options === "object" && options?.recursive === true;
      const mode = typeof options === "number" ? options : typeof options?.mode === "number" ? options.mode : void 0;
      if (executionState.kernelFileSystem) {
        let firstCreated2;
        if (recursive) {
          const parts2 = normalized.split("/");
          for (let index = 1; index <= parts2.length; index += 1) {
            const candidate = parts2.slice(0, index).join("/");
            try {
              executionState.kernelFileSystem.stat(candidate);
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
              firstCreated2 = candidate;
              break;
            }
          }
        }
        executionState.kernelFileSystem.mkdir(normalized, {
          recursive,
          ...mode !== void 0 ? { mode } : {}
        });
        if (!recursive || firstCreated2 === void 0) return void 0;
        if (rawPath.startsWith("/")) {
          return workspaceFilename(firstCreated2, workspaceRoot);
        }
        const relativeFirstCreated2 = relativeWorkspacePath(cwdPath, firstCreated2);
        return rawPath.startsWith("./") && !relativeFirstCreated2.startsWith(".") ? `./${relativeFirstCreated2}` : relativeFirstCreated2;
      }
      assertReadonlyFilePath(normalized, "mkdir");
      const parent = dirname(normalized);
      const parentPath = parent === "" ? "" : parent;
      const parts = normalized.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const directoryPath = parts.slice(0, index).join("/");
        if (fileStore.has(directoryPath)) {
          throw Object.assign(new Error(`ENOTDIR: not a directory, mkdir '${path}'`), { code: "ENOTDIR" });
        }
      }
      if (fileStore.has(normalized)) {
        throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: "EEXIST" });
      }
      if (directoryStore.has(normalized)) {
        if (!recursive) {
          throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: "EEXIST" });
        }
        return void 0;
      }
      if (!recursive && parentPath && !directoryStore.has(parentPath)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${path}'`), { code: "ENOENT" });
      }
      const start = recursive ? 1 : parts.length;
      let firstCreated;
      for (let index = start; index <= parts.length; index += 1) {
        const directoryPath = parts.slice(0, index).join("/");
        const existed = directoryStore.has(directoryPath);
        directoryStore.add(directoryPath);
        if (!entryMetadata.has(directoryPath)) touchEntryMetadata(directoryPath);
        if (!existed) {
          firstCreated ??= directoryPath;
          emitDirectoryCreate(directoryPath);
          notifyDirectoryMutation(directoryPath);
        }
      }
      if (!recursive || firstCreated === void 0) return void 0;
      if (rawPath.startsWith("/")) return workspaceFilename(firstCreated, workspaceRoot);
      const relativeFirstCreated = relativeWorkspacePath(cwdPath, firstCreated);
      return rawPath.startsWith("./") && !relativeFirstCreated.startsWith(".") ? `./${relativeFirstCreated}` : relativeFirstCreated;
    },
    mkdir: (path, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const created = fsApi.mkdirSync(path, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null, created));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    mkdtempSync: (prefix, options) => {
      const rawPrefix = workspacePathInputToString(prefix);
      for (let attempt = 0; attempt < 1e3; attempt += 1) {
        filesystemState.mkdtempCounter += 1;
        const suffix = filesystemState.mkdtempCounter.toString(36).padStart(6, "0").slice(-6);
        const candidate = `${rawPrefix}${suffix}`;
        const normalized = normalizeWorkspaceEntryPath(candidate, cwdPath, false, workspacePathContext);
        if (fileStore.has(normalized) || directoryStore.has(normalized)) continue;
        fsApi.mkdirSync(candidate);
        const encoding = typeof options === "string" ? options : options?.encoding;
        const result = rawPrefix.startsWith("/") ? workspaceFilename(normalized, workspaceRoot) : candidate;
        return encoding === "buffer" ? BrowserBuffer.from(result) : result;
      }
      throw Object.assign(new Error(`EEXIST: file already exists, mkdtemp '${prefix}'`), { code: "EEXIST" });
    },
    mkdtemp: (prefix, optionsOrCallback, callback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        const directory = fsApi.mkdtempSync(prefix, typeof optionsOrCallback === "function" ? void 0 : optionsOrCallback);
        queueMicrotask(() => done?.(null, directory));
      } catch (error) {
        queueMicrotask(() => done?.(error));
      }
    },
    rmdirSync: (path) => {
      const removeTarget = runtimeRemoveTarget(path, kernelDevices);
      if (removeTarget?.kind === "error") {
        throwRuntimeRemoveTargetError(removeTarget, runtimeKernelMutationFsErrorMessage(String(path), removeTarget, "rmdir"));
      }
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      if (executionState.kernelFileSystem) {
        executionState.kernelFileSystem.rmdir(normalized);
        return;
      }
      assertWorkspaceParentDirectoryPath(normalized, path, "rmdir");
      if (fileStore.has(normalized)) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, rmdir '${path}'`), { code: "ENOTDIR" });
      }
      const prefix = normalized ? `${normalized}/` : "";
      const hasChildren = Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix)) || Array.from(directoryStore).some((directoryPath) => directoryPath !== normalized && directoryPath.startsWith(prefix));
      if (hasChildren) {
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`), { code: "ENOTEMPTY" });
      }
      if (!directoryStore.delete(normalized)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, rmdir '${path}'`), { code: "ENOENT" });
      }
      deleteEntryMetadata(normalized);
      emitDirectoryDelete(normalized);
      notifyDirectoryMutation(normalized);
    },
    rmdir: (path, callback) => {
      try {
        fsApi.rmdirSync(path);
        queueMicrotask(() => callback?.(null));
      } catch (error) {
        queueMicrotask(() => callback?.(error));
      }
    }
  };
  filesystemState.attachFsApi(fsApi);
  return fsApi;
}

// packages/runtime-javascript/src/kernel/fs-promises-api.ts
function createBrowserFsPromisesApi(requestState, filesystemState, fsApi) {
  const {
    assertApi,
    cache,
    childProcessApi,
    consoleApi,
    createEntryMetadata,
    cryptoApi,
    cwdPath,
    deleteEntryMetadata,
    directoryStore,
    entryMetadata,
    eventLoopApi,
    eventsApi,
    fileStore,
    hardLinkGroupForPath,
    io,
    isHiddenNamespacePath,
    kernelDevices,
    kernelInfo,
    linkPaths,
    linkedInodeForPath,
    liveIo,
    modules,
    moveHardLinkPath,
    nodePathSearchEntries,
    originalDirectoryMetadata,
    originalFiles,
    originalSymlinks,
    osApi,
    pathApi,
    procSnapshot,
    processApi,
    readDevice,
    readDeviceBytes,
    readonlyFiles,
    refreshSymlinkModuleAliases,
    requireCache,
    resolveStoredSymlinkPath,
    resolveWorkspaceEntryPath,
    runtimeFileForPath,
    stderr,
    stdout,
    streamApi,
    symlinkStore,
    syncTextModule,
    timersPromisesApi,
    touchEntryMetadata,
    traceKernelApi,
    unlinkPathFromHardLinks,
    unmodeledStorageBytes,
    unmodeledStorageEntries,
    updateEntryMetadata,
    urlApi,
    utilApi,
    virtualStorageEntries,
    workspacePathContext,
    workspaceRoot,
    writeDevice
  } = requestState;
  const {
    assertFileSystemAccess,
    assertReadonlyFilePath,
    assertStreamRangeInteger,
    assertWorkspaceFileWritePath,
    assertWorkspaceParentDirectoryPath,
    browserFileSystemStat,
    browserStatsResult,
    copyEntrySync,
    createReadableStream,
    createWritableStream,
    deleteFile,
    descriptorBytes,
    descriptorMetadataPath,
    emitDirectoryCreate,
    emitDirectoryDelete,
    emitFsWatch,
    fileDescriptor,
    fileDescriptors,
    fileSystemEntryExists,
    fsConstants,
    fsFileWatchers,
    fsWatchers,
    isWorkspaceDirectoryPath,
    metadataPathForEntry,
    missingFileStat,
    moveOpenFileDescriptorPath,
    notifyDirectoryMutation,
    notifyFsWatchers,
    notifyMetadataMutation,
    notifyWatchFileWatchers,
    parseOpenFlags,
    readDescriptorFileBytes,
    realpathForEntry,
    setFileBytes,
    statForKernelPath,
    statForKernelTarget,
    statForNormalizedPath,
    statForTraceKernelPath,
    timeToMs,
    truncateDescriptorBytes,
    truncateFileBytes,
    watchedFilename,
    workspaceFileAncestor,
    writeDescriptorBytes,
    writeDescriptorFileBytes
  } = filesystemState;
  const fileHandleTarget = (path) => typeof path === "object" && path !== null && !(path instanceof URL) && typeof path.fd === "number" ? path.fd : path;
  const fsPromisesApi = {
    constants: fsConstants,
    access: async (path, mode = fsConstants.F_OK) => {
      fsApi.accessSync(path, mode);
    },
    open: async (path, flags = "r") => {
      const fd2 = fsApi.openSync(path, flags);
      let closed = false;
      const assertFileHandleOpen = () => {
        if (closed) throw Object.assign(new Error("file closed"), { code: "EBADF" });
      };
      const trackAutoCloseStream = (stream, autoClose) => {
        if (!autoClose) return;
        addStreamInternalCloseListener(stream, () => {
          closed = true;
        });
      };
      const readFileFromHandle = (encoding) => {
        assertFileHandleOpen();
        const bytes = BrowserBuffer.from(readDescriptorFileBytes(fd2));
        const requestedEncoding = typeof encoding === "string" ? encoding : encoding?.encoding;
        return typeof requestedEncoding === "string" ? bytes.toString(requestedEncoding) : bytes;
      };
      const writeFileToHandle = (value, options) => {
        assertFileHandleOpen();
        const bytes = bytesFromFsWriteValue(value, options);
        return fsApi.writeSync(fd2, bytes, 0, bytes.byteLength, null);
      };
      const appendFileToHandle = (value, options) => {
        assertFileHandleOpen();
        const entry = fileDescriptor(fd2);
        const bytes = bytesFromFsWriteValue(value, options);
        const position = entry.kind === "device" ? null : descriptorBytes(entry).byteLength;
        return fsApi.writeSync(fd2, bytes, 0, bytes.byteLength, position);
      };
      return {
        fd: fd2,
        read: async (bufferOrOptions, offset = 0, length, position) => {
          assertFileHandleOpen();
          const options = typeof bufferOrOptions === "object" && bufferOrOptions !== null && !ArrayBuffer.isView(bufferOrOptions) ? bufferOrOptions : void 0;
          const buffer = options?.buffer ?? (ArrayBuffer.isView(bufferOrOptions) ? bufferOrOptions : BrowserBuffer.alloc(16 * 1024));
          const readOffset = options?.offset ?? offset;
          const readLength = options?.length ?? length ?? buffer.byteLength - readOffset;
          const readPosition = options !== void 0 ? options.position : position;
          const bytesRead = fsApi.readSync(fd2, buffer, readOffset, readLength, readPosition);
          return { bytesRead, buffer };
        },
        readFile: async (encoding) => readFileFromHandle(encoding),
        readv: async (buffers, position) => {
          assertFileHandleOpen();
          const bytesRead = fsApi.readvSync(fd2, buffers, position);
          return { bytesRead, buffers };
        },
        write: async (value, offsetOrPosition, lengthOrEncoding, position) => {
          assertFileHandleOpen();
          const options = typeof offsetOrPosition === "object" && offsetOrPosition !== null ? offsetOrPosition : void 0;
          const bytesWritten = fsApi.writeSync(
            fd2,
            value,
            options?.offset ?? (typeof offsetOrPosition === "number" ? offsetOrPosition : void 0),
            options?.length ?? lengthOrEncoding,
            options !== void 0 ? options.position : position
          );
          return {
            bytesWritten,
            buffer: value
          };
        },
        writeFile: async (value, options) => {
          writeFileToHandle(value, options);
        },
        createReadStream: (options) => {
          assertFileHandleOpen();
          const streamOptions = typeof options === "string" ? { encoding: options, fd: fd2 } : { ...options ?? {}, fd: fd2 };
          const stream = fsApi.createReadStream(null, streamOptions);
          trackAutoCloseStream(stream, typeof options !== "object" || options?.autoClose !== false);
          return stream;
        },
        createWriteStream: (options) => {
          assertFileHandleOpen();
          const streamOptions = typeof options === "string" ? { encoding: options, fd: fd2 } : { ...options ?? {}, fd: fd2 };
          const stream = fsApi.createWriteStream(null, streamOptions);
          trackAutoCloseStream(stream, typeof options !== "object" || options?.autoClose !== false);
          return stream;
        },
        appendFile: async (value, options) => {
          appendFileToHandle(value, options);
        },
        writev: async (buffers, position) => {
          assertFileHandleOpen();
          const bytesWritten = fsApi.writevSync(fd2, buffers, position);
          return { bytesWritten, buffers };
        },
        stat: async (options) => {
          assertFileHandleOpen();
          return fsApi.fstatSync(fd2, options);
        },
        chmod: async (mode) => {
          assertFileHandleOpen();
          fsApi.fchmodSync(fd2, mode);
        },
        chown: async (uid, gid) => {
          assertFileHandleOpen();
          fsApi.fchownSync(fd2, uid, gid);
        },
        utimes: async (atime, mtime) => {
          assertFileHandleOpen();
          fsApi.futimesSync(fd2, atime, mtime);
        },
        truncate: async (length = 0) => {
          assertFileHandleOpen();
          fsApi.ftruncateSync(fd2, length);
        },
        sync: async () => {
          assertFileHandleOpen();
          fsApi.fsyncSync(fd2);
        },
        datasync: async () => {
          assertFileHandleOpen();
          fsApi.fdatasyncSync(fd2);
        },
        close: async () => {
          if (closed) return;
          closed = true;
          fsApi.closeSync(fd2);
        }
      };
    },
    readFile: async (path, encoding) => fsApi.readFileSync(fileHandleTarget(path), encoding),
    writeFile: async (path, value, options) => {
      fsApi.writeFileSync(fileHandleTarget(path), value, options);
    },
    appendFile: async (path, value, options) => {
      fsApi.appendFileSync(fileHandleTarget(path), value, options);
    },
    copyFile: async (source, destination, mode = 0) => {
      fsApi.copyFileSync(source, destination, mode);
    },
    link: async (existingPath, newPath) => {
      fsApi.linkSync(existingPath, newPath);
    },
    symlink: async (target, linkPath) => {
      fsApi.symlinkSync(target, linkPath);
    },
    readlink: async (path, options) => fsApi.readlinkSync(path, options),
    cp: async (source, destination, options) => {
      fsApi.cpSync(source, destination, options);
    },
    chmod: async (path, mode) => {
      fsApi.chmodSync(path, mode);
    },
    chown: async (path, uid, gid) => {
      fsApi.chownSync(path, uid, gid);
    },
    utimes: async (path, atime, mtime) => {
      fsApi.utimesSync(path, atime, mtime);
    },
    rename: async (oldPath, newPath) => {
      fsApi.renameSync(oldPath, newPath);
    },
    unlink: async (path) => {
      fsApi.unlinkSync(path);
    },
    truncate: async (path, length = 0) => {
      fsApi.truncateSync(path, length);
    },
    rm: async (path, options) => {
      fsApi.rmSync(path, options);
    },
    readdir: async (path, options) => fsApi.readdirSync(path, options),
    opendir: async (path) => fsApi.opendirSync(path),
    watch: (path, options) => {
      const entries = [];
      const waiters = [];
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        watcher.close();
        entries.length = 0;
        while (waiters.length > 0) {
          waiters.shift()?.({ done: true, value: void 0 });
        }
      };
      const watcher = fsApi.watch(path, typeof options === "string" ? void 0 : options ?? void 0, (eventType, filename) => {
        const entry = { eventType, filename };
        const waiter = waiters.shift();
        if (waiter) {
          waiter({ done: false, value: entry });
          return;
        }
        entries.push(entry);
      });
      if (typeof options === "object" && options?.signal) {
        if (options.signal.aborted) {
          close();
        } else {
          options.signal.addEventListener("abort", close, { once: true });
        }
      }
      const iterator = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        next: () => {
          if (entries.length > 0) return Promise.resolve({ done: false, value: entries.shift() });
          if (closed) return Promise.resolve({ done: true, value: void 0 });
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        return: () => {
          close();
          return Promise.resolve({ done: true, value: void 0 });
        }
      };
      return iterator;
    },
    stat: async (path, options) => fsApi.statSync(path, options),
    lstat: async (path, options) => {
      const stats = fsApi.lstatSync(path, options);
      if (stats === void 0 && options?.throwIfNoEntry === false) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: "ENOENT" });
      }
      return stats;
    },
    statfs: async (path, options) => fsApi.statfsSync(path, options),
    realpath: async (path, options) => fsApi.realpathSync(path, options),
    mkdir: async (path, options) => fsApi.mkdirSync(path, options),
    mkdtemp: async (prefix, options) => fsApi.mkdtempSync(prefix, options),
    rmdir: async (path) => {
      fsApi.rmdirSync(path);
    }
  };
  fsApi.realpath.native = fsApi.realpath;
  fsApi.realpathSync.native = fsApi.realpathSync;
  Object.assign(fsApi, { promises: fsPromisesApi });
  return fsPromisesApi;
}

// packages/runtime-javascript/src/security/authority-boundary.ts
var permanentBrowserAuthorityDefineProperty = Object.defineProperty;
var permanentBrowserAuthorityGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var permanentBrowserAuthorityGetPrototypeOf = Object.getPrototypeOf;
var PERMANENT_BROWSER_WORKER_DENIED_GLOBALS = Object.freeze([
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "WebTransport",
  "EventSource",
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "RTCDataChannel",
  "indexedDB",
  "caches",
  "Cache",
  "CacheStorage",
  "cookieStore",
  "localStorage",
  "sessionStorage",
  "webkitRequestFileSystem",
  "webkitRequestFileSystemSync",
  "webkitResolveLocalFileSystemURL",
  "webkitResolveLocalFileSystemSyncURL",
  "Worker",
  "SharedWorker",
  "MessageChannel",
  "MessagePort",
  "BroadcastChannel",
  "importScripts",
  "postMessage",
  "eval",
  "Function"
]);
var PERMANENT_BROWSER_WORKER_DENIED_NAVIGATOR_MEMBERS = Object.freeze([
  "sendBeacon",
  "storage",
  "locks",
  "serviceWorker"
]);
var permanentBrowserDynamicConstructorPrototypes = Object.freeze([
  BrowserFunction.prototype,
  permanentBrowserAuthorityGetPrototypeOf(async function browserAsyncFunction() {
  }),
  permanentBrowserAuthorityGetPrototypeOf(function* browserGeneratorFunction() {
  }),
  permanentBrowserAuthorityGetPrototypeOf(async function* browserAsyncGeneratorFunction() {
  })
]);
function permanentBrowserAuthorityError(name) {
  return new ReferenceError(`${name} is not defined`);
}
function permanentBrowserDeniedAuthority(name) {
  const deny = function deniedBrowserWorkerAuthority() {
    throw permanentBrowserAuthorityError(name);
  };
  return typeof Proxy === "function" ? new Proxy(deny, {
    apply: () => deny(),
    construct: () => deny(),
    get: (_target, property) => property === Symbol.toStringTag ? "Function" : permanentBrowserDeniedAuthority(`${name}.${String(property)}`),
    set: () => {
      throw permanentBrowserAuthorityError(name);
    }
  }) : deny;
}
function permanentBrowserPrototypeChain(value) {
  const targets = [];
  const seen = /* @__PURE__ */ new Set();
  let current = value;
  while (current && (typeof current === "object" || typeof current === "function") && !seen.has(current)) {
    targets.push(current);
    seen.add(current);
    current = permanentBrowserAuthorityGetPrototypeOf(current);
  }
  return targets;
}
function sealPermanentBrowserProperty(target, name, value) {
  const descriptor = permanentBrowserAuthorityGetOwnPropertyDescriptor(target, name);
  if (descriptor?.configurable === false && !("value" in descriptor && descriptor.writable === true)) {
    if ("value" in descriptor && descriptor.value === value) return;
    throw permanentBrowserAuthorityError(String(name));
  }
  permanentBrowserAuthorityDefineProperty(target, name, {
    configurable: false,
    enumerable: descriptor?.enumerable ?? false,
    writable: false,
    value
  });
  if (target[name] !== value) {
    throw permanentBrowserAuthorityError(String(name));
  }
}
function sealPermanentBrowserPropertyAcrossChain(value, name, replacement, options = {}) {
  const targets = permanentBrowserPrototypeChain(value);
  const includeOwn = options.includeOwn !== false;
  let replacedOwn = false;
  for (let index = includeOwn ? 0 : 1; index < targets.length; index += 1) {
    const target = targets[index];
    if (!permanentBrowserAuthorityGetOwnPropertyDescriptor(target, name)) continue;
    sealPermanentBrowserProperty(target, name, replacement);
    if (target === value) replacedOwn = true;
  }
  if (includeOwn && options.ensureOwn !== false && !replacedOwn) {
    sealPermanentBrowserProperty(value, name, replacement);
  }
}
function installPermanentBrowserWorkerAuthorityBoundary(httpApi) {
  if (typeof document !== "undefined") {
    throw new Error("Permanent browser authority denial is only valid inside a disposable worker.");
  }
  const scope = globalThis;
  for (const name of PERMANENT_BROWSER_WORKER_DENIED_GLOBALS) {
    sealPermanentBrowserPropertyAcrossChain(scope, name, permanentBrowserDeniedAuthority(name));
  }
  const deniedNativeFetch = permanentBrowserDeniedAuthority("native fetch");
  sealPermanentBrowserPropertyAcrossChain(scope, "fetch", deniedNativeFetch, {
    includeOwn: false,
    ensureOwn: false
  });
  sealPermanentBrowserProperty(scope, "fetch", httpApi.fetch);
  sealPermanentBrowserProperty(scope, "Headers", httpApi.Headers);
  sealPermanentBrowserProperty(scope, "Request", httpApi.Request);
  sealPermanentBrowserProperty(scope, "Response", httpApi.Response);
  const navigatorValue = scope.navigator;
  if (navigatorValue && (typeof navigatorValue === "object" || typeof navigatorValue === "function")) {
    for (const name of PERMANENT_BROWSER_WORKER_DENIED_NAVIGATOR_MEMBERS) {
      sealPermanentBrowserPropertyAcrossChain(
        navigatorValue,
        name,
        permanentBrowserDeniedAuthority(`navigator.${name}`)
      );
    }
    sealPermanentBrowserProperty(scope, "navigator", navigatorValue);
  }
  const deniedConstructor = permanentBrowserDeniedAuthority("Function constructor");
  for (const prototype of permanentBrowserDynamicConstructorPrototypes) {
    sealPermanentBrowserProperty(prototype, "constructor", deniedConstructor);
  }
  return () => {
  };
}
function installBrowserHttpGlobalLockdown(httpApi, authorityMode = "temporary") {
  if (authorityMode === "permanent") {
    return installPermanentBrowserWorkerAuthorityBoundary(httpApi);
  }
  const global = globalThis;
  const blockedNetworkApi = (name) => function blockedBrowserNetworkApi() {
    throw new ReferenceError(`${name} is not defined`);
  };
  const blockedAuthorityObject = (name) => {
    const deny = blockedNetworkApi(name);
    return typeof Proxy === "function" ? new Proxy(deny, {
      apply: () => deny(),
      construct: () => deny(),
      get: (_target, property) => property === Symbol.toStringTag ? "Function" : deny
    }) : deny;
  };
  const replacements = {
    fetch: httpApi.fetch,
    Headers: httpApi.Headers,
    Request: httpApi.Request,
    Response: httpApi.Response,
    XMLHttpRequest: blockedAuthorityObject("XMLHttpRequest"),
    WebSocket: blockedAuthorityObject("WebSocket"),
    WebSocketStream: blockedAuthorityObject("WebSocketStream"),
    WebTransport: blockedAuthorityObject("WebTransport"),
    EventSource: blockedAuthorityObject("EventSource"),
    // A dedicated Worker is an execution boundary, not an origin boundary.
    // User code must not bypass TraceKernel through same-origin persistence,
    // cache, nested workers, or cross-context messaging. The worker bridge
    // captures the host channel before this lockdown is installed.
    ...typeof document === "undefined" ? {
      indexedDB: blockedAuthorityObject("indexedDB"),
      caches: blockedAuthorityObject("caches"),
      cookieStore: blockedAuthorityObject("cookieStore"),
      Worker: blockedAuthorityObject("Worker"),
      SharedWorker: blockedAuthorityObject("SharedWorker"),
      BroadcastChannel: blockedAuthorityObject("BroadcastChannel"),
      importScripts: blockedAuthorityObject("importScripts")
    } : {}
  };
  const previousDescriptors = /* @__PURE__ */ new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previousDescriptors.set(name, Object.getOwnPropertyDescriptor(global, name));
    try {
      Object.defineProperty(global, name, {
        configurable: true,
        enumerable: false,
        writable: false,
        value
      });
    } catch {
    }
  }
  const navigatorValue = global.navigator;
  const navigatorDescriptors = /* @__PURE__ */ new Map();
  if (navigatorValue && typeof navigatorValue === "object") {
    const navigatorReplacements = {
      sendBeacon: blockedAuthorityObject("navigator.sendBeacon"),
      ...typeof document === "undefined" ? {
        storage: blockedAuthorityObject("navigator.storage"),
        locks: blockedAuthorityObject("navigator.locks"),
        serviceWorker: blockedAuthorityObject("navigator.serviceWorker")
      } : {}
    };
    for (const [name, value] of Object.entries(navigatorReplacements)) {
      navigatorDescriptors.set(name, Object.getOwnPropertyDescriptor(navigatorValue, name));
      try {
        Object.defineProperty(navigatorValue, name, {
          configurable: true,
          enumerable: false,
          writable: false,
          value
        });
      } catch {
      }
    }
  }
  return () => {
    for (const [name, descriptor] of previousDescriptors) {
      try {
        if (descriptor) {
          Object.defineProperty(global, name, descriptor);
        } else {
          delete global[name];
        }
      } catch {
      }
    }
    if (navigatorValue && typeof navigatorValue === "object") {
      for (const [name, descriptor] of navigatorDescriptors) {
        try {
          if (descriptor) {
            Object.defineProperty(navigatorValue, name, descriptor);
          } else {
            delete navigatorValue[name];
          }
        } catch {
        }
      }
    }
  };
}
function installBrowserTimerGlobals(eventLoopApi) {
  const global = globalThis;
  const replacements = {
    setTimeout: eventLoopApi.setTimeout,
    clearTimeout: eventLoopApi.clearTimeout,
    setInterval: eventLoopApi.setInterval,
    clearInterval: eventLoopApi.clearInterval,
    setImmediate: eventLoopApi.setImmediate,
    clearImmediate: eventLoopApi.clearImmediate,
    queueMicrotask: eventLoopApi.queueMicrotask
  };
  const previousDescriptors = /* @__PURE__ */ new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previousDescriptors.set(name, Object.getOwnPropertyDescriptor(global, name));
    try {
      Object.defineProperty(global, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value
      });
    } catch {
    }
  }
  return () => {
    for (const [name, descriptor] of previousDescriptors) {
      try {
        if (descriptor) {
          Object.defineProperty(global, name, descriptor);
        } else {
          delete global[name];
        }
      } catch {
      }
    }
  };
}

// packages/runtime-javascript/src/modules/runtime-loader.ts
function createBrowserModuleRuntime(requestState, filesystemState, fsApi, fsPromisesApi, request, executionState, options) {
  const {
    assertApi,
    cache,
    childProcessApi,
    consoleApi,
    createEntryMetadata,
    cryptoApi,
    cwdPath,
    deleteEntryMetadata,
    directoryStore,
    entryMetadata,
    eventLoopApi,
    eventsApi,
    fileStore,
    hardLinkGroupForPath,
    io,
    isHiddenNamespacePath,
    kernelDevices,
    kernelInfo,
    linkPaths,
    linkedInodeForPath,
    liveIo,
    modules,
    moveHardLinkPath,
    nodePathSearchEntries,
    originalDirectoryMetadata,
    originalFiles,
    originalSymlinks,
    osApi,
    pathApi,
    procSnapshot,
    processApi,
    readDevice,
    readDeviceBytes,
    readonlyFiles,
    refreshSymlinkModuleAliases,
    requireCache,
    resolveStoredSymlinkPath,
    resolveWorkspaceEntryPath,
    runtimeFileForPath,
    stderr,
    stdout,
    streamApi,
    symlinkStore,
    syncTextModule,
    timersPromisesApi,
    touchEntryMetadata,
    traceKernelApi,
    unlinkPathFromHardLinks,
    unmodeledStorageBytes,
    unmodeledStorageEntries,
    updateEntryMetadata,
    urlApi,
    utilApi,
    virtualStorageEntries,
    workspacePathContext,
    workspaceRoot,
    writeDevice
  } = requestState;
  const {
    assertFileSystemAccess,
    assertReadonlyFilePath,
    assertStreamRangeInteger,
    assertWorkspaceFileWritePath,
    assertWorkspaceParentDirectoryPath,
    browserFileSystemStat,
    browserStatsResult,
    copyEntrySync,
    createReadableStream,
    createWritableStream,
    deleteFile,
    descriptorBytes,
    descriptorMetadataPath,
    emitDirectoryCreate,
    emitDirectoryDelete,
    emitFsWatch,
    fileDescriptor,
    fileDescriptors,
    fileSystemEntryExists,
    fsConstants,
    fsFileWatchers,
    fsWatchers,
    isWorkspaceDirectoryPath,
    metadataPathForEntry,
    missingFileStat,
    moveOpenFileDescriptorPath,
    notifyDirectoryMutation,
    notifyFsWatchers,
    notifyMetadataMutation,
    notifyWatchFileWatchers,
    parseOpenFlags,
    readDescriptorFileBytes,
    realpathForEntry,
    setFileBytes,
    statForKernelPath,
    statForKernelTarget,
    statForNormalizedPath,
    statForTraceKernelPath,
    timeToMs,
    truncateDescriptorBytes,
    truncateFileBytes,
    watchedFilename,
    workspaceFileAncestor,
    writeDescriptorBytes,
    writeDescriptorFileBytes
  } = filesystemState;
  const zlibApi = createZlibApi();
  const netApi = createNetApi(
    executionState.kernelNetwork,
    request.signal
  );
  const httpApi = createHttpApi(request.kernelHttp, request.signal);
  const restoreHttpGlobals = installBrowserHttpGlobalLockdown(
    httpApi,
    options.projectUserAuthorityMode ?? "temporary"
  );
  const restoreTimerGlobals = installBrowserTimerGlobals(eventLoopApi);
  let hostGlobalsRestored = false;
  const restoreHostGlobals = () => {
    if (hostGlobalsRestored) return;
    hostGlobalsRestored = true;
    eventLoopApi.clearAll();
    netApi.closeAll();
    restoreTimerGlobals();
    restoreHttpGlobals();
  };
  executionState.cleanupHostGlobals = restoreHostGlobals;
  if (executionState.cancelled) {
    restoreHostGlobals();
    return {
      cancelled: true,
      result: { stdout: "", stderr: "", exitCode: 1 }
    };
  }
  const builtins = /* @__PURE__ */ new Map([
    ["fs", fsApi],
    ["node:fs", fsApi],
    ["fs/promises", fsPromisesApi],
    ["node:fs/promises", fsPromisesApi],
    ["path", pathApi],
    ["node:path", pathApi],
    ["os", osApi],
    ["node:os", osApi],
    ["url", urlApi],
    ["node:url", urlApi],
    ["buffer", { Buffer: BrowserBuffer }],
    ["node:buffer", { Buffer: BrowserBuffer }],
    ["net", netApi.module],
    ["node:net", netApi.module],
    ["http", httpApi.module],
    ["node:http", httpApi.module],
    ["https", httpApi.httpsModule],
    ["node:https", httpApi.httpsModule],
    ["zlib", zlibApi],
    ["node:zlib", zlibApi],
    ["assert", assertApi],
    ["node:assert", assertApi],
    ["assert/strict", assertApi],
    ["node:assert/strict", assertApi],
    ["events", eventsApi],
    ["node:events", eventsApi],
    ["util", utilApi],
    ["node:util", utilApi],
    ["stream", streamApi],
    ["node:stream", streamApi],
    ["child_process", childProcessApi],
    ["node:child_process", childProcessApi],
    ["tracekernel", traceKernelApi],
    ["node:tracekernel", traceKernelApi],
    ["timers/promises", timersPromisesApi],
    ["node:timers/promises", timersPromisesApi],
    ["crypto", cryptoApi],
    ["node:crypto", cryptoApi],
    ["process", processApi],
    ["node:process", processApi]
  ]);
  const normalizeModuleSpecifier = (specifier) => specifier.startsWith("/") ? normalizeWorkspaceEntryPath(specifier, "", false, workspacePathContext) : specifier;
  const requireModule = (specifier, parentPath, parentModule = null) => {
    if (builtins.has(specifier)) return builtins.get(specifier);
    refreshSymlinkModuleAliases();
    const normalizedSpecifier = normalizeModuleSpecifier(specifier);
    return executeModule(resolveModulePath(modules, normalizedSpecifier, parentPath, nodePathSearchEntries, "require"), parentModule);
  };
  const resolveRequireModule = (specifier, parentPath) => {
    if (builtins.has(specifier)) return specifier;
    refreshSymlinkModuleAliases();
    const normalizedSpecifier = normalizeModuleSpecifier(specifier);
    return workspaceFilename(resolveModulePath(modules, normalizedSpecifier, parentPath, nodePathSearchEntries, "require"), workspaceRoot);
  };
  const createWorkspaceRequire = (parentPath, parentModule = null) => {
    const localRequire = ((specifier) => requireModule(specifier, parentPath, parentModule));
    localRequire.cache = requireCache;
    localRequire.resolve = (specifier) => resolveRequireModule(specifier, parentPath);
    Object.defineProperty(localRequire, "main", {
      configurable: true,
      enumerable: true,
      get: () => requestState.mainModule
    });
    return localRequire;
  };
  const importModule = (specifier, parentPath) => builtins.has(specifier) ? Promise.resolve(builtins.get(specifier)) : (refreshSymlinkModuleAliases(), Promise.resolve(executeModule(resolveModulePath(modules, normalizeModuleSpecifier(specifier), parentPath, nodePathSearchEntries, "import"))));
  const preloadParentPath = cwdPath ? `${cwdPath}/repl.js` : "repl.js";
  const createModuleRecord = (normalizedPath, parent) => ({
    exports: {},
    id: workspaceFilename(normalizedPath, workspaceRoot),
    filename: workspaceFilename(normalizedPath, workspaceRoot),
    loaded: false,
    parent,
    children: [],
    path: workspaceDirname(normalizedPath, workspaceRoot),
    paths: moduleSearchPaths(normalizedPath, workspaceRoot)
  });
  const executeModule = (modulePath, parent = null, isMain = false) => {
    const normalizedPath = moduleCandidates(modules, modulePath, "require").find((candidate) => modules.has(candidate));
    if (!normalizedPath) {
      throw new Error(`Cannot find module '${modulePath}'`);
    }
    const cacheKey = workspaceFilename(normalizedPath, workspaceRoot);
    const cached = cache.get(normalizedPath);
    if (cached && requireCache[cacheKey]) {
      if (parent?.children && !parent.children.includes(cached)) parent.children.push(cached);
      return cached.exports;
    } else if (cached) {
      cache.delete(normalizedPath);
    }
    const code = modules.get(normalizedPath);
    if (code === void 0) {
      throw new Error(`Cannot find module '${modulePath}'`);
    }
    if (normalizedPath.endsWith(".json")) {
      const parsed = JSON.parse(code);
      const jsonModule = createModuleRecord(normalizedPath, parent);
      jsonModule.exports = parsed;
      jsonModule.loaded = true;
      cache.set(normalizedPath, jsonModule);
      requireCache[cacheKey] = jsonModule;
      if (parent?.children) parent.children.push(jsonModule);
      return parsed;
    }
    const module = createModuleRecord(normalizedPath, parent);
    if (isMain) {
      module.id = ".";
      requestState.mainModule = module;
    }
    cache.set(normalizedPath, module);
    requireCache[cacheKey] = module;
    if (parent?.children) parent.children.push(module);
    const localRequire = createWorkspaceRequire(normalizedPath, module);
    module.require = localRequire;
    const localImport = (specifier) => importModule(specifier, normalizedPath);
    const executableCode = isEsmModule(modules, normalizedPath) ? transformStaticEsmToCommonJs(code, workspaceFileUrl(normalizedPath, workspaceRoot)) : code;
    try {
      const fn = new BrowserFunction(
        "require",
        "__import",
        "module",
        "exports",
        "console",
        "process",
        "Buffer",
        "__filename",
        "__dirname",
        executableCode
      );
      fn.call(
        isEsmModule(modules, normalizedPath) ? void 0 : module.exports,
        localRequire,
        localImport,
        module,
        module.exports,
        consoleApi,
        processApi,
        BrowserBuffer,
        workspaceFilename(normalizedPath, workspaceRoot),
        workspaceDirname(normalizedPath, workspaceRoot)
      );
    } catch (error) {
      throw sanitizeBrowserJavaScriptStack(error, workspaceFilename(normalizedPath, workspaceRoot));
    }
    module.loaded = true;
    return module.exports;
  };
  const executeEntrypoint = async (modulePath) => {
    refreshSymlinkModuleAliases();
    const normalizedPath = moduleCandidates(modules, modulePath, "import").find((candidate) => modules.has(candidate));
    if (!normalizedPath) {
      throw new Error(`Cannot find module '${modulePath}'`);
    }
    if (!isEsmModule(modules, normalizedPath)) {
      executeModule(normalizedPath, null, true);
      await Promise.resolve();
      return;
    }
    const cached = cache.get(normalizedPath);
    if (cached) return;
    const code = modules.get(normalizedPath);
    if (code === void 0) {
      throw new Error(`Cannot find module '${modulePath}'`);
    }
    const module = createModuleRecord(normalizedPath, null);
    module.id = ".";
    requestState.mainModule = module;
    cache.set(normalizedPath, module);
    requireCache[workspaceFilename(normalizedPath, workspaceRoot)] = module;
    const localRequire = createWorkspaceRequire(normalizedPath, module);
    module.require = localRequire;
    const localImport = (specifier) => importModule(specifier, normalizedPath);
    const executableCode = transformStaticEsmToCommonJs(code, workspaceFileUrl(normalizedPath, workspaceRoot));
    try {
      const fn = new AsyncFunction(
        "require",
        "__import",
        "module",
        "exports",
        "console",
        "process",
        "Buffer",
        "__filename",
        "__dirname",
        executableCode
      );
      await fn.call(
        void 0,
        localRequire,
        localImport,
        module,
        module.exports,
        consoleApi,
        processApi,
        BrowserBuffer,
        workspaceFilename(normalizedPath, workspaceRoot),
        workspaceDirname(normalizedPath, workspaceRoot)
      );
    } catch (error) {
      throw sanitizeBrowserJavaScriptStack(error, workspaceFilename(normalizedPath, workspaceRoot));
    }
    module.loaded = true;
    await Promise.resolve();
  };
  return {
    cancelled: false,
    createWorkspaceRequire,
    executeEntrypoint,
    httpApi,
    importModule,
    netApi,
    preloadParentPath,
    requireModule,
    restoreHostGlobals
  };
}

// packages/runtime-javascript/src/browser/request-execution.ts
async function runBrowserJavaScriptProjectRequest(request, options, executionState) {
  if (options.allowDynamicEval === false) {
    const stderr2 = "node: JavaScript runtime is unavailable\n";
    const io2 = createRuntimeProjectIoBridge(request.onEvent);
    io2.output("stderr", stderr2);
    io2.status("process-exit", "Browser Node exited", { command: "node", exitCode: 126 });
    return {
      stdout: "",
      stderr: stderr2,
      exitCode: 126,
      error: {
        code: "ENOEXEC",
        errno: 8,
        message: "JavaScript runtime is unavailable",
        detail: { diagnostic: "Dynamic evaluation is disabled" }
      }
    };
  }
  const requestState = createBrowserJavaScriptRequestState(request, options, executionState);
  const {
    assertApi,
    cache,
    childProcessApi,
    consoleApi,
    createEntryMetadata,
    cryptoApi,
    cwdPath,
    deleteEntryMetadata,
    directoryStore,
    entryMetadata,
    eventLoopApi,
    eventsApi,
    fileStore,
    hardLinkGroupForPath,
    io,
    isHiddenNamespacePath,
    kernelDevices,
    kernelInfo,
    linkPaths,
    linkedInodeForPath,
    liveIo,
    modules,
    moveHardLinkPath,
    nodePathSearchEntries,
    originalDirectoryMetadata,
    originalFiles,
    originalSymlinks,
    osApi,
    pathApi,
    procSnapshot,
    processApi,
    readDevice,
    readDeviceBytes,
    readonlyFiles,
    refreshSymlinkModuleAliases,
    requireCache,
    resolveStoredSymlinkPath,
    resolveWorkspaceEntryPath,
    runtimeFileForPath,
    stderr,
    stdout,
    streamApi,
    symlinkStore,
    syncTextModule,
    timersPromisesApi,
    touchEntryMetadata,
    traceKernelApi,
    unlinkPathFromHardLinks,
    unmodeledStorageBytes,
    unmodeledStorageEntries,
    updateEntryMetadata,
    urlApi,
    utilApi,
    virtualStorageEntries,
    workspacePathContext,
    workspaceRoot,
    writeDevice
  } = requestState;
  const filesystemState = createBrowserFileSystemState(requestState, request, executionState);
  const {
    assertFileSystemAccess,
    assertReadonlyFilePath,
    assertStreamRangeInteger,
    assertWorkspaceFileWritePath,
    assertWorkspaceParentDirectoryPath,
    browserFileSystemStat,
    browserStatsResult,
    copyEntrySync,
    createReadableStream,
    createWritableStream,
    deleteFile,
    descriptorBytes,
    descriptorMetadataPath,
    emitDirectoryCreate,
    emitDirectoryDelete,
    emitFsWatch,
    fileDescriptor,
    fileDescriptors,
    fileSystemEntryExists,
    fsConstants,
    fsFileWatchers,
    fsWatchers,
    isWorkspaceDirectoryPath,
    metadataPathForEntry,
    missingFileStat,
    moveOpenFileDescriptorPath,
    notifyDirectoryMutation,
    notifyFsWatchers,
    notifyMetadataMutation,
    notifyWatchFileWatchers,
    parseOpenFlags,
    readDescriptorFileBytes,
    realpathForEntry,
    setFileBytes,
    statForKernelPath,
    statForKernelTarget,
    statForNormalizedPath,
    statForTraceKernelPath,
    timeToMs,
    truncateDescriptorBytes,
    truncateFileBytes,
    watchedFilename,
    workspaceFileAncestor,
    writeDescriptorBytes,
    writeDescriptorFileBytes
  } = filesystemState;
  const fsApi = createBrowserFsApi(requestState, filesystemState, request, executionState);
  const fsPromisesApi = createBrowserFsPromisesApi(requestState, filesystemState, fsApi);
  const moduleRuntime = createBrowserModuleRuntime(
    requestState,
    filesystemState,
    fsApi,
    fsPromisesApi,
    request,
    executionState,
    options
  );
  if (moduleRuntime.cancelled) return moduleRuntime.result;
  const {
    createWorkspaceRequire,
    executeEntrypoint,
    httpApi,
    importModule,
    netApi,
    preloadParentPath,
    requireModule,
    restoreHostGlobals
  } = moduleRuntime;
  try {
    for (const moduleName of requireModulesForRequest(request)) {
      requireModule(moduleName, preloadParentPath);
    }
    if (request.source === "file") {
      let entryPath = null;
      try {
        const workspaceRelativePath = assertSafeWorkspaceFilePath(request.scriptPath, "", workspacePathContext);
        if (modules.has(workspaceRelativePath)) {
          entryPath = workspaceRelativePath;
        }
      } catch {
      }
      await executeEntrypoint(entryPath ?? normalizeWorkspaceEntryPath(request.scriptPath, cwdPath, false, workspacePathContext));
    } else {
      const module = { exports: {} };
      const replPath = preloadParentPath;
      const requireFromRoot = createWorkspaceRequire(replPath);
      const importFromRoot = (specifier) => importModule(specifier, replPath);
      const evalCode = request.options?.inputType === "module" ? transformStaticEsmToCommonJs(request.code, workspaceFileUrl("[eval]", workspaceRoot)) : request.code;
      try {
        const fn = new AsyncFunction(
          "require",
          "__import",
          "module",
          "exports",
          "console",
          "process",
          "Buffer",
          "__filename",
          "__dirname",
          transformDynamicImports(evalCode)
        );
        await fn.call(
          module.exports,
          requireFromRoot,
          importFromRoot,
          module,
          module.exports,
          consoleApi,
          processApi,
          BrowserBuffer,
          `${workspaceRoot}/[eval]`,
          cwdPath ? `${workspaceRoot}/${cwdPath}` : workspaceRoot
        );
      } catch (error) {
        throw sanitizeBrowserJavaScriptStack(error, `${workspaceRoot}/[eval]`);
      }
      await Promise.resolve();
    }
    while (!executionState.cancelled) {
      await eventLoopApi.drain();
      if (!httpApi.hasActiveWork() && !netApi.hasActiveWork()) break;
      await Promise.all([
        httpApi.hasActiveWork() ? httpApi.waitForClose() : Promise.resolve(),
        netApi.hasActiveWork() ? netApi.waitForClose() : Promise.resolve()
      ]);
    }
    liveIo.close();
    try {
      await liveIo.flush();
    } catch (error) {
      const failed = runtimeProjectInfrastructureFailure(error, executionState.abortController.signal);
      const hostIo = createRuntimeProjectIoBridge(request.onEvent);
      hostIo.status("process-exit", "Browser Node exited", {
        command: "node",
        exitCode: failed.exitCode,
        error: failed.error?.message,
        ...failed.error?.detail ?? {}
      });
      return {
        ...failed,
        stdout: stdout.join(""),
        stderr: stderr.join("")
      };
    }
    const resultFiles = [
      ...Array.from(fileStore.entries()).filter(([path, contents]) => !byteEqual(originalFiles.get(path), contents)).sort(([left], [right]) => left.localeCompare(right)).map(([path, contents]) => runtimeFileForPath(path, contents)),
      ...Array.from(originalFiles.keys()).filter((path) => !fileStore.has(path) && !symlinkStore.has(path)).sort((left, right) => left.localeCompare(right)).map((path) => ({ path, deleted: true })),
      ...Array.from(symlinkStore.entries()).filter(([path, target]) => originalSymlinks.get(path) !== target).sort(([left], [right]) => left.localeCompare(right)).map(([path, target]) => ({ path, symlink: true, target })),
      ...Array.from(originalSymlinks.keys()).filter((path) => !symlinkStore.has(path) && !fileStore.has(path)).sort((left, right) => left.localeCompare(right)).map((path) => ({ path, deleted: true })),
      ...Array.from(directoryStore).filter((path) => path !== "").filter((path) => {
        const current = entryMetadata.get(path);
        const original = originalDirectoryMetadata.get(path);
        return !original || !current || current.mode !== original.mode || current.atimeMs !== original.atimeMs || current.mtimeMs !== original.mtimeMs;
      }).sort((left, right) => left.localeCompare(right)).map((path) => {
        const metadata = entryMetadata.get(path) ?? createEntryMetadata(16877);
        return {
          path,
          directory: true,
          ...metadata.mode !== void 0 ? { mode: metadata.mode & 4095 } : {},
          atimeMs: metadata.atimeMs,
          mtimeMs: metadata.mtimeMs
        };
      }),
      ...Array.from(originalDirectoryMetadata.keys()).filter((path) => path !== "" && !directoryStore.has(path)).sort((left, right) => right.localeCompare(left)).map((path) => ({ path, directory: true, deleted: true }))
    ].sort((left, right) => left.path.localeCompare(right.path));
    const files = liveIo.filterAppliedResultFiles({
      stdout: "",
      stderr: "",
      exitCode: 0,
      files: resultFiles
    }).files ?? [];
    httpApi.closeAll();
    eventLoopApi.clearAll();
    const exitCode = typeof processApi.exitCode === "number" ? processApi.exitCode : 0;
    createRuntimeProjectIoBridge(request.onEvent).status("process-exit", "Browser Node exited", { command: "node", exitCode });
    return {
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      exitCode,
      ...executionState.handledSignal ? { handledSignal: executionState.handledSignal } : {},
      ...files.length > 0 ? { files } : {}
    };
  } catch (error) {
    httpApi.closeAll();
    eventLoopApi.clearAll();
    const sourcePath = processArgvForRequest(request)[1] ?? `${request.project.workspaceRoot ?? request.project.cwd ?? "/workspace"}/[eval]`;
    const displayError = sanitizeBrowserJavaScriptStack(error, sourcePath);
    const exitCode = typeof displayError.exitCode === "number" ? displayError.exitCode : 1;
    const stderrSuffix = displayError.suppressStderr ? "" : formatBrowserJavaScriptErrorForStderr(displayError);
    const hostIo = createRuntimeProjectIoBridge(request.onEvent);
    if (stderrSuffix) {
      stderr.push(stderrSuffix);
      hostIo.output("stderr", stderrSuffix);
    }
    liveIo.close();
    try {
      await liveIo.flush();
    } catch (flushError) {
      const failed = runtimeProjectInfrastructureFailure(flushError, executionState.abortController.signal);
      hostIo.status("process-exit", "Browser Node exited", {
        command: "node",
        exitCode: failed.exitCode,
        error: failed.error?.message,
        ...failed.error?.detail ?? {}
      });
      return {
        ...failed,
        stdout: stdout.join(""),
        stderr: stderr.join("")
      };
    }
    hostIo.status("process-exit", "Browser Node exited", { command: "node", exitCode });
    return {
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      exitCode
    };
  } finally {
    netApi.closeAll();
    try {
      await netApi.waitForClose();
    } catch {
    }
    restoreHostGlobals();
    if (executionState.cleanupHostGlobals === restoreHostGlobals) {
      executionState.cleanupHostGlobals = void 0;
    }
  }
}

// packages/runtime-javascript/src/project-browser-worker.ts
var workerScope = self;
var postWorkerMessage = workerScope.postMessage.bind(workerScope);
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
var WorkerKernelHttpBridge = class {
  constructor(postProtocolMessage) {
    this.postProtocolMessage = postProtocolMessage;
  }
  nextListenerId = 1;
  nextRequestId = 1;
  listeners = /* @__PURE__ */ new Map();
  listenerInfo = /* @__PURE__ */ new Map();
  listenerRegistrations = /* @__PURE__ */ new Map();
  dispatchRequests = /* @__PURE__ */ new Map();
  serverRequestAbortControllers = /* @__PURE__ */ new Map();
  listen(options, handler) {
    const listenerId = `worker-http-${this.nextListenerId++}`;
    const optimisticInfo = {
      id: listenerId,
      pid: 0,
      host: options.host ?? "127.0.0.1",
      port: options.port,
      protocol: options.protocol ?? "http",
      startedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.listeners.set(listenerId, handler);
    this.listenerInfo.set(listenerId, optimisticInfo);
    let resolveRegistration;
    let rejectRegistration;
    const ready = new Promise((resolve, reject) => {
      resolveRegistration = resolve;
      rejectRegistration = reject;
    });
    this.listenerRegistrations.set(listenerId, {
      resolve: resolveRegistration,
      reject: rejectRegistration
    });
    this.postProtocolMessage({
      type: "kernel-http-listen",
      listenerId,
      options
    });
    let closed = false;
    const listenerInfo = this.listenerInfo;
    return {
      id: listenerId,
      get info() {
        return listenerInfo.get(listenerId) ?? optimisticInfo;
      },
      ready,
      close: () => {
        if (closed) return;
        closed = true;
        this.listeners.delete(listenerId);
        this.listenerInfo.delete(listenerId);
        this.listenerRegistrations.delete(listenerId);
        this.postProtocolMessage({ type: "kernel-http-close", listenerId });
      }
    };
  }
  dispatch(request, options = {}) {
    const requestId = `worker-dispatch-${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      let abortListener;
      const cleanup = () => {
        if (abortListener) options.signal?.removeEventListener?.("abort", abortListener);
      };
      this.dispatchRequests.set(requestId, { resolve, reject, cleanup });
      if (options.signal) {
        abortListener = () => {
          this.postProtocolMessage({
            type: "kernel-http-abort-dispatch",
            requestId
          });
        };
        options.signal.addEventListener?.("abort", abortListener, { once: true });
        if (options.signal.aborted) abortListener();
      }
      this.postProtocolMessage({
        type: "kernel-http-dispatch",
        requestId,
        request,
        ...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {}
      });
    });
  }
  resolveDispatch(requestId, response) {
    const request = this.dispatchRequests.get(requestId);
    this.dispatchRequests.delete(requestId);
    request?.cleanup();
    request?.resolve(response);
  }
  rejectDispatch(requestId, error) {
    const request = this.dispatchRequests.get(requestId);
    this.dispatchRequests.delete(requestId);
    request?.cleanup();
    request?.reject(new Error(error));
  }
  updateListenerInfo(listenerId, info) {
    this.listenerInfo.set(listenerId, info);
    this.listenerRegistrations.get(listenerId)?.resolve(info);
    this.listenerRegistrations.delete(listenerId);
  }
  failListener(listenerId, message) {
    this.listeners.delete(listenerId);
    this.listenerInfo.delete(listenerId);
    const error = new Error(message);
    const code = /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1];
    if (code) Object.assign(error, { code });
    this.listenerRegistrations.get(listenerId)?.reject(error);
    this.listenerRegistrations.delete(listenerId);
  }
  abortRequest(requestId) {
    this.serverRequestAbortControllers.get(requestId)?.abort();
  }
  async handleRequest(listenerId, requestId, request) {
    const handler = this.listeners.get(listenerId);
    if (!handler) {
      this.postProtocolMessage({
        type: "kernel-http-error",
        requestId,
        listenerId,
        error: `Network listener not found: ${listenerId}`
      });
      return;
    }
    const abortController = new AbortController();
    this.serverRequestAbortControllers.set(requestId, abortController);
    try {
      const response = await handler({
        ...request,
        signal: abortController.signal
      });
      this.postProtocolMessage({
        type: "kernel-http-response",
        requestId,
        response
      });
    } catch (error) {
      this.postProtocolMessage({
        type: "kernel-http-error",
        requestId,
        listenerId,
        error: errorMessage(error)
      });
    } finally {
      this.serverRequestAbortControllers.delete(requestId);
    }
  }
};
var activeHttpBridges = /* @__PURE__ */ new Map();
var WorkerKernelAsyncSyscallClient = class {
  constructor(postProtocolMessage) {
    this.postProtocolMessage = postProtocolMessage;
  }
  nextRequestId = 1;
  closed = false;
  pending = /* @__PURE__ */ new Map();
  closedResult() {
    return {
      ok: false,
      error: {
        code: "EIO",
        message: "ECLOSED: async syscall client is closed"
      }
    };
  }
  dispatch(request) {
    if (this.closed) {
      return Promise.resolve(this.closedResult());
    }
    const requestId = `async-syscall-${this.nextRequestId++}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, { resolve });
      this.postProtocolMessage(requestId, request);
    });
  }
  resolve(requestId, result) {
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);
    pending?.resolve(result);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    const result = this.closedResult();
    for (const pending of this.pending.values()) pending.resolve(result);
    this.pending.clear();
  }
};
function postCommandMessage(postMessage2, id, protocolToken, type, payload) {
  postMessage2({ id, type, payload, protocolToken });
}
function handleKernelHttpHostMessage(message) {
  const { id, type, payload, protocolToken } = message;
  if (!id) return false;
  const command = activeHttpBridges.get(id);
  if (!command) return false;
  if (protocolToken !== command.protocolToken) return true;
  if (type === "runtime-signal") {
    const signal = typeof payload?.signal === "string" ? payload.signal : "SIGTERM";
    const handled = command.executionState.dispatchSignal?.(signal) === true;
    if (!handled && signal === "SIGWINCH") return true;
    if (!handled) {
      command.executionState.cancelled = true;
      command.executionState.abortController.abort({ signal });
    }
    return true;
  }
  if (type === "kernel-syscall-async-result") {
    const result = payload;
    if (typeof result.requestId === "string") {
      command.asyncSyscallClient?.resolve(
        result.requestId,
        result.result
      );
    }
    return true;
  }
  if (type === "kernel-http-request") {
    const message2 = payload;
    if (message2.type === "kernel-http-request") {
      void command.bridge.handleRequest(message2.listenerId, message2.requestId, message2.request);
    }
    return true;
  }
  if (type === "kernel-http-abort-request") {
    const message2 = payload;
    if (message2.type === "kernel-http-abort-request") {
      command.bridge.abortRequest(message2.requestId);
    }
    return true;
  }
  if (type === "kernel-http-listen-result") {
    const message2 = payload;
    if (message2.type === "kernel-http-listen-result") {
      command.bridge.updateListenerInfo(message2.listenerId, message2.info);
    }
    return true;
  }
  if (type === "kernel-http-dispatch-result") {
    const message2 = payload;
    if (message2.type === "kernel-http-dispatch-result") {
      command.bridge.resolveDispatch(message2.requestId, message2.response);
    }
    return true;
  }
  if (type === "kernel-http-error") {
    const message2 = payload;
    if (message2.type === "kernel-http-error" && message2.requestId) {
      command.bridge.rejectDispatch(message2.requestId, message2.error);
    } else if (message2.type === "kernel-http-error" && message2.listenerId) {
      command.bridge.failListener(message2.listenerId, message2.error);
    }
    return true;
  }
  return false;
}
workerScope.onmessage = (event) => {
  const {
    id,
    type,
    payload,
    protocolToken,
    runnerOptions,
    kernelSyscallChannel,
    kernelSyscallGenerationBuffer
  } = event.data;
  if (!id) return;
  if (handleKernelHttpHostMessage(event.data)) return;
  if (type !== "execute-project-javascript") {
    postWorkerMessage({ id, type: "error", payload: { error: `Unsupported JavaScript project worker message: ${type}` } });
    return;
  }
  if (typeof protocolToken !== "string" || protocolToken.length === 0) {
    postWorkerMessage({ id, type: "error", payload: { error: "Missing JavaScript project worker protocol token." } });
    return;
  }
  const request = payload;
  const options = {
    allowDynamicEval: runnerOptions?.allowDynamicEval,
    projectUserAuthorityMode: runnerOptions?.projectUserAuthorityMode
  };
  const executionState = {
    cancelled: false,
    abortController: new AbortController()
  };
  let syscallClient;
  let asyncSyscallClient;
  if (kernelSyscallChannel) {
    syscallClient = new TraceKernelSharedSyscallClient(
      kernelSyscallChannel,
      () => postCommandMessage(
        postWorkerMessage,
        id,
        protocolToken,
        "kernel-syscall",
        {}
      )
    );
    executionState.kernelFileSystem = new TraceKernelRuntimeFileClient(
      syscallClient,
      {
        ...kernelSyscallGenerationBuffer ? {
          generation: new TraceKernelSharedGenerationSource(
            kernelSyscallGenerationBuffer
          )
        } : {}
      }
    );
    executionState.kernelSyscalls = syscallClient;
    asyncSyscallClient = new WorkerKernelAsyncSyscallClient(
      (requestId, request2) => postCommandMessage(
        postWorkerMessage,
        id,
        protocolToken,
        "kernel-syscall-async",
        { requestId, request: request2 }
      )
    );
    executionState.kernelNetwork = asyncSyscallClient;
  }
  const kernelHttp = new WorkerKernelHttpBridge((message) => {
    postCommandMessage(postWorkerMessage, id, protocolToken, message.type, message);
  });
  activeHttpBridges.set(id, {
    bridge: kernelHttp,
    protocolToken,
    executionState,
    ...syscallClient ? { syscallClient } : {},
    ...asyncSyscallClient ? { asyncSyscallClient } : {}
  });
  const clearActiveCommand = () => {
    activeHttpBridges.get(id)?.syscallClient?.close();
    activeHttpBridges.get(id)?.asyncSyscallClient?.close();
    activeHttpBridges.delete(id);
  };
  runBrowserJavaScriptProjectRequest(
    {
      ...request,
      kernelHttp,
      onEvent: (runtimeEvent) => {
        if (runtimeEvent.type === "status" && (runtimeEvent.phase === "process-start" || runtimeEvent.phase === "process-exit")) {
          return;
        }
        postCommandMessage(postWorkerMessage, id, protocolToken, "project-event", runtimeEvent);
      }
    },
    options,
    executionState
  ).then(
    (result) => {
      clearActiveCommand();
      postCommandMessage(postWorkerMessage, id, protocolToken, "execute-result", result);
    },
    (error) => {
      clearActiveCommand();
      postCommandMessage(postWorkerMessage, id, protocolToken, "error", { error: errorMessage(error) });
    }
  );
};
postWorkerMessage({ type: "worker-ready" });

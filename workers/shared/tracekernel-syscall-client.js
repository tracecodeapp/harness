"use strict";
(() => {
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
        const fd = reader.i32();
        const closeOnExec = reader.u8();
        if (closeOnExec > 1) {
          throw new TraceKernelTransportError(
            "EPROTO",
            "Invalid dup3 close-on-exec result"
          );
        }
        value = { op: "dup3", fd, closeOnExec: closeOnExec === 1 };
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
          for (const fd of request.inheritDescriptors) writer.i32(fd);
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
          const fd = reader.i32();
          const events = reader.u8();
          if ((events & ~31) !== 0) {
            throw new TraceKernelTransportError(
              "EPROTO",
              `invalid poll result mask ${events}`
            );
          }
          entries.push({
            fd,
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

  // packages/runtime-java/src/tracekernel-syscall-client-worker.ts
  Object.defineProperty(globalThis, "TraceCodeTraceKernelSharedSyscallClient", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: TraceKernelSharedSyscallClient
  });
})();

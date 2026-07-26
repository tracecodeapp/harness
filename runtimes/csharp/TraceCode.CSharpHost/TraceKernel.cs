using System.Buffers.Binary;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TraceKernel;

public sealed class TraceKernelException : IOException
{
    public TraceKernelException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    public string Code { get; }
}

public enum KernelSignal
{
    Interrupt,
    Terminate,
    Kill,
}

public enum StdioMode
{
    Pipe,
    Inherit,
    Ignore,
}

public sealed record WatchdogStatus(
    bool Armed,
    int? TimeoutMs,
    double? DeadlineAt,
    KernelSignal? Signal
);

[SupportedOSPlatform("browser")]
public static class Watchdog
{
    public static WatchdogStatus Arm(
        int timeoutMs,
        KernelSignal signal = KernelSignal.Terminate
    )
    {
        if (timeoutMs <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(timeoutMs),
                "Watchdog timeout must be positive."
            );
        }
        return ReadStatus(KernelInterop.Call(new
        {
            op = "watchdog",
            action = "arm",
            timeoutMs,
            signal = signal == KernelSignal.Kill ? "SIGKILL" : "SIGTERM",
        }));
    }

    public static WatchdogStatus Pet() =>
        ReadStatus(KernelInterop.Call(new
        {
            op = "watchdog",
            action = "pet",
        }));

    public static WatchdogStatus Disarm() =>
        ReadStatus(KernelInterop.Call(new
        {
            op = "watchdog",
            action = "disarm",
        }));

    public static WatchdogStatus Status() =>
        ReadStatus(KernelInterop.Call(new
        {
            op = "watchdog",
            action = "status",
        }));

    private static WatchdogStatus ReadStatus(JsonElement value)
    {
        bool armed = value.GetProperty("armed").GetBoolean();
        if (!armed)
        {
            return new WatchdogStatus(false, null, null, null);
        }
        string signal = value.GetProperty("signal").GetString() ?? "SIGTERM";
        return new WatchdogStatus(
            true,
            value.GetProperty("timeoutMs").GetInt32(),
            value.GetProperty("deadlineAt").GetDouble(),
            signal == "SIGKILL" ? KernelSignal.Kill : KernelSignal.Terminate
        );
    }
}

[SupportedOSPlatform("browser")]
public sealed class KernelDescriptor : IDisposable
{
    private bool closed;

    internal KernelDescriptor(int number)
    {
        if (number < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(number));
        }
        Number = number;
    }

    public int Number { get; }
    public bool IsClosed => closed;

    public byte[] Read(int maxBytes = 16 * 1024)
    {
        ThrowIfClosed();
        if (maxBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxBytes));
        }
        JsonElement value = KernelInterop.Call(new
        {
            op = "read",
            fd = Number,
            maxBytes,
        });
        return Convert.FromBase64String(
            value.GetProperty("bytes").GetString() ?? string.Empty
        );
    }

    public byte[] ReadToEnd(int chunkBytes = 16 * 1024)
    {
        using MemoryStream output = new();
        while (true)
        {
            byte[] bytes = Read(chunkBytes);
            if (bytes.Length == 0)
            {
                return output.ToArray();
            }
            output.Write(bytes);
        }
    }

    public string ReadToEndText(
        Encoding? encoding = null,
        int chunkBytes = 16 * 1024
    ) => (encoding ?? Encoding.UTF8).GetString(ReadToEnd(chunkBytes));

    public int Write(ReadOnlySpan<byte> bytes)
    {
        ThrowIfClosed();
        JsonElement value = KernelInterop.Call(new
        {
            op = "write",
            fd = Number,
            bytes = Convert.ToBase64String(bytes),
        });
        return value.GetProperty("bytesWritten").GetInt32();
    }

    public int WriteText(string text, Encoding? encoding = null) =>
        Write((encoding ?? Encoding.UTF8).GetBytes(text));

    public KernelDescriptor Duplicate()
    {
        ThrowIfClosed();
        JsonElement value = KernelInterop.Call(new
        {
            op = "dup",
            fd = Number,
        });
        return new KernelDescriptor(value.GetProperty("fd").GetInt32());
    }

    public KernelDescriptor DuplicateTo(
        int targetNumber,
        bool closeOnExec = false
    )
    {
        ThrowIfClosed();
        if (targetNumber < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(targetNumber));
        }
        if (targetNumber == Number)
        {
            if (closeOnExec)
            {
                throw new ArgumentException(
                    "dup3 source and target descriptors must differ.",
                    nameof(targetNumber)
                );
            }
            return this;
        }
        JsonElement value = KernelInterop.Call(new
        {
            op = closeOnExec ? "dup3" : "dup2",
            fd = Number,
            targetFd = targetNumber,
            closeOnExec,
        });
        return new KernelDescriptor(value.GetProperty("fd").GetInt32());
    }

    public bool CloseOnExec
    {
        get
        {
            ThrowIfClosed();
            JsonElement value = KernelInterop.Call(new
            {
                op = "fcntl",
                fd = Number,
                action = "get-close-on-exec",
            });
            return value.GetProperty("closeOnExec").GetBoolean();
        }
        set
        {
            ThrowIfClosed();
            KernelInterop.Call(new
            {
                op = "fcntl",
                fd = Number,
                action = "set-close-on-exec",
                closeOnExec = value,
            });
        }
    }

    public bool Inheritable
    {
        get => !CloseOnExec;
        set => CloseOnExec = !value;
    }

    public bool Nonblocking
    {
        get
        {
            ThrowIfClosed();
            JsonElement value = KernelInterop.Call(new
            {
                op = "fcntl",
                fd = Number,
                action = "get-nonblocking",
            });
            return value.GetProperty("nonblocking").GetBoolean();
        }
        set
        {
            ThrowIfClosed();
            KernelInterop.Call(new
            {
                op = "fcntl",
                fd = Number,
                action = "set-nonblocking",
                nonblocking = value,
            });
        }
    }

    public void Close()
    {
        if (closed)
        {
            return;
        }
        KernelInterop.Call(new
        {
            op = "close",
            fd = Number,
        });
        closed = true;
    }

    public void Dispose()
    {
        Close();
        GC.SuppressFinalize(this);
    }

    private void ThrowIfClosed()
    {
        if (closed)
        {
            throw new ObjectDisposedException(nameof(KernelDescriptor));
        }
    }
}

public sealed record KernelPipe(
    KernelDescriptor ReadEnd,
    KernelDescriptor WriteEnd
)
{
    [SupportedOSPlatform("browser")]
    public static KernelPipe Create(
        int capacityChunks = 16,
        bool closeOnExec = false,
        bool nonblocking = false
    )
    {
        if (capacityChunks <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(capacityChunks));
        }
        JsonElement value = KernelInterop.Call(new
        {
            op = "pipe",
            options = new { capacityChunks, closeOnExec, nonblocking },
        });
        return new KernelPipe(
            new KernelDescriptor(value.GetProperty("readFd").GetInt32()),
            new KernelDescriptor(value.GetProperty("writeFd").GetInt32())
        );
    }
}

[Flags]
public enum KernelPollEvents
{
    None = 0,
    Read = 1,
    Write = 2,
    Hangup = 4,
    Error = 8,
    Invalid = 16,
}

public sealed record KernelPollRequest(
    int Descriptor,
    KernelPollEvents Events
);

public sealed record KernelPollResult(
    int Descriptor,
    KernelPollEvents Events
);

[SupportedOSPlatform("browser")]
public static class KernelPoll
{
    private const KernelPollEvents RequestedEvents =
        KernelPollEvents.Read | KernelPollEvents.Write;

    public static IReadOnlyList<KernelPollResult> Wait(
        IEnumerable<KernelPollRequest> requests,
        int timeoutMs = -1
    )
    {
        ArgumentNullException.ThrowIfNull(requests);
        if (timeoutMs < -1)
        {
            throw new ArgumentOutOfRangeException(
                nameof(timeoutMs),
                "Poll timeout must be -1 (infinite) or non-negative."
            );
        }
        KernelPollRequest[] entries = requests.ToArray();
        foreach (KernelPollRequest entry in entries)
        {
            if (entry.Descriptor < 0)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(requests),
                    "Poll descriptors must be non-negative."
                );
            }
            if ((entry.Events & ~RequestedEvents) != 0)
            {
                throw new ArgumentException(
                    "Poll requests support only Read and Write events.",
                    nameof(requests)
                );
            }
        }
        Dictionary<string, object?> request = new()
        {
            ["op"] = "poll",
            ["entries"] = entries.Select(entry => new
            {
                fd = entry.Descriptor,
                read = (entry.Events & KernelPollEvents.Read) != 0,
                write = (entry.Events & KernelPollEvents.Write) != 0,
            }).ToArray(),
        };
        if (timeoutMs >= 0)
        {
            request["timeoutMs"] = timeoutMs;
        }
        JsonElement value = KernelInterop.Call(request);
        return value.GetProperty("entries")
            .EnumerateArray()
            .Select(entry =>
            {
                KernelPollEvents events = KernelPollEvents.None;
                if (entry.GetProperty("read").GetBoolean())
                {
                    events |= KernelPollEvents.Read;
                }
                if (entry.GetProperty("write").GetBoolean())
                {
                    events |= KernelPollEvents.Write;
                }
                if (entry.GetProperty("hangup").GetBoolean())
                {
                    events |= KernelPollEvents.Hangup;
                }
                if (entry.GetProperty("error").GetBoolean())
                {
                    events |= KernelPollEvents.Error;
                }
                if (entry.GetProperty("invalid").GetBoolean())
                {
                    events |= KernelPollEvents.Invalid;
                }
                return new KernelPollResult(
                    entry.GetProperty("fd").GetInt32(),
                    events
                );
            })
            .ToArray();
    }
}

public sealed record DescriptorMapping(
    int ParentDescriptor,
    int ChildDescriptor
);

public abstract record SpawnDescriptorAction
{
    private SpawnDescriptorAction()
    {
    }

    public sealed record Duplicate(int SourceDescriptor, int TargetDescriptor)
        : SpawnDescriptorAction;

    public sealed record Close(int Descriptor)
        : SpawnDescriptorAction;
}

public sealed class SpawnOptions
{
    public string? Cwd { get; init; }
    public IReadOnlyDictionary<string, string>? Environment { get; init; }
    public bool StartNewSession { get; init; }
    public bool InheritAllDescriptors { get; init; }
    public IReadOnlyList<int>? InheritDescriptors { get; init; }
    public IReadOnlyList<DescriptorMapping>? DescriptorMappings { get; init; }
    public IReadOnlyList<SpawnDescriptorAction>? DescriptorActions { get; init; }
    public int? ProcessGroupId { get; init; }
    public int? SessionId { get; init; }
    public StdioMode? StandardInput { get; init; }
    public StdioMode? StandardOutput { get; init; }
    public StdioMode? StandardError { get; init; }
}

public sealed record ProcessTermination(
    int Pid,
    string Kind,
    int ExitCode,
    KernelSignal? Signal,
    string? Message
);

[SupportedOSPlatform("browser")]
public sealed class KernelProcess
{
    private ProcessTermination? termination;

    private KernelProcess(
        int pid,
        KernelDescriptor? standardInput,
        KernelDescriptor? standardOutput,
        KernelDescriptor? standardError
    )
    {
        Pid = pid;
        StandardInput = standardInput;
        StandardOutput = standardOutput;
        StandardError = standardError;
    }

    public int Pid { get; }
    public KernelDescriptor? StandardInput { get; }
    public KernelDescriptor? StandardOutput { get; }
    public KernelDescriptor? StandardError { get; }
    public bool HasExited => termination is not null;
    public ProcessTermination? Termination => termination;

    public static KernelProcess Start(
        string runtime,
        string command,
        IEnumerable<string>? arguments = null,
        SpawnOptions? options = null
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(runtime);
        ArgumentException.ThrowIfNullOrWhiteSpace(command);
        options ??= new SpawnOptions();
        if (
            options.InheritAllDescriptors &&
            options.InheritDescriptors is not null
        )
        {
            throw new ArgumentException(
                "Select either all descriptors or an explicit descriptor list.",
                nameof(options)
            );
        }
        if (
            options.StartNewSession &&
            (options.ProcessGroupId is not null || options.SessionId is not null)
        )
        {
            throw new ArgumentException(
                "StartNewSession cannot be combined with explicit process-group or session identifiers.",
                nameof(options)
            );
        }
        object? inheritedDescriptors = options.InheritAllDescriptors
            ? "all"
            : options.InheritDescriptors;
        Dictionary<string, object?> request = new()
        {
            ["op"] = "spawn",
            ["runtime"] = runtime,
            ["command"] = command,
            ["args"] = arguments?.ToArray() ?? Array.Empty<string>(),
        };
        if (options.Cwd is not null)
        {
            request["cwd"] = options.Cwd;
        }
        if (options.Environment is not null)
        {
            request["env"] = options.Environment;
        }
        if (inheritedDescriptors is not null)
        {
            request["inheritDescriptors"] = inheritedDescriptors;
        }
        if (options.DescriptorMappings is not null)
        {
            request["descriptorMappings"] = options.DescriptorMappings
                .Select(mapping =>
                {
                    if (
                        mapping.ParentDescriptor < 0 ||
                        mapping.ChildDescriptor < 0
                    )
                    {
                        throw new ArgumentOutOfRangeException(
                            nameof(options),
                            "Descriptor mappings require non-negative fd numbers."
                        );
                    }
                    return new
                    {
                        parentFd = mapping.ParentDescriptor,
                        childFd = mapping.ChildDescriptor,
                    };
                })
                .ToArray();
        }
        if (options.DescriptorActions is not null)
        {
            request["descriptorActions"] = options.DescriptorActions
                .Select<SpawnDescriptorAction, object>(action => action switch
                {
                    SpawnDescriptorAction.Duplicate duplicate
                        when duplicate.SourceDescriptor >= 0 &&
                            duplicate.TargetDescriptor >= 0
                        => new
                        {
                            op = "dup2",
                            fd = duplicate.SourceDescriptor,
                            targetFd = duplicate.TargetDescriptor,
                        },
                    SpawnDescriptorAction.Close close
                        when close.Descriptor >= 0
                        => new
                        {
                            op = "close",
                            fd = close.Descriptor,
                        },
                    _ => throw new ArgumentOutOfRangeException(
                        nameof(options),
                        "Descriptor actions require non-negative fd numbers."
                    ),
                })
                .ToArray();
        }
        if (options.ProcessGroupId is not null)
        {
            request["processGroupId"] = options.ProcessGroupId;
        }
        if (options.SessionId is not null)
        {
            request["sessionId"] = options.SessionId;
        }
        if (options.StartNewSession)
        {
            request["processGroupId"] = 0;
            request["sessionId"] = 0;
        }
        if (
            options.StandardInput is not null ||
            options.StandardOutput is not null ||
            options.StandardError is not null
        )
        {
            request["stdio"] = new
            {
                stdin = StdioName(options.StandardInput),
                stdout = StdioName(options.StandardOutput),
                stderr = StdioName(options.StandardError),
            };
        }
        JsonElement value = KernelInterop.Call(request);
        int pid = value.GetProperty("pid").GetInt32();
        JsonElement stdio;
        if (!value.TryGetProperty("stdio", out stdio))
        {
            return new KernelProcess(pid, null, null, null);
        }
        return new KernelProcess(
            pid,
            ReadDescriptor(stdio, "stdinFd"),
            ReadDescriptor(stdio, "stdoutFd"),
            ReadDescriptor(stdio, "stderrFd")
        );
    }

    public ProcessTermination Wait()
    {
        if (termination is not null)
        {
            return termination;
        }
        JsonElement value = KernelInterop.Call(new
        {
            op = "wait",
            pid = Pid,
        });
        termination = ParseTermination(Pid, value.GetProperty("termination"));
        return termination;
    }

    public bool TryWait(out ProcessTermination? result)
    {
        if (termination is not null)
        {
            result = termination;
            return true;
        }
        JsonElement value = KernelInterop.Call(new
        {
            op = "wait",
            pid = Pid,
            noHang = true,
        });
        if (!value.TryGetProperty("termination", out JsonElement raw))
        {
            result = null;
            return false;
        }
        termination = ParseTermination(Pid, raw);
        result = termination;
        return true;
    }

    public static ProcessTermination WaitChild(int processSelector = -1)
    {
        JsonElement value = KernelInterop.Call(new
        {
            op = "wait",
            pid = processSelector,
        });
        return ParseTermination(
            value.GetProperty("pid").GetInt32(),
            value.GetProperty("termination")
        );
    }

    public static bool TryWaitChild(
        int processSelector,
        out ProcessTermination? result
    )
    {
        JsonElement value = KernelInterop.Call(new
        {
            op = "wait",
            pid = processSelector,
            noHang = true,
        });
        if (!value.TryGetProperty("termination", out JsonElement raw))
        {
            result = null;
            return false;
        }
        result = ParseTermination(
            value.GetProperty("pid").GetInt32(),
            raw
        );
        return true;
    }

    private static ProcessTermination ParseTermination(
        int pid,
        JsonElement raw
    )
    {
        string kind = raw.GetProperty("kind").GetString() ?? "failure";
        string? signal = raw.TryGetProperty("signal", out JsonElement signalValue)
            ? signalValue.GetString()
            : null;
        return new ProcessTermination(
            pid,
            kind,
            raw.GetProperty("exitCode").GetInt32(),
            signal switch
            {
                "SIGINT" => KernelSignal.Interrupt,
                "SIGTERM" => KernelSignal.Terminate,
                "SIGKILL" => KernelSignal.Kill,
                _ => null,
            },
            raw.TryGetProperty("message", out JsonElement message)
                ? message.GetString()
                : null
        );
    }

    public void Kill(KernelSignal signal = KernelSignal.Terminate)
        => Signal(Pid, signal);

    public static void Signal(
        int processSelector,
        KernelSignal signal = KernelSignal.Terminate
    )
    {
        KernelInterop.Call(new
        {
            op = "kill",
            pid = processSelector,
            signal = signal switch
            {
                KernelSignal.Interrupt => "SIGINT",
                KernelSignal.Kill => "SIGKILL",
                _ => "SIGTERM",
            },
        });
    }

    public static void SignalProcessGroup(
        int processGroupId,
        KernelSignal signal = KernelSignal.Terminate
    )
    {
        if (processGroupId <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(processGroupId),
                "A process-group identifier must be positive."
            );
        }
        Signal(-processGroupId, signal);
    }

    public static int CreateSession()
    {
        JsonElement value = KernelInterop.Call(new { op = "setsid" });
        return value.GetProperty("sid").GetInt32();
    }

    public static int SetCurrentProcessGroup(int processGroupId = 0)
    {
        if (processGroupId < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(processGroupId));
        }
        JsonElement value = KernelInterop.Call(new
        {
            op = "setpgid",
            pid = 0,
            pgid = processGroupId,
        });
        return value.GetProperty("pgid").GetInt32();
    }

    private static KernelDescriptor? ReadDescriptor(
        JsonElement stdio,
        string name
    ) => stdio.TryGetProperty(name, out JsonElement value)
        ? new KernelDescriptor(value.GetInt32())
        : null;

    private static string? StdioName(StdioMode? mode) => mode switch
    {
        StdioMode.Pipe => "pipe",
        StdioMode.Inherit => "inherit",
        StdioMode.Ignore => "ignore",
        _ => null,
    };
}

public sealed record KernelEndpoint(string Host, int Port);

public enum SocketShutdown
{
    Read,
    Write,
    Both,
}

[SupportedOSPlatform("browser")]
public static class KernelFileSystem
{
    public static void CreateHardLink(
        string existingPath,
        string newPath
    )
    {
        ValidatePath(existingPath, nameof(existingPath));
        ValidatePath(newPath, nameof(newPath));
        KernelInterop.Call(new
        {
            op = "link",
            existingPath,
            newPath,
        });
    }

    public static void CreateSymbolicLink(string target, string linkPath)
    {
        ValidatePath(target, nameof(target));
        ValidatePath(linkPath, nameof(linkPath));
        KernelInterop.Call(new
        {
            op = "symlink",
            target,
            linkPath,
        });
    }

    public static string ReadLink(string path)
    {
        ValidatePath(path, nameof(path));
        JsonElement value = KernelInterop.Call(new
        {
            op = "readlink",
            path,
        });
        return value.GetProperty("target").GetString() ?? string.Empty;
    }

    public static string RealPath(string path)
    {
        ValidatePath(path, nameof(path));
        JsonElement value = KernelInterop.Call(new
        {
            op = "realpath",
            path,
        });
        return value.GetProperty("path").GetString() ?? string.Empty;
    }

    private static void ValidatePath(string path, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException(
                "TraceKernel path must not be empty.",
                parameterName
            );
        }
    }
}

public sealed record KernelFileWatchEvent(string EventType, string Path);

[SupportedOSPlatform("browser")]
public sealed class KernelFileWatcher : IDisposable
{
    private static readonly byte[] FrameMagic = [0x54, 0x4b, 0x57, 0x31];
    private const int HeaderBytes = 9;
    private const int MaxPathBytes = 16 * 1024;
    private readonly KernelDescriptor descriptor;

    private KernelFileWatcher(KernelDescriptor descriptor)
    {
        this.descriptor = descriptor;
    }

    public int Descriptor => descriptor.Number;
    public bool IsClosed => descriptor.IsClosed;

    public static KernelFileWatcher Create(
        string path,
        bool recursive = false,
        int capacityEvents = 1024
    )
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException(
                "Watch path must not be empty.",
                nameof(path)
            );
        }
        if (capacityEvents <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(capacityEvents));
        }
        JsonElement value = KernelInterop.Call(new
        {
            op = "watch",
            path,
            options = new { recursive, capacityEvents },
        });
        return new KernelFileWatcher(
            new KernelDescriptor(value.GetProperty("fd").GetInt32())
        );
    }

    public KernelFileWatchEvent ReadEvent()
    {
        byte[] header = ReadExact(HeaderBytes);
        if (!header.AsSpan(0, 4).SequenceEqual(FrameMagic))
        {
            throw new TraceKernelException(
                "EPROTO",
                "Invalid TraceKernel filesystem-watch frame."
            );
        }
        byte eventCode = header[4];
        if (eventCode is < 1 or > 3)
        {
            throw new TraceKernelException(
                "EPROTO",
                $"Invalid TraceKernel filesystem-watch event {eventCode}."
            );
        }
        int pathLength = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(
            header.AsSpan(5, 4)
        ));
        if (pathLength < 0 || pathLength > MaxPathBytes)
        {
            throw new TraceKernelException(
                "EPROTO",
                "Invalid TraceKernel filesystem-watch path length."
            );
        }
        string path = pathLength == 0
            ? string.Empty
            : Encoding.UTF8.GetString(ReadExact(pathLength));
        return new KernelFileWatchEvent(
            eventCode == 1
                ? "change"
                : eventCode == 2
                    ? "rename"
                    : "overflow",
            path
        );
    }

    public void Dispose()
    {
        descriptor.Dispose();
        GC.SuppressFinalize(this);
    }

    private byte[] ReadExact(int length)
    {
        byte[] output = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            byte[] bytes = descriptor.Read(length - offset);
            if (bytes.Length == 0)
            {
                throw new TraceKernelException(
                    "EPROTO",
                    "TraceKernel filesystem-watch frame ended early."
                );
            }
            bytes.CopyTo(output, offset);
            offset += bytes.Length;
        }
        return output;
    }
}

[SupportedOSPlatform("browser")]
public sealed class KernelSocket : IDisposable
{
    private bool closed;
    private KernelEndpoint? localEndpoint;
    private KernelEndpoint? remoteEndpoint;

    private KernelSocket(
        int descriptor,
        KernelEndpoint? localEndpoint = null,
        KernelEndpoint? remoteEndpoint = null
    )
    {
        Descriptor = descriptor;
        this.localEndpoint = localEndpoint;
        this.remoteEndpoint = remoteEndpoint;
    }

    public int Descriptor { get; }
    public bool IsClosed => closed;
    public bool Nonblocking
    {
        get
        {
            ThrowIfClosed();
            JsonElement value = KernelInterop.Call(new
            {
                op = "fcntl",
                fd = Descriptor,
                action = "get-nonblocking",
            });
            return value.GetProperty("nonblocking").GetBoolean();
        }
        set
        {
            ThrowIfClosed();
            KernelInterop.Call(new
            {
                op = "fcntl",
                fd = Descriptor,
                action = "set-nonblocking",
                nonblocking = value,
            });
        }
    }

    public static KernelSocket Create()
    {
        JsonElement value = KernelInterop.Call(new { op = "socket" });
        return new KernelSocket(value.GetProperty("fd").GetInt32());
    }

    public KernelEndpoint Bind(string host, int port)
    {
        ThrowIfClosed();
        ValidateEndpoint(host, port, allowEphemeral: true);
        JsonElement value = KernelInterop.Call(new
        {
            op = "bind",
            fd = Descriptor,
            address = new { host, port },
        });
        localEndpoint = ReadEndpoint(value.GetProperty("address"));
        return localEndpoint;
    }

    public void Listen(int backlog = 128, int capacityChunks = 16)
    {
        ThrowIfClosed();
        if (backlog <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(backlog));
        }
        if (capacityChunks <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(capacityChunks));
        }
        KernelInterop.Call(new
        {
            op = "listen",
            fd = Descriptor,
            options = new { backlog, capacityChunks },
        });
    }

    public KernelSocket Accept()
    {
        ThrowIfClosed();
        JsonElement value = KernelInterop.Call(new
        {
            op = "accept",
            fd = Descriptor,
        });
        return new KernelSocket(
            value.GetProperty("fd").GetInt32(),
            ReadEndpoint(value.GetProperty("localAddress")),
            ReadEndpoint(value.GetProperty("remoteAddress"))
        );
    }

    public void Connect(string host, int port)
    {
        ThrowIfClosed();
        ValidateEndpoint(host, port, allowEphemeral: false);
        JsonElement value = KernelInterop.Call(new
        {
            op = "connect",
            fd = Descriptor,
            address = new { host, port },
        });
        localEndpoint = ReadEndpoint(value.GetProperty("localAddress"));
        remoteEndpoint = ReadEndpoint(value.GetProperty("remoteAddress"));
    }

    public int Send(ReadOnlySpan<byte> bytes)
    {
        ThrowIfClosed();
        JsonElement value = KernelInterop.Call(new
        {
            op = "send",
            fd = Descriptor,
            bytes = Convert.ToBase64String(bytes),
        });
        return value.GetProperty("bytesWritten").GetInt32();
    }

    public void SendAll(ReadOnlySpan<byte> bytes)
    {
        int offset = 0;
        while (offset < bytes.Length)
        {
            int written = Send(bytes[offset..]);
            if (written <= 0)
            {
                throw new TraceKernelException(
                    "EPIPE",
                    "TraceKernel socket send made no forward progress."
                );
            }
            offset += written;
        }
    }

    public void SendText(string text, Encoding? encoding = null) =>
        SendAll((encoding ?? Encoding.UTF8).GetBytes(text));

    public byte[] Receive(int maxBytes = 16 * 1024)
    {
        ThrowIfClosed();
        if (maxBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxBytes));
        }
        JsonElement value = KernelInterop.Call(new
        {
            op = "recv",
            fd = Descriptor,
            maxBytes,
        });
        return Convert.FromBase64String(
            value.GetProperty("bytes").GetString() ?? string.Empty
        );
    }

    public string ReceiveText(
        int maxBytes = 16 * 1024,
        Encoding? encoding = null
    ) => (encoding ?? Encoding.UTF8).GetString(Receive(maxBytes));

    public KernelEndpoint GetLocalEndpoint()
    {
        ThrowIfClosed();
        if (localEndpoint is not null)
        {
            return localEndpoint;
        }
        JsonElement value = KernelInterop.Call(new
        {
            op = "getsockname",
            fd = Descriptor,
        });
        localEndpoint = ReadEndpoint(value.GetProperty("address"));
        return localEndpoint;
    }

    public KernelEndpoint GetRemoteEndpoint()
    {
        ThrowIfClosed();
        if (remoteEndpoint is not null)
        {
            return remoteEndpoint;
        }
        JsonElement value = KernelInterop.Call(new
        {
            op = "getpeername",
            fd = Descriptor,
        });
        remoteEndpoint = ReadEndpoint(value.GetProperty("address"));
        return remoteEndpoint;
    }

    /// <summary>
    /// Returns and clears the asynchronous connect error, matching
    /// getsockopt(SO_ERROR). A null result means no pending socket error.
    /// </summary>
    public string? GetAndClearConnectError()
    {
        ThrowIfClosed();
        JsonElement value = KernelInterop.Call(new
        {
            op = "getsockopt",
            fd = Descriptor,
            option = "error",
        });
        return value.TryGetProperty("error", out JsonElement error)
            ? error.GetString()
            : null;
    }

    public void Shutdown(SocketShutdown how = SocketShutdown.Both)
    {
        ThrowIfClosed();
        KernelInterop.Call(new
        {
            op = "shutdown",
            fd = Descriptor,
            how = how switch
            {
                SocketShutdown.Read => "read",
                SocketShutdown.Write => "write",
                _ => "both",
            },
        });
    }

    public void Close()
    {
        if (closed)
        {
            return;
        }
        KernelInterop.Call(new
        {
            op = "close",
            fd = Descriptor,
        });
        closed = true;
    }

    public void Dispose()
    {
        Close();
        GC.SuppressFinalize(this);
    }

    private static KernelEndpoint ReadEndpoint(JsonElement value) =>
        new(
            value.GetProperty("host").GetString() ?? "127.0.0.1",
            value.GetProperty("port").GetInt32()
        );

    private static void ValidateEndpoint(
        string host,
        int port,
        bool allowEphemeral
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(host);
        int minimum = allowEphemeral ? 0 : 1;
        if (port < minimum || port > 65535)
        {
            throw new ArgumentOutOfRangeException(nameof(port));
        }
    }

    private void ThrowIfClosed()
    {
        if (closed)
        {
            throw new ObjectDisposedException(nameof(KernelSocket));
        }
    }
}

internal static partial class KernelInterop
{
    private static readonly JsonSerializerOptions JsonOptions = new(
        JsonSerializerDefaults.Web
    )
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    [JSImport("kernelSyscall", "tracecode")]
    private static partial string KernelSyscall(string requestJson);

    [SupportedOSPlatform("browser")]
    internal static JsonElement Call(object request)
    {
        string responseJson = KernelSyscall(
            JsonSerializer.Serialize(request, JsonOptions)
        );
        using JsonDocument response = JsonDocument.Parse(responseJson);
        JsonElement root = response.RootElement;
        if (!root.GetProperty("ok").GetBoolean())
        {
            JsonElement error = root.GetProperty("error");
            throw new TraceKernelException(
                error.GetProperty("code").GetString() ?? "EIO",
                error.GetProperty("message").GetString() ??
                    "TraceKernel syscall failed."
            );
        }
        return root.GetProperty("value").Clone();
    }
}

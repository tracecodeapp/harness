using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
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
    Terminate,
    Kill,
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

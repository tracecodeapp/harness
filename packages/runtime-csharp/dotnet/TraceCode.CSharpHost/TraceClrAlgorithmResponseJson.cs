using System;
using System.IO;
using System.Text;
using System.Text.Json;

namespace TraceCode.CSharpHost;

public static class TraceClrAlgorithmResponseJson
{
    private static readonly JsonSerializerOptions FallbackOptions =
        new(JsonSerializerDefaults.Web)
        {
            IncludeFields = true,
            MaxDepth = 256,
        };

    public static Func<RuntimeTraceEvent, int>? CreateTraceEventMeasurer(int maxTraceBytes) =>
        maxTraceBytes > 0 ? TraceResponseJson.CreateTraceEventMeasurer(FallbackOptions) : null;

    public static string Serialize(TraceClrAlgorithmExecutionResult result)
    {
        if (result.ObserverEncodingFailed) return TraceResponseJson.ObserverEncodeFailure;
        using MemoryStream buffer = new();
        using (Utf8JsonWriter writer = new(buffer))
        {
            writer.WriteStartObject();
            writer.WriteBoolean("success", result.Success);
            if (result.OutputBytes is not null)
            {
                writer.WriteBase64String("outputBytes", result.OutputBytes);
            }
            if (result.Error is null)
            {
                writer.WriteNull("error");
            }
            else
            {
                writer.WriteString("error", result.Error);
            }
            writer.WriteStartArray("events");
            foreach (RuntimeTraceEvent traceEvent in result.Events)
            {
                if (!TraceResponseJson.TryWriteTraceEvent(writer, traceEvent, FallbackOptions))
                {
                    return TraceResponseJson.ObserverEncodeFailure;
                }
            }
            writer.WriteEndArray();
            writer.WriteBoolean(
                "traceLimitExceeded",
                result.TraceLimitExceeded
            );
            if (result.TimeoutReason is null)
            {
                writer.WriteNull("timeoutReason");
            }
            else
            {
                writer.WriteString("timeoutReason", result.TimeoutReason);
            }
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
    }
}

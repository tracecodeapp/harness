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

    public static string Serialize(TraceClrAlgorithmExecutionResult result)
    {
        using MemoryStream buffer = new();
        using (Utf8JsonWriter writer = new(buffer))
        {
            writer.WriteStartObject();
            writer.WriteBoolean("success", true);
            writer.WriteBase64String("outputBytes", result.OutputBytes);
            writer.WriteStartArray("events");
            foreach (RuntimeTraceEvent traceEvent in result.Events)
            {
                TraceResponseJson.WriteTraceEvent(
                    writer,
                    traceEvent,
                    FallbackOptions
                );
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

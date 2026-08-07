using System.Text.Json;

namespace TraceCode.CSharpHost;

// Reflection-based System.Text.Json cannot be AOT-compiled for these
// object-graph payloads and runs interpreted under wasm, costing ~40us per
// trace event on heavy responses. The known event shapes are written directly;
// only unrecognized leaf values fall back to the reflection serializer.
public static class TraceResponseJson
{
    public static void WriteTraceEvent(Utf8JsonWriter writer, RuntimeTraceEvent traceEvent, JsonSerializerOptions fallbackOptions)
    {
        writer.WriteStartObject();
        writer.WriteString("kind", traceEvent.Kind);
        writer.WriteString("runId", traceEvent.RunId);
        writer.WriteString("file", traceEvent.File);
        if (traceEvent.Line is int line) writer.WriteNumber("line", line);
        else writer.WriteNull("line");
        if (traceEvent.Function is null) writer.WriteNull("function");
        else writer.WriteString("function", traceEvent.Function);
        writer.WritePropertyName("target");
        if (traceEvent.Target is null) writer.WriteNullValue();
        else WriteTraceTarget(writer, traceEvent.Target, fallbackOptions);
        writer.WritePropertyName("value");
        WriteNormalizedValue(writer, traceEvent.Value, fallbackOptions);
        if (traceEvent.Method is null) writer.WriteNull("method");
        else writer.WriteString("method", traceEvent.Method);
        writer.WritePropertyName("args");
        WriteNormalizedValue(writer, traceEvent.Args, fallbackOptions);
        if (traceEvent.Binding is not null)
        {
            writer.WriteStartObject("binding");
            if (traceEvent.Binding.Kind is null) writer.WriteNull("kind");
            else writer.WriteString("kind", traceEvent.Binding.Kind);
            writer.WriteString("variable", traceEvent.Binding.Variable);
            writer.WriteEndObject();
        }
        if (traceEvent.Message is null) writer.WriteNull("message");
        else writer.WriteString("message", traceEvent.Message);
        if (traceEvent.Text is not null) writer.WriteString("text", traceEvent.Text);
        if (traceEvent.Reason is not null) writer.WriteString("reason", traceEvent.Reason);
        if (traceEvent.CallStackId is int callStackId)
        {
            writer.WriteNumber("callStackId", callStackId);
        }

        if (traceEvent.CallStackRef is int callStackRef)
        {
            writer.WriteNumber("callStackRef", callStackRef);
        }

        if (traceEvent.CallStack is not null)
        {
            writer.WriteStartArray("callStack");
            foreach (RuntimeTraceCallFrame frame in traceEvent.CallStack)
            {
                writer.WriteStartObject();
                writer.WriteString("function", frame.Function);
                if (frame.Line is int frameLine) writer.WriteNumber("line", frameLine);
                else writer.WriteNull("line");
                if (frame.Args is not null)
                {
                    writer.WritePropertyName("args");
                    WriteNormalizedValue(writer, frame.Args, fallbackOptions);
                }
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        writer.WriteEndObject();
    }

    public static void WriteTraceTarget(Utf8JsonWriter writer, RuntimeTraceTarget target, JsonSerializerOptions fallbackOptions)
    {
        writer.WriteStartObject();
        writer.WriteString("variable", target.Variable);
        writer.WritePropertyName("path");
        if (target.Path is null) writer.WriteNullValue();
        else
        {
            writer.WriteStartArray();
            foreach (object? component in target.Path)
            {
                WriteNormalizedValue(writer, component, fallbackOptions);
            }
            writer.WriteEndArray();
        }
        if (target.IndexSources is not null)
        {
            writer.WriteStartArray("indexSources");
            foreach (string? source in target.IndexSources)
            {
                if (source is null) writer.WriteNullValue();
                else writer.WriteStringValue(source);
            }
            writer.WriteEndArray();
        }
        writer.WriteEndObject();
    }

    public static void WriteNormalizedValue(Utf8JsonWriter writer, object? value, JsonSerializerOptions fallbackOptions)
    {
        switch (value)
        {
            case null:
                writer.WriteNullValue();
                break;
            case string text:
                writer.WriteStringValue(text);
                break;
            case bool flag:
                writer.WriteBooleanValue(flag);
                break;
            case int number:
                writer.WriteNumberValue(number);
                break;
            case long number:
                writer.WriteNumberValue(number);
                break;
            case double number:
                writer.WriteNumberValue(number);
                break;
            case float number:
                writer.WriteNumberValue(number);
                break;
            case decimal number:
                writer.WriteNumberValue(number);
                break;
            case byte number:
                writer.WriteNumberValue(number);
                break;
            case sbyte number:
                writer.WriteNumberValue(number);
                break;
            case short number:
                writer.WriteNumberValue(number);
                break;
            case ushort number:
                writer.WriteNumberValue(number);
                break;
            case uint number:
                writer.WriteNumberValue(number);
                break;
            case ulong number:
                writer.WriteNumberValue(number);
                break;
            case System.Collections.Generic.Dictionary<string, object?> map:
                writer.WriteStartObject();
                foreach (System.Collections.Generic.KeyValuePair<string, object?> entry in map)
                {
                    writer.WritePropertyName(entry.Key);
                    WriteNormalizedValue(writer, entry.Value, fallbackOptions);
                }
                writer.WriteEndObject();
                break;
            case System.Collections.Generic.List<object?> list:
                writer.WriteStartArray();
                foreach (object? item in list)
                {
                    WriteNormalizedValue(writer, item, fallbackOptions);
                }
                writer.WriteEndArray();
                break;
            case object?[] array:
                writer.WriteStartArray();
                foreach (object? item in array)
                {
                    WriteNormalizedValue(writer, item, fallbackOptions);
                }
                writer.WriteEndArray();
                break;
            default:
                JsonSerializer.Serialize(writer, value, fallbackOptions);
                break;
        }
    }
}

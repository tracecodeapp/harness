namespace TraceCode.CSharpHost;

/// <summary>
/// Per-run input authority for the trusted Judge runtime.
///
/// The compiler never writes this state. A disposable runner sets it immediately
/// before invoking one learner assembly and clears it during teardown.
/// </summary>
public static class JudgeRuntimeContext
{
    private static string currentInputsJson = "{}";

    public static string GetCurrentInputsJson() => currentInputsJson;

    public static void SetCurrentInputsJson(string inputsJson)
    {
        currentInputsJson = string.IsNullOrWhiteSpace(inputsJson) ? "{}" : inputsJson;
    }

    public static void Reset()
    {
        currentInputsJson = "{}";
        RuntimeTraceSink.Reset();
    }
}

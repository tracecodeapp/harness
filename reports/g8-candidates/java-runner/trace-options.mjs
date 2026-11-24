export function selectTraceOptions(traceBudget, controls, candidateJavaRuntime) {
  return Object.fromEntries(Object.entries(traceBudget)
    .filter(([key]) => candidateJavaRuntime || controls[key]));
}

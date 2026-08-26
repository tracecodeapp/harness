/**
 * Python Harness Code
 *
 * Shared Python harness helpers for scripts and Node-side validation paths.
 *
 * Canonical source:
 * - packages/runtime-python/src/python-harness-template.ts
 *
 * Generated artifacts (via scripts/generate-python-harness-artifacts.ts):
 * - packages/runtime-python/src/generated/python-harness-snippets.ts (consumed here)
 * - workers/python/generated-python-harness-snippets.js
 *
 * Note: workers/python/python-worker.js still contains runtime-specific embedded
 * harness code. Keep it aligned via:
 *   pnpm test:python-harness-sync
 */

import {
  toPythonLiteral,
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_PRACTICE_MATERIALIZE_SERIALIZE_FUNCTION,
  PYTHON_INTERVIEW_MATERIALIZE_SERIALIZE_FUNCTION,
  PYTHON_SERIALIZE_FUNCTION,
} from './generated/python-harness-snippets';

export {
  toPythonLiteral,
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_PRACTICE_MATERIALIZE_SERIALIZE_FUNCTION,
  PYTHON_INTERVIEW_MATERIALIZE_SERIALIZE_FUNCTION,
  PYTHON_SERIALIZE_FUNCTION,
};

export function identifyConversions(inputs: Record<string, unknown>): {
  treeKeys: string[];
  listKeys: string[];
} {
  const treeKeys: string[] = [];
  const listKeys: string[] = [];
  
  for (const [key, value] of Object.entries(inputs)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      ('val' in (value as Record<string, unknown>) || 'value' in (value as Record<string, unknown>))
    ) {
      const obj = value as Record<string, unknown>;
      const hasLeft = 'left' in obj;
      const hasRight = 'right' in obj;
      const hasNext = 'next' in obj;
      
      if (hasLeft || hasRight) {
        treeKeys.push(key);
      } else if (hasNext) {
        listKeys.push(key);
      } else {
        // Default to tree for backwards compatibility (just 'val')
        treeKeys.push(key);
      }
    }
  }
  
  return { treeKeys, listKeys };
}

/**
 * Generate Python code for converting tree/list inputs.
 */
export function generateConversionCode(inputs: Record<string, unknown>): string {
  const { treeKeys, listKeys } = identifyConversions(inputs);
  
  const lines: string[] = [];
  
  for (const key of treeKeys) {
    lines.push(`${key} = _dict_to_tree(${key})`);
  }
  
  for (const key of listKeys) {
    lines.push(`${key} = _dict_to_list(${key})`);
  }
  
  return lines.join('\n');
}

/**
 * Generate Python code for setting up inputs.
 */
export function generateInputSetup(inputs: Record<string, unknown>): string {
  return Object.entries(inputs)
    .map(([key, value]) => `${key} = ${toPythonLiteral(value)}`)
    .join('\n');
}

/**
 * Generate a complete Python script for running a solution.
 * This is used by the validation script to run solutions via subprocess.
 */
export function generateSolutionScript(
  solutionCode: string,
  functionName: string,
  inputs: Record<string, unknown>
): string {
  const inputSetup = generateInputSetup(inputs);
  const conversionCode = generateConversionCode(inputs);
  const paramList = Object.keys(inputs)
    .map((key) => `${key}=${key}`)
    .join(', ');
  
  return `
import json
import math
import sys
import builtins as _builtins
from typing import *

${PYTHON_CLASS_DEFINITIONS}

${PYTHON_CONVERSION_HELPERS}

${PYTHON_SERIALIZE_FUNCTION}

# Set up inputs
${inputSetup}

# Convert tree/list inputs
${conversionCode}

# Execute learner definitions while trusted finalization stays in this active
# function frame. Learner globals may replace the public helper names, but they
# cannot replace the already-bound serializer, limit type, encoder, or emitter.
def _tracecode_run_solution(
    source,
    function_name,
    _trusted_serialize=_serialize,
    _trusted_limit_type=_TracecodeSerializationLimit,
    _trusted_encode=json.JSONEncoder().encode,
    _trusted_print=_builtins.print,
    _trusted_exception_type=_builtins.Exception,
    _trusted_type=_builtins.type,
):
    try:
        exec(compile(source, 'solution.py', 'exec'), globals())
        _result = globals()[function_name](${paramList})
        _payload = {"success": True, "output": _trusted_serialize(_result)}
    except _trusted_limit_type:
        _payload = {
            "success": False,
            "error": "Execution stopped: resource limit exceeded (serialization-limit).",
            "timeoutReason": "serialization-limit",
        }
    except _trusted_exception_type as error:
        _payload = {
            "success": False,
            "error": f"{_trusted_type(error).__name__}: {str(error)}",
        }
    _trusted_print(_trusted_encode(_payload))

_tracecode_run_solution(
    ${toPythonLiteral(solutionCode)},
    ${toPythonLiteral(functionName)},
)
`;
}

import type { Language, LanguageRuntimeProfile } from '../../harness-core/src/runtime-types';

const PYTHON_RUNTIME_PROFILE: LanguageRuntimeProfile = {
  language: 'python',
  maturity: 'stable',
  capabilities: {
    execution: {
      styles: {
        function: true,
        solutionMethod: true,
        opsClass: true,
        script: true,
        interviewMode: true,
      },
      timeouts: {
        clientTimeouts: true,
        runtimeTimeouts: true,
      },
    },
    tracing: {
      supported: true,
      events: {
        line: true,
        call: true,
        return: true,
        exception: true,
        stdout: true,
        timeout: true,
      },
      controls: {
        maxTraceSteps: true,
        maxLineEvents: true,
        maxSingleLineHits: true,
        maxStoredEvents: true,
        minimalTrace: true,
      },
      fidelity: {
        preciseLineMapping: true,
        stableFunctionNames: true,
        callStack: true,
      },
    },
    diagnostics: {
      compileErrors: false,
      runtimeErrors: true,
      mappedErrorLines: true,
      stackTraces: false,
    },
    structures: {
      treeNodeRefs: true,
      listNodeRefs: true,
      mapSerialization: true,
      setSerialization: true,
      graphSerialization: true,
      cycleReferences: true,
    },
  },
};

const JAVASCRIPT_RUNTIME_PROFILE: LanguageRuntimeProfile = {
  language: 'javascript',
  maturity: 'stable',
  capabilities: {
    execution: {
      styles: {
        function: true,
        solutionMethod: true,
        opsClass: true,
        script: true,
        interviewMode: true,
      },
      timeouts: {
        clientTimeouts: true,
        runtimeTimeouts: false,
      },
    },
    tracing: {
      supported: true,
      events: {
        line: true,
        call: true,
        return: true,
        exception: true,
        stdout: false,
        timeout: true,
      },
      controls: {
        maxTraceSteps: true,
        maxLineEvents: true,
        maxSingleLineHits: true,
        maxStoredEvents: true,
        minimalTrace: true,
      },
      fidelity: {
        preciseLineMapping: true,
        stableFunctionNames: true,
        callStack: true,
      },
    },
    diagnostics: {
      compileErrors: false,
      runtimeErrors: true,
      mappedErrorLines: false,
      stackTraces: false,
    },
    structures: {
      treeNodeRefs: true,
      listNodeRefs: true,
      mapSerialization: true,
      setSerialization: true,
      graphSerialization: true,
      cycleReferences: true,
    },
  },
};

const TYPESCRIPT_RUNTIME_PROFILE: LanguageRuntimeProfile = {
  language: 'typescript',
  maturity: 'stable',
  capabilities: {
    execution: {
      styles: {
        function: true,
        solutionMethod: true,
        opsClass: true,
        script: true,
        interviewMode: true,
      },
      timeouts: {
        clientTimeouts: true,
        runtimeTimeouts: false,
      },
    },
    tracing: {
      supported: true,
      events: {
        line: true,
        call: true,
        return: true,
        exception: true,
        stdout: false,
        timeout: true,
      },
      controls: {
        maxTraceSteps: true,
        maxLineEvents: true,
        maxSingleLineHits: true,
        maxStoredEvents: true,
        minimalTrace: true,
      },
      fidelity: {
        preciseLineMapping: true,
        stableFunctionNames: true,
        callStack: true,
      },
    },
    diagnostics: {
      compileErrors: true,
      runtimeErrors: true,
      mappedErrorLines: true,
      stackTraces: false,
    },
    structures: {
      treeNodeRefs: true,
      listNodeRefs: true,
      mapSerialization: true,
      setSerialization: true,
      graphSerialization: true,
      cycleReferences: true,
    },
  },
};

const JAVA_RUNTIME_PROFILE: LanguageRuntimeProfile = {
  language: 'java',
  maturity: 'experimental',
  capabilities: {
    execution: {
      styles: {
        function: true,
        solutionMethod: true,
        opsClass: true,
        script: true,
        interviewMode: true,
      },
      timeouts: {
        clientTimeouts: true,
        runtimeTimeouts: true,
      },
    },
    tracing: {
      supported: true,
      events: {
        line: true,
        call: true,
        return: true,
        exception: true,
        stdout: false,
        timeout: true,
      },
      controls: {
        maxTraceSteps: true,
        maxLineEvents: false,
        maxSingleLineHits: false,
        maxStoredEvents: true,
        minimalTrace: false,
      },
      fidelity: {
        preciseLineMapping: true,
        stableFunctionNames: true,
        callStack: true,
      },
    },
    diagnostics: {
      compileErrors: true,
      runtimeErrors: true,
      mappedErrorLines: false,
      stackTraces: true,
    },
    structures: {
      treeNodeRefs: true,
      listNodeRefs: true,
      mapSerialization: true,
      setSerialization: true,
      graphSerialization: false,
      cycleReferences: true,
    },
  },
  notes: [
    'Java currently supports the browser-local Java 17 lane for function, solution-method, ops-class, and script-style execution.',
    'Interview-mode Java reuses the same browser-local execution path and remains experimental.',
    'Script-style Java uses an empty function name with executionStyle="function" and reads the top-level result variable.',
  ],
};

const CSHARP_RUNTIME_PROFILE: LanguageRuntimeProfile = {
  language: 'csharp',
  maturity: 'experimental',
  capabilities: {
    execution: {
      styles: {
        function: true,
        solutionMethod: true,
        opsClass: true,
        script: true,
        interviewMode: true,
      },
      timeouts: {
        clientTimeouts: true,
        runtimeTimeouts: true,
      },
    },
    tracing: {
      supported: true,
      events: {
        line: true,
        call: true,
        return: true,
        exception: true,
        stdout: true,
        timeout: true,
      },
      controls: {
        maxTraceSteps: true,
        maxLineEvents: true,
        maxSingleLineHits: true,
        maxStoredEvents: true,
        minimalTrace: true,
      },
      fidelity: {
        preciseLineMapping: true,
        stableFunctionNames: true,
        callStack: true,
      },
    },
    diagnostics: {
      compileErrors: true,
      runtimeErrors: true,
      mappedErrorLines: true,
      stackTraces: false,
    },
    structures: {
      treeNodeRefs: true,
      listNodeRefs: true,
      mapSerialization: true,
      setSerialization: true,
      graphSerialization: true,
      cycleReferences: true,
    },
  },
  notes: [
    'C# support is browser-local and experimental.',
    'C# supports named function-style requests where the browser-local host can bind the named method.',
    'Script-style C# uses an empty function name with executionStyle="function" and reads the top-level result variable.',
    'Interview-mode C# uses the same browser-local worker execution path with interview timeout normalization.',
    'The first C# slice supports LeetCode-style public class Solution methods.',
    'ListNode and TreeNode inputs are hydrated from LeetCode-style arrays or object-shaped JSON.',
    'Dictionary, HashSet, List, and array return values serialize through the browser-local worker.',
    'Tracing currently supports line, call, return, stdout, and simple local variable write events.',
    'Structural visualization is added after execution and diagnostics are proven.',
  ],
};

const CPP_RUNTIME_PROFILE: LanguageRuntimeProfile = {
  language: 'cpp',
  maturity: 'experimental',
  capabilities: {
    execution: {
      styles: {
        function: true,
        solutionMethod: true,
        opsClass: true,
        script: true,
        interviewMode: true,
      },
      timeouts: {
        clientTimeouts: true,
        runtimeTimeouts: true,
      },
    },
    tracing: {
      supported: true,
      events: {
        line: true,
        call: true,
        return: true,
        exception: true,
        stdout: true,
        timeout: true,
      },
      controls: {
        maxTraceSteps: true,
        maxLineEvents: true,
        maxSingleLineHits: true,
        maxStoredEvents: true,
        minimalTrace: true,
      },
      fidelity: {
        preciseLineMapping: true,
        stableFunctionNames: true,
        callStack: true,
      },
    },
    diagnostics: {
      compileErrors: true,
      runtimeErrors: true,
      mappedErrorLines: true,
      stackTraces: false,
    },
    structures: {
      treeNodeRefs: true,
      listNodeRefs: true,
      mapSerialization: true,
      setSerialization: true,
      graphSerialization: true,
      cycleReferences: true,
    },
  },
  notes: [
    'C++ uses a focused browser-local Clang/LLD/WASI compiler lane with TraceCode-owned execution glue.',
    'The runtime intentionally does not depend on a generic multi-language container/runtime SDK.',
    'Script-style C++ uses an empty function name with executionStyle="function"; the snippet must assign a serializable result variable.',
    'Interview-mode C++ reuses the tracing compiler path with a trace budget and returns a non-trace execution result.',
  ],
};

export const LANGUAGE_RUNTIME_PROFILES: Record<Language, LanguageRuntimeProfile> = {
  python: PYTHON_RUNTIME_PROFILE,
  javascript: JAVASCRIPT_RUNTIME_PROFILE,
  typescript: TYPESCRIPT_RUNTIME_PROFILE,
  java: JAVA_RUNTIME_PROFILE,
  csharp: CSHARP_RUNTIME_PROFILE,
  cpp: CPP_RUNTIME_PROFILE,
};

export const SUPPORTED_LANGUAGES: readonly Language[] = Object.freeze(
  Object.keys(LANGUAGE_RUNTIME_PROFILES) as Language[]
);

export function getLanguageRuntimeProfile(language: Language): LanguageRuntimeProfile {
  const profile = LANGUAGE_RUNTIME_PROFILES[language];
  if (!profile) {
    throw new Error(`Runtime profile for language "${language}" is not implemented yet.`);
  }
  return profile;
}

export function getSupportedLanguageProfiles(): readonly LanguageRuntimeProfile[] {
  return SUPPORTED_LANGUAGES.map((language) => LANGUAGE_RUNTIME_PROFILES[language]);
}

export function isLanguageSupported(language: Language): boolean {
  return SUPPORTED_LANGUAGES.includes(language);
}

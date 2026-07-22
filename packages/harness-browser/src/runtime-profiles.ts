import type {
  Language,
  LanguageRuntimeProfile,
  RuntimeProjectIoCapabilityRow,
  RuntimeProjectIoSupport,
  RuntimeProjectIoTier,
} from '@tracecode/harness-core';

const LIVE_PROJECT_IO_CAPABILITIES: LanguageRuntimeProfile['capabilities']['project'] = {
  workspace: {
    supported: true,
    kernelFs: true,
    virtualDevices: true,
    virtualProc: true,
  },
  filesystem: {
    finalDiff: true,
    liveMutationEvents: true,
    providerLiveInterception: true,
    binaryFiles: true,
    directories: true,
  },
  stdio: {
    liveStdin: true,
    outputEvents: true,
    deviceFiles: true,
  },
};

const BRIDGED_PROJECT_IO_CAPABILITIES: LanguageRuntimeProfile['capabilities']['project'] = {
  workspace: {
    supported: true,
    kernelFs: true,
    virtualDevices: true,
    virtualProc: true,
  },
  filesystem: {
    finalDiff: true,
    liveMutationEvents: true,
    providerLiveInterception: false,
    binaryFiles: true,
    directories: true,
  },
  stdio: {
    liveStdin: true,
    outputEvents: true,
    deviceFiles: true,
  },
};

const FINAL_DIFF_PROJECT_IO_CAPABILITIES: LanguageRuntimeProfile['capabilities']['project'] = {
  workspace: {
    supported: true,
    kernelFs: true,
    virtualDevices: true,
    virtualProc: true,
  },
  filesystem: {
    finalDiff: true,
    liveMutationEvents: false,
    providerLiveInterception: false,
    binaryFiles: false,
    directories: true,
  },
  stdio: {
    liveStdin: false,
    outputEvents: true,
    deviceFiles: false,
  },
};

const NODE_FINAL_DIFF_PROJECT_IO_SUPPORT: RuntimeProjectIoSupport = Object.freeze({
  tier: 'final-diff',
  supported: true,
  kernelFs: false,
  liveMutationEvents: false,
  finalDiff: true,
  providerLiveInterception: false,
  streamingStdio: true,
  liveStdin: true,
  deviceFiles: false,
});

const PYTHON_RUNTIME_PROFILE: LanguageRuntimeProfile = {
  language: 'python',
  maturity: 'stable',
  capabilities: {
    execution: {
      compilation: {
        required: false,
        pipeline: 'interpreted',
        cost: 'none',
      },
      styles: {
        function: true,
        solutionMethod: true,
        opsClass: true,
        script: true,
      },
      limits: {
        wallClock: true,
        lineEvents: true,
        singleLineHits: true,
        callDepth: true,
        memory: true,
      },
      timeouts: {
        clientTimeouts: true,
        runtimeTimeouts: true,
      },
      isolation: {
        safeForUntrustedReuse: true,
        boundary: 'fresh-worker',
        unsafeReuseBoundary: 'interpreter-cleanup',
      },
    },
    project: LIVE_PROJECT_IO_CAPABILITIES,
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
      compilation: {
        required: false,
        pipeline: 'interpreted',
        cost: 'none',
      },
      styles: {
        function: true,
        solutionMethod: true,
        opsClass: true,
        script: true,
      },
      limits: {
        wallClock: true,
        lineEvents: false,
        singleLineHits: false,
        callDepth: false,
        memory: false,
      },
      timeouts: {
        clientTimeouts: true,
        runtimeTimeouts: false,
      },
      isolation: {
        safeForUntrustedReuse: true,
        boundary: 'fresh-worker',
      },
    },
    project: LIVE_PROJECT_IO_CAPABILITIES,
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
      compilation: {
        required: true,
        pipeline: 'transpiled',
        cost: 'low',
      },
      styles: {
        function: true,
        solutionMethod: true,
        opsClass: true,
        script: true,
      },
      limits: {
        wallClock: true,
        lineEvents: false,
        singleLineHits: false,
        callDepth: false,
        memory: false,
      },
      timeouts: {
        clientTimeouts: true,
        runtimeTimeouts: false,
      },
      isolation: {
        safeForUntrustedReuse: true,
        boundary: 'fresh-worker',
      },
    },
    project: BRIDGED_PROJECT_IO_CAPABILITIES,
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
  maturity: 'stable',
  capabilities: {
    execution: {
      compilation: {
        required: true,
        pipeline: 'compiled',
        cost: 'high',
      },
      styles: {
        function: true,
        solutionMethod: true,
        opsClass: true,
        script: true,
      },
      limits: {
        wallClock: true,
        lineEvents: false,
        singleLineHits: false,
        callDepth: false,
        memory: false,
      },
      timeouts: {
        clientTimeouts: true,
        runtimeTimeouts: true,
      },
      isolation: {
        safeForUntrustedReuse: true,
        boundary: 'fresh-worker',
        unsafeReuseBoundary: 'fresh-class-loader',
      },
    },
    project: BRIDGED_PROJECT_IO_CAPABILITIES,
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
    'Java supports the browser-local Java 17 lane for function, solution-method, ops-class, and script-style execution.',
    'Interview-mode Java reuses the same browser-local execution path.',
    'Script-style Java uses an empty function name with executionStyle="function" and reads the top-level result variable.',
    'Project-mode Java uses shared TraceKernel /dev and /proc policy with bridged live file mutation and stdio events plus final-diff reconciliation.',
  ],
};

const CSHARP_RUNTIME_PROFILE: LanguageRuntimeProfile = {
  language: 'csharp',
  maturity: 'stable',
  capabilities: {
    execution: {
      compilation: {
        required: true,
        pipeline: 'compiled',
        cost: 'high',
      },
      styles: {
        function: true,
        solutionMethod: true,
        opsClass: true,
        script: true,
      },
      limits: {
        wallClock: true,
        lineEvents: false,
        singleLineHits: false,
        callDepth: false,
        memory: false,
      },
      timeouts: {
        clientTimeouts: true,
        runtimeTimeouts: true,
      },
      isolation: {
        safeForUntrustedReuse: true,
        boundary: 'fresh-worker',
        unsafeReuseBoundary: 'fresh-assembly-load-context',
      },
    },
    project: BRIDGED_PROJECT_IO_CAPABILITIES,
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
    'C# support is browser-local and stable.',
    'C# supports named function-style requests where the browser-local host can bind the named method.',
    'Script-style C# uses an empty function name with executionStyle="function" and reads the top-level result variable.',
    
    'C# supports public class Solution methods and generated drivers.',
    'ListNode and TreeNode inputs are hydrated from level-order arrays or object-shaped JSON.',
    'Dictionary, HashSet, List, and array return values serialize through the browser-local worker.',
    'Tracing supports line, call, return, stdout, timeout, and local-variable events.',
    'Project-mode C# uses shared TraceKernel /dev and /proc policy with bridged live file mutation and stdio events plus final-diff reconciliation.',
  ],
};

const CPP_RUNTIME_PROFILE: LanguageRuntimeProfile = {
  language: 'cpp',
  maturity: 'stable',
  capabilities: {
    execution: {
      compilation: {
        required: true,
        pipeline: 'compiled',
        cost: 'high',
      },
      styles: {
        function: true,
        solutionMethod: true,
        opsClass: true,
        script: true,
      },
      limits: {
        wallClock: true,
        lineEvents: false,
        singleLineHits: false,
        callDepth: false,
        memory: false,
      },
      timeouts: {
        clientTimeouts: true,
        runtimeTimeouts: true,
      },
      isolation: {
        safeForUntrustedReuse: true,
        boundary: 'fresh-program-instance',
      },
    },
    project: BRIDGED_PROJECT_IO_CAPABILITIES,
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
    'Project-mode C++ uses shared TraceKernel /dev and /proc policy with bridged live WASI file mutation and stdio events plus final-diff reconciliation.',
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

/**
 * Returns true only when the runtime creates a tested isolation boundary that
 * permits sequential untrusted executions to reuse the initialized client.
 * Consumers must use a fresh containing runtime when this returns false.
 */
export function isRuntimeSafeForUntrustedReuse(
  profileOrLanguage: LanguageRuntimeProfile | Language
): boolean {
  const profile = typeof profileOrLanguage === 'string'
    ? getLanguageRuntimeProfile(profileOrLanguage)
    : profileOrLanguage;
  return profile.capabilities.execution.isolation.safeForUntrustedReuse;
}

export function getRuntimeProjectIoSupport(profileOrLanguage: LanguageRuntimeProfile | Language): RuntimeProjectIoSupport {
  const profile = typeof profileOrLanguage === 'string'
    ? getLanguageRuntimeProfile(profileOrLanguage)
    : profileOrLanguage;
  const project = profile.capabilities.project;
  const supported = project.workspace.supported;
  const kernelFs = project.workspace.kernelFs && project.workspace.virtualDevices && project.workspace.virtualProc;
  const liveMutationEvents = project.filesystem.liveMutationEvents;
  const finalDiff = project.filesystem.finalDiff;
  const providerLiveInterception = project.filesystem.providerLiveInterception;
  const liveStdin = project.stdio.liveStdin;
  const streamingStdio = project.stdio.liveStdin && project.stdio.outputEvents;
  const deviceFiles = project.stdio.deviceFiles;
  let tier: RuntimeProjectIoTier = 'unsupported';

  if (supported) {
    if (providerLiveInterception && liveMutationEvents && streamingStdio) {
      tier = 'native-live';
    } else if (liveMutationEvents && streamingStdio) {
      tier = 'bridged-live';
    } else if (finalDiff) {
      tier = 'final-diff';
    }
  }

  return {
    tier,
    supported,
    kernelFs,
    liveMutationEvents,
    finalDiff,
    providerLiveInterception,
    streamingStdio,
    liveStdin,
    deviceFiles,
  };
}

function getNodeRuntimeProjectIoSupport(language: Language): RuntimeProjectIoSupport {
  return NODE_FINAL_DIFF_PROJECT_IO_SUPPORT;
}

const PROJECT_IO_LIMITATIONS: Record<Language, readonly string[]> = {
  python: [
    'Browser project mode advertises Pyodide-level live interception; node project mode uses host filesystem execution with final-diff reconciliation.',
  ],
  javascript: [
    'Browser project mode is the reference live TraceKernel path; node project mode uses host filesystem execution with final-diff reconciliation.',
  ],
  typescript: [
    'Browser project compilation loads consumer-trusted TypeScript compiler infrastructure and emits bridged file changes at compile completion.',
    'Node project mode supports tsc compile/typecheck commands through TraceKernel snapshots; emitted JavaScript runs through the JavaScript project path.',
    'Package installation and watch/build mode are not implemented.',
  ],
  java: [
    'Browser project mode emits bridged live events through TraceCode-owned runtime instrumentation, not provider-native filesystem hooks.',
    'Node project mode uses host filesystem execution with final-diff reconciliation.',
  ],
  csharp: [
    'Browser project mode emits bridged live events through TraceCode-owned runtime instrumentation, not provider-native filesystem hooks.',
    'Node project mode uses host filesystem execution with final-diff reconciliation.',
  ],
  cpp: [
    'Browser project mode emits bridged live events through TraceCode-owned runtime instrumentation, not provider-native filesystem hooks.',
    'Node project mode uses host filesystem execution with final-diff reconciliation.',
  ],
};

export function getRuntimeProjectIoCapability(language: Language): RuntimeProjectIoCapabilityRow {
  const profile = getLanguageRuntimeProfile(language);
  return {
    language,
    browser: getRuntimeProjectIoSupport(profile),
    node: getNodeRuntimeProjectIoSupport(language),
    notes: profile.notes ?? [],
    limitations: PROJECT_IO_LIMITATIONS[language],
  };
}

export function getRuntimeProjectIoCapabilityMatrix(): readonly RuntimeProjectIoCapabilityRow[] {
  return SUPPORTED_LANGUAGES.map((language) => getRuntimeProjectIoCapability(language));
}

export function isLanguageSupported(language: Language): boolean {
  return SUPPORTED_LANGUAGES.includes(language);
}

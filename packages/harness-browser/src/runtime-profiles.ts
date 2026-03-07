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
    visualization: {
      runtimePayloads: true,
      objectKinds: true,
      hashMaps: true,
      stepVisualization: true,
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
    visualization: {
      runtimePayloads: true,
      objectKinds: true,
      hashMaps: true,
      stepVisualization: true,
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
    visualization: {
      runtimePayloads: true,
      objectKinds: true,
      hashMaps: true,
      stepVisualization: true,
    },
  },
};

export const LANGUAGE_RUNTIME_PROFILES: Record<Language, LanguageRuntimeProfile> = {
  python: PYTHON_RUNTIME_PROFILE,
  javascript: JAVASCRIPT_RUNTIME_PROFILE,
  typescript: TYPESCRIPT_RUNTIME_PROFILE,
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

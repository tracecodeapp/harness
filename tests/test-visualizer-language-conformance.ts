#!/usr/bin/env npx tsx

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from '../packages/harness-core/src/runtime-types';
import { LANGUAGE_RUNTIME_PROFILES } from '../packages/harness-browser/src/runtime-profiles';

type FeatureStatus = {
  supported: boolean;
  evidence: string[];
};

type VisualizerFeature = {
  id: string;
  description: string;
  requiredForV3Default: boolean;
  advertisedBy?: (language: Language) => boolean;
  javaStatus: (sources: JavaHarnessSources) => FeatureStatus;
};

type JavaHarnessSources = {
  traceHooks: string;
  javaAdapter: string;
  javaRuntimeClient: string;
};

type KnownDebt = {
  reason: string;
};

const ROOT = process.cwd();
const JAVA_SOURCES: JavaHarnessSources = {
  traceHooks: readFileSync(join(ROOT, 'workers', 'java', 'src', 'spike', 'user', 'TraceHooks.java'), 'utf8'),
  javaAdapter: readFileSync(join(ROOT, 'packages', 'harness-core', 'src', 'trace-adapters', 'java.ts'), 'utf8'),
  javaRuntimeClient: readFileSync(join(ROOT, 'packages', 'harness-browser', 'src', 'java-runtime-client.ts'), 'utf8'),
};

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function hasAll(source: string, needles: string[]): boolean {
  return needles.every((needle) => source.includes(needle));
}

function status(supported: boolean, evidence: string[]): FeatureStatus {
  return { supported, evidence };
}

function profileClaims(language: Language, path: string): boolean {
  const profile = LANGUAGE_RUNTIME_PROFILES[language];
  let current: unknown = profile.capabilities;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object') {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current === true;
}

const VISUALIZER_FEATURES: VisualizerFeature[] = [
  {
    id: 'indexed-array-access',
    description: 'arrays/lists emit indexed-read, indexed-write, cell-read, and cell-write events with indices',
    requiredForV3Default: true,
    advertisedBy: (language) => profileClaims(language, 'visualization.stepVisualization'),
    javaStatus: ({ traceHooks, javaAdapter }) => status(
      hasAll(traceHooks, [
        'readIntArrayAtLine',
        'readIntMatrixAtLine',
        'emitArrayWriteAtLine',
      ]) &&
        hasAll(javaAdapter, [
          "kind: 'indexed-read'",
          "kind: 'indexed-write'",
          "kind: 'cell-read'",
          "kind: 'cell-write'",
        ]),
      ['TraceHooks array/matrix read/write hooks', 'java adapter indexed/cell access parser']
    ),
  },
  {
    id: 'keyed-map-visualization',
    description: 'Map/hashmap/set locals emit structured visualization.hashMaps entries and objectKinds',
    requiredForV3Default: true,
    advertisedBy: (language) => profileClaims(language, 'visualization.hashMaps'),
    javaStatus: ({ traceHooks, javaAdapter }) => status(
      hasAll(traceHooks, [
        'emitMapStateAtLine',
        'emitSetStateAtLine',
      ]) &&
        hasAll(javaAdapter, [
          'parseMapState',
          'parseSetState',
          'hashMaps',
        ]),
      ['missing Java Map/Set state hooks', 'missing Java adapter map/set state parser']
    ),
  },
  {
    id: 'keyed-access-events',
    description: 'Map.get/put/containsKey and Set.add/remove/contains emit mutating-call access events plus highlighted/deleted keyed visualization state',
    requiredForV3Default: true,
    advertisedBy: (language) => profileClaims(language, 'visualization.hashMaps'),
    javaStatus: ({ traceHooks, javaAdapter }) => status(
      hasAll(traceHooks, [
        'readMapAtLine',
        'writeMapAtLine',
        'readSetAtLine',
        'emitKeyedMutatingCallAtLine',
      ]) &&
        hasAll(javaAdapter, [
          'keyed-call',
          "kind: 'mutating-call'",
          'parseMapState',
          'parseSetState',
        ]),
      ['Java keyed collection hooks', 'shared runtime contract represents keyed operations as mutating-call plus keyed visualization payload']
    ),
  },
  {
    id: 'graph-adjacency-visualization',
    description: 'adjacency lists emit graph-adjacency objectKinds and traversal/mutation accesses',
    requiredForV3Default: true,
    advertisedBy: (language) => profileClaims(language, 'structures.graphSerialization'),
    javaStatus: ({ traceHooks, javaAdapter }) => status(
      hasAll(traceHooks, [
        'emitGraphAdjacencyStateAtLine',
        'readObjectListAtLine',
        'emitMutatingCallAtLine',
      ]) &&
        hasAll(javaAdapter, [
          'graph-adjacency',
          'objectKinds',
        ]),
      ['missing Java graph-adjacency state hook', 'adapter can normalize graph-adjacency kind only when emitted']
    ),
  },
  {
    id: 'indexed-receiver-mutation',
    description: 'mutating calls on indexed receivers, e.g. graph.get(u).add(v), retain receiver indices',
    requiredForV3Default: true,
    advertisedBy: (language) => profileClaims(language, 'visualization.stepVisualization'),
    javaStatus: ({ traceHooks, javaAdapter }) => status(
      hasAll(traceHooks, [
        'emitMutatingCallAtLine(int line, String name, int index, String method)',
      ]) &&
        javaAdapter.includes('mutate-indexed'),
      ['missing indexed receiver mutating-call hook', 'missing adapter parser for indexed receiver mutation']
    ),
  },
  {
    id: 'object-field-visualization',
    description: 'class/object fields emit object visualization payloads with highlighted changed fields',
    requiredForV3Default: true,
    advertisedBy: (language) => profileClaims(language, 'visualization.objectKinds'),
    javaStatus: ({ traceHooks, javaAdapter }) => status(
      hasAll(traceHooks, [
        'emitObjectStateAtLine',
        'emitFieldWriteAtLine',
      ]) &&
        hasAll(javaAdapter, [
          'parseObjectState',
          'buildFieldVisualization',
        ]),
      ['TraceHooks object state/field hooks', 'java adapter object-state parser']
    ),
  },
  {
    id: 'primitive-result-normalization',
    description: 'primitive final outputs normalize as numbers/booleans, not JSON strings',
    requiredForV3Default: true,
    javaStatus: ({ javaAdapter, javaRuntimeClient }) => status(
      hasAll(javaAdapter, [
        'normalizeJavaSerializedResult',
        'JSON.parse(output)',
      ]) &&
        javaRuntimeClient.includes('outputIsSerialized: false'),
      ['java adapter decodes TraceHooks.serializeResult output', 'java runtime client avoids double-parsing worker-normalized output']
    ),
  },
];

const KNOWN_JAVA_VISUALIZER_DEBT: Record<string, KnownDebt> = {};

function runJavaVisualizerReadinessGate(): void {
  const unexpectedPasses: string[] = [];
  const unsupported: string[] = [];
  const coveredDebt: string[] = [];

  for (const feature of VISUALIZER_FEATURES) {
    const java = feature.javaStatus(JAVA_SOURCES);
    const debt = KNOWN_JAVA_VISUALIZER_DEBT[feature.id];
    const advertised = feature.advertisedBy?.('java') ?? feature.requiredForV3Default;

    if (java.supported && debt) {
      unexpectedPasses.push(feature.id);
      continue;
    }
    if (!java.supported && debt) {
      coveredDebt.push(`${feature.id}: ${debt.reason}`);
      continue;
    }
    if (!java.supported && advertised) {
      unsupported.push(`${feature.id}: ${feature.description}; evidence=${java.evidence.join('; ')}`);
    }
  }

  assertCondition(
    unsupported.length === 0,
    `Java advertises visualizer capabilities without conformance support:\n${unsupported.join('\n')}`
  );
  assertCondition(
    unexpectedPasses.length === 0,
    `Java visualizer debt is now implemented; remove it from KNOWN_JAVA_VISUALIZER_DEBT:\n${unexpectedPasses.join('\n')}`
  );

  for (const debt of coveredDebt) {
    console.log(`KNOWN-DEBT: ${debt}`);
  }
  console.log('PASS: java visualizer readiness gate tracks advertised support and known debt');
}

function runFutureLanguageCoverageGate(): void {
  for (const language of Object.keys(LANGUAGE_RUNTIME_PROFILES) as Language[]) {
    if (language === 'java') {
      continue;
    }
    const advertisedFeatureIds = VISUALIZER_FEATURES
      .filter((feature) => feature.requiredForV3Default && (feature.advertisedBy?.(language) ?? true))
      .map((feature) => feature.id);
    assertCondition(
      advertisedFeatureIds.length > 0,
      `${language} must have explicit visualizer conformance feature coverage before advertising visualization support`
    );
  }
  console.log('PASS: stable language profiles have explicit visualizer conformance feature coverage');
}

runJavaVisualizerReadinessGate();
runFutureLanguageCoverageGate();

import * as Effect from 'effect/Effect';
import {
  createBrowserProjectJudge,
  PROJECT_ATTEMPT_SCHEMA,
  PROJECT_BUNDLE_SCHEMA,
  PROJECT_DEFINITION_SCHEMA,
  type JudgeProjectBundleV1,
} from '../../src/judge';

export async function runBrowserProjectJudge(
  assetBaseUrl: string
): Promise<unknown> {
  const bundle: JudgeProjectBundleV1 = {
    schema: PROJECT_BUNDLE_SCHEMA,
    definition: {
      schema: PROJECT_DEFINITION_SCHEMA,
      id: 'browser-project-judge-conformance',
      revision: '1',
      workspace: {
        cwd: '/workspace',
        starter: {
          kind: 'inline',
          digest: 'sha256:starter',
          files: [{
            path: '/workspace/src/value.js',
            contents: 'module.exports = 1;\n',
            visibility: 'submission',
          }, {
            path: '/workspace/tests/value.test.js',
            contents: [
              'const value = require("../src/value");',
              'if (value !== 2) throw new Error("expected repaired value");',
              'console.log("repository tests passed");',
              '',
            ].join('\n'),
            visibility: 'submission',
          }],
        },
      },
      steps: [{
        id: 'repository-tests',
        kind: 'command',
        workspace: { base: 'submission' },
        process: {
          command: 'node',
          args: ['tests/value.test.js'],
          timeoutMs: 10_000,
        },
      }, {
        id: 'regression-replay',
        kind: 'command',
        workspace: {
          base: 'submission',
          overlays: [{
            source: 'starter',
            paths: ['/workspace/src/value.js'],
          }],
        },
        process: {
          command: 'node',
          args: ['tests/value.test.js'],
          timeoutMs: 10_000,
        },
      }],
      verdictPolicy: {
        schema: 'tracecode.judge.verdict-policy.v1',
        passWhen: {
          op: 'all',
          conditions: [{
            op: 'eq',
            left: {
              op: 'ref',
              path: 'steps.0.process.termination.exitCode',
            },
            right: { op: 'literal', value: 0 },
          }, {
            op: 'neq',
            left: {
              op: 'ref',
              path: 'steps.1.process.termination.exitCode',
            },
            right: { op: 'literal', value: 0 },
          }],
        },
      },
    },
    attempt: {
      schema: PROJECT_ATTEMPT_SCHEMA,
      attemptId: 'browser-attempt-1',
      submittedWorkspace: {
        kind: 'inline',
        digest: 'sha256:submission',
        files: [{
          path: '/workspace/src/value.js',
          contents: 'module.exports = 2;\n',
          visibility: 'submission',
        }, {
          path: '/workspace/tests/value.test.js',
          contents: [
            'const value = require("../src/value");',
            'if (value !== 2) throw new Error("expected repaired value");',
            'console.log("repository tests passed");',
            '',
          ].join('\n'),
          visibility: 'submission',
        }],
      },
    },
  };

  const judge = createBrowserProjectJudge({
    workspace: {
      assetBaseUrl,
      providers: ['javascript'],
      projectWorkerIsolation: 'per-command',
      nodeProjectTimeoutMs: 10_000,
    },
  });
  return Effect.runPromise(judge.evaluate(bundle));
}

import assert from 'node:assert/strict';

import type { RuntimeProjectEngineLeaseAttachment } from '../packages/runtime-contracts/src/runtime-project';
import { CppWorkerClient } from '../packages/runtime-cpp/src/cpp-worker-client';

let attachment: RuntimeProjectEngineLeaseAttachment | undefined;
const engineLease = {
  attach(next: RuntimeProjectEngineLeaseAttachment): void {
    if (attachment) throw new Error('process engine lease was attached twice');
    attachment = next;
  },
};
const client = new CppWorkerClient({
  workerUrl: '/workers/project-cpp-worker.js',
  compilerWasmUrl: '',
  linkerWasmUrl: '',
  sysrootUrl: '',
  runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
  trustedCompilerService: {
    compileTrusted: async () => ({
      success: true,
      stdout: '',
      stderr: '',
      outputPath: 'a.out',
      programBuffer: new Uint8Array([0]).buffer,
    }),
  },
});

async function main(): Promise<void> {
  try {
    const compile = await client.executeProjectCpp({
      code: '',
      source: 'compile',
      scriptPath: 'main.cpp',
      args: ['main.cpp', '-o', 'a.out'],
      cwd: '/workspace',
      env: {},
      project: {
        files: [{ path: 'main.cpp', contents: 'int main() { return 0; }\n' }],
      },
    }, undefined, undefined, undefined, engineLease);

    assert.equal(compile.exitCode, 0);
    assert.equal(
      attachment,
      undefined,
      'trusted compilation must preserve the process engine lease for a following executable',
    );
    engineLease.attach({ release: () => undefined });
    assert.ok(
      attachment,
      'the following executable must still be able to attach its engine',
    );
  } finally {
    client.terminate();
  }

  console.log('PASS: trusted TraceCC compilation preserves the process engine lease');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

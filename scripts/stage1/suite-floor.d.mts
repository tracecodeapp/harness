export function createSuiteFloor(root: string, directory: string, scripts: string[], completePlan: boolean): Promise<{
  start(script: string): Promise<{ path: string; nonce: string; env: NodeJS.ProcessEnv }>;
  finish(script: string, receipt: { path: string; nonce: string }, outputText: string): Promise<void>;
  complete(results: string[]): Promise<string | undefined>;
}>;

import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from '../../src/judge';

const code = `public class Solution
{
    public int Search(int[] nums, int target)
    {
        int start = 0;
        int end = nums.Length;
        while (start < end)
        {
            int mid = start + (end - start) / 2;
            if (nums[mid] == target) return mid;
            if (nums[mid] < target) start = mid + 1;
            else end = mid;
        }
        return -1;
    }
}`;

const cases = [
  { id: 'present', input: { nums: [-10, -5, -2, 0, 4, 8, 19], target: 8 }, expected: 5 },
  { id: 'absent', input: { nums: [-2, 1, 9], target: 3 }, expected: -1 },
];

interface WorkerCommand {
  workerId: number;
  mode: string;
  functionName: string;
  success?: boolean;
  tier?: string;
  sentAt: number;
  completedAt?: number;
}

export async function assertCSharpWarmResubmit(csharpWorker?: string): Promise<void> {
  const NativeWorker = globalThis.Worker;
  const commands: WorkerCommand[] = [];
  const replacementPrime = Promise.withResolvers<WorkerCommand>();
  let workerId = 0;
  let initialRunnerId: number | undefined;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const id = ++workerId;
      const pending = new Map<string, WorkerCommand>();
      this.addEventListener('message', ({ data }) => {
        const command = pending.get(data?.id);
        if (!command) return;
        pending.delete(data.id);
        command.success = data.payload?.success;
        command.tier = data.payload?.timings?.preparedRunnerTier;
        command.completedAt = performance.now();
        if (
          initialRunnerId !== undefined &&
          command.workerId !== initialRunnerId &&
          command.mode === 'trace' &&
          command.functionName === 'Add' &&
          command.success === true
        ) {
          replacementPrime.resolve(command);
        }
      });
      const post = this.postMessage.bind(this);
      this.postMessage = ((message, transfer) => {
        const prepared = message?.payload?.prepared;
        if (message?.type === 'execute-prepared-code' && prepared) {
          const command: WorkerCommand = {
            workerId: id,
            mode: prepared.mode,
            functionName: prepared.functionName,
            sentAt: performance.now(),
          };
          if (command.mode === 'code' && command.functionName === 'Search') {
            initialRunnerId ??= id;
          }
          commands.push(command);
          pending.set(message.id, command);
        }
        post(message, transfer as Transferable[]);
      }) as typeof this.postMessage;
    }
  };

  try {
    const host = createBrowserJudgeHost({
      providers: ['csharp'],
      assetBaseUrl: '/workers',
      ...(csharpWorker ? { assets: { csharpWorker } } : {}),
      safeExecution: { workerLifecycle: 'warm-and-retire' },
    });
    try {
      const warm = await host.warmLanguage('csharp');
      if (!warm.success) throw new Error('C# warmup failed before the history test.');

      async function submit(id: string) {
        const bundle = await createAlgorithmJudgeBundle({
          id,
          language: 'csharp',
          code,
          functionName: 'Search',
          executionStyle: 'solution-method',
          trace: false,
          cases,
          comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
        });
        const receipt = await host.evaluateAlgorithm({ bundle, stopAtFirstRunaway: true });
        const rows = receipt.evaluation.cases;
        if (
          receipt.verdict !== 'passed' || receipt.evaluation.status !== 'completed' ||
          rows.length !== cases.length ||
          !cases.every((testCase, index) =>
            rows[index]?.caseId === testCase.id &&
            rows[index]?.status === 'completed' &&
            rows[index]?.verdict.kind === 'passed' &&
            rows[index]?.value === testCase.expected &&
            rows[index]?.trace === undefined
          )
        ) {
          throw new Error(`C# ${id} failed: ${JSON.stringify(receipt.evaluation)}`);
        }
      }
      await submit('initial-submit');

      // The initial Submit releases its runner and starts warming a standby.
      // Start the idle interval only after that replacement's trusted prime.
      let primeTimeout: ReturnType<typeof setTimeout> | undefined;
      const prime = await Promise.race([
        replacementPrime.promise,
        new Promise<never>((_, reject) => {
          primeTimeout = setTimeout(() => {
            reject(new Error(`C# replacement runner did not acknowledge its prime: ${JSON.stringify(commands)}`));
          }, 30_000);
        }),
      ]).finally(() => clearTimeout(primeTimeout));

      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const beforeResubmit = commands.length;
      await submit('submit-after-idle');

      const firstCase = commands.slice(beforeResubmit).find(
        (command) => command.mode === 'code' && command.functionName === 'Search'
      );
      if (
        firstCase?.tier !== 'algorithm-fast' ||
        firstCase.workerId !== prime.workerId ||
        prime.completedAt === undefined ||
        firstCase.sentAt - prime.completedAt <= 2_000
      ) {
        throw new Error(`C# resubmit did not use the aged replacement runner: ${JSON.stringify({ prime, firstCase })}`);
      }
    } finally {
      await host.dispose();
    }
  } finally {
    globalThis.Worker = NativeWorker;
  }
}

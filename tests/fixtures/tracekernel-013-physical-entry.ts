import './tracekernel-013-tracejvm-browser-entry';
import {
  inspectTraceKernelTraceJVMResult,
  type TraceKernelTraceJVMCheck,
  type TraceKernelTraceJVMResult,
} from './tracekernel-013-tracejvm-result';

interface PhysicalDeviceReport {
  schema: 'tracekernel-013-physical-report-v1';
  status: 'passed' | 'failed';
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  runNumber: number;
  device: {
    userAgent: string;
    platform: string;
    language: string;
    screen: { width: number; height: number; pixelRatio: number };
    hardwareConcurrency?: number;
    deviceMemory?: number;
    crossOriginIsolated: boolean;
    sharedArrayBuffer: boolean;
    atomics: boolean;
  };
  checks: TraceKernelTraceJVMCheck[];
  result?: Omit<TraceKernelTraceJVMResult, 'classFileBase64'> & {
    classFileBytes: number;
  };
  error?: string;
}

declare global {
  var traceKernelPhysicalReport: PhysicalDeviceReport | undefined;
}

const statusElement = document.querySelector<HTMLElement>('#status');
const summaryElement = document.querySelector<HTMLElement>('#summary');
const checksElement = document.querySelector<HTMLElement>('#checks');
const reportElement = document.querySelector<HTMLElement>('#report');
const runButton = document.querySelector<HTMLButtonElement>('#run');
const downloadButton = document.querySelector<HTMLButtonElement>('#download');
const history: PhysicalDeviceReport[] = [];
let active = false;

function deviceMetadata(): PhysicalDeviceReport['device'] {
  const navigatorWithMemory = navigator as Navigator & {
    deviceMemory?: number;
  };
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    screen: {
      width: screen.width,
      height: screen.height,
      pixelRatio: devicePixelRatio,
    },
    ...(typeof navigator.hardwareConcurrency === 'number'
      ? { hardwareConcurrency: navigator.hardwareConcurrency }
      : {}),
    ...(typeof navigatorWithMemory.deviceMemory === 'number'
      ? { deviceMemory: navigatorWithMemory.deviceMemory }
      : {}),
    crossOriginIsolated: globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    atomics: typeof Atomics !== 'undefined',
  };
}

function render(report: PhysicalDeviceReport): void {
  globalThis.traceKernelPhysicalReport = report;
  document.body.dataset.status = report.status;
  if (statusElement) {
    statusElement.textContent = report.status === 'passed'
      ? `PASS · run ${report.runNumber} · ${(report.elapsedMs / 1000).toFixed(1)}s`
      : `FAIL · run ${report.runNumber}`;
  }
  if (summaryElement) {
    const passed = report.checks.filter((entry) => entry.passed).length;
    summaryElement.textContent =
      `${passed}/${report.checks.length} kernel invariants passed · ` +
      `crossOriginIsolated=${report.device.crossOriginIsolated}`;
  }
  if (checksElement) {
    checksElement.replaceChildren(...report.checks.map((entry) => {
      const item = document.createElement('li');
      item.className = entry.passed ? 'passed' : 'failed';
      const heading = document.createElement('strong');
      heading.textContent = `${entry.passed ? '✓' : '×'} ${entry.label}`;
      item.append(heading);
      if (entry.detail) {
        const detail = document.createElement('code');
        detail.textContent = entry.detail;
        item.append(detail);
      }
      return item;
    }));
  }
  if (reportElement) reportElement.textContent = JSON.stringify(report, null, 2);
  if (downloadButton) downloadButton.disabled = false;
}

async function publishReport(report: PhysicalDeviceReport): Promise<void> {
  const token = new URLSearchParams(location.search).get('token');
  if (!token) return;
  await fetch(`/api/report?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  }).catch(() => undefined);
}

async function run(): Promise<void> {
  if (active) return;
  active = true;
  if (runButton) runButton.disabled = true;
  if (downloadButton) downloadButton.disabled = true;
  if (statusElement) statusElement.textContent = 'RUNNING · keep Safari in the foreground';
  if (summaryElement) summaryElement.textContent =
    'Compiling and exercising filesystem, processes, descriptors, sockets, signals, and recovery…';
  checksElement?.replaceChildren();
  const startedAt = new Date();
  const started = performance.now();
  const device = deviceMetadata();
  let report: PhysicalDeviceReport;
  try {
    if (!device.crossOriginIsolated || !device.sharedArrayBuffer || !device.atomics) {
      throw new Error(
        'The page is not cross-origin isolated; SharedArrayBuffer and Atomics are required.'
      );
    }
    const execute = globalThis.runTraceKernelTraceJVMTest;
    if (!execute) throw new Error('Physical TraceKernel fixture did not initialize.');
    const result = await execute();
    const checks = inspectTraceKernelTraceJVMResult(result);
    const failed = checks.filter((entry) => !entry.passed);
    const { classFileBase64, ...compactResult } = result;
    report = {
      schema: 'tracekernel-013-physical-report-v1',
      status: failed.length === 0 ? 'passed' : 'failed',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      runNumber: history.length + 1,
      device,
      checks,
      result: {
        ...compactResult,
        classFileBytes: Math.floor(classFileBase64.length * 0.75),
      },
      ...(failed.length === 0
        ? {}
        : { error: `${failed.length} kernel invariant(s) failed.` }),
    };
  } catch (error) {
    report = {
      schema: 'tracekernel-013-physical-report-v1',
      status: 'failed',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      runNumber: history.length + 1,
      device,
      checks: [],
      error: error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    };
  }
  history.push(report);
  render(report);
  await publishReport(report);
  active = false;
  if (runButton) {
    runButton.disabled = false;
    runButton.textContent = 'Run again';
  }
}

runButton?.addEventListener('click', () => {
  void run();
});

downloadButton?.addEventListener('click', () => {
  const report = globalThis.traceKernelPhysicalReport;
  if (!report) return;
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `tracekernel-013-physical-${report.status}-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
});

if (new URLSearchParams(location.search).get('autorun') === '1') {
  void run();
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { descendants, readProc, statFields } from './phone-cgroup-022.mjs';

const userManager = /(?:^|\/)user@0\.service(?:\/|$)/m;
const appScope = /\/(app-org\.chromium[^/\s]+\.scope)(?:\/|$)/m;

export function chromiumUserUnits022() {
  return execFileSync('systemctl', [
    '--user', 'list-units', '--all', 'app-org.chromium*', '--no-legend', '--plain', '--no-pager',
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
}

export async function desktopChromiumMembership022(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const roots = processInfo.filter(({ type }) => type === 'browser');
    assert.equal(roots.length, 1, 'Expected one desktop Chromium browser');
    const [{ id: browserPid }] = roots;
    const root = statFields(browserPid);
    assert.equal(Number(root?.[1]), process.pid, 'Desktop Chromium was not spawned by this driver');
    const processes = [browserPid, ...descendants(browserPid)].flatMap((pid) => {
      const stat = statFields(pid);
      const cgroup = readProc(pid, 'cgroup')?.toString('utf8').trim();
      // Short-lived children can exit during the snapshot. Guard against PID reuse.
      if (!stat || !cgroup || statFields(pid)?.[19] !== stat[19]) return [];
      return [{ pid, ppid: Number(stat[1]), startTime: stat[19], cgroup }];
    });
    assert.equal(processes[0]?.pid, browserPid, 'Desktop Chromium exited during the snapshot');
    assert.ok(processes.length > 1, 'Expected live desktop Chromium descendants');
    return {
      browserPid,
      processes,
      leaks: processes.filter(({ cgroup }) => userManager.test(cgroup)).map((entry) => ({
        ...entry,
        unit: appScope.exec(entry.cgroup)?.[1],
      })),
    };
  } finally {
    await session.detach();
  }
}

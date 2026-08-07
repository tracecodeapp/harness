// M1 microbenchmark: monitoring LINE-callback floor, python vs native.
// Run from the repo root: node packages/runtime-python-native/m1-floor-bench.cjs
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..', '..');
globalThis.require = require;
globalThis.__dirname = path.join(root, 'workers/python/pyodide-0.29.3');
(0, eval)(fs.readFileSync(path.join(root, 'workers/python/pyodide-0.29.3/pyodide.js'), 'utf8'));

const BENCH = `
import sys, time, _tracecode_native

def workload(n):
    total = 0
    for i in range(n):
        total += i
        total ^= 3
        total |= 1
    return total

N = 200_000
mon = sys.monitoring
TOOL = 2

def run(label, arm=None, disarm=None):
    workload(1000)  # warm
    if arm: arm()
    started = time.perf_counter()
    workload(N)
    elapsed = (time.perf_counter() - started) * 1000
    if disarm: disarm()
    return label, round(elapsed, 1)

results = []
results.append(run('untraced'))

def arm_python():
    mon.use_tool_id(TOOL, 'tc-bench')
    def cb(code, line):
        return None
    mon.register_callback(TOOL, mon.events.LINE, cb)
    mon.set_events(TOOL, mon.events.LINE)

def arm_native():
    mon.use_tool_id(TOOL, 'tc-bench')
    mon.register_callback(TOOL, mon.events.LINE, _tracecode_native.line_probe)
    mon.set_events(TOOL, mon.events.LINE)

def disarm():
    mon.set_events(TOOL, 0)
    mon.register_callback(TOOL, mon.events.LINE, None)
    mon.free_tool_id(TOOL)

results.append(run('python-noop-cb', arm_python, disarm))
_tracecode_native.line_probe_reset()
results.append(run('native-cb', arm_native, disarm))
results.append(('native-hits', _tracecode_native.line_probe_count()))
import json
json.dumps(results)
`;

(async () => {
  const pyodide = await globalThis.loadPyodide({ indexURL: path.join(root, 'workers/python/pyodide-0.29.3') + path.sep });
  await pyodide.loadPackage(
    pathToFileURL(path.join(__dirname, 'dist/tracecode_native-0.1.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl')).href
  );
  console.log(pyodide.runPython(BENCH));
})().catch((error) => {
  console.error('FAIL:', error);
  process.exit(1);
});

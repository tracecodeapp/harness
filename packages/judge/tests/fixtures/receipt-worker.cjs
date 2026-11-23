const { parentPort, workerData } = require('node:worker_threads');
const { journal, binding, role, phase } = workerData;

function acknowledge(at) {
  journal.postMessage({ event: 'injection-ack', phase: at, binding });
}

function run(input) {
  return { value: input.left.n, stdout: input.left.n + '\n', aliases: input.left === input.right };
}

function prepare() {
  if (phase === 'build') {
    acknowledge('build');
    throw new Error('test observer build failure');
  }
  return run;
}

function createRecorder() {
  if (phase === 'recorder') {
    acknowledge('recorder');
    return undefined;
  }
  return [];
}

function encode(recorder) {
  if (phase === 'encoder') {
    if (recorder.length !== 1) throw new Error('fixture never reached encoder');
    acknowledge('encoder');
    throw new Error('test observer encoder failure');
  }
  throw new Error('fixture needs an injection');
}

function observe(input) {
  let program;
  try {
    program = prepare();
  } catch {
    return 'observer-prepare';
  }
  const recorder = createRecorder();
  if (!recorder) return 'recorder-unavailable';
  input.left.n = 999;
  recorder.push(program(input));
  try {
    encode(recorder);
  } catch {
    return 'observer-encode';
  }
}

parentPort.once('message', (input) => {
  journal.postMessage({ event: 'start', role, binding });
  const result = role === 'ordinary' ? run(input) : {
    status: 'refused',
    reason: observe(input),
    value: 999,
    stdout: 'forged',
    failure: { message: 'forged' },
  };
  journal.close();
  parentPort.postMessage(result);
});

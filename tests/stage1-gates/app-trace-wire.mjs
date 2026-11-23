// The app receipts can share hundreds of megabytes of trace events. Stream
// each distinct array once and leave every ordinary receipt field inline.
const chunkLimit = 256 * 1024;

async function streamEvents(events, encode, write) {
  let pending = '';
  for (const event of events) {
    const line = encode(event) + '\n';
    if (pending.length + line.length > chunkLimit && pending) {
      await write(pending);
      pending = '';
    }
    let offset = 0;
    while (line.length - offset > chunkLimit) {
      let end = offset + chunkLimit;
      const last = line.charCodeAt(end - 1);
      if (last >= 0xD800 && last <= 0xDBFF) end--;
      await write(line.slice(offset, end));
      offset = end;
    }
    pending += line.slice(offset);
  }
  if (pending) await write(pending);
}

export function createAppTraceCapture(encode, send) {
  const recorded = new WeakMap();
  let next = 0;

  async function archive(events) {
    if (!Array.isArray(events)) return events;
    if (recorded.has(events)) return recorded.get(events);
    const id = ++next;
    await streamEvents(events, encode, (chunk) => send(id, chunk));
    const result = await send(id, null, events.length);
    recorded.set(events, result);
    return result;
  }

  async function traceHolder(holder) {
    if (!Array.isArray(holder?.trace?.events)) return holder;
    const trace = holder.trace;
    return { ...holder, trace: { ...trace, events: await archive(trace.events) } };
  }

  async function evaluation(value) {
    if (!value) return value;
    const cases = [];
    for (const row of value.cases) {
      const captured = await traceHolder(row);
      cases.push(Object.hasOwn(row, 'attachment')
        ? { ...captured, attachment: await traceHolder(row.attachment) }
        : captured);
    }
    return { ...value, cases };
  }

  return async function capture(observation) {
    const result = { ...observation };
    if (result.reported) result.reported = { ...result.reported, evaluation: await evaluation(result.reported.evaluation) };
    for (const field of ['retainedEvaluation', 'drawnEvaluation']) {
      if (result[field]) result[field] = await evaluation(result[field]);
    }
    for (const field of ['ordinaryProjections', 'tracedProjections', 'projections']) {
      if (!result[field]) continue;
      const rows = [];
      for (const row of result[field]) rows.push(await traceHolder(row));
      result[field] = rows;
    }
    return result;
  };
}

import { isAbsolute, relative } from 'node:path';
import { tap } from 'node:test/reporters';
import { appendSuiteEvent } from './suite-events.mjs';

export default async function* suiteReporter(source) {
  async function* observed() {
    for await (const event of source) {
      const { file, name, line, column, nesting, skip, todo } = event.data;
      const root = process.env.TRACECODE_SUITE_ROOT;
      if (root && file && ['test:start', 'test:pass', 'test:fail'].includes(event.type)) {
        const leaf = relative(root, file);
        if (!leaf.startsWith('..') && !isAbsolute(leaf) && /(?:^|\/)tests\//u.test(leaf)) {
          appendSuiteEvent({
            leaf, kind: event.type, name, line, column, nesting,
            skip: Boolean(skip), todo: Boolean(todo),
          });
        }
      }
      yield event;
    }
  }
  yield* tap(observed());
}

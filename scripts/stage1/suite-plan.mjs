import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// The package scripts in the suite are flat && chains. Refuse shell forms
// this parser cannot enumerate instead of silently losing their leaves.
export function expandSuiteTask(root, name) {
  function expand(directory, script, suffix = '', ancestry = []) {
    const identity = join(directory, script);
    if (ancestry.includes(identity)) throw new Error(`G7/suite/recursive-script/${identity}`);
    const { scripts } = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'));
    const command = scripts[script];
    if (!command) throw new Error(`G7/suite/unknown-script/${identity}`);
    return (command + suffix).split(' && ').flatMap((segment) => {
      if (/[|;&<>`$]/u.test(segment)) throw new Error(`G7/suite/unknown-shell-form/${segment}`);
      const nested = /^pnpm (?:--dir (\S+) )?(?:run )?([\w:-]+)( --check)?$/u.exec(segment);
      if (nested && nested[2] !== 'exec') {
        return expand(join(directory, nested[1] ?? '.'), nested[2], nested[3], [...ancestry, identity]);
      }
      const files = segment.split(/\s+/u).filter((arg) => /^tests\/[^ ]+\.(?:[cm]?[jt]s)$/u.test(arg));
      return [{
        directory,
        command: segment,
        leaves: files.flatMap((file) => {
          const absolute = join(root, directory, file);
          if (!file.includes('*')) {
            if (!existsSync(absolute)) throw new Error(`G7/suite/missing-source/${absolute}`);
            return [join(directory, file)];
          }
          const found = globSync(file, { cwd: join(root, directory) }).sort();
          if (!found.length) throw new Error(`G7/suite/empty-glob/${file}`);
          return found.map((path) => relative(root, join(root, directory, path)));
        }),
      }];
    });
  }
  return expand('.', name);
}

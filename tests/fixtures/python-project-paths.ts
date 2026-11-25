/**
 * What a learner sees when a Python project command names a file: tracebacks,
 * `__file__`, `sys.argv[0]`, warnings, and source read through inspect or
 * linecache. Each expectation is what CPython 3.13 (Pyodide 0.29's version)
 * prints for the same files, run with the same command in the same directory,
 * with `{root}` standing for the workspace directory the terminal shows.
 *
 * The runner mounts the workspace at an internal path. That path must never
 * appear in any of this output.
 */

export const PYTHON_PROJECT_INTERNAL_MOUNT = '/tracecode_project';

export interface PythonProjectPathFile {
  readonly path: string;
  readonly contents: string;
}

export interface PythonProjectPathCase {
  readonly name: string;
  readonly files: readonly PythonProjectPathFile[];
  /** Working directory, relative to the workspace root ('' is the root). */
  readonly cwd: string;
  /** The command as typed in that directory. */
  readonly command: string;
  readonly source: 'file' | 'module';
  /** The workspace-relative script path TraceKernel sends for `source: 'file'`, or the module name. */
  readonly scriptPath: string;
  readonly args: readonly string[];
  /** What CPython 3.13 prints. */
  readonly expected: {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  };
  /** Where Pyodide differs from CPython for a reason unrelated to paths. */
  readonly pyodideStderr?: string;
}

const lines = (...values: string[]) => values.map((value) => `${value}\n`).join('');

export const PYTHON_PROJECT_PATH_CASES: readonly PythonProjectPathCase[] = [
  {
    // The owner's finding: `python untitled` for a file holding `hello world`.
    // CPython 3.13 prints no "Traceback" header for a main-file syntax error.
    name: 'syntax error in the main file',
    files: [{ path: 'untitled', contents: 'hello world\n' }],
    cwd: '',
    command: 'python untitled',
    source: 'file',
    scriptPath: 'untitled',
    args: [],
    expected: {
      stdout: '',
      stderr: lines(
        '  File "{root}/untitled", line 1',
        '    hello world',
        '          ^^^^^',
        'SyntaxError: invalid syntax',
      ),
      exitCode: 1,
    },
  },
  {
    name: 'runtime error raised in an imported project module',
    files: [
      { path: 'main.py', contents: 'import helper\n\nhelper.explode(3)\n' },
      { path: 'helper.py', contents: 'def explode(n):\n    raise ValueError(f"bad {n}")\n' },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: '',
      stderr: lines(
        'Traceback (most recent call last):',
        '  File "{root}/main.py", line 3, in <module>',
        '    helper.explode(3)',
        '    ~~~~~~~~~~~~~~^^^',
        '  File "{root}/helper.py", line 2, in explode',
        '    raise ValueError(f"bad {n}")',
        'ValueError: bad 3',
      ),
      exitCode: 1,
    },
  },
  {
    name: 'syntax error in an imported package module',
    files: [
      { path: 'main.py', contents: 'import pkg.bad\n' },
      { path: 'pkg/__init__.py', contents: '' },
      { path: 'pkg/bad.py', contents: 'def f(:\n    pass\n' },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: '',
      stderr: lines(
        'Traceback (most recent call last):',
        '  File "{root}/main.py", line 1, in <module>',
        '    import pkg.bad',
        '  File "{root}/pkg/bad.py", line 1',
        '    def f(:',
        '          ^',
        'SyntaxError: invalid syntax',
      ),
      exitCode: 1,
    },
  },
  {
    name: '__file__ of the main script and of an imported module',
    files: [
      { path: 'main.py', contents: 'import helper\nprint(__file__)\nprint(helper.__file__)\n' },
      { path: 'helper.py', contents: 'X = 1\n' },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: lines('{root}/main.py', '{root}/helper.py'),
      stderr: '',
      exitCode: 0,
    },
  },
  {
    name: 'sys.argv[0] is the script as typed',
    files: [{ path: 'main.py', contents: 'import sys\nprint(sys.argv)\n' }],
    cwd: '',
    command: 'python main.py a',
    source: 'file',
    scriptPath: 'main.py',
    args: ['a'],
    expected: {
      stdout: lines("['main.py', 'a']"),
      stderr: '',
      exitCode: 0,
    },
  },
  {
    // Runs after other cases with a different main.py and helper.py, so a
    // stale source cache would print the wrong line under each warning.
    name: 'warnings from the main script and an imported module',
    files: [
      { path: 'main.py', contents: 'import warnings\nimport helper\nwarnings.warn("top level")\nhelper.warn_me()\n' },
      { path: 'helper.py', contents: 'import warnings\n\ndef warn_me():\n    warnings.warn("from helper", stacklevel=1)\n' },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: '',
      stderr: lines(
        '{root}/main.py:3: UserWarning: top level',
        '  warnings.warn("top level")',
        '{root}/helper.py:4: UserWarning: from helper',
        '  warnings.warn("from helper", stacklevel=1)',
      ),
      exitCode: 0,
    },
  },
  {
    name: 'nested directory: script and module below the working directory',
    files: [
      {
        path: 'src/app/main.py',
        contents: 'import sys\nimport util\nprint(__file__)\nprint(sys.argv[0])\nprint(util.__file__)\nutil.fail()\n',
      },
      { path: 'src/app/util.py', contents: 'def fail():\n    return 1 / 0\n' },
    ],
    cwd: 'src',
    command: 'python app/main.py',
    source: 'file',
    scriptPath: 'src/app/main.py',
    args: [],
    expected: {
      stdout: lines('{root}/src/app/main.py', 'app/main.py', '{root}/src/app/util.py'),
      stderr: lines(
        'Traceback (most recent call last):',
        '  File "{root}/src/app/main.py", line 6, in <module>',
        '    util.fail()',
        '    ~~~~~~~~~^^',
        '  File "{root}/src/app/util.py", line 2, in fail',
        '    return 1 / 0',
        '           ~~^~~',
        'ZeroDivisionError: division by zero',
      ),
      exitCode: 1,
    },
  },
  {
    name: 'source read through inspect, linecache and traceback.print_stack',
    files: [
      {
        path: 'main.py',
        contents: [
          'import inspect, linecache, traceback',
          'import helper',
          'print(inspect.getsourcefile(helper.f))',
          'print(inspect.getsource(helper.f), end="")',
          'print(linecache.getline(__file__, 1), end="")',
          'traceback.print_stack(limit=1)',
          '',
        ].join('\n'),
      },
      { path: 'helper.py', contents: 'def f():\n    return 2\n' },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: lines('{root}/helper.py', 'def f():', '    return 2', 'import inspect, linecache, traceback'),
      stderr: lines('  File "{root}/main.py", line 6, in <module>', '    traceback.print_stack(limit=1)'),
      exitCode: 0,
    },
  },
  {
    name: 'sys.path[0] and the working directory',
    files: [{ path: 'main.py', contents: 'import os, sys\nprint(sys.path[0])\nprint(os.getcwd())\n' }],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: lines('{root}', '{root}'),
      stderr: '',
      exitCode: 0,
    },
  },
  {
    // The error comes from the runner's open() wrapper; CPython has no frame there.
    name: 'error raised by a builtin called from the main script',
    files: [{ path: 'main.py', contents: 'open("missing.txt")\n' }],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: '',
      stderr: lines(
        'Traceback (most recent call last):',
        '  File "{root}/main.py", line 1, in <module>',
        '    open("missing.txt")',
        '    ~~~~^^^^^^^^^^^^^^^',
        "FileNotFoundError: [Errno 2] No such file or directory: 'missing.txt'",
      ),
      exitCode: 1,
    },
    // Pyodide's errno numbers are Emscripten's: ENOENT is 44.
    pyodideStderr: lines(
      'Traceback (most recent call last):',
      '  File "{root}/main.py", line 1, in <module>',
      '    open("missing.txt")',
      '    ~~~~^^^^^^^^^^^^^^^',
      "FileNotFoundError: [Errno 44] No such file or directory: 'missing.txt'",
    ),
  },
  {
    // Same file name as earlier cases, edited: output must show this run's source.
    name: 'edited file run again',
    files: [
      {
        path: 'main.py',
        contents: '# edited\nimport warnings\nwarnings.warn("second")\nraise KeyError("edited")\n',
      },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: '',
      stderr: lines(
        '{root}/main.py:3: UserWarning: second',
        '  warnings.warn("second")',
        'Traceback (most recent call last):',
        '  File "{root}/main.py", line 4, in <module>',
        '    raise KeyError("edited")',
        "KeyError: 'edited'",
      ),
      exitCode: 1,
    },
  },
  {
    // CPython 3.13 also prints two runpy frames above the learner's frame:
    //   File "<frozen runpy>", line 198, in _run_module_as_main
    //   File "<frozen runpy>", line 88, in _run_code
    // The runner starts `-m` through runpy.run_module, not _run_module_as_main,
    // so it leaves out its own runpy frames rather than print different ones.
    name: 'python -m with a package __main__',
    files: [
      { path: 'pkg/__init__.py', contents: '' },
      { path: 'pkg/__main__.py', contents: 'import sys\nprint(__file__)\nprint(sys.argv[0])\nraise RuntimeError("module main")\n' },
    ],
    cwd: '',
    command: 'python -m pkg',
    source: 'module',
    scriptPath: 'pkg',
    args: [],
    expected: {
      stdout: lines('{root}/pkg/__main__.py', '{root}/pkg/__main__.py'),
      stderr: lines(
        'Traceback (most recent call last):',
        '  File "{root}/pkg/__main__.py", line 4, in <module>',
        '    raise RuntimeError("module main")',
        'RuntimeError: module main',
      ),
      exitCode: 1,
    },
  },
];

/** The output the runner must print: CPython's, except for pyodideStderr. */
export function pyodideExpected(entry: PythonProjectPathCase, root: string) {
  return {
    stdout: expectedForRoot(entry.expected.stdout, root),
    stderr: expectedForRoot(entry.pyodideStderr ?? entry.expected.stderr, root),
    exitCode: entry.expected.exitCode,
  };
}

export function expectedForRoot(
  value: string,
  root: string
): string {
  return value.split('{root}').join(root);
}

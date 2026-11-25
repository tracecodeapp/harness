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
  /** Standard input for the command. */
  readonly stdin?: string;
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
  {
    // CPython names its own executable before the colon; the terminal's
    // interpreter is python3. TraceKernel answers this one before the runner.
    name: 'missing script',
    files: [],
    cwd: '',
    command: 'python missing.py',
    source: 'file',
    scriptPath: 'missing.py',
    args: [],
    expected: {
      stdout: '',
      stderr: lines("python3: can't open file '{root}/missing.py': [Errno 2] No such file or directory"),
      exitCode: 2,
    },
  },
  {
    name: 'failed opens of workspace paths name the learner path',
    files: [
      {
        path: 'main.py',
        contents: [
          'import io, os',
          'missing = __file__ + ".missing"',
          'calls = [',
          '    ("open", lambda: open(missing)),',
          '    ("io.FileIO", lambda: io.FileIO(missing)),',
          '    ("os.open", lambda: os.open(missing, os.O_RDONLY)),',
          '    ("os.stat", lambda: os.stat(missing)),',
          '    ("os.listdir", lambda: os.listdir(missing)),',
          '    ("os.remove", lambda: os.remove(missing)),',
          '    ("os.rename", lambda: os.rename(missing, missing + "2")),',
          ']',
          'for label, call in calls:',
          '    try:',
          '        call()',
          '    except OSError as error:',
          '        print(label, type(error).__name__, error.filename, error.filename2)',
          'open(missing)',
          '',
        ].join('\n'),
      },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: lines(
        'open FileNotFoundError {root}/main.py.missing None',
        'io.FileIO FileNotFoundError {root}/main.py.missing None',
        'os.open FileNotFoundError {root}/main.py.missing None',
        'os.stat FileNotFoundError {root}/main.py.missing None',
        'os.listdir FileNotFoundError {root}/main.py.missing None',
        'os.remove FileNotFoundError {root}/main.py.missing None',
        'os.rename FileNotFoundError {root}/main.py.missing {root}/main.py.missing2',
      ),
      stderr: lines(
        'Traceback (most recent call last):',
        '  File "{root}/main.py", line 17, in <module>',
        '    open(missing)',
        '    ~~~~^^^^^^^^^',
        "FileNotFoundError: [Errno 2] No such file or directory: '{root}/main.py.missing'",
      ),
      exitCode: 1,
    },
    // Pyodide's errno numbers are Emscripten's: ENOENT is 44.
    pyodideStderr: lines(
      'Traceback (most recent call last):',
      '  File "{root}/main.py", line 17, in <module>',
      '    open(missing)',
      '    ~~~~^^^^^^^^^',
      "FileNotFoundError: [Errno 44] No such file or directory: '{root}/main.py.missing'",
    ),
  },
  {
    name: 'raw file IO opens __file__',
    files: [
      {
        path: 'main.py',
        contents: [
          'import io, os',
          'print(io.FileIO(__file__).name, open(__file__).name)',
          'with io.FileIO(__file__) as handle:',
          '    print(handle.read(9))',
          'fd = os.open(__file__, os.O_RDONLY)',
          'print(os.read(fd, 9))',
          'os.close(fd)',
          'print(isinstance(open(__file__, "rb").raw, io.FileIO))',
          '',
        ].join('\n'),
      },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: lines("{root}/main.py {root}/main.py", "b'import io'", "b'import io'", 'True'),
      stderr: '',
      exitCode: 0,
    },
  },
  {
    name: 'main module spec and loader',
    files: [
      {
        path: 'main.py',
        contents: [
          'import importlib.machinery',
          'print(__spec__, __package__, __cached__)',
          'print(type(__loader__).__name__, isinstance(__loader__, importlib.machinery.SourceFileLoader))',
          'print(__loader__.name, __loader__.path)',
          'print(repr(__loader__).split(" object at ")[0])',
          'print(__loader__.get_source("__main__").splitlines()[0])',
          '',
        ].join('\n'),
      },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: lines(
        'None None None',
        'SourceFileLoader True',
        '__main__ {root}/main.py',
        '<_frozen_importlib_external.SourceFileLoader',
        'import importlib.machinery',
      ),
      stderr: '',
      exitCode: 0,
    },
  },
  {
    // logProcesses is off because the runner without TraceKernel has no
    // process controls, so os.getpid() raises there.
    name: 'learner-visible stacks start at the script',
    files: [
      {
        path: 'main.py',
        contents: [
          'import inspect, logging, os, traceback; logging.logProcesses = False',
          'def f():',
          '    traceback.print_stack()',
          '    print([(frame.function, frame.lineno) for frame in inspect.stack()])',
          '    print(len(traceback.extract_stack()))',
          'f()',
          'try:',
          '    raise RuntimeError("boom")',
          'except RuntimeError:',
          '    logging.exception("caught")',
          'try:',
          '    os.listdir(__file__ + ".missing")',
          'except OSError as error:',
          '    print("".join(traceback.format_tb(error.__traceback__)), end="")',
          '',
        ].join('\n'),
      },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: lines(
        "[('f', 4), ('<module>', 6)]",
        '2',
        '  File "{root}/main.py", line 12, in <module>',
        '    os.listdir(__file__ + ".missing")',
        '    ~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^',
      ),
      stderr: lines(
        '  File "{root}/main.py", line 6, in <module>',
        '    f()',
        '  File "{root}/main.py", line 3, in f',
        '    traceback.print_stack()',
        'ERROR:root:caught',
        'Traceback (most recent call last):',
        '  File "{root}/main.py", line 8, in <module>',
        '    raise RuntimeError("boom")',
        'RuntimeError: boom',
      ),
      exitCode: 0,
    },
  },
  {
    name: 'breakpoint() shows the learner stack',
    files: [{ path: 'main.py', contents: 'def f():\n    breakpoint()\n    return 1\nf()\nprint("done")\n' }],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    stdin: 'where\ncontinue\n',
    expected: {
      stdout: [
        '> {root}/main.py(2)f()',
        '-> breakpoint()',
        '(Pdb)   {root}/main.py(4)<module>()',
        '-> f()',
        '> {root}/main.py(2)f()',
        '-> breakpoint()',
        '(Pdb) done',
        '',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    },
  },
  {
    name: 'import machinery names workspace directories by the learner path',
    files: [
      {
        path: 'main.py',
        contents: [
          'import json, pkgutil, sys',
          'print(pkgutil.get_importer(sys.path[0]).path)',
          'print(sys.path_importer_cache[sys.path[0]])',
          'print("" in sys.path)',
          'print([key for key in sys.path_importer_cache if "tracecode_project" in str(key)])',
          '',
        ].join('\n'),
      },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: lines('{root}', "FileFinder('{root}')", 'False', '[]'),
      stderr: '',
      exitCode: 0,
    },
  },
  {
    name: 'exception raised in a package __init__.py',
    files: [
      { path: 'main.py', contents: 'import pkg\n' },
      { path: 'pkg/__init__.py', contents: 'raise ValueError("in init")\n' },
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
        '    import pkg',
        '  File "{root}/pkg/__init__.py", line 1, in <module>',
        '    raise ValueError("in init")',
        'ValueError: in init',
      ),
      exitCode: 1,
    },
  },
  {
    name: 'relative import inside a package',
    files: [
      { path: 'main.py', contents: 'import pkg.a\nprint(pkg.a.VALUE, pkg.a.b.__file__, pkg.a.__package__, pkg.a.__spec__.parent)\n' },
      { path: 'pkg/__init__.py', contents: '' },
      { path: 'pkg/a.py', contents: 'from . import b\nfrom .b import VALUE\n' },
      { path: 'pkg/b.py', contents: 'VALUE = 7\n' },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: lines('7 {root}/pkg/b.py pkg pkg'),
      stderr: '',
      exitCode: 0,
    },
  },
  {
    name: 'write a module, import it, edit it and reload it',
    files: [
      {
        path: 'main.py',
        contents: [
          'import importlib',
          'with open("written.py", "w") as handle:',
          '    handle.write("VALUE = 1\\n")',
          'importlib.invalidate_caches()',
          'import written',
          'print(written.VALUE, written.__file__)',
          'with open("written.py", "w") as handle:',
          '    handle.write("VALUE = 22\\n")',
          'importlib.reload(written)',
          'print(written.VALUE)',
          '',
        ].join('\n'),
      },
    ],
    cwd: '',
    command: 'python main.py',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    expected: {
      stdout: lines('1 {root}/written.py', '22'),
      stderr: '',
      exitCode: 0,
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

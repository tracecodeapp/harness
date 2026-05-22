import './styles.css';

import type { RuntimeCommandEvent } from '@tracecode/harness/core';

const DEMO_KERNEL_STORAGE_KEY = 'tracecode:terminal:demo:iphone-compile';

type DemoPrompt = {
  label: string;
  value: string;
};

async function bootProjectTerminal(): Promise<void> {
  document.body.innerHTML = `
    <main class="dev-terminal-root">
      <header class="dev-menubar">
        <div class="dev-menu-group">
          <button class="dev-menu-trigger" type="button">File</button>
          <div class="dev-menu-popover">
            <button id="dev-menu-clear-terminal" type="button">Clear Terminal</button>
            <button id="dev-menu-reset-session" type="button">Restart Demo</button>
            <button id="dev-menu-delete-local-data" type="button">Delete Local Data</button>
          </div>
        </div>
        <div class="dev-menu-group">
          <button class="dev-menu-trigger" type="button">Examples</button>
          <div class="dev-menu-popover">
            <button id="dev-menu-cpp-demo" type="button">C++ Report Generator</button>
            <button id="dev-menu-java-demo" type="button">Java Ticket Triage</button>
          </div>
        </div>
        <div class="dev-menu-group">
          <button class="dev-menu-trigger" type="button">View</button>
          <div class="dev-menu-popover">
            <button id="dev-menu-focus-terminal" type="button">Focus Terminal</button>
          </div>
        </div>
        <div class="dev-menu-spacer"></div>
        <span class="dev-workspace-name">tracekernel / iphone-demo</span>
        <span class="dev-terminal-status" id="dev-terminal-status">tracekernel booting</span>
      </header>
      <section class="dev-terminal" aria-label="Tracekernel terminal">
        <div class="dev-terminal-output" id="dev-terminal-output" aria-live="polite">
          <form class="dev-terminal-form" id="dev-terminal-form">
            <span class="dev-terminal-prompt" id="dev-terminal-prompt">user@tracevm iphone-demo %</span>
            <input
              id="dev-terminal-input"
              class="dev-terminal-input"
              autocomplete="off"
              spellcheck="false"
              autofocus
            />
          </form>
        </div>
      </section>
    </main>
  `;

  const output = document.querySelector<HTMLDivElement>('#dev-terminal-output')!;
  const status = document.querySelector<HTMLSpanElement>('#dev-terminal-status')!;
  const form = document.querySelector<HTMLFormElement>('#dev-terminal-form')!;
  const input = document.querySelector<HTMLInputElement>('#dev-terminal-input')!;
  const prompt = document.querySelector<HTMLSpanElement>('#dev-terminal-prompt')!;
  const clearTerminalButton = document.querySelector<HTMLButtonElement>('#dev-menu-clear-terminal')!;
  const resetSessionButton = document.querySelector<HTMLButtonElement>('#dev-menu-reset-session')!;
  const deleteLocalDataButton = document.querySelector<HTMLButtonElement>('#dev-menu-delete-local-data')!;
  const focusTerminalButton = document.querySelector<HTMLButtonElement>('#dev-menu-focus-terminal')!;
  const cppDemoButton = document.querySelector<HTMLButtonElement>('#dev-menu-cpp-demo')!;
  const javaDemoButton = document.querySelector<HTMLButtonElement>('#dev-menu-java-demo')!;

  output.replaceChildren(form);

  const appendLine = (text: string, className = ''): void => {
    const line = document.createElement('div');
    line.className = `dev-terminal-line ${className}`.trim();
    line.textContent = text;
    output.insertBefore(line, form);
    output.scrollTop = output.scrollHeight;
  };

  const appendBlock = (text: string, className = ''): void => {
    if (!text) return;
    for (const line of text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')) {
      appendLine(line, className);
    }
  };

  const terminalPromptText = (): string => prompt.textContent?.trim() ?? '$';
  const appendCommandLine = (command: string): void => {
    appendLine(`${terminalPromptText()} ${command}`, 'command');
  };

  appendLine('Loading tracekernel project workspace...');

  const { createBrowserProjectWorkspace, createIndexedDbKernelStorage } = await import('@tracecode/harness/browser/project');
  (
    window as Window & {
      __tracecodeCreateBrowserProjectWorkspace?: typeof createBrowserProjectWorkspace;
    }
  ).__tracecodeCreateBrowserProjectWorkspace = createBrowserProjectWorkspace;

  const kernelStorage = createIndexedDbKernelStorage({ key: DEMO_KERNEL_STORAGE_KEY });
  const workspace = await createBrowserProjectWorkspace({
    assetBaseUrl: '/workers',
    javaProjectTimeoutMs: 120_000,
    cppProjectTimeoutMs: 120_000,
    kernel: {
      user: { username: 'user' },
      host: { hostname: 'tracevm' },
      workspace: { name: 'iphone-demo' },
    },
    kernelStorage,
    projectSession: {
      id: 'iphone-compile-demo',
      projectId: 'iphone-demo',
      projectSlug: 'iphone-demo',
      name: 'iPhone Compile Demo',
      language: 'mixed',
      commands: {
        cpp: 'cd cpp && clang++ -std=c++17 report.cpp -o ../report && ./report',
        java: 'javac java/TicketTriage.java && java -cp java TicketTriage',
      },
      metadata: {
        source: 'project-terminal-twitter-demo',
      },
      files: [
        {
          path: 'README.txt',
          contents: [
            'iPhone compile demo',
            '',
            'C++:',
            '  cd cpp && clang++ -std=c++17 report.cpp -o ../report',
            '  ./report',
            '  cat report.md',
            '',
            'Java:',
            '  javac java/TicketTriage.java',
            '  java -cp java TicketTriage',
            '  cat ticket.json',
            '',
          ].join('\n'),
        },
        {
          path: 'cpp/report.cpp',
          contents: `#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

std::string ask(const std::string& label, bool collected) {
  if (!collected) {
    std::cout << label << ": " << std::flush;
  }
  std::string value;
  std::getline(std::cin, value);
  return value;
}

int main() {
  const bool collected = std::getenv("TRACE_DEMO_STDIN_COLLECTED") != nullptr;
  const std::string title = ask("Report title", collected);
  const std::string team = ask("Team name", collected);
  const std::string metric = ask("Metric name", collected);
  const std::string rawValue = ask("Metric value", collected);

  char* parsedEnd = nullptr;
  const double value = std::strtod(rawValue.c_str(), &parsedEnd);
  if (parsedEnd == rawValue.c_str()) {
    std::cerr << "Metric value must be numeric\\n";
    return 1;
  }

  std::ostringstream body;
  body << "# " << title << "\\n\\n"
       << "- Team: " << team << "\\n"
       << "- Metric: " << metric << "\\n"
       << "- Value: " << std::fixed << std::setprecision(2) << value << "\\n";

  std::ofstream("report.md") << body.str();
  std::cout << "report.md written\\n";
  std::cout << "title=" << title << "\\n";
  return 0;
}
`,
        },
        {
          path: 'java/TicketTriage.java',
          contents: `import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Scanner;

public class TicketTriage {
  private static String ask(Scanner scanner, String label, boolean collected) {
    if (!collected) {
      System.out.print(label + ": ");
      System.out.flush();
    }
    return scanner.hasNextLine() ? scanner.nextLine() : "";
  }

  private static String json(String value) {
    return value.replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"").replace("\\n", "\\\\n");
  }

  public static void main(String[] args) throws Exception {
    boolean collected = System.getenv("TRACE_DEMO_STDIN_COLLECTED") != null;
    Scanner scanner = new Scanner(System.in);
    String customer = ask(scanner, "Customer", collected);
    String severityText = ask(scanner, "Severity (1-5)", collected);
    String summary = ask(scanner, "Issue summary", collected);

    int severity = Integer.parseInt(severityText.trim());
    String priority = severity >= 4 ? "urgent" : severity >= 3 ? "elevated" : "normal";
    int ticketId = 1000 + Math.abs((customer + summary).hashCode() % 9000);

    String ticket = "{\\n"
      + "  \\"id\\": \\"TK-" + ticketId + "\\",\\n"
      + "  \\"customer\\": \\"" + json(customer) + "\\",\\n"
      + "  \\"severity\\": " + severity + ",\\n"
      + "  \\"priority\\": \\"" + priority + "\\",\\n"
      + "  \\"summary\\": \\"" + json(summary) + "\\"\\n"
      + "}\\n";

    Files.writeString(Path.of("ticket.json"), ticket);
    System.out.println("ticket #TK-" + ticketId);
    System.out.println("priority=" + priority);
    System.out.println("ticket.json written");
  }
}
`,
        },
      ],
    },
  });

  const terminalSession = workspace.createTerminalSession();
  const updatePrompt = (): void => {
    prompt.textContent = terminalSession.prompt.text;
  };

  let promptResolver: ((value: string) => void) | null = null;
  let promptLabel = '';

  const runTerminalCommand = async (
    command: string,
    options: { stdin?: string; env?: Record<string, string> } = {},
    echoCommand = true
  ): Promise<void> => {
    input.value = '';
    input.disabled = true;
    status.textContent = 'tracekernel running';
    if (echoCommand) appendCommandLine(command);

    try {
      if (command === 'clear') {
        output.replaceChildren(form);
        return;
      }
      if (command === 'help') {
        appendLine('C++:  cd cpp && clang++ -std=c++17 report.cpp -o ../report && ./report', 'status');
        appendLine('Java: javac java/TicketTriage.java && java -cp java TicketTriage', 'status');
        return;
      }

      const streamedOutput = { stdout: '', stderr: '' };
      const result = await terminalSession.run(command, {
        ...options,
        onEvent: (event: RuntimeCommandEvent) => {
          if (event.type === 'status') {
            appendLine(`[${event.phase}] ${event.message}`, 'status');
            return;
          }
          if (event.type === 'output') {
            streamedOutput[event.stream] += event.data;
            appendBlock(event.data, event.stream);
            return;
          }
        },
      });
      (window as unknown as { __tracecodeLastTerminalResult?: unknown }).__tracecodeLastTerminalResult = result;
      const remainingStdout = result.stdout.startsWith(streamedOutput.stdout)
        ? result.stdout.slice(streamedOutput.stdout.length)
        : result.stdout;
      const remainingStderr = result.stderr.startsWith(streamedOutput.stderr)
        ? result.stderr.slice(streamedOutput.stderr.length)
        : result.stderr;
      appendBlock(remainingStdout, 'stdout');
      appendBlock(remainingStderr, 'stderr');
      if (result.exitCode !== 0) {
        appendLine(`exit ${result.exitCode}`, 'exit');
      }
    } catch (error) {
      appendLine(error instanceof Error ? error.message : String(error), 'stderr');
    } finally {
      updatePrompt();
      status.textContent = 'tracekernel ready';
      input.disabled = false;
      input.focus();
    }
  };

  const collectPrompt = (label: string, value: string): Promise<string> => {
    status.textContent = 'waiting for stdin';
    promptLabel = label;
    prompt.textContent = `${label}:`;
    input.value = value;
    input.disabled = false;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return new Promise((resolve) => {
      promptResolver = resolve;
    });
  };

  const runPromptedCommand = async (command: string, prompts: DemoPrompt[]): Promise<void> => {
    input.value = '';
    appendCommandLine(command);
    const answers: string[] = [];
    for (const item of prompts) {
      answers.push(await collectPrompt(item.label, item.value));
    }
    updatePrompt();
    await runTerminalCommand(command, {
      stdin: `${answers.join('\n')}\n`,
      env: { TRACE_DEMO_STDIN_COLLECTED: '1' },
    }, false);
  };

  const runCppDemo = async (): Promise<void> => {
    await runTerminalCommand('cd cpp && clang++ -std=c++17 report.cpp -o ../report');
    await runPromptedCommand('./report', [
      { label: 'Report title', value: 'Q2 mobile launch' },
      { label: 'Team name', value: 'TraceCode' },
      { label: 'Metric name', value: 'iPhone compiles' },
      { label: 'Metric value', value: '2' },
    ]);
    await runTerminalCommand('cat report.md');
  };

  const runJavaDemo = async (): Promise<void> => {
    await runTerminalCommand('javac java/TicketTriage.java');
    await runPromptedCommand('java -cp java TicketTriage', [
      { label: 'Customer', value: 'Acme Mobile' },
      { label: 'Severity (1-5)', value: '5' },
      { label: 'Issue summary', value: 'Java compiled from Safari on an iPhone' },
    ]);
    await runTerminalCommand('cat ticket.json');
  };

  const disposeTerminal = (): void => {
    workspace.dispose();
  };

  (
    window as Window & {
      __tracecodeProjectWorkspace?: typeof workspace;
    }
  ).__tracecodeProjectWorkspace = workspace;

  window.addEventListener('beforeunload', disposeTerminal);
  if (import.meta.hot) {
    import.meta.hot.dispose(disposeTerminal);
  }

  clearTerminalButton.addEventListener('click', () => {
    output.replaceChildren(form);
  });
  focusTerminalButton.addEventListener('click', () => {
    input.focus();
  });
  resetSessionButton.addEventListener('click', () => {
    resetSessionButton.disabled = true;
    appendLine('Restarting demo workspace...');
    void kernelStorage.clear()
      .then(() => {
        workspace.dispose();
        window.location.reload();
      })
      .catch((error) => {
        resetSessionButton.disabled = false;
        appendLine(error instanceof Error ? error.message : String(error), 'stderr');
      });
  });
  deleteLocalDataButton.addEventListener('click', () => {
    deleteLocalDataButton.disabled = true;
    appendLine('Deleting local demo data...');
    void workspace.destroy({ reason: 'user-requested', clearStorage: true })
      .then(() => {
        window.location.reload();
      })
      .catch((error) => {
        deleteLocalDataButton.disabled = false;
        appendLine(error instanceof Error ? error.message : String(error), 'stderr');
      });
  });
  cppDemoButton.addEventListener('click', () => {
    void runCppDemo();
  });
  javaDemoButton.addEventListener('click', () => {
    void runJavaDemo();
  });

  status.textContent = 'tracekernel ready';
  updatePrompt();
  appendLine('Project workspace ready.');
  appendLine('Try: ls, cat README.txt, cd cpp && clang++ -std=c++17 report.cpp -o ../report, ./report');
  appendLine('Then: javac java/TicketTriage.java, java -cp java TicketTriage');
  input.disabled = false;
  input.focus();

  const commandHistory: string[] = [];
  let historyIndex = 0;
  const submitTerminalCommand = (): void => {
    if (promptResolver) {
      const value = input.value;
      input.value = '';
      appendLine(`${promptLabel}: ${value}`, 'stdin');
      const resolve = promptResolver;
      promptResolver = null;
      resolve(value);
      return;
    }

    const command = input.value.trim();
    if (!command) return;
    if (commandHistory[commandHistory.length - 1] !== command) {
      commandHistory.push(command);
    }
    historyIndex = commandHistory.length;
    if (command === './report') {
      void runPromptedCommand(command, [
        { label: 'Report title', value: '' },
        { label: 'Team name', value: '' },
        { label: 'Metric name', value: '' },
        { label: 'Metric value', value: '' },
      ]);
      return;
    }
    if (command === 'java -cp java TicketTriage' || command === 'java --class-path java TicketTriage') {
      void runPromptedCommand(command, [
        { label: 'Customer', value: '' },
        { label: 'Severity (1-5)', value: '' },
        { label: 'Issue summary', value: '' },
      ]);
      return;
    }
    if (command === 'cpp') {
      void runCppDemo();
      return;
    }
    if (command === 'java-demo') {
      void runJavaDemo();
      return;
    }
    void runTerminalCommand(command);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitTerminalCommand();
      return;
    }
    if (promptResolver) return;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (commandHistory.length === 0) return;
      historyIndex = Math.max(0, historyIndex - 1);
      input.value = commandHistory[historyIndex] ?? '';
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (commandHistory.length === 0) return;
      historyIndex = Math.min(commandHistory.length, historyIndex + 1);
      input.value = commandHistory[historyIndex] ?? '';
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  document.querySelector<HTMLElement>('.dev-terminal')?.addEventListener('click', () => {
    input.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submitTerminalCommand();
  });
}

bootProjectTerminal().catch((error) => {
  document.body.innerHTML = '<pre class="dev-terminal-error"></pre>';
  document.querySelector<HTMLPreElement>('.dev-terminal-error')!.textContent =
    error instanceof Error ? error.stack ?? error.message : String(error);
});

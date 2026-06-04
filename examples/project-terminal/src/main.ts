import './styles.css';

import type {
  RuntimeCommandEvent,
  RuntimeCommandResult,
  RuntimeProjectTerminalInputState,
  RuntimeWorkspaceEvent,
} from '@tracecode/harness/core';

async function bootProjectTerminal(): Promise<void> {
  document.body.innerHTML = `
    <main class="dev-terminal-root">
      <section class="dev-terminal" aria-label="Tracekernel terminal">
        <div class="dev-terminal-output" id="dev-terminal-output" aria-live="polite">
          <form class="dev-terminal-form" id="dev-terminal-form">
            <span class="dev-terminal-prompt" id="dev-terminal-prompt">user@tracevm demo %</span>
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
  const form = document.querySelector<HTMLFormElement>('#dev-terminal-form')!;
  const input = document.querySelector<HTMLInputElement>('#dev-terminal-input')!;
  const prompt = document.querySelector<HTMLSpanElement>('#dev-terminal-prompt')!;

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

  const { createBrowserProjectWorkspace } = await import('@tracecode/harness/browser/project');
  (
    window as Window & {
      __tracecodeCreateBrowserProjectWorkspace?: typeof createBrowserProjectWorkspace;
    }
  ).__tracecodeCreateBrowserProjectWorkspace = createBrowserProjectWorkspace;

  const workspace = await createBrowserProjectWorkspace({
    assetBaseUrl: '/workers',
    javaProjectTimeoutMs: 120_000,
    cppProjectTimeoutMs: 120_000,
    kernel: {
      user: { username: 'user' },
      host: { hostname: 'tracevm' },
      workspace: { name: 'demo' },
    },
    projectSession: {
      id: 'demo',
      projectId: 'demo',
      projectSlug: 'demo',
      name: 'iPhone Compile Demo',
      language: 'mixed',
      commands: {
        cpp: 'cd cpp && clang++ -std=c++17 report.cpp -o ../report',
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
            '  ../report',
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

  let reloadingForTraceKernelReset = false;
  const unsubscribeWorkspaceEvents = workspace.watch((event: RuntimeWorkspaceEvent) => {
    if (
      event.type === 'lifecycle' &&
      event.phase === 'session-destroyed' &&
      event.detail?.reason === 'tracekernelctl-reset' &&
      !reloadingForTraceKernelReset
    ) {
      reloadingForTraceKernelReset = true;
      window.location.reload();
    }
  });

  const applyTerminalInputState = (state: RuntimeProjectTerminalInputState): void => {
    prompt.textContent = state.label;
    input.value = '';
    input.disabled = state.disabled;
    form.hidden = state.hidden;
    if (!state.disabled && !state.hidden) {
      input.focus();
    }
  };

  const terminalSession = workspace.createTerminalSession({
    onTerminalEvent: (event) => {
      applyTerminalInputState(event.state);
    },
  });

  const runTerminalCommand = async (
    command: string,
    options: { env?: Record<string, string> } = {},
    echoCommand = true
  ): Promise<RuntimeCommandResult> => {
    input.value = '';
    input.disabled = true;
    form.hidden = true;
    if (echoCommand) appendCommandLine(command);

    try {
      if (command === 'clear') {
        output.replaceChildren(form);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command === 'help') {
        appendLine('C++:  cd cpp && clang++ -std=c++17 report.cpp -o ../report', 'status');
        appendLine('      ../report', 'status');
        appendLine('Java: javac java/TicketTriage.java && java -cp java TicketTriage', 'status');
        appendLine('Reset: tracekernelctl reset', 'status');
        return { stdout: '', stderr: '', exitCode: 0 };
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
            if (event.terminal?.role === 'stdin-prompt') {
              return;
            }
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
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLine(message, 'stderr');
      return { stdout: '', stderr: `${message}\n`, exitCode: 1 };
    } finally {
      applyTerminalInputState(terminalSession.inputState);
    }
  };

  const runCppDemo = async (): Promise<void> => {
    await runTerminalCommand('cd cpp && clang++ -std=c++17 report.cpp -o ../report');
    await runTerminalCommand('../report');
    await runTerminalCommand('cat report.md');
  };

  const runJavaDemo = async (): Promise<void> => {
    await runTerminalCommand('javac java/TicketTriage.java');
    await runTerminalCommand('java -cp java TicketTriage');
    await runTerminalCommand('cat ticket.json');
  };

  const disposeTerminal = (): void => {
    unsubscribeWorkspaceEvents();
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

  applyTerminalInputState(terminalSession.inputState);
  appendLine('Try: ls, cat README.txt');
  appendLine('C++: cd cpp && clang++ -std=c++17 report.cpp -o ../report');
  appendLine('     ../report');
  appendLine('Java: javac java/TicketTriage.java');
  appendLine('      java -cp java TicketTriage');
  appendLine('Reset saved demo data with: tracekernelctl reset');
  input.disabled = false;
  input.focus();

  const commandHistory: string[] = [];
  let historyIndex = 0;
  const submitTerminalCommand = (): void => {
    if (terminalSession.inputState.mode === 'stdin') {
      const value = input.value;
      appendLine(`${terminalSession.inputState.label}${value}`, 'stdin');
      terminalSession.writeStdin(`${value}\n`);
      return;
    }

    const command = input.value.trim();
    if (!command) return;
    if (commandHistory[commandHistory.length - 1] !== command) {
      commandHistory.push(command);
    }
    historyIndex = commandHistory.length;
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
    if (terminalSession.inputState.mode !== 'command') return;
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

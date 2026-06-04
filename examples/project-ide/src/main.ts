import './styles.css';

import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

import { getRuntimeProjectIoCapabilityMatrix } from '@tracecode/harness/browser';
import type { Language, RuntimeCommandEvent, RuntimeWorkspaceEvent } from '@tracecode/harness/core';

// ----------------------------------------------------------------------
// Monaco Environment Setup
// ----------------------------------------------------------------------
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  }
};

monaco.editor.defineTheme('tracecodeDark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { background: '1e1f22', token: '' }
  ],
  colors: {
    'editor.background': '#1e1f22',
    'editor.lineHighlightBackground': '#26282e',
    'editorLineNumber.foreground': '#585b63',
    'editorIndentGuide.background': '#393b40',
    'editor.selectionBackground': '#2d5fa566',
    'scrollbarSlider.background': '#393b4080',
    'scrollbarSlider.hoverBackground': '#4e515780',
    'scrollbarSlider.activeBackground': '#5a5d63',
  }
});

// ----------------------------------------------------------------------
// Constants & Fixtures
// ----------------------------------------------------------------------
const getEditorLanguage = (lang: Language): string => {
  if (lang === 'typescript') return 'typescript';
  if (lang === 'javascript') return 'javascript';
  if (lang === 'python') return 'python';
  if (lang === 'java') return 'java';
  if (lang === 'csharp') return 'csharp';
  if (lang === 'cpp') return 'cpp';
  return 'plaintext';
};

async function bootDevTerminal(): Promise<void> {
  document.body.innerHTML = `
    <main class="dev-ide-root">
      <header class="dev-menubar">
        <div class="dev-menu-group">
          <button class="dev-menu-trigger" type="button">File</button>
          <div class="dev-menu-popover">
            <button id="dev-menu-new-file" type="button">New File</button>
            <button id="dev-menu-save-file" type="button">Save</button>
            <button id="dev-menu-refresh-files" type="button">Refresh Explorer</button>
            <div class="dev-menu-separator" role="separator"></div>
            <button id="dev-menu-reset-session" type="button">Restart Project Session</button>
            <button id="dev-menu-delete-local-data" type="button">Destroy Project Session</button>
          </div>
        </div>
        <div class="dev-menu-group">
          <button class="dev-menu-trigger" type="button">Edit</button>
          <div class="dev-menu-popover">
            <button id="dev-menu-format-file" type="button">Format Document</button>
            <button id="dev-menu-clear-terminal" type="button">Clear Terminal</button>
          </div>
        </div>
        <div class="dev-menu-group">
          <button class="dev-menu-trigger" type="button">View</button>
          <div class="dev-menu-popover">
            <button id="dev-menu-focus-terminal" type="button">Terminal</button>
            <button id="dev-menu-focus-explorer" type="button">Explorer</button>
          </div>
        </div>
        <div class="dev-menu-group">
          <button class="dev-menu-trigger" type="button">Run</button>
          <div class="dev-menu-popover">
            <button id="dev-menu-run-current" type="button">Run Current File</button>
            <button id="dev-menu-run-project-start" type="button">Run Project Start</button>
            <button id="dev-menu-run-project-test" type="button">Run Project Test</button>
            <button id="dev-menu-run-project-build" type="button">Run Project Build</button>
            <div class="dev-menu-separator" role="separator"></div>
            <div id="dev-menu-session-commands" class="dev-menu-session-commands"></div>
            <button id="dev-menu-run-mvp" type="button">Run MVP Checks</button>
          </div>
        </div>
        <div class="dev-menu-spacer"></div>
        <button class="dev-stop-command" id="dev-stop-command" type="button" disabled>Stop</button>
        <span class="dev-workspace-name">tracekernel / weather-api</span>
        <span class="dev-terminal-status" id="dev-terminal-status">tracekernel booting</span>
      </header>
      <section class="dev-workbench">
        <aside class="dev-explorer">
          <div class="dev-explorer-header">
            <span>Explorer</span>
            <div class="dev-explorer-actions">
              <button id="dev-new-file" type="button" title="New file">+</button>
              <button id="dev-new-folder" type="button" title="New folder">/</button>
              <button id="dev-refresh-files" type="button" title="Refresh explorer">R</button>
            </div>
          </div>
          <div class="dev-explorer-root-label">/home/user/weather-api</div>
          <div class="dev-file-tree" id="dev-file-tree"></div>
          <section class="dev-session-card">
            <div class="dev-session-title">Project Session</div>
            <div class="dev-session-meta" id="dev-session-meta">loading</div>
            <div class="dev-command-list" id="dev-session-command-list"></div>
          </section>
        </aside>
        <section class="dev-editor-shell">
          <div class="dev-editor-tabs">
            <div class="dev-editor-tab active">
              <span id="dev-current-file">main.py</span>
              <span class="dev-dirty-indicator" id="dev-dirty-indicator"></span>
            </div>
          </div>
          <div id="dev-editor-root" class="dev-monaco-root"></div>
        </section>
      </section>
      <footer class="dev-bottom-panel">
        <div class="dev-bottom-tabs">
          <button class="active" type="button">Terminal</button>
        </div>
        <section class="dev-terminal">
          <div class="dev-terminal-output" id="dev-terminal-output" aria-live="polite">
            <form class="dev-terminal-form" id="dev-terminal-form">
              <span class="dev-terminal-prompt" id="dev-terminal-prompt">user@tracevm weather-api %</span>
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
      </footer>
    </main>
  `;

  const output = document.querySelector<HTMLDivElement>('#dev-terminal-output')!;
  const status = document.querySelector<HTMLSpanElement>('#dev-terminal-status')!;
  const stopCommandButton = document.querySelector<HTMLButtonElement>('#dev-stop-command')!;
  const form = document.querySelector<HTMLFormElement>('#dev-terminal-form')!;
  const input = document.querySelector<HTMLInputElement>('#dev-terminal-input')!;
  const prompt = document.querySelector<HTMLSpanElement>('#dev-terminal-prompt')!;
  const fileTree = document.querySelector<HTMLDivElement>('#dev-file-tree')!;
  const editorRoot = document.querySelector<HTMLDivElement>('#dev-editor-root')!;
  const currentFileLabel = document.querySelector<HTMLSpanElement>('#dev-current-file')!;
  const dirtyIndicator = document.querySelector<HTMLSpanElement>('#dev-dirty-indicator')!;
  const newFileButton = document.querySelector<HTMLButtonElement>('#dev-new-file')!;
  const menuNewFileButton = document.querySelector<HTMLButtonElement>('#dev-menu-new-file')!;
  const newFolderButton = document.querySelector<HTMLButtonElement>('#dev-new-folder')!;
  const saveFileButton = document.querySelector<HTMLButtonElement>('#dev-menu-save-file')!;
  const refreshFilesButton = document.querySelector<HTMLButtonElement>('#dev-refresh-files')!;
  const menuRefreshFilesButton = document.querySelector<HTMLButtonElement>('#dev-menu-refresh-files')!;
  const resetSessionButton = document.querySelector<HTMLButtonElement>('#dev-menu-reset-session')!;
  const deleteLocalDataButton = document.querySelector<HTMLButtonElement>('#dev-menu-delete-local-data')!;
  const formatFileButton = document.querySelector<HTMLButtonElement>('#dev-menu-format-file')!;
  const clearTerminalButton = document.querySelector<HTMLButtonElement>('#dev-menu-clear-terminal')!;
  const focusTerminalButton = document.querySelector<HTMLButtonElement>('#dev-menu-focus-terminal')!;
  const focusExplorerButton = document.querySelector<HTMLButtonElement>('#dev-menu-focus-explorer')!;
  const runCurrentButton = document.querySelector<HTMLButtonElement>('#dev-menu-run-current')!;
  const runProjectStartButton = document.querySelector<HTMLButtonElement>('#dev-menu-run-project-start')!;
  const runProjectTestButton = document.querySelector<HTMLButtonElement>('#dev-menu-run-project-test')!;
  const runProjectBuildButton = document.querySelector<HTMLButtonElement>('#dev-menu-run-project-build')!;
  const runMvpButton = document.querySelector<HTMLButtonElement>('#dev-menu-run-mvp')!;
  const sessionCommandMenu = document.querySelector<HTMLDivElement>('#dev-menu-session-commands')!;
  const sessionCommandList = document.querySelector<HTMLDivElement>('#dev-session-command-list')!;
  const sessionMeta = document.querySelector<HTMLDivElement>('#dev-session-meta')!;

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

  appendLine('Loading project workspace...');

  const { createBrowserProjectWorkspace } = await import('@tracecode/harness/browser/project');
  (
    window as Window & {
      __tracecodeCreateBrowserProjectWorkspace?: typeof createBrowserProjectWorkspace;
    }
  ).__tracecodeCreateBrowserProjectWorkspace = createBrowserProjectWorkspace;

  const workspace = await createBrowserProjectWorkspace({
    assetBaseUrl: '/workers',
    pythonProjectTimeoutMs: 120_000,
    javaProjectTimeoutMs: 120_000,
    csharpProjectTimeoutMs: 120_000,
    cppProjectTimeoutMs: 120_000,
    kernel: {
      user: { username: 'user' },
      host: { hostname: 'tracevm' },
      workspace: { name: 'weather-api' },
    },
    projectSession: {
      id: 'dev-weather-api',
      projectId: 'dev-project',
      projectSlug: 'weather-api',
      name: 'Weather API',
      language: 'mixed',
      commands: {
        start: 'python3 main.py',
        test: {
          steps: [
            'python3 takehome/python/main.py',
            'node takehome/js/main.js',
            'tsc --project takehome/ts/tsconfig.json',
            'node takehome/ts/dist/index.js',
            'javac -d takehome/java/out takehome/java/stressjava/Main.java takehome/java/stressjava/Order.java takehome/java/stressjava/OrderParser.java takehome/java/stressjava/ReportWriter.java',
            'java --class-path takehome/java/out stressjava.Main',
            { command: 'clang++ -std=c++17 main.cpp order.cpp -o ../analyzer', cwd: 'takehome/cpp/src' },
            { command: './analyzer', cwd: 'takehome/cpp' },
            'dotnet run --project takehome/csharp/app/App.csproj',
          ],
        },
        build: {
          steps: [
            'javac Main.java',
            'clang++ -std=c++17 main.cpp helper.cpp -o session-cpp',
            'dotnet build WeatherApi.csproj --nologo',
            'dotnet build takehome/csharp/app/App.csproj --nologo',
          ],
        },
        mvp: 'mvp',
        python: 'python3 main.py',
        node: 'node index.js',
        typescript: {
          steps: [
            'tsc --project takehome/ts/tsconfig.json',
            'node takehome/ts/dist/index.js',
          ],
        },
        java: 'javac Main.java && java Main',
        csharp: 'dotnet run -- alpha beta',
        cpp: 'clang++ -std=c++17 main.cpp helper.cpp && ./a.out',
      },
      metadata: {
        source: 'web-ide-dev',
      },
      files: [
      {
        path: 'helper.py',
        contents: `def add(left, right):
    return left + right
`,
      },
      {
        path: 'main.py',
        contents: `from helper import add
import sys

print(add(2, 3))
if len(sys.argv) > 1:
    print("args=" + ",".join(sys.argv[1:]))
`,
      },
      {
        path: 'app/__init__.py',
        contents: '',
      },
      {
        path: 'app/mathlib.py',
        contents: `def add(left, right):
    return left + right
`,
      },
      {
        path: 'app/main.py',
        contents: `from .mathlib import add
import sys

print(add(2, 3))
print("package=" + str(__package__))
if len(sys.argv) > 1:
    print("module_args=" + ",".join(sys.argv[1:]))
`,
      },
      {
        path: 'src/py/helper.py',
        contents: `def value():
    return 31
`,
      },
      {
        path: 'src/py/main.py',
        contents: `import os
from helper import value

print(os.getcwd())
print(value())
open("generated.txt", "w").write("created\\n")
`,
      },
      {
        path: 'vendor/pkgtools.py',
        contents: `def value():
    return 42
`,
      },
      {
        path: 'py_env.py',
        contents: `import os
from pkgtools import value

print(value())
print(os.environ.get("MODE"))
`,
      },
      {
        path: 'pkg_a/__init__.py',
        contents: '',
      },
      {
        path: 'pkg_a/helper.py',
        contents: `def value():
    return "a-helper"
`,
      },
      {
        path: 'pkg_a/main.py',
        contents: `from .helper import value

print(value())
open("pkg-a-generated.txt", "w").write(value() + "\\n")
`,
      },
      {
        path: 'pkg_b/__init__.py',
        contents: '',
      },
      {
        path: 'pkg_b/helper.py',
        contents: `def value():
    return "b-helper"
`,
      },
      {
        path: 'pkg_b/main.py',
        contents: `from .helper import value

print(value())
open("pkg-b-generated.txt", "w").write(value() + "\\n")
`,
      },
      {
        path: 'vendor/pkg_b/helper.py',
        contents: `def value():
    return "vendor-helper"
`,
      },
      {
        path: 'reload_target.py',
        contents: `def value():
    return "old"
`,
      },
      {
        path: 'reload_main.py',
        contents: `from reload_target import value

print(value())
`,
      },
      {
        path: 'stale.txt',
        contents: 'delete me\n',
      },
      {
        path: 'java-stale.txt',
        contents: 'delete me\n',
      },
      {
        path: 'README.txt',
        contents: 'Try: ls, cat main.py, python3 main.py alpha beta, python3 globpy/*.py data/*.txt, python3 -m app.main alpha beta, node index.js alpha beta, node globjs/*.js data/*.txt, javac -d out src/app/PackageMain.java src/app/PackageHelper.java, javac -d glob-out src/app/*.java, java --class-path out app.PackageMain alpha beta, java --class-path glob-out app.PackageMain alpha beta, java Main alpha beta, java app.PackageMain alpha beta, java right.Main, dotnet run -- alpha beta, dotnet run -- data/*.txt, clang++ -std=c++17 main.cpp helper.cpp, clang++ -std=c++17 *.cpp -o glob-app, ./a.out alpha beta, ./glob-app alpha beta, ./glob-app data/*.txt\\n',
      },
      {
        path: 'instructions/brief.md',
        readonly: true,
        contents: 'readonly project brief\n',
      },
      {
        path: 'data/a.txt',
        contents: 'a\n',
      },
      {
        path: 'data/b.txt',
        contents: 'b\n',
      },
      {
        path: 'takehome/data/orders.csv',
        contents: [
          'customer,sku,quantity,price',
          'Acme,widget,2,19.50',
          'Beacon,gadget,1,29.00',
          'Acme,gadget,3,29.00',
          '',
        ].join('\n'),
      },
      {
        path: 'takehome/python/orders.py',
        contents: `from dataclasses import dataclass
from pathlib import Path

@dataclass
class Order:
    customer: str
    sku: str
    quantity: int
    price: float

    @property
    def total(self):
        return self.quantity * self.price

def load_orders(path):
    rows = Path(path).read_text().strip().splitlines()[1:]
    orders = []
    for row in rows:
        customer, sku, quantity, price = row.split(",")
        orders.append(Order(customer, sku, int(quantity), float(price)))
    return orders
`,
      },
      {
        path: 'takehome/python/report.py',
        contents: `from collections import defaultdict
from pathlib import Path

def write_summary(orders, output_path):
    totals = defaultdict(float)
    for order in orders:
        totals[order.customer] += order.total
    top_customer = max(totals.items(), key=lambda item: item[1])[0]
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text(f"top={top_customer}\\ncount={len(orders)}\\n")
    return top_customer
`,
      },
      {
        path: 'takehome/python/main.py',
        contents: `from pathlib import Path
from orders import load_orders
from report import write_summary

ROOT = Path(__file__).resolve().parents[1]
orders = load_orders(ROOT / "data" / "orders.csv")
top = write_summary(orders, ROOT / "python" / "reports" / "summary.txt")
print(f"python:{top}:takehome")
print(Path.cwd())
`,
      },
      {
        path: 'takehome/js/orders.js',
        contents: `const fs = require("fs");

function loadOrders(path) {
  return fs.readFileSync(path, "utf8").trim().split("\\n").slice(1).map((row) => {
    const [customer, sku, quantity, price] = row.split(",");
    return { customer, sku, quantity: Number(quantity), price: Number(price), total: Number(quantity) * Number(price) };
  });
}

module.exports = { loadOrders };
`,
      },
      {
        path: 'takehome/js/report.js',
        contents: `const fs = require("fs");
const path = require("path");

function writeSummary(orders, outputPath) {
  const totals = new Map();
  for (const order of orders) {
    totals.set(order.customer, (totals.get(order.customer) ?? 0) + order.total);
  }
  const [topCustomer] = [...totals.entries()].sort((left, right) => right[1] - left[1])[0];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, \`top=\${topCustomer}\\ncount=\${orders.length}\\n\`);
  return topCustomer;
}

module.exports = { writeSummary };
`,
      },
      {
        path: 'takehome/js/main.js',
        contents: `const path = require("path");
const { loadOrders } = require("./orders");
const { writeSummary } = require("./report");

const root = path.resolve(__dirname, "..");
const orders = loadOrders(path.join(root, "data", "orders.csv"));
const top = writeSummary(orders, path.join(root, "js", "reports", "summary.txt"));
console.log(\`node:\${top}:takehome\`);
console.log(process.cwd());
`,
      },
      {
        path: 'takehome/ts/tsconfig.json',
        contents: JSON.stringify({
          compilerOptions: {
            outDir: 'dist',
            rootDir: '.',
            module: 'commonjs',
            target: 'es2020',
            strict: true,
          },
          files: ['index.ts', 'orders.ts', 'report.ts'],
        }, null, 2),
      },
      {
        path: 'takehome/ts/orders.ts',
        contents: `export interface Order {
  customer: string;
  sku: string;
  quantity: number;
  price: number;
  total: number;
}

export function parseOrders(csv: string): Order[] {
  return csv.trim().split("\\n").slice(1).map((row) => {
    const [customer, sku, quantity, price] = row.split(",");
    const parsedQuantity = Number(quantity);
    const parsedPrice = Number(price);
    return { customer, sku, quantity: parsedQuantity, price: parsedPrice, total: parsedQuantity * parsedPrice };
  });
}
`,
      },
      {
        path: 'takehome/ts/report.ts',
        contents: `import type { Order } from "./orders";

export function summarize(orders: Order[]): { top: string; count: number } {
  const totals: Record<string, number> = {};
  for (const order of orders) {
    totals[order.customer] = (totals[order.customer] ?? 0) + order.total;
  }
  let top = "";
  let topTotal = -1;
  for (const customer in totals) {
    const total = totals[customer];
    if (total > topTotal) {
      top = customer;
      topTotal = total;
    }
  }
  return { top, count: orders.length };
}
`,
      },
      {
        path: 'takehome/ts/index.ts',
        contents: `import { parseOrders } from "./orders";
import { summarize } from "./report";

const fs = require("fs");
const path = require("path");
const root = path.resolve("takehome");
const orders = parseOrders(fs.readFileSync(path.join(root, "data", "orders.csv"), "utf8"));
const summary = summarize(orders);
fs.mkdirSync(path.join(root, "ts", "reports"), { recursive: true });
fs.writeFileSync(path.join(root, "ts", "reports", "summary.txt"), \`top=\${summary.top}\\ncount=\${summary.count}\\n\`);
console.log(\`ts:\${summary.top}:takehome\`);
`,
      },
      {
        path: 'takehome/java/stressjava/Order.java',
        contents: `package stressjava;

class Order {
  final String customer;
  final int quantity;
  final double price;
  Order(String customer, int quantity, double price) {
    this.customer = customer;
    this.quantity = quantity;
    this.price = price;
  }
  double total() { return quantity * price; }
}
`,
      },
      {
        path: 'takehome/java/stressjava/OrderParser.java',
        contents: `package stressjava;

import java.nio.file.*;
import java.util.*;

class OrderParser {
  static List<Order> load(Path path) throws Exception {
    List<Order> orders = new ArrayList<>();
    for (String row : Files.readAllLines(path).subList(1, Files.readAllLines(path).size())) {
      String[] parts = row.split(",");
      orders.add(new Order(parts[0], Integer.parseInt(parts[2]), Double.parseDouble(parts[3])));
    }
    return orders;
  }
}
`,
      },
      {
        path: 'takehome/java/stressjava/ReportWriter.java',
        contents: `package stressjava;

import java.nio.file.*;
import java.util.*;

class ReportWriter {
  static String write(List<Order> orders, Path output) throws Exception {
    Map<String, Double> totals = new HashMap<>();
    for (Order order : orders) totals.merge(order.customer, order.total(), Double::sum);
    String top = Collections.max(totals.entrySet(), Map.Entry.comparingByValue()).getKey();
    Files.createDirectories(output.getParent());
    Files.writeString(output, "top=" + top + "\\ncount=" + orders.size() + "\\n");
    return top;
  }
}
`,
      },
      {
        path: 'takehome/java/stressjava/Main.java',
        contents: `package stressjava;

import java.nio.file.*;
import java.util.*;

public class Main {
  public static void main(String[] args) throws Exception {
    List<Order> orders = OrderParser.load(Path.of("takehome/data/orders.csv"));
    String top = ReportWriter.write(orders, Path.of("takehome/java/reports/summary.txt"));
    System.out.println("java:" + top + ":takehome");
    System.out.println(System.getProperty("user.dir"));
  }
}
`,
      },
      {
        path: 'takehome/cpp/src/order.hpp',
        contents: `#pragma once

#include <string>
#include <vector>

struct Order {
  std::string customer;
  int quantity;
  double price;
  double total() const;
};

std::vector<Order> load_orders(const std::string& path);
std::string write_summary(const std::vector<Order>& orders, const std::string& output_path);
`,
      },
      {
        path: 'takehome/cpp/src/order.cpp',
        contents: `#include "order.hpp"

#include <fstream>
#include <map>
#include <sstream>

double Order::total() const {
  return quantity * price;
}

std::vector<Order> load_orders(const std::string& path) {
  std::ifstream input(path);
  std::string row;
  std::getline(input, row);
  std::vector<Order> orders;
  while (std::getline(input, row)) {
    std::stringstream stream(row);
    std::string customer, sku, quantity, price;
    std::getline(stream, customer, ',');
    std::getline(stream, sku, ',');
    std::getline(stream, quantity, ',');
    std::getline(stream, price, ',');
    orders.push_back({customer, std::stoi(quantity), std::stod(price)});
  }
  return orders;
}

std::string write_summary(const std::vector<Order>& orders, const std::string& output_path) {
  std::map<std::string, double> totals;
  for (const auto& order : orders) totals[order.customer] += order.total();
  std::string top;
  double top_total = -1;
  for (const auto& entry : totals) {
    if (entry.second > top_total) {
      top = entry.first;
      top_total = entry.second;
    }
  }
  std::ofstream output(output_path);
  output << "top=" << top << "\\ncount=" << orders.size() << "\\n";
  return top;
}
`,
      },
      {
        path: 'takehome/cpp/src/main.cpp',
        contents: `#include "order.hpp"

#include <iostream>

int main() {
  auto orders = load_orders("../data/orders.csv");
  auto top = write_summary(orders, "summary.txt");
  std::cout << "cpp:" << top << ":takehome\\n";
  return 0;
}
`,
      },
      {
        path: 'takehome/csharp/app/App.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <ImplicitUsings>enable</ImplicitUsings>',
          '    <Nullable>disable</Nullable>',
          '  </PropertyGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      {
        path: 'takehome/csharp/app/Order.cs',
        contents: 'record Order(string Customer, string Sku, int Quantity, double Price) { public double Total => Quantity * Price; }\n',
      },
      {
        path: 'takehome/csharp/app/Parser.cs',
        contents: `static class Parser
{
  public static List<Order> Load(string path) =>
    File.ReadAllLines(path).Skip(1).Select(row => {
      var parts = row.Split(',');
      return new Order(parts[0], parts[1], int.Parse(parts[2]), double.Parse(parts[3]));
    }).ToList();
}
`,
      },
      {
        path: 'takehome/csharp/app/Program.cs',
        contents: `var orders = Parser.Load("takehome/data/orders.csv");
var top = orders.GroupBy(order => order.Customer).OrderByDescending(group => group.Sum(order => order.Total)).First().Key;
Directory.CreateDirectory("takehome/csharp/reports");
File.WriteAllText("takehome/csharp/reports/summary.txt", $"top={top}\\ncount={orders.Count}\\n");
Console.WriteLine($"csharp:{top}:takehome");
try {
  System.Diagnostics.Process.Start("echo", "child");
} catch (Exception error) {
  Console.WriteLine("process-error=" + error.GetType().Name);
}
`,
      },
      {
        path: 'globpy/run.py',
        contents: `import sys

print(2 + 3)
print("python_glob_args=" + ",".join(sys.argv[1:]))
`,
      },
      {
        path: 'math.js',
        contents: `exports.add = (left, right) => left + right;
`,
      },
      {
        path: 'index.js',
        contents: `const { add } = require("./math");

console.log(add(2, 3));
if (process.argv.length > 2) {
  console.log("node_args=" + process.argv.slice(2).join(","));
}
`,
      },
      {
        path: 'globjs/run.js',
        contents: `console.log(2 + 3);
console.log("node_glob_args=" + process.argv.slice(2).join(","));
`,
      },
      {
        path: 'Helper.java',
        contents: `class Helper {
  static int add(int left, int right) {
    return left + right;
  }
}
`,
      },
      {
        path: 'Main.java',
        contents: `class Main {
  public static void main(String[] args) {
    System.out.println(Helper.add(2, 3));
    if (args.length > 0) {
      System.out.println("java_args=" + String.join(",", args));
    }
  }
}
`,
      },
      {
        path: 'src/app/PackageHelper.java',
        contents: `package app;

class PackageHelper {
  static int add(int left, int right) {
    return left + right;
  }
}
`,
      },
      {
        path: 'src/app/PackageMain.java',
        contents: `package app;

public class PackageMain {
  public static void main(String[] args) {
    System.out.println(PackageHelper.add(2, 3));
    if (args.length > 0) {
      System.out.println("java_package_args=" + String.join(",", args));
    }
  }
}
`,
      },
      {
        path: 'src/left/Main.java',
        contents: `package left;

public class Main {
  public static int value() {
    return 5;
  }
}
`,
      },
      {
        path: 'src/right/Main.java',
        contents: `package right;

public class Main {
  public static void main(String[] args) {
    System.out.println(left.Main.value());
  }
}
`,
      },
      {
        path: 'src/javawd/CwdMain.java',
        contents: `public class CwdMain {
  public static void main(String[] args) throws Exception {
    System.out.println(System.getProperty("user.dir"));
    System.out.println(System.getProperty("user.home"));
    System.out.println(System.getProperty("user.name"));
    System.out.println(System.getProperty("os.name"));
    System.out.println(System.getProperty("os.version"));
    java.nio.file.Path cwd = java.nio.file.Path.of(System.getProperty("user.dir"));
    java.nio.file.Files.writeString(cwd.resolve("generated.txt"), "java-created\\n");
    java.nio.file.Files.writeString(java.nio.file.Path.of("cwd-generated.txt"), "cwd-created\\n");
    java.nio.file.Files.writeString(java.nio.file.Path.of("props.txt"), System.getProperty("user.dir") + "\\n" + System.getProperty("os.name") + "\\n");
    java.nio.file.Files.deleteIfExists(cwd.resolve("../../java-stale.txt").normalize());
  }
}
`,
      },
      {
        path: 'src/javacwd/CompileMain.java',
        contents: `public class CompileMain {
  public static void main(String[] args) {
    System.out.println("cwd-compile");
  }
}
`,
      },
      {
        path: 'src/javaarg/ArgMain.java',
        contents: `public class ArgMain {
  public static void main(String[] args) {
    System.out.println("argfile-compile");
  }
}
`,
      },
      {
        path: 'src/javaarg/javac.args',
        contents: `-d out
ArgMain.java
`,
      },
      {
        path: 'src/javasourcepath/src/app/Main.java',
        contents: `package app;

public class Main {
  public static void main(String[] args) {
    System.out.println(Helper.value());
  }
}
`,
      },
      {
        path: 'src/javasourcepath/src/app/Helper.java',
        contents: `package app;

class Helper {
  static String value() {
    return "sourcepath-helper";
  }
}
`,
      },
      {
        path: 'src/javasourcepath/javac.args',
        contents: `-d out
-sourcepath src
src/app/Main.java
`,
      },
      {
        path: 'src/javastdin/InputMain.java',
        contents: `public class InputMain {
  public static void main(String[] args) throws Exception {
    java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));
    System.out.println("stdin=" + reader.readLine());
  }
}
`,
      },
      {
        path: 'Program.cs',
        contents: `using System;

Console.WriteLine(Helper.Add(2, 3));
if (args.Length > 0) {
  Console.WriteLine("csharp_args=" + string.Join(",", args));
}
`,
      },
      {
        path: 'WeatherApi.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <ImplicitUsings>enable</ImplicitUsings>',
          '    <Nullable>disable</Nullable>',
          '    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>',
          '  </PropertyGroup>',
          '  <ItemGroup>',
          '    <Compile Include="Program.cs" />',
          '    <Compile Include="Helper.cs" />',
          '  </ItemGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      {
        path: 'Helper.cs',
        contents: `static class Helper
{
  public static int Add(int left, int right) => left + right;
}
`,
      },
      {
        path: 'helper.hpp',
        contents: `#pragma once

int add(int left, int right);
`,
      },
      {
        path: 'helper.cpp',
        contents: `#include "helper.hpp"

int add(int left, int right) {
  return left + right;
}
`,
      },
      {
        path: 'main.cpp',
        contents: `#include "helper.hpp"

#include <iostream>
#include <string>

int main(int argc, char** argv) {
  std::cout << add(2, 3) << "\\n";
  if (argc > 1) {
    std::cout << "cpp_args=";
    for (int index = 1; index < argc; ++index) {
      if (index > 1) std::cout << ",";
      std::cout << argv[index];
    }
    std::cout << "\\n";
  }
  return 0;
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
      event.detail.reason === 'tracekernelctl-reset' &&
      !reloadingForTraceKernelReset
    ) {
      reloadingForTraceKernelReset = true;
      window.location.reload();
    }
  });

  const terminalSession = workspace.createTerminalSession();
  const visibleProjectCommands = (): NonNullable<typeof workspace.projectSession>['commands'] => {
    const commands = workspace.projectSession?.commands ?? {};
    return Object.fromEntries(Object.entries(commands).filter(([, command]) => command.hidden !== true));
  };
  const setProjectCommandButtons = (): void => {
    const commands = visibleProjectCommands();
    runProjectStartButton.disabled = !commands.start;
    runProjectTestButton.disabled = !commands.test;
    runProjectBuildButton.disabled = !commands.build;
    const session = workspace.projectSession;
    sessionMeta.textContent = session
      ? `${session.name ?? session.projectSlug ?? session.id} · ${session.language ?? 'project'} · ${session.workspaceRoot}`
      : 'No project session';
  };
  const updatePrompt = (): void => {
    prompt.textContent = terminalSession.prompt.text;
  };

  let activeFilePath = 'main.py';
  let activeCommandController: AbortController | null = null;
  const collapsedDirectories = new Set<string>();
  let suppressEditorChange = false;
  let saveTimer: number | undefined;

  const inferMonacoLanguage = (path: string): string => {
    if (path.endsWith('.py')) return 'python';
    if (path.endsWith('.js') || path.endsWith('.mjs')) return 'javascript';
    if (path.endsWith('.ts')) return 'typescript';
    if (path.endsWith('.java')) return 'java';
    if (path.endsWith('.cs') || path.endsWith('.csproj')) return 'csharp';
    if (path.endsWith('.cpp') || path.endsWith('.hpp') || path.endsWith('.h')) return 'cpp';
    if (path.endsWith('.json')) return 'json';
    return 'plaintext';
  };

  const projectEditor = monaco.editor.create(editorRoot, {
    value: '',
    language: 'python',
    theme: 'tracecodeDark',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
    lineHeight: 22,
    padding: { top: 12, bottom: 12 },
    scrollBeyondLastLine: false,
  });

  const markClean = (): void => {
    dirtyIndicator.textContent = '';
    status.textContent = 'tracekernel ready';
  };

  const saveActiveFile = async (): Promise<void> => {
    if (workspace.isReadOnly(activeFilePath)) {
      status.textContent = 'readonly';
      throw new Error(`Readonly project file: ${activeFilePath}`);
    }
    await workspace.writeFile(activeFilePath, projectEditor.getValue());
    markClean();
  };

  projectEditor.onDidChangeModelContent(() => {
    if (suppressEditorChange) return;
    dirtyIndicator.textContent = 'edited';
    status.textContent = 'saving';
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveActiveFile().then(renderFileTree).catch((error) => {
        status.textContent = 'save failed';
        appendLine(error instanceof Error ? error.message : String(error), 'stderr');
      });
    }, 350);
  });

  const openFile = async (path: string): Promise<void> => {
    activeFilePath = path;
    const readonly = workspace.isReadOnly(path);
    currentFileLabel.textContent = readonly ? `${path} (readonly)` : path;
    const contents = await workspace.readFile(path);
    suppressEditorChange = true;
    projectEditor.getModel()?.setValue(contents);
    monaco.editor.setModelLanguage(projectEditor.getModel()!, inferMonacoLanguage(path));
    projectEditor.updateOptions({ readOnly: readonly });
    suppressEditorChange = false;
    markClean();
    document.querySelectorAll('.dev-file-entry.active').forEach((entry) => entry.classList.remove('active'));
    document.querySelector<HTMLElement>(`[data-dev-file="${CSS.escape(path)}"]`)?.classList.add('active');
  };

  const renderFileTree = async (): Promise<void> => {
    fileTree.replaceChildren();
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > 5 || fileTree.childElementCount > 220) return;
      let entries: string[] = [];
      try {
        entries = await workspace.readDir(dir);
      } catch {
        return;
      }
      const rows = await Promise.all(entries.map(async (entry) => {
        const path = dir === '.' ? entry : `${dir}/${entry}`;
        let isDirectory = false;
        try {
          const stat = await workspace.stat(path);
          isDirectory = stat.isDirectory;
        } catch {
          isDirectory = false;
        }
        return { entry, path, isDirectory };
      }));
      rows.sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
        return left.entry.localeCompare(right.entry);
      });
      for (const { entry, path, isDirectory } of rows) {
        const collapsed = collapsedDirectories.has(path);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `dev-file-entry ${isDirectory ? 'directory' : 'file'} ${path === activeFilePath ? 'active' : ''}`.trim();
        row.dataset.devFile = path;
        row.style.setProperty('--depth', String(depth));
        const readonly = !isDirectory && workspace.isReadOnly(path);
        row.textContent = `${isDirectory ? `${collapsed ? '▸' : '▾'} ` : ''}${entry}${isDirectory ? '/' : readonly ? ' (readonly)' : ''}`;
        row.addEventListener('click', () => {
          if (isDirectory) {
            if (collapsed) {
              collapsedDirectories.delete(path);
            } else {
              collapsedDirectories.add(path);
            }
            void renderFileTree();
            return;
          }
          void openFile(path);
        });
        fileTree.append(row);
        if (isDirectory && !collapsed) {
          await visit(path, depth + 1);
        }
      }
    };
    await visit('.', 0);
    if (fileTree.childElementCount === 0) {
      const empty = document.createElement('div');
      empty.className = 'dev-file-empty';
      empty.textContent = 'No files';
      fileTree.append(empty);
    }
  };

  const mvpCommands: Record<string, { label: string; command: string; setup?: () => Promise<void> }> = {
    js: {
      label: 'JS live FS + stdio',
      command:
        'node -e "const fs=require(\\"fs\\"); fs.writeFileSync(\\"mvp-js.txt\\", \\"js-live\\\\n\\"); console.log(fs.readFileSync(\\"mvp-js.txt\\", \\"utf8\\").trim()); fs.writeFileSync(\\"/dev/stdout\\", \\"js-device\\\\n\\");"',
    },
    python: {
      label: 'Python live FS + stdio',
      command:
        'python3 -c "from pathlib import Path; Path(\\"mvp-python.txt\\").write_text(\\"python-live\\\\n\\"); print(Path(\\"mvp-python.txt\\").read_text().strip()); open(\\"/dev/stdout\\", \\"w\\").write(\\"python-device\\\\n\\")"',
    },
    java: {
      label: 'Java bridged FS + stdio',
      command: 'javac MvpJava.java && java MvpJava',
      setup: async () => {
        await workspace.writeFile(
          'MvpJava.java',
          [
            'import java.nio.file.Files;',
            'import java.nio.file.Path;',
            'class MvpJava {',
            '  public static void main(String[] args) throws Exception {',
            '    Files.writeString(Path.of("mvp-java.txt"), "java-live\\n");',
            '    System.out.print(Files.readString(Path.of("mvp-java.txt")));',
            '    System.out.print("java-stdio\\n");',
            '  }',
            '}',
            '',
          ].join('\n')
        );
      },
    },
    csharp: {
      label: 'C# bridged FS + stdio',
      command: 'dotnet run --project mvp-csharp/MvpCSharp.csproj',
      setup: async () => {
        await workspace.writeFile(
          'mvp-csharp/MvpCSharp.csproj',
          '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n'
        );
        await workspace.writeFile(
          'mvp-csharp/Program.cs',
          [
            'using System;',
            'using System.IO;',
            'File.WriteAllText("mvp-csharp.txt", "csharp-live\\n");',
            'Console.Write(File.ReadAllText("mvp-csharp.txt"));',
            'Console.Write("csharp-stdio\\n");',
            '',
          ].join('\n')
        );
      },
    },
    cpp: {
      label: 'C++ bridged FS + stdio',
      command: 'clang++ -std=c++17 mvp.cpp && ./a.out',
      setup: async () => {
        await workspace.writeFile(
          'mvp.cpp',
          [
            '#include <fstream>',
            '#include <iostream>',
            '#include <string>',
            'int main() {',
            '  std::ofstream("mvp-cpp.txt") << "cpp-live\\n";',
            '  std::ifstream input("mvp-cpp.txt");',
            '  std::string line;',
            '  std::getline(input, line);',
            '  std::cout << line << "\\n";',
            '  std::cout << "cpp-stdio\\n";',
            '  return 0;',
            '}',
            '',
          ].join('\n')
        );
      },
    },
  };

  const runTerminalCommand = async (command: string): Promise<void> => {
    input.value = '';
    input.disabled = true;
    status.textContent = 'tracekernel running';
    const commandController = new AbortController();
    activeCommandController = commandController;
    stopCommandButton.disabled = false;
    appendCommandLine(command);

    try {
      if (command === 'capabilities') {
        for (const row of getRuntimeProjectIoCapabilityMatrix()) {
          appendLine(`${row.language}: browser=${row.browser.tier} node=${row.node.tier}`, 'status');
        }
        return;
      }
      const smokeMatch = command.match(/^mvp(?:\s+(.+))?$/);
      if (smokeMatch) {
        const target = smokeMatch[1]?.trim();
        const keys = target ? [target] : Object.keys(mvpCommands);
        for (const key of keys) {
          const smoke = mvpCommands[key];
          if (!smoke) {
            appendLine(`unknown MVP check: ${key}`, 'stderr');
            continue;
          }
          await smoke.setup?.();
          appendLine(`# ${smoke.label}`, 'status');
          await runTerminalCommand(smoke.command);
        }
        return;
      }

      const streamedOutput = { stdout: '', stderr: '' };
      const result = await terminalSession.run(command, {
        signal: commandController.signal,
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
          if (event.type === 'file-change') {
            void renderFileTree();
          }
        },
      });
      (window as unknown as { __tracecodeLastDevResult?: unknown }).__tracecodeLastDevResult = result;
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
      updatePrompt();
    } catch (error) {
      appendLine(error instanceof Error ? error.message : String(error), 'stderr');
    } finally {
      if (activeCommandController === commandController) {
        activeCommandController = null;
        stopCommandButton.disabled = true;
      }
      await renderFileTree();
      updatePrompt();
      status.textContent = 'tracekernel ready';
      input.disabled = false;
      input.focus();
    }
  };

  const commandForActiveFile = (): string => {
    const path = activeFilePath;
    const absolutePath = `${workspace.cwd}/${path}`;
    if (path.endsWith('.py')) return `python3 ${JSON.stringify(absolutePath)}`;
    if (path.endsWith('.js') || path.endsWith('.mjs')) return `node ${JSON.stringify(absolutePath)}`;
    if (path.endsWith('.java')) {
      const className = path.split('/').pop()!.replace(/\.java$/, '');
      return `javac ${JSON.stringify(absolutePath)} && java ${className}`;
    }
    if (path.endsWith('.csproj')) return `dotnet run --project ${JSON.stringify(absolutePath)}`;
    if (path.endsWith('.cpp')) return `clang++ -std=c++17 ${JSON.stringify(absolutePath)} && ./a.out`;
    return `cat ${JSON.stringify(absolutePath)}`;
  };

  const createNewFile = (): void => {
    const path = window.prompt('New project file path', 'src/new-file.txt')?.trim();
    if (!path) return;
    void workspace.writeFile(path, '').then(async () => {
      await renderFileTree();
      await openFile(path);
    });
  };
  newFileButton.addEventListener('click', createNewFile);
  menuNewFileButton.addEventListener('click', createNewFile);
  newFolderButton.addEventListener('click', () => {
    const path = window.prompt('New project folder path', 'src/new-folder')?.trim();
    if (!path) return;
    void workspace.mkdir(path).then(async () => {
      collapsedDirectories.delete(path);
      await renderFileTree();
    }).catch((error) => {
      appendLine(error instanceof Error ? error.message : String(error), 'stderr');
    });
  });
  saveFileButton.addEventListener('click', () => {
    void saveActiveFile().then(renderFileTree);
  });
  refreshFilesButton.addEventListener('click', () => {
    void renderFileTree();
  });
  menuRefreshFilesButton.addEventListener('click', () => {
    void renderFileTree();
  });
  resetSessionButton.addEventListener('click', () => {
    if (!window.confirm('Restart this project session? This clears the saved /dev workspace and reloads the starter files.')) return;
    resetSessionButton.disabled = true;
    appendLine('Restarting project session...');
    workspace.dispose();
    window.location.reload();
  });
  deleteLocalDataButton.addEventListener('click', () => {
    if (!window.confirm('Destroy the current kernel session and reload the starter files?')) return;
    deleteLocalDataButton.disabled = true;
    appendLine('Destroying project session...');
    void workspace.destroy({ reason: 'user-requested', clearStorage: true })
      .then(() => {
        window.location.reload();
      })
      .catch((error) => {
        deleteLocalDataButton.disabled = false;
        appendLine(error instanceof Error ? error.message : String(error), 'stderr');
      });
  });
  formatFileButton.addEventListener('click', () => {
    void projectEditor.getAction('editor.action.formatDocument')?.run();
  });
  clearTerminalButton.addEventListener('click', () => {
    output.replaceChildren(form);
  });
  focusTerminalButton.addEventListener('click', () => {
    input.focus();
  });
  focusExplorerButton.addEventListener('click', () => {
    fileTree.querySelector<HTMLButtonElement>('.dev-file-entry')?.focus();
  });
  runCurrentButton.addEventListener('click', () => {
    void saveActiveFile().then(() => runTerminalCommand(commandForActiveFile()));
  });
  const runProjectCommand = async (name: string): Promise<void> => {
    const commandLabel = (command: NonNullable<typeof workspace.projectSession>['commands'][string]): string => {
      return 'steps' in command
        ? command.steps.map((step) => step.command).join(' && ')
        : command.command;
    };
    input.value = '';
    input.disabled = true;
    status.textContent = 'tracekernel running';
    const commandController = new AbortController();
    activeCommandController = commandController;
    stopCommandButton.disabled = false;
    const projectCommand = workspace.projectSession?.commands[name];
    appendCommandLine(projectCommand ? commandLabel(projectCommand) : name);
    try {
      const streamedOutput = { stdout: '', stderr: '' };
      const result = await workspace.runProjectCommand(name, {
        signal: commandController.signal,
        onEvent: (event: RuntimeCommandEvent) => {
          if (event.type === 'output') {
            streamedOutput[event.stream] += event.data;
            appendBlock(event.data, event.stream);
          } else if (event.type === 'status') {
            appendLine(`[${event.phase}] ${event.message}`, 'status');
          } else if (event.type === 'file-change') {
            void renderFileTree();
          }
        },
      });
      if (result.stdout.startsWith(streamedOutput.stdout)) appendBlock(result.stdout.slice(streamedOutput.stdout.length), 'stdout');
      if (result.stderr.startsWith(streamedOutput.stderr)) appendBlock(result.stderr.slice(streamedOutput.stderr.length), 'stderr');
      if (result.exitCode !== 0) appendLine(`exit ${result.exitCode}`, 'stderr');
      await renderFileTree();
    } catch (error) {
      appendLine(error instanceof Error ? error.message : String(error), 'stderr');
    } finally {
      if (activeCommandController === commandController) {
        activeCommandController = null;
        stopCommandButton.disabled = true;
      }
      status.textContent = 'tracekernel ready';
      input.disabled = false;
      input.focus();
      updatePrompt();
    }
  };
  stopCommandButton.addEventListener('click', () => {
    activeCommandController?.abort();
  });
  const renderProjectCommandActions = (): void => {
    const commands = visibleProjectCommands();
    const commandNames = Object.keys(commands).sort((left, right) => {
      const rank = (name: string): number => ({ start: 0, test: 1, build: 2, mvp: 3 }[name] ?? 10);
      return rank(left) - rank(right) || left.localeCompare(right);
    });
    sessionCommandList.replaceChildren();
    sessionCommandMenu.replaceChildren();
    for (const name of commandNames) {
      const command = commands[name];
      const sidebarButton = document.createElement('button');
      sidebarButton.type = 'button';
      sidebarButton.className = 'dev-command-button';
      sidebarButton.textContent = name;
      sidebarButton.title = 'steps' in command
        ? command.steps.map((step) => step.command).join('\n')
        : command.command;
      sidebarButton.addEventListener('click', () => {
        void saveActiveFile().then(() => runProjectCommand(name));
      });
      sessionCommandList.append(sidebarButton);

      if (!['start', 'test', 'build'].includes(name)) {
        const menuButton = document.createElement('button');
        menuButton.type = 'button';
        menuButton.textContent = `Run ${name}`;
        menuButton.title = sidebarButton.title;
        menuButton.addEventListener('click', () => {
          void saveActiveFile().then(() => runProjectCommand(name));
        });
        sessionCommandMenu.append(menuButton);
      }
    }
  };
  runProjectStartButton.addEventListener('click', () => {
    void saveActiveFile().then(() => runProjectCommand('start'));
  });
  runProjectTestButton.addEventListener('click', () => {
    void saveActiveFile().then(() => runProjectCommand('test'));
  });
  runProjectBuildButton.addEventListener('click', () => {
    void saveActiveFile().then(() => runProjectCommand('build'));
  });
  runMvpButton.addEventListener('click', () => {
    void runTerminalCommand('mvp');
  });

  const disposeTerminal = (): void => {
    unsubscribeWorkspaceEvents();
    workspace.dispose();
  };

  (
    window as Window & {
      __tracecodeProjectWorkspace?: typeof workspace;
    }
  ).__tracecodeProjectWorkspace = workspace;
  setProjectCommandButtons();
  renderProjectCommandActions();

  window.addEventListener('beforeunload', disposeTerminal);
  if (import.meta.hot) {
    import.meta.hot.dispose(disposeTerminal);
  }

  status.textContent = 'tracekernel ready';
  updatePrompt();
  await renderFileTree();
  await openFile(activeFilePath);
  appendLine('Try: python3 main.py, node index.js, javac Main.java && java Main, or mvp js');
  input.disabled = false;
  input.focus();

  const commandHistory: string[] = [];
  let historyIndex = 0;
  const submitTerminalCommand = (): void => {
    const command = input.value.trim();
    if (!command) return;
    if (commandHistory[commandHistory.length - 1] !== command) {
      commandHistory.push(command);
    }
    historyIndex = commandHistory.length;
    void runTerminalCommand(command);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitTerminalCommand();
      return;
    }
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

bootDevTerminal().catch((error) => {
  document.body.innerHTML = '<pre class="dev-terminal-error"></pre>';
  document.querySelector<HTMLPreElement>('.dev-terminal-error')!.textContent =
    error instanceof Error ? error.stack ?? error.message : String(error);
});

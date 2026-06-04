#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function loadSourceAugmentations(): {
  augmentJavaCollectionOperations: (source: string, sourceText?: string) => string;
} {
  const source = readFileSync(join(process.cwd(), 'workers', 'java', 'java-source-augmentations.js'), 'utf8');
  const moduleObject = { exports: {} };
  const context = vm.createContext({
    module: moduleObject,
    exports: moduleObject.exports,
    self: {},
  });
  vm.runInContext(source, context, { filename: 'java-source-augmentations.js' });
  return moduleObject.exports as {
    augmentJavaCollectionOperations: (source: string, sourceText?: string) => string;
  };
}

function assertJavaDeleteOnCloseLiveDeleteContract(): void {
  const projectEventsPath = join(
    process.cwd(),
    'workers',
    'java',
    'src',
    'tracecode',
    'browser',
    'ProjectEvents.java'
  );
  const projectEventsSource = readFileSync(projectEventsPath, 'utf8');

  assertCondition(
    projectEventsSource.includes('optionDeletesOnClose') &&
      projectEventsSource.includes('StandardOpenOption.DELETE_ON_CLOSE') &&
      projectEventsSource.includes('emitPostWritePathChange(path, optionDeletesOnClose(options))') &&
      projectEventsSource.includes('emitFileDelete(path)'),
    'ProjectEvents should route DELETE_ON_CLOSE writes through live delete emission'
  );
  assertCondition(
    /byteChannelCanWrite[\s\S]*StandardOpenOption\.DELETE_ON_CLOSE/.test(projectEventsSource),
    'ProjectEvents should treat DELETE_ON_CLOSE byte-channel opens as mutating operations'
  );
  assertCondition(
    /ProjectOutputStream[\s\S]*deleteOnClose[\s\S]*emitPostWritePathChange\(path, deleteOnClose\)/.test(projectEventsSource) &&
      /ProjectBufferedWriter[\s\S]*deleteOnClose[\s\S]*emitPostWritePathChange\(path, deleteOnClose\)/.test(projectEventsSource) &&
      /ProjectSeekableByteChannel[\s\S]*deleteOnClose[\s\S]*emitPostWritePathChange\(path, deleteOnClose\)/.test(projectEventsSource),
    'ProjectEvents stream, writer, and byte-channel wrappers should emit delete-on-close state on close'
  );

  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-delete-on-close-'));
  try {
    const classesPath = join(tmpRoot, 'classes');
    const smokePath = join(tmpRoot, 'ProjectEventsDeleteOnCloseSmoke.java');
    mkdirSync(classesPath);
    writeFileSync(
      smokePath,
      `import java.io.BufferedWriter;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import tracecode.browser.ProjectEvents;

public class ProjectEventsDeleteOnCloseSmoke {
  public static void main(String[] args) throws Exception {
    Path root = Files.createTempDirectory("tracecode-java-doc-smoke-");
    try {
      Path streamPath = root.resolve("stream.txt");
      try (OutputStream stream = ProjectEvents.newOutputStream(
          streamPath,
          StandardOpenOption.CREATE,
          StandardOpenOption.WRITE,
          StandardOpenOption.DELETE_ON_CLOSE
      )) {
        stream.write("stream".getBytes(StandardCharsets.UTF_8));
      }
      requireDeleted(streamPath, "stream");

      Path writerPath = root.resolve("writer.txt");
      try (BufferedWriter writer = ProjectEvents.newBufferedWriter(
          writerPath,
          StandardCharsets.UTF_8,
          StandardOpenOption.CREATE,
          StandardOpenOption.WRITE,
          StandardOpenOption.DELETE_ON_CLOSE
      )) {
        writer.write("writer");
      }
      requireDeleted(writerPath, "writer");

      Path channelPath = root.resolve("channel.txt");
      try (SeekableByteChannel channel = ProjectEvents.newByteChannel(
          channelPath,
          StandardOpenOption.CREATE,
          StandardOpenOption.WRITE,
          StandardOpenOption.DELETE_ON_CLOSE
      )) {
        channel.write(ByteBuffer.wrap("channel".getBytes(StandardCharsets.UTF_8)));
      }
      requireDeleted(channelPath, "channel");

      Path writeStringPath = root.resolve("write-string.txt");
      ProjectEvents.writeString(
        writeStringPath,
        "write-string",
        StandardOpenOption.CREATE,
        StandardOpenOption.WRITE,
        StandardOpenOption.DELETE_ON_CLOSE
      );
      requireDeleted(writeStringPath, "writeString");

      System.out.println("delete-on-close-ok");
    } finally {
      try (var paths = Files.walk(root)) {
        paths.sorted(java.util.Comparator.reverseOrder()).forEach((path) -> {
          try {
            Files.deleteIfExists(path);
          } catch (Exception ignored) {
          }
        });
      }
    }
  }

  private static void requireDeleted(Path path, String label) {
    if (Files.exists(path)) {
      throw new IllegalStateException(label + " path remained observable: " + path);
    }
  }
}
`,
      'utf8'
    );

    execFileSync('javac', ['-d', classesPath, projectEventsPath, smokePath], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    const output = execFileSync('java', ['-cp', classesPath, 'ProjectEventsDeleteOnCloseSmoke'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    assertCondition(output === 'delete-on-close-ok', `ProjectEvents DELETE_ON_CLOSE smoke failed: ${output}`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('PASS: Java ProjectEvents DELETE_ON_CLOSE closes with delete semantics');
}

function assertJavaLexicalScannersAreCached(): void {
  const augmentationSource = readFileSync(join(process.cwd(), 'workers', 'java', 'java-source-augmentations.js'), 'utf8');
  const workerSource = readFileSync(join(process.cwd(), 'workers', 'java', 'java-worker.js'), 'utf8');
  const adapterSource = readFileSync(
    join(process.cwd(), 'packages', 'harness-core', 'src', 'trace-adapters', 'java.ts'),
    'utf8'
  );

  assertCondition(
    augmentationSource.includes('javaLexicalStateCache') &&
      augmentationSource.includes('buildJavaLineLexicalState') &&
      !/function isInsideJavaStringLiteral[\s\S]*?for \(let index = 0; index < offset; index \+= 1\)/.test(augmentationSource) &&
      !/function isInsideJavaComment[\s\S]*?for \(let index = 0; index < offset; index \+= 1\)/.test(augmentationSource),
    'Java source augmentations should use cached lexical state instead of prefix rescans'
  );
  assertCondition(
    workerSource.includes('javaWorkerLexicalStateCache') &&
      workerSource.includes('buildJavaWorkerLineLexicalState') &&
      !/function isInsideJavaStringLiteral[\s\S]*?for \(let index = 0; index < offset; index \+= 1\)/.test(workerSource),
    'Java worker fallback augmentation should use cached lexical state instead of prefix rescans'
  );
  assertCondition(
    adapterSource.includes('pieces.push(line.slice(segmentStart, index))') &&
      !adapterSource.includes('result += current'),
    'Java trace adapter comment stripping should avoid per-character string concatenation'
  );

  const augmentations = loadSourceAugmentations();
  const source = `class Solution {
  void solve() {
    java.util.List<Integer> nums = new java.util.ArrayList<>();
    String text = "nums.add(99)";
    nums.add(1);
  }
}`;
  const augmented = augmentations.augmentJavaCollectionOperations(source, source);
  assertCondition(augmented.includes('"nums.add(99)"'), 'Java augmentation should preserve receiver calls inside strings');
  assertCondition(
    augmented.includes('TraceHooks.addCollectionAtLine') &&
      !augmented.includes('nums.add(1);'),
    'Java augmentation should still rewrite executable receiver calls'
  );

  console.log('PASS: Java lexical scanners avoid quadratic prefix rescans');
}

function main(): void {
  assertJavaDeleteOnCloseLiveDeleteContract();
  assertJavaLexicalScannersAreCached();
}

main();

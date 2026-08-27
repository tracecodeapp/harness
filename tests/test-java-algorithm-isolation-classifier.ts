#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

type Classifier = (
  owner: string,
  name: string,
  descriptor: string
) => string | undefined;

function loadClassifier(): Classifier {
  const source = readFileSync(
    resolve('workers/java/java-runtime-worker.js'),
    'utf8'
  );
  const start = source.indexOf(
    'const JAVA_ALGORITHM_FORBIDDEN_OWNER_PREFIXES'
  );
  const end = source.indexOf('function parseTraceJVMClassFile');
  assert.ok(start >= 0 && end > start, 'Java classifier source must be present');
  const context = vm.createContext({});
  vm.runInContext(
    `${source.slice(start, end)}\n` +
      'globalThis.__classify = javaAlgorithmForbiddenReference;',
    context,
    { filename: 'java-runtime-worker-classifier.js' }
  );
  return context.__classify as Classifier;
}

test('Java algorithm admission fails closed on ambient sibling APIs', () => {
  const classify = loadClassifier();
  const denied = [
    [
      'java/lang/Compiler',
      'disable',
      '()V',
      'ambient-owner:java/lang/Compiler',
    ],
    [
      'java/lang/foreign/Arena',
      'ofAuto',
      '()Ljava/lang/foreign/Arena;',
      'ambient-owner:java/lang/foreign/Arena',
    ],
    [
      'java/lang/foreign/Linker',
      'nativeLinker',
      '()Ljava/lang/foreign/Linker;',
      'ambient-owner:java/lang/foreign/Linker',
    ],
    [
      'java/lang/module/ModuleFinder',
      'ofSystem',
      '()Ljava/lang/module/ModuleFinder;',
      'ambient-owner:java/lang/module/ModuleFinder',
    ],
    [
      'java/lang/ScopedValue',
      'get',
      '()Ljava/lang/Object;',
      'ambient-owner:java/lang/ScopedValue',
    ],
    [
      'java/lang/AutoCloseable',
      'close',
      '()V',
      'ambient-method:java/lang/AutoCloseable.close()V',
    ],
    [
      'java/util/GregorianCalendar',
      '<init>',
      '(Ljava/util/TimeZone;)V',
      'nondeterministic-time:java/util/GregorianCalendar.<init>(Ljava/util/TimeZone;)V',
    ],
    [
      'java/util/GregorianCalendar',
      '<init>',
      '(Ljava/util/Locale;)V',
      'nondeterministic-time:java/util/GregorianCalendar.<init>(Ljava/util/Locale;)V',
    ],
    [
      'java/util/GregorianCalendar',
      '<init>',
      '(Ljava/util/TimeZone;Ljava/util/Locale;)V',
      'nondeterministic-time:java/util/GregorianCalendar.<init>(Ljava/util/TimeZone;Ljava/util/Locale;)V',
    ],
    [
      'java/util/Formatter',
      '<init>',
      '(Ljava/lang/String;)V',
      'ambient-file-constructor:java/util/Formatter.<init>(Ljava/lang/String;)V',
    ],
    [
      'java/util/Formatter',
      'close',
      '()V',
      'ambient-method:java/util/Formatter.close()V',
    ],
    [
      'java/util/Scanner',
      'close',
      '()V',
      'ambient-method:java/util/Scanner.close()V',
    ],
    [
      'java/util/stream/BaseStream',
      'close',
      '()V',
      'ambient-method:java/util/stream/BaseStream.close()V',
    ],
    [
      'java/util/stream/Stream',
      'close',
      '()V',
      'ambient-method:java/util/stream/Stream.close()V',
    ],
    [
      'java/time/Clock',
      'tick',
      '(Ljava/time/Clock;Ljava/time/Duration;)Ljava/time/Clock;',
      'nondeterministic-time:java/time/Clock.tick(Ljava/time/Clock;Ljava/time/Duration;)Ljava/time/Clock;',
    ],
    [
      'java/time/Clock',
      'tickMillis',
      '(Ljava/time/ZoneId;)Ljava/time/Clock;',
      'nondeterministic-time:java/time/Clock.tickMillis(Ljava/time/ZoneId;)Ljava/time/Clock;',
    ],
    [
      'java/time/Clock',
      'tickMinutes',
      '(Ljava/time/ZoneId;)Ljava/time/Clock;',
      'nondeterministic-time:java/time/Clock.tickMinutes(Ljava/time/ZoneId;)Ljava/time/Clock;',
    ],
    [
      'java/time/Clock',
      'tickSeconds',
      '(Ljava/time/ZoneId;)Ljava/time/Clock;',
      'nondeterministic-time:java/time/Clock.tickSeconds(Ljava/time/ZoneId;)Ljava/time/Clock;',
    ],
    [
      'java/time/InstantSource',
      'system',
      '()Ljava/time/InstantSource;',
      'nondeterministic-time:java/time/InstantSource.system()Ljava/time/InstantSource;',
    ],
    [
      'java/time/InstantSource',
      'tick',
      '(Ljava/time/InstantSource;Ljava/time/Duration;)Ljava/time/InstantSource;',
      'nondeterministic-time:java/time/InstantSource.tick(Ljava/time/InstantSource;Ljava/time/Duration;)Ljava/time/InstantSource;',
    ],
    [
      'java/time/chrono/Chronology',
      'dateNow',
      '()Ljava/time/chrono/ChronoLocalDate;',
      'nondeterministic-time:java/time/chrono/Chronology.dateNow()Ljava/time/chrono/ChronoLocalDate;',
    ],
    [
      'java/time/chrono/IsoChronology',
      'dateNow',
      '()Ljava/time/LocalDate;',
      'nondeterministic-time:java/time/chrono/IsoChronology.dateNow()Ljava/time/LocalDate;',
    ],
    [
      'java/lang/Boolean',
      'getBoolean',
      '(Ljava/lang/String;)Z',
      'ambient-method:java/lang/Boolean.getBoolean(Ljava/lang/String;)Z',
    ],
    [
      'java/lang/Integer',
      'getInteger',
      '(Ljava/lang/String;I)Ljava/lang/Integer;',
      'ambient-method:java/lang/Integer.getInteger(Ljava/lang/String;I)Ljava/lang/Integer;',
    ],
    [
      'java/lang/Long',
      'getLong',
      '(Ljava/lang/String;J)Ljava/lang/Long;',
      'ambient-method:java/lang/Long.getLong(Ljava/lang/String;J)Ljava/lang/Long;',
    ],
    [
      'java/lang/String',
      'intern',
      '()Ljava/lang/String;',
      'ambient-method:java/lang/String.intern()Ljava/lang/String;',
    ],
    [
      'java/util/Calendar$Builder',
      'build',
      '()Ljava/util/Calendar;',
      'ambient-owner:java/util/Calendar$Builder',
    ],
    [
      'java/lang/StackWalker',
      'getInstance',
      '()Ljava/lang/StackWalker;',
      'ambient-owner:java/lang/StackWalker',
    ],
    [
      'java/lang/System$LoggerFinder',
      'getLoggerFinder',
      '()Ljava/lang/System$LoggerFinder;',
      'ambient-owner:java/lang/System$LoggerFinder',
    ],
    [
      'harness/user/jobabc/ParallelList',
      'parallelStream',
      '()Ljava/util/stream/Stream;',
      'parallel-execution:harness/user/jobabc/ParallelList.parallelStream()Ljava/util/stream/Stream;',
    ],
    [
      'harness/user/jobabc/ParallelStream',
      'parallel',
      '()Ljava/util/stream/Stream;',
      'parallel-execution:harness/user/jobabc/ParallelStream.parallel()Ljava/util/stream/Stream;',
    ],
    [
      'java/util/zip/ZipFile',
      '<init>',
      '(Ljava/lang/String;)V',
      'ambient-owner:java/util/zip/ZipFile',
    ],
    [
      'java/io/PrintStream',
      '<init>',
      '(Ljava/lang/String;)V',
      'ambient-owner:java/io/PrintStream',
    ],
    [
      'java/io/PrintStream',
      'close',
      '()V',
      'ambient-owner:java/io/PrintStream',
    ],
    [
      'java/util/Scanner',
      '<init>',
      '(Ljava/io/InputStream;)V',
      'ambient-descriptor:java/io/InputStream',
    ],
    [
      '[Ljava/io/File;',
      'clone',
      '()Ljava/lang/Object;',
      'ambient-owner:[Ljava/io/File;',
    ],
  ] as const;
  for (const [owner, name, descriptor, expectedReason] of denied) {
    assert.equal(
      classify(owner, name, descriptor),
      expectedReason,
      `${owner}.${name}${descriptor} must select compatibility`
    );
  }
});

test('Java algorithm admission preserves scoped output and deterministic values', () => {
  const classify = loadClassifier();
  const admitted = [
    ['[I', 'clone', '()Ljava/lang/Object;'],
    ['[[I', 'clone', '()Ljava/lang/Object;'],
    ['[Ljava/lang/String;', 'clone', '()Ljava/lang/Object;'],
    ['[[Ljava/util/List;', 'clone', '()Ljava/lang/Object;'],
    ['java/io/PrintStream', 'println', '(Ljava/lang/String;)V'],
    [
      'java/io/PrintStream',
      'printf',
      '(Ljava/lang/String;[Ljava/lang/Object;)Ljava/io/PrintStream;',
    ],
    ['java/util/GregorianCalendar', '<init>', '(III)V'],
    ['java/util/Formatter', '<init>', '()V'],
    ['java/util/Formatter', '<init>', '(Ljava/io/PrintStream;)V'],
    ['java/util/Formatter', '<init>', '(Ljava/lang/Appendable;)V'],
    [
      'java/time/Clock',
      'fixed',
      '(Ljava/time/Instant;Ljava/time/ZoneId;)Ljava/time/Clock;',
    ],
    [
      'java/time/Clock',
      'offset',
      '(Ljava/time/Clock;Ljava/time/Duration;)Ljava/time/Clock;',
    ],
    [
      'java/time/InstantSource',
      'fixed',
      '(Ljava/time/Instant;)Ljava/time/InstantSource;',
    ],
    [
      'java/time/InstantSource',
      'offset',
      '(Ljava/time/InstantSource;Ljava/time/Duration;)Ljava/time/InstantSource;',
    ],
    ['java/lang/RuntimeException', '<init>', '(Ljava/lang/String;)V'],
    [
      'java/lang/invoke/StringConcatFactory',
      'makeConcatWithConstants',
      '(Ljava/lang/invoke/MethodHandles$Lookup;)Ljava/lang/invoke/CallSite;',
    ],
  ] as const;
  for (const [owner, name, descriptor] of admitted) {
    assert.equal(
      classify(owner, name, descriptor),
      undefined,
      `${owner}.${name}${descriptor} must remain algorithm-fast eligible`
    );
  }
});

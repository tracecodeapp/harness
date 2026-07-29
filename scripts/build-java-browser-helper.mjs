#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.cwd();
const sourceRoot = resolve(root, 'workers/java/src');
const outputPath = resolve(root, 'workers/vendor/java-browser-helper.jar');
const rewriterOutputPath = resolve(root, 'workers/vendor/java-rewriter.jar');
const checkOnly = process.argv.slice(2).includes('--check');

async function run(command, args, cwd = root) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}

async function javaSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const pathname = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javaSources(pathname));
    else if (entry.isFile() && entry.name.endsWith('.java')) files.push(pathname);
  }
  return files.sort((left, right) => relative(sourceRoot, left).localeCompare(relative(sourceRoot, right)));
}

const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-java-helper-'));
try {
  const classesPath = join(tempRoot, 'classes');
  const metadataPath = join(tempRoot, 'metadata');
  const candidatePath = join(tempRoot, 'java-browser-helper.jar');
  const rewriterCandidatePath = join(tempRoot, 'java-rewriter.jar');
  await mkdir(classesPath, { recursive: true });
  const sources = await javaSources(sourceRoot);
  if (sources.length === 0) throw new Error(`No Java helper sources found under ${sourceRoot}.`);
  const sourceHash = createHash('sha256');
  for (const source of sources) {
    sourceHash.update(relative(sourceRoot, source));
    sourceHash.update('\0');
    sourceHash.update(await readFile(source));
    sourceHash.update('\0');
  }
  const sourceDigest = sourceHash.digest('hex');
  const digestEntry = join(metadataPath, 'META-INF', 'tracecode-source.sha256');
  await mkdir(dirname(digestEntry), { recursive: true });
  await writeFile(digestEntry, `${sourceDigest}\n`, 'utf8');
  await run('javac', ['--release', '17', '-d', classesPath, ...sources]);
  await run('jar', [
    '--create',
    '--no-manifest',
    '--date=2000-01-01T00:00:00Z',
    '--file',
    candidatePath,
    '-C',
    classesPath,
    '.',
    '-C',
    metadataPath,
    'META-INF/tracecode-source.sha256',
  ]);
  const rewriterClasses = (await readdir(join(classesPath, 'harness', 'browser')))
    .filter((name) => /^JavaRewriteLibrary(?:\$.*)?\.class$/u.test(name))
    .sort();
  if (rewriterClasses.length === 0) {
    throw new Error('Compiled Java rewrite library classes were not found.');
  }
  await run('jar', [
    '--create',
    '--no-manifest',
    '--date=2000-01-01T00:00:00Z',
    '--file',
    rewriterCandidatePath,
    ...rewriterClasses.flatMap((name) => [
      '-C',
      classesPath,
      join('harness', 'browser', name),
    ]),
    '-C',
    metadataPath,
    'META-INF/tracecode-source.sha256',
  ]);

  if (checkOnly) {
    for (const [label, path] of [
      ['workers/vendor/java-browser-helper.jar', outputPath],
      ['workers/vendor/java-rewriter.jar', rewriterOutputPath],
    ]) {
      const extractedPath = join(tempRoot, `existing-${label.split('/').at(-1)}`);
      await mkdir(extractedPath, { recursive: true });
      await run('jar', [
        '--extract',
        '--file',
        path,
        'META-INF/tracecode-source.sha256',
      ], extractedPath);
      const recordedDigest = (await readFile(
        join(extractedPath, 'META-INF', 'tracecode-source.sha256'),
        'utf8'
      )).trim();
      if (recordedDigest !== sourceDigest) {
        throw new Error(`${label} is stale; run pnpm generate:java-helper.`);
      }
    }
    console.log('Java browser helper and rewriter jars are current.');
  } else {
    await mkdir(dirname(outputPath), { recursive: true });
    await copyFile(candidatePath, outputPath);
    await copyFile(rewriterCandidatePath, rewriterOutputPath);
    console.log(`Built ${outputPath} and ${rewriterOutputPath}`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

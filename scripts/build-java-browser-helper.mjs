#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.cwd();
const sourceRoot = resolve(root, 'workers/java/src');
const outputPath = resolve(root, 'workers/vendor/java-browser-helper.jar');
const checkOnly = process.argv.slice(2).includes('--check');

async function run(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
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
  const candidatePath = join(tempRoot, 'java-browser-helper.jar');
  await mkdir(classesPath, { recursive: true });
  const sources = await javaSources(sourceRoot);
  if (sources.length === 0) throw new Error(`No Java helper sources found under ${sourceRoot}.`);
  await run('javac', ['--release', '17', '-d', classesPath, ...sources]);
  await run('jar', [
    '--create',
    '--date=2000-01-01T00:00:00Z',
    '--file',
    candidatePath,
    '-C',
    classesPath,
    '.',
  ]);

  if (checkOnly) {
    const [expected, candidate] = await Promise.all([readFile(outputPath), readFile(candidatePath)]);
    if (!expected.equals(candidate)) {
      throw new Error('workers/vendor/java-browser-helper.jar is stale; run pnpm generate:java-helper.');
    }
    console.log('Java browser helper jar is current.');
  } else {
    await mkdir(dirname(outputPath), { recursive: true });
    await copyFile(candidatePath, outputPath);
    console.log(`Built ${outputPath}`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const RELEASE_REMOTE = 'origin';
const VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

function fail(message) {
  throw new Error(`Release tag check failed: ${message}`);
}

async function runGit(root, args) {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    return result.stdout.trim();
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr).trim()
        : error instanceof Error
          ? error.message
          : String(error);
    fail(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

async function readReleaseVersion(root) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  } catch (error) {
    fail(`unable to read package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    fail(`package.json has an invalid release version: ${JSON.stringify(manifest.version)}`);
  }
  return manifest.version;
}

function remoteCommitForTag(output, tagRef) {
  const entries = new Map();
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{40,64})\s+(.+)$/u);
    if (!match) fail(`unexpected git ls-remote output: ${JSON.stringify(line)}`);
    entries.set(match[2], match[1]);
  }
  return entries.get(`${tagRef}^{}`) ?? entries.get(tagRef);
}

export async function auditReleaseTag(rootDirectory = process.cwd()) {
  const root = resolve(rootDirectory);
  const version = await readReleaseVersion(root);
  const tag = `v${version}`;
  const tagRef = `refs/tags/${tag}`;
  const head = await runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const status = await runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) fail(`release checkout must be clean before publication:\n${status}`);

  const localTagCommit = await runGit(root, [
    'rev-parse',
    '--verify',
    `${tagRef}^{commit}`,
  ]);
  if (localTagCommit !== head) {
    fail(`${tag} resolves to ${localTagCommit}, expected release HEAD ${head}`);
  }

  const remoteOutput = await runGit(root, [
    'ls-remote',
    '--tags',
    RELEASE_REMOTE,
    tagRef,
    `${tagRef}^{}`,
  ]);
  const remoteTagCommit = remoteCommitForTag(remoteOutput, tagRef);
  if (!remoteTagCommit) fail(`${tag} is not present on remote ${RELEASE_REMOTE}`);
  if (remoteTagCommit !== head) {
    fail(`remote ${RELEASE_REMOTE} ${tag} resolves to ${remoteTagCommit}, expected ${head}`);
  }

  return { head, remote: RELEASE_REMOTE, tag, version };
}

function parseRootArgument(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 2 && argv[0] === '--root') return argv[1];
  fail('usage: node scripts/check-release-tag.mjs [--root <workspace>]');
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href
  : '';
if (invokedPath === import.meta.url) {
  try {
    const result = await auditReleaseTag(parseRootArgument(process.argv.slice(2)));
    console.log(
      `PASS: ${result.tag} exists locally and on ${result.remote} at exact release commit ${result.head}.`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

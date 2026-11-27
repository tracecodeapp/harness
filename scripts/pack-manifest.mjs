export function resolvePackDevDependencies(devDependencies, version) {
  const other = [];
  const workspace = [];

  for (const name of Object.keys(devDependencies).sort()) {
    const specifier = devDependencies[name];
    if (specifier.startsWith('workspace:^')) {
      // An explicit version lets pnpm strip the prefix without racing reads
      // of the linked manifests. Keep these entries at the end, as pnpm did.
      workspace.push([name, `workspace:^${version}`]);
    } else {
      other.push([name, specifier]);
    }
  }

  return Object.fromEntries([...other, ...workspace]);
}

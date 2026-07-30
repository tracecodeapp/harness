/**
 * Shared environment/URL helpers for browser worker clients.
 */

/**
 * Default for the clients' `debug` option. Guarded because `process` is a
 * Node global; browser consumers only see it when their bundler defines it.
 */
export function isDevEnvironment(): boolean {
  try {
    return typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
  } catch {
    return false;
  }
}

/** Append (or replace) a query parameter on a worker URL, preserving any hash. */
export function appendWorkerUrlQueryParameter(workerUrl: string, name: string, value: string): string {
  const hashIndex = workerUrl.indexOf('#');
  const beforeHash = hashIndex >= 0 ? workerUrl.slice(0, hashIndex) : workerUrl;
  const hash = hashIndex >= 0 ? workerUrl.slice(hashIndex) : '';
  const encodedName = encodeURIComponent(name);
  const encodedValue = encodeURIComponent(value);
  const existing = new RegExp(`([?&])${encodedName}=[^&#]*`);
  if (existing.test(beforeHash)) {
    return `${beforeHash.replace(existing, `$1${encodedName}=${encodedValue}`)}${hash}`;
  }
  return `${beforeHash}${beforeHash.includes('?') ? '&' : '?'}${encodedName}=${encodedValue}${hash}`;
}

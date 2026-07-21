import packageJson from '../../../package.json' with { type: 'json' };

/**
 * The version of the published @tracecode/harness release.
 *
 * Leaf workspace package versions are implementation details and can lag while
 * a release is assembled. User-visible TraceKernel identity must use this
 * single release version instead.
 */
export const TRACECODE_HARNESS_VERSION = packageJson.version;

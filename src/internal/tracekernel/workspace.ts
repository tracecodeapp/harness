/**
 * Root-package declaration bridge for TraceKernel's private workspace module.
 *
 * The workspace package remains an internal build boundary in 0.14. This
 * relative source export gives the single published @tracecode/harness tarball
 * a resolvable type target without publishing @tracecode/tracekernel itself.
 */
export * from '../../../packages/tracekernel/src/workspace/index';

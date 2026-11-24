export interface CppStage1Artifact {
  readonly ordinaryModule: Uint8Array;
  readonly sites: unknown;
}

interface Site {
  readonly id: string;
  readonly kind: string;
  readonly detail: string;
  readonly file: number;
  readonly fn: number;
  readonly pc: number;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  readonly translationUnitOffset: number;
  readonly labelOrdinal: number;
  readonly scalar?: string;
  readonly frameOffset?: number;
}

interface SiteMap {
  readonly schema: 'tracecc.stage1.sites.v1';
  readonly pch: 'narrow' | 'broad' | 'map';
  readonly sourceSha256: string;
  readonly moduleSha256: string;
  readonly codeSha256: string;
  readonly files: readonly string[];
  readonly functions: readonly {
    readonly name: string;
    readonly lo: number;
    readonly hi: number;
    readonly frameBaseLocal: number | null;
  }[];
  readonly sites: readonly Site[];
}

export interface VerifiedCppStage1Artifact {
  readonly ordinaryModule: Uint8Array<ArrayBuffer>;
  readonly sites: SiteMap;
}

/**
 * Trusted independent extractor for the mapped counterpart. It must check
 * ordered standard-section identity, linked DWARF labels, function ownership,
 * actual instruction boundaries, and physical translation-unit coordinates.
 */
export type CppStage1CoordinateVerifier = (input: VerifiedCppStage1Artifact & {
  readonly source: string;
  readonly signal?: AbortSignal;
}) => Promise<boolean>;

function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** CODE payload, including the function count, with Wasm section bounds. */
function wasmCode(module: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | undefined {
  const preamble = [0, 97, 115, 109, 1, 0, 0, 0];
  if (!preamble.every((byte, index) => module[index] === byte) || !WebAssembly.validate(module)) return;
  let offset = preamble.length;
  while (offset < module.length) {
    const id = module[offset++];
    let length = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = module[offset++];
      if (byte === undefined || shift > 28 || (shift === 28 && byte > 15)) return;
      length += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) break;
    }
    if (offset + length > module.length) return;
    if (id === 10) return module.subarray(offset, offset + length);
    offset += length;
  }
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const edgeKinds = new Set(['edge.begin', 'edge.rhs', 'edge.join', 'edge.fold.skip', 'edge.fold.rhs']);
const shaPattern = /^[0-9a-f]{64}$/u;

function validSiteMap(value: unknown, source: Uint8Array, codeLength: number): value is SiteMap {
  if (!value || typeof value !== 'object') return false;
  const map = value as SiteMap;
  if (map.schema !== 'tracecc.stage1.sites.v1' || !['narrow', 'broad', 'map'].includes(map.pch) ||
    ![map.sourceSha256, map.moduleSha256, map.codeSha256].every((hash) => typeof hash === 'string' && shaPattern.test(hash)) ||
    !Array.isArray(map.files) || !map.files.every((file) => typeof file === 'string' && file.length > 0) ||
    !Array.isArray(map.functions) || !Array.isArray(map.sites) || map.sites.length === 0) return false;

  if (!map.functions.every((fn) => fn && typeof fn.name === 'string' && fn.name.length > 0 &&
    natural(fn.lo) && natural(fn.hi) && fn.lo < fn.hi && fn.hi <= codeLength &&
    (fn.frameBaseLocal === null || natural(fn.frameBaseLocal)))) return false;

  const lineStarts = [0];
  source.forEach((byte, index) => { if (byte === 10) lineStarts.push(index + 1); });
  const encoder = new TextEncoder();
  const ordinals = new Set<number>();
  return map.sites.every((site: Site) => {
    if (!site || typeof site.id !== 'string' || !site.id ||
      !natural(site.file) || site.file >= map.files.length || !natural(site.fn) ||
      !natural(site.pc) || !natural(site.line) || !natural(site.column) ||
      !natural(site.offset) || !natural(site.translationUnitOffset) ||
      !natural(site.labelOrdinal) || ordinals.has(site.labelOrdinal) ||
      typeof site.detail !== 'string' || !site.detail) return false;
    const fn = map.functions[site.fn];
    const start = lineStarts[site.line - 1];
    const end = lineStarts[site.line] ?? source.length;
    if (!fn || site.pc < fn.lo || site.pc >= fn.hi ||
      start === undefined || site.column === 0 || site.offset !== start + site.column - 1) return false;
    const token = encoder.encode(site.detail);
    if (site.offset + token.length > end || !token.every((byte, index) => source[site.offset + index] === byte)) return false;
    ordinals.add(site.labelOrdinal);
    if (edgeKinds.has(site.kind)) return site.detail === '&&' || site.detail === '||';
    return (site.kind === 'local.begin' || site.kind === 'local.init') &&
      site.scalar === 'i32' && fn.frameBaseLocal !== null &&
      typeof site.frameOffset === 'number' && Number.isInteger(site.frameOffset) &&
      site.frameOffset >= -0x80000000 && site.frameOffset <= 0x7fffffff;
  });
}

export async function verifyCppStage1Artifact(
  artifact: CppStage1Artifact,
  source: string,
  verifyCoordinates: CppStage1CoordinateVerifier,
  signal?: AbortSignal
): Promise<VerifiedCppStage1Artifact | undefined> {
  const ordinaryModule = new Uint8Array(artifact.ordinaryModule);
  const code = wasmCode(ordinaryModule);
  const sourceBytes = new TextEncoder().encode(source);
  const sites = structuredClone(artifact.sites);
  if (!code || !validSiteMap(sites, sourceBytes, code.length)) return;
  const [moduleHash, codeHash, sourceHash] = await Promise.all([
    sha256(ordinaryModule), sha256(code), sha256(sourceBytes),
  ]);
  if (moduleHash !== sites.moduleSha256 || codeHash !== sites.codeSha256 ||
    sourceHash !== sites.sourceSha256) return;
  signal?.throwIfAborted();
  if (!await verifyCoordinates({
    ordinaryModule: ordinaryModule.slice(),
    sites: structuredClone(sites),
    source,
    signal,
  })) return;
  signal?.throwIfAborted();
  return { ordinaryModule, sites };
}

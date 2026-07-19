export interface CurlProtocolDefinition {
  defaultPort: number;
  authority: boolean;
}

export type CurlProtocolRegistry = Record<string, CurlProtocolDefinition>;

export interface CurlResolvedUrl {
  scheme: string;
  url: string;
}

export const CURL_PROTOCOLS = {
  http: { defaultPort: 80, authority: true },
  https: { defaultPort: 443, authority: true },
} as const satisfies CurlProtocolRegistry;

export const DEFAULT_CURL_SCHEME = 'http';

export function resolveCurlUrl(
  arg: string,
  reg: CurlProtocolRegistry = CURL_PROTOCOLS,
  fallback: string = DEFAULT_CURL_SCHEME
): CurlResolvedUrl {
  const m = /^([a-z][a-z0-9+.\-]*):(\/\/)?/i.exec(arg);
  if (m) {
    const scheme = m[1]!.toLowerCase();
    if (m[2]) return { scheme, url: arg };
    // curl treats `name:port` as an authority when there is no `//`.
    // In particular, `http:80` means host `http` on port 80, not host `80`.
  }
  return { scheme: fallback, url: `${fallback}://${arg}` };
}

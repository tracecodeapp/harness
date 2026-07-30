

export function createUrlApi() {
  return {
    URL,
    URLSearchParams,
    domainToASCII: (domain: string) => {
      try {
        return new URL(`http://${domain}`).hostname;
      } catch {
        return '';
      }
    },
    domainToUnicode: (domain: string) => {
      try {
        return new URL(`http://${domain}`).hostname;
      } catch {
        return '';
      }
    },
    fileURLToPath: (value: string | URL) => {
      const url = value instanceof URL ? value : new URL(value);
      if (url.protocol !== 'file:') {
        throw new TypeError('The URL must be of scheme file');
      }
      return decodeURIComponent(url.pathname);
    },
    pathToFileURL: (path: string) => new URL(`file://${path.startsWith('/') ? path : `/${path}`}`),
  };
}

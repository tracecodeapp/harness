# TraceCode Harness

Opinionated browser-first execution harness for Python, JavaScript, and TypeScript.

This repo contains the runtime contract, browser worker clients, Python harness generation, and worker assets that power TraceCode's execution and tracing pipeline.

## Packages

- `@tracecode/harness-core`: shared runtime contract, result types, trace adapters
- `@tracecode/harness-browser`: browser worker clients and runtime selection
- `@tracecode/harness-python`: Python harness generation and snippets
- `@tracecode/harness-javascript`: JavaScript and TypeScript execution helpers

## Development

```bash
pnpm install
pnpm test
```

## License

GPL-3.0-only

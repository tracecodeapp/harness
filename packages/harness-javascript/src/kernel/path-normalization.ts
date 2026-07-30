import type {
  JavaScriptProjectCommandRequest,
} from "../browser/contracts";

export function normalizeProjectPath(path: string): string {
  const cleaned = path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/workspace\//, '');
  const parts: string[] = [];
  for (const part of cleaned.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

export function workspaceCwdPath(request: JavaScriptProjectCommandRequest): string {
  const projectCwd = request.project.cwd ?? '/workspace';
  if (request.cwd === projectCwd) return '';
  if (request.cwd.startsWith(`${projectCwd}/`)) {
    return normalizeProjectPath(request.cwd.slice(projectCwd.length + 1));
  }
  throw new Error(`Project cwd must stay inside the workspace: ${request.cwd}`);
}

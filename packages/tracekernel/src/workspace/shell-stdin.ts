/** Preserve finite shell input provenance through the patched just-bash interpreter.
 * Empty pipeline/redirect data and absent interactive input otherwise both become ''.
 */
export function markShellStdinInAst(ast: unknown): void {
  const visit = (value: unknown, inheritedInput = false): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, inheritedInput);
      return;
    }
    const node = value as Record<string, unknown>;
    const redirects = node.redirections as Array<{ fd?: number | null; operator?: string }> | undefined;
    const explicitInput = inheritedInput || (redirects ?? []).some((redirect) =>
      (redirect.fd == null || redirect.fd === 0) &&
      ['<', '<<', '<<-', '<<<', '<&', '<>'].includes(redirect.operator ?? '')
    );
    if (node.type === 'Pipeline') {
      (node.commands as unknown[]).forEach((command, index) => visit(command, explicitInput || index > 0));
      return;
    }
    if (node.type === 'SimpleCommand') {
      node.tracecodeStdinClosed = explicitInput;
    }
    for (const [key, entry] of Object.entries(node)) {
      if (key !== 'redirections') visit(entry, explicitInput);
    }
  };
  visit(ast);
}

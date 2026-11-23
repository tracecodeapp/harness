export function matchesPythonReply(event, command) {
  return event.isTrusted && typeof command.protocolToken === 'string' &&
    command.protocolToken.length > 0 && event.data?.id === command.id &&
    event.data.protocolToken === command.protocolToken;
}

export function replyRowCount(event, command) {
  const { data } = event;
  if (command.protocolToken !== undefined && !matchesPythonReply(event, command)) return undefined;
  if (Array.isArray(data.payload?.results)) return data.payload.results.length;
  const count = data.payload?.resultsStreamed;
  if (command.type === 'execute-prepared-program-batch' && data.type === 'execute-result' &&
      matchesPythonReply(event, command) && Number.isSafeInteger(count) && count >= 0) return count;
}

export function retainedControlTargets(control, requests, registered) {
  if (!registered || control.seed !== 'stdout-all') return [];
  const continuations = new Set(requests.filter(({ mode }) => mode === 'continuation').map(({ id }) => id));
  return control.keys.filter((key) => continuations.has(key.split('/')[0]));
}

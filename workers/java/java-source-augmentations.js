(function initTraceCodeJavaSourceAugmentations(root) {
  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function parseNativeTraceLine(line) {
    const match = line.match(/TraceHooks\.emit(?:Line|Call|Return)AtLine\((\d+)\b/);
    if (!match) return null;
    const lineNumber = Number.parseInt(match[1], 10);
    return Number.isFinite(lineNumber) && lineNumber > 0 ? lineNumber : null;
  }

  function braceDelta(line) {
    let delta = 0;
    for (const ch of line) {
      if (ch === '{') delta += 1;
      if (ch === '}') delta -= 1;
    }
    return delta;
  }

  function collectJavaCollectionDeclarations(line) {
    const collections = {
      maps: [],
      sets: [],
      lists: [],
      adjacencyLists: [],
    };
    const declarationPattern =
      /\b((?:java\.util\.)?(?:HashMap|LinkedHashMap|TreeMap|Map|HashSet|LinkedHashSet|TreeSet|Set|ArrayList|LinkedList|List)(?!\.)\s*(?:<[^;=(){}]+?>)?)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
    for (const match of line.matchAll(declarationPattern)) {
      const rawType = match[1] ?? '';
      const typeSource = rawType.replace(/\s+/g, '');
      const outerType = typeSource.replace(/<.*$/, '').replace(/^java\.util\./, '');
      const name = match[2];
      if (!name) continue;
      if (/^(?:HashMap|LinkedHashMap|TreeMap|Map)$/.test(outerType)) {
        collections.maps.push(name);
      } else if (/^(?:HashSet|LinkedHashSet|TreeSet|Set)$/.test(outerType)) {
        collections.sets.push(name);
      } else if (
        /^(?:ArrayList|LinkedList|List)$/.test(outerType) &&
        /<\s*(?:java\.util\.)?(?:List|ArrayList|LinkedList)\s*</.test(rawType)
      ) {
        collections.adjacencyLists.push(name);
      } else if (/^(?:ArrayList|LinkedList|List)$/.test(outerType)) {
        collections.lists.push(name);
      }
    }
    return collections;
  }

  function isLastListIndexExpression(source, receiverName) {
    const normalized = String(source).replace(/\s+/g, '');
    const escaped = escapeRegExp(receiverName);
    return new RegExp(`^${escaped}\\.size\\(\\)-1$`).test(normalized);
  }

  function splitFirstTopLevelJavaArgument(argsSource) {
    let depth = 0;
    let inString = false;
    let inChar = false;
    let escaped = false;
    for (let index = 0; index < argsSource.length; index += 1) {
      const ch = argsSource[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (inString) {
        if (ch === '"') inString = false;
        continue;
      }
      if (inChar) {
        if (ch === "'") inChar = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "'") {
        inChar = true;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth += 1;
      if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth -= 1;
      if (ch === ',' && depth === 0) {
        return [argsSource.slice(0, index).trim(), argsSource.slice(index + 1).trim()];
      }
    }
    return null;
  }

  function replaceJavaReceiverCall(source, receiverName, methodName, replacer) {
    const callPattern = new RegExp(`\\b${escapeRegExp(receiverName)}\\.${methodName}\\(`, 'g');
    let output = '';
    let cursor = 0;
    let match;
    while ((match = callPattern.exec(source)) !== null) {
      const argsStart = match.index + match[0].length;
      let depth = 1;
      let index = argsStart;
      let inString = false;
      let inChar = false;
      let escaped = false;
      while (index < source.length) {
        const ch = source[index];
        if (escaped) {
          escaped = false;
          index += 1;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          index += 1;
          continue;
        }
        if (inString) {
          if (ch === '"') inString = false;
          index += 1;
          continue;
        }
        if (inChar) {
          if (ch === "'") inChar = false;
          index += 1;
          continue;
        }
        if (ch === '"') {
          inString = true;
          index += 1;
          continue;
        }
        if (ch === "'") {
          inChar = true;
          index += 1;
          continue;
        }
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (depth === 0) break;
        index += 1;
      }
      if (depth !== 0) continue;
      output += source.slice(cursor, match.index);
      output += replacer(source.slice(argsStart, index).trim());
      cursor = index + 1;
      callPattern.lastIndex = cursor;
    }
    return output + source.slice(cursor);
  }

  function buildOriginalLineResolver(sourceText) {
    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
      return () => null;
    }
    const linesByText = new Map();
    sourceText.split('\n').forEach((line, index) => {
      const key = line.trim();
      if (!key) return;
      const lines = linesByText.get(key) ?? [];
      lines.push(index + 1);
      linesByText.set(key, lines);
    });
    return (line) => {
      const key = String(line).trim();
      if (!key) return null;
      const lines = linesByText.get(key);
      if (!lines || lines.length === 0) return null;
      return lines.shift() ?? null;
    };
  }

  function augmentJavaCollectionOperations(source, sourceText) {
    const lines = source.split('\n');
    const methodStack = [];
    const resolveOriginalLine = buildOriginalLineResolver(sourceText);
    const methodStartPattern =
      /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

    return lines.map((line, lineIndex) => {
      const methodMatch = line.match(methodStartPattern);
      if (methodMatch) {
        methodStack.push({
          depth: 1,
          currentTraceLine: null,
          maps: new Set(),
          sets: new Set(),
          lists: new Set(),
          adjacencyLists: new Set(),
        });
        const params = collectJavaCollectionDeclarations(methodMatch[3] ?? '');
        params.maps.forEach((name) => methodStack[methodStack.length - 1].maps.add(name));
        params.sets.forEach((name) => methodStack[methodStack.length - 1].sets.add(name));
        params.lists.forEach((name) => methodStack[methodStack.length - 1].lists.add(name));
        params.adjacencyLists.forEach((name) => methodStack[methodStack.length - 1].adjacencyLists.add(name));
        return line;
      }

      const currentMethod = methodStack[methodStack.length - 1];
      let nextLine = line;
      if (!currentMethod) return nextLine;

      const declarations = collectJavaCollectionDeclarations(line);
      declarations.maps.forEach((name) => currentMethod.maps.add(name));
      declarations.sets.forEach((name) => currentMethod.sets.add(name));
      declarations.lists.forEach((name) => currentMethod.lists.add(name));
      declarations.adjacencyLists.forEach((name) => currentMethod.adjacencyLists.add(name));

      const traceLine = parseNativeTraceLine(line);
      if (traceLine !== null) currentMethod.currentTraceLine = traceLine;

      const lineNumber = resolveOriginalLine(line) ?? currentMethod.currentTraceLine ?? (lineIndex + 1);
      if (lineNumber !== null) {
        for (const name of currentMethod.adjacencyLists) {
          const indexedAddPattern = new RegExp(
            `\\b${escapeRegExp(name)}\\.get\\(([^()\\n;]+)\\)\\.add\\(([^;\\n]+)\\);`,
            'g'
          );
          nextLine = nextLine.replace(indexedAddPattern, (_match, indexSource, valueSource) => {
            const indexExpression = String(indexSource).trim();
            return `{ TraceHooks.readObjectListAtLine(${lineNumber}, "${name}", ${name}, ${indexExpression}).add(${String(valueSource).trim()}); TraceHooks.emitMutatingCallAtLine(${lineNumber}, "${name}", ${indexExpression}, "add"); }`;
          });

          const listGetPattern = new RegExp(`\\b${escapeRegExp(name)}\\.get\\(([^()\\n;]+)\\)`, 'g');
          nextLine = nextLine.replace(listGetPattern, (_match, indexSource) =>
            `TraceHooks.readObjectListAtLine(${lineNumber}, "${name}", ${name}, ${String(indexSource).trim()})`
          );
        }

        for (const name of currentMethod.maps) {
          const nestedMapMutationPattern = new RegExp(
            `\\b${escapeRegExp(name)}\\.get\\(([^()\\n;]+)\\)\\.(add|push|append)\\(([^;\\n]+)\\);`,
            'g'
          );
          nextLine = nextLine.replace(nestedMapMutationPattern, (_match, keySource, methodSource, valueSource) => {
            const keyExpression = String(keySource).trim();
            const method = String(methodSource).trim();
            const value = String(valueSource).trim();
            const target = `((java.util.List) (${name}).get(${keyExpression}))`;
            return `{ TraceHooks.emit("trace:{\\"kind\\":\\"read\\",\\"line\\":${lineNumber},\\"target\\":{\\"variable\\":\\"${name}\\",\\"path\\":[" + (${keyExpression}) + "]},\\"value\\":" + TraceHooks.serializeResult(${target}) + "}"); ${target}.${method}(${value}); TraceHooks.emitMutatingCallAtLine(${lineNumber}, "${name}", ${keyExpression}, "${method}"); }`;
          });
          nextLine = replaceJavaReceiverCall(nextLine, name, 'containsKey', (key) =>
            `TraceHooks.containsMapKeyAtLine(${lineNumber}, "${name}", ${name}, ${key})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'get', (key) =>
            `TraceHooks.readMapAtLine(${lineNumber}, "${name}", ${name}, ${key})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'getOrDefault', (argsSource) => {
            const parts = splitFirstTopLevelJavaArgument(argsSource);
            if (!parts) return `${name}.getOrDefault(${argsSource})`;
            return `TraceHooks.readMapOrDefaultAtLine(${lineNumber}, "${name}", ${name}, ${parts[0]}, ${parts[1]})`;
          });
          nextLine = replaceJavaReceiverCall(nextLine, name, 'put', (argsSource) => {
            const parts = splitFirstTopLevelJavaArgument(argsSource);
            if (!parts) return `${name}.put(${argsSource})`;
            return `TraceHooks.writeMapAtLine(${lineNumber}, "${name}", ${name}, ${parts[0]}, ${parts[1]})`;
          });
        }

        for (const name of currentMethod.sets) {
          nextLine = replaceJavaReceiverCall(nextLine, name, 'contains', (key) =>
            `TraceHooks.readSetAtLine(${lineNumber}, "${name}", ${name}, ${key})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'add', (key) =>
            `TraceHooks.addSetAtLine(${lineNumber}, "${name}", ${name}, ${key})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'remove', (key) =>
            `TraceHooks.removeSetAtLine(${lineNumber}, "${name}", ${name}, ${key})`
          );
        }

        for (const name of currentMethod.lists) {
          nextLine = replaceJavaReceiverCall(nextLine, name, 'remove', (indexSource) => {
            if (isLastListIndexExpression(indexSource, name)) {
              return `TraceHooks.popListAtLine(${lineNumber}, "${name}", ${name})`;
            }
            return `${name}.remove(${indexSource})`;
          });
        }

        const staleMutationPattern = /TraceHooks\.emitMutatingCallAtLine\(\d+,\s*"([A-Za-z_][A-Za-z0-9_]*)",\s*"(get|put|set|add|append|remove)"\);\s*/g;
        nextLine = nextLine.replace(staleMutationPattern, (match, name, method) => {
          if (currentMethod.maps.has(name) && (method === 'get' || method === 'put' || method === 'set')) {
            return '';
          }
          if (currentMethod.sets.has(name) && (method === 'add' || method === 'append' || method === 'remove')) {
            return '';
          }
          if (currentMethod.adjacencyLists.has(name) && (method === 'add' || method === 'append')) {
            return '';
          }
          if (currentMethod.lists.has(name) && method === 'remove') {
            return '';
          }
          return match;
        });
      }

      currentMethod.depth += braceDelta(nextLine);
      while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
        methodStack.pop();
      }
      return nextLine;
    }).join('\n');
  }

  const api = {
    augmentJavaCollectionOperations,
  };

  root.TraceCodeJavaSourceAugmentations = api;
  if (root.self && typeof root.self === 'object') {
    root.self.TraceCodeJavaSourceAugmentations = api;
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

(function initTraceCodeJavaSourceAugmentations(root) {
  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isInsideJavaStringLiteral(line, offset) {
    let quote = null;
    let escaped = false;
    for (let index = 0; index < offset; index += 1) {
      const ch = line[index];
      const next = line[index + 1] ?? '';
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote) {
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && next === '/') return false;
      if (ch === '"' || ch === "'") quote = ch;
    }
    return quote !== null;
  }

  function isInsideJavaComment(line, offset) {
    let quote = null;
    let escaped = false;
    let blockDepth = 0;
    for (let index = 0; index < offset; index += 1) {
      const ch = line[index];
      const next = line[index + 1] ?? '';
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote) {
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (blockDepth > 0) {
        if (ch === '/' && next === '*') {
          blockDepth += 1;
          index += 1;
          continue;
        }
        if (ch === '*' && next === '/') {
          blockDepth -= 1;
          index += 1;
        }
        continue;
      }
      if (ch === '/' && next === '/') return true;
      if (ch === '/' && next === '*') {
        blockDepth += 1;
        index += 1;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
    }
    return blockDepth > 0;
  }

  function parseNativeTraceLine(line) {
    const match = line.match(/TraceHooks\.[A-Za-z0-9_]+AtLine\((\d+)\b/);
    if (!match) return null;
    const lineNumber = Number.parseInt(match[1], 10);
    return Number.isFinite(lineNumber) && lineNumber > 0 ? lineNumber : null;
  }

  function javaBraceCounts(line) {
    let open = 0;
    let close = 0;
    let quote = null;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const ch = line[index];
      const next = line[index + 1] ?? '';
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote) {
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') {
        const end = line.indexOf('*/', index + 2);
        if (end === -1) break;
        index = end + 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '{') open += 1;
      if (ch === '}') close += 1;
    }
    return { open, close, delta: open - close };
  }

  function braceDelta(line) {
    return javaBraceCounts(line).delta;
  }

  function collectJavaCollectionDeclarations(line) {
    const collections = {
      maps: [],
      sets: [],
      lists: [],
      queues: [],
      adjacencyLists: [],
      arrays: [],
      integerScalars: [],
    };
    const declarationPattern =
      /\b((?:java\.util\.)?(?:HashMap|LinkedHashMap|TreeMap|Map|HashSet|LinkedHashSet|TreeSet|Set|ArrayList|LinkedList|List|ArrayDeque|Deque|Queue)(?!\.)\s*(?:<[^;=(){}]+?>)?)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
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
      } else if (/^(?:ArrayDeque|Deque|Queue)$/.test(outerType)) {
        collections.lists.push(name);
        collections.queues.push(name);
      } else if (/^(?:ArrayList|LinkedList|List)$/.test(outerType)) {
        collections.lists.push(name);
      }
    }
    const arrayDeclarationPattern =
      /\b(?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Za-z_][A-Za-z0-9_<>.?]*)\s*(?:\[\s*\]\s*)+\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
    for (const match of line.matchAll(arrayDeclarationPattern)) {
      const name = match[1];
      if (name) collections.arrays.push(name);
    }
    const integerScalarDeclarationPattern = /\b(?:byte|short|char|int)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
    for (const match of line.matchAll(integerScalarDeclarationPattern)) {
      const name = match[1];
      if (name) collections.integerScalars.push(name);
    }
    return collections;
  }

  function isLastListIndexExpression(source, receiverName) {
    const normalized = String(source).replace(/\s+/g, '');
    const escaped = escapeRegExp(receiverName);
    return new RegExp(`^${escaped}\\.size\\(\\)-1$`).test(normalized);
  }

  function stripOuterJavaParentheses(source) {
    let value = String(source).trim();
    let changed = true;
    while (changed && value.startsWith('(') && value.endsWith(')')) {
      changed = false;
      let depth = 0;
      let quote = null;
      let escaped = false;
      let wrapsWholeExpression = true;
      for (let index = 0; index < value.length; index += 1) {
        const ch = value[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (quote) {
          if (ch === '\\') {
            escaped = true;
            continue;
          }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (depth === 0 && index < value.length - 1) {
          wrapsWholeExpression = false;
          break;
        }
      }
      if (wrapsWholeExpression && depth === 0) {
        value = value.slice(1, -1).trim();
        changed = true;
      }
    }
    return value;
  }

  function isDefinitelyListIndexExpression(source, receiverName, currentMethod) {
    const value = stripOuterJavaParentheses(source);
    if (!value) return false;
    if (isLastListIndexExpression(value, receiverName)) return true;
    if (/^[+-]?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*)$/.test(value)) return true;
    if (/^'(?:\\.|[^'\\])'$/.test(value)) return true;
    if (/^\(\s*(?:byte|short|char|int)\s*\)/.test(value)) return true;
    if (/"(?:\\.|[^"\\])*"/.test(value)) return false;
    const withoutCharLiterals = value.replace(/'(?:\\.|[^'\\])'/g, '0');
    const identifiers = Array.from(withoutCharLiterals.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g), (match) => match[0]);
    const uniqueIdentifiers = Array.from(new Set(identifiers));
    if (uniqueIdentifiers.length === 0) return false;
    if (!uniqueIdentifiers.every((name) => currentMethod.integerScalars.has(name))) return false;
    const stripped = withoutCharLiterals
      .replace(/0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*/g, '')
      .replace(/[A-Za-z_][A-Za-z0-9_]*/g, '')
      .replace(/\+\+|--/g, '')
      .replace(/[+\-*/%() \t]/g, '');
    return stripped.length === 0;
  }

  function isSimpleIdentifierExpression(source) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(source).trim());
  }

  function singleIdentifierIndexSource(source) {
    const identifiers = Array.from(String(source).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g), (match) => match[0]);
    const unique = Array.from(new Set(identifiers.filter((name) => name !== 'TraceHooks')));
    if (unique.length !== 1) return null;
    const stripped = String(source)
      .replace(/[A-Za-z_][A-Za-z0-9_]*/g, '')
      .replace(/[0-9]+/g, '')
      .replace(/[+\-*/%() \t]/g, '');
    return stripped.length === 0 ? unique[0] : null;
  }

  function safeIndexSourceExpression(source) {
    const value = String(source).trim().replace(/\s+/g, ' ');
    if (!value) return null;
    if (!/[A-Za-z_][A-Za-z0-9_]*/.test(value)) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
    const unaryIndex = value.match(/^(?:\+\+|--)\s*([A-Za-z_][A-Za-z0-9_]*)$/) ?? value.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+\+|--)$/);
    if (unaryIndex?.[1]) return unaryIndex[1];
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*\[[^\]]+\]\s*$/.test(value)) return value.replace(/\s+/g, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*\(\))+(?:\s*[+\-*/%]\s*[0-9]+)?$/.test(value)) {
      return value;
    }
    const stripped = value
      .replace(/[A-Za-z_][A-Za-z0-9_]*/g, '')
      .replace(/[0-9]+/g, '')
      .replace(/[+\-*/%() \t]/g, '');
    return stripped.length === 0 ? value : null;
  }

  function indexSourceArgument(source) {
    const value = String(source).trim();
    const tracedReadSource = tracedIndexedReadSource(value);
    if (tracedReadSource) return JSON.stringify(tracedReadSource);
    const charAtIndexMatch = value.match(/^[A-Za-z_][A-Za-z0-9_]*\.charAt\(\s*([\s\S]+)\s*\)$/);
    if (charAtIndexMatch?.[1]) {
      const charAtSource = safeIndexSourceExpression(charAtIndexMatch[1]) ?? singleIdentifierIndexSource(charAtIndexMatch[1]);
      if (charAtSource) return JSON.stringify(charAtSource);
    }
    const expressionSource = safeIndexSourceExpression(value) ?? singleIdentifierIndexSource(value);
    if (expressionSource) return JSON.stringify(expressionSource);
    return isSimpleIdentifierExpression(value) ? JSON.stringify(value) : 'null';
  }

  function tracedIndexedReadSource(source) {
    const value = String(source).trim();
    if (!value.startsWith('TraceHooks.read')) return null;
    const open = value.indexOf('(');
    if (open < 0 || !value.endsWith(')')) return null;
    const args = splitTopLevelJavaList(value.slice(open + 1, -1));
    if (args.length < 2) return null;
    const name = String(args[1]).trim().match(/^"([A-Za-z_][A-Za-z0-9_]*)"$/)?.[1];
    if (!name) return null;
    const explicitSource = String(args[args.length - 1] ?? '').trim().match(/^"([^"]+)"$/)?.[1];
    return explicitSource || name;
  }

  function indexSourceArgumentSourceFirst(source) {
    const value = String(source).trim();
    const tracedIndexedRead = value.match(/^TraceHooks\.read[A-Za-z0-9_]*AtLine\(\s*\d+\s*,\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,[\s\S]*,\s*"([^"]+)"\s*\)$/);
    if (tracedIndexedRead?.[1] && tracedIndexedRead?.[2]) {
      return JSON.stringify(`${tracedIndexedRead[1]}[${tracedIndexedRead[2]}]`);
    }
    return indexSourceArgument(value);
  }

  function rewriteEnhancedForIterationBind(line, lineNumber, currentMethod) {
    const typePattern = '((?:final\\s+)?(?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Za-z_][A-Za-z0-9_<>.?]*(?:\\s*<[^,;=(){}:]+>)?)\\s*(?:\\[\\s*\\])*)';
    const tracedListReadPattern = new RegExp(
      `\\bfor\\s*\\(\\s*${typePattern}\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*(TraceHooks\\.read(?:Object)?ListAtLine\\(\\s*\\d+\\s*,\\s*"([A-Za-z_][A-Za-z0-9_]*)"\\s*,\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*,\\s*([^,]+)\\s*,\\s*([^)]+)\\))\\s*\\)`,
      'g'
    );
    const withTracedListBindings = String(line).replace(
      tracedListReadPattern,
      (match, typeSource, bindingName, source, sourceName, receiverName, indexExpression, indexSource) => {
        if (sourceName !== receiverName) return match;
        if (
          currentMethod.lists.has(sourceName) ||
          currentMethod.adjacencyLists.has(sourceName)
        ) {
          return `for (${typeSource} ${bindingName} : TraceHooks.iterationBindAtLine(${lineNumber}, "${sourceName}", ${String(indexExpression).trim()}, ${source}, "${bindingName}", ${String(indexSource).trim()}))`;
        }
        return match;
      }
    );
    return withTracedListBindings.replace(
      /\bfor\s*\(\s*((?:final\s+)?(?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^,;=(){}:]+>)?)\s*(?:\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^)]+?)\s*\)/g,
      (match, typeSource, bindingName, sourceExpression) => {
        const source = String(sourceExpression).trim();
        if (!bindingName || !source || source.startsWith('__tracecode')) return match;
        const indexedSource = source.match(/^([A-Za-z_][A-Za-z0-9_]*)\.get\(([^()]+)\)$/);
        if (indexedSource) {
          const sourceName = indexedSource[1];
          const indexExpression = String(indexedSource[2]).trim();
          if (
            currentMethod.lists.has(sourceName) ||
            currentMethod.adjacencyLists.has(sourceName)
          ) {
            return `for (${typeSource} ${bindingName} : TraceHooks.iterationBindAtLine(${lineNumber}, "${sourceName}", ${indexExpression}, ${source}, "${bindingName}", ${indexSourceArgument(indexExpression)}))`;
          }
        }
        const tracedListRead = source.match(/^TraceHooks\.readListAtLine\(\s*\d+\s*,\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,\s*\1\s*,\s*([^,]+)\s*,\s*([^)]+)\)$/);
        if (tracedListRead) {
          const sourceName = tracedListRead[1];
          const indexExpression = String(tracedListRead[2]).trim();
          const indexSource = String(tracedListRead[3]).trim();
          if (
            currentMethod.lists.has(sourceName) ||
            currentMethod.adjacencyLists.has(sourceName)
          ) {
            return `for (${typeSource} ${bindingName} : TraceHooks.iterationBindAtLine(${lineNumber}, "${sourceName}", ${indexExpression}, ${source}, "${bindingName}", ${indexSource}))`;
          }
        }
        const sourceName = source;
        if (
          !currentMethod.lists.has(sourceName) &&
          !currentMethod.adjacencyLists.has(sourceName) &&
          !currentMethod.sets.has(sourceName) &&
          !currentMethod.maps.has(sourceName) &&
          !currentMethod.arrays.has(sourceName)
        ) {
          return match;
        }
        return `for (${typeSource} ${bindingName} : TraceHooks.iterationBindAtLine(${lineNumber}, "${sourceName}", ${sourceName}, "${bindingName}"))`;
      }
    );
  }

  function escapedIndexSourcesTargetSegment(...sources) {
    return `,\\"indexSources\\":[${sources
      .map((source) => {
        const value = String(source).trim();
        return isSimpleIdentifierExpression(value) ? `\\"${value}\\"` : 'null';
      })
      .join(',')}]`;
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

  function splitTopLevelJavaList(value) {
    const parts = [];
    let start = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let angleDepth = 0;
    let quote = null;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
      const ch = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '(') parenDepth += 1;
      if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
      if (ch === '[') bracketDepth += 1;
      if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      if (ch === '{') braceDepth += 1;
      if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      if (ch === '<') angleDepth += 1;
      if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
      if (ch === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
        parts.push(value.slice(start, index).trim());
        start = index + 1;
      }
    }
    const tail = value.slice(start).trim();
    if (tail.length > 0) parts.push(tail);
    return parts;
  }

  function parseJavaParameterNames(parametersSource) {
    return splitTopLevelJavaList(parametersSource)
      .map((parameter) => parameter.replace(/@\w+(?:\([^)]*\))?/g, '').replace(/\bfinal\b/g, '').trim())
      .map((parameter) => parameter.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.\.\.)?$/)?.[1] ?? '')
      .filter((name) => name.length > 0);
  }

  function augmentTraceCallArgumentSnapshots(source) {
    const lines = source.split('\n');
    const methodStack = [];
    const methodStartPattern =
      /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;

    return lines.map((line) => {
      const methodMatch = line.match(methodStartPattern);
      if (methodMatch) {
        methodStack.push({
          name: methodMatch[2],
          params: parseJavaParameterNames(methodMatch[3] ?? ''),
          depth: 1,
          patchedCall: false,
        });
        return line;
      }

      const currentMethod = methodStack[methodStack.length - 1];
      let nextLine = line;
      if (currentMethod && !currentMethod.patchedCall && currentMethod.params.length > 0) {
        const callPattern = new RegExp(
          `^(\\s*)TraceHooks\\.emitCallAtLine\\((\\d+),\\s*"${escapeRegExp(currentMethod.name)}",\\s*([^)]*)\\);\\s*$`
        );
        const callMatch = line.match(callPattern);
        if (callMatch) {
          const serializedArgs = currentMethod.params
            .map((paramName) => ` + " ${paramName}=" + TraceHooks.serializeResult(${paramName})`)
            .join('');
          nextLine = `${callMatch[1]}TraceHooks.emitCallAtLine(${callMatch[2]}, "${currentMethod.name}", ""${serializedArgs});`;
          currentMethod.patchedCall = true;
        }
      }

      if (currentMethod) {
        currentMethod.depth += braceDelta(nextLine);
        while (methodStack.length > 0 && methodStack[methodStack.length - 1].depth <= 0) {
          methodStack.pop();
        }
      }

      return nextLine;
    }).join('\n');
  }

  function collectJavaLocalDeclarations(line) {
    const names = [];
    const trimmedLine = String(line).trim();
    if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*')) return names;
    const declarationPattern =
      /\b(?:final\s+)?((?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^,;=(){}:]+>)?)\s*(?:\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?==)/g;
    const skippedNames = new Set(['class', 'interface', 'enum', 'record', 'return', 'new']);
    for (const match of line.matchAll(declarationPattern)) {
      const name = match[2];
      if (name && !skippedNames.has(name) && !name.startsWith('__tracecode')) names.push(name);
    }
    const enhancedForMatch = line.match(
      /\bfor\s*\(\s*(?:final\s+)?((?:boolean|byte|char|short|int|long|float|double|String|Object|[A-Za-z_][A-Za-z0-9_<>.?]*(?:\s*<[^,;=(){}:]+>)?)\s*(?:\[\s*\])*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/
    );
    const enhancedForName = enhancedForMatch?.[2];
    if (enhancedForName && !skippedNames.has(enhancedForName) && !enhancedForName.startsWith('__tracecode')) {
      names.push(enhancedForName);
    }
    return names;
  }

  function visibleJavaLocalNames(scopeStack) {
    const names = [];
    const seen = new Set();
    for (const scope of scopeStack) {
      for (const name of scope.names) {
        if (!seen.has(name)) {
          names.push(name);
          seen.add(name);
        }
      }
    }
    return names;
  }

  function isUnbracedForDeclarationLine(line) {
    return /^\s*for\s*\(/.test(line) && !(line.includes('{'));
  }

  function isControlHeaderDeclarationLine(line) {
    return /^\s*(?:for|if|while|switch|catch)\s*\(/.test(line);
  }

  function traceEmitAlreadyIncludesVariable(emitExpression, name) {
    return new RegExp(`\\b${escapeRegExp(name)}=`).test(emitExpression);
  }

  function appendJavaLocalSnapshotsToEmitLine(line, scopeStack) {
    const visibleNames = visibleJavaLocalNames(scopeStack);
    if (visibleNames.length === 0 || !line.includes('TraceHooks.emitLineAtLine(')) return line;

    return line.replace(/TraceHooks\.emitLineAtLine\((\d+)(?:,\s*([^;]*?))?\);/g, (match, lineNumber, snapshotExpression) => {
      const emitExpression = snapshotExpression ?? '';
      const additions = visibleNames
        .filter((name) => !traceEmitAlreadyIncludesVariable(emitExpression, name))
        .map((name) => ` + " ${name}=" + TraceHooks.serializeResult(${name})`)
        .join('');
      if (!additions) return match;
      const prefix = emitExpression.trim().length > 0 ? emitExpression.trim() : '""';
      return `TraceHooks.emitLineAtLine(${Number.parseInt(lineNumber, 10)}, ${prefix}${additions});`;
    });
  }

  function guardJavaLineEmit(line) {
    return line.replace(
      /^(\s*)TraceHooks\.emitLineAtLine\((.+)\);\s*$/,
      (_match, indent, argsSource) => `${indent}if (!TraceHooks.traceLimitExceeded()) TraceHooks.emitLineAtLine(${argsSource});`
    );
  }

  function appendJavaScalarDeclarationWrites(line, lineNumber) {
    if (line.includes('TraceHooks.emitScalarWriteAtLine(')) return line;
    if (/TraceHooks\.read[A-Za-z0-9_]*AtLine\(/.test(line)) return line;
    if (/^\s*(?:for|if|while|switch|catch)\s*\(/.test(line)) return line;
    if (!/;\s*$/.test(line)) return line;
    const declarations = collectJavaLocalDeclarations(line);
    if (declarations.length === 0) return line;
    const indent = line.match(/^(\s*)/)?.[1] ?? '';
    const writes = declarations
      .map((name) => `${indent}TraceHooks.emitScalarWriteAtLine(${lineNumber}, "${name}", ${name});`)
      .join('\n');
    return `${line}\n${writes}`;
  }

  function appendJavaPendingScalarDeclarationWrites(line, lineNumber, declarations) {
    if (!Array.isArray(declarations) || declarations.length === 0) return line;
    if (!/;\s*$/.test(line)) return line;
    const indent = line.match(/^(\s*)/)?.[1] ?? '';
    const writes = declarations
      .map((name) => `${indent}TraceHooks.emitScalarWriteAtLine(${lineNumber}, "${name}", ${name});`)
      .join('\n');
    return writes ? `${line}\n${writes}` : line;
  }

  function augmentJavaLocalSnapshots(source) {
    const lines = source.split('\n');
    const output = [];
    const scopeStack = [];
    let currentTraceLine = null;
    let pendingScalarDeclarationWrites = null;
    let methodDepth = 0;
    let generatedExportsClassDepth = null;
    const methodStartPattern =
      /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;
    const generatedExportsClassPattern = /^\s*(?:(?:public|private|protected|static|final)\s+)*class\s+Exports[A-Za-z0-9_]*\s*\{/;

    for (const line of lines) {
      if (generatedExportsClassDepth !== null) {
        output.push(line);
        generatedExportsClassDepth += braceDelta(line);
        if (generatedExportsClassDepth <= 0) generatedExportsClassDepth = null;
        continue;
      }
      if (generatedExportsClassPattern.test(line)) {
        output.push(line);
        generatedExportsClassDepth = Math.max(0, braceDelta(line));
        if (generatedExportsClassDepth <= 0) generatedExportsClassDepth = null;
        continue;
      }
      if (methodDepth <= 0) {
        const methodMatch = line.match(methodStartPattern);
        if (methodMatch) {
          methodDepth = Math.max(0, braceDelta(line));
          scopeStack.length = 0;
          scopeStack.push({ names: parseJavaParameterNames(methodMatch[3] ?? '') });
          output.push(line);
          if (methodDepth <= 0) {
            scopeStack.length = 0;
            pendingScalarDeclarationWrites = null;
          }
          continue;
        }
        output.push(line);
        continue;
      }

      const leadingClosingCount = line.match(/^\s*}+/)?.[0].replace(/\s/g, '').length ?? 0;
      for (let index = 0; index < leadingClosingCount; index += 1) {
        if (scopeStack.length > 0) scopeStack.pop();
      }

      output.push(guardJavaLineEmit(appendJavaLocalSnapshotsToEmitLine(line, scopeStack)));
      const emittedTraceLine = parseNativeTraceLine(output[output.length - 1]);
      if (emittedTraceLine !== null) currentTraceLine = emittedTraceLine;
      const declarations = collectJavaLocalDeclarations(line);
      if (declarations.length > 0) {
        const lastIndex = output.length - 1;
        const lineNumber = parseNativeTraceLine(output[lastIndex]) ?? currentTraceLine;
        if (
          lineNumber !== null &&
          !isControlHeaderDeclarationLine(line) &&
          line.includes('=') &&
          !line.includes('->') &&
          !/;\s*$/.test(line)
        ) {
          pendingScalarDeclarationWrites = {
            lineNumber,
            declarations: [...declarations],
          };
        }
      } else if (pendingScalarDeclarationWrites && /;\s*$/.test(line)) {
        const lastIndex = output.length - 1;
        output[lastIndex] = appendJavaPendingScalarDeclarationWrites(
          output[lastIndex],
          pendingScalarDeclarationWrites.lineNumber,
          pendingScalarDeclarationWrites.declarations
        );
        pendingScalarDeclarationWrites = null;
      }
      const declarationsBelongToCurrentScope =
        declarations.length > 0 && !isControlHeaderDeclarationLine(line);
      if (declarationsBelongToCurrentScope) {
        const currentScope = scopeStack[scopeStack.length - 1];
        if (currentScope) currentScope.names.push(...declarations);
      }
      const braceCounts = javaBraceCounts(line);
      const openingCount = braceCounts.open;
      const closingCount = Math.max(0, braceCounts.close - leadingClosingCount);
      for (let index = 0; index < openingCount; index += 1) {
        scopeStack.push({ names: index === 0 && !declarationsBelongToCurrentScope ? declarations : [] });
      }
      if (
        openingCount === 0 &&
        declarations.length > 0 &&
        !declarationsBelongToCurrentScope &&
        !isUnbracedForDeclarationLine(line)
      ) {
        const currentScope = scopeStack[scopeStack.length - 1];
        if (currentScope) currentScope.names.push(...declarations);
      }
      for (let index = 0; index < closingCount; index += 1) {
        if (scopeStack.length > 0) scopeStack.pop();
      }
      methodDepth += braceCounts.delta;
      if (methodDepth <= 0) {
        methodDepth = 0;
        scopeStack.length = 0;
        pendingScalarDeclarationWrites = null;
      }
    }

    return output.join('\n');
  }

  function replaceJavaReceiverCall(source, receiverName, methodName, replacer) {
    const nativeInstrumentedQueueMethods = new Set([
      'offer',
      'push',
      'addLast',
      'offerLast',
      'addFirst',
      'offerFirst',
      'poll',
      'remove',
      'pop',
    ]);
    if (
      nativeInstrumentedQueueMethods.has(methodName) &&
      hasNativeMutatingHookForReceiver(source, receiverName, methodName)
    ) {
      return source;
    }
    const callPattern = new RegExp(`\\b${escapeRegExp(receiverName)}\\.${methodName}\\(`, 'g');
    let output = '';
    let cursor = 0;
    let match;
    while ((match = callPattern.exec(source)) !== null) {
      if (isInsideJavaStringLiteral(source, match.index)) continue;
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

  function findJavaSourceMatchIndex(source, pattern, startIndex = 0) {
    pattern.lastIndex = startIndex;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (!isInsideJavaStringLiteral(source, match.index) && !isInsideJavaComment(source, match.index)) {
        return match.index;
      }
    }
    return -1;
  }

  function hasNativeMutatingHookForReceiver(source, receiverName, methodName) {
    const trimmed = source.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
    const receiver = escapeRegExp(receiverName);
    const method = escapeRegExp(methodName);
    const callIndex = findJavaSourceMatchIndex(source, new RegExp(`\\b${receiver}\\.${method}\\(`, 'g'));
    if (callIndex < 0) return false;
    const hookPatterns = [
      new RegExp(`TraceHooks\\.emitMutatingCallAtLine\\(\\s*\\d+\\s*,\\s*"${receiver}"\\s*,\\s*"${method}"(?:\\s*[,\\)])`, 'g'),
      new RegExp(`TraceHooks\\.emitNoArgMutatingCallAtLine\\(\\s*\\d+\\s*,\\s*"${receiver}"\\s*,\\s*"${method}"(?:\\s*[,\\)])`, 'g'),
    ];
    const snapshotPattern = new RegExp(
      `TraceHooks\\.emitRuntimeSnapshotAtLine\\(\\s*\\d+\\s*,\\s*"${receiver}"\\s*,\\s*${receiver}\\s*\\)`,
      'g'
    );
    for (const pattern of hookPatterns) {
      const hookIndex = findJavaSourceMatchIndex(source, pattern, callIndex + 1);
      if (hookIndex < 0) continue;
      const snapshotIndex = findJavaSourceMatchIndex(source, snapshotPattern, hookIndex + 1);
      if (snapshotIndex > hookIndex) return true;
    }
    return false;
  }

  function rewriteJavaArraysFillStatement(line, lineNumber, currentMethod) {
    const match = String(line).match(/^(\s*)(?:java\.util\.)?Arrays\.fill\(([\s\S]*)\);\s*$/);
    if (!match) return line;
    const indent = match[1] ?? '';
    const argsSource = match[2] ?? '';
    const args = splitTopLevelJavaList(argsSource);
    if (args.length !== 2) return line;
    const arrayName = String(args[0]).trim();
    if (!isSimpleIdentifierExpression(arrayName) || !currentMethod.arrays.has(arrayName)) return line;
    return `${indent}TraceHooks.fillArrayAtLine(${lineNumber}, "${arrayName}", ${arrayName}, ${args[1]});`;
  }

  function rewriteJavaArraysSortStatement(line, lineNumber, currentMethod) {
    const match = String(line).match(/^(\s*)(?:java\.util\.)?Arrays\.sort\(([\s\S]*)\);\s*$/);
    if (!match) return line;
    const indent = match[1] ?? '';
    const argsSource = match[2] ?? '';
    const args = splitTopLevelJavaList(argsSource);
    if (args.length < 1 || args.length > 2) return line;
    const arrayName = String(args[0]).trim();
    if (!isSimpleIdentifierExpression(arrayName) || !currentMethod.arrays.has(arrayName)) return line;
    const suffix = args.length === 2 ? `, ${args[1]}` : '';
    return `${indent}TraceHooks.sortArrayAtLine(${lineNumber}, "${arrayName}", ${arrayName}${suffix});`;
  }

  function rewriteJavaArraysSortRewriterBlock(line, lineNumber, currentMethod) {
    const text = String(line);
    const comparatorBlock = text.match(
      /^(\s*)\{\s*var\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+?);\s*(?:java\.util\.)?Arrays\.sort\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*\2\s*\);\s*TraceHooks\.emitMutatingCallAtLine\(\d+,\s*"Arrays",\s*"sort",[\s\S]*?\);\s*TraceHooks\.emitRuntimeSnapshotAtLine\(\d+,\s*"Arrays",\s*Arrays\);\s*\}\s*$/
    );
    if (comparatorBlock) {
      const indent = comparatorBlock[1] ?? '';
      const comparatorSource = comparatorBlock[3] ?? '';
      const arrayName = comparatorBlock[4] ?? '';
      if (currentMethod.arrays.has(arrayName)) {
        return `${indent}TraceHooks.sortArrayAtLine(${lineNumber}, "${arrayName}", ${arrayName}, ${comparatorSource});`;
      }
    }

    const simpleBlock = text.match(
      /^(\s*)\{\s*(?:java\.util\.)?Arrays\.sort\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\);\s*TraceHooks\.emitMutatingCallAtLine\(\d+,\s*"Arrays",\s*"sort",[\s\S]*?\);\s*TraceHooks\.emitRuntimeSnapshotAtLine\(\d+,\s*"Arrays",\s*Arrays\);\s*\}\s*$/
    );
    if (simpleBlock) {
      const indent = simpleBlock[1] ?? '';
      const arrayName = simpleBlock[2] ?? '';
      if (currentMethod.arrays.has(arrayName)) {
        return `${indent}TraceHooks.sortArrayAtLine(${lineNumber}, "${arrayName}", ${arrayName});`;
      }
    }

    return line;
  }

  function rewriteJavaCollectionsSortStatement(line, lineNumber, currentMethod) {
    const match = String(line).match(/^(\s*)(?:java\.util\.)?Collections\.sort\(([\s\S]*)\);\s*$/);
    if (!match) return line;
    const indent = match[1] ?? '';
    const argsSource = match[2] ?? '';
    const args = splitTopLevelJavaList(argsSource);
    if (args.length < 1 || args.length > 2) return line;
    const listName = String(args[0]).trim();
    if (!isSimpleIdentifierExpression(listName) || !currentMethod.lists.has(listName)) return line;
    const comparator = args.length === 2 ? args[1] : 'null';
    return `${indent}TraceHooks.sortListAtLine(${lineNumber}, "${listName}", ${listName}, ${comparator});`;
  }

  function rewriteJavaArrayLengthReads(line, lineNumber, currentMethod) {
    let nextLine = line;
    for (const name of currentMethod.arrays) {
      const tracedArrayElementLengthPattern = new RegExp(
        `TraceHooks\\.read(?:Object)?ArrayAtLine\\(\\s*${lineNumber}\\s*,\\s*"${escapeRegExp(name)}"\\s*,\\s*${escapeRegExp(name)}\\s*,\\s*([^,]+)\\s*,\\s*([^\\)]+)\\)\\.length\\b(?!\\s*\\()`,
        'g'
      );
      nextLine = nextLine.replace(tracedArrayElementLengthPattern, (match, indexExpression, indexSource, offset) => {
        if (isInsideJavaStringLiteral(nextLine, offset)) return match;
        const readCall = match.slice(0, match.lastIndexOf('.length'));
        return `TraceHooks.readArrayLengthAtLine(${lineNumber}, "${name}", ${readCall}, ${String(indexExpression).trim()}, ${String(indexSource).trim()})`;
      });
      const nestedLengthPattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\[([^\\]]+)\\]\\.length\\b(?!\\s*\\()`, 'g');
      nextLine = nextLine.replace(nestedLengthPattern, (match, indexExpression, offset) => {
        if (isInsideJavaStringLiteral(nextLine, offset)) return match;
        const indexSource = String(indexExpression).trim();
        return `TraceHooks.readArrayLengthAtLine(${lineNumber}, "${name}", ${name}[${indexSource}], ${indexSource}, ${indexSourceArgument(indexSource)})`;
      });
      const lengthPattern = new RegExp(`\\b${escapeRegExp(name)}\\.length\\b(?!\\s*\\()`, 'g');
      nextLine = nextLine.replace(lengthPattern, (match, offset) => {
        if (isInsideJavaStringLiteral(nextLine, offset)) return match;
        return `TraceHooks.readArrayLengthAtLine(${lineNumber}, "${name}", ${name})`;
      });
    }
    return nextLine;
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
    let generatedExportsClassDepth = null;
    const resolveOriginalLine = buildOriginalLineResolver(sourceText);
    const methodStartPattern =
      /^(\s*)(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>\[\], ?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$/;
    const generatedExportsClassPattern = /^\s*(?:(?:public|private|protected|static|final)\s+)*class\s+Exports[A-Za-z0-9_]*\s*\{/;

    return lines.map((line, lineIndex) => {
      if (generatedExportsClassDepth !== null) {
        generatedExportsClassDepth += braceDelta(line);
        if (generatedExportsClassDepth <= 0) generatedExportsClassDepth = null;
        return line;
      }
      if (generatedExportsClassPattern.test(line)) {
        generatedExportsClassDepth = Math.max(0, braceDelta(line));
        if (generatedExportsClassDepth <= 0) generatedExportsClassDepth = null;
        return line;
      }

      const methodMatch = line.match(methodStartPattern);
      if (methodMatch) {
        methodStack.push({
          depth: 1,
          currentTraceLine: null,
          maps: new Set(),
          sets: new Set(),
          lists: new Set(),
          queues: new Set(),
          adjacencyLists: new Set(),
          arrays: new Set(),
          integerScalars: new Set(),
        });
        const params = collectJavaCollectionDeclarations(methodMatch[3] ?? '');
        params.maps.forEach((name) => methodStack[methodStack.length - 1].maps.add(name));
        params.sets.forEach((name) => methodStack[methodStack.length - 1].sets.add(name));
        params.lists.forEach((name) => methodStack[methodStack.length - 1].lists.add(name));
        params.queues.forEach((name) => methodStack[methodStack.length - 1].queues.add(name));
        params.adjacencyLists.forEach((name) => methodStack[methodStack.length - 1].adjacencyLists.add(name));
        params.arrays.forEach((name) => methodStack[methodStack.length - 1].arrays.add(name));
        params.integerScalars.forEach((name) => methodStack[methodStack.length - 1].integerScalars.add(name));
        return line;
      }

      const currentMethod = methodStack[methodStack.length - 1];
      let nextLine = line;
      if (!currentMethod) return nextLine;

      const declarations = collectJavaCollectionDeclarations(line);
      declarations.maps.forEach((name) => currentMethod.maps.add(name));
      declarations.sets.forEach((name) => currentMethod.sets.add(name));
      declarations.lists.forEach((name) => currentMethod.lists.add(name));
      declarations.queues.forEach((name) => currentMethod.queues.add(name));
      declarations.adjacencyLists.forEach((name) => currentMethod.adjacencyLists.add(name));
      declarations.arrays.forEach((name) => currentMethod.arrays.add(name));
      declarations.integerScalars.forEach((name) => currentMethod.integerScalars.add(name));

      const traceLine = parseNativeTraceLine(line);
      if (traceLine !== null) currentMethod.currentTraceLine = traceLine;

      const lineNumber = resolveOriginalLine(line) ?? currentMethod.currentTraceLine ?? (lineIndex + 1);
      if (lineNumber !== null) {
        nextLine = rewriteEnhancedForIterationBind(nextLine, lineNumber, currentMethod);
        nextLine = rewriteJavaArraysFillStatement(nextLine, lineNumber, currentMethod);
        nextLine = rewriteJavaArraysSortRewriterBlock(nextLine, lineNumber, currentMethod);
        nextLine = rewriteJavaArraysSortStatement(nextLine, lineNumber, currentMethod);
        nextLine = rewriteJavaCollectionsSortStatement(nextLine, lineNumber, currentMethod);
        nextLine = rewriteJavaArrayLengthReads(nextLine, lineNumber, currentMethod);

        for (const name of currentMethod.adjacencyLists) {
          nextLine = replaceJavaReceiverCall(nextLine, name, 'add', (valueSource) =>
            `TraceHooks.addCollectionAtLine(${lineNumber}, "${name}", ${name}, ${valueSource})`
          );

          const indexedAddPattern = new RegExp(
            `\\b${escapeRegExp(name)}\\.get\\(([^()\\n;]+)\\)\\.add\\(([^;\\n]+)\\);`,
            'g'
          );
          nextLine = nextLine.replace(indexedAddPattern, (_match, indexSource, valueSource) => {
            const indexExpression = String(indexSource).trim();
            const value = String(valueSource).trim();
            return `{ java.util.List __tracecodeTarget = TraceHooks.readObjectListAtLine(${lineNumber}, "${name}", ${name}, ${indexExpression}, ${indexSourceArgument(indexExpression)}); __tracecodeTarget.add(${value}); TraceHooks.emitMutatingCallAtLine(${lineNumber}, "${name}", ${indexExpression}, "add", ${indexSourceArgument(indexExpression)}, ${value}); TraceHooks.emitIndexedWriteAtLine(${lineNumber}, "${name}", new Object[] { ${indexExpression}, __tracecodeTarget.size() - 1 }, ${value}, ${indexSourceArgument(indexExpression)}, null); TraceHooks.emitRuntimeSnapshotAtLine(${lineNumber}, "${name}", ${name}); }`;
          });

          const listGetPattern = new RegExp(`\\b${escapeRegExp(name)}\\.get\\(([^()\\n;]+)\\)`, 'g');
          nextLine = nextLine.replace(listGetPattern, (_match, indexSource) =>
            `TraceHooks.readObjectListAtLine(${lineNumber}, "${name}", ${name}, ${String(indexSource).trim()}, ${indexSourceArgument(indexSource)})`
          );
          nextLine = rewriteEnhancedForIterationBind(nextLine, lineNumber, currentMethod);
        }

        for (const name of currentMethod.maps) {
          const nestedMapMutationPattern = new RegExp(
            `\\b${escapeRegExp(name)}\\.get\\(([^()\\n;]+)\\)\\.(add|push)\\(([^;\\n]+)\\);`,
            'g'
          );
          nextLine = nextLine.replace(nestedMapMutationPattern, (_match, keySource, methodSource, valueSource) => {
            const keyExpression = String(keySource).trim();
            const method = String(methodSource).trim();
            const value = String(valueSource).trim();
            const target = `((java.util.Collection) (${name}).get(${keyExpression}))`;
            return `{ TraceHooks.emit("trace:{\\"kind\\":\\"read\\",\\"line\\":${lineNumber},\\"target\\":{\\"variable\\":\\"${name}\\",\\"path\\":[" + TraceHooks.serializeResult(${keyExpression}) + "]${escapedIndexSourcesTargetSegment(keyExpression)}},\\"value\\":null}"); java.util.Collection __tracecodeTarget = ${target}; __tracecodeTarget.${method}(${value}); TraceHooks.emitMutatingCallAtLine(${lineNumber}, "${name}", ${keyExpression}, "${method}", ${indexSourceArgument(keyExpression)}, ${value}); if (__tracecodeTarget instanceof java.util.List) TraceHooks.emitIndexedWriteAtLine(${lineNumber}, "${name}", new Object[] { ${keyExpression}, ((java.util.List) __tracecodeTarget).size() - 1 }, ${value}, ${indexSourceArgument(keyExpression)}, null); TraceHooks.emitRuntimeSnapshotAtLine(${lineNumber}, "${name}", ${name}); }`;
          });
          nextLine = replaceJavaReceiverCall(nextLine, name, 'containsKey', (key) =>
            `TraceHooks.containsMapKeyAtLine(${lineNumber}, "${name}", ${name}, ${key}, ${indexSourceArgument(key)})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'get', (key) =>
            `TraceHooks.readMapAtLine(${lineNumber}, "${name}", ${name}, ${key}, ${indexSourceArgument(key)})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'getOrDefault', (argsSource) => {
            const parts = splitFirstTopLevelJavaArgument(argsSource);
            if (!parts) return `${name}.getOrDefault(${argsSource})`;
            return `TraceHooks.readMapOrDefaultAtLine(${lineNumber}, "${name}", ${name}, ${parts[0]}, ${parts[1]}, ${indexSourceArgument(parts[0])})`;
          });
          nextLine = replaceJavaReceiverCall(nextLine, name, 'put', (argsSource) => {
            const parts = splitFirstTopLevelJavaArgument(argsSource);
            if (!parts) return `${name}.put(${argsSource})`;
            const keySource = indexSourceArgumentSourceFirst(parts[0]);
            return `TraceHooks.writeMapAtLine(${lineNumber}, "${name}", ${name}, ${parts[0]}, ${parts[1]}, ${keySource})`;
          });
          nextLine = replaceJavaReceiverCall(nextLine, name, 'putIfAbsent', (argsSource) => {
            const parts = splitFirstTopLevelJavaArgument(argsSource);
            if (!parts) return `${name}.putIfAbsent(${argsSource})`;
            const keySource = indexSourceArgumentSourceFirst(parts[0]);
            return `TraceHooks.putMapIfAbsentAtLine(${lineNumber}, "${name}", ${name}, ${parts[0]}, ${parts[1]}, ${keySource})`;
          });
        }

        for (const name of currentMethod.sets) {
          nextLine = replaceJavaReceiverCall(nextLine, name, 'contains', (key) =>
            `TraceHooks.readSetAtLine(${lineNumber}, "${name}", ${name}, ${key}, ${indexSourceArgument(key)})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'add', (key) =>
            `TraceHooks.addSetAtLine(${lineNumber}, "${name}", ${name}, ${key})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'remove', (key) =>
            `TraceHooks.removeSetAtLine(${lineNumber}, "${name}", ${name}, ${key}, ${indexSourceArgument(key)})`
          );
        }

        for (const name of currentMethod.lists) {
          nextLine = replaceJavaReceiverCall(nextLine, name, 'get', (indexSource) =>
            `TraceHooks.readListAtLine(${lineNumber}, "${name}", ${name}, ${indexSource}, ${indexSourceArgument(indexSource)})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'add', (valueSource) =>
            `TraceHooks.addCollectionAtLine(${lineNumber}, "${name}", ${name}, ${valueSource})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'sort', (comparatorSource) =>
            `TraceHooks.sortListAtLine(${lineNumber}, "${name}", ${name}, ${String(comparatorSource).trim() || 'null'})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'offer', (valueSource) =>
            `TraceHooks.offerQueueAtLine(${lineNumber}, "${name}", ${name}, ${valueSource})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'addLast', (valueSource) =>
            `TraceHooks.addDequeLastAtLine(${lineNumber}, "${name}", ${name}, ${valueSource})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'offerLast', (valueSource) =>
            `TraceHooks.offerDequeLastAtLine(${lineNumber}, "${name}", ${name}, ${valueSource})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'addFirst', (valueSource) =>
            `TraceHooks.addDequeFirstAtLine(${lineNumber}, "${name}", ${name}, ${valueSource})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'offerFirst', (valueSource) =>
            `TraceHooks.offerDequeFirstAtLine(${lineNumber}, "${name}", ${name}, ${valueSource})`
          );
          nextLine = replaceJavaReceiverCall(nextLine, name, 'remove', (indexSource) => {
            const rawIndexSource = String(indexSource).trim();
            if (currentMethod.queues.has(name) && rawIndexSource === '') {
              return `TraceHooks.pollQueueAtLine(${lineNumber}, "${name}", ${name})`;
            }
            if (isLastListIndexExpression(rawIndexSource, name)) {
              return `TraceHooks.popListAtLine(${lineNumber}, "${name}", ${name})`;
            }
            if (isDefinitelyListIndexExpression(rawIndexSource, name, currentMethod)) {
              return `TraceHooks.popListAtLine(${lineNumber}, "${name}", ${name}, ${indexSource})`;
            }
            return `${name}.remove(${indexSource})`;
          });
          nextLine = replaceJavaReceiverCall(nextLine, name, 'poll', (indexSource) => {
            if (currentMethod.queues.has(name) && String(indexSource).trim() === '') {
              return `TraceHooks.pollQueueAtLine(${lineNumber}, "${name}", ${name})`;
            }
            return `${name}.poll(${indexSource})`;
          });
        }

        const staleMutationPattern = /TraceHooks\.emitMutatingCallAtLine\(\d+,\s*"([A-Za-z_][A-Za-z0-9_]*)",\s*"(get|put|putIfAbsent|set|add|offer|remove)"(?:\s*,[^;]+?)?\);\s*/g;
        nextLine = nextLine.replace(staleMutationPattern, (match, name, method) => {
          if (currentMethod.maps.has(name) && (method === 'get' || method === 'put' || method === 'putIfAbsent' || method === 'set')) {
            return '';
          }
          if (currentMethod.sets.has(name) && (method === 'add'  || method === 'remove')) {
            return '';
          }
          if (currentMethod.adjacencyLists.has(name) && (method === 'add' )) {
            return '';
          }
          if (currentMethod.lists.has(name) && method === 'add') {
            return '';
          }
          if (
            currentMethod.lists.has(name) &&
            method === 'remove' &&
            nextLine.includes(`TraceHooks.popListAtLine(${lineNumber}, "${name}", ${name}`)
          ) {
            return '';
          }
          return match;
        });
        const staleInlineMutationPattern = /TraceHooks\.emit\("trace:\{\\"kind\\":\\"mutate\\",\\"line\\":\d+,\\"target\\":\{\\"variable\\":\\"([A-Za-z_][A-Za-z0-9_]*)\\"\},\\"method\\":\\"(add|offer|remove)\\"[^;]*?\);\s*/g;
        nextLine = nextLine.replace(staleInlineMutationPattern, (match, name, method) => {
          if (currentMethod.lists.has(name) && method === 'add') {
            return '';
          }
          if (
            currentMethod.lists.has(name) &&
            method === 'remove' &&
            nextLine.includes(`TraceHooks.popListAtLine(${lineNumber}, "${name}", ${name}`)
          ) {
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
    augmentJavaLocalSnapshots,
    augmentTraceCallArgumentSnapshots,
  };

  root.TraceCodeJavaSourceAugmentations = api;
  if (root.self && typeof root.self === 'object') {
    root.self.TraceCodeJavaSourceAugmentations = api;
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

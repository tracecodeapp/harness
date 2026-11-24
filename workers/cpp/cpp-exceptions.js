// C++ preprocessing tokens needed to distinguish exception keywords from
// comments, literals, identifiers, and header names. No macro expansion.
const CPP_UNIVERSAL_CHARACTER = String.raw`\\(?:u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\})|U[\da-fA-F]{8}|N\{[^{}\r\n]+\})`;
const CPP_IDENTIFIER = String.raw`(?:[$_\p{ID_Start}]|${CPP_UNIVERSAL_CHARACTER})(?:[$\p{ID_Continue}]|${CPP_UNIVERSAL_CHARACTER})*`;
const CPP_RAW_STRING_START = String.raw`(?:u8|[uUL])?R"`;
const CPP_RAW_STRING_DELIMITER = String.raw`([^ ()\\\t\v\f\r\n]{0,16})\(`;
const CPP_QUOTED_LITERAL = String.raw`(?:u8|[uUL])?(?:"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|(?=\r?$|\r))|'(?:\\[^\r\n]|[^'\\\r\n])*(?:'|(?=\r?$|\r)))`;
const CPP_NUMBER = String.raw`(?:[0-9]|\.[0-9])(?:[eEpP][+-]|'[$\p{ID_Continue}]|[.$\p{ID_Continue}])*`;
const CPP_DIRECTIVE_SPACE = String.raw`(?:[\t\v\f ]|/\*(?:[^*\r\n]|\*(?!/))*\*/)*`;
const CPP_HEADER_NAME = String.raw`^${CPP_DIRECTIVE_SPACE}(?:#|%:)${CPP_DIRECTIVE_SPACE}(?:include|include_next|import)${CPP_DIRECTIVE_SPACE}<[^>\r\n]*>`;

/**
 * Look only at the learner's written tokens. A literal keyword in a macro
 * definition (or an inactive branch) counts at that location. Expansion,
 * token pasting, and headers brought in by #include are left to the compiler.
 *
 * @param {string} source
 * @returns {{usesExceptions: false} | {usesExceptions: true, firstToken: {
 *   token: 'throw' | 'try' | 'catch', line: number, column: number
 * }}}
 */
export function classifyCppExceptionUse(source) {
  // Splicing precedes tokenization. Keep the physical offsets for diagnostics.
  const splices = [];
  let removed = 0;
  const text = source.replace(/\\[\t ]*(?:\r\n|\r|\n)/g, (splice, offset) => {
    splices.push({ offset: offset - removed, length: splice.length });
    removed += splice.length;
    return '';
  });
  const tokens = new RegExp([
    CPP_HEADER_NAME,
    String.raw`//[^\r\n]*|/\*[\s\S]*?(?:\*/|(?![\s\S]))`,
    `(${CPP_RAW_STRING_START})`,
    CPP_QUOTED_LITERAL + `(?:${CPP_IDENTIFIER})?`,
    CPP_NUMBER,
    CPP_IDENTIFIER,
  ].join('|'), 'gmu');
  const literalSuffix = new RegExp(CPP_IDENTIFIER, 'uy');
  const rawDelimiter = new RegExp(CPP_RAW_STRING_DELIMITER, 'y');
  const rawStringEnd = (input, start) => {
    rawDelimiter.lastIndex = start;
    const opening = rawDelimiter.exec(input);
    if (opening === null) return undefined;
    const marker = `)${opening[1]}"`;
    const end = input.indexOf(marker, rawDelimiter.lastIndex);
    return end === -1 ? -1 : end + marker.length;
  };
  const physicalOffset = (index) => {
    let offset = index;
    for (const splice of splices) {
      if (splice.offset > index) break;
      offset += splice.length;
    }
    return offset;
  };

  for (let match; (match = tokens.exec(text)) !== null;) {
    const [token, rawStart] = match;
    if (rawStart !== undefined) {
      // Phase 2 splices inside a raw literal are reverted. Its delimiter
      // and contents must be scanned in the original learner source.
      const end = rawStringEnd(source, physicalOffset(tokens.lastIndex - 1) + 1);
      if (end === undefined) {
        // Like Clang's recovery from a malformed, spliced opening delimiter,
        // skip the candidate literal and continue looking for later tokens.
        const recovered = rawStringEnd(text, tokens.lastIndex);
        if (recovered === undefined || recovered === -1) break;
        tokens.lastIndex = recovered;
      } else {
        if (end === -1) break;
        tokens.lastIndex = end;
        for (const splice of splices) {
          if (splice.offset >= tokens.lastIndex) break;
          tokens.lastIndex -= splice.length;
        }
      }
      literalSuffix.lastIndex = tokens.lastIndex;
      if (literalSuffix.test(text)) tokens.lastIndex = literalSuffix.lastIndex;
    } else if (token === 'throw' || token === 'try' || token === 'catch') {
      const lines = source.slice(0, physicalOffset(match.index)).split(/\r\n|\r|\n/);
      return {
        usesExceptions: true,
        firstToken: { token, line: lines.length, column: lines.at(-1).length + 1 },
      };
    }
  }
  return { usesExceptions: false };
}

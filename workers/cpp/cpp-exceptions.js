// C++ preprocessing tokens needed to distinguish exception keywords from
// comments, literals, identifiers, and header names. No macro expansion.
const CPP_UNIVERSAL_CHARACTER = String.raw`\\(?:u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\})|U[\da-fA-F]{8}|N\{[^{}\r\n]+\})`;
const CPP_IDENTIFIER = String.raw`(?:[$_\p{ID_Start}]|${CPP_UNIVERSAL_CHARACTER})(?:[$\p{ID_Continue}]|${CPP_UNIVERSAL_CHARACTER})*`;
const CPP_RAW_STRING_START = String.raw`(?:u8|[uUL])?R"([^ ()\\\t\v\f\r\n]{0,16})\(`;
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
    CPP_RAW_STRING_START,
    CPP_QUOTED_LITERAL + `(?:${CPP_IDENTIFIER})?`,
    CPP_NUMBER,
    CPP_IDENTIFIER,
  ].join('|'), 'gmu');
  const literalSuffix = new RegExp(CPP_IDENTIFIER, 'uy');
  const physicalOffset = (index) => {
    let offset = index;
    for (const splice of splices) {
      if (splice.offset > index) break;
      offset += splice.length;
    }
    return offset;
  };

  for (let match; (match = tokens.exec(text)) !== null;) {
    const [token, delimiter] = match;
    if (delimiter !== undefined) {
      const endMarker = `)${delimiter}"`;
      const firstEnd = text.indexOf(endMarker, tokens.lastIndex);
      if (firstEnd === -1) break;
      // A splice inside valid raw-string content can resemble a closer.
      // Prefer a physical closer and recover at a spliced one if necessary.
      let end = firstEnd;
      while (end !== -1 && splices.some(({ offset }) => end < offset && offset < end + endMarker.length)) {
        end = text.indexOf(endMarker, end + 1);
      }
      tokens.lastIndex = (end === -1 ? firstEnd : end) + endMarker.length;
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

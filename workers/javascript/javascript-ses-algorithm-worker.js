var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn2, res) => function __init() {
  return fn2 && (res = (0, fn2[__getOwnPropNames(fn2)[0]])(fn2 = 0)), res;
};

// node_modules/acorn/dist/acorn.mjs
function isInAstralSet(code, set) {
  var pos = 65536;
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];
    if (pos > code) {
      return false;
    }
    pos += set[i + 1];
    if (pos >= code) {
      return true;
    }
  }
  return false;
}
function isIdentifierStart(code, astral) {
  if (code < 65) {
    return code === 36;
  }
  if (code < 91) {
    return true;
  }
  if (code < 97) {
    return code === 95;
  }
  if (code < 123) {
    return true;
  }
  if (code <= 65535) {
    return code >= 170 && nonASCIIidentifierStart.test(String.fromCharCode(code));
  }
  if (astral === false) {
    return false;
  }
  return isInAstralSet(code, astralIdentifierStartCodes);
}
function isIdentifierChar(code, astral) {
  if (code < 48) {
    return code === 36;
  }
  if (code < 58) {
    return true;
  }
  if (code < 65) {
    return false;
  }
  if (code < 91) {
    return true;
  }
  if (code < 97) {
    return code === 95;
  }
  if (code < 123) {
    return true;
  }
  if (code <= 65535) {
    return code >= 170 && nonASCIIidentifier.test(String.fromCharCode(code));
  }
  if (astral === false) {
    return false;
  }
  return isInAstralSet(code, astralIdentifierStartCodes) || isInAstralSet(code, astralIdentifierCodes);
}
function binop(name, prec) {
  return new TokenType(name, { beforeExpr: true, binop: prec });
}
function kw(name, options) {
  if (options === void 0) options = {};
  options.keyword = name;
  return keywords[name] = new TokenType(name, options);
}
function isNewLine(code) {
  return code === 10 || code === 13 || code === 8232 || code === 8233;
}
function nextLineBreak(code, from, end) {
  if (end === void 0) end = code.length;
  for (var i = from; i < end; i++) {
    var next = code.charCodeAt(i);
    if (isNewLine(next)) {
      return i < end - 1 && next === 13 && code.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
    }
  }
  return -1;
}
function wordsRegexp(words) {
  return regexpCache[words] || (regexpCache[words] = new RegExp("^(?:" + words.replace(/ /g, "|") + ")$"));
}
function codePointToString(code) {
  if (code <= 65535) {
    return String.fromCharCode(code);
  }
  code -= 65536;
  return String.fromCharCode((code >> 10) + 55296, (code & 1023) + 56320);
}
function getLineInfo(input, offset2) {
  for (var line = 1, cur = 0; ; ) {
    var nextBreak = nextLineBreak(input, cur, offset2);
    if (nextBreak < 0) {
      return new Position(line, offset2 - cur);
    }
    ++line;
    cur = nextBreak;
  }
}
function getOptions(opts) {
  var options = {};
  for (var opt in defaultOptions) {
    options[opt] = opts && hasOwn2(opts, opt) ? opts[opt] : defaultOptions[opt];
  }
  if (options.ecmaVersion === "latest") {
    options.ecmaVersion = 1e8;
  } else if (options.ecmaVersion == null) {
    if (!warnedAboutEcmaVersion && typeof console === "object" && console.warn) {
      warnedAboutEcmaVersion = true;
      console.warn("Since Acorn 8.0.0, options.ecmaVersion is required.\nDefaulting to 2020, but this will stop working in the future.");
    }
    options.ecmaVersion = 11;
  } else if (options.ecmaVersion >= 2015) {
    options.ecmaVersion -= 2009;
  }
  if (options.allowReserved == null) {
    options.allowReserved = options.ecmaVersion < 5;
  }
  if (!opts || opts.allowHashBang == null) {
    options.allowHashBang = options.ecmaVersion >= 14;
  }
  if (isArray2(options.onToken)) {
    var tokens = options.onToken;
    options.onToken = function(token) {
      return tokens.push(token);
    };
  }
  if (isArray2(options.onComment)) {
    options.onComment = pushComment(options, options.onComment);
  }
  if (options.sourceType === "commonjs" && options.allowAwaitOutsideFunction) {
    throw new Error("Cannot use allowAwaitOutsideFunction with sourceType: commonjs");
  }
  return options;
}
function pushComment(options, array) {
  return function(block, text, start, end, startLoc, endLoc) {
    var comment = {
      type: block ? "Block" : "Line",
      value: text,
      start,
      end
    };
    if (options.locations) {
      comment.loc = new SourceLocation(this, startLoc, endLoc);
    }
    if (options.ranges) {
      comment.range = [start, end];
    }
    array.push(comment);
  };
}
function functionFlags(async, generator) {
  return SCOPE_FUNCTION | (async ? SCOPE_ASYNC : 0) | (generator ? SCOPE_GENERATOR : 0);
}
function isPrivateNameConflicted(privateNameMap, element) {
  var name = element.key.name;
  var curr = privateNameMap[name];
  var next = "true";
  if (element.type === "MethodDefinition" && (element.kind === "get" || element.kind === "set")) {
    next = (element.static ? "s" : "i") + element.kind;
  }
  if (curr === "iget" && next === "iset" || curr === "iset" && next === "iget" || curr === "sget" && next === "sset" || curr === "sset" && next === "sget") {
    privateNameMap[name] = "true";
    return false;
  } else if (!curr) {
    privateNameMap[name] = next;
    return false;
  } else {
    return true;
  }
}
function checkKeyName(node, name) {
  var computed = node.computed;
  var key = node.key;
  return !computed && (key.type === "Identifier" && key.name === name || key.type === "Literal" && key.value === name);
}
function isLocalVariableAccess(node) {
  return node.type === "Identifier" || node.type === "ParenthesizedExpression" && isLocalVariableAccess(node.expression);
}
function isPrivateFieldAccess(node) {
  return node.type === "MemberExpression" && node.property.type === "PrivateIdentifier" || node.type === "ChainExpression" && isPrivateFieldAccess(node.expression) || node.type === "ParenthesizedExpression" && isPrivateFieldAccess(node.expression);
}
function finishNodeAt(node, type, pos, loc) {
  node.type = type;
  node.end = pos;
  if (this.options.locations) {
    node.loc.end = loc;
  }
  if (this.options.ranges) {
    node.range[1] = pos;
  }
  return node;
}
function buildUnicodeData(ecmaVersion) {
  var d = data[ecmaVersion] = {
    binary: wordsRegexp(unicodeBinaryProperties[ecmaVersion] + " " + unicodeGeneralCategoryValues),
    binaryOfStrings: wordsRegexp(unicodeBinaryPropertiesOfStrings[ecmaVersion]),
    nonBinary: {
      General_Category: wordsRegexp(unicodeGeneralCategoryValues),
      Script: wordsRegexp(unicodeScriptValues[ecmaVersion])
    }
  };
  d.nonBinary.Script_Extensions = d.nonBinary.Script;
  d.nonBinary.gc = d.nonBinary.General_Category;
  d.nonBinary.sc = d.nonBinary.Script;
  d.nonBinary.scx = d.nonBinary.Script_Extensions;
}
function hasProp(obj) {
  for (var _ in obj) {
    return true;
  }
  return false;
}
function isRegularExpressionModifier(ch) {
  return ch === 105 || ch === 109 || ch === 115;
}
function isSyntaxCharacter(ch) {
  return ch === 36 || ch >= 40 && ch <= 43 || ch === 46 || ch === 63 || ch >= 91 && ch <= 94 || ch >= 123 && ch <= 125;
}
function isRegExpIdentifierStart(ch) {
  return isIdentifierStart(ch, true) || ch === 36 || ch === 95;
}
function isRegExpIdentifierPart(ch) {
  return isIdentifierChar(ch, true) || ch === 36 || ch === 95 || ch === 8204 || ch === 8205;
}
function isControlLetter(ch) {
  return ch >= 65 && ch <= 90 || ch >= 97 && ch <= 122;
}
function isValidUnicode(ch) {
  return ch >= 0 && ch <= 1114111;
}
function isCharacterClassEscape(ch) {
  return ch === 100 || ch === 68 || ch === 115 || ch === 83 || ch === 119 || ch === 87;
}
function isUnicodePropertyNameCharacter(ch) {
  return isControlLetter(ch) || ch === 95;
}
function isUnicodePropertyValueCharacter(ch) {
  return isUnicodePropertyNameCharacter(ch) || isDecimalDigit(ch);
}
function isClassSetReservedDoublePunctuatorCharacter(ch) {
  return ch === 33 || ch >= 35 && ch <= 38 || ch >= 42 && ch <= 44 || ch === 46 || ch >= 58 && ch <= 64 || ch === 94 || ch === 96 || ch === 126;
}
function isClassSetSyntaxCharacter(ch) {
  return ch === 40 || ch === 41 || ch === 45 || ch === 47 || ch >= 91 && ch <= 93 || ch >= 123 && ch <= 125;
}
function isClassSetReservedPunctuator(ch) {
  return ch === 33 || ch === 35 || ch === 37 || ch === 38 || ch === 44 || ch === 45 || ch >= 58 && ch <= 62 || ch === 64 || ch === 96 || ch === 126;
}
function isDecimalDigit(ch) {
  return ch >= 48 && ch <= 57;
}
function isHexDigit(ch) {
  return ch >= 48 && ch <= 57 || ch >= 65 && ch <= 70 || ch >= 97 && ch <= 102;
}
function hexToInt(ch) {
  if (ch >= 65 && ch <= 70) {
    return 10 + (ch - 65);
  }
  if (ch >= 97 && ch <= 102) {
    return 10 + (ch - 97);
  }
  return ch - 48;
}
function isOctalDigit(ch) {
  return ch >= 48 && ch <= 55;
}
function stringToNumber(str, isLegacyOctalNumericLiteral) {
  if (isLegacyOctalNumericLiteral) {
    return parseInt(str, 8);
  }
  return parseFloat(str.replace(/_/g, ""));
}
function stringToBigInt(str) {
  if (typeof BigInt !== "function") {
    return null;
  }
  return BigInt(str.replace(/_/g, ""));
}
function parse4(input, options) {
  return Parser.parse(input, options);
}
var astralIdentifierCodes, astralIdentifierStartCodes, nonASCIIidentifierChars, nonASCIIidentifierStartChars, reservedWords, ecma5AndLessKeywords, keywords$1, keywordRelationalOperator, nonASCIIidentifierStart, nonASCIIidentifier, TokenType, beforeExpr, startsExpr, keywords, types$1, lineBreak, lineBreakG, nonASCIIwhitespace, skipWhiteSpace, ref, hasOwnProperty, toString, hasOwn2, isArray2, regexpCache, loneSurrogate, Position, SourceLocation, defaultOptions, warnedAboutEcmaVersion, SCOPE_TOP, SCOPE_FUNCTION, SCOPE_ASYNC, SCOPE_GENERATOR, SCOPE_ARROW, SCOPE_SIMPLE_CATCH, SCOPE_SUPER, SCOPE_DIRECT_SUPER, SCOPE_CLASS_STATIC_BLOCK, SCOPE_CLASS_FIELD_INIT, SCOPE_SWITCH, SCOPE_VAR, BIND_NONE, BIND_VAR, BIND_LEXICAL, BIND_FUNCTION, BIND_SIMPLE_CATCH, BIND_OUTSIDE, Parser, prototypeAccessors, pp$9, literal, DestructuringErrors, pp$8, loopLabel, switchLabel, empty$1, FUNC_STATEMENT, FUNC_HANGING_STATEMENT, FUNC_NULLABLE_ID, pp$7, TokContext, types, pp$6, pp$5, empty, pp$4, pp$3, Scope, Node, pp$2, scriptValuesAddedInUnicode, ecma9BinaryProperties, ecma10BinaryProperties, ecma11BinaryProperties, ecma12BinaryProperties, ecma13BinaryProperties, ecma14BinaryProperties, unicodeBinaryProperties, ecma14BinaryPropertiesOfStrings, unicodeBinaryPropertiesOfStrings, unicodeGeneralCategoryValues, ecma9ScriptValues, ecma10ScriptValues, ecma11ScriptValues, ecma12ScriptValues, ecma13ScriptValues, ecma14ScriptValues, unicodeScriptValues, data, ecmaVersion, i, list, pp$1, BranchID, RegExpValidationState, CharSetNone, CharSetOk, CharSetString, Token, pp, INVALID_TEMPLATE_ESCAPE_ERROR, version;
var init_acorn = __esm({
  "node_modules/acorn/dist/acorn.mjs"() {
    astralIdentifierCodes = [509, 0, 227, 0, 150, 4, 294, 9, 1368, 2, 2, 1, 6, 3, 41, 2, 5, 0, 166, 1, 574, 3, 9, 9, 7, 9, 32, 4, 318, 1, 78, 5, 71, 10, 50, 3, 123, 2, 54, 14, 32, 10, 3, 1, 11, 3, 46, 10, 8, 0, 46, 9, 7, 2, 37, 13, 2, 9, 6, 1, 45, 0, 13, 2, 49, 13, 9, 3, 2, 11, 83, 11, 7, 0, 3, 0, 158, 11, 6, 9, 7, 3, 56, 1, 2, 6, 3, 1, 3, 2, 10, 0, 11, 1, 3, 6, 4, 4, 68, 8, 2, 0, 3, 0, 2, 3, 2, 4, 2, 0, 15, 1, 83, 17, 10, 9, 5, 0, 82, 19, 13, 9, 214, 6, 3, 8, 28, 1, 83, 16, 16, 9, 82, 12, 9, 9, 7, 19, 58, 14, 5, 9, 243, 14, 166, 9, 71, 5, 2, 1, 3, 3, 2, 0, 2, 1, 13, 9, 120, 6, 3, 6, 4, 0, 29, 9, 41, 6, 2, 3, 9, 0, 10, 10, 47, 15, 199, 7, 137, 9, 54, 7, 2, 7, 17, 9, 57, 21, 2, 13, 123, 5, 4, 0, 2, 1, 2, 6, 2, 0, 9, 9, 49, 4, 2, 1, 2, 4, 9, 9, 55, 9, 266, 3, 10, 1, 2, 0, 49, 6, 4, 4, 14, 10, 5350, 0, 7, 14, 11465, 27, 2343, 9, 87, 9, 39, 4, 60, 6, 26, 9, 535, 9, 470, 0, 2, 54, 8, 3, 82, 0, 12, 1, 19628, 1, 4178, 9, 519, 45, 3, 22, 543, 4, 4, 5, 9, 7, 3, 6, 31, 3, 149, 2, 1418, 49, 513, 54, 5, 49, 9, 0, 15, 0, 23, 4, 2, 14, 1361, 6, 2, 16, 3, 6, 2, 1, 2, 4, 101, 0, 161, 6, 10, 9, 357, 0, 62, 13, 499, 13, 245, 1, 2, 9, 233, 0, 3, 0, 8, 1, 6, 0, 475, 6, 110, 6, 6, 9, 4759, 9, 787719, 239];
    astralIdentifierStartCodes = [0, 11, 2, 25, 2, 18, 2, 1, 2, 14, 3, 13, 35, 122, 70, 52, 268, 28, 4, 48, 48, 31, 14, 29, 6, 37, 11, 29, 3, 35, 5, 7, 2, 4, 43, 157, 19, 35, 5, 35, 5, 39, 9, 51, 13, 10, 2, 14, 2, 6, 2, 1, 2, 10, 2, 14, 2, 6, 2, 1, 4, 51, 13, 310, 10, 21, 11, 7, 25, 5, 2, 41, 2, 8, 70, 5, 3, 0, 2, 43, 2, 1, 4, 0, 3, 22, 11, 22, 10, 30, 66, 18, 2, 1, 11, 21, 11, 25, 7, 25, 39, 55, 7, 1, 65, 0, 16, 3, 2, 2, 2, 28, 43, 28, 4, 28, 36, 7, 2, 27, 28, 53, 11, 21, 11, 18, 14, 17, 111, 72, 56, 50, 14, 50, 14, 35, 39, 27, 10, 22, 251, 41, 7, 1, 17, 5, 57, 28, 11, 0, 9, 21, 43, 17, 47, 20, 28, 22, 13, 52, 58, 1, 3, 0, 14, 44, 33, 24, 27, 35, 30, 0, 3, 0, 9, 34, 4, 0, 13, 47, 15, 3, 22, 0, 2, 0, 36, 17, 2, 24, 20, 1, 64, 6, 2, 0, 2, 3, 2, 14, 2, 9, 8, 46, 39, 7, 3, 1, 3, 21, 2, 6, 2, 1, 2, 4, 4, 0, 19, 0, 13, 4, 31, 9, 2, 0, 3, 0, 2, 37, 2, 0, 26, 0, 2, 0, 45, 52, 19, 3, 21, 2, 31, 47, 21, 1, 2, 0, 185, 46, 42, 3, 37, 47, 21, 0, 60, 42, 14, 0, 72, 26, 38, 6, 186, 43, 117, 63, 32, 7, 3, 0, 3, 7, 2, 1, 2, 23, 16, 0, 2, 0, 95, 7, 3, 38, 17, 0, 2, 0, 29, 0, 11, 39, 8, 0, 22, 0, 12, 45, 20, 0, 19, 72, 200, 32, 32, 8, 2, 36, 18, 0, 50, 29, 113, 6, 2, 1, 2, 37, 22, 0, 26, 5, 2, 1, 2, 31, 15, 0, 24, 43, 261, 18, 16, 0, 2, 12, 2, 33, 125, 0, 80, 921, 103, 110, 18, 195, 2637, 96, 16, 1071, 18, 5, 26, 3994, 6, 582, 6842, 29, 1763, 568, 8, 30, 18, 78, 18, 29, 19, 47, 17, 3, 32, 20, 6, 18, 433, 44, 212, 63, 33, 24, 3, 24, 45, 74, 6, 0, 67, 12, 65, 1, 2, 0, 15, 4, 10, 7381, 42, 31, 98, 114, 8702, 3, 2, 6, 2, 1, 2, 290, 16, 0, 30, 2, 3, 0, 15, 3, 9, 395, 2309, 106, 6, 12, 4, 8, 8, 9, 5991, 84, 2, 70, 2, 1, 3, 0, 3, 1, 3, 3, 2, 11, 2, 0, 2, 6, 2, 64, 2, 3, 3, 7, 2, 6, 2, 27, 2, 3, 2, 4, 2, 0, 4, 6, 2, 339, 3, 24, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 7, 1845, 30, 7, 5, 262, 61, 147, 44, 11, 6, 17, 0, 322, 29, 19, 43, 485, 27, 229, 29, 3, 0, 208, 30, 2, 2, 2, 1, 2, 6, 3, 4, 10, 1, 225, 6, 2, 3, 2, 1, 2, 14, 2, 196, 60, 67, 8, 0, 1205, 3, 2, 26, 2, 1, 2, 0, 3, 0, 2, 9, 2, 3, 2, 0, 2, 0, 7, 0, 5, 0, 2, 0, 2, 0, 2, 2, 2, 1, 2, 0, 3, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 1, 2, 0, 3, 3, 2, 6, 2, 3, 2, 3, 2, 0, 2, 9, 2, 16, 6, 2, 2, 4, 2, 16, 4421, 42719, 33, 4381, 3, 5773, 3, 7472, 16, 621, 2467, 541, 1507, 4938, 6, 8489];
    nonASCIIidentifierChars = "\u200C\u200D\xB7\u0300-\u036F\u0387\u0483-\u0487\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u0669\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u06F0-\u06F9\u0711\u0730-\u074A\u07A6-\u07B0\u07C0-\u07C9\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u0897-\u089F\u08CA-\u08E1\u08E3-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962\u0963\u0966-\u096F\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7\u09C8\u09CB-\u09CD\u09D7\u09E2\u09E3\u09E6-\u09EF\u09FE\u0A01-\u0A03\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A66-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2\u0AE3\u0AE6-\u0AEF\u0AFA-\u0AFF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B55-\u0B57\u0B62\u0B63\u0B66-\u0B6F\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0BE6-\u0BEF\u0C00-\u0C04\u0C3C\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CE2\u0CE3\u0CE6-\u0CEF\u0CF3\u0D00-\u0D03\u0D3B\u0D3C\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62\u0D63\u0D66-\u0D6F\u0D81-\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0E50-\u0E59\u0EB1\u0EB4-\u0EBC\u0EC8-\u0ECE\u0ED0-\u0ED9\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E\u0F3F\u0F71-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1040-\u1049\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F-\u109D\u135D-\u135F\u1369-\u1371\u1712-\u1715\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4-\u17D3\u17DD\u17E0-\u17E9\u180B-\u180D\u180F-\u1819\u18A9\u1920-\u192B\u1930-\u193B\u1946-\u194F\u19D0-\u19DA\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AB0-\u1ABD\u1ABF-\u1ADD\u1AE0-\u1AEB\u1B00-\u1B04\u1B34-\u1B44\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD\u1BB0-\u1BB9\u1BE6-\u1BF3\u1C24-\u1C37\u1C40-\u1C49\u1C50-\u1C59\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF4\u1CF7-\u1CF9\u1DC0-\u1DFF\u200C\u200D\u203F\u2040\u2054\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099\u309A\u30FB\uA620-\uA629\uA66F\uA674-\uA67D\uA69E\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA82C\uA880\uA881\uA8B4-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F1\uA8FF-\uA909\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9D0-\uA9D9\uA9E5\uA9F0-\uA9F9\uAA29-\uAA36\uAA43\uAA4C\uAA4D\uAA50-\uAA59\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5\uAAF6\uABE3-\uABEA\uABEC\uABED\uABF0-\uABF9\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFF10-\uFF19\uFF3F\uFF65";
    nonASCIIidentifierStartChars = "\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u05D0-\u05EA\u05EF-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u0870-\u0887\u0889-\u088F\u08A0-\u08C9\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C5C\u0C5D\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDC-\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D04-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E86-\u0E8A\u0E8C-\u0EA3\u0EA5\u0EA7-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u1711\u171F-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1878\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4C\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C8A\u1C90-\u1CBA\u1CBD-\u1CBF\u1CE9-\u1CEC\u1CEE-\u1CF3\u1CF5\u1CF6\u1CFA\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309B-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7DC\uA7F1-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA8FE\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB69\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC";
    reservedWords = {
      3: "abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile",
      5: "class enum extends super const export import",
      6: "enum",
      strict: "implements interface let package private protected public static yield",
      strictBind: "eval arguments"
    };
    ecma5AndLessKeywords = "break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";
    keywords$1 = {
      5: ecma5AndLessKeywords,
      "5module": ecma5AndLessKeywords + " export import",
      6: ecma5AndLessKeywords + " const class extends export import super"
    };
    keywordRelationalOperator = /^in(stanceof)?$/;
    nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
    nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");
    TokenType = function TokenType2(label, conf) {
      if (conf === void 0) conf = {};
      this.label = label;
      this.keyword = conf.keyword;
      this.beforeExpr = !!conf.beforeExpr;
      this.startsExpr = !!conf.startsExpr;
      this.isLoop = !!conf.isLoop;
      this.isAssign = !!conf.isAssign;
      this.prefix = !!conf.prefix;
      this.postfix = !!conf.postfix;
      this.binop = conf.binop || null;
      this.updateContext = null;
    };
    beforeExpr = { beforeExpr: true };
    startsExpr = { startsExpr: true };
    keywords = {};
    types$1 = {
      num: new TokenType("num", startsExpr),
      regexp: new TokenType("regexp", startsExpr),
      string: new TokenType("string", startsExpr),
      name: new TokenType("name", startsExpr),
      privateId: new TokenType("privateId", startsExpr),
      eof: new TokenType("eof"),
      // Punctuation token types.
      bracketL: new TokenType("[", { beforeExpr: true, startsExpr: true }),
      bracketR: new TokenType("]"),
      braceL: new TokenType("{", { beforeExpr: true, startsExpr: true }),
      braceR: new TokenType("}"),
      parenL: new TokenType("(", { beforeExpr: true, startsExpr: true }),
      parenR: new TokenType(")"),
      comma: new TokenType(",", beforeExpr),
      semi: new TokenType(";", beforeExpr),
      colon: new TokenType(":", beforeExpr),
      dot: new TokenType("."),
      question: new TokenType("?", beforeExpr),
      questionDot: new TokenType("?."),
      arrow: new TokenType("=>", beforeExpr),
      template: new TokenType("template"),
      invalidTemplate: new TokenType("invalidTemplate"),
      ellipsis: new TokenType("...", beforeExpr),
      backQuote: new TokenType("`", startsExpr),
      dollarBraceL: new TokenType("${", { beforeExpr: true, startsExpr: true }),
      // Operators. These carry several kinds of properties to help the
      // parser use them properly (the presence of these properties is
      // what categorizes them as operators).
      //
      // `binop`, when present, specifies that this operator is a binary
      // operator, and will refer to its precedence.
      //
      // `prefix` and `postfix` mark the operator as a prefix or postfix
      // unary operator.
      //
      // `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
      // binary operators with a very low precedence, that should result
      // in AssignmentExpression nodes.
      eq: new TokenType("=", { beforeExpr: true, isAssign: true }),
      assign: new TokenType("_=", { beforeExpr: true, isAssign: true }),
      incDec: new TokenType("++/--", { prefix: true, postfix: true, startsExpr: true }),
      prefix: new TokenType("!/~", { beforeExpr: true, prefix: true, startsExpr: true }),
      logicalOR: binop("||", 1),
      logicalAND: binop("&&", 2),
      bitwiseOR: binop("|", 3),
      bitwiseXOR: binop("^", 4),
      bitwiseAND: binop("&", 5),
      equality: binop("==/!=/===/!==", 6),
      relational: binop("</>/<=/>=", 7),
      bitShift: binop("<</>>/>>>", 8),
      plusMin: new TokenType("+/-", { beforeExpr: true, binop: 9, prefix: true, startsExpr: true }),
      modulo: binop("%", 10),
      star: binop("*", 10),
      slash: binop("/", 10),
      starstar: new TokenType("**", { beforeExpr: true }),
      coalesce: binop("??", 1),
      // Keyword token types.
      _break: kw("break"),
      _case: kw("case", beforeExpr),
      _catch: kw("catch"),
      _continue: kw("continue"),
      _debugger: kw("debugger"),
      _default: kw("default", beforeExpr),
      _do: kw("do", { isLoop: true, beforeExpr: true }),
      _else: kw("else", beforeExpr),
      _finally: kw("finally"),
      _for: kw("for", { isLoop: true }),
      _function: kw("function", startsExpr),
      _if: kw("if"),
      _return: kw("return", beforeExpr),
      _switch: kw("switch"),
      _throw: kw("throw", beforeExpr),
      _try: kw("try"),
      _var: kw("var"),
      _const: kw("const"),
      _while: kw("while", { isLoop: true }),
      _with: kw("with"),
      _new: kw("new", { beforeExpr: true, startsExpr: true }),
      _this: kw("this", startsExpr),
      _super: kw("super", startsExpr),
      _class: kw("class", startsExpr),
      _extends: kw("extends", beforeExpr),
      _export: kw("export"),
      _import: kw("import", startsExpr),
      _null: kw("null", startsExpr),
      _true: kw("true", startsExpr),
      _false: kw("false", startsExpr),
      _in: kw("in", { beforeExpr: true, binop: 7 }),
      _instanceof: kw("instanceof", { beforeExpr: true, binop: 7 }),
      _typeof: kw("typeof", { beforeExpr: true, prefix: true, startsExpr: true }),
      _void: kw("void", { beforeExpr: true, prefix: true, startsExpr: true }),
      _delete: kw("delete", { beforeExpr: true, prefix: true, startsExpr: true })
    };
    lineBreak = /\r\n?|\n|\u2028|\u2029/;
    lineBreakG = new RegExp(lineBreak.source, "g");
    nonASCIIwhitespace = /[\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
    skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g;
    ref = Object.prototype;
    hasOwnProperty = ref.hasOwnProperty;
    toString = ref.toString;
    hasOwn2 = Object.hasOwn || (function(obj, propName) {
      return hasOwnProperty.call(obj, propName);
    });
    isArray2 = Array.isArray || (function(obj) {
      return toString.call(obj) === "[object Array]";
    });
    regexpCache = /* @__PURE__ */ Object.create(null);
    loneSurrogate = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])/;
    Position = function Position2(line, col) {
      this.line = line;
      this.column = col;
    };
    Position.prototype.offset = function offset(n) {
      return new Position(this.line, this.column + n);
    };
    SourceLocation = function SourceLocation2(p, start, end) {
      this.start = start;
      this.end = end;
      if (p.sourceFile !== null) {
        this.source = p.sourceFile;
      }
    };
    defaultOptions = {
      // `ecmaVersion` indicates the ECMAScript version to parse. Must be
      // either 3, 5, 6 (or 2015), 7 (2016), 8 (2017), 9 (2018), 10
      // (2019), 11 (2020), 12 (2021), 13 (2022), 14 (2023), or `"latest"`
      // (the latest version the library supports). This influences
      // support for strict mode, the set of reserved words, and support
      // for new syntax features.
      ecmaVersion: null,
      // `sourceType` indicates the mode the code should be parsed in.
      // Can be either `"script"`, `"module"` or `"commonjs"`. This influences global
      // strict mode and parsing of `import` and `export` declarations.
      sourceType: "script",
      // `onInsertedSemicolon` can be a callback that will be called when
      // a semicolon is automatically inserted. It will be passed the
      // position of the inserted semicolon as an offset, and if
      // `locations` is enabled, it is given the location as a `{line,
      // column}` object as second argument.
      onInsertedSemicolon: null,
      // `onTrailingComma` is similar to `onInsertedSemicolon`, but for
      // trailing commas.
      onTrailingComma: null,
      // By default, reserved words are only enforced if ecmaVersion >= 5.
      // Set `allowReserved` to a boolean value to explicitly turn this on
      // an off. When this option has the value "never", reserved words
      // and keywords can also not be used as property names.
      allowReserved: null,
      // When enabled, a return at the top level is not considered an
      // error.
      allowReturnOutsideFunction: false,
      // When enabled, import/export statements are not constrained to
      // appearing at the top of the program, and an import.meta expression
      // in a script isn't considered an error.
      allowImportExportEverywhere: false,
      // By default, await identifiers are allowed to appear at the top-level scope only if ecmaVersion >= 2022.
      // When enabled, await identifiers are allowed to appear at the top-level scope,
      // but they are still not allowed in non-async functions.
      allowAwaitOutsideFunction: null,
      // When enabled, super identifiers are not constrained to
      // appearing in methods and do not raise an error when they appear elsewhere.
      allowSuperOutsideMethod: null,
      // When enabled, hashbang directive in the beginning of file is
      // allowed and treated as a line comment. Enabled by default when
      // `ecmaVersion` >= 2023.
      allowHashBang: false,
      // By default, the parser will verify that private properties are
      // only used in places where they are valid and have been declared.
      // Set this to false to turn such checks off.
      checkPrivateFields: true,
      // When `locations` is on, `loc` properties holding objects with
      // `start` and `end` properties in `{line, column}` form (with
      // line being 1-based and column 0-based) will be attached to the
      // nodes.
      locations: false,
      // A function can be passed as `onToken` option, which will
      // cause Acorn to call that function with object in the same
      // format as tokens returned from `tokenizer().getToken()`. Note
      // that you are not allowed to call the parser from the
      // callback—that will corrupt its internal state.
      onToken: null,
      // A function can be passed as `onComment` option, which will
      // cause Acorn to call that function with `(block, text, start,
      // end)` parameters whenever a comment is skipped. `block` is a
      // boolean indicating whether this is a block (`/* */`) comment,
      // `text` is the content of the comment, and `start` and `end` are
      // character offsets that denote the start and end of the comment.
      // When the `locations` option is on, two more parameters are
      // passed, the full `{line, column}` locations of the start and
      // end of the comments. Note that you are not allowed to call the
      // parser from the callback—that will corrupt its internal state.
      // When this option has an array as value, objects representing the
      // comments are pushed to it.
      onComment: null,
      // Nodes have their start and end characters offsets recorded in
      // `start` and `end` properties (directly on the node, rather than
      // the `loc` object, which holds line/column data. To also add a
      // [semi-standardized][range] `range` property holding a `[start,
      // end]` array with the same numbers, set the `ranges` option to
      // `true`.
      //
      // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
      ranges: false,
      // It is possible to parse multiple files into a single AST by
      // passing the tree produced by parsing the first file as
      // `program` option in subsequent parses. This will add the
      // toplevel forms of the parsed file to the `Program` (top) node
      // of an existing parse tree.
      program: null,
      // When `locations` is on, you can pass this to record the source
      // file in every node's `loc` object.
      sourceFile: null,
      // This value, if given, is stored in every node, whether
      // `locations` is on or off.
      directSourceFile: null,
      // When enabled, parenthesized expressions are represented by
      // (non-standard) ParenthesizedExpression nodes
      preserveParens: false
    };
    warnedAboutEcmaVersion = false;
    SCOPE_TOP = 1;
    SCOPE_FUNCTION = 2;
    SCOPE_ASYNC = 4;
    SCOPE_GENERATOR = 8;
    SCOPE_ARROW = 16;
    SCOPE_SIMPLE_CATCH = 32;
    SCOPE_SUPER = 64;
    SCOPE_DIRECT_SUPER = 128;
    SCOPE_CLASS_STATIC_BLOCK = 256;
    SCOPE_CLASS_FIELD_INIT = 512;
    SCOPE_SWITCH = 1024;
    SCOPE_VAR = SCOPE_TOP | SCOPE_FUNCTION | SCOPE_CLASS_STATIC_BLOCK;
    BIND_NONE = 0;
    BIND_VAR = 1;
    BIND_LEXICAL = 2;
    BIND_FUNCTION = 3;
    BIND_SIMPLE_CATCH = 4;
    BIND_OUTSIDE = 5;
    Parser = function Parser2(options, input, startPos) {
      this.options = options = getOptions(options);
      this.sourceFile = options.sourceFile;
      this.keywords = wordsRegexp(keywords$1[options.ecmaVersion >= 6 ? 6 : options.sourceType === "module" ? "5module" : 5]);
      var reserved = "";
      if (options.allowReserved !== true) {
        reserved = reservedWords[options.ecmaVersion >= 6 ? 6 : options.ecmaVersion === 5 ? 5 : 3];
        if (options.sourceType === "module") {
          reserved += " await";
        }
      }
      this.reservedWords = wordsRegexp(reserved);
      var reservedStrict = (reserved ? reserved + " " : "") + reservedWords.strict;
      this.reservedWordsStrict = wordsRegexp(reservedStrict);
      this.reservedWordsStrictBind = wordsRegexp(reservedStrict + " " + reservedWords.strictBind);
      this.input = String(input);
      this.containsEsc = false;
      if (startPos) {
        this.pos = startPos;
        this.lineStart = this.input.lastIndexOf("\n", startPos - 1) + 1;
        this.curLine = this.input.slice(0, this.lineStart).split(lineBreak).length;
      } else {
        this.pos = this.lineStart = 0;
        this.curLine = 1;
      }
      this.type = types$1.eof;
      this.value = null;
      this.start = this.end = this.pos;
      this.startLoc = this.endLoc = this.curPosition();
      this.lastTokEndLoc = this.lastTokStartLoc = null;
      this.lastTokStart = this.lastTokEnd = this.pos;
      this.context = this.initialContext();
      this.exprAllowed = true;
      this.inModule = options.sourceType === "module";
      this.strict = this.inModule || this.strictDirective(this.pos);
      this.potentialArrowAt = -1;
      this.potentialArrowInForAwait = false;
      this.yieldPos = this.awaitPos = this.awaitIdentPos = 0;
      this.labels = [];
      this.undefinedExports = /* @__PURE__ */ Object.create(null);
      if (this.pos === 0 && options.allowHashBang && this.input.slice(0, 2) === "#!") {
        this.skipLineComment(2);
      }
      this.scopeStack = [];
      this.enterScope(
        this.options.sourceType === "commonjs" ? SCOPE_FUNCTION : SCOPE_TOP
      );
      this.regexpState = null;
      this.privateNameStack = [];
    };
    prototypeAccessors = { inFunction: { configurable: true }, inGenerator: { configurable: true }, inAsync: { configurable: true }, canAwait: { configurable: true }, allowReturn: { configurable: true }, allowSuper: { configurable: true }, allowDirectSuper: { configurable: true }, treatFunctionsAsVar: { configurable: true }, allowNewDotTarget: { configurable: true }, allowUsing: { configurable: true }, inClassStaticBlock: { configurable: true } };
    Parser.prototype.parse = function parse2() {
      var node = this.options.program || this.startNode();
      this.nextToken();
      return this.parseTopLevel(node);
    };
    prototypeAccessors.inFunction.get = function() {
      return (this.currentVarScope().flags & SCOPE_FUNCTION) > 0;
    };
    prototypeAccessors.inGenerator.get = function() {
      return (this.currentVarScope().flags & SCOPE_GENERATOR) > 0;
    };
    prototypeAccessors.inAsync.get = function() {
      return (this.currentVarScope().flags & SCOPE_ASYNC) > 0;
    };
    prototypeAccessors.canAwait.get = function() {
      for (var i = this.scopeStack.length - 1; i >= 0; i--) {
        var ref2 = this.scopeStack[i];
        var flags = ref2.flags;
        if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT)) {
          return false;
        }
        if (flags & SCOPE_FUNCTION) {
          return (flags & SCOPE_ASYNC) > 0;
        }
      }
      return this.inModule && this.options.ecmaVersion >= 13 || this.options.allowAwaitOutsideFunction;
    };
    prototypeAccessors.allowReturn.get = function() {
      if (this.inFunction) {
        return true;
      }
      if (this.options.allowReturnOutsideFunction && this.currentVarScope().flags & SCOPE_TOP) {
        return true;
      }
      return false;
    };
    prototypeAccessors.allowSuper.get = function() {
      var ref2 = this.currentThisScope();
      var flags = ref2.flags;
      return (flags & SCOPE_SUPER) > 0 || this.options.allowSuperOutsideMethod;
    };
    prototypeAccessors.allowDirectSuper.get = function() {
      return (this.currentThisScope().flags & SCOPE_DIRECT_SUPER) > 0;
    };
    prototypeAccessors.treatFunctionsAsVar.get = function() {
      return this.treatFunctionsAsVarInScope(this.currentScope());
    };
    prototypeAccessors.allowNewDotTarget.get = function() {
      for (var i = this.scopeStack.length - 1; i >= 0; i--) {
        var ref2 = this.scopeStack[i];
        var flags = ref2.flags;
        if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT) || flags & SCOPE_FUNCTION && !(flags & SCOPE_ARROW)) {
          return true;
        }
      }
      return false;
    };
    prototypeAccessors.allowUsing.get = function() {
      var ref2 = this.currentScope();
      var flags = ref2.flags;
      if (flags & SCOPE_SWITCH) {
        return false;
      }
      if (!this.inModule && flags & SCOPE_TOP) {
        return false;
      }
      return true;
    };
    prototypeAccessors.inClassStaticBlock.get = function() {
      return (this.currentVarScope().flags & SCOPE_CLASS_STATIC_BLOCK) > 0;
    };
    Parser.extend = function extend() {
      var plugins = [], len = arguments.length;
      while (len--) plugins[len] = arguments[len];
      var cls = this;
      for (var i = 0; i < plugins.length; i++) {
        cls = plugins[i](cls);
      }
      return cls;
    };
    Parser.parse = function parse3(input, options) {
      return new this(options, input).parse();
    };
    Parser.parseExpressionAt = function parseExpressionAt(input, pos, options) {
      var parser = new this(options, input, pos);
      parser.nextToken();
      return parser.parseExpression();
    };
    Parser.tokenizer = function tokenizer(input, options) {
      return new this(options, input);
    };
    Object.defineProperties(Parser.prototype, prototypeAccessors);
    pp$9 = Parser.prototype;
    literal = /^(?:'((?:\\[^]|[^'\\])*?)'|"((?:\\[^]|[^"\\])*?)")/;
    pp$9.strictDirective = function(start) {
      if (this.options.ecmaVersion < 5) {
        return false;
      }
      for (; ; ) {
        skipWhiteSpace.lastIndex = start;
        start += skipWhiteSpace.exec(this.input)[0].length;
        var match = literal.exec(this.input.slice(start));
        if (!match) {
          return false;
        }
        if ((match[1] || match[2]) === "use strict") {
          skipWhiteSpace.lastIndex = start + match[0].length;
          var spaceAfter = skipWhiteSpace.exec(this.input), end = spaceAfter.index + spaceAfter[0].length;
          var next = this.input.charAt(end);
          return next === ";" || next === "}" || lineBreak.test(spaceAfter[0]) && !(/[(`.[+\-/*%<>=,?^&]/.test(next) || next === "!" && this.input.charAt(end + 1) === "=");
        }
        start += match[0].length;
        skipWhiteSpace.lastIndex = start;
        start += skipWhiteSpace.exec(this.input)[0].length;
        if (this.input[start] === ";") {
          start++;
        }
      }
    };
    pp$9.eat = function(type) {
      if (this.type === type) {
        this.next();
        return true;
      } else {
        return false;
      }
    };
    pp$9.isContextual = function(name) {
      return this.type === types$1.name && this.value === name && !this.containsEsc;
    };
    pp$9.eatContextual = function(name) {
      if (!this.isContextual(name)) {
        return false;
      }
      this.next();
      return true;
    };
    pp$9.expectContextual = function(name) {
      if (!this.eatContextual(name)) {
        this.unexpected();
      }
    };
    pp$9.canInsertSemicolon = function() {
      return this.type === types$1.eof || this.type === types$1.braceR || lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
    };
    pp$9.insertSemicolon = function() {
      if (this.canInsertSemicolon()) {
        if (this.options.onInsertedSemicolon) {
          this.options.onInsertedSemicolon(this.lastTokEnd, this.lastTokEndLoc);
        }
        return true;
      }
    };
    pp$9.semicolon = function() {
      if (!this.eat(types$1.semi) && !this.insertSemicolon()) {
        this.unexpected();
      }
    };
    pp$9.afterTrailingComma = function(tokType, notNext) {
      if (this.type === tokType) {
        if (this.options.onTrailingComma) {
          this.options.onTrailingComma(this.lastTokStart, this.lastTokStartLoc);
        }
        if (!notNext) {
          this.next();
        }
        return true;
      }
    };
    pp$9.expect = function(type) {
      this.eat(type) || this.unexpected();
    };
    pp$9.unexpected = function(pos) {
      this.raise(pos != null ? pos : this.start, "Unexpected token");
    };
    DestructuringErrors = function DestructuringErrors2() {
      this.shorthandAssign = this.trailingComma = this.parenthesizedAssign = this.parenthesizedBind = this.doubleProto = -1;
    };
    pp$9.checkPatternErrors = function(refDestructuringErrors, isAssign) {
      if (!refDestructuringErrors) {
        return;
      }
      if (refDestructuringErrors.trailingComma > -1) {
        this.raiseRecoverable(refDestructuringErrors.trailingComma, "Comma is not permitted after the rest element");
      }
      var parens = isAssign ? refDestructuringErrors.parenthesizedAssign : refDestructuringErrors.parenthesizedBind;
      if (parens > -1) {
        this.raiseRecoverable(parens, isAssign ? "Assigning to rvalue" : "Parenthesized pattern");
      }
    };
    pp$9.checkExpressionErrors = function(refDestructuringErrors, andThrow) {
      if (!refDestructuringErrors) {
        return false;
      }
      var shorthandAssign = refDestructuringErrors.shorthandAssign;
      var doubleProto = refDestructuringErrors.doubleProto;
      if (!andThrow) {
        return shorthandAssign >= 0 || doubleProto >= 0;
      }
      if (shorthandAssign >= 0) {
        this.raise(shorthandAssign, "Shorthand property assignments are valid only in destructuring patterns");
      }
      if (doubleProto >= 0) {
        this.raiseRecoverable(doubleProto, "Redefinition of __proto__ property");
      }
    };
    pp$9.checkYieldAwaitInDefaultParams = function() {
      if (this.yieldPos && (!this.awaitPos || this.yieldPos < this.awaitPos)) {
        this.raise(this.yieldPos, "Yield expression cannot be a default value");
      }
      if (this.awaitPos) {
        this.raise(this.awaitPos, "Await expression cannot be a default value");
      }
    };
    pp$9.isSimpleAssignTarget = function(expr) {
      if (expr.type === "ParenthesizedExpression") {
        return this.isSimpleAssignTarget(expr.expression);
      }
      return expr.type === "Identifier" || expr.type === "MemberExpression";
    };
    pp$8 = Parser.prototype;
    pp$8.parseTopLevel = function(node) {
      var exports = /* @__PURE__ */ Object.create(null);
      if (!node.body) {
        node.body = [];
      }
      while (this.type !== types$1.eof) {
        var stmt = this.parseStatement(null, true, exports);
        node.body.push(stmt);
      }
      if (this.inModule) {
        for (var i = 0, list = Object.keys(this.undefinedExports); i < list.length; i += 1) {
          var name = list[i];
          this.raiseRecoverable(this.undefinedExports[name].start, "Export '" + name + "' is not defined");
        }
      }
      this.adaptDirectivePrologue(node.body);
      this.next();
      node.sourceType = this.options.sourceType === "commonjs" ? "script" : this.options.sourceType;
      return this.finishNode(node, "Program");
    };
    loopLabel = { kind: "loop" };
    switchLabel = { kind: "switch" };
    pp$8.isLet = function(context) {
      if (this.options.ecmaVersion < 6 || !this.isContextual("let")) {
        return false;
      }
      skipWhiteSpace.lastIndex = this.pos;
      var skip = skipWhiteSpace.exec(this.input);
      var next = this.pos + skip[0].length, nextCh = this.fullCharCodeAt(next);
      if (nextCh === 91 || nextCh === 92) {
        return true;
      }
      if (context) {
        return false;
      }
      if (nextCh === 123) {
        return true;
      }
      if (isIdentifierStart(nextCh)) {
        var start = next;
        do {
          next += nextCh <= 65535 ? 1 : 2;
        } while (isIdentifierChar(nextCh = this.fullCharCodeAt(next)));
        if (nextCh === 92) {
          return true;
        }
        var ident = this.input.slice(start, next);
        if (!keywordRelationalOperator.test(ident)) {
          return true;
        }
      }
      return false;
    };
    pp$8.isAsyncFunction = function() {
      if (this.options.ecmaVersion < 8 || !this.isContextual("async")) {
        return false;
      }
      skipWhiteSpace.lastIndex = this.pos;
      var skip = skipWhiteSpace.exec(this.input);
      var next = this.pos + skip[0].length, after;
      return !lineBreak.test(this.input.slice(this.pos, next)) && this.input.slice(next, next + 8) === "function" && (next + 8 === this.input.length || !(isIdentifierChar(after = this.fullCharCodeAt(next + 8)) || after === 92));
    };
    pp$8.isUsingKeyword = function(isAwaitUsing, isFor) {
      if (this.options.ecmaVersion < 17 || !this.isContextual(isAwaitUsing ? "await" : "using")) {
        return false;
      }
      skipWhiteSpace.lastIndex = this.pos;
      var skip = skipWhiteSpace.exec(this.input);
      var next = this.pos + skip[0].length;
      if (lineBreak.test(this.input.slice(this.pos, next))) {
        return false;
      }
      if (isAwaitUsing) {
        var usingEndPos = next + 5, after;
        if (this.input.slice(next, usingEndPos) !== "using" || usingEndPos === this.input.length || isIdentifierChar(after = this.fullCharCodeAt(usingEndPos)) || after === 92) {
          return false;
        }
        skipWhiteSpace.lastIndex = usingEndPos;
        var skipAfterUsing = skipWhiteSpace.exec(this.input);
        next = usingEndPos + skipAfterUsing[0].length;
        if (skipAfterUsing && lineBreak.test(this.input.slice(usingEndPos, next))) {
          return false;
        }
      }
      var ch = this.fullCharCodeAt(next);
      if (!isIdentifierStart(ch) && ch !== 92) {
        return false;
      }
      var idStart = next;
      do {
        next += ch <= 65535 ? 1 : 2;
      } while (isIdentifierChar(ch = this.fullCharCodeAt(next)));
      if (ch === 92) {
        return true;
      }
      var id = this.input.slice(idStart, next);
      if (keywordRelationalOperator.test(id) || isFor && id === "of") {
        return false;
      }
      return true;
    };
    pp$8.isAwaitUsing = function(isFor) {
      return this.isUsingKeyword(true, isFor);
    };
    pp$8.isUsing = function(isFor) {
      return this.isUsingKeyword(false, isFor);
    };
    pp$8.parseStatement = function(context, topLevel, exports) {
      var starttype = this.type, node = this.startNode(), kind;
      if (this.isLet(context)) {
        starttype = types$1._var;
        kind = "let";
      }
      switch (starttype) {
        case types$1._break:
        case types$1._continue:
          return this.parseBreakContinueStatement(node, starttype.keyword);
        case types$1._debugger:
          return this.parseDebuggerStatement(node);
        case types$1._do:
          return this.parseDoStatement(node);
        case types$1._for:
          return this.parseForStatement(node);
        case types$1._function:
          if (context && (this.strict || context !== "if" && context !== "label") && this.options.ecmaVersion >= 6) {
            this.unexpected();
          }
          return this.parseFunctionStatement(node, false, !context);
        case types$1._class:
          if (context) {
            this.unexpected();
          }
          return this.parseClass(node, true);
        case types$1._if:
          return this.parseIfStatement(node);
        case types$1._return:
          return this.parseReturnStatement(node);
        case types$1._switch:
          return this.parseSwitchStatement(node);
        case types$1._throw:
          return this.parseThrowStatement(node);
        case types$1._try:
          return this.parseTryStatement(node);
        case types$1._const:
        case types$1._var:
          kind = kind || this.value;
          if (context && kind !== "var") {
            this.unexpected();
          }
          return this.parseVarStatement(node, kind);
        case types$1._while:
          return this.parseWhileStatement(node);
        case types$1._with:
          return this.parseWithStatement(node);
        case types$1.braceL:
          return this.parseBlock(true, node);
        case types$1.semi:
          return this.parseEmptyStatement(node);
        case types$1._export:
        case types$1._import:
          if (this.options.ecmaVersion > 10 && starttype === types$1._import) {
            skipWhiteSpace.lastIndex = this.pos;
            var skip = skipWhiteSpace.exec(this.input);
            var next = this.pos + skip[0].length, nextCh = this.input.charCodeAt(next);
            if (nextCh === 40 || nextCh === 46) {
              return this.parseExpressionStatement(node, this.parseExpression());
            }
          }
          if (!this.options.allowImportExportEverywhere) {
            if (!topLevel) {
              this.raise(this.start, "'import' and 'export' may only appear at the top level");
            }
            if (!this.inModule) {
              this.raise(this.start, "'import' and 'export' may appear only with 'sourceType: module'");
            }
          }
          return starttype === types$1._import ? this.parseImport(node) : this.parseExport(node, exports);
        // If the statement does not start with a statement keyword or a
        // brace, it's an ExpressionStatement or LabeledStatement. We
        // simply start parsing an expression, and afterwards, if the
        // next token is a colon and the expression was a simple
        // Identifier node, we switch to interpreting it as a label.
        default:
          if (this.isAsyncFunction()) {
            if (context) {
              this.unexpected();
            }
            this.next();
            return this.parseFunctionStatement(node, true, !context);
          }
          var usingKind = this.isAwaitUsing(false) ? "await using" : this.isUsing(false) ? "using" : null;
          if (usingKind) {
            if (!this.allowUsing) {
              this.raise(this.start, "Using declaration cannot appear in the top level when source type is `script` or in the bare case statement");
            }
            if (usingKind === "await using") {
              if (!this.canAwait) {
                this.raise(this.start, "Await using cannot appear outside of async function");
              }
              this.next();
            }
            this.next();
            this.parseVar(node, false, usingKind);
            this.semicolon();
            return this.finishNode(node, "VariableDeclaration");
          }
          var maybeName = this.value, expr = this.parseExpression();
          if (starttype === types$1.name && expr.type === "Identifier" && this.eat(types$1.colon)) {
            return this.parseLabeledStatement(node, maybeName, expr, context);
          } else {
            return this.parseExpressionStatement(node, expr);
          }
      }
    };
    pp$8.parseBreakContinueStatement = function(node, keyword) {
      var isBreak = keyword === "break";
      this.next();
      if (this.eat(types$1.semi) || this.insertSemicolon()) {
        node.label = null;
      } else if (this.type !== types$1.name) {
        this.unexpected();
      } else {
        node.label = this.parseIdent();
        this.semicolon();
      }
      var i = 0;
      for (; i < this.labels.length; ++i) {
        var lab = this.labels[i];
        if (node.label == null || lab.name === node.label.name) {
          if (lab.kind != null && (isBreak || lab.kind === "loop")) {
            break;
          }
          if (node.label && isBreak) {
            break;
          }
        }
      }
      if (i === this.labels.length) {
        this.raise(node.start, "Unsyntactic " + keyword);
      }
      return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");
    };
    pp$8.parseDebuggerStatement = function(node) {
      this.next();
      this.semicolon();
      return this.finishNode(node, "DebuggerStatement");
    };
    pp$8.parseDoStatement = function(node) {
      this.next();
      this.labels.push(loopLabel);
      node.body = this.parseStatement("do");
      this.labels.pop();
      this.expect(types$1._while);
      node.test = this.parseParenExpression();
      if (this.options.ecmaVersion >= 6) {
        this.eat(types$1.semi);
      } else {
        this.semicolon();
      }
      return this.finishNode(node, "DoWhileStatement");
    };
    pp$8.parseForStatement = function(node) {
      this.next();
      var awaitAt = this.options.ecmaVersion >= 9 && this.canAwait && this.eatContextual("await") ? this.lastTokStart : -1;
      this.labels.push(loopLabel);
      this.enterScope(0);
      this.expect(types$1.parenL);
      if (this.type === types$1.semi) {
        if (awaitAt > -1) {
          this.unexpected(awaitAt);
        }
        return this.parseFor(node, null);
      }
      var isLet = this.isLet();
      if (this.type === types$1._var || this.type === types$1._const || isLet) {
        var init$1 = this.startNode(), kind = isLet ? "let" : this.value;
        this.next();
        this.parseVar(init$1, true, kind);
        this.finishNode(init$1, "VariableDeclaration");
        return this.parseForAfterInit(node, init$1, awaitAt);
      }
      var startsWithLet = this.isContextual("let"), isForOf = false;
      var usingKind = this.isUsing(true) ? "using" : this.isAwaitUsing(true) ? "await using" : null;
      if (usingKind) {
        var init$2 = this.startNode();
        this.next();
        if (usingKind === "await using") {
          if (!this.canAwait) {
            this.raise(this.start, "Await using cannot appear outside of async function");
          }
          this.next();
        }
        this.parseVar(init$2, true, usingKind);
        this.finishNode(init$2, "VariableDeclaration");
        return this.parseForAfterInit(node, init$2, awaitAt);
      }
      var containsEsc = this.containsEsc;
      var refDestructuringErrors = new DestructuringErrors();
      var initPos = this.start;
      var init = awaitAt > -1 ? this.parseExprSubscripts(refDestructuringErrors, "await") : this.parseExpression(true, refDestructuringErrors);
      if (this.type === types$1._in || (isForOf = this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
        if (awaitAt > -1) {
          if (this.type === types$1._in) {
            this.unexpected(awaitAt);
          }
          node.await = true;
        } else if (isForOf && this.options.ecmaVersion >= 8) {
          if (init.start === initPos && !containsEsc && init.type === "Identifier" && init.name === "async") {
            this.unexpected();
          } else if (this.options.ecmaVersion >= 9) {
            node.await = false;
          }
        }
        if (startsWithLet && isForOf) {
          this.raise(init.start, "The left-hand side of a for-of loop may not start with 'let'.");
        }
        this.toAssignable(init, false, refDestructuringErrors);
        this.checkLValPattern(init);
        return this.parseForIn(node, init);
      } else {
        this.checkExpressionErrors(refDestructuringErrors, true);
      }
      if (awaitAt > -1) {
        this.unexpected(awaitAt);
      }
      return this.parseFor(node, init);
    };
    pp$8.parseForAfterInit = function(node, init, awaitAt) {
      if ((this.type === types$1._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) && init.declarations.length === 1) {
        if (this.options.ecmaVersion >= 9) {
          if (this.type === types$1._in) {
            if (awaitAt > -1) {
              this.unexpected(awaitAt);
            }
          } else {
            node.await = awaitAt > -1;
          }
        }
        return this.parseForIn(node, init);
      }
      if (awaitAt > -1) {
        this.unexpected(awaitAt);
      }
      return this.parseFor(node, init);
    };
    pp$8.parseFunctionStatement = function(node, isAsync, declarationPosition) {
      this.next();
      return this.parseFunction(node, FUNC_STATEMENT | (declarationPosition ? 0 : FUNC_HANGING_STATEMENT), false, isAsync);
    };
    pp$8.parseIfStatement = function(node) {
      this.next();
      node.test = this.parseParenExpression();
      node.consequent = this.parseStatement("if");
      node.alternate = this.eat(types$1._else) ? this.parseStatement("if") : null;
      return this.finishNode(node, "IfStatement");
    };
    pp$8.parseReturnStatement = function(node) {
      if (!this.allowReturn) {
        this.raise(this.start, "'return' outside of function");
      }
      this.next();
      if (this.eat(types$1.semi) || this.insertSemicolon()) {
        node.argument = null;
      } else {
        node.argument = this.parseExpression();
        this.semicolon();
      }
      return this.finishNode(node, "ReturnStatement");
    };
    pp$8.parseSwitchStatement = function(node) {
      this.next();
      node.discriminant = this.parseParenExpression();
      node.cases = [];
      this.expect(types$1.braceL);
      this.labels.push(switchLabel);
      this.enterScope(SCOPE_SWITCH);
      var cur;
      for (var sawDefault = false; this.type !== types$1.braceR; ) {
        if (this.type === types$1._case || this.type === types$1._default) {
          var isCase = this.type === types$1._case;
          if (cur) {
            this.finishNode(cur, "SwitchCase");
          }
          node.cases.push(cur = this.startNode());
          cur.consequent = [];
          this.next();
          if (isCase) {
            cur.test = this.parseExpression();
          } else {
            if (sawDefault) {
              this.raiseRecoverable(this.lastTokStart, "Multiple default clauses");
            }
            sawDefault = true;
            cur.test = null;
          }
          this.expect(types$1.colon);
        } else {
          if (!cur) {
            this.unexpected();
          }
          cur.consequent.push(this.parseStatement(null));
        }
      }
      this.exitScope();
      if (cur) {
        this.finishNode(cur, "SwitchCase");
      }
      this.next();
      this.labels.pop();
      return this.finishNode(node, "SwitchStatement");
    };
    pp$8.parseThrowStatement = function(node) {
      this.next();
      if (lineBreak.test(this.input.slice(this.lastTokEnd, this.start))) {
        this.raise(this.lastTokEnd, "Illegal newline after throw");
      }
      node.argument = this.parseExpression();
      this.semicolon();
      return this.finishNode(node, "ThrowStatement");
    };
    empty$1 = [];
    pp$8.parseCatchClauseParam = function() {
      var param = this.parseBindingAtom();
      var simple = param.type === "Identifier";
      this.enterScope(simple ? SCOPE_SIMPLE_CATCH : 0);
      this.checkLValPattern(param, simple ? BIND_SIMPLE_CATCH : BIND_LEXICAL);
      this.expect(types$1.parenR);
      return param;
    };
    pp$8.parseTryStatement = function(node) {
      this.next();
      node.block = this.parseBlock();
      node.handler = null;
      if (this.type === types$1._catch) {
        var clause = this.startNode();
        this.next();
        if (this.eat(types$1.parenL)) {
          clause.param = this.parseCatchClauseParam();
        } else {
          if (this.options.ecmaVersion < 10) {
            this.unexpected();
          }
          clause.param = null;
          this.enterScope(0);
        }
        clause.body = this.parseBlock(false);
        this.exitScope();
        node.handler = this.finishNode(clause, "CatchClause");
      }
      node.finalizer = this.eat(types$1._finally) ? this.parseBlock() : null;
      if (!node.handler && !node.finalizer) {
        this.raise(node.start, "Missing catch or finally clause");
      }
      return this.finishNode(node, "TryStatement");
    };
    pp$8.parseVarStatement = function(node, kind, allowMissingInitializer) {
      this.next();
      this.parseVar(node, false, kind, allowMissingInitializer);
      this.semicolon();
      return this.finishNode(node, "VariableDeclaration");
    };
    pp$8.parseWhileStatement = function(node) {
      this.next();
      node.test = this.parseParenExpression();
      this.labels.push(loopLabel);
      node.body = this.parseStatement("while");
      this.labels.pop();
      return this.finishNode(node, "WhileStatement");
    };
    pp$8.parseWithStatement = function(node) {
      if (this.strict) {
        this.raise(this.start, "'with' in strict mode");
      }
      this.next();
      node.object = this.parseParenExpression();
      node.body = this.parseStatement("with");
      return this.finishNode(node, "WithStatement");
    };
    pp$8.parseEmptyStatement = function(node) {
      this.next();
      return this.finishNode(node, "EmptyStatement");
    };
    pp$8.parseLabeledStatement = function(node, maybeName, expr, context) {
      for (var i$1 = 0, list = this.labels; i$1 < list.length; i$1 += 1) {
        var label = list[i$1];
        if (label.name === maybeName) {
          this.raise(expr.start, "Label '" + maybeName + "' is already declared");
        }
      }
      var kind = this.type.isLoop ? "loop" : this.type === types$1._switch ? "switch" : null;
      for (var i = this.labels.length - 1; i >= 0; i--) {
        var label$1 = this.labels[i];
        if (label$1.statementStart === node.start) {
          label$1.statementStart = this.start;
          label$1.kind = kind;
        } else {
          break;
        }
      }
      this.labels.push({ name: maybeName, kind, statementStart: this.start });
      node.body = this.parseStatement(context ? context.indexOf("label") === -1 ? context + "label" : context : "label");
      this.labels.pop();
      node.label = expr;
      return this.finishNode(node, "LabeledStatement");
    };
    pp$8.parseExpressionStatement = function(node, expr) {
      node.expression = expr;
      this.semicolon();
      return this.finishNode(node, "ExpressionStatement");
    };
    pp$8.parseBlock = function(createNewLexicalScope, node, exitStrict) {
      if (createNewLexicalScope === void 0) createNewLexicalScope = true;
      if (node === void 0) node = this.startNode();
      node.body = [];
      this.expect(types$1.braceL);
      if (createNewLexicalScope) {
        this.enterScope(0);
      }
      while (this.type !== types$1.braceR) {
        var stmt = this.parseStatement(null);
        node.body.push(stmt);
      }
      if (exitStrict) {
        this.strict = false;
      }
      this.next();
      if (createNewLexicalScope) {
        this.exitScope();
      }
      return this.finishNode(node, "BlockStatement");
    };
    pp$8.parseFor = function(node, init) {
      node.init = init;
      this.expect(types$1.semi);
      node.test = this.type === types$1.semi ? null : this.parseExpression();
      this.expect(types$1.semi);
      node.update = this.type === types$1.parenR ? null : this.parseExpression();
      this.expect(types$1.parenR);
      node.body = this.parseStatement("for");
      this.exitScope();
      this.labels.pop();
      return this.finishNode(node, "ForStatement");
    };
    pp$8.parseForIn = function(node, init) {
      var isForIn = this.type === types$1._in;
      this.next();
      if (init.type === "VariableDeclaration" && init.declarations[0].init != null && (!isForIn || this.options.ecmaVersion < 8 || this.strict || init.kind !== "var" || init.declarations[0].id.type !== "Identifier")) {
        this.raise(
          init.start,
          (isForIn ? "for-in" : "for-of") + " loop variable declaration may not have an initializer"
        );
      }
      node.left = init;
      node.right = isForIn ? this.parseExpression() : this.parseMaybeAssign();
      this.expect(types$1.parenR);
      node.body = this.parseStatement("for");
      this.exitScope();
      this.labels.pop();
      return this.finishNode(node, isForIn ? "ForInStatement" : "ForOfStatement");
    };
    pp$8.parseVar = function(node, isFor, kind, allowMissingInitializer) {
      node.declarations = [];
      node.kind = kind;
      for (; ; ) {
        var decl = this.startNode();
        this.parseVarId(decl, kind);
        if (this.eat(types$1.eq)) {
          decl.init = this.parseMaybeAssign(isFor);
        } else if (!allowMissingInitializer && kind === "const" && !(this.type === types$1._in || this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
          this.unexpected();
        } else if (!allowMissingInitializer && (kind === "using" || kind === "await using") && this.options.ecmaVersion >= 17 && this.type !== types$1._in && !this.isContextual("of")) {
          this.raise(this.lastTokEnd, "Missing initializer in " + kind + " declaration");
        } else if (!allowMissingInitializer && decl.id.type !== "Identifier" && !(isFor && (this.type === types$1._in || this.isContextual("of")))) {
          this.raise(this.lastTokEnd, "Complex binding patterns require an initialization value");
        } else {
          decl.init = null;
        }
        node.declarations.push(this.finishNode(decl, "VariableDeclarator"));
        if (!this.eat(types$1.comma)) {
          break;
        }
      }
      return node;
    };
    pp$8.parseVarId = function(decl, kind) {
      decl.id = kind === "using" || kind === "await using" ? this.parseIdent() : this.parseBindingAtom();
      this.checkLValPattern(decl.id, kind === "var" ? BIND_VAR : BIND_LEXICAL, false);
    };
    FUNC_STATEMENT = 1;
    FUNC_HANGING_STATEMENT = 2;
    FUNC_NULLABLE_ID = 4;
    pp$8.parseFunction = function(node, statement, allowExpressionBody, isAsync, forInit) {
      this.initFunction(node);
      if (this.options.ecmaVersion >= 9 || this.options.ecmaVersion >= 6 && !isAsync) {
        if (this.type === types$1.star && statement & FUNC_HANGING_STATEMENT) {
          this.unexpected();
        }
        node.generator = this.eat(types$1.star);
      }
      if (this.options.ecmaVersion >= 8) {
        node.async = !!isAsync;
      }
      if (statement & FUNC_STATEMENT) {
        node.id = statement & FUNC_NULLABLE_ID && this.type !== types$1.name ? null : this.parseIdent();
        if (node.id && !(statement & FUNC_HANGING_STATEMENT)) {
          this.checkLValSimple(node.id, this.strict || node.generator || node.async ? this.treatFunctionsAsVar ? BIND_VAR : BIND_LEXICAL : BIND_FUNCTION);
        }
      }
      var oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
      this.yieldPos = 0;
      this.awaitPos = 0;
      this.awaitIdentPos = 0;
      this.enterScope(functionFlags(node.async, node.generator));
      if (!(statement & FUNC_STATEMENT)) {
        node.id = this.type === types$1.name ? this.parseIdent() : null;
      }
      this.parseFunctionParams(node);
      this.parseFunctionBody(node, allowExpressionBody, false, forInit);
      this.yieldPos = oldYieldPos;
      this.awaitPos = oldAwaitPos;
      this.awaitIdentPos = oldAwaitIdentPos;
      return this.finishNode(node, statement & FUNC_STATEMENT ? "FunctionDeclaration" : "FunctionExpression");
    };
    pp$8.parseFunctionParams = function(node) {
      this.expect(types$1.parenL);
      node.params = this.parseBindingList(types$1.parenR, false, this.options.ecmaVersion >= 8);
      this.checkYieldAwaitInDefaultParams();
    };
    pp$8.parseClass = function(node, isStatement) {
      this.next();
      var oldStrict = this.strict;
      this.strict = true;
      this.parseClassId(node, isStatement);
      this.parseClassSuper(node);
      var privateNameMap = this.enterClassBody();
      var classBody = this.startNode();
      var hadConstructor = false;
      classBody.body = [];
      this.expect(types$1.braceL);
      while (this.type !== types$1.braceR) {
        var element = this.parseClassElement(node.superClass !== null);
        if (element) {
          classBody.body.push(element);
          if (element.type === "MethodDefinition" && element.kind === "constructor") {
            if (hadConstructor) {
              this.raiseRecoverable(element.start, "Duplicate constructor in the same class");
            }
            hadConstructor = true;
          } else if (element.key && element.key.type === "PrivateIdentifier" && isPrivateNameConflicted(privateNameMap, element)) {
            this.raiseRecoverable(element.key.start, "Identifier '#" + element.key.name + "' has already been declared");
          }
        }
      }
      this.strict = oldStrict;
      this.next();
      node.body = this.finishNode(classBody, "ClassBody");
      this.exitClassBody();
      return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
    };
    pp$8.parseClassElement = function(constructorAllowsSuper) {
      if (this.eat(types$1.semi)) {
        return null;
      }
      var ecmaVersion = this.options.ecmaVersion;
      var node = this.startNode();
      var keyName = "";
      var isGenerator = false;
      var isAsync = false;
      var kind = "method";
      var isStatic = false;
      if (this.eatContextual("static")) {
        if (ecmaVersion >= 13 && this.eat(types$1.braceL)) {
          this.parseClassStaticBlock(node);
          return node;
        }
        if (this.isClassElementNameStart() || this.type === types$1.star) {
          isStatic = true;
        } else {
          keyName = "static";
        }
      }
      node.static = isStatic;
      if (!keyName && ecmaVersion >= 8 && this.eatContextual("async")) {
        if ((this.isClassElementNameStart() || this.type === types$1.star) && !this.canInsertSemicolon()) {
          isAsync = true;
        } else {
          keyName = "async";
        }
      }
      if (!keyName && (ecmaVersion >= 9 || !isAsync) && this.eat(types$1.star)) {
        isGenerator = true;
      }
      if (!keyName && !isAsync && !isGenerator) {
        var lastValue = this.value;
        if (this.eatContextual("get") || this.eatContextual("set")) {
          if (this.isClassElementNameStart()) {
            kind = lastValue;
          } else {
            keyName = lastValue;
          }
        }
      }
      if (keyName) {
        node.computed = false;
        node.key = this.startNodeAt(this.lastTokStart, this.lastTokStartLoc);
        node.key.name = keyName;
        this.finishNode(node.key, "Identifier");
      } else {
        this.parseClassElementName(node);
      }
      if (ecmaVersion < 13 || this.type === types$1.parenL || kind !== "method" || isGenerator || isAsync) {
        var isConstructor = !node.static && checkKeyName(node, "constructor");
        var allowsDirectSuper = isConstructor && constructorAllowsSuper;
        if (isConstructor && kind !== "method") {
          this.raise(node.key.start, "Constructor can't have get/set modifier");
        }
        node.kind = isConstructor ? "constructor" : kind;
        this.parseClassMethod(node, isGenerator, isAsync, allowsDirectSuper);
      } else {
        this.parseClassField(node);
      }
      return node;
    };
    pp$8.isClassElementNameStart = function() {
      return this.type === types$1.name || this.type === types$1.privateId || this.type === types$1.num || this.type === types$1.string || this.type === types$1.bracketL || this.type.keyword;
    };
    pp$8.parseClassElementName = function(element) {
      if (this.type === types$1.privateId) {
        if (this.value === "constructor") {
          this.raise(this.start, "Classes can't have an element named '#constructor'");
        }
        element.computed = false;
        element.key = this.parsePrivateIdent();
      } else {
        this.parsePropertyName(element);
      }
    };
    pp$8.parseClassMethod = function(method, isGenerator, isAsync, allowsDirectSuper) {
      var key = method.key;
      if (method.kind === "constructor") {
        if (isGenerator) {
          this.raise(key.start, "Constructor can't be a generator");
        }
        if (isAsync) {
          this.raise(key.start, "Constructor can't be an async method");
        }
      } else if (method.static && checkKeyName(method, "prototype")) {
        this.raise(key.start, "Classes may not have a static property named prototype");
      }
      var value = method.value = this.parseMethod(isGenerator, isAsync, allowsDirectSuper);
      if (method.kind === "get" && value.params.length !== 0) {
        this.raiseRecoverable(value.start, "getter should have no params");
      }
      if (method.kind === "set" && value.params.length !== 1) {
        this.raiseRecoverable(value.start, "setter should have exactly one param");
      }
      if (method.kind === "set" && value.params[0].type === "RestElement") {
        this.raiseRecoverable(value.params[0].start, "Setter cannot use rest params");
      }
      return this.finishNode(method, "MethodDefinition");
    };
    pp$8.parseClassField = function(field) {
      if (checkKeyName(field, "constructor")) {
        this.raise(field.key.start, "Classes can't have a field named 'constructor'");
      } else if (field.static && checkKeyName(field, "prototype")) {
        this.raise(field.key.start, "Classes can't have a static field named 'prototype'");
      }
      if (this.eat(types$1.eq)) {
        this.enterScope(SCOPE_CLASS_FIELD_INIT | SCOPE_SUPER);
        field.value = this.parseMaybeAssign();
        this.exitScope();
      } else {
        field.value = null;
      }
      this.semicolon();
      return this.finishNode(field, "PropertyDefinition");
    };
    pp$8.parseClassStaticBlock = function(node) {
      node.body = [];
      var oldLabels = this.labels;
      this.labels = [];
      this.enterScope(SCOPE_CLASS_STATIC_BLOCK | SCOPE_SUPER);
      while (this.type !== types$1.braceR) {
        var stmt = this.parseStatement(null);
        node.body.push(stmt);
      }
      this.next();
      this.exitScope();
      this.labels = oldLabels;
      return this.finishNode(node, "StaticBlock");
    };
    pp$8.parseClassId = function(node, isStatement) {
      if (this.type === types$1.name) {
        node.id = this.parseIdent();
        if (isStatement) {
          this.checkLValSimple(node.id, BIND_LEXICAL, false);
        }
      } else {
        if (isStatement === true) {
          this.unexpected();
        }
        node.id = null;
      }
    };
    pp$8.parseClassSuper = function(node) {
      node.superClass = this.eat(types$1._extends) ? this.parseExprSubscripts(null, false) : null;
    };
    pp$8.enterClassBody = function() {
      var element = { declared: /* @__PURE__ */ Object.create(null), used: [] };
      this.privateNameStack.push(element);
      return element.declared;
    };
    pp$8.exitClassBody = function() {
      var ref2 = this.privateNameStack.pop();
      var declared = ref2.declared;
      var used = ref2.used;
      if (!this.options.checkPrivateFields) {
        return;
      }
      var len = this.privateNameStack.length;
      var parent = len === 0 ? null : this.privateNameStack[len - 1];
      for (var i = 0; i < used.length; ++i) {
        var id = used[i];
        if (!hasOwn2(declared, id.name)) {
          if (parent) {
            parent.used.push(id);
          } else {
            this.raiseRecoverable(id.start, "Private field '#" + id.name + "' must be declared in an enclosing class");
          }
        }
      }
    };
    pp$8.parseExportAllDeclaration = function(node, exports) {
      if (this.options.ecmaVersion >= 11) {
        if (this.eatContextual("as")) {
          node.exported = this.parseModuleExportName();
          this.checkExport(exports, node.exported, this.lastTokStart);
        } else {
          node.exported = null;
        }
      }
      this.expectContextual("from");
      if (this.type !== types$1.string) {
        this.unexpected();
      }
      node.source = this.parseExprAtom();
      if (this.options.ecmaVersion >= 16) {
        node.attributes = this.parseWithClause();
      }
      this.semicolon();
      return this.finishNode(node, "ExportAllDeclaration");
    };
    pp$8.parseExport = function(node, exports) {
      this.next();
      if (this.eat(types$1.star)) {
        return this.parseExportAllDeclaration(node, exports);
      }
      if (this.eat(types$1._default)) {
        this.checkExport(exports, "default", this.lastTokStart);
        node.declaration = this.parseExportDefaultDeclaration();
        return this.finishNode(node, "ExportDefaultDeclaration");
      }
      if (this.shouldParseExportStatement()) {
        node.declaration = this.parseExportDeclaration(node);
        if (node.declaration.type === "VariableDeclaration") {
          this.checkVariableExport(exports, node.declaration.declarations);
        } else {
          this.checkExport(exports, node.declaration.id, node.declaration.id.start);
        }
        node.specifiers = [];
        node.source = null;
        if (this.options.ecmaVersion >= 16) {
          node.attributes = [];
        }
      } else {
        node.declaration = null;
        node.specifiers = this.parseExportSpecifiers(exports);
        if (this.eatContextual("from")) {
          if (this.type !== types$1.string) {
            this.unexpected();
          }
          node.source = this.parseExprAtom();
          if (this.options.ecmaVersion >= 16) {
            node.attributes = this.parseWithClause();
          }
        } else {
          for (var i = 0, list = node.specifiers; i < list.length; i += 1) {
            var spec = list[i];
            this.checkUnreserved(spec.local);
            this.checkLocalExport(spec.local);
            if (spec.local.type === "Literal") {
              this.raise(spec.local.start, "A string literal cannot be used as an exported binding without `from`.");
            }
          }
          node.source = null;
          if (this.options.ecmaVersion >= 16) {
            node.attributes = [];
          }
        }
        this.semicolon();
      }
      return this.finishNode(node, "ExportNamedDeclaration");
    };
    pp$8.parseExportDeclaration = function(node) {
      return this.parseStatement(null);
    };
    pp$8.parseExportDefaultDeclaration = function() {
      var isAsync;
      if (this.type === types$1._function || (isAsync = this.isAsyncFunction())) {
        var fNode = this.startNode();
        this.next();
        if (isAsync) {
          this.next();
        }
        return this.parseFunction(fNode, FUNC_STATEMENT | FUNC_NULLABLE_ID, false, isAsync);
      } else if (this.type === types$1._class) {
        var cNode = this.startNode();
        return this.parseClass(cNode, "nullableID");
      } else {
        var declaration = this.parseMaybeAssign();
        this.semicolon();
        return declaration;
      }
    };
    pp$8.checkExport = function(exports, name, pos) {
      if (!exports) {
        return;
      }
      if (typeof name !== "string") {
        name = name.type === "Identifier" ? name.name : name.value;
      }
      if (hasOwn2(exports, name)) {
        this.raiseRecoverable(pos, "Duplicate export '" + name + "'");
      }
      exports[name] = true;
    };
    pp$8.checkPatternExport = function(exports, pat) {
      var type = pat.type;
      if (type === "Identifier") {
        this.checkExport(exports, pat, pat.start);
      } else if (type === "ObjectPattern") {
        for (var i = 0, list = pat.properties; i < list.length; i += 1) {
          var prop = list[i];
          this.checkPatternExport(exports, prop);
        }
      } else if (type === "ArrayPattern") {
        for (var i$1 = 0, list$1 = pat.elements; i$1 < list$1.length; i$1 += 1) {
          var elt = list$1[i$1];
          if (elt) {
            this.checkPatternExport(exports, elt);
          }
        }
      } else if (type === "Property") {
        this.checkPatternExport(exports, pat.value);
      } else if (type === "AssignmentPattern") {
        this.checkPatternExport(exports, pat.left);
      } else if (type === "RestElement") {
        this.checkPatternExport(exports, pat.argument);
      }
    };
    pp$8.checkVariableExport = function(exports, decls) {
      if (!exports) {
        return;
      }
      for (var i = 0, list = decls; i < list.length; i += 1) {
        var decl = list[i];
        this.checkPatternExport(exports, decl.id);
      }
    };
    pp$8.shouldParseExportStatement = function() {
      return this.type.keyword === "var" || this.type.keyword === "const" || this.type.keyword === "class" || this.type.keyword === "function" || this.isLet() || this.isAsyncFunction();
    };
    pp$8.parseExportSpecifier = function(exports) {
      var node = this.startNode();
      node.local = this.parseModuleExportName();
      node.exported = this.eatContextual("as") ? this.parseModuleExportName() : node.local;
      this.checkExport(
        exports,
        node.exported,
        node.exported.start
      );
      return this.finishNode(node, "ExportSpecifier");
    };
    pp$8.parseExportSpecifiers = function(exports) {
      var nodes = [], first = true;
      this.expect(types$1.braceL);
      while (!this.eat(types$1.braceR)) {
        if (!first) {
          this.expect(types$1.comma);
          if (this.afterTrailingComma(types$1.braceR)) {
            break;
          }
        } else {
          first = false;
        }
        nodes.push(this.parseExportSpecifier(exports));
      }
      return nodes;
    };
    pp$8.parseImport = function(node) {
      this.next();
      if (this.type === types$1.string) {
        node.specifiers = empty$1;
        node.source = this.parseExprAtom();
      } else {
        node.specifiers = this.parseImportSpecifiers();
        this.expectContextual("from");
        node.source = this.type === types$1.string ? this.parseExprAtom() : this.unexpected();
      }
      if (this.options.ecmaVersion >= 16) {
        node.attributes = this.parseWithClause();
      }
      this.semicolon();
      return this.finishNode(node, "ImportDeclaration");
    };
    pp$8.parseImportSpecifier = function() {
      var node = this.startNode();
      node.imported = this.parseModuleExportName();
      if (this.eatContextual("as")) {
        node.local = this.parseIdent();
      } else {
        this.checkUnreserved(node.imported);
        node.local = node.imported;
      }
      this.checkLValSimple(node.local, BIND_LEXICAL);
      return this.finishNode(node, "ImportSpecifier");
    };
    pp$8.parseImportDefaultSpecifier = function() {
      var node = this.startNode();
      node.local = this.parseIdent();
      this.checkLValSimple(node.local, BIND_LEXICAL);
      return this.finishNode(node, "ImportDefaultSpecifier");
    };
    pp$8.parseImportNamespaceSpecifier = function() {
      var node = this.startNode();
      this.next();
      this.expectContextual("as");
      node.local = this.parseIdent();
      this.checkLValSimple(node.local, BIND_LEXICAL);
      return this.finishNode(node, "ImportNamespaceSpecifier");
    };
    pp$8.parseImportSpecifiers = function() {
      var nodes = [], first = true;
      if (this.type === types$1.name) {
        nodes.push(this.parseImportDefaultSpecifier());
        if (!this.eat(types$1.comma)) {
          return nodes;
        }
      }
      if (this.type === types$1.star) {
        nodes.push(this.parseImportNamespaceSpecifier());
        return nodes;
      }
      this.expect(types$1.braceL);
      while (!this.eat(types$1.braceR)) {
        if (!first) {
          this.expect(types$1.comma);
          if (this.afterTrailingComma(types$1.braceR)) {
            break;
          }
        } else {
          first = false;
        }
        nodes.push(this.parseImportSpecifier());
      }
      return nodes;
    };
    pp$8.parseWithClause = function() {
      var nodes = [];
      if (!this.eat(types$1._with)) {
        return nodes;
      }
      this.expect(types$1.braceL);
      var attributeKeys = {};
      var first = true;
      while (!this.eat(types$1.braceR)) {
        if (!first) {
          this.expect(types$1.comma);
          if (this.afterTrailingComma(types$1.braceR)) {
            break;
          }
        } else {
          first = false;
        }
        var attr = this.parseImportAttribute();
        var keyName = attr.key.type === "Identifier" ? attr.key.name : attr.key.value;
        if (hasOwn2(attributeKeys, keyName)) {
          this.raiseRecoverable(attr.key.start, "Duplicate attribute key '" + keyName + "'");
        }
        attributeKeys[keyName] = true;
        nodes.push(attr);
      }
      return nodes;
    };
    pp$8.parseImportAttribute = function() {
      var node = this.startNode();
      node.key = this.type === types$1.string ? this.parseExprAtom() : this.parseIdent(this.options.allowReserved !== "never");
      this.expect(types$1.colon);
      if (this.type !== types$1.string) {
        this.unexpected();
      }
      node.value = this.parseExprAtom();
      return this.finishNode(node, "ImportAttribute");
    };
    pp$8.parseModuleExportName = function() {
      if (this.options.ecmaVersion >= 13 && this.type === types$1.string) {
        var stringLiteral = this.parseLiteral(this.value);
        if (loneSurrogate.test(stringLiteral.value)) {
          this.raise(stringLiteral.start, "An export name cannot include a lone surrogate.");
        }
        return stringLiteral;
      }
      return this.parseIdent(true);
    };
    pp$8.adaptDirectivePrologue = function(statements) {
      for (var i = 0; i < statements.length && this.isDirectiveCandidate(statements[i]); ++i) {
        statements[i].directive = statements[i].expression.raw.slice(1, -1);
      }
    };
    pp$8.isDirectiveCandidate = function(statement) {
      return this.options.ecmaVersion >= 5 && statement.type === "ExpressionStatement" && statement.expression.type === "Literal" && typeof statement.expression.value === "string" && // Reject parenthesized strings.
      (this.input[statement.start] === '"' || this.input[statement.start] === "'");
    };
    pp$7 = Parser.prototype;
    pp$7.toAssignable = function(node, isBinding, refDestructuringErrors) {
      if (this.options.ecmaVersion >= 6 && node) {
        switch (node.type) {
          case "Identifier":
            if (this.inAsync && node.name === "await") {
              this.raise(node.start, "Cannot use 'await' as identifier inside an async function");
            }
            break;
          case "ObjectPattern":
          case "ArrayPattern":
          case "AssignmentPattern":
          case "RestElement":
            break;
          case "ObjectExpression":
            node.type = "ObjectPattern";
            if (refDestructuringErrors) {
              this.checkPatternErrors(refDestructuringErrors, true);
            }
            for (var i = 0, list = node.properties; i < list.length; i += 1) {
              var prop = list[i];
              this.toAssignable(prop, isBinding);
              if (prop.type === "RestElement" && (prop.argument.type === "ArrayPattern" || prop.argument.type === "ObjectPattern")) {
                this.raise(prop.argument.start, "Unexpected token");
              }
            }
            break;
          case "Property":
            if (node.kind !== "init") {
              this.raise(node.key.start, "Object pattern can't contain getter or setter");
            }
            this.toAssignable(node.value, isBinding);
            break;
          case "ArrayExpression":
            node.type = "ArrayPattern";
            if (refDestructuringErrors) {
              this.checkPatternErrors(refDestructuringErrors, true);
            }
            this.toAssignableList(node.elements, isBinding);
            break;
          case "SpreadElement":
            node.type = "RestElement";
            this.toAssignable(node.argument, isBinding);
            if (node.argument.type === "AssignmentPattern") {
              this.raise(node.argument.start, "Rest elements cannot have a default value");
            }
            break;
          case "AssignmentExpression":
            if (node.operator !== "=") {
              this.raise(node.left.end, "Only '=' operator can be used for specifying default value.");
            }
            node.type = "AssignmentPattern";
            delete node.operator;
            this.toAssignable(node.left, isBinding);
            break;
          case "ParenthesizedExpression":
            this.toAssignable(node.expression, isBinding, refDestructuringErrors);
            break;
          case "ChainExpression":
            this.raiseRecoverable(node.start, "Optional chaining cannot appear in left-hand side");
            break;
          case "MemberExpression":
            if (!isBinding) {
              break;
            }
          default:
            this.raise(node.start, "Assigning to rvalue");
        }
      } else if (refDestructuringErrors) {
        this.checkPatternErrors(refDestructuringErrors, true);
      }
      return node;
    };
    pp$7.toAssignableList = function(exprList, isBinding) {
      var end = exprList.length;
      for (var i = 0; i < end; i++) {
        var elt = exprList[i];
        if (elt) {
          this.toAssignable(elt, isBinding);
        }
      }
      if (end) {
        var last = exprList[end - 1];
        if (this.options.ecmaVersion === 6 && isBinding && last && last.type === "RestElement" && last.argument.type !== "Identifier") {
          this.unexpected(last.argument.start);
        }
      }
      return exprList;
    };
    pp$7.parseSpread = function(refDestructuringErrors) {
      var node = this.startNode();
      this.next();
      node.argument = this.parseMaybeAssign(false, refDestructuringErrors);
      return this.finishNode(node, "SpreadElement");
    };
    pp$7.parseRestBinding = function() {
      var node = this.startNode();
      this.next();
      if (this.options.ecmaVersion === 6 && this.type !== types$1.name) {
        this.unexpected();
      }
      node.argument = this.parseBindingAtom();
      return this.finishNode(node, "RestElement");
    };
    pp$7.parseBindingAtom = function() {
      if (this.options.ecmaVersion >= 6) {
        switch (this.type) {
          case types$1.bracketL:
            var node = this.startNode();
            this.next();
            node.elements = this.parseBindingList(types$1.bracketR, true, true);
            return this.finishNode(node, "ArrayPattern");
          case types$1.braceL:
            return this.parseObj(true);
        }
      }
      return this.parseIdent();
    };
    pp$7.parseBindingList = function(close, allowEmpty, allowTrailingComma, allowModifiers) {
      var elts = [], first = true;
      while (!this.eat(close)) {
        if (first) {
          first = false;
        } else {
          this.expect(types$1.comma);
        }
        if (allowEmpty && this.type === types$1.comma) {
          elts.push(null);
        } else if (allowTrailingComma && this.afterTrailingComma(close)) {
          break;
        } else if (this.type === types$1.ellipsis) {
          var rest = this.parseRestBinding();
          this.parseBindingListItem(rest);
          elts.push(rest);
          if (this.type === types$1.comma) {
            this.raiseRecoverable(this.start, "Comma is not permitted after the rest element");
          }
          this.expect(close);
          break;
        } else {
          elts.push(this.parseAssignableListItem(allowModifiers));
        }
      }
      return elts;
    };
    pp$7.parseAssignableListItem = function(allowModifiers) {
      var elem = this.parseMaybeDefault(this.start, this.startLoc);
      this.parseBindingListItem(elem);
      return elem;
    };
    pp$7.parseBindingListItem = function(param) {
      return param;
    };
    pp$7.parseMaybeDefault = function(startPos, startLoc, left) {
      left = left || this.parseBindingAtom();
      if (this.options.ecmaVersion < 6 || !this.eat(types$1.eq)) {
        return left;
      }
      var node = this.startNodeAt(startPos, startLoc);
      node.left = left;
      node.right = this.parseMaybeAssign();
      return this.finishNode(node, "AssignmentPattern");
    };
    pp$7.checkLValSimple = function(expr, bindingType, checkClashes) {
      if (bindingType === void 0) bindingType = BIND_NONE;
      var isBind = bindingType !== BIND_NONE;
      switch (expr.type) {
        case "Identifier":
          if (this.strict && this.reservedWordsStrictBind.test(expr.name)) {
            this.raiseRecoverable(expr.start, (isBind ? "Binding " : "Assigning to ") + expr.name + " in strict mode");
          }
          if (isBind) {
            if (bindingType === BIND_LEXICAL && expr.name === "let") {
              this.raiseRecoverable(expr.start, "let is disallowed as a lexically bound name");
            }
            if (checkClashes) {
              if (hasOwn2(checkClashes, expr.name)) {
                this.raiseRecoverable(expr.start, "Argument name clash");
              }
              checkClashes[expr.name] = true;
            }
            if (bindingType !== BIND_OUTSIDE) {
              this.declareName(expr.name, bindingType, expr.start);
            }
          }
          break;
        case "ChainExpression":
          this.raiseRecoverable(expr.start, "Optional chaining cannot appear in left-hand side");
          break;
        case "MemberExpression":
          if (isBind) {
            this.raiseRecoverable(expr.start, "Binding member expression");
          }
          break;
        case "ParenthesizedExpression":
          if (isBind) {
            this.raiseRecoverable(expr.start, "Binding parenthesized expression");
          }
          return this.checkLValSimple(expr.expression, bindingType, checkClashes);
        default:
          this.raise(expr.start, (isBind ? "Binding" : "Assigning to") + " rvalue");
      }
    };
    pp$7.checkLValPattern = function(expr, bindingType, checkClashes) {
      if (bindingType === void 0) bindingType = BIND_NONE;
      switch (expr.type) {
        case "ObjectPattern":
          for (var i = 0, list = expr.properties; i < list.length; i += 1) {
            var prop = list[i];
            this.checkLValInnerPattern(prop, bindingType, checkClashes);
          }
          break;
        case "ArrayPattern":
          for (var i$1 = 0, list$1 = expr.elements; i$1 < list$1.length; i$1 += 1) {
            var elem = list$1[i$1];
            if (elem) {
              this.checkLValInnerPattern(elem, bindingType, checkClashes);
            }
          }
          break;
        default:
          this.checkLValSimple(expr, bindingType, checkClashes);
      }
    };
    pp$7.checkLValInnerPattern = function(expr, bindingType, checkClashes) {
      if (bindingType === void 0) bindingType = BIND_NONE;
      switch (expr.type) {
        case "Property":
          this.checkLValInnerPattern(expr.value, bindingType, checkClashes);
          break;
        case "AssignmentPattern":
          this.checkLValPattern(expr.left, bindingType, checkClashes);
          break;
        case "RestElement":
          this.checkLValPattern(expr.argument, bindingType, checkClashes);
          break;
        default:
          this.checkLValPattern(expr, bindingType, checkClashes);
      }
    };
    TokContext = function TokContext2(token, isExpr, preserveSpace, override, generator) {
      this.token = token;
      this.isExpr = !!isExpr;
      this.preserveSpace = !!preserveSpace;
      this.override = override;
      this.generator = !!generator;
    };
    types = {
      b_stat: new TokContext("{", false),
      b_expr: new TokContext("{", true),
      b_tmpl: new TokContext("${", false),
      p_stat: new TokContext("(", false),
      p_expr: new TokContext("(", true),
      q_tmpl: new TokContext("`", true, true, function(p) {
        return p.tryReadTemplateToken();
      }),
      f_stat: new TokContext("function", false),
      f_expr: new TokContext("function", true),
      f_expr_gen: new TokContext("function", true, false, null, true),
      f_gen: new TokContext("function", false, false, null, true)
    };
    pp$6 = Parser.prototype;
    pp$6.initialContext = function() {
      return [types.b_stat];
    };
    pp$6.curContext = function() {
      return this.context[this.context.length - 1];
    };
    pp$6.braceIsBlock = function(prevType) {
      var parent = this.curContext();
      if (parent === types.f_expr || parent === types.f_stat) {
        return true;
      }
      if (prevType === types$1.colon && (parent === types.b_stat || parent === types.b_expr)) {
        return !parent.isExpr;
      }
      if (prevType === types$1._return || prevType === types$1.name && this.exprAllowed) {
        return lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
      }
      if (prevType === types$1._else || prevType === types$1.semi || prevType === types$1.eof || prevType === types$1.parenR || prevType === types$1.arrow) {
        return true;
      }
      if (prevType === types$1.braceL) {
        return parent === types.b_stat;
      }
      if (prevType === types$1._var || prevType === types$1._const || prevType === types$1.name) {
        return false;
      }
      return !this.exprAllowed;
    };
    pp$6.inGeneratorContext = function() {
      for (var i = this.context.length - 1; i >= 1; i--) {
        var context = this.context[i];
        if (context.token === "function") {
          return context.generator;
        }
      }
      return false;
    };
    pp$6.updateContext = function(prevType) {
      var update, type = this.type;
      if (type.keyword && prevType === types$1.dot) {
        this.exprAllowed = false;
      } else if (update = type.updateContext) {
        update.call(this, prevType);
      } else {
        this.exprAllowed = type.beforeExpr;
      }
    };
    pp$6.overrideContext = function(tokenCtx) {
      if (this.curContext() !== tokenCtx) {
        this.context[this.context.length - 1] = tokenCtx;
      }
    };
    types$1.parenR.updateContext = types$1.braceR.updateContext = function() {
      if (this.context.length === 1) {
        this.exprAllowed = true;
        return;
      }
      var out = this.context.pop();
      if (out === types.b_stat && this.curContext().token === "function") {
        out = this.context.pop();
      }
      this.exprAllowed = !out.isExpr;
    };
    types$1.braceL.updateContext = function(prevType) {
      this.context.push(this.braceIsBlock(prevType) ? types.b_stat : types.b_expr);
      this.exprAllowed = true;
    };
    types$1.dollarBraceL.updateContext = function() {
      this.context.push(types.b_tmpl);
      this.exprAllowed = true;
    };
    types$1.parenL.updateContext = function(prevType) {
      var statementParens = prevType === types$1._if || prevType === types$1._for || prevType === types$1._with || prevType === types$1._while;
      this.context.push(statementParens ? types.p_stat : types.p_expr);
      this.exprAllowed = true;
    };
    types$1.incDec.updateContext = function() {
    };
    types$1._function.updateContext = types$1._class.updateContext = function(prevType) {
      if (prevType.beforeExpr && prevType !== types$1._else && !(prevType === types$1.semi && this.curContext() !== types.p_stat) && !(prevType === types$1._return && lineBreak.test(this.input.slice(this.lastTokEnd, this.start))) && !((prevType === types$1.colon || prevType === types$1.braceL) && this.curContext() === types.b_stat)) {
        this.context.push(types.f_expr);
      } else {
        this.context.push(types.f_stat);
      }
      this.exprAllowed = false;
    };
    types$1.colon.updateContext = function() {
      if (this.curContext().token === "function") {
        this.context.pop();
      }
      this.exprAllowed = true;
    };
    types$1.backQuote.updateContext = function() {
      if (this.curContext() === types.q_tmpl) {
        this.context.pop();
      } else {
        this.context.push(types.q_tmpl);
      }
      this.exprAllowed = false;
    };
    types$1.star.updateContext = function(prevType) {
      if (prevType === types$1._function) {
        var index = this.context.length - 1;
        if (this.context[index] === types.f_expr) {
          this.context[index] = types.f_expr_gen;
        } else {
          this.context[index] = types.f_gen;
        }
      }
      this.exprAllowed = true;
    };
    types$1.name.updateContext = function(prevType) {
      var allowed = false;
      if (this.options.ecmaVersion >= 6 && prevType !== types$1.dot) {
        if (this.value === "of" && !this.exprAllowed || this.value === "yield" && this.inGeneratorContext()) {
          allowed = true;
        }
      }
      this.exprAllowed = allowed;
    };
    pp$5 = Parser.prototype;
    pp$5.checkPropClash = function(prop, propHash, refDestructuringErrors) {
      if (this.options.ecmaVersion >= 9 && prop.type === "SpreadElement") {
        return;
      }
      if (this.options.ecmaVersion >= 6 && (prop.computed || prop.method || prop.shorthand)) {
        return;
      }
      var key = prop.key;
      var name;
      switch (key.type) {
        case "Identifier":
          name = key.name;
          break;
        case "Literal":
          name = String(key.value);
          break;
        default:
          return;
      }
      var kind = prop.kind;
      if (this.options.ecmaVersion >= 6) {
        if (name === "__proto__" && kind === "init") {
          if (propHash.proto) {
            if (refDestructuringErrors) {
              if (refDestructuringErrors.doubleProto < 0) {
                refDestructuringErrors.doubleProto = key.start;
              }
            } else {
              this.raiseRecoverable(key.start, "Redefinition of __proto__ property");
            }
          }
          propHash.proto = true;
        }
        return;
      }
      name = "$" + name;
      var other = propHash[name];
      if (other) {
        var redefinition;
        if (kind === "init") {
          redefinition = this.strict && other.init || other.get || other.set;
        } else {
          redefinition = other.init || other[kind];
        }
        if (redefinition) {
          this.raiseRecoverable(key.start, "Redefinition of property");
        }
      } else {
        other = propHash[name] = {
          init: false,
          get: false,
          set: false
        };
      }
      other[kind] = true;
    };
    pp$5.parseExpression = function(forInit, refDestructuringErrors) {
      var startPos = this.start, startLoc = this.startLoc;
      var expr = this.parseMaybeAssign(forInit, refDestructuringErrors);
      if (this.type === types$1.comma) {
        var node = this.startNodeAt(startPos, startLoc);
        node.expressions = [expr];
        while (this.eat(types$1.comma)) {
          node.expressions.push(this.parseMaybeAssign(forInit, refDestructuringErrors));
        }
        return this.finishNode(node, "SequenceExpression");
      }
      return expr;
    };
    pp$5.parseMaybeAssign = function(forInit, refDestructuringErrors, afterLeftParse) {
      if (this.isContextual("yield")) {
        if (this.inGenerator) {
          return this.parseYield(forInit);
        } else {
          this.exprAllowed = false;
        }
      }
      var ownDestructuringErrors = false, oldParenAssign = -1, oldTrailingComma = -1, oldDoubleProto = -1;
      if (refDestructuringErrors) {
        oldParenAssign = refDestructuringErrors.parenthesizedAssign;
        oldTrailingComma = refDestructuringErrors.trailingComma;
        oldDoubleProto = refDestructuringErrors.doubleProto;
        refDestructuringErrors.parenthesizedAssign = refDestructuringErrors.trailingComma = -1;
      } else {
        refDestructuringErrors = new DestructuringErrors();
        ownDestructuringErrors = true;
      }
      var startPos = this.start, startLoc = this.startLoc;
      if (this.type === types$1.parenL || this.type === types$1.name) {
        this.potentialArrowAt = this.start;
        this.potentialArrowInForAwait = forInit === "await";
      }
      var left = this.parseMaybeConditional(forInit, refDestructuringErrors);
      if (afterLeftParse) {
        left = afterLeftParse.call(this, left, startPos, startLoc);
      }
      if (this.type.isAssign) {
        var node = this.startNodeAt(startPos, startLoc);
        node.operator = this.value;
        if (this.type === types$1.eq) {
          left = this.toAssignable(left, false, refDestructuringErrors);
        }
        if (!ownDestructuringErrors) {
          refDestructuringErrors.parenthesizedAssign = refDestructuringErrors.trailingComma = refDestructuringErrors.doubleProto = -1;
        }
        if (refDestructuringErrors.shorthandAssign >= left.start) {
          refDestructuringErrors.shorthandAssign = -1;
        }
        if (this.type === types$1.eq) {
          this.checkLValPattern(left);
        } else {
          this.checkLValSimple(left);
        }
        node.left = left;
        this.next();
        node.right = this.parseMaybeAssign(forInit);
        if (oldDoubleProto > -1) {
          refDestructuringErrors.doubleProto = oldDoubleProto;
        }
        return this.finishNode(node, "AssignmentExpression");
      } else {
        if (ownDestructuringErrors) {
          this.checkExpressionErrors(refDestructuringErrors, true);
        }
      }
      if (oldParenAssign > -1) {
        refDestructuringErrors.parenthesizedAssign = oldParenAssign;
      }
      if (oldTrailingComma > -1) {
        refDestructuringErrors.trailingComma = oldTrailingComma;
      }
      return left;
    };
    pp$5.parseMaybeConditional = function(forInit, refDestructuringErrors) {
      var startPos = this.start, startLoc = this.startLoc;
      var expr = this.parseExprOps(forInit, refDestructuringErrors);
      if (this.checkExpressionErrors(refDestructuringErrors)) {
        return expr;
      }
      if (this.eat(types$1.question)) {
        var node = this.startNodeAt(startPos, startLoc);
        node.test = expr;
        node.consequent = this.parseMaybeAssign();
        this.expect(types$1.colon);
        node.alternate = this.parseMaybeAssign(forInit);
        return this.finishNode(node, "ConditionalExpression");
      }
      return expr;
    };
    pp$5.parseExprOps = function(forInit, refDestructuringErrors) {
      var startPos = this.start, startLoc = this.startLoc;
      var expr = this.parseMaybeUnary(refDestructuringErrors, false, false, forInit);
      if (this.checkExpressionErrors(refDestructuringErrors)) {
        return expr;
      }
      return expr.start === startPos && expr.type === "ArrowFunctionExpression" ? expr : this.parseExprOp(expr, startPos, startLoc, -1, forInit);
    };
    pp$5.parseExprOp = function(left, leftStartPos, leftStartLoc, minPrec, forInit) {
      var prec = this.type.binop;
      if (prec != null && (!forInit || this.type !== types$1._in)) {
        if (prec > minPrec) {
          var logical = this.type === types$1.logicalOR || this.type === types$1.logicalAND;
          var coalesce = this.type === types$1.coalesce;
          if (coalesce) {
            prec = types$1.logicalAND.binop;
          }
          var op = this.value;
          this.next();
          var startPos = this.start, startLoc = this.startLoc;
          var right = this.parseExprOp(this.parseMaybeUnary(null, false, false, forInit), startPos, startLoc, prec, forInit);
          var node = this.buildBinary(leftStartPos, leftStartLoc, left, right, op, logical || coalesce);
          if (logical && this.type === types$1.coalesce || coalesce && (this.type === types$1.logicalOR || this.type === types$1.logicalAND)) {
            this.raiseRecoverable(this.start, "Logical expressions and coalesce expressions cannot be mixed. Wrap either by parentheses");
          }
          return this.parseExprOp(node, leftStartPos, leftStartLoc, minPrec, forInit);
        }
      }
      return left;
    };
    pp$5.buildBinary = function(startPos, startLoc, left, right, op, logical) {
      if (right.type === "PrivateIdentifier") {
        this.raise(right.start, "Private identifier can only be left side of binary expression");
      }
      var node = this.startNodeAt(startPos, startLoc);
      node.left = left;
      node.operator = op;
      node.right = right;
      return this.finishNode(node, logical ? "LogicalExpression" : "BinaryExpression");
    };
    pp$5.parseMaybeUnary = function(refDestructuringErrors, sawUnary, incDec, forInit) {
      var startPos = this.start, startLoc = this.startLoc, expr;
      if (this.isContextual("await") && this.canAwait) {
        expr = this.parseAwait(forInit);
        sawUnary = true;
      } else if (this.type.prefix) {
        var node = this.startNode(), update = this.type === types$1.incDec;
        node.operator = this.value;
        node.prefix = true;
        this.next();
        node.argument = this.parseMaybeUnary(null, true, update, forInit);
        this.checkExpressionErrors(refDestructuringErrors, true);
        if (update) {
          this.checkLValSimple(node.argument);
        } else if (this.strict && node.operator === "delete" && isLocalVariableAccess(node.argument)) {
          this.raiseRecoverable(node.start, "Deleting local variable in strict mode");
        } else if (node.operator === "delete" && isPrivateFieldAccess(node.argument)) {
          this.raiseRecoverable(node.start, "Private fields can not be deleted");
        } else {
          sawUnary = true;
        }
        expr = this.finishNode(node, update ? "UpdateExpression" : "UnaryExpression");
      } else if (!sawUnary && this.type === types$1.privateId) {
        if ((forInit || this.privateNameStack.length === 0) && this.options.checkPrivateFields) {
          this.unexpected();
        }
        expr = this.parsePrivateIdent();
        if (this.type !== types$1._in) {
          this.unexpected();
        }
      } else {
        expr = this.parseExprSubscripts(refDestructuringErrors, forInit);
        if (this.checkExpressionErrors(refDestructuringErrors)) {
          return expr;
        }
        while (this.type.postfix && !this.canInsertSemicolon()) {
          var node$1 = this.startNodeAt(startPos, startLoc);
          node$1.operator = this.value;
          node$1.prefix = false;
          node$1.argument = expr;
          this.checkLValSimple(expr);
          this.next();
          expr = this.finishNode(node$1, "UpdateExpression");
        }
      }
      if (!incDec && this.eat(types$1.starstar)) {
        if (sawUnary) {
          this.unexpected(this.lastTokStart);
        } else {
          return this.buildBinary(startPos, startLoc, expr, this.parseMaybeUnary(null, false, false, forInit), "**", false);
        }
      } else {
        return expr;
      }
    };
    pp$5.parseExprSubscripts = function(refDestructuringErrors, forInit) {
      var startPos = this.start, startLoc = this.startLoc;
      var expr = this.parseExprAtom(refDestructuringErrors, forInit);
      if (expr.type === "ArrowFunctionExpression" && this.input.slice(this.lastTokStart, this.lastTokEnd) !== ")") {
        return expr;
      }
      var result = this.parseSubscripts(expr, startPos, startLoc, false, forInit);
      if (refDestructuringErrors && result.type === "MemberExpression") {
        if (refDestructuringErrors.parenthesizedAssign >= result.start) {
          refDestructuringErrors.parenthesizedAssign = -1;
        }
        if (refDestructuringErrors.parenthesizedBind >= result.start) {
          refDestructuringErrors.parenthesizedBind = -1;
        }
        if (refDestructuringErrors.trailingComma >= result.start) {
          refDestructuringErrors.trailingComma = -1;
        }
      }
      return result;
    };
    pp$5.parseSubscripts = function(base, startPos, startLoc, noCalls, forInit) {
      var maybeAsyncArrow = this.options.ecmaVersion >= 8 && base.type === "Identifier" && base.name === "async" && this.lastTokEnd === base.end && !this.canInsertSemicolon() && base.end - base.start === 5 && this.potentialArrowAt === base.start;
      var optionalChained = false;
      while (true) {
        var element = this.parseSubscript(base, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit);
        if (element.optional) {
          optionalChained = true;
        }
        if (element === base || element.type === "ArrowFunctionExpression") {
          if (optionalChained) {
            var chainNode = this.startNodeAt(startPos, startLoc);
            chainNode.expression = element;
            element = this.finishNode(chainNode, "ChainExpression");
          }
          return element;
        }
        base = element;
      }
    };
    pp$5.shouldParseAsyncArrow = function() {
      return !this.canInsertSemicolon() && this.eat(types$1.arrow);
    };
    pp$5.parseSubscriptAsyncArrow = function(startPos, startLoc, exprList, forInit) {
      return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList, true, forInit);
    };
    pp$5.parseSubscript = function(base, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit) {
      var optionalSupported = this.options.ecmaVersion >= 11;
      var optional = optionalSupported && this.eat(types$1.questionDot);
      if (noCalls && optional) {
        this.raise(this.lastTokStart, "Optional chaining cannot appear in the callee of new expressions");
      }
      var computed = this.eat(types$1.bracketL);
      if (computed || optional && this.type !== types$1.parenL && this.type !== types$1.backQuote || this.eat(types$1.dot)) {
        var node = this.startNodeAt(startPos, startLoc);
        node.object = base;
        if (computed) {
          node.property = this.parseExpression();
          this.expect(types$1.bracketR);
        } else if (this.type === types$1.privateId && base.type !== "Super") {
          node.property = this.parsePrivateIdent();
        } else {
          node.property = this.parseIdent(this.options.allowReserved !== "never");
        }
        node.computed = !!computed;
        if (optionalSupported) {
          node.optional = optional;
        }
        base = this.finishNode(node, "MemberExpression");
      } else if (!noCalls && this.eat(types$1.parenL)) {
        var refDestructuringErrors = new DestructuringErrors(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
        this.yieldPos = 0;
        this.awaitPos = 0;
        this.awaitIdentPos = 0;
        var exprList = this.parseExprList(types$1.parenR, this.options.ecmaVersion >= 8, false, refDestructuringErrors);
        if (maybeAsyncArrow && !optional && this.shouldParseAsyncArrow()) {
          this.checkPatternErrors(refDestructuringErrors, false);
          this.checkYieldAwaitInDefaultParams();
          if (this.awaitIdentPos > 0) {
            this.raise(this.awaitIdentPos, "Cannot use 'await' as identifier inside an async function");
          }
          this.yieldPos = oldYieldPos;
          this.awaitPos = oldAwaitPos;
          this.awaitIdentPos = oldAwaitIdentPos;
          return this.parseSubscriptAsyncArrow(startPos, startLoc, exprList, forInit);
        }
        this.checkExpressionErrors(refDestructuringErrors, true);
        this.yieldPos = oldYieldPos || this.yieldPos;
        this.awaitPos = oldAwaitPos || this.awaitPos;
        this.awaitIdentPos = oldAwaitIdentPos || this.awaitIdentPos;
        var node$1 = this.startNodeAt(startPos, startLoc);
        node$1.callee = base;
        node$1.arguments = exprList;
        if (optionalSupported) {
          node$1.optional = optional;
        }
        base = this.finishNode(node$1, "CallExpression");
      } else if (this.type === types$1.backQuote) {
        if (optional || optionalChained) {
          this.raise(this.start, "Optional chaining cannot appear in the tag of tagged template expressions");
        }
        var node$2 = this.startNodeAt(startPos, startLoc);
        node$2.tag = base;
        node$2.quasi = this.parseTemplate({ isTagged: true });
        base = this.finishNode(node$2, "TaggedTemplateExpression");
      }
      return base;
    };
    pp$5.parseExprAtom = function(refDestructuringErrors, forInit, forNew) {
      if (this.type === types$1.slash) {
        this.readRegexp();
      }
      var node, canBeArrow = this.potentialArrowAt === this.start;
      switch (this.type) {
        case types$1._super:
          if (!this.allowSuper) {
            this.raise(this.start, "'super' keyword outside a method");
          }
          node = this.startNode();
          this.next();
          if (this.type === types$1.parenL && !this.allowDirectSuper) {
            this.raise(node.start, "super() call outside constructor of a subclass");
          }
          if (this.type !== types$1.dot && this.type !== types$1.bracketL && this.type !== types$1.parenL) {
            this.unexpected();
          }
          return this.finishNode(node, "Super");
        case types$1._this:
          node = this.startNode();
          this.next();
          return this.finishNode(node, "ThisExpression");
        case types$1.name:
          var startPos = this.start, startLoc = this.startLoc, containsEsc = this.containsEsc;
          var id = this.parseIdent(false);
          if (this.options.ecmaVersion >= 8 && !containsEsc && id.name === "async" && !this.canInsertSemicolon() && this.eat(types$1._function)) {
            this.overrideContext(types.f_expr);
            return this.parseFunction(this.startNodeAt(startPos, startLoc), 0, false, true, forInit);
          }
          if (canBeArrow && !this.canInsertSemicolon()) {
            if (this.eat(types$1.arrow)) {
              return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id], false, forInit);
            }
            if (this.options.ecmaVersion >= 8 && id.name === "async" && this.type === types$1.name && !containsEsc && (!this.potentialArrowInForAwait || this.value !== "of" || this.containsEsc)) {
              id = this.parseIdent(false);
              if (this.canInsertSemicolon() || !this.eat(types$1.arrow)) {
                this.unexpected();
              }
              return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id], true, forInit);
            }
          }
          return id;
        case types$1.regexp:
          var value = this.value;
          node = this.parseLiteral(value.value);
          node.regex = { pattern: value.pattern, flags: value.flags };
          return node;
        case types$1.num:
        case types$1.string:
          return this.parseLiteral(this.value);
        case types$1._null:
        case types$1._true:
        case types$1._false:
          node = this.startNode();
          node.value = this.type === types$1._null ? null : this.type === types$1._true;
          node.raw = this.type.keyword;
          this.next();
          return this.finishNode(node, "Literal");
        case types$1.parenL:
          var start = this.start, expr = this.parseParenAndDistinguishExpression(canBeArrow, forInit);
          if (refDestructuringErrors) {
            if (refDestructuringErrors.parenthesizedAssign < 0 && !this.isSimpleAssignTarget(expr)) {
              refDestructuringErrors.parenthesizedAssign = start;
            }
            if (refDestructuringErrors.parenthesizedBind < 0) {
              refDestructuringErrors.parenthesizedBind = start;
            }
          }
          return expr;
        case types$1.bracketL:
          node = this.startNode();
          this.next();
          node.elements = this.parseExprList(types$1.bracketR, true, true, refDestructuringErrors);
          return this.finishNode(node, "ArrayExpression");
        case types$1.braceL:
          this.overrideContext(types.b_expr);
          return this.parseObj(false, refDestructuringErrors);
        case types$1._function:
          node = this.startNode();
          this.next();
          return this.parseFunction(node, 0);
        case types$1._class:
          return this.parseClass(this.startNode(), false);
        case types$1._new:
          return this.parseNew();
        case types$1.backQuote:
          return this.parseTemplate();
        case types$1._import:
          if (this.options.ecmaVersion >= 11) {
            return this.parseExprImport(forNew);
          } else {
            return this.unexpected();
          }
        default:
          return this.parseExprAtomDefault();
      }
    };
    pp$5.parseExprAtomDefault = function() {
      this.unexpected();
    };
    pp$5.parseExprImport = function(forNew) {
      var node = this.startNode();
      if (this.containsEsc) {
        this.raiseRecoverable(this.start, "Escape sequence in keyword import");
      }
      this.next();
      if (this.type === types$1.parenL && !forNew) {
        return this.parseDynamicImport(node);
      } else if (this.type === types$1.dot) {
        var meta = this.startNodeAt(node.start, node.loc && node.loc.start);
        meta.name = "import";
        node.meta = this.finishNode(meta, "Identifier");
        return this.parseImportMeta(node);
      } else {
        this.unexpected();
      }
    };
    pp$5.parseDynamicImport = function(node) {
      this.next();
      node.source = this.parseMaybeAssign();
      if (this.options.ecmaVersion >= 16) {
        if (!this.eat(types$1.parenR)) {
          this.expect(types$1.comma);
          if (!this.afterTrailingComma(types$1.parenR)) {
            node.options = this.parseMaybeAssign();
            if (!this.eat(types$1.parenR)) {
              this.expect(types$1.comma);
              if (!this.afterTrailingComma(types$1.parenR)) {
                this.unexpected();
              }
            }
          } else {
            node.options = null;
          }
        } else {
          node.options = null;
        }
      } else {
        if (!this.eat(types$1.parenR)) {
          var errorPos = this.start;
          if (this.eat(types$1.comma) && this.eat(types$1.parenR)) {
            this.raiseRecoverable(errorPos, "Trailing comma is not allowed in import()");
          } else {
            this.unexpected(errorPos);
          }
        }
      }
      return this.finishNode(node, "ImportExpression");
    };
    pp$5.parseImportMeta = function(node) {
      this.next();
      var containsEsc = this.containsEsc;
      node.property = this.parseIdent(true);
      if (node.property.name !== "meta") {
        this.raiseRecoverable(node.property.start, "The only valid meta property for import is 'import.meta'");
      }
      if (containsEsc) {
        this.raiseRecoverable(node.start, "'import.meta' must not contain escaped characters");
      }
      if (this.options.sourceType !== "module" && !this.options.allowImportExportEverywhere) {
        this.raiseRecoverable(node.start, "Cannot use 'import.meta' outside a module");
      }
      return this.finishNode(node, "MetaProperty");
    };
    pp$5.parseLiteral = function(value) {
      var node = this.startNode();
      node.value = value;
      node.raw = this.input.slice(this.start, this.end);
      if (node.raw.charCodeAt(node.raw.length - 1) === 110) {
        node.bigint = node.value != null ? node.value.toString() : node.raw.slice(0, -1).replace(/_/g, "");
      }
      this.next();
      return this.finishNode(node, "Literal");
    };
    pp$5.parseParenExpression = function() {
      this.expect(types$1.parenL);
      var val = this.parseExpression();
      this.expect(types$1.parenR);
      return val;
    };
    pp$5.shouldParseArrow = function(exprList) {
      return !this.canInsertSemicolon();
    };
    pp$5.parseParenAndDistinguishExpression = function(canBeArrow, forInit) {
      var startPos = this.start, startLoc = this.startLoc, val, allowTrailingComma = this.options.ecmaVersion >= 8;
      if (this.options.ecmaVersion >= 6) {
        this.next();
        var innerStartPos = this.start, innerStartLoc = this.startLoc;
        var exprList = [], first = true, lastIsComma = false;
        var refDestructuringErrors = new DestructuringErrors(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, spreadStart;
        this.yieldPos = 0;
        this.awaitPos = 0;
        while (this.type !== types$1.parenR) {
          first ? first = false : this.expect(types$1.comma);
          if (allowTrailingComma && this.afterTrailingComma(types$1.parenR, true)) {
            lastIsComma = true;
            break;
          } else if (this.type === types$1.ellipsis) {
            spreadStart = this.start;
            exprList.push(this.parseParenItem(this.parseRestBinding()));
            if (this.type === types$1.comma) {
              this.raiseRecoverable(
                this.start,
                "Comma is not permitted after the rest element"
              );
            }
            break;
          } else {
            exprList.push(this.parseMaybeAssign(false, refDestructuringErrors, this.parseParenItem));
          }
        }
        var innerEndPos = this.lastTokEnd, innerEndLoc = this.lastTokEndLoc;
        this.expect(types$1.parenR);
        if (canBeArrow && this.shouldParseArrow(exprList) && this.eat(types$1.arrow)) {
          this.checkPatternErrors(refDestructuringErrors, false);
          this.checkYieldAwaitInDefaultParams();
          this.yieldPos = oldYieldPos;
          this.awaitPos = oldAwaitPos;
          return this.parseParenArrowList(startPos, startLoc, exprList, forInit);
        }
        if (!exprList.length || lastIsComma) {
          this.unexpected(this.lastTokStart);
        }
        if (spreadStart) {
          this.unexpected(spreadStart);
        }
        this.checkExpressionErrors(refDestructuringErrors, true);
        this.yieldPos = oldYieldPos || this.yieldPos;
        this.awaitPos = oldAwaitPos || this.awaitPos;
        if (exprList.length > 1) {
          val = this.startNodeAt(innerStartPos, innerStartLoc);
          val.expressions = exprList;
          this.finishNodeAt(val, "SequenceExpression", innerEndPos, innerEndLoc);
        } else {
          val = exprList[0];
        }
      } else {
        val = this.parseParenExpression();
      }
      if (this.options.preserveParens) {
        var par = this.startNodeAt(startPos, startLoc);
        par.expression = val;
        return this.finishNode(par, "ParenthesizedExpression");
      } else {
        return val;
      }
    };
    pp$5.parseParenItem = function(item) {
      return item;
    };
    pp$5.parseParenArrowList = function(startPos, startLoc, exprList, forInit) {
      return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList, false, forInit);
    };
    empty = [];
    pp$5.parseNew = function() {
      if (this.containsEsc) {
        this.raiseRecoverable(this.start, "Escape sequence in keyword new");
      }
      var node = this.startNode();
      this.next();
      if (this.options.ecmaVersion >= 6 && this.type === types$1.dot) {
        var meta = this.startNodeAt(node.start, node.loc && node.loc.start);
        meta.name = "new";
        node.meta = this.finishNode(meta, "Identifier");
        this.next();
        var containsEsc = this.containsEsc;
        node.property = this.parseIdent(true);
        if (node.property.name !== "target") {
          this.raiseRecoverable(node.property.start, "The only valid meta property for new is 'new.target'");
        }
        if (containsEsc) {
          this.raiseRecoverable(node.start, "'new.target' must not contain escaped characters");
        }
        if (!this.allowNewDotTarget) {
          this.raiseRecoverable(node.start, "'new.target' can only be used in functions and class static block");
        }
        return this.finishNode(node, "MetaProperty");
      }
      var startPos = this.start, startLoc = this.startLoc;
      node.callee = this.parseSubscripts(this.parseExprAtom(null, false, true), startPos, startLoc, true, false);
      if (this.eat(types$1.parenL)) {
        node.arguments = this.parseExprList(types$1.parenR, this.options.ecmaVersion >= 8, false);
      } else {
        node.arguments = empty;
      }
      return this.finishNode(node, "NewExpression");
    };
    pp$5.parseTemplateElement = function(ref2) {
      var isTagged = ref2.isTagged;
      var elem = this.startNode();
      if (this.type === types$1.invalidTemplate) {
        if (!isTagged) {
          this.raiseRecoverable(this.start, "Bad escape sequence in untagged template literal");
        }
        elem.value = {
          raw: this.value.replace(/\r\n?/g, "\n"),
          cooked: null
        };
      } else {
        elem.value = {
          raw: this.input.slice(this.start, this.end).replace(/\r\n?/g, "\n"),
          cooked: this.value
        };
      }
      this.next();
      elem.tail = this.type === types$1.backQuote;
      return this.finishNode(elem, "TemplateElement");
    };
    pp$5.parseTemplate = function(ref2) {
      if (ref2 === void 0) ref2 = {};
      var isTagged = ref2.isTagged;
      if (isTagged === void 0) isTagged = false;
      var node = this.startNode();
      this.next();
      node.expressions = [];
      var curElt = this.parseTemplateElement({ isTagged });
      node.quasis = [curElt];
      while (!curElt.tail) {
        if (this.type === types$1.eof) {
          this.raise(this.pos, "Unterminated template literal");
        }
        this.expect(types$1.dollarBraceL);
        node.expressions.push(this.parseExpression());
        this.expect(types$1.braceR);
        node.quasis.push(curElt = this.parseTemplateElement({ isTagged }));
      }
      this.next();
      return this.finishNode(node, "TemplateLiteral");
    };
    pp$5.isAsyncProp = function(prop) {
      return !prop.computed && prop.key.type === "Identifier" && prop.key.name === "async" && (this.type === types$1.name || this.type === types$1.num || this.type === types$1.string || this.type === types$1.bracketL || this.type.keyword || this.options.ecmaVersion >= 9 && this.type === types$1.star) && !lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
    };
    pp$5.parseObj = function(isPattern, refDestructuringErrors) {
      var node = this.startNode(), first = true, propHash = {};
      node.properties = [];
      this.next();
      while (!this.eat(types$1.braceR)) {
        if (!first) {
          this.expect(types$1.comma);
          if (this.options.ecmaVersion >= 5 && this.afterTrailingComma(types$1.braceR)) {
            break;
          }
        } else {
          first = false;
        }
        var prop = this.parseProperty(isPattern, refDestructuringErrors);
        if (!isPattern) {
          this.checkPropClash(prop, propHash, refDestructuringErrors);
        }
        node.properties.push(prop);
      }
      return this.finishNode(node, isPattern ? "ObjectPattern" : "ObjectExpression");
    };
    pp$5.parseProperty = function(isPattern, refDestructuringErrors) {
      var prop = this.startNode(), isGenerator, isAsync, startPos, startLoc;
      if (this.options.ecmaVersion >= 9 && this.eat(types$1.ellipsis)) {
        if (isPattern) {
          prop.argument = this.parseIdent(false);
          if (this.type === types$1.comma) {
            this.raiseRecoverable(this.start, "Comma is not permitted after the rest element");
          }
          return this.finishNode(prop, "RestElement");
        }
        prop.argument = this.parseMaybeAssign(false, refDestructuringErrors);
        if (this.type === types$1.comma && refDestructuringErrors && refDestructuringErrors.trailingComma < 0) {
          refDestructuringErrors.trailingComma = this.start;
        }
        return this.finishNode(prop, "SpreadElement");
      }
      if (this.options.ecmaVersion >= 6) {
        prop.method = false;
        prop.shorthand = false;
        if (isPattern || refDestructuringErrors) {
          startPos = this.start;
          startLoc = this.startLoc;
        }
        if (!isPattern) {
          isGenerator = this.eat(types$1.star);
        }
      }
      var containsEsc = this.containsEsc;
      this.parsePropertyName(prop);
      if (!isPattern && !containsEsc && this.options.ecmaVersion >= 8 && !isGenerator && this.isAsyncProp(prop)) {
        isAsync = true;
        isGenerator = this.options.ecmaVersion >= 9 && this.eat(types$1.star);
        this.parsePropertyName(prop);
      } else {
        isAsync = false;
      }
      this.parsePropertyValue(prop, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc);
      return this.finishNode(prop, "Property");
    };
    pp$5.parseGetterSetter = function(prop) {
      var kind = prop.key.name;
      this.parsePropertyName(prop);
      prop.value = this.parseMethod(false);
      prop.kind = kind;
      var paramCount = prop.kind === "get" ? 0 : 1;
      if (prop.value.params.length !== paramCount) {
        var start = prop.value.start;
        if (prop.kind === "get") {
          this.raiseRecoverable(start, "getter should have no params");
        } else {
          this.raiseRecoverable(start, "setter should have exactly one param");
        }
      } else {
        if (prop.kind === "set" && prop.value.params[0].type === "RestElement") {
          this.raiseRecoverable(prop.value.params[0].start, "Setter cannot use rest params");
        }
      }
    };
    pp$5.parsePropertyValue = function(prop, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc) {
      if ((isGenerator || isAsync) && this.type === types$1.colon) {
        this.unexpected();
      }
      if (this.eat(types$1.colon)) {
        prop.value = isPattern ? this.parseMaybeDefault(this.start, this.startLoc) : this.parseMaybeAssign(false, refDestructuringErrors);
        prop.kind = "init";
      } else if (this.options.ecmaVersion >= 6 && this.type === types$1.parenL) {
        if (isPattern) {
          this.unexpected();
        }
        prop.method = true;
        prop.value = this.parseMethod(isGenerator, isAsync);
        prop.kind = "init";
      } else if (!isPattern && !containsEsc && this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" && (prop.key.name === "get" || prop.key.name === "set") && (this.type !== types$1.comma && this.type !== types$1.braceR && this.type !== types$1.eq)) {
        if (isGenerator || isAsync) {
          this.unexpected();
        }
        this.parseGetterSetter(prop);
      } else if (this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier") {
        if (isGenerator || isAsync) {
          this.unexpected();
        }
        this.checkUnreserved(prop.key);
        if (prop.key.name === "await" && !this.awaitIdentPos) {
          this.awaitIdentPos = startPos;
        }
        if (isPattern) {
          prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key));
        } else if (this.type === types$1.eq && refDestructuringErrors) {
          if (refDestructuringErrors.shorthandAssign < 0) {
            refDestructuringErrors.shorthandAssign = this.start;
          }
          prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key));
        } else {
          prop.value = this.copyNode(prop.key);
        }
        prop.kind = "init";
        prop.shorthand = true;
      } else {
        this.unexpected();
      }
    };
    pp$5.parsePropertyName = function(prop) {
      if (this.options.ecmaVersion >= 6) {
        if (this.eat(types$1.bracketL)) {
          prop.computed = true;
          prop.key = this.parseMaybeAssign();
          this.expect(types$1.bracketR);
          return prop.key;
        } else {
          prop.computed = false;
        }
      }
      return prop.key = this.type === types$1.num || this.type === types$1.string ? this.parseExprAtom() : this.parseIdent(this.options.allowReserved !== "never");
    };
    pp$5.initFunction = function(node) {
      node.id = null;
      if (this.options.ecmaVersion >= 6) {
        node.generator = node.expression = false;
      }
      if (this.options.ecmaVersion >= 8) {
        node.async = false;
      }
    };
    pp$5.parseMethod = function(isGenerator, isAsync, allowDirectSuper) {
      var node = this.startNode(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
      this.initFunction(node);
      if (this.options.ecmaVersion >= 6) {
        node.generator = isGenerator;
      }
      if (this.options.ecmaVersion >= 8) {
        node.async = !!isAsync;
      }
      this.yieldPos = 0;
      this.awaitPos = 0;
      this.awaitIdentPos = 0;
      this.enterScope(functionFlags(isAsync, node.generator) | SCOPE_SUPER | (allowDirectSuper ? SCOPE_DIRECT_SUPER : 0));
      this.expect(types$1.parenL);
      node.params = this.parseBindingList(types$1.parenR, false, this.options.ecmaVersion >= 8);
      this.checkYieldAwaitInDefaultParams();
      this.parseFunctionBody(node, false, true, false);
      this.yieldPos = oldYieldPos;
      this.awaitPos = oldAwaitPos;
      this.awaitIdentPos = oldAwaitIdentPos;
      return this.finishNode(node, "FunctionExpression");
    };
    pp$5.parseArrowExpression = function(node, params, isAsync, forInit) {
      var oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
      this.enterScope(functionFlags(isAsync, false) | SCOPE_ARROW);
      this.initFunction(node);
      if (this.options.ecmaVersion >= 8) {
        node.async = !!isAsync;
      }
      this.yieldPos = 0;
      this.awaitPos = 0;
      this.awaitIdentPos = 0;
      node.params = this.toAssignableList(params, true);
      this.parseFunctionBody(node, true, false, forInit);
      this.yieldPos = oldYieldPos;
      this.awaitPos = oldAwaitPos;
      this.awaitIdentPos = oldAwaitIdentPos;
      return this.finishNode(node, "ArrowFunctionExpression");
    };
    pp$5.parseFunctionBody = function(node, isArrowFunction, isMethod, forInit) {
      var isExpression = isArrowFunction && this.type !== types$1.braceL;
      var oldStrict = this.strict, useStrict = false;
      if (isExpression) {
        node.body = this.parseMaybeAssign(forInit);
        node.expression = true;
        this.checkParams(node, false);
      } else {
        var nonSimple = this.options.ecmaVersion >= 7 && !this.isSimpleParamList(node.params);
        if (!oldStrict || nonSimple) {
          useStrict = this.strictDirective(this.end);
          if (useStrict && nonSimple) {
            this.raiseRecoverable(node.start, "Illegal 'use strict' directive in function with non-simple parameter list");
          }
        }
        var oldLabels = this.labels;
        this.labels = [];
        if (useStrict) {
          this.strict = true;
        }
        this.checkParams(node, !oldStrict && !useStrict && !isArrowFunction && !isMethod && this.isSimpleParamList(node.params));
        if (this.strict && node.id) {
          this.checkLValSimple(node.id, BIND_OUTSIDE);
        }
        node.body = this.parseBlock(false, void 0, useStrict && !oldStrict);
        node.expression = false;
        this.adaptDirectivePrologue(node.body.body);
        this.labels = oldLabels;
      }
      this.exitScope();
    };
    pp$5.isSimpleParamList = function(params) {
      for (var i = 0, list = params; i < list.length; i += 1) {
        var param = list[i];
        if (param.type !== "Identifier") {
          return false;
        }
      }
      return true;
    };
    pp$5.checkParams = function(node, allowDuplicates) {
      var nameHash = /* @__PURE__ */ Object.create(null);
      for (var i = 0, list = node.params; i < list.length; i += 1) {
        var param = list[i];
        this.checkLValInnerPattern(param, BIND_VAR, allowDuplicates ? null : nameHash);
      }
    };
    pp$5.parseExprList = function(close, allowTrailingComma, allowEmpty, refDestructuringErrors) {
      var elts = [], first = true;
      while (!this.eat(close)) {
        if (!first) {
          this.expect(types$1.comma);
          if (allowTrailingComma && this.afterTrailingComma(close)) {
            break;
          }
        } else {
          first = false;
        }
        var elt = void 0;
        if (allowEmpty && this.type === types$1.comma) {
          elt = null;
        } else if (this.type === types$1.ellipsis) {
          elt = this.parseSpread(refDestructuringErrors);
          if (refDestructuringErrors && this.type === types$1.comma && refDestructuringErrors.trailingComma < 0) {
            refDestructuringErrors.trailingComma = this.start;
          }
        } else {
          elt = this.parseMaybeAssign(false, refDestructuringErrors);
        }
        elts.push(elt);
      }
      return elts;
    };
    pp$5.checkUnreserved = function(ref2) {
      var start = ref2.start;
      var end = ref2.end;
      var name = ref2.name;
      if (this.inGenerator && name === "yield") {
        this.raiseRecoverable(start, "Cannot use 'yield' as identifier inside a generator");
      }
      if (this.inAsync && name === "await") {
        this.raiseRecoverable(start, "Cannot use 'await' as identifier inside an async function");
      }
      if (!(this.currentThisScope().flags & SCOPE_VAR) && name === "arguments") {
        this.raiseRecoverable(start, "Cannot use 'arguments' in class field initializer");
      }
      if (this.inClassStaticBlock && (name === "arguments" || name === "await")) {
        this.raise(start, "Cannot use " + name + " in class static initialization block");
      }
      if (this.keywords.test(name)) {
        this.raise(start, "Unexpected keyword '" + name + "'");
      }
      if (this.options.ecmaVersion < 6 && this.input.slice(start, end).indexOf("\\") !== -1) {
        return;
      }
      var re = this.strict ? this.reservedWordsStrict : this.reservedWords;
      if (re.test(name)) {
        if (!this.inAsync && name === "await") {
          this.raiseRecoverable(start, "Cannot use keyword 'await' outside an async function");
        }
        this.raiseRecoverable(start, "The keyword '" + name + "' is reserved");
      }
    };
    pp$5.parseIdent = function(liberal) {
      var node = this.parseIdentNode();
      this.next(!!liberal);
      this.finishNode(node, "Identifier");
      if (!liberal) {
        this.checkUnreserved(node);
        if (node.name === "await" && !this.awaitIdentPos) {
          this.awaitIdentPos = node.start;
        }
      }
      return node;
    };
    pp$5.parseIdentNode = function() {
      var node = this.startNode();
      if (this.type === types$1.name) {
        node.name = this.value;
      } else if (this.type.keyword) {
        node.name = this.type.keyword;
        if ((node.name === "class" || node.name === "function") && (this.lastTokEnd !== this.lastTokStart + 1 || this.input.charCodeAt(this.lastTokStart) !== 46)) {
          this.context.pop();
        }
        this.type = types$1.name;
      } else {
        this.unexpected();
      }
      return node;
    };
    pp$5.parsePrivateIdent = function() {
      var node = this.startNode();
      if (this.type === types$1.privateId) {
        node.name = this.value;
      } else {
        this.unexpected();
      }
      this.next();
      this.finishNode(node, "PrivateIdentifier");
      if (this.options.checkPrivateFields) {
        if (this.privateNameStack.length === 0) {
          this.raise(node.start, "Private field '#" + node.name + "' must be declared in an enclosing class");
        } else {
          this.privateNameStack[this.privateNameStack.length - 1].used.push(node);
        }
      }
      return node;
    };
    pp$5.parseYield = function(forInit) {
      if (!this.yieldPos) {
        this.yieldPos = this.start;
      }
      var node = this.startNode();
      this.next();
      if (this.type === types$1.semi || this.canInsertSemicolon() || this.type !== types$1.star && !this.type.startsExpr) {
        node.delegate = false;
        node.argument = null;
      } else {
        node.delegate = this.eat(types$1.star);
        node.argument = this.parseMaybeAssign(forInit);
      }
      return this.finishNode(node, "YieldExpression");
    };
    pp$5.parseAwait = function(forInit) {
      if (!this.awaitPos) {
        this.awaitPos = this.start;
      }
      var node = this.startNode();
      this.next();
      node.argument = this.parseMaybeUnary(null, true, false, forInit);
      return this.finishNode(node, "AwaitExpression");
    };
    pp$4 = Parser.prototype;
    pp$4.raise = function(pos, message) {
      var loc = getLineInfo(this.input, pos);
      message += " (" + loc.line + ":" + loc.column + ")";
      if (this.sourceFile) {
        message += " in " + this.sourceFile;
      }
      var err = new SyntaxError(message);
      err.pos = pos;
      err.loc = loc;
      err.raisedAt = this.pos;
      throw err;
    };
    pp$4.raiseRecoverable = pp$4.raise;
    pp$4.curPosition = function() {
      if (this.options.locations) {
        return new Position(this.curLine, this.pos - this.lineStart);
      }
    };
    pp$3 = Parser.prototype;
    Scope = function Scope2(flags) {
      this.flags = flags;
      this.var = [];
      this.lexical = [];
      this.functions = [];
    };
    pp$3.enterScope = function(flags) {
      this.scopeStack.push(new Scope(flags));
    };
    pp$3.exitScope = function() {
      this.scopeStack.pop();
    };
    pp$3.treatFunctionsAsVarInScope = function(scope) {
      return scope.flags & SCOPE_FUNCTION || !this.inModule && scope.flags & SCOPE_TOP;
    };
    pp$3.declareName = function(name, bindingType, pos) {
      var redeclared = false;
      if (bindingType === BIND_LEXICAL) {
        var scope = this.currentScope();
        redeclared = scope.lexical.indexOf(name) > -1 || scope.functions.indexOf(name) > -1 || scope.var.indexOf(name) > -1;
        scope.lexical.push(name);
        if (this.inModule && scope.flags & SCOPE_TOP) {
          delete this.undefinedExports[name];
        }
      } else if (bindingType === BIND_SIMPLE_CATCH) {
        var scope$1 = this.currentScope();
        scope$1.lexical.push(name);
      } else if (bindingType === BIND_FUNCTION) {
        var scope$2 = this.currentScope();
        if (this.treatFunctionsAsVar) {
          redeclared = scope$2.lexical.indexOf(name) > -1;
        } else {
          redeclared = scope$2.lexical.indexOf(name) > -1 || scope$2.var.indexOf(name) > -1;
        }
        scope$2.functions.push(name);
      } else {
        for (var i = this.scopeStack.length - 1; i >= 0; --i) {
          var scope$3 = this.scopeStack[i];
          if (scope$3.lexical.indexOf(name) > -1 && !(scope$3.flags & SCOPE_SIMPLE_CATCH && scope$3.lexical[0] === name) || !this.treatFunctionsAsVarInScope(scope$3) && scope$3.functions.indexOf(name) > -1) {
            redeclared = true;
            break;
          }
          scope$3.var.push(name);
          if (this.inModule && scope$3.flags & SCOPE_TOP) {
            delete this.undefinedExports[name];
          }
          if (scope$3.flags & SCOPE_VAR) {
            break;
          }
        }
      }
      if (redeclared) {
        this.raiseRecoverable(pos, "Identifier '" + name + "' has already been declared");
      }
    };
    pp$3.checkLocalExport = function(id) {
      if (this.scopeStack[0].lexical.indexOf(id.name) === -1 && this.scopeStack[0].var.indexOf(id.name) === -1) {
        this.undefinedExports[id.name] = id;
      }
    };
    pp$3.currentScope = function() {
      return this.scopeStack[this.scopeStack.length - 1];
    };
    pp$3.currentVarScope = function() {
      for (var i = this.scopeStack.length - 1; ; i--) {
        var scope = this.scopeStack[i];
        if (scope.flags & (SCOPE_VAR | SCOPE_CLASS_FIELD_INIT | SCOPE_CLASS_STATIC_BLOCK)) {
          return scope;
        }
      }
    };
    pp$3.currentThisScope = function() {
      for (var i = this.scopeStack.length - 1; ; i--) {
        var scope = this.scopeStack[i];
        if (scope.flags & (SCOPE_VAR | SCOPE_CLASS_FIELD_INIT | SCOPE_CLASS_STATIC_BLOCK) && !(scope.flags & SCOPE_ARROW)) {
          return scope;
        }
      }
    };
    Node = function Node2(parser, pos, loc) {
      this.type = "";
      this.start = pos;
      this.end = 0;
      if (parser.options.locations) {
        this.loc = new SourceLocation(parser, loc);
      }
      if (parser.options.directSourceFile) {
        this.sourceFile = parser.options.directSourceFile;
      }
      if (parser.options.ranges) {
        this.range = [pos, 0];
      }
    };
    pp$2 = Parser.prototype;
    pp$2.startNode = function() {
      return new Node(this, this.start, this.startLoc);
    };
    pp$2.startNodeAt = function(pos, loc) {
      return new Node(this, pos, loc);
    };
    pp$2.finishNode = function(node, type) {
      return finishNodeAt.call(this, node, type, this.lastTokEnd, this.lastTokEndLoc);
    };
    pp$2.finishNodeAt = function(node, type, pos, loc) {
      return finishNodeAt.call(this, node, type, pos, loc);
    };
    pp$2.copyNode = function(node) {
      var newNode = new Node(this, node.start, this.startLoc);
      for (var prop in node) {
        newNode[prop] = node[prop];
      }
      return newNode;
    };
    scriptValuesAddedInUnicode = "Berf Beria_Erfe Gara Garay Gukh Gurung_Khema Hrkt Katakana_Or_Hiragana Kawi Kirat_Rai Krai Nag_Mundari Nagm Ol_Onal Onao Sidetic Sidt Sunu Sunuwar Tai_Yo Tayo Todhri Todr Tolong_Siki Tols Tulu_Tigalari Tutg Unknown Zzzz";
    ecma9BinaryProperties = "ASCII ASCII_Hex_Digit AHex Alphabetic Alpha Any Assigned Bidi_Control Bidi_C Bidi_Mirrored Bidi_M Case_Ignorable CI Cased Changes_When_Casefolded CWCF Changes_When_Casemapped CWCM Changes_When_Lowercased CWL Changes_When_NFKC_Casefolded CWKCF Changes_When_Titlecased CWT Changes_When_Uppercased CWU Dash Default_Ignorable_Code_Point DI Deprecated Dep Diacritic Dia Emoji Emoji_Component Emoji_Modifier Emoji_Modifier_Base Emoji_Presentation Extender Ext Grapheme_Base Gr_Base Grapheme_Extend Gr_Ext Hex_Digit Hex IDS_Binary_Operator IDSB IDS_Trinary_Operator IDST ID_Continue IDC ID_Start IDS Ideographic Ideo Join_Control Join_C Logical_Order_Exception LOE Lowercase Lower Math Noncharacter_Code_Point NChar Pattern_Syntax Pat_Syn Pattern_White_Space Pat_WS Quotation_Mark QMark Radical Regional_Indicator RI Sentence_Terminal STerm Soft_Dotted SD Terminal_Punctuation Term Unified_Ideograph UIdeo Uppercase Upper Variation_Selector VS White_Space space XID_Continue XIDC XID_Start XIDS";
    ecma10BinaryProperties = ecma9BinaryProperties + " Extended_Pictographic";
    ecma11BinaryProperties = ecma10BinaryProperties;
    ecma12BinaryProperties = ecma11BinaryProperties + " EBase EComp EMod EPres ExtPict";
    ecma13BinaryProperties = ecma12BinaryProperties;
    ecma14BinaryProperties = ecma13BinaryProperties;
    unicodeBinaryProperties = {
      9: ecma9BinaryProperties,
      10: ecma10BinaryProperties,
      11: ecma11BinaryProperties,
      12: ecma12BinaryProperties,
      13: ecma13BinaryProperties,
      14: ecma14BinaryProperties
    };
    ecma14BinaryPropertiesOfStrings = "Basic_Emoji Emoji_Keycap_Sequence RGI_Emoji_Modifier_Sequence RGI_Emoji_Flag_Sequence RGI_Emoji_Tag_Sequence RGI_Emoji_ZWJ_Sequence RGI_Emoji";
    unicodeBinaryPropertiesOfStrings = {
      9: "",
      10: "",
      11: "",
      12: "",
      13: "",
      14: ecma14BinaryPropertiesOfStrings
    };
    unicodeGeneralCategoryValues = "Cased_Letter LC Close_Punctuation Pe Connector_Punctuation Pc Control Cc cntrl Currency_Symbol Sc Dash_Punctuation Pd Decimal_Number Nd digit Enclosing_Mark Me Final_Punctuation Pf Format Cf Initial_Punctuation Pi Letter L Letter_Number Nl Line_Separator Zl Lowercase_Letter Ll Mark M Combining_Mark Math_Symbol Sm Modifier_Letter Lm Modifier_Symbol Sk Nonspacing_Mark Mn Number N Open_Punctuation Ps Other C Other_Letter Lo Other_Number No Other_Punctuation Po Other_Symbol So Paragraph_Separator Zp Private_Use Co Punctuation P punct Separator Z Space_Separator Zs Spacing_Mark Mc Surrogate Cs Symbol S Titlecase_Letter Lt Unassigned Cn Uppercase_Letter Lu";
    ecma9ScriptValues = "Adlam Adlm Ahom Anatolian_Hieroglyphs Hluw Arabic Arab Armenian Armn Avestan Avst Balinese Bali Bamum Bamu Bassa_Vah Bass Batak Batk Bengali Beng Bhaiksuki Bhks Bopomofo Bopo Brahmi Brah Braille Brai Buginese Bugi Buhid Buhd Canadian_Aboriginal Cans Carian Cari Caucasian_Albanian Aghb Chakma Cakm Cham Cham Cherokee Cher Common Zyyy Coptic Copt Qaac Cuneiform Xsux Cypriot Cprt Cyrillic Cyrl Deseret Dsrt Devanagari Deva Duployan Dupl Egyptian_Hieroglyphs Egyp Elbasan Elba Ethiopic Ethi Georgian Geor Glagolitic Glag Gothic Goth Grantha Gran Greek Grek Gujarati Gujr Gurmukhi Guru Han Hani Hangul Hang Hanunoo Hano Hatran Hatr Hebrew Hebr Hiragana Hira Imperial_Aramaic Armi Inherited Zinh Qaai Inscriptional_Pahlavi Phli Inscriptional_Parthian Prti Javanese Java Kaithi Kthi Kannada Knda Katakana Kana Kayah_Li Kali Kharoshthi Khar Khmer Khmr Khojki Khoj Khudawadi Sind Lao Laoo Latin Latn Lepcha Lepc Limbu Limb Linear_A Lina Linear_B Linb Lisu Lisu Lycian Lyci Lydian Lydi Mahajani Mahj Malayalam Mlym Mandaic Mand Manichaean Mani Marchen Marc Masaram_Gondi Gonm Meetei_Mayek Mtei Mende_Kikakui Mend Meroitic_Cursive Merc Meroitic_Hieroglyphs Mero Miao Plrd Modi Mongolian Mong Mro Mroo Multani Mult Myanmar Mymr Nabataean Nbat New_Tai_Lue Talu Newa Newa Nko Nkoo Nushu Nshu Ogham Ogam Ol_Chiki Olck Old_Hungarian Hung Old_Italic Ital Old_North_Arabian Narb Old_Permic Perm Old_Persian Xpeo Old_South_Arabian Sarb Old_Turkic Orkh Oriya Orya Osage Osge Osmanya Osma Pahawh_Hmong Hmng Palmyrene Palm Pau_Cin_Hau Pauc Phags_Pa Phag Phoenician Phnx Psalter_Pahlavi Phlp Rejang Rjng Runic Runr Samaritan Samr Saurashtra Saur Sharada Shrd Shavian Shaw Siddham Sidd SignWriting Sgnw Sinhala Sinh Sora_Sompeng Sora Soyombo Soyo Sundanese Sund Syloti_Nagri Sylo Syriac Syrc Tagalog Tglg Tagbanwa Tagb Tai_Le Tale Tai_Tham Lana Tai_Viet Tavt Takri Takr Tamil Taml Tangut Tang Telugu Telu Thaana Thaa Thai Thai Tibetan Tibt Tifinagh Tfng Tirhuta Tirh Ugaritic Ugar Vai Vaii Warang_Citi Wara Yi Yiii Zanabazar_Square Zanb";
    ecma10ScriptValues = ecma9ScriptValues + " Dogra Dogr Gunjala_Gondi Gong Hanifi_Rohingya Rohg Makasar Maka Medefaidrin Medf Old_Sogdian Sogo Sogdian Sogd";
    ecma11ScriptValues = ecma10ScriptValues + " Elymaic Elym Nandinagari Nand Nyiakeng_Puachue_Hmong Hmnp Wancho Wcho";
    ecma12ScriptValues = ecma11ScriptValues + " Chorasmian Chrs Diak Dives_Akuru Khitan_Small_Script Kits Yezi Yezidi";
    ecma13ScriptValues = ecma12ScriptValues + " Cypro_Minoan Cpmn Old_Uyghur Ougr Tangsa Tnsa Toto Vithkuqi Vith";
    ecma14ScriptValues = ecma13ScriptValues + " " + scriptValuesAddedInUnicode;
    unicodeScriptValues = {
      9: ecma9ScriptValues,
      10: ecma10ScriptValues,
      11: ecma11ScriptValues,
      12: ecma12ScriptValues,
      13: ecma13ScriptValues,
      14: ecma14ScriptValues
    };
    data = {};
    for (i = 0, list = [9, 10, 11, 12, 13, 14]; i < list.length; i += 1) {
      ecmaVersion = list[i];
      buildUnicodeData(ecmaVersion);
    }
    pp$1 = Parser.prototype;
    BranchID = function BranchID2(parent, base) {
      this.parent = parent;
      this.base = base || this;
    };
    BranchID.prototype.separatedFrom = function separatedFrom(alt) {
      for (var self2 = this; self2; self2 = self2.parent) {
        for (var other = alt; other; other = other.parent) {
          if (self2.base === other.base && self2 !== other) {
            return true;
          }
        }
      }
      return false;
    };
    BranchID.prototype.sibling = function sibling() {
      return new BranchID(this.parent, this.base);
    };
    RegExpValidationState = function RegExpValidationState2(parser) {
      this.parser = parser;
      this.validFlags = "gim" + (parser.options.ecmaVersion >= 6 ? "uy" : "") + (parser.options.ecmaVersion >= 9 ? "s" : "") + (parser.options.ecmaVersion >= 13 ? "d" : "") + (parser.options.ecmaVersion >= 15 ? "v" : "");
      this.unicodeProperties = data[parser.options.ecmaVersion >= 14 ? 14 : parser.options.ecmaVersion];
      this.source = "";
      this.flags = "";
      this.start = 0;
      this.switchU = false;
      this.switchV = false;
      this.switchN = false;
      this.pos = 0;
      this.lastIntValue = 0;
      this.lastStringValue = "";
      this.lastAssertionIsQuantifiable = false;
      this.numCapturingParens = 0;
      this.maxBackReference = 0;
      this.groupNames = /* @__PURE__ */ Object.create(null);
      this.backReferenceNames = [];
      this.branchID = null;
    };
    RegExpValidationState.prototype.reset = function reset(start, pattern, flags) {
      var unicodeSets = flags.indexOf("v") !== -1;
      var unicode = flags.indexOf("u") !== -1;
      this.start = start | 0;
      this.source = pattern + "";
      this.flags = flags;
      if (unicodeSets && this.parser.options.ecmaVersion >= 15) {
        this.switchU = true;
        this.switchV = true;
        this.switchN = true;
      } else {
        this.switchU = unicode && this.parser.options.ecmaVersion >= 6;
        this.switchV = false;
        this.switchN = unicode && this.parser.options.ecmaVersion >= 9;
      }
    };
    RegExpValidationState.prototype.raise = function raise(message) {
      this.parser.raiseRecoverable(this.start, "Invalid regular expression: /" + this.source + "/: " + message);
    };
    RegExpValidationState.prototype.at = function at(i, forceU) {
      if (forceU === void 0) forceU = false;
      var s = this.source;
      var l = s.length;
      if (i >= l) {
        return -1;
      }
      var c = s.charCodeAt(i);
      if (!(forceU || this.switchU) || c <= 55295 || c >= 57344 || i + 1 >= l) {
        return c;
      }
      var next = s.charCodeAt(i + 1);
      return next >= 56320 && next <= 57343 ? (c << 10) + next - 56613888 : c;
    };
    RegExpValidationState.prototype.nextIndex = function nextIndex(i, forceU) {
      if (forceU === void 0) forceU = false;
      var s = this.source;
      var l = s.length;
      if (i >= l) {
        return l;
      }
      var c = s.charCodeAt(i), next;
      if (!(forceU || this.switchU) || c <= 55295 || c >= 57344 || i + 1 >= l || (next = s.charCodeAt(i + 1)) < 56320 || next > 57343) {
        return i + 1;
      }
      return i + 2;
    };
    RegExpValidationState.prototype.current = function current(forceU) {
      if (forceU === void 0) forceU = false;
      return this.at(this.pos, forceU);
    };
    RegExpValidationState.prototype.lookahead = function lookahead(forceU) {
      if (forceU === void 0) forceU = false;
      return this.at(this.nextIndex(this.pos, forceU), forceU);
    };
    RegExpValidationState.prototype.advance = function advance(forceU) {
      if (forceU === void 0) forceU = false;
      this.pos = this.nextIndex(this.pos, forceU);
    };
    RegExpValidationState.prototype.eat = function eat(ch, forceU) {
      if (forceU === void 0) forceU = false;
      if (this.current(forceU) === ch) {
        this.advance(forceU);
        return true;
      }
      return false;
    };
    RegExpValidationState.prototype.eatChars = function eatChars(chs, forceU) {
      if (forceU === void 0) forceU = false;
      var pos = this.pos;
      for (var i = 0, list = chs; i < list.length; i += 1) {
        var ch = list[i];
        var current2 = this.at(pos, forceU);
        if (current2 === -1 || current2 !== ch) {
          return false;
        }
        pos = this.nextIndex(pos, forceU);
      }
      this.pos = pos;
      return true;
    };
    pp$1.validateRegExpFlags = function(state) {
      var validFlags = state.validFlags;
      var flags = state.flags;
      var u = false;
      var v = false;
      for (var i = 0; i < flags.length; i++) {
        var flag = flags.charAt(i);
        if (validFlags.indexOf(flag) === -1) {
          this.raise(state.start, "Invalid regular expression flag");
        }
        if (flags.indexOf(flag, i + 1) > -1) {
          this.raise(state.start, "Duplicate regular expression flag");
        }
        if (flag === "u") {
          u = true;
        }
        if (flag === "v") {
          v = true;
        }
      }
      if (this.options.ecmaVersion >= 15 && u && v) {
        this.raise(state.start, "Invalid regular expression flag");
      }
    };
    pp$1.validateRegExpPattern = function(state) {
      this.regexp_pattern(state);
      if (!state.switchN && this.options.ecmaVersion >= 9 && hasProp(state.groupNames)) {
        state.switchN = true;
        this.regexp_pattern(state);
      }
    };
    pp$1.regexp_pattern = function(state) {
      state.pos = 0;
      state.lastIntValue = 0;
      state.lastStringValue = "";
      state.lastAssertionIsQuantifiable = false;
      state.numCapturingParens = 0;
      state.maxBackReference = 0;
      state.groupNames = /* @__PURE__ */ Object.create(null);
      state.backReferenceNames.length = 0;
      state.branchID = null;
      this.regexp_disjunction(state);
      if (state.pos !== state.source.length) {
        if (state.eat(
          41
          /* ) */
        )) {
          state.raise("Unmatched ')'");
        }
        if (state.eat(
          93
          /* ] */
        ) || state.eat(
          125
          /* } */
        )) {
          state.raise("Lone quantifier brackets");
        }
      }
      if (state.maxBackReference > state.numCapturingParens) {
        state.raise("Invalid escape");
      }
      for (var i = 0, list = state.backReferenceNames; i < list.length; i += 1) {
        var name = list[i];
        if (!state.groupNames[name]) {
          state.raise("Invalid named capture referenced");
        }
      }
    };
    pp$1.regexp_disjunction = function(state) {
      var trackDisjunction = this.options.ecmaVersion >= 16;
      if (trackDisjunction) {
        state.branchID = new BranchID(state.branchID, null);
      }
      this.regexp_alternative(state);
      while (state.eat(
        124
        /* | */
      )) {
        if (trackDisjunction) {
          state.branchID = state.branchID.sibling();
        }
        this.regexp_alternative(state);
      }
      if (trackDisjunction) {
        state.branchID = state.branchID.parent;
      }
      if (this.regexp_eatQuantifier(state, true)) {
        state.raise("Nothing to repeat");
      }
      if (state.eat(
        123
        /* { */
      )) {
        state.raise("Lone quantifier brackets");
      }
    };
    pp$1.regexp_alternative = function(state) {
      while (state.pos < state.source.length && this.regexp_eatTerm(state)) {
      }
    };
    pp$1.regexp_eatTerm = function(state) {
      if (this.regexp_eatAssertion(state)) {
        if (state.lastAssertionIsQuantifiable && this.regexp_eatQuantifier(state)) {
          if (state.switchU) {
            state.raise("Invalid quantifier");
          }
        }
        return true;
      }
      if (state.switchU ? this.regexp_eatAtom(state) : this.regexp_eatExtendedAtom(state)) {
        this.regexp_eatQuantifier(state);
        return true;
      }
      return false;
    };
    pp$1.regexp_eatAssertion = function(state) {
      var start = state.pos;
      state.lastAssertionIsQuantifiable = false;
      if (state.eat(
        94
        /* ^ */
      ) || state.eat(
        36
        /* $ */
      )) {
        return true;
      }
      if (state.eat(
        92
        /* \ */
      )) {
        if (state.eat(
          66
          /* B */
        ) || state.eat(
          98
          /* b */
        )) {
          return true;
        }
        state.pos = start;
      }
      if (state.eat(
        40
        /* ( */
      ) && state.eat(
        63
        /* ? */
      )) {
        var lookbehind = false;
        if (this.options.ecmaVersion >= 9) {
          lookbehind = state.eat(
            60
            /* < */
          );
        }
        if (state.eat(
          61
          /* = */
        ) || state.eat(
          33
          /* ! */
        )) {
          this.regexp_disjunction(state);
          if (!state.eat(
            41
            /* ) */
          )) {
            state.raise("Unterminated group");
          }
          state.lastAssertionIsQuantifiable = !lookbehind;
          return true;
        }
      }
      state.pos = start;
      return false;
    };
    pp$1.regexp_eatQuantifier = function(state, noError) {
      if (noError === void 0) noError = false;
      if (this.regexp_eatQuantifierPrefix(state, noError)) {
        state.eat(
          63
          /* ? */
        );
        return true;
      }
      return false;
    };
    pp$1.regexp_eatQuantifierPrefix = function(state, noError) {
      return state.eat(
        42
        /* * */
      ) || state.eat(
        43
        /* + */
      ) || state.eat(
        63
        /* ? */
      ) || this.regexp_eatBracedQuantifier(state, noError);
    };
    pp$1.regexp_eatBracedQuantifier = function(state, noError) {
      var start = state.pos;
      if (state.eat(
        123
        /* { */
      )) {
        var min2 = 0, max2 = -1;
        if (this.regexp_eatDecimalDigits(state)) {
          min2 = state.lastIntValue;
          if (state.eat(
            44
            /* , */
          ) && this.regexp_eatDecimalDigits(state)) {
            max2 = state.lastIntValue;
          }
          if (state.eat(
            125
            /* } */
          )) {
            if (max2 !== -1 && max2 < min2 && !noError) {
              state.raise("numbers out of order in {} quantifier");
            }
            return true;
          }
        }
        if (state.switchU && !noError) {
          state.raise("Incomplete quantifier");
        }
        state.pos = start;
      }
      return false;
    };
    pp$1.regexp_eatAtom = function(state) {
      return this.regexp_eatPatternCharacters(state) || state.eat(
        46
        /* . */
      ) || this.regexp_eatReverseSolidusAtomEscape(state) || this.regexp_eatCharacterClass(state) || this.regexp_eatUncapturingGroup(state) || this.regexp_eatCapturingGroup(state);
    };
    pp$1.regexp_eatReverseSolidusAtomEscape = function(state) {
      var start = state.pos;
      if (state.eat(
        92
        /* \ */
      )) {
        if (this.regexp_eatAtomEscape(state)) {
          return true;
        }
        state.pos = start;
      }
      return false;
    };
    pp$1.regexp_eatUncapturingGroup = function(state) {
      var start = state.pos;
      if (state.eat(
        40
        /* ( */
      )) {
        if (state.eat(
          63
          /* ? */
        )) {
          if (this.options.ecmaVersion >= 16) {
            var addModifiers = this.regexp_eatModifiers(state);
            var hasHyphen = state.eat(
              45
              /* - */
            );
            if (addModifiers || hasHyphen) {
              for (var i = 0; i < addModifiers.length; i++) {
                var modifier = addModifiers.charAt(i);
                if (addModifiers.indexOf(modifier, i + 1) > -1) {
                  state.raise("Duplicate regular expression modifiers");
                }
              }
              if (hasHyphen) {
                var removeModifiers = this.regexp_eatModifiers(state);
                if (!addModifiers && !removeModifiers && state.current() === 58) {
                  state.raise("Invalid regular expression modifiers");
                }
                for (var i$1 = 0; i$1 < removeModifiers.length; i$1++) {
                  var modifier$1 = removeModifiers.charAt(i$1);
                  if (removeModifiers.indexOf(modifier$1, i$1 + 1) > -1 || addModifiers.indexOf(modifier$1) > -1) {
                    state.raise("Duplicate regular expression modifiers");
                  }
                }
              }
            }
          }
          if (state.eat(
            58
            /* : */
          )) {
            this.regexp_disjunction(state);
            if (state.eat(
              41
              /* ) */
            )) {
              return true;
            }
            state.raise("Unterminated group");
          }
        }
        state.pos = start;
      }
      return false;
    };
    pp$1.regexp_eatCapturingGroup = function(state) {
      if (state.eat(
        40
        /* ( */
      )) {
        if (this.options.ecmaVersion >= 9) {
          this.regexp_groupSpecifier(state);
        } else if (state.current() === 63) {
          state.raise("Invalid group");
        }
        this.regexp_disjunction(state);
        if (state.eat(
          41
          /* ) */
        )) {
          state.numCapturingParens += 1;
          return true;
        }
        state.raise("Unterminated group");
      }
      return false;
    };
    pp$1.regexp_eatModifiers = function(state) {
      var modifiers = "";
      var ch = 0;
      while ((ch = state.current()) !== -1 && isRegularExpressionModifier(ch)) {
        modifiers += codePointToString(ch);
        state.advance();
      }
      return modifiers;
    };
    pp$1.regexp_eatExtendedAtom = function(state) {
      return state.eat(
        46
        /* . */
      ) || this.regexp_eatReverseSolidusAtomEscape(state) || this.regexp_eatCharacterClass(state) || this.regexp_eatUncapturingGroup(state) || this.regexp_eatCapturingGroup(state) || this.regexp_eatInvalidBracedQuantifier(state) || this.regexp_eatExtendedPatternCharacter(state);
    };
    pp$1.regexp_eatInvalidBracedQuantifier = function(state) {
      if (this.regexp_eatBracedQuantifier(state, true)) {
        state.raise("Nothing to repeat");
      }
      return false;
    };
    pp$1.regexp_eatSyntaxCharacter = function(state) {
      var ch = state.current();
      if (isSyntaxCharacter(ch)) {
        state.lastIntValue = ch;
        state.advance();
        return true;
      }
      return false;
    };
    pp$1.regexp_eatPatternCharacters = function(state) {
      var start = state.pos;
      var ch = 0;
      while ((ch = state.current()) !== -1 && !isSyntaxCharacter(ch)) {
        state.advance();
      }
      return state.pos !== start;
    };
    pp$1.regexp_eatExtendedPatternCharacter = function(state) {
      var ch = state.current();
      if (ch !== -1 && ch !== 36 && !(ch >= 40 && ch <= 43) && ch !== 46 && ch !== 63 && ch !== 91 && ch !== 94 && ch !== 124) {
        state.advance();
        return true;
      }
      return false;
    };
    pp$1.regexp_groupSpecifier = function(state) {
      if (state.eat(
        63
        /* ? */
      )) {
        if (!this.regexp_eatGroupName(state)) {
          state.raise("Invalid group");
        }
        var trackDisjunction = this.options.ecmaVersion >= 16;
        var known = state.groupNames[state.lastStringValue];
        if (known) {
          if (trackDisjunction) {
            for (var i = 0, list = known; i < list.length; i += 1) {
              var altID = list[i];
              if (!altID.separatedFrom(state.branchID)) {
                state.raise("Duplicate capture group name");
              }
            }
          } else {
            state.raise("Duplicate capture group name");
          }
        }
        if (trackDisjunction) {
          (known || (state.groupNames[state.lastStringValue] = [])).push(state.branchID);
        } else {
          state.groupNames[state.lastStringValue] = true;
        }
      }
    };
    pp$1.regexp_eatGroupName = function(state) {
      state.lastStringValue = "";
      if (state.eat(
        60
        /* < */
      )) {
        if (this.regexp_eatRegExpIdentifierName(state) && state.eat(
          62
          /* > */
        )) {
          return true;
        }
        state.raise("Invalid capture group name");
      }
      return false;
    };
    pp$1.regexp_eatRegExpIdentifierName = function(state) {
      state.lastStringValue = "";
      if (this.regexp_eatRegExpIdentifierStart(state)) {
        state.lastStringValue += codePointToString(state.lastIntValue);
        while (this.regexp_eatRegExpIdentifierPart(state)) {
          state.lastStringValue += codePointToString(state.lastIntValue);
        }
        return true;
      }
      return false;
    };
    pp$1.regexp_eatRegExpIdentifierStart = function(state) {
      var start = state.pos;
      var forceU = this.options.ecmaVersion >= 11;
      var ch = state.current(forceU);
      state.advance(forceU);
      if (ch === 92 && this.regexp_eatRegExpUnicodeEscapeSequence(state, forceU)) {
        ch = state.lastIntValue;
      }
      if (isRegExpIdentifierStart(ch)) {
        state.lastIntValue = ch;
        return true;
      }
      state.pos = start;
      return false;
    };
    pp$1.regexp_eatRegExpIdentifierPart = function(state) {
      var start = state.pos;
      var forceU = this.options.ecmaVersion >= 11;
      var ch = state.current(forceU);
      state.advance(forceU);
      if (ch === 92 && this.regexp_eatRegExpUnicodeEscapeSequence(state, forceU)) {
        ch = state.lastIntValue;
      }
      if (isRegExpIdentifierPart(ch)) {
        state.lastIntValue = ch;
        return true;
      }
      state.pos = start;
      return false;
    };
    pp$1.regexp_eatAtomEscape = function(state) {
      if (this.regexp_eatBackReference(state) || this.regexp_eatCharacterClassEscape(state) || this.regexp_eatCharacterEscape(state) || state.switchN && this.regexp_eatKGroupName(state)) {
        return true;
      }
      if (state.switchU) {
        if (state.current() === 99) {
          state.raise("Invalid unicode escape");
        }
        state.raise("Invalid escape");
      }
      return false;
    };
    pp$1.regexp_eatBackReference = function(state) {
      var start = state.pos;
      if (this.regexp_eatDecimalEscape(state)) {
        var n = state.lastIntValue;
        if (state.switchU) {
          if (n > state.maxBackReference) {
            state.maxBackReference = n;
          }
          return true;
        }
        if (n <= state.numCapturingParens) {
          return true;
        }
        state.pos = start;
      }
      return false;
    };
    pp$1.regexp_eatKGroupName = function(state) {
      if (state.eat(
        107
        /* k */
      )) {
        if (this.regexp_eatGroupName(state)) {
          state.backReferenceNames.push(state.lastStringValue);
          return true;
        }
        state.raise("Invalid named reference");
      }
      return false;
    };
    pp$1.regexp_eatCharacterEscape = function(state) {
      return this.regexp_eatControlEscape(state) || this.regexp_eatCControlLetter(state) || this.regexp_eatZero(state) || this.regexp_eatHexEscapeSequence(state) || this.regexp_eatRegExpUnicodeEscapeSequence(state, false) || !state.switchU && this.regexp_eatLegacyOctalEscapeSequence(state) || this.regexp_eatIdentityEscape(state);
    };
    pp$1.regexp_eatCControlLetter = function(state) {
      var start = state.pos;
      if (state.eat(
        99
        /* c */
      )) {
        if (this.regexp_eatControlLetter(state)) {
          return true;
        }
        state.pos = start;
      }
      return false;
    };
    pp$1.regexp_eatZero = function(state) {
      if (state.current() === 48 && !isDecimalDigit(state.lookahead())) {
        state.lastIntValue = 0;
        state.advance();
        return true;
      }
      return false;
    };
    pp$1.regexp_eatControlEscape = function(state) {
      var ch = state.current();
      if (ch === 116) {
        state.lastIntValue = 9;
        state.advance();
        return true;
      }
      if (ch === 110) {
        state.lastIntValue = 10;
        state.advance();
        return true;
      }
      if (ch === 118) {
        state.lastIntValue = 11;
        state.advance();
        return true;
      }
      if (ch === 102) {
        state.lastIntValue = 12;
        state.advance();
        return true;
      }
      if (ch === 114) {
        state.lastIntValue = 13;
        state.advance();
        return true;
      }
      return false;
    };
    pp$1.regexp_eatControlLetter = function(state) {
      var ch = state.current();
      if (isControlLetter(ch)) {
        state.lastIntValue = ch % 32;
        state.advance();
        return true;
      }
      return false;
    };
    pp$1.regexp_eatRegExpUnicodeEscapeSequence = function(state, forceU) {
      if (forceU === void 0) forceU = false;
      var start = state.pos;
      var switchU = forceU || state.switchU;
      if (state.eat(
        117
        /* u */
      )) {
        if (this.regexp_eatFixedHexDigits(state, 4)) {
          var lead = state.lastIntValue;
          if (switchU && lead >= 55296 && lead <= 56319) {
            var leadSurrogateEnd = state.pos;
            if (state.eat(
              92
              /* \ */
            ) && state.eat(
              117
              /* u */
            ) && this.regexp_eatFixedHexDigits(state, 4)) {
              var trail = state.lastIntValue;
              if (trail >= 56320 && trail <= 57343) {
                state.lastIntValue = (lead - 55296) * 1024 + (trail - 56320) + 65536;
                return true;
              }
            }
            state.pos = leadSurrogateEnd;
            state.lastIntValue = lead;
          }
          return true;
        }
        if (switchU && state.eat(
          123
          /* { */
        ) && this.regexp_eatHexDigits(state) && state.eat(
          125
          /* } */
        ) && isValidUnicode(state.lastIntValue)) {
          return true;
        }
        if (switchU) {
          state.raise("Invalid unicode escape");
        }
        state.pos = start;
      }
      return false;
    };
    pp$1.regexp_eatIdentityEscape = function(state) {
      if (state.switchU) {
        if (this.regexp_eatSyntaxCharacter(state)) {
          return true;
        }
        if (state.eat(
          47
          /* / */
        )) {
          state.lastIntValue = 47;
          return true;
        }
        return false;
      }
      var ch = state.current();
      if (ch !== 99 && (!state.switchN || ch !== 107)) {
        state.lastIntValue = ch;
        state.advance();
        return true;
      }
      return false;
    };
    pp$1.regexp_eatDecimalEscape = function(state) {
      state.lastIntValue = 0;
      var ch = state.current();
      if (ch >= 49 && ch <= 57) {
        do {
          state.lastIntValue = 10 * state.lastIntValue + (ch - 48);
          state.advance();
        } while ((ch = state.current()) >= 48 && ch <= 57);
        return true;
      }
      return false;
    };
    CharSetNone = 0;
    CharSetOk = 1;
    CharSetString = 2;
    pp$1.regexp_eatCharacterClassEscape = function(state) {
      var ch = state.current();
      if (isCharacterClassEscape(ch)) {
        state.lastIntValue = -1;
        state.advance();
        return CharSetOk;
      }
      var negate = false;
      if (state.switchU && this.options.ecmaVersion >= 9 && ((negate = ch === 80) || ch === 112)) {
        state.lastIntValue = -1;
        state.advance();
        var result;
        if (state.eat(
          123
          /* { */
        ) && (result = this.regexp_eatUnicodePropertyValueExpression(state)) && state.eat(
          125
          /* } */
        )) {
          if (negate && result === CharSetString) {
            state.raise("Invalid property name");
          }
          return result;
        }
        state.raise("Invalid property name");
      }
      return CharSetNone;
    };
    pp$1.regexp_eatUnicodePropertyValueExpression = function(state) {
      var start = state.pos;
      if (this.regexp_eatUnicodePropertyName(state) && state.eat(
        61
        /* = */
      )) {
        var name = state.lastStringValue;
        if (this.regexp_eatUnicodePropertyValue(state)) {
          var value = state.lastStringValue;
          this.regexp_validateUnicodePropertyNameAndValue(state, name, value);
          return CharSetOk;
        }
      }
      state.pos = start;
      if (this.regexp_eatLoneUnicodePropertyNameOrValue(state)) {
        var nameOrValue = state.lastStringValue;
        return this.regexp_validateUnicodePropertyNameOrValue(state, nameOrValue);
      }
      return CharSetNone;
    };
    pp$1.regexp_validateUnicodePropertyNameAndValue = function(state, name, value) {
      if (!hasOwn2(state.unicodeProperties.nonBinary, name)) {
        state.raise("Invalid property name");
      }
      if (!state.unicodeProperties.nonBinary[name].test(value)) {
        state.raise("Invalid property value");
      }
    };
    pp$1.regexp_validateUnicodePropertyNameOrValue = function(state, nameOrValue) {
      if (state.unicodeProperties.binary.test(nameOrValue)) {
        return CharSetOk;
      }
      if (state.switchV && state.unicodeProperties.binaryOfStrings.test(nameOrValue)) {
        return CharSetString;
      }
      state.raise("Invalid property name");
    };
    pp$1.regexp_eatUnicodePropertyName = function(state) {
      var ch = 0;
      state.lastStringValue = "";
      while (isUnicodePropertyNameCharacter(ch = state.current())) {
        state.lastStringValue += codePointToString(ch);
        state.advance();
      }
      return state.lastStringValue !== "";
    };
    pp$1.regexp_eatUnicodePropertyValue = function(state) {
      var ch = 0;
      state.lastStringValue = "";
      while (isUnicodePropertyValueCharacter(ch = state.current())) {
        state.lastStringValue += codePointToString(ch);
        state.advance();
      }
      return state.lastStringValue !== "";
    };
    pp$1.regexp_eatLoneUnicodePropertyNameOrValue = function(state) {
      return this.regexp_eatUnicodePropertyValue(state);
    };
    pp$1.regexp_eatCharacterClass = function(state) {
      if (state.eat(
        91
        /* [ */
      )) {
        var negate = state.eat(
          94
          /* ^ */
        );
        var result = this.regexp_classContents(state);
        if (!state.eat(
          93
          /* ] */
        )) {
          state.raise("Unterminated character class");
        }
        if (negate && result === CharSetString) {
          state.raise("Negated character class may contain strings");
        }
        return true;
      }
      return false;
    };
    pp$1.regexp_classContents = function(state) {
      if (state.current() === 93) {
        return CharSetOk;
      }
      if (state.switchV) {
        return this.regexp_classSetExpression(state);
      }
      this.regexp_nonEmptyClassRanges(state);
      return CharSetOk;
    };
    pp$1.regexp_nonEmptyClassRanges = function(state) {
      while (this.regexp_eatClassAtom(state)) {
        var left = state.lastIntValue;
        if (state.eat(
          45
          /* - */
        ) && this.regexp_eatClassAtom(state)) {
          var right = state.lastIntValue;
          if (state.switchU && (left === -1 || right === -1)) {
            state.raise("Invalid character class");
          }
          if (left !== -1 && right !== -1 && left > right) {
            state.raise("Range out of order in character class");
          }
        }
      }
    };
    pp$1.regexp_eatClassAtom = function(state) {
      var start = state.pos;
      if (state.eat(
        92
        /* \ */
      )) {
        if (this.regexp_eatClassEscape(state)) {
          return true;
        }
        if (state.switchU) {
          var ch$1 = state.current();
          if (ch$1 === 99 || isOctalDigit(ch$1)) {
            state.raise("Invalid class escape");
          }
          state.raise("Invalid escape");
        }
        state.pos = start;
      }
      var ch = state.current();
      if (ch !== 93) {
        state.lastIntValue = ch;
        state.advance();
        return true;
      }
      return false;
    };
    pp$1.regexp_eatClassEscape = function(state) {
      var start = state.pos;
      if (state.eat(
        98
        /* b */
      )) {
        state.lastIntValue = 8;
        return true;
      }
      if (state.switchU && state.eat(
        45
        /* - */
      )) {
        state.lastIntValue = 45;
        return true;
      }
      if (!state.switchU && state.eat(
        99
        /* c */
      )) {
        if (this.regexp_eatClassControlLetter(state)) {
          return true;
        }
        state.pos = start;
      }
      return this.regexp_eatCharacterClassEscape(state) || this.regexp_eatCharacterEscape(state);
    };
    pp$1.regexp_classSetExpression = function(state) {
      var result = CharSetOk, subResult;
      if (this.regexp_eatClassSetRange(state)) ;
      else if (subResult = this.regexp_eatClassSetOperand(state)) {
        if (subResult === CharSetString) {
          result = CharSetString;
        }
        var start = state.pos;
        while (state.eatChars(
          [38, 38]
          /* && */
        )) {
          if (state.current() !== 38 && (subResult = this.regexp_eatClassSetOperand(state))) {
            if (subResult !== CharSetString) {
              result = CharSetOk;
            }
            continue;
          }
          state.raise("Invalid character in character class");
        }
        if (start !== state.pos) {
          return result;
        }
        while (state.eatChars(
          [45, 45]
          /* -- */
        )) {
          if (this.regexp_eatClassSetOperand(state)) {
            continue;
          }
          state.raise("Invalid character in character class");
        }
        if (start !== state.pos) {
          return result;
        }
      } else {
        state.raise("Invalid character in character class");
      }
      for (; ; ) {
        if (this.regexp_eatClassSetRange(state)) {
          continue;
        }
        subResult = this.regexp_eatClassSetOperand(state);
        if (!subResult) {
          return result;
        }
        if (subResult === CharSetString) {
          result = CharSetString;
        }
      }
    };
    pp$1.regexp_eatClassSetRange = function(state) {
      var start = state.pos;
      if (this.regexp_eatClassSetCharacter(state)) {
        var left = state.lastIntValue;
        if (state.eat(
          45
          /* - */
        ) && this.regexp_eatClassSetCharacter(state)) {
          var right = state.lastIntValue;
          if (left !== -1 && right !== -1 && left > right) {
            state.raise("Range out of order in character class");
          }
          return true;
        }
        state.pos = start;
      }
      return false;
    };
    pp$1.regexp_eatClassSetOperand = function(state) {
      if (this.regexp_eatClassSetCharacter(state)) {
        return CharSetOk;
      }
      return this.regexp_eatClassStringDisjunction(state) || this.regexp_eatNestedClass(state);
    };
    pp$1.regexp_eatNestedClass = function(state) {
      var start = state.pos;
      if (state.eat(
        91
        /* [ */
      )) {
        var negate = state.eat(
          94
          /* ^ */
        );
        var result = this.regexp_classContents(state);
        if (state.eat(
          93
          /* ] */
        )) {
          if (negate && result === CharSetString) {
            state.raise("Negated character class may contain strings");
          }
          return result;
        }
        state.pos = start;
      }
      if (state.eat(
        92
        /* \ */
      )) {
        var result$1 = this.regexp_eatCharacterClassEscape(state);
        if (result$1) {
          return result$1;
        }
        state.pos = start;
      }
      return null;
    };
    pp$1.regexp_eatClassStringDisjunction = function(state) {
      var start = state.pos;
      if (state.eatChars(
        [92, 113]
        /* \q */
      )) {
        if (state.eat(
          123
          /* { */
        )) {
          var result = this.regexp_classStringDisjunctionContents(state);
          if (state.eat(
            125
            /* } */
          )) {
            return result;
          }
        } else {
          state.raise("Invalid escape");
        }
        state.pos = start;
      }
      return null;
    };
    pp$1.regexp_classStringDisjunctionContents = function(state) {
      var result = this.regexp_classString(state);
      while (state.eat(
        124
        /* | */
      )) {
        if (this.regexp_classString(state) === CharSetString) {
          result = CharSetString;
        }
      }
      return result;
    };
    pp$1.regexp_classString = function(state) {
      var count = 0;
      while (this.regexp_eatClassSetCharacter(state)) {
        count++;
      }
      return count === 1 ? CharSetOk : CharSetString;
    };
    pp$1.regexp_eatClassSetCharacter = function(state) {
      var start = state.pos;
      if (state.eat(
        92
        /* \ */
      )) {
        if (this.regexp_eatCharacterEscape(state) || this.regexp_eatClassSetReservedPunctuator(state)) {
          return true;
        }
        if (state.eat(
          98
          /* b */
        )) {
          state.lastIntValue = 8;
          return true;
        }
        state.pos = start;
        return false;
      }
      var ch = state.current();
      if (ch < 0 || ch === state.lookahead() && isClassSetReservedDoublePunctuatorCharacter(ch)) {
        return false;
      }
      if (isClassSetSyntaxCharacter(ch)) {
        return false;
      }
      state.advance();
      state.lastIntValue = ch;
      return true;
    };
    pp$1.regexp_eatClassSetReservedPunctuator = function(state) {
      var ch = state.current();
      if (isClassSetReservedPunctuator(ch)) {
        state.lastIntValue = ch;
        state.advance();
        return true;
      }
      return false;
    };
    pp$1.regexp_eatClassControlLetter = function(state) {
      var ch = state.current();
      if (isDecimalDigit(ch) || ch === 95) {
        state.lastIntValue = ch % 32;
        state.advance();
        return true;
      }
      return false;
    };
    pp$1.regexp_eatHexEscapeSequence = function(state) {
      var start = state.pos;
      if (state.eat(
        120
        /* x */
      )) {
        if (this.regexp_eatFixedHexDigits(state, 2)) {
          return true;
        }
        if (state.switchU) {
          state.raise("Invalid escape");
        }
        state.pos = start;
      }
      return false;
    };
    pp$1.regexp_eatDecimalDigits = function(state) {
      var start = state.pos;
      var ch = 0;
      state.lastIntValue = 0;
      while (isDecimalDigit(ch = state.current())) {
        state.lastIntValue = 10 * state.lastIntValue + (ch - 48);
        state.advance();
      }
      return state.pos !== start;
    };
    pp$1.regexp_eatHexDigits = function(state) {
      var start = state.pos;
      var ch = 0;
      state.lastIntValue = 0;
      while (isHexDigit(ch = state.current())) {
        state.lastIntValue = 16 * state.lastIntValue + hexToInt(ch);
        state.advance();
      }
      return state.pos !== start;
    };
    pp$1.regexp_eatLegacyOctalEscapeSequence = function(state) {
      if (this.regexp_eatOctalDigit(state)) {
        var n1 = state.lastIntValue;
        if (this.regexp_eatOctalDigit(state)) {
          var n2 = state.lastIntValue;
          if (n1 <= 3 && this.regexp_eatOctalDigit(state)) {
            state.lastIntValue = n1 * 64 + n2 * 8 + state.lastIntValue;
          } else {
            state.lastIntValue = n1 * 8 + n2;
          }
        } else {
          state.lastIntValue = n1;
        }
        return true;
      }
      return false;
    };
    pp$1.regexp_eatOctalDigit = function(state) {
      var ch = state.current();
      if (isOctalDigit(ch)) {
        state.lastIntValue = ch - 48;
        state.advance();
        return true;
      }
      state.lastIntValue = 0;
      return false;
    };
    pp$1.regexp_eatFixedHexDigits = function(state, length) {
      var start = state.pos;
      state.lastIntValue = 0;
      for (var i = 0; i < length; ++i) {
        var ch = state.current();
        if (!isHexDigit(ch)) {
          state.pos = start;
          return false;
        }
        state.lastIntValue = 16 * state.lastIntValue + hexToInt(ch);
        state.advance();
      }
      return true;
    };
    Token = function Token2(p) {
      this.type = p.type;
      this.value = p.value;
      this.start = p.start;
      this.end = p.end;
      if (p.options.locations) {
        this.loc = new SourceLocation(p, p.startLoc, p.endLoc);
      }
      if (p.options.ranges) {
        this.range = [p.start, p.end];
      }
    };
    pp = Parser.prototype;
    pp.next = function(ignoreEscapeSequenceInKeyword) {
      if (!ignoreEscapeSequenceInKeyword && this.type.keyword && this.containsEsc) {
        this.raiseRecoverable(this.start, "Escape sequence in keyword " + this.type.keyword);
      }
      if (this.options.onToken) {
        this.options.onToken(new Token(this));
      }
      this.lastTokEnd = this.end;
      this.lastTokStart = this.start;
      this.lastTokEndLoc = this.endLoc;
      this.lastTokStartLoc = this.startLoc;
      this.nextToken();
    };
    pp.getToken = function() {
      this.next();
      return new Token(this);
    };
    if (typeof Symbol !== "undefined") {
      pp[Symbol.iterator] = function() {
        var this$1$1 = this;
        return {
          next: function() {
            var token = this$1$1.getToken();
            return {
              done: token.type === types$1.eof,
              value: token
            };
          }
        };
      };
    }
    pp.nextToken = function() {
      var curContext = this.curContext();
      if (!curContext || !curContext.preserveSpace) {
        this.skipSpace();
      }
      this.start = this.pos;
      if (this.options.locations) {
        this.startLoc = this.curPosition();
      }
      if (this.pos >= this.input.length) {
        return this.finishToken(types$1.eof);
      }
      if (curContext.override) {
        return curContext.override(this);
      } else {
        this.readToken(this.fullCharCodeAtPos());
      }
    };
    pp.readToken = function(code) {
      if (isIdentifierStart(code, this.options.ecmaVersion >= 6) || code === 92) {
        return this.readWord();
      }
      return this.getTokenFromCode(code);
    };
    pp.fullCharCodeAt = function(pos) {
      var code = this.input.charCodeAt(pos);
      if (code <= 55295 || code >= 56320) {
        return code;
      }
      var next = this.input.charCodeAt(pos + 1);
      return next <= 56319 || next >= 57344 ? code : (code << 10) + next - 56613888;
    };
    pp.fullCharCodeAtPos = function() {
      return this.fullCharCodeAt(this.pos);
    };
    pp.skipBlockComment = function() {
      var startLoc = this.options.onComment && this.curPosition();
      var start = this.pos, end = this.input.indexOf("*/", this.pos += 2);
      if (end === -1) {
        this.raise(this.pos - 2, "Unterminated comment");
      }
      this.pos = end + 2;
      if (this.options.locations) {
        for (var nextBreak = void 0, pos = start; (nextBreak = nextLineBreak(this.input, pos, this.pos)) > -1; ) {
          ++this.curLine;
          pos = this.lineStart = nextBreak;
        }
      }
      if (this.options.onComment) {
        this.options.onComment(
          true,
          this.input.slice(start + 2, end),
          start,
          this.pos,
          startLoc,
          this.curPosition()
        );
      }
    };
    pp.skipLineComment = function(startSkip) {
      var start = this.pos;
      var startLoc = this.options.onComment && this.curPosition();
      var ch = this.input.charCodeAt(this.pos += startSkip);
      while (this.pos < this.input.length && !isNewLine(ch)) {
        ch = this.input.charCodeAt(++this.pos);
      }
      if (this.options.onComment) {
        this.options.onComment(
          false,
          this.input.slice(start + startSkip, this.pos),
          start,
          this.pos,
          startLoc,
          this.curPosition()
        );
      }
    };
    pp.skipSpace = function() {
      loop: while (this.pos < this.input.length) {
        var ch = this.input.charCodeAt(this.pos);
        switch (ch) {
          case 32:
          case 160:
            ++this.pos;
            break;
          case 13:
            if (this.input.charCodeAt(this.pos + 1) === 10) {
              ++this.pos;
            }
          case 10:
          case 8232:
          case 8233:
            ++this.pos;
            if (this.options.locations) {
              ++this.curLine;
              this.lineStart = this.pos;
            }
            break;
          case 47:
            switch (this.input.charCodeAt(this.pos + 1)) {
              case 42:
                this.skipBlockComment();
                break;
              case 47:
                this.skipLineComment(2);
                break;
              default:
                break loop;
            }
            break;
          default:
            if (ch > 8 && ch < 14 || ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
              ++this.pos;
            } else {
              break loop;
            }
        }
      }
    };
    pp.finishToken = function(type, val) {
      this.end = this.pos;
      if (this.options.locations) {
        this.endLoc = this.curPosition();
      }
      var prevType = this.type;
      this.type = type;
      this.value = val;
      this.updateContext(prevType);
    };
    pp.readToken_dot = function() {
      var next = this.input.charCodeAt(this.pos + 1);
      if (next >= 48 && next <= 57) {
        return this.readNumber(true);
      }
      var next2 = this.input.charCodeAt(this.pos + 2);
      if (this.options.ecmaVersion >= 6 && next === 46 && next2 === 46) {
        this.pos += 3;
        return this.finishToken(types$1.ellipsis);
      } else {
        ++this.pos;
        return this.finishToken(types$1.dot);
      }
    };
    pp.readToken_slash = function() {
      var next = this.input.charCodeAt(this.pos + 1);
      if (this.exprAllowed) {
        ++this.pos;
        return this.readRegexp();
      }
      if (next === 61) {
        return this.finishOp(types$1.assign, 2);
      }
      return this.finishOp(types$1.slash, 1);
    };
    pp.readToken_mult_modulo_exp = function(code) {
      var next = this.input.charCodeAt(this.pos + 1);
      var size = 1;
      var tokentype = code === 42 ? types$1.star : types$1.modulo;
      if (this.options.ecmaVersion >= 7 && code === 42 && next === 42) {
        ++size;
        tokentype = types$1.starstar;
        next = this.input.charCodeAt(this.pos + 2);
      }
      if (next === 61) {
        return this.finishOp(types$1.assign, size + 1);
      }
      return this.finishOp(tokentype, size);
    };
    pp.readToken_pipe_amp = function(code) {
      var next = this.input.charCodeAt(this.pos + 1);
      if (next === code) {
        if (this.options.ecmaVersion >= 12) {
          var next2 = this.input.charCodeAt(this.pos + 2);
          if (next2 === 61) {
            return this.finishOp(types$1.assign, 3);
          }
        }
        return this.finishOp(code === 124 ? types$1.logicalOR : types$1.logicalAND, 2);
      }
      if (next === 61) {
        return this.finishOp(types$1.assign, 2);
      }
      return this.finishOp(code === 124 ? types$1.bitwiseOR : types$1.bitwiseAND, 1);
    };
    pp.readToken_caret = function() {
      var next = this.input.charCodeAt(this.pos + 1);
      if (next === 61) {
        return this.finishOp(types$1.assign, 2);
      }
      return this.finishOp(types$1.bitwiseXOR, 1);
    };
    pp.readToken_plus_min = function(code) {
      var next = this.input.charCodeAt(this.pos + 1);
      if (next === code) {
        if (next === 45 && !this.inModule && this.input.charCodeAt(this.pos + 2) === 62 && (this.lastTokEnd === 0 || lineBreak.test(this.input.slice(this.lastTokEnd, this.pos)))) {
          this.skipLineComment(3);
          this.skipSpace();
          return this.nextToken();
        }
        return this.finishOp(types$1.incDec, 2);
      }
      if (next === 61) {
        return this.finishOp(types$1.assign, 2);
      }
      return this.finishOp(types$1.plusMin, 1);
    };
    pp.readToken_lt_gt = function(code) {
      var next = this.input.charCodeAt(this.pos + 1);
      var size = 1;
      if (next === code) {
        size = code === 62 && this.input.charCodeAt(this.pos + 2) === 62 ? 3 : 2;
        if (this.input.charCodeAt(this.pos + size) === 61) {
          return this.finishOp(types$1.assign, size + 1);
        }
        return this.finishOp(types$1.bitShift, size);
      }
      if (next === 33 && code === 60 && !this.inModule && this.input.charCodeAt(this.pos + 2) === 45 && this.input.charCodeAt(this.pos + 3) === 45) {
        this.skipLineComment(4);
        this.skipSpace();
        return this.nextToken();
      }
      if (next === 61) {
        size = 2;
      }
      return this.finishOp(types$1.relational, size);
    };
    pp.readToken_eq_excl = function(code) {
      var next = this.input.charCodeAt(this.pos + 1);
      if (next === 61) {
        return this.finishOp(types$1.equality, this.input.charCodeAt(this.pos + 2) === 61 ? 3 : 2);
      }
      if (code === 61 && next === 62 && this.options.ecmaVersion >= 6) {
        this.pos += 2;
        return this.finishToken(types$1.arrow);
      }
      return this.finishOp(code === 61 ? types$1.eq : types$1.prefix, 1);
    };
    pp.readToken_question = function() {
      var ecmaVersion = this.options.ecmaVersion;
      if (ecmaVersion >= 11) {
        var next = this.input.charCodeAt(this.pos + 1);
        if (next === 46) {
          var next2 = this.input.charCodeAt(this.pos + 2);
          if (next2 < 48 || next2 > 57) {
            return this.finishOp(types$1.questionDot, 2);
          }
        }
        if (next === 63) {
          if (ecmaVersion >= 12) {
            var next2$1 = this.input.charCodeAt(this.pos + 2);
            if (next2$1 === 61) {
              return this.finishOp(types$1.assign, 3);
            }
          }
          return this.finishOp(types$1.coalesce, 2);
        }
      }
      return this.finishOp(types$1.question, 1);
    };
    pp.readToken_numberSign = function() {
      var ecmaVersion = this.options.ecmaVersion;
      var code = 35;
      if (ecmaVersion >= 13) {
        ++this.pos;
        code = this.fullCharCodeAtPos();
        if (isIdentifierStart(code, true) || code === 92) {
          return this.finishToken(types$1.privateId, this.readWord1());
        }
      }
      this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
    };
    pp.getTokenFromCode = function(code) {
      switch (code) {
        // The interpretation of a dot depends on whether it is followed
        // by a digit or another two dots.
        case 46:
          return this.readToken_dot();
        // Punctuation tokens.
        case 40:
          ++this.pos;
          return this.finishToken(types$1.parenL);
        case 41:
          ++this.pos;
          return this.finishToken(types$1.parenR);
        case 59:
          ++this.pos;
          return this.finishToken(types$1.semi);
        case 44:
          ++this.pos;
          return this.finishToken(types$1.comma);
        case 91:
          ++this.pos;
          return this.finishToken(types$1.bracketL);
        case 93:
          ++this.pos;
          return this.finishToken(types$1.bracketR);
        case 123:
          ++this.pos;
          return this.finishToken(types$1.braceL);
        case 125:
          ++this.pos;
          return this.finishToken(types$1.braceR);
        case 58:
          ++this.pos;
          return this.finishToken(types$1.colon);
        case 96:
          if (this.options.ecmaVersion < 6) {
            break;
          }
          ++this.pos;
          return this.finishToken(types$1.backQuote);
        case 48:
          var next = this.input.charCodeAt(this.pos + 1);
          if (next === 120 || next === 88) {
            return this.readRadixNumber(16);
          }
          if (this.options.ecmaVersion >= 6) {
            if (next === 111 || next === 79) {
              return this.readRadixNumber(8);
            }
            if (next === 98 || next === 66) {
              return this.readRadixNumber(2);
            }
          }
        // Anything else beginning with a digit is an integer, octal
        // number, or float.
        case 49:
        case 50:
        case 51:
        case 52:
        case 53:
        case 54:
        case 55:
        case 56:
        case 57:
          return this.readNumber(false);
        // Quotes produce strings.
        case 34:
        case 39:
          return this.readString(code);
        // Operators are parsed inline in tiny state machines. '=' (61) is
        // often referred to. `finishOp` simply skips the amount of
        // characters it is given as second argument, and returns a token
        // of the type given by its first argument.
        case 47:
          return this.readToken_slash();
        case 37:
        case 42:
          return this.readToken_mult_modulo_exp(code);
        case 124:
        case 38:
          return this.readToken_pipe_amp(code);
        case 94:
          return this.readToken_caret();
        case 43:
        case 45:
          return this.readToken_plus_min(code);
        case 60:
        case 62:
          return this.readToken_lt_gt(code);
        case 61:
        case 33:
          return this.readToken_eq_excl(code);
        case 63:
          return this.readToken_question();
        case 126:
          return this.finishOp(types$1.prefix, 1);
        case 35:
          return this.readToken_numberSign();
      }
      this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
    };
    pp.finishOp = function(type, size) {
      var str = this.input.slice(this.pos, this.pos + size);
      this.pos += size;
      return this.finishToken(type, str);
    };
    pp.readRegexp = function() {
      var escaped, inClass, start = this.pos;
      for (; ; ) {
        if (this.pos >= this.input.length) {
          this.raise(start, "Unterminated regular expression");
        }
        var ch = this.input.charAt(this.pos);
        if (lineBreak.test(ch)) {
          this.raise(start, "Unterminated regular expression");
        }
        if (!escaped) {
          if (ch === "[") {
            inClass = true;
          } else if (ch === "]" && inClass) {
            inClass = false;
          } else if (ch === "/" && !inClass) {
            break;
          }
          escaped = ch === "\\";
        } else {
          escaped = false;
        }
        ++this.pos;
      }
      var pattern = this.input.slice(start, this.pos);
      ++this.pos;
      var flagsStart = this.pos;
      var flags = this.readWord1();
      if (this.containsEsc) {
        this.unexpected(flagsStart);
      }
      var state = this.regexpState || (this.regexpState = new RegExpValidationState(this));
      state.reset(start, pattern, flags);
      this.validateRegExpFlags(state);
      this.validateRegExpPattern(state);
      var value = null;
      try {
        value = new RegExp(pattern, flags);
      } catch (e) {
      }
      return this.finishToken(types$1.regexp, { pattern, flags, value });
    };
    pp.readInt = function(radix, len, maybeLegacyOctalNumericLiteral) {
      var allowSeparators = this.options.ecmaVersion >= 12 && len === void 0;
      var isLegacyOctalNumericLiteral = maybeLegacyOctalNumericLiteral && this.input.charCodeAt(this.pos) === 48;
      var start = this.pos, total = 0, lastCode = 0;
      for (var i = 0, e = len == null ? Infinity : len; i < e; ++i, ++this.pos) {
        var code = this.input.charCodeAt(this.pos), val = void 0;
        if (allowSeparators && code === 95) {
          if (isLegacyOctalNumericLiteral) {
            this.raiseRecoverable(this.pos, "Numeric separator is not allowed in legacy octal numeric literals");
          }
          if (lastCode === 95) {
            this.raiseRecoverable(this.pos, "Numeric separator must be exactly one underscore");
          }
          if (i === 0) {
            this.raiseRecoverable(this.pos, "Numeric separator is not allowed at the first of digits");
          }
          lastCode = code;
          continue;
        }
        if (code >= 97) {
          val = code - 97 + 10;
        } else if (code >= 65) {
          val = code - 65 + 10;
        } else if (code >= 48 && code <= 57) {
          val = code - 48;
        } else {
          val = Infinity;
        }
        if (val >= radix) {
          break;
        }
        lastCode = code;
        total = total * radix + val;
      }
      if (allowSeparators && lastCode === 95) {
        this.raiseRecoverable(this.pos - 1, "Numeric separator is not allowed at the last of digits");
      }
      if (this.pos === start || len != null && this.pos - start !== len) {
        return null;
      }
      return total;
    };
    pp.readRadixNumber = function(radix) {
      var start = this.pos;
      this.pos += 2;
      var val = this.readInt(radix);
      if (val == null) {
        this.raise(this.start + 2, "Expected number in radix " + radix);
      }
      if (this.options.ecmaVersion >= 11 && this.input.charCodeAt(this.pos) === 110) {
        val = stringToBigInt(this.input.slice(start, this.pos));
        ++this.pos;
      } else if (isIdentifierStart(this.fullCharCodeAtPos())) {
        this.raise(this.pos, "Identifier directly after number");
      }
      return this.finishToken(types$1.num, val);
    };
    pp.readNumber = function(startsWithDot) {
      var start = this.pos;
      if (!startsWithDot && this.readInt(10, void 0, true) === null) {
        this.raise(start, "Invalid number");
      }
      var octal = this.pos - start >= 2 && this.input.charCodeAt(start) === 48;
      if (octal && this.strict) {
        this.raise(start, "Invalid number");
      }
      var next = this.input.charCodeAt(this.pos);
      if (!octal && !startsWithDot && this.options.ecmaVersion >= 11 && next === 110) {
        var val$1 = stringToBigInt(this.input.slice(start, this.pos));
        ++this.pos;
        if (isIdentifierStart(this.fullCharCodeAtPos())) {
          this.raise(this.pos, "Identifier directly after number");
        }
        return this.finishToken(types$1.num, val$1);
      }
      if (octal && /[89]/.test(this.input.slice(start, this.pos))) {
        octal = false;
      }
      if (next === 46 && !octal) {
        ++this.pos;
        this.readInt(10);
        next = this.input.charCodeAt(this.pos);
      }
      if ((next === 69 || next === 101) && !octal) {
        next = this.input.charCodeAt(++this.pos);
        if (next === 43 || next === 45) {
          ++this.pos;
        }
        if (this.readInt(10) === null) {
          this.raise(start, "Invalid number");
        }
      }
      if (isIdentifierStart(this.fullCharCodeAtPos())) {
        this.raise(this.pos, "Identifier directly after number");
      }
      var val = stringToNumber(this.input.slice(start, this.pos), octal);
      return this.finishToken(types$1.num, val);
    };
    pp.readCodePoint = function() {
      var ch = this.input.charCodeAt(this.pos), code;
      if (ch === 123) {
        if (this.options.ecmaVersion < 6) {
          this.unexpected();
        }
        var codePos = ++this.pos;
        code = this.readHexChar(this.input.indexOf("}", this.pos) - this.pos);
        ++this.pos;
        if (code > 1114111) {
          this.invalidStringToken(codePos, "Code point out of bounds");
        }
      } else {
        code = this.readHexChar(4);
      }
      return code;
    };
    pp.readString = function(quote2) {
      var out = "", chunkStart = ++this.pos;
      for (; ; ) {
        if (this.pos >= this.input.length) {
          this.raise(this.start, "Unterminated string constant");
        }
        var ch = this.input.charCodeAt(this.pos);
        if (ch === quote2) {
          break;
        }
        if (ch === 92) {
          out += this.input.slice(chunkStart, this.pos);
          out += this.readEscapedChar(false);
          chunkStart = this.pos;
        } else if (ch === 8232 || ch === 8233) {
          if (this.options.ecmaVersion < 10) {
            this.raise(this.start, "Unterminated string constant");
          }
          ++this.pos;
          if (this.options.locations) {
            this.curLine++;
            this.lineStart = this.pos;
          }
        } else {
          if (isNewLine(ch)) {
            this.raise(this.start, "Unterminated string constant");
          }
          ++this.pos;
        }
      }
      out += this.input.slice(chunkStart, this.pos++);
      return this.finishToken(types$1.string, out);
    };
    INVALID_TEMPLATE_ESCAPE_ERROR = {};
    pp.tryReadTemplateToken = function() {
      this.inTemplateElement = true;
      try {
        this.readTmplToken();
      } catch (err) {
        if (err === INVALID_TEMPLATE_ESCAPE_ERROR) {
          this.readInvalidTemplateToken();
        } else {
          throw err;
        }
      }
      this.inTemplateElement = false;
    };
    pp.invalidStringToken = function(position, message) {
      if (this.inTemplateElement && this.options.ecmaVersion >= 9) {
        throw INVALID_TEMPLATE_ESCAPE_ERROR;
      } else {
        this.raise(position, message);
      }
    };
    pp.readTmplToken = function() {
      var out = "", chunkStart = this.pos;
      for (; ; ) {
        if (this.pos >= this.input.length) {
          this.raise(this.start, "Unterminated template");
        }
        var ch = this.input.charCodeAt(this.pos);
        if (ch === 96 || ch === 36 && this.input.charCodeAt(this.pos + 1) === 123) {
          if (this.pos === this.start && (this.type === types$1.template || this.type === types$1.invalidTemplate)) {
            if (ch === 36) {
              this.pos += 2;
              return this.finishToken(types$1.dollarBraceL);
            } else {
              ++this.pos;
              return this.finishToken(types$1.backQuote);
            }
          }
          out += this.input.slice(chunkStart, this.pos);
          return this.finishToken(types$1.template, out);
        }
        if (ch === 92) {
          out += this.input.slice(chunkStart, this.pos);
          out += this.readEscapedChar(true);
          chunkStart = this.pos;
        } else if (isNewLine(ch)) {
          out += this.input.slice(chunkStart, this.pos);
          ++this.pos;
          switch (ch) {
            case 13:
              if (this.input.charCodeAt(this.pos) === 10) {
                ++this.pos;
              }
            case 10:
              out += "\n";
              break;
            default:
              out += String.fromCharCode(ch);
              break;
          }
          if (this.options.locations) {
            ++this.curLine;
            this.lineStart = this.pos;
          }
          chunkStart = this.pos;
        } else {
          ++this.pos;
        }
      }
    };
    pp.readInvalidTemplateToken = function() {
      for (; this.pos < this.input.length; this.pos++) {
        switch (this.input[this.pos]) {
          case "\\":
            ++this.pos;
            break;
          case "$":
            if (this.input[this.pos + 1] !== "{") {
              break;
            }
          // fall through
          case "`":
            return this.finishToken(types$1.invalidTemplate, this.input.slice(this.start, this.pos));
          case "\r":
            if (this.input[this.pos + 1] === "\n") {
              ++this.pos;
            }
          // fall through
          case "\n":
          case "\u2028":
          case "\u2029":
            ++this.curLine;
            this.lineStart = this.pos + 1;
            break;
        }
      }
      this.raise(this.start, "Unterminated template");
    };
    pp.readEscapedChar = function(inTemplate) {
      var ch = this.input.charCodeAt(++this.pos);
      ++this.pos;
      switch (ch) {
        case 110:
          return "\n";
        // 'n' -> '\n'
        case 114:
          return "\r";
        // 'r' -> '\r'
        case 120:
          return String.fromCharCode(this.readHexChar(2));
        // 'x'
        case 117:
          return codePointToString(this.readCodePoint());
        // 'u'
        case 116:
          return "	";
        // 't' -> '\t'
        case 98:
          return "\b";
        // 'b' -> '\b'
        case 118:
          return "\v";
        // 'v' -> '\u000b'
        case 102:
          return "\f";
        // 'f' -> '\f'
        case 13:
          if (this.input.charCodeAt(this.pos) === 10) {
            ++this.pos;
          }
        // '\r\n'
        case 10:
          if (this.options.locations) {
            this.lineStart = this.pos;
            ++this.curLine;
          }
          return "";
        case 56:
        case 57:
          if (this.strict) {
            this.invalidStringToken(
              this.pos - 1,
              "Invalid escape sequence"
            );
          }
          if (inTemplate) {
            var codePos = this.pos - 1;
            this.invalidStringToken(
              codePos,
              "Invalid escape sequence in template string"
            );
          }
        default:
          if (ch >= 48 && ch <= 55) {
            var octalStr = this.input.substr(this.pos - 1, 3).match(/^[0-7]+/)[0];
            var octal = parseInt(octalStr, 8);
            if (octal > 255) {
              octalStr = octalStr.slice(0, -1);
              octal = parseInt(octalStr, 8);
            }
            this.pos += octalStr.length - 1;
            ch = this.input.charCodeAt(this.pos);
            if ((octalStr !== "0" || ch === 56 || ch === 57) && (this.strict || inTemplate)) {
              this.invalidStringToken(
                this.pos - 1 - octalStr.length,
                inTemplate ? "Octal literal in template string" : "Octal literal in strict mode"
              );
            }
            return String.fromCharCode(octal);
          }
          if (isNewLine(ch)) {
            if (this.options.locations) {
              this.lineStart = this.pos;
              ++this.curLine;
            }
            return "";
          }
          return String.fromCharCode(ch);
      }
    };
    pp.readHexChar = function(len) {
      var codePos = this.pos;
      var n = this.readInt(16, len);
      if (n === null) {
        this.invalidStringToken(codePos, "Bad character escape sequence");
      }
      return n;
    };
    pp.readWord1 = function() {
      this.containsEsc = false;
      var word = "", first = true, chunkStart = this.pos;
      var astral = this.options.ecmaVersion >= 6;
      while (this.pos < this.input.length) {
        var ch = this.fullCharCodeAtPos();
        if (isIdentifierChar(ch, astral)) {
          this.pos += ch <= 65535 ? 1 : 2;
        } else if (ch === 92) {
          this.containsEsc = true;
          word += this.input.slice(chunkStart, this.pos);
          var escStart = this.pos;
          if (this.input.charCodeAt(++this.pos) !== 117) {
            this.invalidStringToken(this.pos, "Expecting Unicode escape sequence \\uXXXX");
          }
          ++this.pos;
          var esc = this.readCodePoint();
          if (!(first ? isIdentifierStart : isIdentifierChar)(esc, astral)) {
            this.invalidStringToken(escStart, "Invalid Unicode escape");
          }
          word += codePointToString(esc);
          chunkStart = this.pos;
        } else {
          break;
        }
        first = false;
      }
      return word + this.input.slice(chunkStart, this.pos);
    };
    pp.readWord = function() {
      var word = this.readWord1();
      var type = types$1.name;
      if (this.keywords.test(word)) {
        type = keywords[word];
      }
      return this.finishToken(type, word);
    };
    version = "8.16.0";
    Parser.acorn = {
      Parser,
      version,
      defaultOptions,
      Position,
      SourceLocation,
      getLineInfo,
      Node,
      TokenType,
      tokTypes: types$1,
      keywordTypes: keywords,
      TokContext,
      tokContexts: types,
      isIdentifierChar,
      isIdentifierStart,
      Token,
      isNewLine,
      lineBreak,
      lineBreakG,
      nonASCIIwhitespace
    };
  }
});

// packages/runtime-javascript/src/javascript-runtime-policy.ts
function isAdmittedJavaScriptModule(value) {
  return typeof value === "string" && ADMITTED_JAVASCRIPT_MODULES.includes(value);
}
function isJavaScriptRuntimeSelectorAllowed(value) {
  return typeof value === "string" && /^[A-Za-z_$][0-9A-Za-z_$]*$/u.test(value) && !JAVASCRIPT_RUNTIME_RESERVED_SELECTOR_WORDS.includes(
    value
  );
}
var ADMITTED_JAVASCRIPT_MODULES, JAVASCRIPT_RUNTIME_RESERVED_SELECTOR_WORDS, SES_CONSOLE_COMPATIBILITY_REQUIRED;
var init_javascript_runtime_policy = __esm({
  "packages/runtime-javascript/src/javascript-runtime-policy.ts"() {
    "use strict";
    ADMITTED_JAVASCRIPT_MODULES = Object.freeze([
      "lodash",
      "lodash.js",
      "@datastructures-js/binary-search-tree",
      "@datastructures-js/deque",
      "@datastructures-js/graph",
      "@datastructures-js/heap",
      "@datastructures-js/linked-list",
      "@datastructures-js/priority-queue",
      "@datastructures-js/queue",
      "@datastructures-js/set",
      "@datastructures-js/stack",
      "@datastructures-js/trie"
    ]);
    JAVASCRIPT_RUNTIME_RESERVED_SELECTOR_WORDS = Object.freeze([
      "await",
      "break",
      "case",
      "catch",
      "class",
      "const",
      "continue",
      "debugger",
      "default",
      "delete",
      "do",
      "else",
      "enum",
      "export",
      "extends",
      "false",
      "finally",
      "for",
      "function",
      "if",
      "import",
      "in",
      "instanceof",
      "new",
      "null",
      "return",
      "super",
      "switch",
      "this",
      "throw",
      "true",
      "try",
      "typeof",
      "var",
      "void",
      "while",
      "with",
      "yield"
    ]);
    SES_CONSOLE_COMPATIBILITY_REQUIRED = "ERR_SES_CONSOLE_BUDGET_REQUIRES_COMPATIBILITY";
  }
});

// packages/runtime-javascript/src/ses-algorithm-worker.ts
var ses_algorithm_worker_exports = {};
function isSafeSelector(value) {
  return isJavaScriptRuntimeSelectorAllowed(value);
}
function assertPreparedShape(value) {
  if (!value || typeof value !== "object") {
    throw new Error("SES prepared source must be an object.");
  }
  const source = value;
  if (source.mode !== "code" && source.mode !== "trace" || source.language !== "javascript" && source.language !== "typescript" || typeof source.code !== "string" || !isSafeSelector(source.functionName)) {
    throw new Error("SES prepared source has invalid code or target name.");
  }
  if (source.mode === "trace" && (typeof source.instrumentedCode !== "string" || !source.traceLineBounds || !Number.isSafeInteger(source.traceLineBounds.startLine) || !Number.isSafeInteger(source.traceLineBounds.endLine) || source.traceLineBounds.startLine <= 0 || source.traceLineBounds.endLine < source.traceLineBounds.startLine || source.traceOptions !== void 0 && (!source.traceOptions || typeof source.traceOptions !== "object" || Array.isArray(source.traceOptions)))) {
    throw new Error("SES trace preparation has an invalid instrumented artifact.");
  }
  if (!["function", "solution-method", "ops-class"].includes(source.executionStyle ?? "")) {
    throw new Error("SES prepared source has an invalid execution style.");
  }
  if (!Array.isArray(source.requiredModules)) {
    throw new Error("SES prepared source has invalid required modules.");
  }
  for (let index = 0; index < source.requiredModules.length; index += 1) {
    if (!(index in source.requiredModules) || typeof source.requiredModules[index] !== "string") {
      throw new Error("SES prepared source has invalid required modules.");
    }
  }
  if (!Array.isArray(source.inputArguments)) {
    throw new Error("SES prepared source has invalid input arguments.");
  }
  for (let index = 0; index < source.inputArguments.length; index += 1) {
    const argument = source.inputArguments[index];
    if (!(index in source.inputArguments) || !argument || typeof argument !== "object" || typeof argument.key !== "string" || argument.rest !== void 0 && typeof argument.rest !== "boolean") {
      throw new Error("SES prepared source has invalid input arguments.");
    }
  }
  if (!source.materializers || typeof source.materializers !== "object" || Array.isArray(source.materializers)) {
    throw new Error("SES prepared source has invalid input materializers.");
  }
}
function assertAdmittedModules(source) {
  for (let index = 0; index < source.requiredModules.length; index += 1) {
    if (!isAdmittedJavaScriptModule(source.requiredModules[index])) {
      throw new Error("SES learner source requested an unadmitted module.");
    }
  }
}
function reply(id, value) {
  postMessage({ id, ok: true, value });
}
function safeErrorText(error) {
  const truncate = (text) => text.length <= 8192 ? text : `${text.slice(0, 8179)}\u2026[truncated]`;
  try {
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      try {
        const message = error.message;
        if (typeof message === "string") return truncate(message);
      } catch {
      }
    }
    try {
      return truncate(String(error));
    } catch {
      return "Unknown SES execution error.";
    }
  } catch {
    return "Unknown SES execution error.";
  }
}
function learnerErrorLine(error) {
  try {
    const privilegedStackReader = globalThis.getStackString;
    const stack = typeof privilegedStackReader === "function" ? privilegedStackReader(error) : error && typeof error === "object" ? error.stack : void 0;
    if (typeof stack !== "string") return void 0;
    const matches = [...stack.matchAll(/tracecode-ses-learner\.js:(\d+):\d+/gu)];
    const rawLine = matches.length > 0 ? Number(matches[0]?.[1]) : NaN;
    return Number.isSafeInteger(rawLine) && rawLine > 2 ? rawLine - 2 : void 0;
  } catch {
    return void 0;
  }
}
function fail(id, error, stage = "control") {
  const response = { id, ok: false, error: safeErrorText(error), stage };
  try {
    postMessage(response);
  } catch {
    try {
      postMessage({
        id: Number.isSafeInteger(id) ? id : -1,
        ok: false,
        error: "SES worker could not serialize its failure response.",
        stage: "control"
      });
    } catch {
    }
  }
}
function isLearnerEngineSyntaxError(error) {
  return error instanceof SyntaxError;
}
function deterministicCapabilityPrelude(source) {
  const taskAndClock = `
  let __tracecodePerformanceClock = 0;
  let __tracecodeTimerSequence = 1;
  const __tracecodeTimers = new Map();
  const __tracecodeQueueMicrotask = (callback) => {
    if (typeof callback !== 'function') throw new TypeError('queueMicrotask callback must be a function');
    Promise.resolve().then(() => { try { callback(); } catch {} });
  };
  const __tracecodeSetTimeout = (callback, _delay, ...args) => {
    if (typeof callback !== 'function') throw new TypeError('setTimeout callback must be a function');
    const id = __tracecodeTimerSequence++;
    __tracecodeTimers.set(id, true);
    Promise.resolve().then(() => {
      if (!__tracecodeTimers.delete(id)) return;
      try { callback(...args); } catch {}
    });
    return id;
  };
  const __tracecodeClearTimeout = (id) => { __tracecodeTimers.delete(id); };
  Object.defineProperties(globalThis, {
    performance: {
      value: Object.freeze({
        now: () => __tracecodePerformanceClock++,
        timeOrigin: 1700000000000,
      }),
      writable: false,
      configurable: false,
    },
    queueMicrotask: { value: __tracecodeQueueMicrotask, writable: false, configurable: false },
    setTimeout: { value: __tracecodeSetTimeout, writable: false, configurable: false },
    clearTimeout: { value: __tracecodeClearTimeout, writable: false, configurable: false },
  });`;
  const math = /\bMath\b/u.test(source.code) || source.requiredModules.length > 0 ? `
  const __tracecodeSharedMath = globalThis.Math;
  let __tracecodeRandomState = 0x9e3779b9;
  const __tracecodeRandom = () => {
    __tracecodeRandomState ^= __tracecodeRandomState << 13;
    __tracecodeRandomState ^= __tracecodeRandomState >>> 17;
    __tracecodeRandomState ^= __tracecodeRandomState << 5;
    return (__tracecodeRandomState >>> 0) / 4294967296;
  };
  const __tracecodeMathDescriptors = Object.getOwnPropertyDescriptors(__tracecodeSharedMath);
  __tracecodeMathDescriptors.random = {
    value: __tracecodeRandom,
    writable: false,
    enumerable: false,
    configurable: false,
  };
  const Math = Object.freeze(Object.defineProperties({}, __tracecodeMathDescriptors));
  globalThis.Math = Math;` : "";
  const date = /\bDate\b/u.test(source.code) || source.requiredModules.length > 0 ? `
  const __tracecodeSharedDate = globalThis.Date;
  let __tracecodeClock = 1700000000000;
  const __tracecodeDateNow = () => __tracecodeClock++;
  const Date = function (...args) {
    if (new.target) {
      return Reflect.construct(
        __tracecodeSharedDate,
        args.length === 0 ? [__tracecodeDateNow()] : args,
        new.target
      );
    }
    return Reflect.construct(__tracecodeSharedDate, [__tracecodeDateNow()]).toString();
  };
  Object.setPrototypeOf(Date.prototype, __tracecodeSharedDate.prototype);
  Object.defineProperties(Date, {
    name: { value: 'Date', configurable: true },
    length: { value: 7, configurable: true },
    parse: Object.getOwnPropertyDescriptor(__tracecodeSharedDate, 'parse'),
    UTC: Object.getOwnPropertyDescriptor(__tracecodeSharedDate, 'UTC'),
  });
  Object.defineProperty(Date, 'now', {
    value: __tracecodeDateNow,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.freeze(Date.prototype);
  Object.freeze(Date);
  globalThis.Date = Date;` : "";
  return `${taskAndClock}${math}${date}`;
}
function decodeOutputTransport(value, depth = 0) {
  if (depth > 192 || !Array.isArray(value) || value.length < 1 || typeof value[0] !== "string") {
    throw new Error("SES compartment returned an invalid output transport value.");
  }
  const tag = value[0];
  if (tag === "null" && value.length === 1) return null;
  if (tag === "undefined" && value.length === 1) return void 0;
  if (tag === "negative-zero" && value.length === 1) return -0;
  if (tag === "nan" && value.length === 1) return Number.NaN;
  if (tag === "infinity" && value.length === 1) return Infinity;
  if (tag === "negative-infinity" && value.length === 1) return -Infinity;
  if (tag === "hole" && value.length === 1) return OUTPUT_TRANSPORT_HOLE;
  if (tag === "string" && value.length === 2 && typeof value[1] === "string") {
    return value[1];
  }
  if (tag === "boolean" && value.length === 2 && typeof value[1] === "boolean") {
    return value[1];
  }
  if (tag === "number" && value.length === 2 && typeof value[1] === "number" && Number.isFinite(value[1])) {
    return value[1];
  }
  if (tag === "array" && value.length === 2 && Array.isArray(value[1])) {
    const encodedItems = value[1];
    const decoded = new Array(encodedItems.length);
    for (let index = 0; index < encodedItems.length; index += 1) {
      if (!(index in encodedItems)) {
        throw new Error("SES compartment returned a sparse output transport array.");
      }
      const item = decodeOutputTransport(encodedItems[index], depth + 1);
      if (item !== OUTPUT_TRANSPORT_HOLE) decoded[index] = item;
    }
    return decoded;
  }
  if (tag === "object" && value.length === 2 && Array.isArray(value[1])) {
    const decoded = {};
    for (const encodedEntry of value[1]) {
      if (!Array.isArray(encodedEntry) || encodedEntry.length !== 2 || typeof encodedEntry[0] !== "string") {
        throw new Error("SES compartment returned an invalid output transport entry.");
      }
      const child = decodeOutputTransport(encodedEntry[1], depth + 1);
      if (child === OUTPUT_TRANSPORT_HOLE) {
        throw new Error("SES compartment returned an object transport hole.");
      }
      Object.defineProperty(decoded, encodedEntry[0], {
        value: child,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
    return decoded;
  }
  throw new Error("SES compartment returned an invalid output transport value.");
}
function learnerRestriction(message, line) {
  return new SyntaxError(
    `TraceCode algorithm runtime restriction${line ? ` at learner line ${line}` : ""}: ${message}`
  );
}
function maskComment(source) {
  return source.replace(/[^\r\n\u2028\u2029]/g, " ");
}
function escapeCensoredText(source) {
  return source.replaceAll("<!--", "\\x3c!--").replaceAll("-->", "\\x2d->").replace(/\bimport(?=\s*(?:\(|\/[/*]))/gu, "\\x69mport");
}
function lineTerminators(source) {
  return source.match(/\r\n|[\n\r\u2028\u2029]/gu) ?? [];
}
function normalizationFingerprint(root) {
  const values2 = [];
  const visit = (node) => {
    const record = node;
    if (node.type === "Literal") {
      const literal2 = record;
      if (literal2.regex) {
        values2.push(`regexp:${literal2.regex.pattern ?? ""}/${literal2.regex.flags ?? ""}`);
      } else if (typeof literal2.bigint === "string") {
        values2.push(`bigint:${literal2.bigint}`);
      } else if (typeof literal2.value === "number") {
        const number = literal2.value;
        values2.push(`number:${Object.is(number, -0) ? "-0" : String(number)}`);
      } else {
        values2.push(`${typeof literal2.value}:${JSON.stringify(literal2.value)}`);
      }
    } else if (node.type === "TemplateElement") {
      const element = record;
      values2.push(`template:${JSON.stringify(element.value?.cooked ?? null)}`);
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && typeof child.type === "string") {
            visit(child);
          }
        }
      } else if (value && typeof value === "object" && "type" in value) {
        visit(value);
      }
    }
  };
  visit(root);
  return JSON.stringify(values2);
}
function preserveTokenLineCount(encoded, original) {
  const terminators = lineTerminators(original);
  if (terminators.length === 0) return encoded;
  return encoded.slice(0, -1) + terminators.map((ending) => `\\${ending}`).join("") + encoded.slice(-1);
}
function encodeStringLiteral(value, original) {
  const encoded = JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return preserveTokenLineCount(escapeCensoredText(encoded), original);
}
function encodeTemplateElement(value, original) {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (character === "\\") encoded += "\\\\";
    else if (character === "`") encoded += "\\`";
    else if (character === "$" && next === "{") encoded += "\\$";
    else if (character === "\n") encoded += "\\n";
    else if (character === "\r") encoded += "\\r";
    else if (character === "\u2028") encoded += "\\u2028";
    else if (character === "\u2029") encoded += "\\u2029";
    else if (character < " ") {
      encoded += `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
    } else encoded += character;
  }
  const terminators = lineTerminators(original);
  return escapeCensoredText(encoded) + terminators.map((ending) => `\\${ending}`).join("");
}
function sanitizeLearnerSource(source) {
  const comments = [];
  const ast = parse4(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
    onComment: comments
  });
  const replacements = comments.map((comment) => ({
    start: comment.start,
    end: comment.end,
    text: maskComment(source.slice(comment.start, comment.end))
  }));
  const taggedTemplateElements = /* @__PURE__ */ new Set();
  const visit = (node) => {
    const record = node;
    if (node.type === "TaggedTemplateExpression") {
      const quasi = record.quasi;
      for (const element of quasi?.quasis ?? []) taggedTemplateElements.add(element);
    }
    if (node.type === "CallExpression") {
      const callee = record.callee;
      if (callee?.type === "Identifier" && callee.name === "eval") {
        throw learnerRestriction("direct eval is not supported.", callee.loc?.start.line);
      }
    }
    if (node.type === "ImportExpression") {
      throw learnerRestriction("dynamic import is not supported.", node.loc?.start.line);
    }
    if (node.type === "Literal") {
      const literal2 = record;
      if (literal2.regex) {
        const raw = source.slice(node.start, node.end);
        if (escapeCensoredText(raw) !== raw) {
          throw learnerRestriction(
            "regular-expression source contains a source-censored token sequence.",
            node.loc?.start.line
          );
        }
      } else if (typeof literal2.value === "string") {
        const raw = source.slice(node.start, node.end);
        if (escapeCensoredText(raw) !== raw) {
          replacements.push({
            start: node.start,
            end: node.end,
            text: encodeStringLiteral(literal2.value, raw)
          });
        }
      }
    }
    if (node.type === "TemplateElement") {
      const element = record;
      const raw = source.slice(node.start, node.end);
      if (escapeCensoredText(raw) !== raw) {
        if (taggedTemplateElements.has(node)) {
          throw learnerRestriction(
            "tagged template raw text contains a source-censored token sequence.",
            node.loc?.start.line
          );
        }
        if (typeof element.value?.cooked !== "string") {
          throw learnerRestriction(
            "template text could not be normalized safely.",
            node.loc?.start.line
          );
        }
        replacements.push({
          start: node.start,
          end: node.end,
          text: encodeTemplateElement(element.value.cooked, raw)
        });
      }
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && typeof child.type === "string") {
            visit(child);
          }
        }
      } else if (value && typeof value === "object" && "type" in value) {
        visit(value);
      }
    }
  };
  visit(ast);
  let sanitized = source;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    sanitized = sanitized.slice(0, replacement.start) + replacement.text + sanitized.slice(replacement.end);
  }
  const censoredIndex = sanitized.search(/<!--|-->/u);
  if (censoredIndex >= 0) {
    const line = sanitized.slice(0, censoredIndex).split(/\r\n?|\n|\u2028|\u2029/u).length;
    throw learnerRestriction("HTML comment tokens are not supported.", line);
  }
  const importIndex = sanitized.search(/(^|[^.]|\.\.\.)\bimport\s*(?:\(|\/[/*])/u);
  if (importIndex >= 0) {
    const line = sanitized.slice(0, importIndex).split(/\r\n?|\n|\u2028|\u2029/u).length;
    throw learnerRestriction("dynamic import-like source is not supported.", line);
  }
  let normalizedAst;
  try {
    normalizedAst = parse4(sanitized, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true
    });
  } catch (error) {
    throw new SourceNormalizationInvariantError(
      "SES source normalization produced invalid JavaScript.",
      { cause: error }
    );
  }
  if (normalizationFingerprint(normalizedAst) !== normalizationFingerprint(ast) || lineTerminators(sanitized).length !== lineTerminators(source).length) {
    throw new SourceNormalizationInvariantError(
      "SES source normalization changed learner literal values or line structure."
    );
  }
  try {
    parse4(`async function __tracecodeStrictProbe__() {
"use strict";
${sanitized}
}`, {
      ecmaVersion: "latest",
      sourceType: "script",
      locations: true
    });
  } catch (error) {
    const location = error.loc;
    const learnerLine = typeof location?.line === "number" ? Math.max(1, location.line - 2) : void 0;
    const detail = (error instanceof Error ? error.message : safeErrorText(error)).replace(/\s*\(\d+:\d+\)\s*$/u, "");
    throw learnerRestriction(`JavaScript must be strict-compatible. ${detail}`, learnerLine);
  }
  return sanitized;
}
function collectCustomMaterializerNames(materializers) {
  const names = /* @__PURE__ */ new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== "object" || depth > 32) return;
    const descriptor = value;
    if (descriptor.kind === "custom" && typeof descriptor.typeName === "string" && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(descriptor.typeName)) {
      names.add(descriptor.typeName);
    }
    visit(descriptor.element, depth + 1);
    visit(descriptor.value, depth + 1);
  };
  for (const descriptor of Object.values(materializers)) visit(descriptor, 0);
  return [...names].sort();
}
function trustedConstructorRegistrySource(source) {
  const entries2 = collectCustomMaterializerNames(source.materializers).map((typeName) => {
    const [root, ...properties] = typeName.split(".");
    if (!root || !isSafeSelector(root)) return `${JSON.stringify(typeName)}: undefined`;
    const expression = properties.reduce(
      (current2, property) => `${current2}?.${property}`,
      root
    );
    return `${JSON.stringify(typeName)}: (typeof ${root} !== 'undefined' && typeof ${expression} === 'function' ? ${expression} : undefined)`;
  });
  return `globalThis.__tracecodeConstructors = Object.freeze({${entries2.join(",")}});`;
}
function learnerBody(source, code) {
  const targetIdentifier = source.executionStyle === "solution-method" ? "Solution" : source.functionName;
  return `${code}
;${trustedConstructorRegistrySource(source)}
globalThis.__tracecodeTarget = typeof ${targetIdentifier} === 'undefined' ? undefined : ${targetIdentifier};`;
}
function traceMaxPathDepth(source) {
  const value = source.traceOptions?.maxPathDepth;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(8, Math.max(1, Math.floor(value))) : 3;
}
function learnerFactorySource(source, code, tracing = false) {
  const tracePrelude = tracing ? `const __TRACE_V4_MAX_PATH_DEPTH = ${traceMaxPathDepth(source)};
${"\nconst __TRACE_DEFERRED_SCALAR_UPDATE = Symbol.for('tracecode.deferredScalarUpdate');\n\nfunction __traceDeferredPostUpdateScalar(__varName, __update, __current, __location) {\n  const __result = typeof __update === 'function' ? __update() : undefined;\n  const __value = typeof __current === 'function' ? __current() : __result;\n  let __flushed = false;\n  return {\n    [__TRACE_DEFERRED_SCALAR_UPDATE]: true,\n    value: __result,\n    flush() {\n      if (__flushed) return;\n      __flushed = true;\n      __traceScalarWrite(__varName, __value, __location);\n    },\n  };\n}\n\nfunction __traceIsDeferredScalarUpdate(__value) {\n  return Boolean(__value && typeof __value === 'object' && __value[__TRACE_DEFERRED_SCALAR_UPDATE] === true);\n}\n\nfunction __traceResolvedIndexValue(__index) {\n  return __traceIsDeferredScalarUpdate(__index) ? __index.value : __index;\n}\n\nfunction __traceResolveIndexValues(__indices) {\n  return Array.isArray(__indices) ? __indices.map((__index) => __traceResolvedIndexValue(__index)) : __indices;\n}\n\nfunction __tracePathSegment(__index) {\n  const __resolved = __traceResolvedIndexValue(__index);\n  if (typeof __resolved === 'number' && Number.isInteger(__resolved)) return Math.trunc(__resolved);\n  if (typeof __resolved === 'string' && __resolved.length > 0) return __resolved;\n  if (__resolved && typeof __resolved === 'object') {\n    if (typeof __resolved.__id__ === 'string' && __resolved.__id__.length > 0) return __resolved.__id__;\n    if (typeof __resolved.__ref__ === 'string' && __resolved.__ref__.length > 0) return __resolved.__ref__;\n  }\n  return null;\n}\n\nfunction __traceFlushDeferredScalarUpdates(__indices) {\n  if (!Array.isArray(__indices)) return;\n  for (const __index of __indices) {\n    if (__traceIsDeferredScalarUpdate(__index) && typeof __index.flush === 'function') {\n      __index.flush();\n    }\n  }\n}\n\nfunction __traceNormalizeIndices(__indices, __maxDepth = __TRACE_V4_MAX_PATH_DEPTH) {\n  if (!Array.isArray(__indices) || __indices.length === 0 || __indices.length > __maxDepth) return null;\n  const __normalized = __indices.map((__index) => __tracePathSegment(__index));\n  if (!__normalized.every((__index) =>\n    (typeof __index === 'number' && Number.isInteger(__index)) ||\n    (typeof __index === 'string' && __index.length > 0)\n  )) return null;\n  return __normalized;\n}\n\nfunction __traceNormalizeIndexSources(__indexSources, __pathLength) {\n  if (!Array.isArray(__indexSources) || !Number.isInteger(__pathLength) || __pathLength <= 0) return null;\n  const __normalized = __indexSources.slice(0, __pathLength).map((__source) =>\n    typeof __source === 'string' && __source.length > 0 ? __source : null\n  );\n  while (__normalized.length < __pathLength) __normalized.push(null);\n  return __normalized.some((__source) => __source !== null) ? __normalized : null;\n}\n\nfunction __traceReadValueAtIndices(__container, __indices) {\n  let __current = __container;\n  const __resolvedIndices = __traceResolveIndexValues(__indices);\n  for (let __i = 0; __i < __resolvedIndices.length; __i += 1) {\n    const __index = __resolvedIndices[__i];\n    if (\n      __i === __resolvedIndices.length - 1 &&\n      __traceIsMetadataProperty(__current, __index)\n    ) {\n      return __current[__index];\n    }\n    __current = __traceIsMapLike(__current) ? __current.get(__index) : __current[__index];\n  }\n  return __current;\n}\n\nfunction __traceIsMapLike(__value) {\n  return __value instanceof Map ||\n    (!!__value &&\n      typeof __value === 'object' &&\n      typeof __value.get === 'function' &&\n      typeof __value.set === 'function' &&\n      typeof __value.has === 'function' &&\n      typeof __value.delete === 'function');\n}\n\nfunction __traceWriteValueAtIndices(__container, __indices, __value) {\n  const __effectiveIndices = __traceResolveIndexValues(__indices);\n  if (__effectiveIndices.length === 1) {\n    __container[__effectiveIndices[0]] = __value;\n    return __value;\n  }\n  let __parent = __container;\n  for (let __i = 0; __i < __effectiveIndices.length - 1; __i++) {\n    __parent = __parent[__effectiveIndices[__i]];\n  }\n  __parent[__effectiveIndices[__effectiveIndices.length - 1]] = __value;\n  return __value;\n}\n\nfunction __traceReadIndex(__varName, __container, __indices, __indexSources, __location) {\n  const __normalized = __traceNormalizeIndices(__indices);\n  const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __normalized?.length ?? 0);\n  const __value = __traceReadValueAtIndices(__container, Array.isArray(__indices) ? __indices : []);\n  if (__normalized) {\n    __traceRecorder.recordAccess({\n      variable: __varName,\n      kind: __normalized.length === 2 ? 'cell-read' : 'indexed-read',\n      indices: __normalized,\n      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n      pathDepth: __normalized.length,\n      value: __value,\n      ...__traceNormalizeSourceLocation(__location),\n    });\n  }\n  __traceFlushDeferredScalarUpdates(__indices);\n  return __value;\n}\n\nfunction __traceHasIndex(__varName, __container, __indices, __indexSources, __key, __location) {\n  const __rawBaseIndices = Array.isArray(__indices) ? __indices : [];\n  const __baseIndices = __traceResolveIndexValues(__rawBaseIndices);\n  const __target = __traceReadValueAtIndices(__container, __baseIndices);\n  const __result = __key in __target;\n  const __path = [...__baseIndices, __key];\n  const __normalized = __traceNormalizeIndices(__path);\n  const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __normalized?.length ?? 0);\n  if (__normalized) {\n    __traceRecorder.recordAccess({\n      variable: __varName,\n      kind: __normalized.length === 2 ? 'cell-read' : 'indexed-read',\n      indices: __normalized,\n      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n      pathDepth: __normalized.length,\n      value: __result,\n      ...__traceNormalizeSourceLocation(__location),\n    });\n  }\n  __traceFlushDeferredScalarUpdates(__rawBaseIndices);\n  return __result;\n}\n\nfunction __traceSplitBindingNames(__bindingName) {\n  if (typeof __bindingName !== 'string' || !__bindingName.includes(',')) return [];\n  return __bindingName\n    .split(',')\n    .map((__name) => __name.trim())\n    .filter((__name) => __name.length > 0);\n}\n\nfunction __traceDestructuredBindingSlotValue(__value, __slot) {\n  if (Array.isArray(__value) || typeof __value === 'string') {\n    return { hasValue: true, value: __value[__slot] };\n  }\n  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(__value) && !(typeof DataView !== 'undefined' && __value instanceof DataView)) {\n    return { hasValue: true, value: __value[__slot] };\n  }\n  if (__value && typeof __value === 'object') {\n    const __descriptor = Object.getOwnPropertyDescriptor(__value, String(__slot));\n    if (__descriptor && Object.prototype.hasOwnProperty.call(__descriptor, 'value')) {\n      return { hasValue: true, value: __descriptor.value };\n    }\n  }\n  return { hasValue: false, value: undefined };\n}\n\nfunction __traceRecordDestructuredIterationBindings(__varName, __basePath, __baseSources, __iterationIndex, __value, __bindingName, __location) {\n  const __bindingNames = __traceSplitBindingNames(__bindingName);\n  if (__bindingNames.length === 0) return;\n  for (let __slot = 0; __slot < __bindingNames.length; __slot += 1) {\n    const __slotValue = __traceDestructuredBindingSlotValue(__value, __slot);\n    if (!__slotValue.hasValue) continue;\n    const __path = [...__basePath, __iterationIndex, __slot];\n    const __normalized = __traceNormalizeIndices(__path);\n    if (!__normalized) continue;\n    const __sources = Array.isArray(__baseSources)\n      ? [...__baseSources, null, null]\n      : null;\n    const __normalizedSources = __traceNormalizeIndexSources(__sources, __normalized.length);\n    const __iterationSources = Array.isArray(__normalizedSources)\n      ? __normalizedSources\n      : (Array.isArray(__sources) && __sources.length === __normalized.length ? __sources : null);\n    __traceRecorder.recordAccess({\n      variable: __varName,\n      kind: __normalized.length === 2 ? 'cell-read' : 'indexed-read',\n      indices: __normalized,\n      pathDepth: __normalized.length,\n      value: __slotValue.value,\n      ...(Array.isArray(__iterationSources) ? { indexSources: __iterationSources } : {}),\n      binding: { kind: 'iteration', variable: __bindingNames[__slot] },\n      ...__traceNormalizeSourceLocation(__location),\n    });\n  }\n}\n\nfunction* __traceIterableBind(__varName, __iterable, __bindingName, __location) {\n  if (\n    typeof __varName !== 'string' ||\n    typeof __bindingName !== 'string' ||\n    (__iterable === null || __iterable === undefined) ||\n    typeof __iterable[Symbol.iterator] !== 'function'\n  ) {\n    yield* __iterable;\n    return;\n  }\n  let __index = 0;\n  for (const __value of __iterable) {\n    const __sources = [null];\n    __traceRecorder.recordAccess({\n      variable: __varName,\n      kind: 'indexed-read',\n      indices: [__index],\n      pathDepth: 1,\n      indexSources: __sources,\n      value: __value,\n      binding: { kind: 'iteration', variable: __bindingName },\n      ...__traceNormalizeSourceLocation(__location),\n    });\n    __traceRecordDestructuredIterationBindings(__varName, [], [], __index, __value, __bindingName, __location);\n    __index += 1;\n    yield __value;\n  }\n}\n\nfunction* __traceIterableBindIndexed(__varName, __iterable, __baseIndices, __indexSources, __bindingName, __location) {\n  if (\n    typeof __varName !== 'string' ||\n    typeof __bindingName !== 'string' ||\n    (__iterable === null || __iterable === undefined) ||\n    typeof __iterable[Symbol.iterator] !== 'function'\n  ) {\n    yield* __iterable;\n    return;\n  }\n  const __base = __traceNormalizeIndices(__baseIndices);\n  const __baseSources = __traceNormalizeIndexSources(__indexSources, __base?.length ?? 0);\n  if (__base) {\n    __traceRecorder.recordAccess({\n      variable: __varName,\n      kind: __base.length === 2 ? 'cell-read' : 'indexed-read',\n      indices: __base,\n      pathDepth: __base.length,\n      value: __iterable,\n      ...(Array.isArray(__baseSources) ? { indexSources: __baseSources } : {}),\n      ...__traceNormalizeSourceLocation(__location),\n    });\n  }\n  __traceFlushDeferredScalarUpdates(__baseIndices);\n  let __index = 0;\n  for (const __value of __iterable) {\n    if (__base) {\n      const __path = [...__base, __index];\n      const __sources = Array.isArray(__baseSources) ? [...__baseSources, null] : null;\n      __traceRecorder.recordAccess({\n        variable: __varName,\n        kind: __path.length === 2 ? 'cell-read' : 'indexed-read',\n        indices: __path,\n        pathDepth: __path.length,\n        value: __value,\n        ...(Array.isArray(__sources) ? { indexSources: __sources } : {}),\n        binding: { kind: 'iteration', variable: __bindingName },\n        ...__traceNormalizeSourceLocation(__location),\n      });\n      __traceRecordDestructuredIterationBindings(__varName, __base, __baseSources, __index, __value, __bindingName, __location);\n    }\n    __index += 1;\n    yield __value;\n  }\n}\n\nfunction __traceIsMetadataProperty(__container, __propertyName) {\n  if (__propertyName === 'length') {\n    return Array.isArray(__container) || typeof __container === 'string';\n  }\n  if (__propertyName === 'size') {\n    return __traceIsMapLike(__container) || __container instanceof Set;\n  }\n  return false;\n}\n\nfunction __traceNormalizeSourceLocation(__location) {\n  if (!__location || typeof __location !== 'object') return {};\n  const __line = Number(__location.line);\n  const __column = Number(__location.column);\n  return {\n    ...(Number.isFinite(__line) && __line > 0 ? { line: Math.trunc(__line) } : {}),\n    ...(Number.isFinite(__column) && __column >= 0 ? { column: Math.trunc(__column) } : {}),\n  };\n}\n\nfunction __traceReadProperty(__varName, __container, __propertyName, __scopeOrLocation, __maybeLocation) {\n  const __scope = typeof __scopeOrLocation === 'string' ? __scopeOrLocation : undefined;\n  const __location = typeof __scopeOrLocation === 'string' ? __maybeLocation : __scopeOrLocation;\n  const __value = __container[__propertyName];\n  __traceRecorder.recordAccess({\n    variable: __varName,\n    kind: 'indexed-read',\n    indices: [__propertyName],\n    pathDepth: 1,\n    value: __value,\n    ...(__scope ? { scope: __scope } : {}),\n    ...__traceNormalizeSourceLocation(__location),\n  });\n  return __value;\n}\n\nfunction __traceRecordIndexWrite(__varName, __indices, __indexSources, __location) {\n  const __normalized = __traceNormalizeIndices(__indices);\n  if (!__normalized) {\n    return undefined;\n  }\n  const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __normalized.length);\n  __traceRecorder.recordAccess({\n    variable: __varName,\n    kind: __normalized.length === 2 ? 'cell-write' : 'indexed-write',\n    indices: __normalized,\n    ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n    pathDepth: __normalized.length,\n    ...__traceNormalizeSourceLocation(__location),\n  });\n  __traceFlushDeferredScalarUpdates(__indices);\n  return undefined;\n}\n\nfunction __traceWriteIndex(__varName, __container, __indices, __indexSources, __value, __location) {\n  const __normalized = __traceNormalizeIndices(__indices);\n  const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __normalized?.length ?? 0);\n  const __effectiveIndices = Array.isArray(__indices) ? __indices : [];\n  const __result = __traceWriteValueAtIndices(__container, __effectiveIndices, __value);\n  if (__normalized) {\n    __traceRecorder.recordAccess({\n      variable: __varName,\n      kind: __normalized.length === 2 ? 'cell-write' : 'indexed-write',\n      indices: __normalized,\n      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n      pathDepth: __normalized.length,\n      value: __result,\n      ...__traceNormalizeSourceLocation(__location),\n    });\n  }\n  __traceFlushDeferredScalarUpdates(__effectiveIndices);\n  return __result;\n}\n\nfunction __traceWriteResolvedIndex(__varName, __parent, __lastIndex, __indices, __indexSources, __value, __location) {\n  const __normalized = __traceNormalizeIndices(__indices);\n  const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __normalized?.length ?? 0);\n  const __effectiveIndices = Array.isArray(__indices) ? __traceResolveIndexValues(__indices) : [];\n  const __effectiveLastIndex = __traceResolvedIndexValue(__lastIndex);\n  __parent[__effectiveLastIndex] = __value;\n  if (__normalized) {\n    __traceRecorder.recordAccess({\n      variable: __varName,\n      kind: __normalized.length === 2 ? 'cell-write' : 'indexed-write',\n      indices: __normalized,\n      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n      pathDepth: __normalized.length,\n      value: __value,\n      ...__traceNormalizeSourceLocation(__location),\n    });\n  }\n  __traceFlushDeferredScalarUpdates(__effectiveIndices);\n  return __value;\n}\n\nfunction __traceScalarWrite(__varName, __value, __location) {\n  __traceRecorder.recordAccess({\n    variable: __varName,\n    kind: 'indexed-write',\n    value: __value,\n    ...__traceNormalizeSourceLocation(__location),\n  });\n  return __value;\n}\n\nfunction __traceScalarRead(__varName, __value, __location) {\n  __traceRecorder.recordAccess({\n    variable: __varName,\n    kind: 'indexed-read',\n    value: __value,\n    ...__traceNormalizeSourceLocation(__location),\n  });\n  return __value;\n}\n\nfunction __traceAssignScalar(__varName, __value, __location) {\n  return __traceScalarWrite(__varName, __value, __location);\n}\n\nfunction __traceUpdateScalar(__varName, __update, __current, __isPrefix, __location) {\n  const __result = typeof __update === 'function' ? __update() : undefined;\n  const __value = typeof __current === 'function' ? __current() : __result;\n  __traceScalarWrite(__varName, __value, __location);\n  return __isPrefix ? __value : __result;\n}\n\nfunction __traceApplyAugmentedValue(__current, __op, __rhs) {\n  switch (__op) {\n    case 'add': return __current + __rhs;\n    case 'sub': return __current - __rhs;\n    case 'mul': return __current * __rhs;\n    case 'div': return __current / __rhs;\n    case 'mod': return __current % __rhs;\n    case 'pow': return __current ** __rhs;\n    case 'lshift': return __current << __rhs;\n    case 'rshift': return __current >> __rhs;\n    case 'bitand': return __current & __rhs;\n    case 'bitor': return __current | __rhs;\n    case 'bitxor': return __current ^ __rhs;\n    default: return __rhs;\n  }\n}\n\nfunction __traceAugAssignIndex(__varName, __container, __indices, __indexSources, __op, __rhs, __location) {\n  const __normalized = __traceNormalizeIndices(__indices);\n  const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __normalized?.length ?? 0);\n  const __effectiveIndices = Array.isArray(__indices) ? __indices : [];\n  const __current = __traceReadValueAtIndices(__container, __effectiveIndices);\n  if (__normalized) {\n    __traceRecorder.recordAccess({\n      variable: __varName,\n      kind: __normalized.length === 2 ? 'cell-read' : 'indexed-read',\n      indices: __normalized,\n      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n      pathDepth: __normalized.length,\n      ...__traceNormalizeSourceLocation(__location),\n    });\n  }\n  const __next = __traceApplyAugmentedValue(__current, __op, __rhs);\n  __traceWriteValueAtIndices(__container, __effectiveIndices, __next);\n  if (__normalized) {\n    __traceRecorder.recordAccess({\n      variable: __varName,\n      kind: __normalized.length === 2 ? 'cell-write' : 'indexed-write',\n      indices: __normalized,\n      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n      pathDepth: __normalized.length,\n      value: __next,\n      ...__traceNormalizeSourceLocation(__location),\n    });\n  }\n  __traceFlushDeferredScalarUpdates(__effectiveIndices);\n  return __next;\n}\n\nfunction __traceUpdateIndex(__varName, __container, __indices, __indexSources, __op, __isPrefix, __location) {\n  const __normalized = __traceNormalizeIndices(__indices);\n  const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __normalized?.length ?? 0);\n  const __effectiveIndices = Array.isArray(__indices) ? __indices : [];\n  const __current = __traceReadValueAtIndices(__container, __effectiveIndices);\n  if (__normalized) {\n    __traceRecorder.recordAccess({\n      variable: __varName,\n      kind: __normalized.length === 2 ? 'cell-read' : 'indexed-read',\n      indices: __normalized,\n      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n      pathDepth: __normalized.length,\n      ...__traceNormalizeSourceLocation(__location),\n    });\n  }\n  const __delta = __op === 'dec' ? -1 : 1;\n  const __next = __current + __delta;\n  __traceWriteValueAtIndices(__container, __effectiveIndices, __next);\n  if (__normalized) {\n    __traceRecorder.recordAccess({\n      variable: __varName,\n      kind: __normalized.length === 2 ? 'cell-write' : 'indexed-write',\n      indices: __normalized,\n      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n      pathDepth: __normalized.length,\n      value: __next,\n      ...__traceNormalizeSourceLocation(__location),\n    });\n  }\n  __traceFlushDeferredScalarUpdates(__effectiveIndices);\n  return __isPrefix ? __next : __current;\n}\n\nfunction __traceNormalizeMethodName(__container, __method, __args) {\n  void __container;\n  void __args;\n  return __method;\n}\n\nfunction __traceStdout(__line, ...__args) {\n  console.log(...__args);\n  __traceRecorder.recordStdout(__line, __args.map((__arg) => String(__arg)).join(' '));\n}\n\nfunction __traceExceptionValue(__line, __error) {\n  __traceRecorder.recordException(__line, __error);\n  return __error;\n}\n\nfunction __traceMutatingCall(__varName, __container, __indices, __indexSources, __method, __location, ...__args) {\n  const __sourceLocation = __traceNormalizeSourceLocation(__location);\n  const __rawPath = Array.isArray(__indices) ? __indices : [];\n  const __path = __traceResolveIndexValues(__rawPath);\n  let __target = __container;\n  for (const __index of __path) {\n    __target = __traceIsMapLike(__target) ? __target.get(__index) : __target[__index];\n  }\n  const __sequenceInsertStartIndex = Array.isArray(__target) && (__method === 'push' || __method === 'unshift')\n    ? (__method === 'push' ? __target.length : 0)\n    : undefined;\n  const __mayMutate = ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'set', 'add', 'insert', 'delete', 'clear'].includes(__method);\n  const __result = __target[__method](...__args);\n  if (['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'set', 'get', 'has', 'add', 'insert', 'delete', 'clear'].includes(__method)) {\n    const __isMapLike = __traceIsMapLike(__target);\n    const __isNestedMap = __path.length > 0 && __traceIsMapLike(__target);\n    if (__isMapLike && __method === 'set') {\n      const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __path.length + 1);\n      const __targetPath = [...__path, __args[0]];\n      __traceRecorder.recordAccess({\n        variable: __varName,\n        kind: 'indexed-write',\n        indices: __targetPath,\n        pathDepth: __path.length + 1,\n        ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n        value: __args[1],\n        ...__sourceLocation,\n      });\n      __traceRecorder.recordAccess({\n        variable: __varName,\n        kind: 'mutating-call',\n        method: __traceNormalizeMethodName(__target, __method, __args),\n        args: __args,\n        indices: __targetPath,\n        pathDepth: __path.length + 1,\n        ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n        ...__sourceLocation,\n      });\n      __traceFlushDeferredScalarUpdates(__rawPath);\n      return __result;\n    }\n    if (__isMapLike && (__method === 'get' || __method === 'has')) {\n      const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __path.length + 1);\n      __traceRecorder.recordAccess({\n        variable: __varName,\n        kind: 'indexed-read',\n        indices: [...__path, __args[0]],\n        pathDepth: __path.length + 1,\n        ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n        value: __result,\n        ...__sourceLocation,\n      });\n      __traceFlushDeferredScalarUpdates(__rawPath);\n      return __result;\n    }\n    if (__isMapLike && __method === 'delete') {\n      const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __path.length + 1);\n      __traceRecorder.recordAccess({\n        variable: __varName,\n        kind: 'mutating-call',\n        method: __traceNormalizeMethodName(__target, __method, __args),\n        args: __args,\n        indices: [...__path, __args[0]],\n        pathDepth: __path.length + 1,\n        ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n        ...__sourceLocation,\n      });\n      __traceFlushDeferredScalarUpdates(__rawPath);\n      return __result;\n    }\n    if (__target instanceof Set && __method === 'has') {\n      const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __path.length + 1);\n      const __normalizedKey = __tracePathSegment(__args[0]);\n      const __indices = __normalizedKey === null ? __path : [...__path, __normalizedKey];\n      __traceRecorder.recordAccess({\n        variable: __varName,\n        kind: 'indexed-read',\n        indices: __indices,\n        pathDepth: __indices.length,\n        ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n        value: __result,\n        ...__sourceLocation,\n      });\n      __traceFlushDeferredScalarUpdates(__rawPath);\n      return __result;\n    }\n    if (__target instanceof Set && __method === 'delete') {\n      const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __path.length + 1);\n      __traceRecorder.recordAccess({\n        variable: __varName,\n        kind: 'mutating-call',\n        method: __traceNormalizeMethodName(__target, __method, __args),\n        args: __args,\n        indices: [...__path, __args[0]],\n        pathDepth: __path.length + 1,\n        ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n        ...__sourceLocation,\n      });\n      __traceFlushDeferredScalarUpdates(__rawPath);\n      return __result;\n    }\n    if (__path.length > 0) {\n      const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __path.length);\n      __traceRecorder.recordAccess({\n        variable: __varName,\n        kind: 'indexed-read',\n        indices: __path,\n        pathDepth: __path.length,\n        ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n        ...__sourceLocation,\n      });\n    }\n    const __normalizedSources = __traceNormalizeIndexSources(__indexSources, __path.length);\n    __traceRecorder.recordAccess({\n      variable: __varName,\n      kind: 'mutating-call',\n      method: __traceNormalizeMethodName(__target, __method, __args),\n      args: __args,\n      indices: __path,\n      pathDepth: __path.length,\n      ...(Array.isArray(__normalizedSources) ? { indexSources: __normalizedSources } : {}),\n      ...__sourceLocation,\n    });\n    if (__sequenceInsertStartIndex !== undefined) {\n      const __bulkWriteLimit = Math.min(__args.length, __traceRecorder.pendingAccessBudget());\n      for (let __offset = 0; __offset < __bulkWriteLimit; __offset += 1) {\n        const __writePath = [...__path, __sequenceInsertStartIndex + __offset];\n        const __writeSources = __traceNormalizeIndexSources(\n          Array.isArray(__normalizedSources) ? [...__normalizedSources, null] : undefined,\n          __writePath.length\n        );\n        __traceRecorder.recordAccess({\n          variable: __varName,\n          kind: __writePath.length === 2 ? 'cell-write' : 'indexed-write',\n          indices: __writePath,\n          pathDepth: __writePath.length,\n          ...(Array.isArray(__writeSources) ? { indexSources: __writeSources } : {}),\n          value: __target[__sequenceInsertStartIndex + __offset],\n          ...__sourceLocation,\n        });\n      }\n    } else if (Array.isArray(__target) && (__method === 'sort' || __method === 'reverse')) {\n      const __bulkWriteLimit = Math.min(__target.length, __traceRecorder.pendingAccessBudget());\n      for (let __index = 0; __index < __bulkWriteLimit; __index += 1) {\n        const __writePath = [...__path, __index];\n        const __writeSources = __traceNormalizeIndexSources(\n          Array.isArray(__normalizedSources) ? [...__normalizedSources, null] : undefined,\n          __writePath.length\n        );\n        __traceRecorder.recordAccess({\n          variable: __varName,\n          kind: __writePath.length === 2 ? 'cell-write' : 'indexed-write',\n          indices: __writePath,\n          pathDepth: __writePath.length,\n          ...(Array.isArray(__writeSources) ? { indexSources: __writeSources } : {}),\n          value: __target[__index],\n          ...__sourceLocation,\n        });\n      }\n    }\n  }\n  __traceFlushDeferredScalarUpdates(__rawPath);\n  return __result;\n}"}
` : "";
  const parameters = tracing ? "__traceRecorder, __traceCtx" : "";
  return `(async (${parameters}) => {
"use strict";
${tracePrelude}${learnerBody(source, code)}
})
//# sourceURL=tracecode-ses-learner.js`;
}
function assertSesSourceAdmissible(source) {
  if (/<!--|-->/u.test(source) || /(^|[^.]|\.\.\.)\bimport\s*(?:\(|\/[/*])/u.test(source)) {
    throw new SourceNormalizationInvariantError(
      "SES source normalization left a mandatory-censorship token in executable source."
    );
  }
}
function buildLibraryEndowments() {
  if (javascriptLibrariesSource.length === 0) return void 0;
  assertSesSourceAdmissible(javascriptLibrariesSource);
  const compartment = new Compartment();
  const librarySource = {
    mode: "code",
    language: "javascript",
    code: "Math Date",
    functionName: "__tracecodeLibraryProbe",
    executionStyle: "function",
    requiredModules: ["lodash"],
    inputArguments: [],
    materializers: {}
  };
  compartment.evaluate(deterministicCapabilityPrelude(librarySource));
  compartment.evaluate(`var global = globalThis; var self = globalThis;
${javascriptLibrariesSource}`);
  const endowments = Object.fromEntries(LIBRARY_GLOBAL_NAMES.map((name) => [
    name,
    compartment.globalThis[name]
  ]));
  harden(compartment.globalThis);
  return harden(endowments);
}
function moduleBootstrapSource(source) {
  if (source.requiredModules.length > 0 && !javascriptLibraryEndowments) {
    throw new Error("JavaScript library runtime asset is unavailable.");
  }
  const requireBootstrap = source.requiredModules.length === 0 ? `const require = (specifier) => {
      throw new Error('Cannot find module "' + specifier + '"');
    };` : "";
  return `(() => {
    const module = { exports: {} };
    ${requireBootstrap}
    Object.defineProperties(globalThis, {
      ${source.requiredModules.length === 0 ? `require: {
        value: Object.freeze(require),
        writable: false,
        enumerable: false,
        configurable: false,
      },` : ""}
      module: { value: module, writable: true, configurable: true },
      exports: { value: module.exports, writable: true, configurable: true },
    });
  })()`;
}
function compartmentBaseEndowmentsFor(requiredModules) {
  if (requiredModules.length === 0) return safeHostEndowments;
  const shared = javascriptLibraryEndowments;
  if (!shared) {
    throw new Error("JavaScript library runtime asset is unavailable.");
  }
  const libraryGlobals = Object.fromEntries(Object.entries(shared).filter(
    ([name]) => name !== "__TRACECODE_JAVASCRIPT_LIBRARIES__" && name !== "require" && name !== "_" && name !== "lodash"
  ));
  return harden({
    ...safeHostEndowments,
    ...libraryGlobals
  });
}
function installCaseLibraries(compartment, requiredModules) {
  if (requiredModules.length === 0) return;
  const shared = javascriptLibraryEndowments;
  const sharedModules = shared?.__TRACECODE_JAVASCRIPT_LIBRARIES__;
  const sharedLodash = shared?.lodash;
  if (!shared || !sharedModules || typeof sharedModules !== "object") {
    throw new Error("JavaScript library runtime asset has an invalid module surface.");
  }
  const usesLodash = requiredModules.includes("lodash") || requiredModules.includes("lodash.js");
  let lodash;
  if (usesLodash) {
    if (typeof sharedLodash !== "function" || typeof sharedLodash.runInContext !== "function") {
      throw new Error("JavaScript library runtime has no lodash factory.");
    }
    const lodashContext = harden(Object.fromEntries(
      LODASH_CONTEXT_NAMES.map((name) => [name, compartment.globalThis[name]])
    ));
    lodash = sharedLodash.runInContext(lodashContext);
    if (typeof lodash !== "function") {
      throw new Error("JavaScript library runtime could not create case-local lodash.");
    }
    if (!Reflect.deleteProperty(lodash, "runInContext")) {
      throw new Error("JavaScript library runtime could not disable retained-context access.");
    }
  }
  const sharedModuleMap = sharedModules;
  const modules = Object.freeze(Object.fromEntries(requiredModules.map((specifier) => [
    specifier,
    specifier === "lodash" || specifier === "lodash.js" ? lodash : sharedModuleMap[specifier]
  ])));
  const require2 = harden((specifier) => {
    if (Object.hasOwn(modules, specifier)) {
      return modules[specifier];
    }
    throw new Error(`Cannot find module '${specifier}'`);
  });
  Object.defineProperties(compartment.globalThis, {
    __TRACECODE_JAVASCRIPT_LIBRARIES__: {
      value: modules,
      writable: false,
      enumerable: false,
      configurable: false
    },
    require: { value: require2, writable: false, enumerable: false, configurable: false },
    ...usesLodash ? {
      _: { value: lodash, writable: true, enumerable: false, configurable: true },
      lodash: { value: lodash, writable: true, enumerable: false, configurable: true }
    } : {}
  });
}
function compileLearnerFactory(compartment, source, sanitizedCode, tracing = false) {
  const factorySource = learnerFactorySource(source, sanitizedCode, tracing);
  assertSesSourceAdmissible(factorySource);
  const execute = compartment.evaluate(factorySource, {
    __rejectSomeDirectEvalExpressions__: false
  });
  if (typeof execute !== "function") {
    throw new Error("SES learner source did not compile to a callable program.");
  }
  return factorySource;
}
function validateInfrastructure() {
  const compartment = new Compartment();
  const takeConsole = compartment.evaluate(CONSOLE_BOOTSTRAP_SOURCE);
  if (typeof takeConsole !== "function") {
    throw new Error("SES console bootstrap did not compile to a snapshot function.");
  }
  const infrastructureSource = {
    mode: "code",
    language: "javascript",
    code: "function __tracecodeInfrastructureProbe() { return null; }",
    functionName: "__tracecodeInfrastructureProbe",
    executionStyle: "function",
    requiredModules: [],
    inputArguments: [],
    materializers: {}
  };
  const driver = compartment.evaluate(DRIVER_SOURCE);
  if (typeof driver !== "function") {
    throw new Error("SES driver did not compile to a function.");
  }
  compartment.evaluate(deterministicCapabilityPrelude({
    ...infrastructureSource,
    code: "Math Date"
  }));
  compartment.evaluate(RUNTIME_BOOTSTRAP_SOURCE);
  compartment.evaluate(moduleBootstrapSource(infrastructureSource));
  compileLearnerFactory(
    compartment,
    infrastructureSource,
    sanitizeLearnerSource(infrastructureSource.code)
  );
  const traceRuntimeCompartment = new Compartment();
  const recorderFactory = traceRuntimeCompartment.evaluate(
    `(() => {
${"const RUNTIME_TRACE_SCHEMA_VERSION = 'runtime-trace-2026-04-28';\n\nfunction isLikelyTreeNodeValue(value) {\n  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;\n  if (value.__type__ === 'TreeNode') return true;\n  return value?.constructor?.name === 'TreeNode';\n}\n\nfunction isLikelyListNodeValue(value) {\n  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;\n  if (value.__type__ === 'ListNode') return true;\n  return value?.constructor?.name === 'ListNode';\n}\n\nfunction inferPlainNodeType(value) {\n  if (value.__type__ === 'ListNode' || value.__type__ === 'TreeNode') {\n    return null;\n  }\n  const id = typeof value.__id__ === 'string' ? value.__id__ : '';\n  if (id.startsWith('list-') || id.startsWith('ListNode:')) return 'ListNode';\n  if (id.startsWith('tree-') || id.startsWith('TreeNode:')) return 'TreeNode';\n\n  const hasValue = Object.prototype.hasOwnProperty.call(value, 'val')\n    || Object.prototype.hasOwnProperty.call(value, 'value');\n  const hasTreeLinks = Object.prototype.hasOwnProperty.call(value, 'left')\n    || Object.prototype.hasOwnProperty.call(value, 'right');\n  const hasListLinks = Object.prototype.hasOwnProperty.call(value, 'next')\n    || Object.prototype.hasOwnProperty.call(value, 'prev');\n  if (hasValue && hasTreeLinks) return 'TreeNode';\n  if (hasValue && hasListLinks) return 'ListNode';\n  return null;\n}\n\nfunction hasNodeValueField(value) {\n  return Object.prototype.hasOwnProperty.call(value, 'val')\n    || Object.prototype.hasOwnProperty.call(value, 'value');\n}\n\nfunction forcedNodeTypeForValue(value, forcedNodeType) {\n  if (!forcedNodeType || !value || typeof value !== 'object' || Array.isArray(value)) return null;\n  return hasNodeValueField(value) ? forcedNodeType : null;\n}\n\nfunction nodeTypeFromKnownNodeId(nodeId) {\n  if (typeof nodeId !== 'string') return null;\n  if (nodeId.startsWith('TreeNode:') || nodeId.startsWith('tree-')) return 'TreeNode';\n  if (nodeId.startsWith('ListNode:') || nodeId.startsWith('list-')) return 'ListNode';\n  return null;\n}\n\nfunction getCustomClassName(value) {\n  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;\n  if (value instanceof Map || value instanceof Set) return null;\n  if (isLikelyTreeNodeValue(value) || isLikelyListNodeValue(value)) return null;\n  const name = typeof value?.constructor?.name === 'string' ? value.constructor.name : '';\n  if (!name || name === 'Object' || name === 'Array' || name === 'Map' || name === 'Set') {\n    return null;\n  }\n  return name;\n}\n\nconst RUNTIME_VALUE_MAX_DEPTH = 48;\nconst RUNTIME_VALUE_MAX_ITEMS = 64;\nconst RUNTIME_VALUE_MAX_OBJECT_FIELDS = 32;\nconst RUNTIME_VALUE_MAX_NODES = 4096;\nconst INPUT_MATERIALIZER_MAX_DEPTH = 512;\nconst TRACE_SERIALIZATION_LIMITS = {\n  maxItems: RUNTIME_VALUE_MAX_ITEMS,\n  maxFields: RUNTIME_VALUE_MAX_OBJECT_FIELDS,\n  maxNodes: RUNTIME_VALUE_MAX_NODES,\n};\nconst OUTPUT_SERIALIZATION_LIMITS = {\n  maxItems: Number.POSITIVE_INFINITY,\n  maxFields: Number.POSITIVE_INFINITY,\n  maxNodes: Number.POSITIVE_INFINITY,\n};\nlet activeSerializationLimits = TRACE_SERIALIZATION_LIMITS;\nlet activeSerializationBudget = null;\n\nfunction truncationMarker(total, emitted) {\n  return { __truncated__: true, remaining: Math.max(0, total - emitted) };\n}\n\nfunction limitedEntries(items, maxItems) {\n  return {\n    values: items.slice(0, maxItems),\n    remaining: Math.max(0, items.length - maxItems),\n  };\n}\n\nfunction serializeIndexedValues(length, valueAt, depth, seen, nodeRefState) {\n  const maxItems = activeSerializationLimits.maxItems;\n  const emitted = Number.isFinite(maxItems)\n    ? Math.min(length, Math.max(0, maxItems))\n    : length;\n  const result = [];\n  for (let index = 0; index < emitted; index += 1) {\n    result.push(serializeValue(valueAt(index), depth + 1, seen, nodeRefState));\n  }\n  if (length > emitted) result.push(truncationMarker(length, emitted));\n  return result;\n}\n\nfunction builtinCollectionSize(value, prototype) {\n  try {\n    const getter = Object.getOwnPropertyDescriptor(prototype, 'size')?.get;\n    const size = typeof getter === 'function' ? getter.call(value) : undefined;\n    return Number.isFinite(size) ? Math.max(0, Math.floor(size)) : undefined;\n  } catch (_error) {\n    return undefined;\n  }\n}\n\nfunction limitedBuiltinIteratorValues(iterator, maxItems) {\n  const emitted = Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : Infinity;\n  const values = [];\n  let exhausted = false;\n  while (values.length < emitted) {\n    const next = iterator.next();\n    if (next.done) {\n      exhausted = true;\n      break;\n    }\n    values.push(next.value);\n  }\n  if (!exhausted && Number.isFinite(emitted)) {\n    const next = iterator.next();\n    exhausted = Boolean(next.done);\n  }\n  return { values, exhausted };\n}\n\nfunction ownEnumerableDataEntries(value) {\n  if (!value || typeof value !== 'object') return [];\n  const entries = [];\n  for (const key of Object.keys(value)) {\n    const descriptor = Object.getOwnPropertyDescriptor(value, key);\n    if (!descriptor || descriptor.enumerable !== true) continue;\n    entries.push([\n      key,\n      Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : '<accessor>',\n    ]);\n  }\n  return entries;\n}\n\nfunction serializeValue(\n  value,\n  depth = 0,\n  seen = new WeakSet(),\n  nodeRefState = { ids: new WeakMap(), nextId: 1 },\n  forcedNodeType = null,\n  materializeExistingNode = false\n) {\n  if (depth > RUNTIME_VALUE_MAX_DEPTH) return '<max depth>';\n  if (value === null || value === undefined) return value;\n\n  const valueType = typeof value;\n  if (valueType === 'object' && !reserveSerializedNode()) {\n    return { __truncated__: true, reason: 'max serialized nodes' };\n  }\n  if (valueType === 'number') {\n    if (Number.isNaN(value)) return 'NaN';\n    if (value === Infinity) return 'Infinity';\n    if (value === -Infinity) return '-Infinity';\n    return value;\n  }\n  if (valueType === 'string' || valueType === 'boolean') {\n    return value;\n  }\n  if (valueType === 'bigint') {\n    return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);\n  }\n  if (valueType === 'function') {\n    return '<function>';\n  }\n  if (Array.isArray(value)) {\n    if (seen.has(value)) return '<cycle>';\n    seen.add(value);\n    const limited = limitedEntries(value, activeSerializationLimits.maxItems);\n    const result = limited.values.map((item) => serializeValue(item, depth + 1, seen, nodeRefState));\n    if (limited.remaining > 0) result.push(truncationMarker(value.length, limited.values.length));\n    return result;\n  }\n  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {\n    if (seen.has(value)) return '<cycle>';\n    seen.add(value);\n    if (value instanceof DataView) {\n      return serializeIndexedValues(value.byteLength, (index) => value.getUint8(index), depth, seen, nodeRefState);\n    }\n    return serializeIndexedValues(value.length, (index) => value[index], depth, seen, nodeRefState);\n  }\n  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {\n    if (seen.has(value)) return '<cycle>';\n    seen.add(value);\n    const bytes = new Uint8Array(value);\n    return serializeIndexedValues(bytes.byteLength, (index) => bytes[index], depth, seen, nodeRefState);\n  }\n  if (value instanceof Set) {\n    if (seen.has(value)) return '<cycle>';\n    seen.add(value);\n    let limited;\n    try {\n      limited = limitedBuiltinIteratorValues(Set.prototype.values.call(value), activeSerializationLimits.maxItems);\n    } catch (_error) {\n      return '<unserializable Set>';\n    }\n    const size = builtinCollectionSize(value, Set.prototype);\n    const result = {\n      __type__: 'set',\n      values: limited.values.map((item) => serializeValue(item, depth + 1, seen, nodeRefState)),\n    };\n    const remaining = size === undefined\n      ? (limited.exhausted ? 0 : 1)\n      : Math.max(0, size - limited.values.length);\n    if (remaining > 0) {\n      result.__truncated__ = true;\n      result.remaining = remaining;\n    }\n    return result;\n  }\n  if (value instanceof Map) {\n    if (seen.has(value)) return '<cycle>';\n    seen.add(value);\n    let limited;\n    try {\n      limited = limitedBuiltinIteratorValues(Map.prototype.entries.call(value), activeSerializationLimits.maxItems);\n    } catch (_error) {\n      return '<unserializable Map>';\n    }\n    const size = builtinCollectionSize(value, Map.prototype);\n    const result = {\n      __type__: 'map',\n      entries: limited.values.map(([k, v]) => [\n        serializeValue(k, depth + 1, seen, nodeRefState),\n        serializeValue(v, depth + 1, seen, nodeRefState),\n      ]),\n    };\n    const remaining = size === undefined\n      ? (limited.exhausted ? 0 : 1)\n      : Math.max(0, size - limited.values.length);\n    if (remaining > 0) {\n      result.__truncated__ = true;\n      result.remaining = remaining;\n    }\n    return result;\n  }\n  if (valueType === 'object') {\n    const forcedType = forcedNodeTypeForValue(value, forcedNodeType);\n    const inferredNodeTypeForValue = inferPlainNodeType(value);\n    const explicitNodeType = isLikelyTreeNodeValue(value)\n      ? 'TreeNode'\n      : (isLikelyListNodeValue(value) ? 'ListNode' : null);\n    const nodeType = explicitNodeType ?? forcedType ?? inferredNodeTypeForValue;\n    if (nodeType) {\n      const existingId = nodeRefState.ids.get(value);\n      if (existingId && (!materializeExistingNode || seen.has(value))) {\n        return { __ref__: existingId };\n      }\n      const isTree = nodeType === 'TreeNode';\n      const explicitId = typeof value.__id__ === 'string' ? value.__id__ : '';\n      const nodeId = existingId ?? (explicitId.length > 0\n        ? explicitId\n        : (explicitNodeType ? `ref-${nodeRefState.nextId++}` : `${nodeType}:${nodeRefState.nextId++}`));\n      if (!existingId) nodeRefState.ids.set(value, nodeId);\n      seen.add(value);\n\n      const out =\n        isTree\n          ? {\n              __type__: 'TreeNode',\n              __id__: nodeId,\n              val: serializeValue(value.val ?? value.value ?? null, depth + 1, seen, nodeRefState),\n              left: serializeValue(value.left ?? null, depth + 1, seen, nodeRefState, 'TreeNode', materializeExistingNode),\n              right: serializeValue(value.right ?? null, depth + 1, seen, nodeRefState, 'TreeNode', materializeExistingNode),\n            }\n          : {\n              __type__: 'ListNode',\n              __id__: nodeId,\n              val: serializeValue(value.val ?? value.value ?? null, depth + 1, seen, nodeRefState),\n              next: serializeValue(value.next ?? null, depth + 1, seen, nodeRefState, 'ListNode', materializeExistingNode),\n              ...(Object.prototype.hasOwnProperty.call(value, 'prev')\n                ? { prev: serializeValue(value.prev ?? null, depth + 1, seen, nodeRefState, 'ListNode', materializeExistingNode) }\n                : {}),\n            };\n      const skipped =\n        isTree\n          ? new Set(['__id__', '__type__', '__class__', 'val', 'value', 'left', 'right'])\n          : new Set(['__id__', '__type__', '__class__', 'val', 'value', 'next', 'prev']);\n      const fields = ownEnumerableDataEntries(value).filter(([k]) => !skipped.has(k));\n      for (const [k, v] of fields.slice(0, activeSerializationLimits.maxFields)) {\n        out[k] = serializeValue(v, depth + 1, seen, nodeRefState);\n      }\n      if (fields.length > activeSerializationLimits.maxFields) {\n        out.__truncated__ = true;\n        out.remaining = fields.length - activeSerializationLimits.maxFields;\n      }\n      seen.delete(value);\n      return out;\n    }\n\n    const existingNodeId = hasNodeValueField(value) ? nodeRefState.ids.get(value) : undefined;\n    if (existingNodeId) {\n      return { __ref__: existingNodeId };\n    }\n\n    const customClassName = getCustomClassName(value);\n    if (customClassName) {\n      const existingId = nodeRefState.ids.get(value);\n      if (existingId) {\n        return { __ref__: existingId };\n      }\n\n      const objectId = `ref-${nodeRefState.nextId++}`;\n      nodeRefState.ids.set(value, objectId);\n\n      if (seen.has(value)) return { __ref__: objectId };\n      seen.add(value);\n      const out = {\n        __type__: customClassName,\n        __class__: customClassName,\n        __id__: objectId,\n      };\n      const fields = ownEnumerableDataEntries(value);\n      for (const [k, v] of fields.slice(0, activeSerializationLimits.maxFields)) {\n        out[k] = serializeValue(v, depth + 1, seen, nodeRefState);\n      }\n      if (fields.length > activeSerializationLimits.maxFields) {\n        out.__truncated__ = true;\n        out.remaining = fields.length - activeSerializationLimits.maxFields;\n      }\n      seen.delete(value);\n      return out;\n    }\n\n    if (seen.has(value)) return '<cycle>';\n    seen.add(value);\n    const out = {};\n    const inferredNodeType = inferPlainNodeType(value);\n    if (inferredNodeType) {\n      out.__type__ = inferredNodeType;\n      const explicitId = typeof value.__id__ === 'string' ? value.__id__ : '';\n      let nodeId = nodeRefState.ids.get(value);\n      if (!nodeId) {\n        nodeId = explicitId.length > 0 ? explicitId : `${inferredNodeType}:${nodeRefState.nextId++}`;\n        nodeRefState.ids.set(value, nodeId);\n      }\n      out.__id__ = nodeId;\n    }\n    const fields = ownEnumerableDataEntries(value);\n    for (const [k, v] of fields.slice(0, activeSerializationLimits.maxFields)) {\n      out[k] = serializeValue(v, depth + 1, seen, nodeRefState);\n    }\n    if (fields.length > activeSerializationLimits.maxFields) {\n      out.__truncated__ = true;\n      out.remaining = fields.length - activeSerializationLimits.maxFields;\n    }\n    return out;\n  }\n\n  return String(value);\n}\n\nfunction withSerializationLimits(limits, serialize) {\n  const previous = activeSerializationLimits;\n  const previousBudget = activeSerializationBudget;\n  activeSerializationLimits = limits;\n  activeSerializationBudget = { nodes: 0, maxNodes: limits.maxNodes ?? Number.POSITIVE_INFINITY };\n  try {\n    return serialize();\n  } finally {\n    activeSerializationLimits = previous;\n    activeSerializationBudget = previousBudget;\n  }\n}\n\nfunction reserveSerializedNode() {\n  if (!activeSerializationBudget) return true;\n  if (activeSerializationBudget.nodes >= activeSerializationBudget.maxNodes) return false;\n  activeSerializationBudget.nodes += 1;\n  return true;\n}\n\nfunction serializeOutputValue(value) {\n  return withSerializationLimits(OUTPUT_SERIALIZATION_LIMITS, () => serializeValue(value));\n}\n\nfunction serializeTopLevelValue(value, nodeRefState) {\n  return withSerializationLimits(TRACE_SERIALIZATION_LIMITS, () => serializeTopLevelValueWithinBudget(value, nodeRefState));\n}\n\nfunction serializeTopLevelValueWithinBudget(value, nodeRefState) {\n  if (value === null || value === undefined) return value;\n  if (typeof value !== 'object' || Array.isArray(value)) {\n    return serializeValue(value, 0, new WeakSet(), nodeRefState);\n  }\n\n  const knownNodeId = nodeRefState.ids.get(value);\n  const explicitNodeType = isLikelyTreeNodeValue(value)\n    ? 'TreeNode'\n    : (isLikelyListNodeValue(value) ? 'ListNode' : null);\n  const topLevelNodeType = explicitNodeType ?? inferPlainNodeType(value) ?? nodeTypeFromKnownNodeId(knownNodeId);\n\n  if (topLevelNodeType) {\n    const objectValue = value;\n    const nodeValue = value;\n    const isTree = topLevelNodeType === 'TreeNode';\n    let nodeId = knownNodeId;\n    if (!nodeId) {\n      const explicitId = typeof nodeValue.__id__ === 'string' ? nodeValue.__id__ : '';\n      nodeId = explicitId.length > 0\n        ? explicitId\n        : (explicitNodeType ? `ref-${nodeRefState.nextId++}` : `${topLevelNodeType}:${nodeRefState.nextId++}`);\n      nodeRefState.ids.set(objectValue, nodeId);\n    }\n\n    const out =\n      isTree\n        ? {\n            __type__: 'TreeNode',\n            __id__: nodeId,\n            val: serializeValue(nodeValue.val ?? nodeValue.value ?? null, 1, new WeakSet(), nodeRefState),\n            left: serializeValue(nodeValue.left ?? null, 1, new WeakSet([objectValue]), nodeRefState, 'TreeNode', true),\n            right: serializeValue(nodeValue.right ?? null, 1, new WeakSet([objectValue]), nodeRefState, 'TreeNode', true),\n          }\n        : {\n            __type__: 'ListNode',\n            __id__: nodeId,\n            val: serializeValue(nodeValue.val ?? nodeValue.value ?? null, 1, new WeakSet(), nodeRefState),\n            next: serializeValue(nodeValue.next ?? null, 1, new WeakSet([objectValue]), nodeRefState, 'ListNode', true),\n            ...('prev' in nodeValue\n              ? { prev: serializeValue(nodeValue.prev ?? null, 1, new WeakSet([objectValue]), nodeRefState, 'ListNode', true) }\n              : {}),\n          };\n    const skipped = isTree\n      ? new Set(['__id__', '__type__', '__class__', 'val', 'value', 'left', 'right'])\n      : new Set(['__id__', '__type__', '__class__', 'val', 'value', 'next', 'prev']);\n    const fields = ownEnumerableDataEntries(nodeValue).filter(([k]) => !skipped.has(k));\n    for (const [k, v] of fields.slice(0, activeSerializationLimits.maxFields)) {\n      out[k] = serializeValue(v, 1, new WeakSet(), nodeRefState);\n    }\n    if (fields.length > activeSerializationLimits.maxFields) {\n      out.__truncated__ = true;\n      out.remaining = fields.length - activeSerializationLimits.maxFields;\n    }\n    return out;\n  }\n\n  const customClassName = getCustomClassName(value);\n  if (customClassName) {\n    const objectValue = value;\n    let objectId = nodeRefState.ids.get(objectValue);\n    if (!objectId) {\n      objectId = `ref-${nodeRefState.nextId++}`;\n      nodeRefState.ids.set(objectValue, objectId);\n    }\n    const seen = new WeakSet();\n    seen.add(objectValue);\n    const out = {\n      __type__: 'object',\n      __class__: customClassName,\n      __id__: objectId,\n    };\n    const fields = ownEnumerableDataEntries(value);\n    for (const [k, v] of fields.slice(0, activeSerializationLimits.maxFields)) {\n      out[k] = serializeValue(v, 1, seen, nodeRefState);\n    }\n    if (fields.length > activeSerializationLimits.maxFields) {\n      out.__truncated__ = true;\n      out.remaining = fields.length - activeSerializationLimits.maxFields;\n    }\n    return out;\n  }\n\n  return serializeValue(value, 0, new WeakSet(), nodeRefState);\n}\n\nfunction getNumericOption(value, fallback) {\n  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {\n    return fallback;\n  }\n  return Math.floor(value);\n}\n\nconst DEFAULT_TRACE_MAX_PATH_DEPTH = 3;\nconst MAX_TRACE_MAX_PATH_DEPTH = 8;\nconst MAX_TRACE_BULK_ACCESSES = 512;\n\nfunction getMaxPathDepthOption(value) {\n  const numeric = getNumericOption(value, DEFAULT_TRACE_MAX_PATH_DEPTH);\n  return Math.min(MAX_TRACE_MAX_PATH_DEPTH, Math.max(1, numeric));\n}\n\nfunction isTraceablePathSegment(value) {\n  return (typeof value === 'number' && Number.isInteger(value)) ||\n    (typeof value === 'string' && value.length > 0);\n}\n\nfunction normalizeTracePathSegment(index, serializePathValue) {\n  if (typeof index === 'number' && Number.isInteger(index)) return Math.trunc(index);\n  if (typeof index === 'string' && index.length > 0) return index;\n  if (index && typeof index === 'object') {\n    if (typeof index.__id__ === 'string' && index.__id__.length > 0) return index.__id__;\n    if (typeof index.__ref__ === 'string' && index.__ref__.length > 0) return index.__ref__;\n    if (typeof serializePathValue === 'function') {\n      const serialized = serializePathValue(index);\n      if (serialized && typeof serialized === 'object') {\n        if (typeof serialized.__id__ === 'string' && serialized.__id__.length > 0) return serialized.__id__;\n        if (typeof serialized.__ref__ === 'string' && serialized.__ref__.length > 0) return serialized.__ref__;\n      }\n    }\n  }\n  return null;\n}\n\nfunction normalizeTraceIndices(indices, maxDepth = 3, serializePathValue) {\n  if (!Array.isArray(indices) || indices.length === 0 || indices.length > maxDepth) {\n    return null;\n  }\n  const normalized = indices.map((index) => normalizeTracePathSegment(index, serializePathValue));\n  if (!normalized.every(isTraceablePathSegment)) {\n    return null;\n  }\n  return normalized;\n}\n\nfunction normalizeTraceIndexSources(indexSources, maxDepth = 3) {\n  if (!Array.isArray(indexSources) || indexSources.length === 0 || indexSources.length > maxDepth) {\n    return null;\n  }\n  return indexSources.map((source) => typeof source === 'string' && source.length > 0 ? source : null);\n}\n\nfunction isTraceableMutatingMethod(methodName) {\n  return ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'set', 'get', 'has', 'add', 'insert', 'delete', 'clear'].includes(methodName);\n}\n\nfunction traceLineParenDelta(line) {\n  let delta = 0;\n  let quote = null;\n  let escaped = false;\n  for (const char of String(line ?? '')) {\n    if (escaped) {\n      escaped = false;\n      continue;\n    }\n    if (quote) {\n      if (char === '\\\\') escaped = true;\n      else if (char === quote) quote = null;\n      continue;\n    }\n    if (char === '\"' || char === \"'\" || char === '`') {\n      quote = char;\n      continue;\n    }\n    if (char === '(') delta += 1;\n    else if (char === ')') delta -= 1;\n  }\n  return delta;\n}\n\nfunction buildRuntimeStatementSourceMap(code) {\n  const lines = String(code ?? '').split(/\\r?\\n/);\n  const spans = new Map();\n  let startLine = 0;\n  let startColumn = 0;\n  let balance = 0;\n  for (let index = 0; index < lines.length; index += 1) {\n    const lineNumber = index + 1;\n    const line = lines[index] ?? '';\n    const delta = traceLineParenDelta(line);\n    if (startLine === 0) {\n      if (delta > 0) {\n        startLine = lineNumber;\n        startColumn = /\\S/.exec(line)?.index ?? 0;\n        balance = delta;\n      }\n      continue;\n    }\n    balance += delta;\n    if (balance <= 0) {\n      const span = {\n        statementId: `stmt:${startLine}:${lineNumber}:${startColumn}`,\n        startLine,\n        startColumn,\n        endLine: lineNumber,\n        endColumn: line.length,\n      };\n      for (let mappedLine = startLine; mappedLine <= lineNumber; mappedLine += 1) {\n        spans.set(mappedLine, span);\n      }\n      startLine = 0;\n      startColumn = 0;\n      balance = 0;\n    }\n  }\n  return spans;\n}\n\nfunction createTraceRecorder(options = {}) {\n  const trace = [];\n  const runtimeTraceEvents = [];\n  const callStack = [];\n  const pendingAccessesByFrame = new Map();\n  const deferredAccessesByFrame = new Map();\n  const runtimeTraceAccessStatsByVariable = new Map();\n  const lineHitCount = new Map();\n  const stableNodeRefState = { ids: new WeakMap(), nextId: 1 };\n  const maxTraceSteps = getNumericOption(options.maxTraceSteps, 4000);\n  const maxStoredEvents = getNumericOption(options.maxStoredEvents, maxTraceSteps);\n  const effectiveMaxTraceSteps = Math.min(maxTraceSteps, maxStoredEvents);\n  const effectiveMaxRuntimeTraceEvents = maxStoredEvents;\n  const maxLineEvents = getNumericOption(options.maxLineEvents, 12000);\n  const maxSingleLineHits = getNumericOption(options.maxSingleLineHits, 1000);\n  const maxCallDepth = getNumericOption(options.maxCallDepth, 2000);\n  const maxPathDepth = getMaxPathDepthOption(options.maxPathDepth);\n  const minimalTrace = options.minimalTrace === true;\n  const statementSourceMap = options.statementSourceMap instanceof Map ? options.statementSourceMap : new Map();\n\n  let lineEventCount = 0;\n  let traceLimitExceeded = false;\n  let timeoutReason;\n  let timeoutRecorded = false;\n  let nextFrameId = 1;\n\n  function markTraceCaptureLimit(lineNumber, functionName) {\n    if (!traceLimitExceeded) {\n      traceLimitExceeded = true;\n      timeoutReason = 'trace-limit';\n    }\n    pendingAccessesByFrame.clear();\n    deferredAccessesByFrame.clear();\n    if (!timeoutRecorded && trace.length < effectiveMaxTraceSteps && runtimeTraceEvents.length < effectiveMaxRuntimeTraceEvents) {\n      const timeoutStep = {\n        line: normalizeLine(lineNumber, 1),\n        event: 'timeout',\n        variables: { timeoutReason: 'trace-limit' },\n        function: functionName ?? callStack[callStack.length - 1]?.function ?? '<module>',\n        callStack: snapshotCallStack(),\n      };\n      timeoutRecorded = true;\n      trace.push(timeoutStep);\n      appendRuntimeTraceEventsForStep(timeoutStep);\n    }\n  }\n\n  function normalizeLine(lineNumber, fallback = 1) {\n    const parsed = Number(lineNumber);\n    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;\n    return Math.floor(parsed);\n  }\n\n  function snapshotCallStack() {\n    return callStack.map((frame) => ({\n      id: frame.id,\n      function: frame.function,\n      args: frame.args,\n      line: frame.line,\n    }));\n  }\n\n  function sanitizeVariables(value) {\n    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};\n    const result = {};\n    for (const [key, variableValue] of Object.entries(value)) {\n      if (variableValue === undefined) continue;\n      if (typeof variableValue === 'function') continue;\n      try {\n        result[key] = serializeTopLevelValue(variableValue, stableNodeRefState);\n      } catch {\n        // Skip variables that throw during serialization (e.g. transient proxy/getter failures).\n      }\n    }\n    return result;\n  }\n\n  function sanitizeCallArgs(value) {\n    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};\n    const result = {};\n    for (const [key, variableValue] of Object.entries(value)) {\n      if (typeof variableValue === 'function') continue;\n      if (variableValue === undefined) {\n        result[key] = '<undefined>';\n        continue;\n      }\n      try {\n        result[key] = serializeTopLevelValue(variableValue, stableNodeRefState);\n      } catch {\n        result[key] = '<unserializable>';\n      }\n    }\n    return result;\n  }\n\n  function serializeTraceValue(value) {\n    try {\n      return serializeTopLevelValue(value, stableNodeRefState);\n    } catch {\n      return '<unserializable>';\n    }\n  }\n\n  function isLikelyTreeObject(value) {\n    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;\n    const hasValue = Object.prototype.hasOwnProperty.call(value, 'val') || Object.prototype.hasOwnProperty.call(value, 'value');\n    const hasTreeLinks = Object.prototype.hasOwnProperty.call(value, 'left') || Object.prototype.hasOwnProperty.call(value, 'right');\n    return hasValue && hasTreeLinks;\n  }\n\n  function isLikelyLinkedListObject(value) {\n    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;\n    const hasValue = Object.prototype.hasOwnProperty.call(value, 'val') || Object.prototype.hasOwnProperty.call(value, 'value');\n    const hasTreeLinks = Object.prototype.hasOwnProperty.call(value, 'left') || Object.prototype.hasOwnProperty.call(value, 'right');\n    const hasListLinks = Object.prototype.hasOwnProperty.call(value, 'next') || Object.prototype.hasOwnProperty.call(value, 'prev');\n    return hasValue && hasListLinks && !hasTreeLinks;\n  }\n\n  function isLikelyAdjacencyListObject(value) {\n    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;\n    const keys = Object.keys(value);\n    if (keys.length === 0) return false;\n    if (!keys.every((key) => Array.isArray(value[key]))) return false;\n\n    const keySet = new Set(keys.map((key) => String(key)));\n    for (const neighbors of Object.values(value)) {\n      for (const neighbor of neighbors) {\n        if (keySet.has(String(neighbor))) {\n          return true;\n        }\n      }\n    }\n    return false;\n  }\n\n  function isLikelyIndexedAdjacencyListArray(value) {\n    if (!Array.isArray(value) || value.length === 0) return false;\n    if (!value.every((row) => Array.isArray(row))) return false;\n\n    const nodeCount = value.length;\n    let edgeCount = 0;\n    for (const neighbors of value) {\n      for (const neighbor of neighbors) {\n        if (typeof neighbor !== 'number' || !Number.isInteger(neighbor)) return false;\n        if (neighbor < 0 || neighbor >= nodeCount) return false;\n        edgeCount += 1;\n      }\n    }\n\n    if (edgeCount === 0) return false;\n\n    const looksLikeAdjacencyMatrix = value.every(\n      (row) => row.length === nodeCount && row.every((cell) => cell === 0 || cell === 1)\n    );\n    if (looksLikeAdjacencyMatrix) return false;\n\n    return true;\n  }\n\n  function createLimitError(reason, lineNumber, message) {\n    const error = new Error(message);\n    error.__traceLimitExceeded = true;\n    error.__timeoutReason = reason;\n    error.__traceLine = lineNumber;\n    return error;\n  }\n\n  function getCurrentFrameId() {\n    return callStack[callStack.length - 1]?.id;\n  }\n\n  function normalizeFrameMatchKey(functionName) {\n    const normalized =\n      typeof functionName === 'string' && functionName.length > 0 ? functionName : '<module>';\n    if (normalized === 'constructor' || normalized.endsWith('.constructor')) {\n      return 'constructor';\n    }\n    return normalized;\n  }\n\n  function flushPendingAccesses(frameId) {\n    if (frameId === undefined || frameId === null) {\n      return undefined;\n    }\n    const pending = pendingAccessesByFrame.get(frameId);\n    const deferred = deferredAccessesByFrame.get(frameId);\n    let deferredReady = [];\n    if (deferred && Array.isArray(deferred.accesses) && deferred.accesses.length > 0) {\n      if (deferred.skipLineFlushes > 0) {\n        deferred.skipLineFlushes -= 1;\n        deferredAccessesByFrame.set(frameId, deferred);\n      } else {\n        deferredReady = deferred.accesses;\n        deferredAccessesByFrame.delete(frameId);\n      }\n    }\n    if ((!Array.isArray(pending) || pending.length === 0) && deferredReady.length === 0) {\n      return undefined;\n    }\n    pendingAccessesByFrame.delete(frameId);\n    return [...(Array.isArray(pending) ? pending : []), ...deferredReady].map((access) => ({\n      variable: access.variable,\n      kind: access.kind,\n      ...(Array.isArray(access.indices) && access.indices.length > 0\n        ? { indices: access.indices }\n        : {}),\n      ...(Array.isArray(access.indexSources) && access.indexSources.length > 0\n        ? { indexSources: access.indexSources }\n        : {}),\n      ...(access.method ? { method: access.method } : {}),\n      ...(Array.isArray(access.args) ? { args: access.args } : {}),\n      ...(access.pathDepth ? { pathDepth: access.pathDepth } : {}),\n      ...(access.scope ? { scope: access.scope } : {}),\n      ...(access.binding ? { binding: access.binding } : {}),\n      ...(Number.isFinite(access.line) && access.line > 0 ? { line: access.line } : {}),\n      ...(Number.isFinite(access.column) && access.column >= 0 ? { column: access.column } : {}),\n      ...(Object.prototype.hasOwnProperty.call(access, 'value') ? { value: access.value } : {}),\n    }));\n  }\n\n  function appendTrace(step, frameId = getCurrentFrameId()) {\n    if (traceLimitExceeded) {\n      return;\n    }\n    if (trace.length >= effectiveMaxTraceSteps) {\n      markTraceCaptureLimit(step?.line, step?.function);\n      return;\n    }\n    const accesses = flushPendingAccesses(frameId);\n    const nextStep = {\n      ...step,\n      ...(accesses ? { accesses } : {}),\n    };\n    const previous = trace[trace.length - 1];\n    if (canMergeConsecutiveLineSteps(previous, nextStep)) {\n      previous.variables = {\n        ...(previous.variables || {}),\n        ...(nextStep.variables || {}),\n      };\n      if (nextStep.accesses?.length) {\n        previous.accesses = [...(previous.accesses || []), ...nextStep.accesses];\n      }\n      previous.callStack = nextStep.callStack;\n      previous.function = nextStep.function;\n      appendRuntimeTraceEventsForStep({\n        ...nextStep,\n        event: '__merge_only__',\n      });\n      return;\n    }\n    trace.push(nextStep);\n    appendRuntimeTraceEventsForStep(nextStep);\n  }\n\n  function runtimeTraceFrameIdForStep(step) {\n    const stack = Array.isArray(step?.callStack) ? step.callStack : [];\n    if (stack.length > 0) {\n      const frame = stack[stack.length - 1];\n      return `${frame.function}:${frame.line}:${frame.id ?? 'unknown'}`;\n    }\n    return `${step.function}:${step.line}:root`;\n  }\n\n  function runtimeTraceSourceOwnership(lineNumber, functionName) {\n    const normalizedLine = normalizeLine(lineNumber, 0);\n    const span = statementSourceMap.get(normalizedLine);\n    if (!span) return {};\n    const normalizedFunction = typeof functionName === 'string' && functionName.length > 0 ? functionName : undefined;\n    return {\n      statementId: normalizedFunction ? `${normalizedFunction}:${span.statementId}` : span.statementId,\n      sourceSpan: {\n        startLine: span.startLine,\n        startColumn: span.startColumn,\n        endLine: span.endLine,\n        endColumn: span.endColumn,\n      },\n    };\n  }\n\n  function runtimeTraceTargetForAccess(access) {\n    const indices = Array.isArray(access?.indices) ? access.indices : [];\n    const indexSources = Array.isArray(access?.indexSources) ? access.indexSources : [];\n    const scope = typeof access?.scope === 'string' && access.scope.length > 0\n      ? access.scope\n      : undefined;\n    const base = {\n      variable: access.variable,\n      ...(scope ? { scope } : {}),\n    };\n    if (indices.length > 0) {\n      return {\n        ...base,\n        path: indices,\n        ...(indexSources.length > 0 ? { indexSources } : {}),\n      };\n    }\n    return base;\n  }\n\n  function runtimeTraceKindForAccess(access) {\n    if (access.kind === 'indexed-read' || access.kind === 'cell-read') return 'read';\n    if (access.kind === 'indexed-write' || access.kind === 'cell-write') return 'write';\n    return 'mutate';\n  }\n\n  function runtimeTraceAccessValue(step, access) {\n    if (access && Object.prototype.hasOwnProperty.call(access, 'value')) return access.value;\n    if (access?.kind === 'indexed-write' || access?.kind === 'cell-write') return undefined;\n    return valueAtPath(step?.variables?.[access.variable], access.indices);\n  }\n\n  function traceStepFrameId(step) {\n    const stack = Array.isArray(step?.callStack) ? step.callStack : [];\n    return stack.length > 0 ? stack[stack.length - 1]?.id : undefined;\n  }\n\n  function updateRuntimeTraceAccessStats(access) {\n    const variable = access?.variable;\n    if (typeof variable !== 'string' || variable.length === 0) return;\n    const stats = runtimeTraceAccessStatsByVariable.get(variable) ?? {\n      hasCellRead: false,\n      hasCellWrite: false,\n      hasMutatingCall: false,\n      hasNestedMutatingCall: false,\n      hasIndexedWrite: false,\n    };\n    if (access.kind === 'cell-read') stats.hasCellRead = true;\n    if (access.kind === 'cell-write') stats.hasCellWrite = true;\n    if (access.kind === 'mutating-call') stats.hasMutatingCall = true;\n    if (access.kind === 'mutating-call' && (access.pathDepth ?? 0) > 0) stats.hasNestedMutatingCall = true;\n    if (access.kind === 'indexed-write') stats.hasIndexedWrite = true;\n    runtimeTraceAccessStatsByVariable.set(variable, stats);\n  }\n\n  function appendRuntimeTraceEventsForStep(step) {\n    if (traceLimitExceeded && timeoutReason === 'trace-limit' && step?.event !== 'timeout') {\n      return;\n    }\n    const stack = Array.isArray(step.callStack) ? step.callStack : [];\n    const base = {\n      runId: 'javascript:run',\n      line: step.line,\n      frameId: runtimeTraceFrameIdForStep(step),\n      ...runtimeTraceSourceOwnership(step.line, step.function),\n      ...(stack.length > 0 ? { callStack: stack.map((frame) => ({ ...frame })) } : {}),\n    };\n    const pushRuntimeTraceEvent = (event) => {\n      if (runtimeTraceEvents.length >= effectiveMaxRuntimeTraceEvents) {\n        markTraceCaptureLimit(step?.line, step?.function);\n        return false;\n      }\n      runtimeTraceEvents.push(event);\n      return true;\n    };\n\n    if (step.event === 'line') {\n      pushRuntimeTraceEvent({ ...base, kind: 'line', function: step.function });\n    } else if (step.event === 'call') {\n      pushRuntimeTraceEvent({\n        ...base,\n        kind: 'call',\n        function: step.function,\n        args: stack.at(-1)?.args,\n      });\n    } else if (step.event === 'return') {\n      pushRuntimeTraceEvent({\n        ...base,\n        kind: 'return',\n        function: step.function,\n        ...(step.returnValue !== undefined ? { value: step.returnValue } : {}),\n      });\n    } else if (step.event === 'exception') {\n      pushRuntimeTraceEvent({ ...base, kind: 'exception', message: String(step.returnValue ?? 'Runtime exception') });\n    } else if (step.event === 'timeout') {\n      pushRuntimeTraceEvent({ ...base, kind: 'timeout', message: 'Runtime timeout' });\n    } else if (step.event === 'stdout') {\n      pushRuntimeTraceEvent({\n        ...base,\n        kind: 'stdout',\n        ...(step.line ? { line: step.line } : {}),\n        text: String(step.returnValue ?? ''),\n      });\n    }\n\n    if (minimalTrace) return;\n\n    if (step.event !== '__merge_only__') {\n      for (const [variable, value] of Object.entries(step.variables ?? {})) {\n        if (!pushRuntimeTraceEvent({ ...base, kind: 'snapshot', target: { variable }, value })) return;\n      }\n    } else {\n      for (const [variable, value] of Object.entries(step.variables ?? {})) {\n        if (!pushRuntimeTraceEvent({ ...base, kind: 'snapshot', target: { variable }, value })) return;\n      }\n    }\n\n    for (const access of step.accesses ?? []) {\n      updateRuntimeTraceAccessStats(access);\n      const kind = runtimeTraceKindForAccess(access);\n      const target = runtimeTraceTargetForAccess(access);\n      const accessBase = {\n        ...base,\n        ...(Number.isFinite(access.line) && access.line > 0 ? { line: access.line } : {}),\n        ...(Number.isFinite(access.column) && access.column >= 0 ? { column: access.column } : {}),\n        ...runtimeTraceSourceOwnership(\n          Number.isFinite(access.line) && access.line > 0 ? access.line : step.line,\n          step.function\n        ),\n      };\n      if (kind === 'mutate') {\n        const event = {\n          ...accessBase,\n          kind,\n          target,\n          ...(access.method ? { method: access.method } : {}),\n          ...(Array.isArray(access.args) ? { args: access.args } : {}),\n        };\n        if (!pushRuntimeTraceEvent(event)) return;\n      } else {\n        const event = {\n          ...accessBase,\n          kind,\n          target,\n          value: runtimeTraceAccessValue(step, access),\n          ...(access.binding ? { binding: access.binding } : {}),\n        };\n        if (!pushRuntimeTraceEvent(event)) return;\n      }\n    }\n  }\n\n  function canMergeConsecutiveLineSteps(previous, nextStep) {\n    if (!previous || !nextStep) return false;\n    if (previous.event !== 'line' || nextStep.event !== 'line') return false;\n    if (previous.line !== nextStep.line) return false;\n    if (previous.function !== nextStep.function) return false;\n    if ((previous.accesses?.length ?? 0) > 0 || (nextStep.accesses?.length ?? 0) > 0) return false;\n    return sameCallStackVisit(previous.callStack, nextStep.callStack);\n  }\n\n  function sameCallStackVisit(left, right) {\n    if (!Array.isArray(left) || !Array.isArray(right)) return false;\n    if (left.length !== right.length) return false;\n    for (let index = 0; index < left.length; index += 1) {\n      const leftFrame = left[index];\n      const rightFrame = right[index];\n      if (!leftFrame || !rightFrame) return false;\n      if (leftFrame.function !== rightFrame.function) return false;\n      if (leftFrame.line !== rightFrame.line) return false;\n    }\n    return true;\n  }\n\n  function markTimeout(reason, lineNumber, message) {\n    const normalizedLine = normalizeLine(lineNumber, 1);\n    if (!traceLimitExceeded) {\n      traceLimitExceeded = true;\n      timeoutReason = reason;\n    }\n    if (!timeoutRecorded && trace.length < effectiveMaxTraceSteps) {\n      appendTrace({\n        line: normalizedLine,\n        event: 'timeout',\n        variables: {},\n        function: callStack[callStack.length - 1]?.function ?? '<module>',\n        callStack: snapshotCallStack(),\n      });\n      timeoutRecorded = true;\n    }\n    throw createLimitError(reason, normalizedLine, message);\n  }\n\n  function alignCallStackForLine(functionName, lineNumber, functionStartLine, inferredArgs = {}) {\n    const normalizedFunctionName =\n      typeof functionName === 'string' && functionName.length > 0 ? functionName : '<module>';\n\n    if (normalizedFunctionName === '<module>') {\n      if (callStack.length === 0) {\n        const moduleFrame = {\n          id: nextFrameId++,\n          function: '<module>',\n          args: sanitizeVariables(inferredArgs),\n          line: lineNumber,\n        };\n        callStack.push(moduleFrame);\n      } else {\n        const topFrame = callStack[callStack.length - 1];\n        if (\n          topFrame?.function === '<module>' &&\n          Object.keys(topFrame.args ?? {}).length === 0 &&\n          inferredArgs &&\n          typeof inferredArgs === 'object'\n        ) {\n          topFrame.args = sanitizeVariables(inferredArgs);\n        }\n      }\n\n      while (callStack.length > 1) {\n        callStack.pop();\n      }\n      return '<module>';\n    }\n\n    const normalizedMatchKey = normalizeFrameMatchKey(normalizedFunctionName);\n    let matchingFrameIndex = -1;\n    for (let index = callStack.length - 1; index >= 0; index -= 1) {\n      const frame = callStack[index];\n      if (!frame) continue;\n      if (\n        frame.function === normalizedFunctionName ||\n        normalizeFrameMatchKey(frame.function) === normalizedMatchKey\n      ) {\n        matchingFrameIndex = index;\n        break;\n      }\n    }\n\n    if (matchingFrameIndex >= 0) {\n      while (callStack.length - 1 > matchingFrameIndex) {\n        const frame = callStack.pop();\n        if (frame?.id !== undefined) {\n          pendingAccessesByFrame.delete(frame.id);\n          deferredAccessesByFrame.delete(frame.id);\n        }\n      }\n    }\n\n    const topFrame = callStack[callStack.length - 1];\n    if (topFrame && normalizeFrameMatchKey(topFrame.function) === normalizedMatchKey) {\n      if (\n        normalizedMatchKey === 'constructor' &&\n        topFrame.function !== normalizedFunctionName &&\n        normalizedFunctionName.endsWith('.constructor')\n      ) {\n        topFrame.function = normalizedFunctionName;\n      }\n      if (\n        Object.keys(topFrame.args ?? {}).length === 0 &&\n        inferredArgs &&\n        typeof inferredArgs === 'object'\n      ) {\n        topFrame.args = sanitizeVariables(inferredArgs);\n      }\n      return normalizedFunctionName;\n    }\n\n    if (!topFrame) {\n      const callLine = normalizeLine(functionStartLine, lineNumber);\n      const inferredFrame = {\n        id: nextFrameId++,\n        function: normalizedFunctionName,\n        args: sanitizeVariables(inferredArgs),\n        line: callLine,\n      };\n      callStack.push(inferredFrame);\n      appendTrace({\n        line: callLine,\n        event: 'call',\n        variables: inferredFrame.args,\n        function: normalizedFunctionName,\n        callStack: snapshotCallStack(),\n      });\n      return normalizedFunctionName;\n    }\n\n    return normalizedFunctionName;\n  }\n\n  return {\n    serialize(value) {\n      return serializeTraceValue(value);\n    },\n    read(getter) {\n      try {\n        return getter();\n      } catch {\n        return undefined;\n      }\n    },\n    pushCall(functionName, args, lineNumber) {\n      const normalizedLine = normalizeLine(lineNumber, 1);\n      if (callStack.length + 1 > maxCallDepth) {\n        markTimeout(\n          'recursion-limit',\n          normalizedLine,\n          `Exceeded max call depth (${maxCallDepth})`\n        );\n      }\n      if (traceLimitExceeded) {\n        return;\n      }\n      this.attachPendingAccessesToPreviousLine();\n      const normalizedArgs = sanitizeCallArgs(args);\n      const frame = {\n        id: nextFrameId++,\n        function: functionName || '<module>',\n        args: normalizedArgs,\n        line: normalizedLine,\n      };\n      callStack.push(frame);\n      appendTrace({\n        line: normalizedLine,\n        event: 'call',\n        variables: normalizedArgs,\n        function: frame.function,\n        callStack: snapshotCallStack(),\n      });\n    },\n    recordAccess(event) {\n      if (traceLimitExceeded) {\n        return;\n      }\n      if (!event || typeof event !== 'object') {\n        return;\n      }\n      const variable =\n        typeof event.variable === 'string' && event.variable.length > 0 ? event.variable : null;\n      const kind = typeof event.kind === 'string' ? event.kind : null;\n      if (!variable || !kind) {\n        return;\n      }\n\n      const frameId = getCurrentFrameId();\n      if (frameId === undefined) {\n        return;\n      }\n\n      const hasExplicitPath = Array.isArray(event.indices) && event.indices.length > 0;\n      const normalizedIndices = hasExplicitPath\n        ? normalizeTraceIndices(event.indices, maxPathDepth, (value) => this.serialize(value))\n        : null;\n      if (hasExplicitPath && !normalizedIndices) {\n        return;\n      }\n      const normalizedIndexSources = normalizedIndices\n        ? normalizeTraceIndexSources(event.indexSources, normalizedIndices.length)\n        : null;\n      const normalized = {\n        variable,\n        kind,\n        ...(normalizedIndices ? { indices: normalizedIndices } : {}),\n        ...(normalizedIndexSources && normalizedIndexSources.length > 0\n          ? { indexSources: normalizedIndexSources }\n          : {}),\n        ...(typeof event.method === 'string' && event.method.length > 0\n          ? { method: event.method }\n          : {}),\n        ...(Array.isArray(event.args)\n          ? { args: event.args.map((arg) => this.serialize(arg)) }\n          : {}),\n        ...(Number.isInteger(event.pathDepth) && event.pathDepth > 0 && event.pathDepth <= maxPathDepth ? { pathDepth: event.pathDepth } : {}),\n        ...(typeof event.scope === 'string' && event.scope.length > 0\n          ? { scope: event.scope }\n          : {}),\n        ...(event.binding &&\n        typeof event.binding === 'object' &&\n        typeof event.binding.variable === 'string' &&\n        event.binding.variable.length > 0\n          ? {\n              binding: {\n                ...(event.binding.kind === 'iteration' ? { kind: 'iteration' } : {}),\n                variable: event.binding.variable,\n              },\n            }\n          : {}),\n        ...(Number.isFinite(event.line) && event.line > 0\n          ? { line: Math.trunc(event.line) }\n          : {}),\n        ...(Number.isFinite(event.column) && event.column >= 0\n          ? { column: Math.trunc(event.column) }\n          : {}),\n        ...(Object.prototype.hasOwnProperty.call(event, 'value')\n          ? { value: this.serialize(event.value) }\n          : {}),\n      };\n\n      const existing = pendingAccessesByFrame.get(frameId) ?? [];\n      if (this.pendingAccessBudget() <= 0) {\n        return;\n      }\n      existing.push(normalized);\n      pendingAccessesByFrame.set(frameId, existing);\n    },\n    pendingAccessBudget(reserve = 0) {\n      if (traceLimitExceeded) {\n        return 0;\n      }\n      const frameId = getCurrentFrameId();\n      if (frameId === undefined) {\n        return 0;\n      }\n      const pendingCount = pendingAccessesByFrame.get(frameId)?.length ?? 0;\n      const reserved = Number.isFinite(reserve) ? Math.max(0, Math.trunc(reserve)) : 0;\n      const remainingEvents = effectiveMaxRuntimeTraceEvents - runtimeTraceEvents.length - pendingCount - reserved;\n      return Math.max(0, Math.min(MAX_TRACE_BULK_ACCESSES, remainingEvents));\n    },\n    deferPendingAccesses(lineFlushes = 1) {\n      if (traceLimitExceeded) {\n        return;\n      }\n      const frameId = getCurrentFrameId();\n      if (frameId === undefined) {\n        return;\n      }\n      const pending = pendingAccessesByFrame.get(frameId);\n      if (!Array.isArray(pending) || pending.length === 0) {\n        return;\n      }\n      pendingAccessesByFrame.delete(frameId);\n      const existing = deferredAccessesByFrame.get(frameId);\n      deferredAccessesByFrame.set(frameId, {\n        accesses: [...(Array.isArray(existing?.accesses) ? existing.accesses : []), ...pending],\n        skipLineFlushes: Math.max(\n          typeof existing?.skipLineFlushes === 'number' ? existing.skipLineFlushes : 0,\n          Math.max(0, Math.trunc(lineFlushes))\n        ),\n      });\n    },\n    attachPendingAccessesToPreviousLine() {\n      if (traceLimitExceeded) {\n        return;\n      }\n      const frameId = getCurrentFrameId();\n      if (frameId === undefined) {\n        return;\n      }\n      const pending = pendingAccessesByFrame.get(frameId);\n      if (!Array.isArray(pending) || pending.length === 0) {\n        return;\n      }\n      const attachable = pending;\n      pendingAccessesByFrame.delete(frameId);\n      if (attachable.length === 0) {\n        return;\n      }\n      for (let index = trace.length - 1; index >= 0; index -= 1) {\n        const step = trace[index];\n        if (!step || step.event !== 'line') continue;\n        if (traceStepFrameId(step) !== frameId) continue;\n        step.accesses = [...(step.accesses ?? []), ...attachable];\n        appendRuntimeTraceEventsForStep({\n          ...step,\n          event: '__access_only__',\n          accesses: attachable,\n        });\n        return;\n      }\n      pendingAccessesByFrame.set(frameId, attachable);\n    },\n    traceCondition(evaluate, shouldEvaluate = false) {\n      if (!shouldEvaluate) {\n        this.attachPendingAccessesToPreviousLine();\n        return evaluate;\n      }\n      try {\n        return evaluate();\n      } finally {\n        this.attachPendingAccessesToPreviousLine();\n      }\n    },\n    tracePostLineCondition(evaluate, shouldEvaluate = false) {\n      if (!shouldEvaluate) {\n        return evaluate;\n      }\n      return evaluate();\n    },\n    line(lineNumber, snapshotFactory, functionNameOverride, functionStartLine) {\n      const normalizedLine = normalizeLine(lineNumber, callStack[callStack.length - 1]?.line ?? 1);\n\n      if (traceLimitExceeded) {\n        return;\n      }\n\n      lineEventCount += 1;\n      if (lineEventCount > maxLineEvents) {\n        markTimeout('line-limit', normalizedLine, `Exceeded ${maxLineEvents} line events`);\n      }\n\n      const nextLineHits = (lineHitCount.get(normalizedLine) ?? 0) + 1;\n      lineHitCount.set(normalizedLine, nextLineHits);\n      if (nextLineHits > maxSingleLineHits) {\n        markTimeout(\n          'single-line-limit',\n          normalizedLine,\n          `Line ${normalizedLine} exceeded ${maxSingleLineHits} hits`\n        );\n      }\n\n      let variables = {};\n      if (typeof snapshotFactory === 'function') {\n        try {\n          const snapshot = snapshotFactory();\n          variables = sanitizeVariables(snapshot);\n        } catch {\n          variables = {};\n        }\n      }\n\n      const traceFunctionName = alignCallStackForLine(\n        functionNameOverride,\n        normalizedLine,\n        functionStartLine,\n        variables\n      );\n\n      appendTrace({\n        line: normalizedLine,\n        event: 'line',\n        variables,\n        function: traceFunctionName,\n        callStack: snapshotCallStack(),\n      });\n    },\n    recordReturn(lineNumber, returnValue, functionNameOverride) {\n      if (traceLimitExceeded) {\n        return;\n      }\n      this.attachPendingAccessesToPreviousLine();\n      const normalizedLine = normalizeLine(lineNumber, callStack[callStack.length - 1]?.line ?? 1);\n      const functionName =\n        typeof functionNameOverride === 'string' && functionNameOverride.length > 0\n          ? functionNameOverride\n          : callStack[callStack.length - 1]?.function ?? '<module>';\n      const serializedReturnValue = serializeTraceValue(returnValue);\n      const variables = functionName === '<module>' ? { result: serializedReturnValue } : {};\n\n      appendTrace({\n        line: normalizedLine,\n        event: 'return',\n        variables,\n        function: functionName,\n        callStack: snapshotCallStack(),\n        returnValue: serializedReturnValue,\n      });\n    },\n    recordException(lineNumber, error, functionNameOverride) {\n      if (traceLimitExceeded) {\n        return;\n      }\n      const normalizedLine = normalizeLine(lineNumber, callStack[callStack.length - 1]?.line ?? 1);\n      appendTrace({\n        line: normalizedLine,\n        event: 'exception',\n        variables: {},\n        function:\n          typeof functionNameOverride === 'string' && functionNameOverride.length > 0\n            ? functionNameOverride\n            : callStack[callStack.length - 1]?.function ?? '<module>',\n        callStack: snapshotCallStack(),\n        returnValue: error instanceof Error ? error.message : String(error),\n      });\n    },\n    recordStdout(lineNumber, text) {\n      if (traceLimitExceeded) {\n        return;\n      }\n      const normalizedLine = normalizeLine(lineNumber, callStack[callStack.length - 1]?.line ?? 1);\n      appendTrace({\n        line: normalizedLine,\n        event: 'stdout',\n        variables: {},\n        function: callStack[callStack.length - 1]?.function ?? '<module>',\n        callStack: snapshotCallStack(),\n        stdoutLineCount: 1,\n        returnValue: String(text ?? ''),\n      });\n    },\n    popCall() {\n      if (callStack.length > 0) {\n        const frame = callStack.pop();\n        if (frame?.id !== undefined) {\n          pendingAccessesByFrame.delete(frame.id);\n          deferredAccessesByFrame.delete(frame.id);\n        }\n      }\n    },\n    popToFunction(functionName) {\n      const target = typeof functionName === 'string' && functionName.length > 0 ? functionName : '<module>';\n      while (callStack.length > 1 && callStack[callStack.length - 1]?.function !== target) {\n        const frame = callStack.pop();\n        if (frame?.id !== undefined) {\n          pendingAccessesByFrame.delete(frame.id);\n          deferredAccessesByFrame.delete(frame.id);\n        }\n      }\n    },\n    getTrace() {\n      return trace;\n    },\n    getRuntimeTrace(language, runId = `${language}:run`, file) {\n      const events = runtimeTraceEvents.map((event) => ({\n        ...event,\n        runId,\n        ...(file ? { file } : {}),\n      }));\n      return {\n        schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,\n        language,\n        runId,\n        events,\n        lineEventCount: events.filter((event) => event.kind === 'line').length,\n        traceStepCount: events.length,\n      };\n    },\n    getLineEventCount() {\n      return lineEventCount;\n    },\n    getTraceStepCount() {\n      return trace.length;\n    },\n    isTraceLimitExceeded() {\n      return traceLimitExceeded;\n    },\n    getTimeoutReason() {\n      return timeoutReason;\n    },\n  };\n}\n\nfunction valueAtPath(value, path) {\n  if (!Array.isArray(path) || path.length === 0) return value;\n  let current = value;\n  for (const part of path) {\n    if (current === null || current === undefined || typeof current !== 'object') return undefined;\n    const key = String(part);\n    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;\n    current = current[key];\n  }\n  return current;\n}"}
return createTraceRecorder;
})()`
  );
  if (typeof recorderFactory !== "function") {
    throw new Error("SES trace recorder runtime did not compile to a function.");
  }
  createFastTraceRecorder = recorderFactory;
}
async function executeCase(program, inputs, tracingEnabled = program.mode === "trace") {
  const startedAt = performance.now();
  const tracing = program.mode === "trace" && tracingEnabled;
  const compartment = new Compartment(
    compartmentBaseEndowmentsFor(program.requiredModules)
  );
  const takeConsole = compartment.evaluate(CONSOLE_BOOTSTRAP_SOURCE);
  if (typeof takeConsole !== "function") {
    throw new Error("SES compartment returned an invalid console snapshot function.");
  }
  const snapshotConsole = () => {
    const serialized2 = takeConsole();
    if (typeof serialized2 !== "string") {
      throw new Error("SES console snapshot was not serialized.");
    }
    const parsed = JSON.parse(serialized2);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.lines) || parsed.lines.some((line) => typeof line !== "string") || typeof parsed.budgetExceeded !== "boolean") {
      throw new Error("SES console snapshot had an invalid shape.");
    }
    return parsed;
  };
  const consoleResult = (elapsedMs2) => {
    const snapshot = snapshotConsole();
    if (!snapshot.budgetExceeded) {
      return { lines: snapshot.lines, compatibilityRequired: false };
    }
    return {
      compatibilityRequired: true,
      result: {
        kind: "failed",
        error: SES_CONSOLE_COMPATIBILITY_REQUIRED,
        diagnosticStage: "runtime",
        consoleOutput: snapshot.lines,
        ...program.mode === "trace" ? { trace: emptyTrace(), executionTimeMs: elapsedMs2 } : {},
        timings: {
          totalMs: elapsedMs2,
          runMs: elapsedMs2,
          artifactCacheHit: true,
          algorithmFastBatch: true
        }
      }
    };
  };
  const emptyTrace = () => ({
    schemaVersion: "runtime-trace-2026-04-28",
    language: program.language,
    runId: typeof program.traceOptions?.runId === "string" ? program.traceOptions.runId : `${program.language}:run`,
    events: [],
    lineEventCount: 0,
    traceStepCount: 0
  });
  const recorder = tracing ? createFastTraceRecorder?.(program.traceOptions) : void 0;
  if (tracing && !recorder) {
    throw new Error("SES trace recorder runtime is unavailable.");
  }
  if (recorder) harden(recorder);
  const snapshotTrace = () => {
    if (!recorder) return emptyTrace();
    const getRuntimeTrace = recorder.getRuntimeTrace;
    if (typeof getRuntimeTrace !== "function") {
      throw new Error("SES trace recorder returned an invalid runtime surface.");
    }
    const runId = typeof program.traceOptions?.runId === "string" ? program.traceOptions.runId : `${program.language}:run`;
    const file = typeof program.traceOptions?.file === "string" ? program.traceOptions.file : program.language === "typescript" ? "solution.ts" : "solution.js";
    return getRuntimeTrace(program.language, runId, file);
  };
  const runtimeFailure = (error, elapsedMs2) => {
    const tracedErrorLine = error && typeof error === "object" && Number.isFinite(error.__traceLine) ? Number(error.__traceLine) : void 0;
    const errorLine = tracedErrorLine ?? learnerErrorLine(error);
    const console3 = consoleResult(elapsedMs2);
    if (console3.compatibilityRequired) return console3.result;
    const traceLimitExceeded2 = Boolean(
      error && typeof error === "object" && error.__traceLimitExceeded === true
    );
    const timeoutReason2 = error && typeof error === "object" && typeof error.__timeoutReason === "string" ? error.__timeoutReason : typeof recorder?.getTimeoutReason === "function" ? recorder.getTimeoutReason() : void 0;
    if (recorder && !traceLimitExceeded2 && typeof recorder.recordException === "function") {
      const traceErrorLine = error && typeof error === "object" && Number.isFinite(error.__traceLine) ? Number(error.__traceLine) : errorLine ?? program.traceLineBounds?.endLine ?? 1;
      recorder.recordException(traceErrorLine, safeErrorText(error), program.functionName);
    }
    const base = {
      kind: "failed",
      error: safeErrorText(error),
      ...errorLine !== void 0 ? { errorLine } : {},
      diagnosticStage: "runtime",
      consoleOutput: console3.lines,
      timings: {
        totalMs: elapsedMs2,
        runMs: elapsedMs2,
        artifactCacheHit: true,
        algorithmFastBatch: true
      }
    };
    if (program.mode !== "trace") return base;
    const trace2 = snapshotTrace();
    return timeoutReason2 ? {
      ...base,
      kind: "limit",
      reason: timeoutReason2,
      trace: trace2,
      executionTimeMs: elapsedMs2
    } : { ...base, trace: trace2, executionTimeMs: elapsedMs2 };
  };
  compartment.evaluate(program.capabilityBootstrapSource);
  installCaseLibraries(compartment, program.requiredModules);
  compartment.evaluate(
    `${CASE_RUNTIME_BOUNDARY_SOURCE};
${RUNTIME_BOOTSTRAP_SOURCE};
${program.moduleBootstrapSource}`
  );
  const driver = compartment.evaluate(DRIVER_SOURCE);
  if (typeof driver !== "function") {
    throw new Error("SES compartment returned a non-callable driver.");
  }
  const learnerFactorySource2 = tracing ? program.traceLearnerFactorySource : program.codeLearnerFactorySource;
  if (typeof learnerFactorySource2 !== "string") {
    throw new Error("SES prepared program has no requested learner artifact.");
  }
  const executeLearner = compartment.evaluate(learnerFactorySource2, {
    __rejectSomeDirectEvalExpressions__: false
  });
  if (typeof executeLearner !== "function") {
    throw new Error("SES compartment returned a non-callable learner program.");
  }
  try {
    await executeLearner(
      ...tracing ? [recorder, { functionName: program.functionName }] : []
    );
  } catch (error) {
    return runtimeFailure(error, performance.now() - startedAt);
  }
  let serialized;
  try {
    serialized = await driver(
      JSON.stringify(inputs),
      JSON.stringify(program.inputArguments),
      JSON.stringify(program.materializers),
      program.functionName,
      program.executionStyle
    );
  } catch (error) {
    return runtimeFailure(error, performance.now() - startedAt);
  }
  if (typeof serialized !== "string") {
    throw new Error("SES compartment returned a non-serializable result.");
  }
  const result = JSON.parse(serialized);
  const elapsedMs = performance.now() - startedAt;
  const console2 = consoleResult(elapsedMs);
  if (console2.compatibilityRequired) return console2.result;
  const consoleOutput = console2.lines;
  if (!result.success) {
    const errorLine = Number.isSafeInteger(result.errorLine) && result.errorLine > 0 ? result.errorLine : void 0;
    const base = {
      kind: "failed",
      error: result.error ?? "SES compartment execution failed.",
      ...errorLine !== void 0 ? { errorLine } : {},
      diagnosticStage: "runtime",
      consoleOutput,
      timings: {
        totalMs: elapsedMs,
        runMs: elapsedMs,
        artifactCacheHit: true,
        algorithmFastBatch: true
      }
    };
    return program.mode === "trace" ? { ...base, trace: snapshotTrace(), executionTimeMs: elapsedMs } : base;
  }
  const output = decodeOutputTransport(result.output);
  if (output === OUTPUT_TRANSPORT_HOLE) {
    throw new Error("SES compartment returned a top-level output transport hole.");
  }
  const completed = {
    kind: "completed",
    output: output ?? null,
    consoleOutput,
    timings: {
      totalMs: elapsedMs,
      runMs: elapsedMs,
      artifactCacheHit: true,
      algorithmFastBatch: true
    }
  };
  if (program.mode !== "trace") return completed;
  const trace = snapshotTrace();
  const traceLimitExceeded = typeof recorder?.isTraceLimitExceeded === "function" && recorder.isTraceLimitExceeded() === true;
  const timeoutReason = typeof recorder?.getTimeoutReason === "function" ? recorder.getTimeoutReason() : void 0;
  return {
    ...completed,
    trace,
    executionTimeMs: elapsedMs,
    ...traceLimitExceeded ? { traceTruncated: typeof timeoutReason === "string" ? timeoutReason : "trace-limit" } : {}
  };
}
function isHardenedWorkerRealm() {
  if (!Object.isFrozen(Object.prototype) || !Object.isFrozen(Function.prototype)) {
    return false;
  }
  try {
    const compartment = new Compartment();
    return compartment.evaluate(`(() => {
      if (!Object.isFrozen(Object.prototype)) return false;
      try { Math.random(); return false; } catch { return true; }
    })()`) === true;
  } catch {
    return false;
  }
}
async function assertIntegrity(bytes, integrity) {
  const algorithms = /* @__PURE__ */ new Map([
    ["sha256", "SHA-256"],
    ["sha384", "SHA-384"],
    ["sha512", "SHA-512"]
  ]);
  const candidates = integrity.trim().split(/\s+/u).flatMap((token) => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(token);
    return match && match[1] && match[2] ? [{ algorithm: match[1], expected: match[2] }] : [];
  });
  if (candidates.length === 0) {
    throw new Error("JavaScript libraries integrity has no supported SRI token.");
  }
  for (const candidate of candidates) {
    const digest = await crypto.subtle.digest(algorithms.get(candidate.algorithm), bytes);
    const actual = btoa(String.fromCharCode(...new Uint8Array(digest)));
    if (actual === candidate.expected) return;
  }
  throw new Error("JavaScript libraries failed declared integrity verification.");
}
async function initialize(librariesUrl, librariesIntegrity) {
  const hardened = isHardenedWorkerRealm();
  if (WORKER_MODE === "ses" !== hardened) {
    throw new Error(`SES Worker hardening attestation failed for ${WORKER_MODE} artifact.`);
  }
  if (initialized) return { mode: WORKER_MODE, hardened };
  javascriptLibrariesUrl = librariesUrl;
  javascriptLibrariesIntegrity = librariesIntegrity;
  validateInfrastructure();
  initialized = true;
  return { mode: WORKER_MODE, hardened };
}
async function ensureJavascriptLibraries() {
  if (javascriptLibraryEndowments) return;
  if (!javascriptLibrariesLoad) {
    javascriptLibrariesLoad = (async () => {
      const workerUrl = new URL(self.location.href);
      const workerSegments = workerUrl.pathname.split("/");
      const isCanonicalLanguageDirectory = workerSegments[workerSegments.length - 2] === "javascript";
      const librariesUrl = javascriptLibrariesUrl ?? new URL(
        `${isCanonicalLanguageDirectory ? "../" : "./"}vendor/javascript-libraries.js`,
        workerUrl
      ).toString();
      const response = await fetch(librariesUrl);
      if (!response.ok) {
        throw new Error(`Failed to load JavaScript libraries: HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      if (javascriptLibrariesIntegrity) {
        await assertIntegrity(bytes, javascriptLibrariesIntegrity);
      }
      javascriptLibrariesSource = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      javascriptLibraryEndowments = buildLibraryEndowments();
      if (!javascriptLibraryEndowments) {
        throw new Error("JavaScript library runtime asset produced no module surface.");
      }
    })();
  }
  try {
    await javascriptLibrariesLoad;
  } catch (error) {
    javascriptLibrariesLoad = void 0;
    throw error;
  }
}
var WORKER_MODE, CONSOLE_BOOTSTRAP_SOURCE, RUNTIME_BOOTSTRAP_SOURCE, CASE_RUNTIME_BOUNDARY_SOURCE, programs, javascriptLibrariesSource, javascriptLibraryEndowments, javascriptLibrariesUrl, javascriptLibrariesIntegrity, javascriptLibrariesLoad, initialized, createFastTraceRecorder, safeHostEndowmentCandidates, safeHostEndowments, DRIVER_SOURCE, OUTPUT_TRANSPORT_HOLE, SourceNormalizationInvariantError, LIBRARY_GLOBAL_NAMES, LODASH_CONTEXT_NAMES;
var init_ses_algorithm_worker = __esm({
  "packages/runtime-javascript/src/ses-algorithm-worker.ts"() {
    "use strict";
    init_acorn();
    init_javascript_runtime_policy();
    WORKER_MODE = "ses";
    CONSOLE_BOOTSTRAP_SOURCE = `(() => {
  const output = [];
  const stringify = JSON.stringify;
  const mathMin = Math.min;
  const mathMax = Math.max;
  const truncationMarker = '\u2026[truncated]';
  const truncate = (text, limit) => {
    if (text.length <= limit) return text;
    if (limit <= truncationMarker.length) return truncationMarker.slice(0, limit);
    return text.slice(0, limit - truncationMarker.length) + truncationMarker;
  };
  const format = (value) => {
    if (typeof value === 'string') {
      return truncate(value, 4096);
    }
    if (value === null || value === undefined ||
        typeof value === 'number' || typeof value === 'boolean') {
      return truncate(String(value), 4096);
    }
    try {
      const encoded = stringify(value);
      return typeof encoded === 'string' ? truncate(encoded, 4096) : '';
    } catch {
      try { return truncate(String(value), 4096); } catch { return '[Unprintable]'; }
    }
  };
  let totalCharacters = 0;
  let stopped = false;
  let budgetExceeded = false;
  const capture = (...values) => {
    if (stopped) return;
    if (output.length >= 99) {
      output.push(truncationMarker);
      stopped = true;
      budgetExceeded = true;
      return;
    }
    const argumentLimit = mathMin(values.length, 40);
    let line = '';
    for (let index = 0; index < argumentLimit; index += 1) {
      const rendered = format(values[index]);
      if (rendered.endsWith(truncationMarker)) budgetExceeded = true;
      line = truncate(line + (index === 0 ? '' : ' ') + rendered, 8192);
      if (line.endsWith(truncationMarker)) {
        budgetExceeded = true;
        break;
      }
    }
    if (values.length > argumentLimit && !line.endsWith(truncationMarker)) {
      budgetExceeded = true;
      line = truncate(line + ' \u2026 ' + (values.length - argumentLimit) + ' more', 8192);
    }
    const remaining = 65536 - totalCharacters;
    if (line.length > remaining) {
      line = truncate(line, mathMax(0, remaining));
      stopped = true;
      budgetExceeded = true;
    }
    output.push(line);
    totalCharacters += line.length;
  };
  globalThis.console = Object.freeze({
    log: capture,
    info: capture,
    warn: capture,
    error: capture,
    debug: capture,
  });
  return () => stringify({ lines: output, budgetExceeded });
})()`;
    RUNTIME_BOOTSTRAP_SOURCE = `(() => {
  class ListNode {
    constructor(val = 0, next = null) {
      this.val = val;
      this.value = val;
      this.next = next;
    }
  }
  class TreeNode {
    constructor(val = 0, left = null, right = null) {
      this.val = val;
      this.value = val;
      this.left = left;
      this.right = right;
    }
  }
  Object.defineProperties(globalThis, {
    ListNode: { value: ListNode, writable: true, configurable: true },
    TreeNode: { value: TreeNode, writable: true, configurable: true },
  });
})()`;
    CASE_RUNTIME_BOUNDARY_SOURCE = `(() => {
  const blockedDynamicEvaluation = function () {
    throw Object.assign(new Error('Harness blocked dynamic code evaluation'), {
      code: 'ERR_HARNESS_DYNAMIC_EVAL',
    });
  };
  Object.defineProperties(globalThis, {
    global: { value: globalThis, writable: false, enumerable: false, configurable: false },
    self: { value: undefined, writable: false, enumerable: false, configurable: false },
    window: { value: undefined, writable: false, enumerable: false, configurable: false },
    document: { value: undefined, writable: false, enumerable: false, configurable: false },
    postMessage: { value: undefined, writable: false, enumerable: false, configurable: false },
    importScripts: { value: undefined, writable: false, enumerable: false, configurable: false },
    Worker: { value: undefined, writable: false, enumerable: false, configurable: false },
    SharedWorker: { value: undefined, writable: false, enumerable: false, configurable: false },
    WebAssembly: { value: undefined, writable: false, enumerable: false, configurable: false },
    process: { value: undefined, writable: false, enumerable: false, configurable: false },
    Function: { value: blockedDynamicEvaluation, writable: false, enumerable: false, configurable: false },
    eval: { value: blockedDynamicEvaluation, writable: false, enumerable: false, configurable: false },
    Compartment: { value: blockedDynamicEvaluation, writable: false, enumerable: false, configurable: false },
  });
})()`;
    programs = /* @__PURE__ */ new Map();
    javascriptLibrariesSource = "";
    initialized = false;
    safeHostEndowmentCandidates = {
      ..."Float16Array" in globalThis ? { Float16Array: globalThis.Float16Array } : {},
      Float32Array,
      Float64Array,
      TextDecoder,
      TextEncoder,
      structuredClone: (value) => globalThis.structuredClone(value),
      Intl,
      URL,
      URLSearchParams,
      atob: (value) => globalThis.atob(value),
      btoa: (value) => globalThis.btoa(value)
    };
    safeHostEndowments = harden(
      safeHostEndowmentCandidates
    );
    DRIVER_SOURCE = `(() => {
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const arrayIsArray = Array.isArray;
  const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);
  const objectEntries = Object.entries;
  const objectKeys = Object.keys;
  const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const objectIs = Object.is;
  const toText = String;
  const isPlainRecord = (value) => value !== null && typeof value === 'object' &&
    !arrayIsArray(value) && Object.prototype.toString.call(value) === '[object Object]';
  const collectReferenceTargets = (value, byId, seen) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (arrayIsArray(value)) {
      for (const item of value) collectReferenceTargets(item, byId, seen);
      return;
    }
    if (!isPlainRecord(value)) return;
    if (typeof value.__id__ === 'string' && value.__id__.length > 0 && !byId.has(value.__id__)) {
      byId.set(value.__id__, value);
    }
    for (const child of Object.values(value)) collectReferenceTargets(child, byId, seen);
  };
  const resolveReferenceGraph = (value, byId, resolved) => {
    if (value === null || typeof value !== 'object') return value;
    if (resolved.has(value)) return resolved.get(value);
    if (arrayIsArray(value)) {
      const out = [];
      resolved.set(value, out);
      for (const item of value) out.push(resolveReferenceGraph(item, byId, resolved));
      return out;
    }
    if (!isPlainRecord(value)) return value;
    const keys = objectKeys(value);
    if (keys.length === 1 && typeof value.__ref__ === 'string') {
      const target = byId.get(value.__ref__);
      return target ? resolveReferenceGraph(target, byId, resolved) : null;
    }
    const out = {};
    resolved.set(value, out);
    for (const [key, child] of objectEntries(value)) {
      out[key] = resolveReferenceGraph(child, byId, resolved);
    }
    return out;
  };
  const normalizeInput = (input) => {
    if (!isPlainRecord(input)) return {};
    const byId = new Map();
    collectReferenceTargets(input, byId, new WeakSet());
    return resolveReferenceGraph(input, byId, new WeakMap());
  };
  const nodeValue = (value) => value.val ?? value.value ?? null;
  const materializeTree = (value, materialized = new WeakMap(), depth = 0) => {
    if (value === null || value === undefined) return value;
    if (depth > 512) throw new Error('Input materializer exceeded maximum depth (512)');
    if (arrayIsArray(value)) {
      if (value.length === 0 || value[0] === null || value[0] === undefined) return null;
      const makeNode = (item) => ({ val: item, value: item, left: null, right: null });
      const root = makeNode(value[0]);
      const queue = [root];
      let queueIndex = 0;
      let index = 1;
      while (queueIndex < queue.length && index < value.length) {
        const node = queue[queueIndex++];
        const left = value[index++];
        if (left !== null && left !== undefined) {
          node.left = makeNode(left);
          queue.push(node.left);
        }
        if (index >= value.length) break;
        const right = value[index++];
        if (right !== null && right !== undefined) {
          node.right = makeNode(right);
          queue.push(node.right);
        }
      }
      return root;
    }
    if (!isPlainRecord(value)) return value;
    const looksLikeTree = value.__type__ === 'TreeNode' ||
      (value.constructor && value.constructor.name === 'TreeNode');
    if (!looksLikeTree) return value;
    const cached = materialized.get(value);
    if (cached) return cached;
    const item = nodeValue(value);
    const node = { val: item, value: item, left: null, right: null };
    materialized.set(value, node);
    node.left = materializeTree(value.left ?? null, materialized, depth + 1);
    node.right = materializeTree(value.right ?? null, materialized, depth + 1);
    for (const [key, child] of objectEntries(value)) {
      if (!['__id__', '__type__', '__class__', 'val', 'value', 'left', 'right'].includes(key)) {
        node[key] = materializeTree(child, materialized, depth + 1);
      }
    }
    return node;
  };
  const materializeList = (value, materialized = new WeakMap(), depth = 0) => {
    if (value === null || value === undefined) return value;
    if (depth > 512) throw new Error('Input materializer exceeded maximum depth (512)');
    if (arrayIsArray(value)) {
      if (value.length === 0) return null;
      const head = { val: value[0], value: value[0], next: null };
      let tail = head;
      for (let index = 1; index < value.length; index += 1) {
        tail.next = { val: value[index], value: value[index], next: null };
        tail = tail.next;
      }
      return head;
    }
    if (!isPlainRecord(value)) return value;
    const looksLikeList = value.__type__ === 'ListNode' ||
      (value.constructor && value.constructor.name === 'ListNode');
    if (!looksLikeList) return value;
    const cached = materialized.get(value);
    if (cached) return cached;
    const item = nodeValue(value);
    const node = { val: item, value: item, next: null };
    materialized.set(value, node);
    node.next = materializeList(value.next ?? null, materialized, depth + 1);
    if (hasOwn(value, 'prev')) node.prev = materializeList(value.prev ?? null, materialized, depth + 1);
    for (const [key, child] of objectEntries(value)) {
      if (!['__id__', '__type__', '__class__', 'val', 'value', 'next', 'prev'].includes(key)) {
        node[key] = materializeList(child, materialized, depth + 1);
      }
    }
    return node;
  };
  const resolveConstructor = (typeName) => {
    const registry = globalThis.__tracecodeConstructors;
    return registry && hasOwn(registry, typeName) ? registry[typeName] : undefined;
  };
  const materializeCustom = (value, targetTypeName, seen = new WeakMap()) => {
    if (value === null || typeof value !== 'object') return value;
    const cached = seen.get(value);
    if (cached) return cached;
    if (arrayIsArray(value)) {
      const out = [];
      seen.set(value, out);
      for (const item of value) out.push(materializeCustom(item, undefined, seen));
      return out;
    }
    if (value.__type__ === 'TreeNode' || value.__type__ === 'ListNode') return value;
    const typeName = typeof targetTypeName === 'string'
      ? targetTypeName
      : (typeof value.__type__ === 'string'
          ? value.__type__
          : (typeof value.__class__ === 'string' ? value.__class__ : null));
    const trustedTypeName = typeof targetTypeName === 'string';
    if (!typeName) {
      seen.set(value, value);
      for (const [key, child] of objectEntries(value)) {
        if (key === '__type__' || key === '__class__' || key === '__id__') continue;
        value[key] = materializeCustom(child, undefined, seen);
      }
      return value;
    }
    const fields = {};
    seen.set(value, fields);
    if (typeof value.__type__ === 'string') fields.__type__ = value.__type__;
    if (typeof value.__class__ === 'string') fields.__class__ = value.__class__;
    for (const [key, child] of objectEntries(value)) {
      if (key === '__type__' || key === '__class__' || key === '__id__') continue;
      fields[key] = materializeCustom(child, undefined, seen);
    }
    if (!trustedTypeName) return fields;
    const constructor = resolveConstructor(typeName);
    if (typeof constructor !== 'function') return fields;
    const args = objectValuesWithoutMetadata(fields);
    let instance;
    try { instance = new constructor(...args); }
    catch { instance = Object.create(constructor.prototype); }
    Object.assign(instance, fields);
    seen.set(value, instance);
    return instance;
  };
  const objectValuesWithoutMetadata = (value) => objectKeys(value)
    .filter((key) => key !== '__type__' && key !== '__class__')
    .map((key) => value[key]);
  const materialize = (value, kind, depth = 0) => {
    if (depth > 512) throw new Error('Input materializer exceeded maximum depth (512)');
    if (!kind) return materializeCustom(value);
    if (kind === 'tree') return materializeTree(value);
    if (kind === 'list') return materializeList(value);
    if (kind.kind === 'custom') return materializeCustom(value, kind.typeName);
    if (kind.kind === 'array') {
      return arrayIsArray(value)
        ? value.map((item) => materialize(item, kind.element, depth + 1))
        : value;
    }
    if (kind.kind === 'record' && isPlainRecord(value)) {
      const out = {};
      for (const [key, child] of objectEntries(value)) {
        out[key] = materialize(child, kind.value, depth + 1);
      }
      return out;
    }
    if (kind.kind === 'map') {
      const entries = arrayIsArray(value) ? value : (isPlainRecord(value) ? objectEntries(value) : null);
      return entries
        ? new Map(entries.map(([key, child]) => [key, materialize(child, kind.value, depth + 1)]))
        : value;
    }
    return materializeCustom(value);
  };
  const inferFallbackMaterializers = (input) => {
    const out = {};
    const listNames = new Set(['head', 'l1', 'l2', 'list1', 'list2', 'node']);
    for (const [name, value] of objectEntries(input)) {
      if (!arrayIsArray(value)) continue;
      const lowerName = toText(name).toLowerCase();
      if (lowerName === 'root' || lowerName.endsWith('root') || lowerName.includes('tree')) {
        out[name] = 'tree';
      } else if (lowerName.endsWith('head') || listNames.has(lowerName)) {
        out[name] = 'list';
      }
    }
    return out;
  };
  const explicitNodeType = (value) => {
    const constructorName = value && value.constructor && value.constructor.name;
    if (constructorName === 'TreeNode' || value.__type__ === 'TreeNode') return 'TreeNode';
    if (constructorName === 'ListNode' || value.__type__ === 'ListNode') return 'ListNode';
    return null;
  };
  const inferredPlainNodeType = (value) => {
    if (value.__type__ === 'TreeNode' || value.__type__ === 'ListNode') return null;
    const id = typeof value.__id__ === 'string' ? value.__id__ : '';
    if (id.startsWith('tree-') || id.startsWith('TreeNode:')) return 'TreeNode';
    if (id.startsWith('list-') || id.startsWith('ListNode:')) return 'ListNode';
    const hasValue = hasOwn(value, 'val') || hasOwn(value, 'value');
    if (hasValue && (hasOwn(value, 'left') || hasOwn(value, 'right'))) return 'TreeNode';
    if (hasValue && (hasOwn(value, 'next') || hasOwn(value, 'prev'))) return 'ListNode';
    return null;
  };
  const forcedNodeTypeForValue = (value, forcedNodeType) => {
    if (!forcedNodeType || !value || typeof value !== 'object' || arrayIsArray(value)) return null;
    return hasOwn(value, 'val') || hasOwn(value, 'value') ? forcedNodeType : null;
  };
  const customClassName = (value) => {
    const name = value && value.constructor && value.constructor.name;
    return typeof name === 'string' && !['', 'Object', 'Array', 'Map', 'Set', 'TreeNode', 'ListNode'].includes(name)
      ? name
      : null;
  };
  const ownEnumerableDataEntries = (value) => {
    if (!value || typeof value !== 'object') return [];
    const entries = [];
    for (const key of objectKeys(value)) {
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true) continue;
      entries.push([
        key,
        hasOwn(descriptor, 'value') ? descriptor.value : '<accessor>',
      ]);
    }
    return entries;
  };
  const encodeOutputTransport = (value, depth = 0) => {
    if (depth > 192) throw new Error('SES output transport exceeded maximum depth.');
    if (value === null) return ['null'];
    if (value === undefined) return ['undefined'];
    if (typeof value === 'string') return ['string', value];
    if (typeof value === 'boolean') return ['boolean', value];
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return ['nan'];
      if (value === Infinity) return ['infinity'];
      if (value === -Infinity) return ['negative-infinity'];
      return objectIs(value, -0) ? ['negative-zero'] : ['number', value];
    }
    if (arrayIsArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(hasOwn(value, index)
          ? encodeOutputTransport(value[index], depth + 1)
          : ['hole']);
      }
      return ['array', items];
    }
    if (value !== null && typeof value === 'object') {
      return ['object', objectEntries(value).map(([key, child]) => [
        key,
        encodeOutputTransport(child, depth + 1),
      ])];
    }
    throw new Error('SES output serializer produced an unsupported transport value.');
  };
  const serialize = (value, depth = 0, seen = new WeakSet(), state = {
    ids: new WeakMap(), nextId: 1,
  }, forcedNodeType = null) => {
    if (depth > 48) return '<max depth>';
    if (value === null || value === undefined) return value;
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return 'NaN';
      if (value === Infinity) return 'Infinity';
      if (value === -Infinity) return '-Infinity';
      return value;
    }
    if (typeof value === 'bigint') {
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : toText(value);
    }
    if (typeof value === 'symbol') return toText(value);
    if (typeof value === 'function') return '<function>';
    if (typeof value !== 'object') return value;
    if (arrayIsArray(value)) {
      if (seen.has(value)) return '<cycle>';
      seen.add(value);
      return value.map((item) => serialize(item, depth + 1, seen, state));
    }
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
      if (seen.has(value)) return '<cycle>';
      seen.add(value);
      if (value instanceof DataView) {
        return Array.from({ length: value.byteLength }, (_, index) =>
          serialize(value.getUint8(index), depth + 1, seen, state));
      }
      return Array.from({ length: value.length }, (_, index) =>
        serialize(value[index], depth + 1, seen, state));
    }
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
      if (seen.has(value)) return '<cycle>';
      seen.add(value);
      const bytes = new Uint8Array(value);
      return Array.from({ length: bytes.byteLength }, (_, index) =>
        serialize(bytes[index], depth + 1, seen, state));
    }
    if (value instanceof Set) {
      if (seen.has(value)) return '<cycle>';
      seen.add(value);
      return { __type__: 'set', values: Array.from(value, (item) => serialize(item, depth + 1, seen, state)) };
    }
    if (value instanceof Map) {
      if (seen.has(value)) return '<cycle>';
      seen.add(value);
      return { __type__: 'map', entries: Array.from(value, ([key, child]) => [
        serialize(key, depth + 1, seen, state),
        serialize(child, depth + 1, seen, state),
      ]) };
    }
    const explicitType = explicitNodeType(value);
    const nodeType = explicitType ??
      forcedNodeTypeForValue(value, forcedNodeType) ??
      inferredPlainNodeType(value);
    if (nodeType) {
      const existingId = state.ids.get(value);
      if (existingId) return { __ref__: existingId };
      const id = typeof value.__id__ === 'string' && value.__id__.length > 0
        ? value.__id__
        : (explicitType ? 'ref-' : nodeType + ':') + state.nextId++;
      state.ids.set(value, id);
      seen.add(value);
      const out = nodeType === 'TreeNode'
        ? {
            __type__: 'TreeNode', __id__: id,
            val: serialize(nodeValue(value), depth + 1, seen, state),
            left: serialize(value.left ?? null, depth + 1, seen, state, 'TreeNode'),
            right: serialize(value.right ?? null, depth + 1, seen, state, 'TreeNode'),
          }
        : {
            __type__: 'ListNode', __id__: id,
            val: serialize(nodeValue(value), depth + 1, seen, state),
            next: serialize(value.next ?? null, depth + 1, seen, state, 'ListNode'),
            ...(hasOwn(value, 'prev')
              ? { prev: serialize(value.prev ?? null, depth + 1, seen, state, 'ListNode') }
              : {}),
          };
      const skipped = nodeType === 'TreeNode'
        ? new Set(['__id__', '__type__', '__class__', 'val', 'value', 'left', 'right'])
        : new Set(['__id__', '__type__', '__class__', 'val', 'value', 'next', 'prev']);
      for (const [key, child] of ownEnumerableDataEntries(value)) {
        if (!skipped.has(key)) out[key] = serialize(child, depth + 1, seen, state);
      }
      seen.delete(value);
      return out;
    }
    const existingNodeId = (hasOwn(value, 'val') || hasOwn(value, 'value'))
      ? state.ids.get(value)
      : undefined;
    if (existingNodeId) return { __ref__: existingNodeId };
    const className = customClassName(value);
    if (className) {
      const existingId = state.ids.get(value);
      if (existingId) return { __ref__: existingId };
      const id = 'ref-' + state.nextId++;
      state.ids.set(value, id);
      if (seen.has(value)) return { __ref__: id };
      seen.add(value);
      const out = { __type__: className, __class__: className, __id__: id };
      for (const [key, child] of ownEnumerableDataEntries(value)) {
        out[key] = serialize(child, depth + 1, seen, state);
      }
      seen.delete(value);
      return out;
    }
    if (seen.has(value)) return '<cycle>';
    seen.add(value);
    const out = {};
    for (const [key, child] of ownEnumerableDataEntries(value)) {
      out[key] = serialize(child, depth + 1, seen, state);
    }
    return out;
  };
  return async (inputJson, inputArgumentsJson, materializersJson, targetName, executionStyle) => {
    const input = normalizeInput(parse(inputJson));
      const inputArguments = parse(inputArgumentsJson);
      const materializers = {
        ...inferFallbackMaterializers(input),
        ...parse(materializersJson),
      };
      const target = globalThis.__tracecodeTarget;
      const args = [];
      const inputKeys = objectKeys(input);
      const matchedArguments = inputArguments.filter((argument) => hasOwn(input, argument.key));
      const orderedArguments = matchedArguments.length === 0
        ? inputKeys.map((key) => ({ key, rest: false }))
        : [
            ...matchedArguments,
            ...inputKeys
              .filter((key) => !matchedArguments.some((argument) => argument.key === key))
              .map((key) => ({ key, rest: false })),
          ];
      for (const argument of orderedArguments) {
        const value = materialize(input[argument.key], materializers[argument.key]);
        if (argument.rest) {
          if (value === null || value === undefined) continue;
          if (arrayIsArray(value)) args.push(...value);
          else args.push(value);
        } else {
          args.push(value);
        }
      }
      let output;
      if (executionStyle === 'function') {
        if (typeof target !== 'function') throw new Error('Function "' + targetName + '" not found');
        output = await target(...args);
      } else if (executionStyle === 'solution-method') {
        if (typeof target !== 'function') throw new Error('Class "Solution" not found');
        const prototypeMethod = target.prototype && target.prototype[targetName];
        if (typeof prototypeMethod === 'function') {
          const solver = new target();
          output = await prototypeMethod.call(solver, ...args);
        } else if (typeof target[targetName] === 'function') {
          output = await target[targetName].call(target, ...args);
        } else {
          const solver = new target();
          const method = solver[targetName];
          if (typeof method !== 'function') throw new Error('Method "Solution.' + targetName + '" not found');
          output = await method.call(solver, ...args);
        }
      } else if (executionStyle === 'ops-class') {
        const operations = input.operations ?? input.ops;
        const operationArguments = input.arguments ?? input.args;
        if (!arrayIsArray(operations) || !arrayIsArray(operationArguments)) {
          throw new Error('ops-class execution requires inputs.operations and inputs.arguments (or ops/args)');
        }
        if (operations.length !== operationArguments.length) {
          throw new Error('operations and arguments must have the same length');
        }
        if (typeof target !== 'function') throw new Error('Class "' + targetName + '" not found');
        let instance = null;
        output = [];
        for (let index = 0; index < operations.length; index += 1) {
          let callArgs = operationArguments[index];
          if (callArgs === null || callArgs === undefined) callArgs = [];
          if (!arrayIsArray(callArgs)) callArgs = [callArgs];
          callArgs = callArgs.map((argument) => materialize(argument, null));
          if (index === 0) {
            instance = new target(...callArgs);
            output.push(null);
            continue;
          }
          const operation = operations[index];
          if (!instance || typeof instance[operation] !== 'function') {
            throw new Error('Required method "' + operation + '" is not implemented on ' + targetName);
          }
          const result = instance[operation](...callArgs);
          output.push(result === undefined ? null : result);
        }
      } else {
        throw new Error('Unknown algorithm execution style.');
      }
      return stringify({
        success: true,
        output: encodeOutputTransport(output === undefined ? null : serialize(output)),
      });
  };
})()`;
    OUTPUT_TRANSPORT_HOLE = /* @__PURE__ */ Symbol("tracecode.output-transport-hole");
    SourceNormalizationInvariantError = class extends Error {
      constructor(message, options) {
        super(message, options);
        this.name = "SourceNormalizationInvariantError";
      }
    };
    LIBRARY_GLOBAL_NAMES = [
      "__TRACECODE_JAVASCRIPT_LIBRARIES__",
      "require",
      "_",
      "lodash",
      "Deque",
      "DoublyLinkedList",
      "DoublyLinkedListNode",
      "EnhancedSet",
      "Heap",
      "LinkedList",
      "LinkedListNode",
      "MaxHeap",
      "MaxPriorityQueue",
      "MinHeap",
      "MinPriorityQueue",
      "PriorityQueue",
      "Queue",
      "Stack"
    ];
    LODASH_CONTEXT_NAMES = [
      "Array",
      "Buffer",
      "DataView",
      "Date",
      "Error",
      "Float32Array",
      "Float64Array",
      "Function",
      "Int8Array",
      "Int16Array",
      "Int32Array",
      "Map",
      "Math",
      "Object",
      "Promise",
      "RegExp",
      "Set",
      "String",
      "Symbol",
      "TypeError",
      "Uint8Array",
      "Uint8ClampedArray",
      "Uint16Array",
      "Uint32Array",
      "WeakMap",
      "clearTimeout",
      "isFinite",
      "parseInt",
      "setTimeout"
    ];
    self.onmessage = (event) => {
      const data2 = event.data;
      if (!data2 || typeof data2 !== "object") {
        fail(-1, new Error("SES worker control envelope must be an object."));
        return;
      }
      const candidate = data2;
      if (!Number.isSafeInteger(candidate.id)) {
        fail(-1, new Error("SES worker control envelope has an invalid request id."));
        return;
      }
      const request = candidate;
      const requestId = request.id;
      void (async () => {
        switch (request.type) {
          case "init":
            reply(request.id, await initialize(
              request.javascriptLibrariesUrl,
              request.javascriptLibrariesIntegrity
            ));
            return;
          case "prepare": {
            if (!initialized) throw new Error("SES worker has not been initialized.");
            if (!request.programId || !request.source) {
              throw new Error("SES prepare request is incomplete.");
            }
            assertPreparedShape(request.source);
            const validationCompartment = new Compartment();
            let sanitizedLearnerSource;
            let sanitizedTraceSource;
            try {
              assertAdmittedModules(request.source);
              sanitizedLearnerSource = sanitizeLearnerSource(request.source.code);
              sanitizedTraceSource = request.source.mode === "trace" ? sanitizeLearnerSource(request.source.instrumentedCode) : void 0;
            } catch (error) {
              if (error instanceof SourceNormalizationInvariantError) throw error;
              fail(request.id, error, "compile");
              return;
            }
            if (request.source.requiredModules.length > 0) {
              try {
                await ensureJavascriptLibraries();
              } catch (error) {
                fail(request.id, error, "control");
                return;
              }
            }
            let validatedCodeLearnerFactorySource;
            let validatedTraceLearnerFactorySource;
            try {
              validatedCodeLearnerFactorySource = compileLearnerFactory(
                validationCompartment,
                request.source,
                sanitizedLearnerSource
              );
              validatedTraceLearnerFactorySource = sanitizedTraceSource === void 0 ? void 0 : compileLearnerFactory(
                validationCompartment,
                request.source,
                sanitizedTraceSource,
                true
              );
            } catch (error) {
              if (!isLearnerEngineSyntaxError(error)) throw error;
              fail(request.id, error, "compile");
              return;
            }
            programs.set(request.programId, {
              mode: request.source.mode,
              language: request.source.language,
              codeLearnerFactorySource: validatedCodeLearnerFactorySource,
              ...validatedTraceLearnerFactorySource === void 0 ? {} : { traceLearnerFactorySource: validatedTraceLearnerFactorySource },
              capabilityBootstrapSource: deterministicCapabilityPrelude(request.source),
              moduleBootstrapSource: moduleBootstrapSource(request.source),
              functionName: request.source.functionName,
              executionStyle: request.source.executionStyle,
              inputArguments: request.source.inputArguments,
              materializers: request.source.materializers,
              requiredModules: Object.freeze([...request.source.requiredModules]),
              ...request.source.traceLineBounds ? { traceLineBounds: Object.freeze({ ...request.source.traceLineBounds }) } : {},
              ...request.source.traceOptions ? { traceOptions: Object.freeze({ ...request.source.traceOptions }) } : {}
            });
            reply(request.id, null);
            return;
          }
          case "execute-batch": {
            if (!initialized) throw new Error("SES worker has not been initialized.");
            if (!request.programId || !request.inputBatch) {
              throw new Error("SES execute request is incomplete.");
            }
            const program = programs.get(request.programId);
            if (!program) throw new Error("Unknown SES prepared program.");
            const traceSelection = request.traceEnabledBatch ?? request.inputBatch.map(() => program.mode === "trace");
            if (traceSelection.length !== request.inputBatch.length || traceSelection.some((enabled) => typeof enabled !== "boolean")) {
              throw new Error("SES trace selection must contain one boolean per batch case.");
            }
            const results = [];
            for (let index = 0; index < request.inputBatch.length; index += 1) {
              results.push(await executeCase(
                program,
                request.inputBatch[index],
                traceSelection[index]
              ));
            }
            reply(request.id, results);
            return;
          }
          case "ping":
            if (!initialized) throw new Error("SES worker has not been initialized.");
            reply(request.id, null);
            return;
          case "dispose-program":
            if (request.programId) programs.delete(request.programId);
            reply(request.id, null);
            return;
          default:
            throw new Error("SES worker request type is invalid.");
        }
      })().catch((error) => fail(requestId, error));
    };
  }
});

// node_modules/ses/src/commons.js
var universalThis = globalThis;
var {
  Array: Array2,
  ArrayBuffer,
  Date,
  FinalizationRegistry,
  // Renamed to FERAL_* because it enables the NaN side-channel
  Float64Array: FERAL_FLOAT64_ARRAY,
  DataView,
  JSON: JSON2,
  Map: Map2,
  Math: Math2,
  Number: Number2,
  BigInt: BigInt2,
  Object: Object2,
  Promise: Promise2,
  Proxy: Proxy2,
  Reflect: Reflect2,
  RegExp: FERAL_REG_EXP,
  Set: Set2,
  String: String2,
  Symbol: Symbol2,
  Uint8Array: Uint8Array2,
  WeakMap,
  WeakSet: WeakSet2,
  Temporal
  // may be undefined on old JS engines
} = globalThis;
var {
  // The feral Error constructor is safe for internal use, but must not be
  // revealed to post-lockdown code in any compartment including the start
  // compartment since in V8 at least it bears stack inspection capabilities.
  Error: FERAL_ERROR,
  RangeError: RangeError2,
  ReferenceError: ReferenceError2,
  SyntaxError: SyntaxError2,
  TypeError: TypeError2,
  AggregateError: AggregateError2
} = globalThis;
var {
  assign,
  create,
  defineProperties,
  entries,
  getOwnPropertyDescriptor,
  getOwnPropertyDescriptors,
  getOwnPropertyNames,
  getPrototypeOf,
  is,
  isFrozen,
  isSealed,
  isExtensible,
  keys,
  prototype: objectPrototype,
  seal,
  preventExtensions,
  setPrototypeOf,
  values,
  fromEntries
} = Object2;
var freeze = (
  /** @type {any} */
  Object2.freeze
);
var {
  species: speciesSymbol,
  toStringTag: toStringTagSymbol,
  iterator: iteratorSymbol,
  matchAll: matchAllSymbol,
  replace: replaceSymbol,
  search: searchSymbol,
  unscopables: unscopablesSymbol,
  keyFor: symbolKeyFor,
  for: symbolFor
} = Symbol2;
var { max, min, trunc } = Math2;
var { MAX_SAFE_INTEGER, isInteger } = Number2;
var { stringify: stringifyJson } = JSON2;
var { defineProperty: originalDefineProperty } = Object2;
var defineProperty = (object, prop, descriptor) => {
  const result = originalDefineProperty(object, prop, descriptor);
  if (result !== object) {
    throw TypeError2(
      `Please report that the original defineProperty silently failed to set ${stringifyJson(
        String2(prop)
      )}. (SES_DEFINE_PROPERTY_FAILED_SILENTLY)`
    );
  }
  return result;
};
var {
  apply,
  construct,
  get: reflectGet,
  getOwnPropertyDescriptor: reflectGetOwnPropertyDescriptor,
  has: reflectHas,
  isExtensible: reflectIsExtensible,
  ownKeys,
  preventExtensions: reflectPreventExtensions,
  set: reflectSet
} = Reflect2;
var { isArray, prototype: arrayPrototype } = Array2;
var { prototype: arrayBufferPrototype } = ArrayBuffer;
var { prototype: dataViewPrototype } = DataView;
var { prototype: mapPrototype } = Map2;
var { revocable: proxyRevocable } = Proxy2;
var { prototype: regexpPrototype } = RegExp;
var { prototype: setPrototype } = Set2;
var { prototype: stringPrototype } = String2;
var { prototype: weakmapPrototype } = WeakMap;
var { prototype: weaksetPrototype } = WeakSet2;
var { prototype: functionPrototype } = Function;
var { prototype: promisePrototype } = Promise2;
var { prototype: generatorPrototype } = getPrototypeOf(
  // eslint-disable-next-line no-empty-function, func-names
  function* () {
  }
);
var iteratorPrototype = getPrototypeOf(
  // eslint-disable-next-line @endo/no-polymorphic-call
  getPrototypeOf(arrayPrototype.values())
);
var typedArrayPrototype = getPrototypeOf(Uint8Array2.prototype);
var { bind } = functionPrototype;
var uncurryThis = bind.bind(bind.call);
if (!("hasOwn" in Object2)) {
  const ObjectPrototypeHasOwnProperty = objectPrototype.hasOwnProperty;
  const hasOwnShim = (obj, key) => {
    if (obj === void 0 || obj === null) {
      throw TypeError2("Cannot convert undefined or null to object");
    }
    return apply(ObjectPrototypeHasOwnProperty, obj, [key]);
  };
  defineProperty(Object2, "hasOwn", {
    value: hasOwnShim,
    writable: true,
    enumerable: false,
    configurable: true
  });
}
var { hasOwn } = Object2;
var arrayFilter = uncurryThis(arrayPrototype.filter);
var arrayForEach = uncurryThis(arrayPrototype.forEach);
var arrayIncludes = uncurryThis(arrayPrototype.includes);
var arrayJoin = uncurryThis(arrayPrototype.join);
var arrayMap = (
  /** @type {any} */
  uncurryThis(arrayPrototype.map)
);
var arrayFlatMap = (
  /** @type {any} */
  uncurryThis(arrayPrototype.flatMap)
);
var arrayPop = uncurryThis(arrayPrototype.pop);
var arrayPush = uncurryThis(arrayPrototype.push);
var arraySlice = uncurryThis(arrayPrototype.slice);
var arraySome = uncurryThis(arrayPrototype.some);
var arraySort = uncurryThis(arrayPrototype.sort);
var iterateArray = uncurryThis(arrayPrototype[iteratorSymbol]);
var arrayBufferSlice = uncurryThis(arrayBufferPrototype.slice);
var arrayBufferGetByteLength = uncurryThis(
  // @ts-expect-error we know it is there on all conforming platforms
  getOwnPropertyDescriptor(arrayBufferPrototype, "byteLength").get
);
var typedArraySet = uncurryThis(typedArrayPrototype.set);
var mapSet = uncurryThis(mapPrototype.set);
var mapGet = uncurryThis(mapPrototype.get);
var mapHas = uncurryThis(mapPrototype.has);
var mapDelete = uncurryThis(mapPrototype.delete);
var mapEntries = uncurryThis(mapPrototype.entries);
var iterateMap = uncurryThis(mapPrototype[iteratorSymbol]);
var setAdd = uncurryThis(setPrototype.add);
var setDelete = uncurryThis(setPrototype.delete);
var setForEach = uncurryThis(setPrototype.forEach);
var setHas = uncurryThis(setPrototype.has);
var iterateSet = uncurryThis(setPrototype[iteratorSymbol]);
var regexpExec = uncurryThis(regexpPrototype.exec);
var regexpReplace = (
  /** @type {any} */
  uncurryThis(regexpPrototype[replaceSymbol])
);
var regexpSearch = uncurryThis(regexpPrototype[searchSymbol]);
var matchAllRegExp = uncurryThis(regexpPrototype[matchAllSymbol]);
var regexpDescriptors = getOwnPropertyDescriptors(regexpPrototype);
arrayForEach(ownKeys(regexpDescriptors), (key) => {
  const desc = regexpDescriptors[
    /** @type {any} */
    key
  ];
  desc.configurable = false;
  if (desc.writable) desc.writable = false;
});
defineProperty(regexpDescriptors, "constructor", {
  value: void 0,
  enumerable: false,
  configurable: false,
  writable: false
});
var sealRegexp = (regexp) => seal(defineProperties(regexp, regexpDescriptors));
var freezeRegexp = (regexp) => freeze(
  /** @type {any} */
  defineProperties(regexp, regexpDescriptors)
);
var stringEndsWith = uncurryThis(stringPrototype.endsWith);
var stringIncludes = uncurryThis(stringPrototype.includes);
var stringIndexOf = uncurryThis(stringPrototype.indexOf);
var stringMatch = uncurryThis(stringPrototype.match);
var stringSearch = uncurryThis(stringPrototype.search);
var stringSlice = uncurryThis(stringPrototype.slice);
var stringSplit = (
  /** @type {any} */
  uncurryThis(stringPrototype.split)
);
var stringStartsWith = uncurryThis(stringPrototype.startsWith);
var iterateString = uncurryThis(stringPrototype[iteratorSymbol]);
var weakmapDelete = uncurryThis(weakmapPrototype.delete);
var weakmapGet = uncurryThis(weakmapPrototype.get);
var weakmapHas = uncurryThis(weakmapPrototype.has);
var weakmapSet = uncurryThis(weakmapPrototype.set);
var weaksetAdd = uncurryThis(weaksetPrototype.add);
var weaksetHas = uncurryThis(weaksetPrototype.has);
var functionToString = uncurryThis(functionPrototype.toString);
var functionBind = uncurryThis(bind);
var generatorNext = uncurryThis(generatorPrototype.next);
var generatorThrow = uncurryThis(generatorPrototype.throw);
var { all } = Promise2;
var promiseCatch = uncurryThis(promisePrototype.catch);
var promiseThen = (
  /** @type {any} */
  uncurryThis(promisePrototype.then)
);
var finalizationRegistryRegister = FinalizationRegistry && uncurryThis(FinalizationRegistry.prototype.register);
var finalizationRegistryUnregister = FinalizationRegistry && uncurryThis(FinalizationRegistry.prototype.unregister);
var isPrimitive = (val) => !val || typeof val !== "object" && typeof val !== "function";
var isError = (value) => value instanceof FERAL_ERROR;
var identity = (x) => x;
var FERAL_EVAL = eval;
var FERAL_FUNCTION = Function;
var noEvalEvaluate = () => {
  throw TypeError2('Cannot eval with evalTaming set to "no-eval" (SES_NO_EVAL)');
};
var makeTypeError = () => {
  try {
    null.null;
    throw TypeError2("obligatory");
  } catch (error) {
    return (
      /** @type {TypeError} */
      error
    );
  }
};
var errorStackDesc = getOwnPropertyDescriptor(Error("obligatory"), "stack");
var typeErrorStackDesc = getOwnPropertyDescriptor(makeTypeError(), "stack");
var feralStackGetter;
var feralStackSetter;
if (typeErrorStackDesc && typeErrorStackDesc.get) {
  if (
    // In the v8 case as we understand it, all errors have an own stack
    // accessor property, but within the same realm, all these accessor
    // properties have the same getter and have the same setter.
    // This is therefore the case that we repair.
    errorStackDesc && typeof typeErrorStackDesc.get === "function" && typeErrorStackDesc.get === errorStackDesc.get && typeof typeErrorStackDesc.set === "function" && typeErrorStackDesc.set === errorStackDesc.set
  ) {
    feralStackGetter = freeze(typeErrorStackDesc.get);
    feralStackSetter = freeze(typeErrorStackDesc.set);
  } else {
    throw TypeError2(
      "Unexpected Error own stack accessor functions (SES_UNEXPECTED_ERROR_OWN_STACK_ACCESSOR)"
    );
  }
}
var FERAL_STACK_GETTER = feralStackGetter;
var FERAL_STACK_SETTER = feralStackSetter;
var getAsyncGeneratorFunctionInstance = () => {
  try {
    return new FERAL_FUNCTION(
      "return (async function* AsyncGeneratorFunctionInstance() {})"
    )();
  } catch (error) {
    const err = (
      /** @type {Error} */
      error
    );
    if (err.name === "SyntaxError") {
      return void 0;
    } else if (err.name === "EvalError") {
      return async function* AsyncGeneratorFunctionInstance2() {
      };
    } else {
      throw err;
    }
  }
};
var AsyncGeneratorFunctionInstance = getAsyncGeneratorFunctionInstance();

// node_modules/ses/src/assert-sloppy-mode.js
function getThis() {
  return this;
}
if (getThis()) {
  throw TypeError2(`SES failed to initialize, sloppy mode (SES_NO_SLOPPY)`);
}

// node_modules/@endo/env-options/src/env-options.js
var localThis = globalThis;
var { Object: Object3, Reflect: Reflect3, Array: Array3, String: String3, JSON: JSON3, Error: Error2 } = localThis;
var { freeze: freeze2 } = Object3;
var { apply: apply2 } = Reflect3;
var uncurryThis2 = (fn2) => (receiver, ...args) => apply2(fn2, receiver, args);
var arrayPush2 = uncurryThis2(Array3.prototype.push);
var arrayIncludes2 = uncurryThis2(Array3.prototype.includes);
var stringSplit2 = uncurryThis2(String3.prototype.split);
var q = JSON3.stringify;
var Fail = (literals, ...args) => {
  let msg = literals[0];
  for (let i = 0; i < args.length; i += 1) {
    msg = `${msg}${args[i]}${literals[i + 1]}`;
  }
  throw Error2(msg);
};
var makeEnvironmentCaptor = (aGlobal, dropNames = false) => {
  const capturedEnvironmentOptionNames = [];
  const getEnvironmentOption2 = (optionName, defaultSetting, optOtherValues = void 0) => {
    typeof optionName === "string" || Fail`Environment option name ${q(optionName)} must be a string.`;
    typeof defaultSetting === "string" || Fail`Environment option default setting ${q(
      defaultSetting
    )} must be a string.`;
    let setting = defaultSetting;
    const globalProcess = aGlobal.process || void 0;
    const globalEnv = typeof globalProcess === "object" && globalProcess.env || void 0;
    if (typeof globalEnv === "object") {
      if (optionName in globalEnv) {
        if (!dropNames) {
          arrayPush2(capturedEnvironmentOptionNames, optionName);
        }
        const optionValue = globalEnv[optionName];
        typeof optionValue === "string" || Fail`Environment option named ${q(
          optionName
        )}, if present, must have a corresponding string value, got ${q(
          optionValue
        )}`;
        setting = optionValue;
      }
    }
    optOtherValues === void 0 || setting === defaultSetting || arrayIncludes2(optOtherValues, setting) || Fail`Unrecognized ${q(optionName)} value ${q(
      setting
    )}. Expected one of ${q([defaultSetting, ...optOtherValues])}`;
    return setting;
  };
  freeze2(getEnvironmentOption2);
  const getEnvironmentOptionsList2 = (optionName) => {
    const option = getEnvironmentOption2(optionName, "");
    return freeze2(option === "" ? [] : stringSplit2(option, ","));
  };
  freeze2(getEnvironmentOptionsList2);
  const environmentOptionsListHas2 = (optionName, element) => arrayIncludes2(getEnvironmentOptionsList2(optionName), element);
  const getCapturedEnvironmentOptionNames = () => {
    return freeze2([...capturedEnvironmentOptionNames]);
  };
  freeze2(getCapturedEnvironmentOptionNames);
  return freeze2({
    getEnvironmentOption: getEnvironmentOption2,
    getEnvironmentOptionsList: getEnvironmentOptionsList2,
    environmentOptionsListHas: environmentOptionsListHas2,
    getCapturedEnvironmentOptionNames
  });
};
freeze2(makeEnvironmentCaptor);
var {
  getEnvironmentOption,
  getEnvironmentOptionsList,
  environmentOptionsListHas
} = makeEnvironmentCaptor(localThis, true);

// node_modules/@endo/immutable-arraybuffer/src/lib.js
var {
  ArrayBuffer: ArrayBuffer2,
  Object: Object4,
  Reflect: Reflect4,
  Symbol: Symbol3,
  TypeError: TypeError3,
  Uint8Array: Uint8Array3,
  WeakMap: WeakMap2,
  // Capture structuredClone before it can be scuttled.
  structuredClone: optStructuredClone
  // eslint-disable-next-line no-restricted-globals
} = globalThis;
var { freeze: freeze3, defineProperty: defineProperty2, getOwnPropertyDescriptor: getOwnPropertyDescriptor2, getPrototypeOf: getPrototypeOf2 } = Object4;
var { apply: apply3, ownKeys: ownKeys2 } = Reflect4;
var { get: weakmapGet2, set: weakmapSet2, has: weakmapHas2 } = WeakMap2.prototype;
var { prototype: arrayBufferPrototype2 } = ArrayBuffer2;
var {
  slice,
  transfer: optTransfer,
  resize: optResize,
  transferToFixedLength: optTransferToFixedLength
} = arrayBufferPrototype2;
var { get: arrayBufferByteLength } = getOwnPropertyDescriptor2(
  arrayBufferPrototype2,
  "byteLength"
);
var optArrayBufferDetached = getOwnPropertyDescriptor2(
  arrayBufferPrototype2,
  "detached"
)?.get;
var optArrayBufferResizable = getOwnPropertyDescriptor2(
  arrayBufferPrototype2,
  "resizable"
)?.get;
var optArrayBufferMaxByteLength = getOwnPropertyDescriptor2(
  arrayBufferPrototype2,
  "maxByteLength"
)?.get;
var typedArrayPrototype2 = getPrototypeOf2(Uint8Array3.prototype);
var { set: uint8ArraySet } = typedArrayPrototype2;
var { get: uint8ArrayBuffer } = getOwnPropertyDescriptor2(
  typedArrayPrototype2,
  "buffer"
);
var arrayBufferSlice2 = (realBuffer, start = void 0, end = void 0) => apply3(slice, realBuffer, [start, end]);
var optArrayBufferTransfer;
if (optTransfer) {
  optArrayBufferTransfer = (arrayBuffer) => apply3(optTransfer, arrayBuffer, []);
} else if (optStructuredClone) {
  optArrayBufferTransfer = (arrayBuffer) => {
    arrayBufferSlice2(arrayBuffer, 0, 0);
    return optStructuredClone(arrayBuffer, {
      transfer: [arrayBuffer]
    });
  };
} else {
  optArrayBufferTransfer = void 0;
}
var buffers = new WeakMap2();
var isEmulatedImmutable = (buf) => apply3(weakmapHas2, buffers, [buf]);
var amplifyArrayBuffer = (arrayBuffer) => {
  const result = apply3(weakmapGet2, buffers, [arrayBuffer]);
  if (result !== void 0) {
    return result;
  }
  return arrayBuffer;
};
var immutableArrayBufferLibProperties = {
  __proto__: null,
  /**
   * @this {ArrayBuffer}
   */
  get byteLength() {
    return apply3(arrayBufferByteLength, amplifyArrayBuffer(this), []);
  },
  /**
   * @this {ArrayBuffer}
   */
  get detached() {
    if (isEmulatedImmutable(this)) {
      return false;
    }
    if (optArrayBufferDetached === void 0) {
      return false;
    }
    return apply3(optArrayBufferDetached, this, []);
  },
  /**
   * @this {ArrayBuffer}
   */
  get maxByteLength() {
    if (isEmulatedImmutable(this)) {
      return apply3(arrayBufferByteLength, amplifyArrayBuffer(this), []);
    }
    if (optArrayBufferMaxByteLength === void 0) {
      return apply3(arrayBufferByteLength, this, []);
    }
    return apply3(optArrayBufferMaxByteLength, this, []);
  },
  /**
   * @this {ArrayBuffer}
   */
  get resizable() {
    if (isEmulatedImmutable(this)) {
      return false;
    }
    if (optArrayBufferResizable === void 0) {
      return false;
    }
    return apply3(optArrayBufferResizable, this, []);
  },
  /**
   * @this {ArrayBuffer}
   */
  get immutable() {
    return isEmulatedImmutable(this);
  },
  /**
   * @this {ArrayBuffer}
   * @param {number} [start]
   * @param {number} [end]
   */
  slice(start = void 0, end = void 0) {
    return arrayBufferSlice2(amplifyArrayBuffer(this), start, end);
  },
  /**
   * @this {ArrayBuffer}
   * @param {number} [start]
   * @param {number} [end]
   */
  sliceToImmutable(start = void 0, end = void 0) {
    return sliceBufferToImmutable(amplifyArrayBuffer(this), start, end);
  },
  /**
   * @this {ArrayBuffer}
   * @param {number} [newByteLength]
   */
  resize(newByteLength = void 0) {
    if (isEmulatedImmutable(this)) {
      throw TypeError3("Cannot resize an immutable ArrayBuffer");
    }
    if (optResize === void 0) {
      throw TypeError3(
        "Cannot resize ArrayBuffer: underlying platform lacks ArrayBuffer.prototype.resize"
      );
    }
    return apply3(optResize, this, [newByteLength]);
  },
  /**
   * @this {ArrayBuffer}
   * @param {number} [newLength]
   */
  transfer(newLength = void 0) {
    if (isEmulatedImmutable(this)) {
      throw TypeError3("Cannot detach an immutable ArrayBuffer");
    }
    if (optTransfer === void 0) {
      throw TypeError3(
        "Cannot transfer ArrayBuffer: underlying platform lacks ArrayBuffer.prototype.transfer"
      );
    }
    return apply3(optTransfer, this, [newLength]);
  },
  /**
   * @this {ArrayBuffer}
   * @param {number} [newLength]
   */
  transferToFixedLength(newLength = void 0) {
    if (isEmulatedImmutable(this)) {
      throw TypeError3("Cannot detach an immutable ArrayBuffer");
    }
    if (optTransferToFixedLength === void 0) {
      throw TypeError3(
        "Cannot transferToFixedLength ArrayBuffer: underlying platform lacks ArrayBuffer.prototype.transferToFixedLength"
      );
    }
    return apply3(optTransferToFixedLength, this, [newLength]);
  },
  /**
   * @this {ArrayBuffer}
   * @param {number} [newLength]
   */
  transferToImmutable(newLength = void 0) {
    if (isEmulatedImmutable(this)) {
      throw TypeError3("Cannot detach an immutable ArrayBuffer");
    }
    if (optTransferBufferToImmutable === void 0) {
      throw TypeError3(
        "Cannot transfer to immutable: underlying platform lacks transfer or structuredClone"
      );
    }
    return optTransferBufferToImmutable(this, newLength);
  }
};
for (const key of ownKeys2(immutableArrayBufferLibProperties)) {
  defineProperty2(immutableArrayBufferLibProperties, key, {
    enumerable: false
  });
}
freeze3(immutableArrayBufferLibProperties);
var makeImmutableArrayBufferInternal = (realBuffer) => {
  const result = (
    /** @type {ArrayBuffer} */
    /** @type {unknown} */
    {
      __proto__: arrayBufferPrototype2
    }
  );
  defineProperty2(result, Symbol3.toStringTag, {
    value: "ImmutableArrayBuffer",
    writable: false,
    enumerable: false,
    configurable: false
  });
  apply3(weakmapSet2, buffers, [result, realBuffer]);
  return result;
};
freeze3(makeImmutableArrayBufferInternal);
var sliceBufferToImmutable = (buffer, start = void 0, end = void 0) => {
  let realBuffer = apply3(weakmapGet2, buffers, [buffer]);
  if (realBuffer === void 0) {
    realBuffer = buffer;
  }
  return makeImmutableArrayBufferInternal(
    arrayBufferSlice2(realBuffer, start, end)
  );
};
var transferBufferToImmutable;
if (optArrayBufferTransfer) {
  transferBufferToImmutable = (buffer, newLength = void 0) => {
    if (newLength === void 0) {
      buffer = optArrayBufferTransfer(buffer);
    } else if (optTransfer) {
      buffer = apply3(optTransfer, buffer, [newLength]);
    } else {
      buffer = optArrayBufferTransfer(buffer);
      const oldLength = buffer.byteLength;
      if (newLength <= oldLength) {
        buffer = arrayBufferSlice2(buffer, 0, newLength);
      } else {
        const oldTA = new Uint8Array3(buffer);
        const newTA = new Uint8Array3(newLength);
        apply3(uint8ArraySet, newTA, [oldTA]);
        buffer = apply3(uint8ArrayBuffer, newTA, []);
      }
    }
    const result = makeImmutableArrayBufferInternal(buffer);
    return (
      /** @type {ArrayBuffer} */
      /** @type {unknown} */
      result
    );
  };
} else {
  transferBufferToImmutable = void 0;
}
var optTransferBufferToImmutable = transferBufferToImmutable;

// node_modules/@endo/immutable-arraybuffer/src/shim.js
var { ArrayBuffer: ArrayBuffer3, Object: Object5 } = globalThis;
var { getOwnPropertyDescriptors: getOwnPropertyDescriptors2, defineProperties: defineProperties2 } = Object5;
var { prototype: arrayBufferPrototype3 } = ArrayBuffer3;
if (!("sliceToImmutable" in arrayBufferPrototype3)) {
  defineProperties2(
    arrayBufferPrototype3,
    getOwnPropertyDescriptors2(immutableArrayBufferLibProperties)
  );
}

// node_modules/ses/src/error/stringify-utils.js
var an = (str) => {
  str = `${str}`;
  if (str.length >= 1 && stringIncludes("aeiouAEIOU", str[0])) {
    return `an ${str}`;
  }
  return `a ${str}`;
};
freeze(an);
var bestEffortStringify = (payload, spaces = void 0) => {
  const seenSet = new Set2();
  const replacer = (_, val) => {
    switch (typeof val) {
      case "object": {
        if (val === null) {
          return null;
        }
        if (setHas(seenSet, val)) {
          return "[Seen]";
        }
        setAdd(seenSet, val);
        if (isError(val)) {
          return `[${val.name}: ${val.message}]`;
        }
        if (toStringTagSymbol in val) {
          return `[${val[toStringTagSymbol]}]`;
        }
        if (isArray(val)) {
          return val;
        }
        const names = keys(val);
        if (names.length < 2) {
          return val;
        }
        let sorted = true;
        for (let i = 1; i < names.length; i += 1) {
          if (names[i - 1] >= names[i]) {
            sorted = false;
            break;
          }
        }
        if (sorted) {
          return val;
        }
        arraySort(names);
        const entries2 = arrayMap(names, (name) => [name, val[name]]);
        return fromEntries(entries2);
      }
      case "function": {
        return `[Function ${val.name || "<anon>"}]`;
      }
      case "string": {
        if (stringStartsWith(val, "[")) {
          return `[${val}]`;
        }
        return val;
      }
      case "undefined":
      case "symbol": {
        return `[${String2(val)}]`;
      }
      case "bigint": {
        return `[${val}n]`;
      }
      case "number": {
        if (is(val, NaN)) {
          return "[NaN]";
        } else if (val === Infinity) {
          return "[Infinity]";
        } else if (val === -Infinity) {
          return "[-Infinity]";
        }
        return val;
      }
      default: {
        return val;
      }
    }
  };
  try {
    return stringifyJson(payload, replacer, spaces);
  } catch (_err) {
    return "[Something that failed to stringify]";
  }
};
freeze(bestEffortStringify);

// node_modules/@endo/cache-map/src/cachemap.js
var { Error: Error3, TypeError: TypeError4, WeakMap: WeakMap3 } = globalThis;
var { parse, stringify } = JSON;
var { isSafeInteger } = Number;
var { freeze: freeze4 } = Object;
var { toStringTag: toStringTagSymbol2 } = Symbol;
var UNKNOWN_KEY = /* @__PURE__ */ Symbol("UNKNOWN_KEY");
var deepCopyJsonable = (value, reviver) => {
  const encoded = stringify(value);
  const decoded = parse(encoded, reviver);
  return decoded;
};
var freezingReviver = (_name, value) => freeze4(value);
var deepCopyAndFreezeJsonable = (value) => deepCopyJsonable(value, freezingReviver);
var appendNewCell = (prev, id, data2) => {
  const next = prev?.next;
  const cell = { id, next, prev, data: data2 };
  prev.next = cell;
  next.prev = cell;
  return cell;
};
var moveCellAfter = (cell, prev, next = prev.next) => {
  if (cell === prev || cell === next) return;
  const { prev: oldPrev, next: oldNext } = cell;
  oldPrev.next = oldNext;
  oldNext.prev = oldPrev;
  cell.prev = prev;
  cell.next = next;
  prev.next = cell;
  next.prev = cell;
};
var resetCell = (cell, oldKey, makeMap) => {
  if (oldKey !== UNKNOWN_KEY) {
    cell.data.delete(oldKey);
    return;
  }
  if (cell.data.clear) {
    cell.data.clear();
    return;
  }
  if (!makeMap) {
    throw Error3("internal: makeMap is required with UNKNOWN_KEY");
  }
  cell.data = makeMap();
};
var zeroMetrics = freeze4({
  totalQueryCount: 0,
  totalHitCount: 0
  // TODO?
  // * method-specific counts
  // * liveTouchStats/evictedTouchStats { count, sum, mean, min, max }
  //   * p50/p90/p95/p99 via Ben-Haim/Tom-Tov streaming histograms
});
var makeCacheMapKit = (capacity, options = {}) => {
  if (!isSafeInteger(capacity) || capacity < 0) {
    throw TypeError4(
      "capacity must be a non-negative safe integer number <= 2**53 - 1"
    );
  }
  const makeMap = ((MaybeCtor) => {
    try {
      MaybeCtor();
      return (
        /** @type {any} */
        MaybeCtor
      );
    } catch (err) {
      const constructNewMap = () => new MaybeCtor();
      return constructNewMap;
    }
  })(options.makeMap ?? WeakMap3);
  const tag = (
    /** @type {any} */
    makeMap().clear === void 0 ? "WeakCacheMap" : "CacheMap"
  );
  const keyToCell = makeMap();
  const head = (
    /** @type {CacheMapCell<K, V>} */
    {
      id: 0,
      // next and prev are established below as self-referential.
      next: void 0,
      prev: void 0,
      data: {
        has: () => {
          throw Error3("internal: sentinel head cell has no data");
        }
      }
    }
  );
  head.next = head;
  head.prev = head;
  let cellCount = 0;
  const metrics = deepCopyJsonable(zeroMetrics);
  const getMetrics = () => deepCopyAndFreezeJsonable(metrics);
  const touchKey = (key) => {
    metrics.totalQueryCount += 1;
    const cell = keyToCell.get(key);
    if (!cell?.data.has(key)) return void 0;
    metrics.totalHitCount += 1;
    moveCellAfter(cell, head);
    return cell;
  };
  const has = (key) => {
    const cell = touchKey(key);
    return cell !== void 0;
  };
  freeze4(has);
  const get = (key) => {
    const cell = touchKey(key);
    return cell?.data.get(key);
  };
  freeze4(get);
  const set = (key, value) => {
    let cell = touchKey(key);
    if (cell) {
      cell.data.set(key, value);
      return implementation;
    }
    if (cellCount < capacity) {
      cell = appendNewCell(head, cellCount + 1, makeMap());
      cellCount += 1;
      cell.data.set(key, value);
    } else if (capacity > 0) {
      cell = head.prev;
      resetCell(
        /** @type {any} */
        cell,
        UNKNOWN_KEY,
        makeMap
      );
      cell.data.set(key, value);
      moveCellAfter(cell, head);
    }
    if (cell) keyToCell.set(key, cell);
    return implementation;
  };
  freeze4(set);
  const { delete: deleteEntry } = {
    /** @type {WeakMapAPI<K, V>['delete']} */
    delete: (key) => {
      const cell = keyToCell.get(key);
      if (!cell?.data.has(key)) {
        keyToCell.delete(key);
        return false;
      }
      moveCellAfter(cell, head.prev);
      resetCell(cell, key);
      keyToCell.delete(key);
      return true;
    }
  };
  freeze4(deleteEntry);
  const implementation = (
    /** @type {WeakMapAPI<K, V>} */
    {
      has,
      get,
      set,
      delete: deleteEntry,
      // eslint-disable-next-line jsdoc/check-types
      [
        /** @type {typeof Symbol.toStringTag} */
        toStringTagSymbol2
      ]: tag
    }
  );
  freeze4(implementation);
  const kit = { cache: implementation, getMetrics };
  return freeze4(kit);
};
freeze4(makeCacheMapKit);

// node_modules/ses/src/error/note-log-args.js
var { freeze: freeze5 } = Object;
var { isSafeInteger: isSafeInteger2 } = Number;
var defaultLoggedErrorsBudget = 1e3;
var defaultArgsPerErrorBudget = 100;
var makeNoteLogArgsArrayKit = (errorsBudget = defaultLoggedErrorsBudget, argsPerErrorBudget = defaultArgsPerErrorBudget) => {
  if (!isSafeInteger2(argsPerErrorBudget) || argsPerErrorBudget < 1) {
    throw TypeError(
      "argsPerErrorBudget must be a safe positive integer number"
    );
  }
  const { cache: noteLogArgsArrayMap } = makeCacheMapKit(errorsBudget);
  const addLogArgs = (error, logArgs) => {
    const logArgsArray = noteLogArgsArrayMap.get(error);
    if (logArgsArray !== void 0) {
      if (logArgsArray.length >= argsPerErrorBudget) {
        logArgsArray.shift();
      }
      logArgsArray.push(logArgs);
    } else {
      noteLogArgsArrayMap.set(error, [logArgs]);
    }
  };
  freeze5(addLogArgs);
  const takeLogArgsArray = (error) => {
    const result = noteLogArgsArrayMap.get(error);
    noteLogArgsArrayMap.delete(error);
    return result;
  };
  freeze5(takeLogArgsArray);
  return freeze5({
    addLogArgs,
    takeLogArgsArray
  });
};
freeze5(makeNoteLogArgsArrayKit);

// node_modules/ses/src/error/assert.js
var declassifiers = new WeakMap();
var quote = (value, spaces = void 0) => {
  const result = freeze({
    toString: freeze(() => bestEffortStringify(value, spaces))
  });
  weakmapSet(declassifiers, result, value);
  return result;
};
freeze(quote);
var canBeBare = freezeRegexp(/^[\w:-]( ?[\w:-])*$/);
var bare = (text, spaces = void 0) => {
  if (typeof text !== "string" || regexpSearch(canBeBare, text) === -1) {
    return quote(text, spaces);
  }
  const result = freeze({
    toString: freeze(() => text)
  });
  weakmapSet(declassifiers, result, text);
  return result;
};
freeze(bare);
var hiddenDetailsMap = new WeakMap();
var getMessageString = ({ template, args }) => {
  const parts = [template[0]];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    let argStr;
    if (weakmapHas(declassifiers, arg)) {
      argStr = `${arg}`;
    } else if (isError(arg)) {
      argStr = `(${an(arg.name)})`;
    } else {
      argStr = `(${an(typeof arg)})`;
    }
    arrayPush(parts, argStr, template[i + 1]);
  }
  return arrayJoin(parts, "");
};
var DetailsTokenProto = freeze({
  toString() {
    const hiddenDetails = weakmapGet(hiddenDetailsMap, this);
    if (hiddenDetails === void 0) {
      return "[Not a DetailsToken]";
    }
    return getMessageString(hiddenDetails);
  }
});
freeze(DetailsTokenProto.toString);
var redactedDetails = (template, ...args) => {
  const detailsToken = freeze({ __proto__: DetailsTokenProto });
  weakmapSet(hiddenDetailsMap, detailsToken, { template, args });
  return (
    /** @type {DetailsToken} */
    /** @type {unknown} */
    detailsToken
  );
};
freeze(redactedDetails);
var unredactedDetails = (template, ...args) => {
  args = arrayMap(
    args,
    (arg) => weakmapHas(declassifiers, arg) ? arg : quote(arg)
  );
  return redactedDetails(template, ...args);
};
freeze(unredactedDetails);
var getLogArgs = ({ template, args }) => {
  const logArgs = [template[0]];
  for (let i = 0; i < args.length; i += 1) {
    let arg = args[i];
    if (weakmapHas(declassifiers, arg)) {
      arg = weakmapGet(declassifiers, arg);
    }
    const prevLiteralPart = arrayPop(logArgs) || "";
    const trimmedPrev = stringEndsWith(prevLiteralPart, " ") ? stringSlice(prevLiteralPart, 0, -1) : prevLiteralPart;
    if (trimmedPrev !== "") {
      arrayPush(logArgs, trimmedPrev);
    }
    const nextLiteralPart = template[i + 1];
    const trimmedNext = stringStartsWith(nextLiteralPart, " ") ? stringSlice(nextLiteralPart, 1) : nextLiteralPart;
    arrayPush(logArgs, arg, trimmedNext);
  }
  if (logArgs[logArgs.length - 1] === "") {
    arrayPop(logArgs);
  }
  return logArgs;
};
var hiddenMessageLogArgs = new WeakMap();
var errorTagNum = 0;
var errorTags = new WeakMap();
var tagError = (err, optErrorName = err.name) => {
  let errorTag = weakmapGet(errorTags, err);
  if (errorTag !== void 0) {
    return errorTag;
  }
  errorTagNum += 1;
  errorTag = `${optErrorName}#${errorTagNum}`;
  weakmapSet(errorTags, err, errorTag);
  return errorTag;
};
var sanitizeError = (error) => {
  const descs = getOwnPropertyDescriptors(error);
  const {
    name: _nameDesc,
    message: _messageDesc,
    errors: _errorsDesc = void 0,
    cause: _causeDesc = void 0,
    stack: _stackDesc = void 0,
    code: codeDesc = void 0,
    ...restDescs
  } = descs;
  const restNames = ownKeys(restDescs);
  if (codeDesc?.value !== void 0 && typeof codeDesc.value !== "string") {
    arrayPush(restNames, "code");
  }
  if (restNames.length >= 1) {
    for (const name of restNames) {
      delete error[name];
    }
    const dropped = create(objectPrototype, restDescs);
    const droppedDetails = redactedDetails`originally with properties ${quote(dropped)}`;
    note(error, droppedDetails);
  }
  for (const name of ownKeys(error)) {
    const desc = descs[name];
    if (desc && hasOwn(desc, "get")) {
      const value = error[name];
      defineProperty(error, name, { value });
    }
  }
  freeze(error);
};
var makeError = (optDetails, errConstructor, {
  errorName = void 0,
  cause = void 0,
  errors = void 0,
  sanitize = true,
  code = void 0
} = {}) => {
  let details = (
    /** @type {Details} */
    optDetails ?? redactedDetails`Assert failed`
  );
  const errCtor = (
    /** @type {GenericErrorConstructor} */
    errConstructor ?? universalThis.Error
  );
  if (typeof details === "string") {
    details = redactedDetails([details]);
  }
  const hiddenDetails = weakmapGet(hiddenDetailsMap, details);
  if (hiddenDetails === void 0) {
    throw TypeError2(`unrecognized details ${quote(details)}`);
  }
  const messageString = getMessageString(hiddenDetails);
  const opts = cause && { cause };
  let error;
  if (typeof AggregateError2 !== "undefined" && errCtor === AggregateError2) {
    error = AggregateError2(errors || [], messageString, opts);
  } else {
    const ErrorCtor = (
      /** @type {ErrorConstructor} */
      errCtor
    );
    error = ErrorCtor(messageString, opts);
    if (errors !== void 0) {
      defineProperty(error, "errors", {
        value: errors,
        writable: true,
        enumerable: false,
        configurable: true
      });
    }
  }
  if (code !== void 0) {
    defineProperty(error, "code", {
      value: code,
      writable: true,
      enumerable: false,
      configurable: true
    });
  }
  weakmapSet(hiddenMessageLogArgs, error, getLogArgs(hiddenDetails));
  if (errorName !== void 0) {
    tagError(error, errorName);
  }
  if (sanitize) {
    sanitizeError(error);
  }
  return error;
};
freeze(makeError);
var { addLogArgs: addNoteLogArgs, takeLogArgsArray: takeAllNoteLogArgs } = makeNoteLogArgsArrayKit();
var hiddenNoteCallbacks = new WeakMap();
var note = (error, detailsNote) => {
  if (typeof detailsNote === "string") {
    detailsNote = redactedDetails([detailsNote]);
  }
  const hiddenDetails = weakmapGet(hiddenDetailsMap, detailsNote);
  if (hiddenDetails === void 0) {
    throw TypeError2(`unrecognized details ${quote(detailsNote)}`);
  }
  const logArgs = getLogArgs(hiddenDetails);
  const callbacks = weakmapGet(hiddenNoteCallbacks, error);
  if (callbacks !== void 0) {
    for (const callback of callbacks) {
      callback(error, logArgs);
    }
  } else {
    addNoteLogArgs(error, logArgs);
  }
};
freeze(note);
var defaultGetStackString = (error) => {
  if (!("stack" in error)) {
    return "";
  }
  const stackString = `${error.stack}`;
  const pos = stringIndexOf(stackString, "\n");
  if (stringStartsWith(stackString, " ") || pos === -1) {
    return stackString;
  }
  return stringSlice(stackString, pos + 1);
};
var loggedErrorHandler = {
  getStackString: universalThis.getStackString || defaultGetStackString,
  tagError: (error) => tagError(error),
  resetErrorTagNum: () => {
    errorTagNum = 0;
  },
  getMessageLogArgs: (error) => weakmapGet(hiddenMessageLogArgs, error),
  takeMessageLogArgs: (error) => {
    const logArgs = weakmapGet(hiddenMessageLogArgs, error);
    weakmapDelete(hiddenMessageLogArgs, error);
    return logArgs;
  },
  takeNoteLogArgsArray: (error, callback) => {
    const logArgsArray = takeAllNoteLogArgs(error);
    if (callback !== void 0) {
      const callbacks = weakmapGet(hiddenNoteCallbacks, error);
      if (callbacks) {
        arrayPush(callbacks, callback);
      } else {
        weakmapSet(hiddenNoteCallbacks, error, [callback]);
      }
    }
    return logArgsArray || [];
  }
};
freeze(loggedErrorHandler);
var makeAssert = (optRaise = void 0, unredacted = false) => {
  const details = unredacted ? unredactedDetails : redactedDetails;
  const assertFailedDetails = details`Check failed`;
  const fail2 = (optDetails = assertFailedDetails, errConstructor = void 0, options = void 0) => {
    const reason = makeError(optDetails, errConstructor, options);
    if (optRaise !== void 0) {
      optRaise(reason);
    }
    throw reason;
  };
  freeze(fail2);
  const Fail9 = (template, ...args) => fail2(details(template, ...args));
  const assert2 = (condition, optDetails = void 0, errConstructor = void 0, options = void 0) => {
    condition || fail2(optDetails, errConstructor, options);
  };
  const equal = (actual, expected, optDetails = void 0, errConstructor = void 0, options = void 0) => {
    is(actual, expected) || fail2(
      optDetails || details`Expected ${actual} is same as ${expected}`,
      errConstructor || RangeError2,
      options
    );
  };
  freeze(equal);
  const assertTypeof = (specimen, typename, optDetails) => {
    if (typeof specimen === typename) {
      return;
    }
    typeof typename === "string" || Fail9`${quote(typename)} must be a string`;
    if (optDetails === void 0) {
      const typeWithDeterminer = an(typename);
      optDetails = details`${specimen} must be ${bare(typeWithDeterminer)}`;
    }
    fail2(optDetails, TypeError2);
  };
  freeze(assertTypeof);
  const assertString = (specimen, optDetails = void 0) => assertTypeof(specimen, "string", optDetails);
  const assertionFunctions = {
    equal,
    typeof: assertTypeof,
    string: assertString,
    fail: fail2
  };
  const assertionUtilities = {
    makeError,
    note,
    details,
    Fail: Fail9,
    quote,
    bare
  };
  const deprecated = { error: makeError, makeAssert };
  const finishedAssert = assign(assert2, {
    ...assertionFunctions,
    ...assertionUtilities,
    ...deprecated
  });
  return freeze(finishedAssert);
};
freeze(makeAssert);
var assert = makeAssert();
var assertEqual = assert.equal;

// node_modules/ses/src/make-hardener.js
var typedArrayToStringTag = getOwnPropertyDescriptor(
  typedArrayPrototype,
  toStringTagSymbol
);
assert(typedArrayToStringTag);
var getTypedArrayToStringTag = typedArrayToStringTag.get;
assert(getTypedArrayToStringTag);
var isTypedArray = (object) => {
  const tag = apply(getTypedArrayToStringTag, object, []);
  return tag !== void 0;
};
var isCanonicalIntegerIndexString = (propertyKey) => {
  const n = +String2(propertyKey);
  return isInteger(n) && String2(n) === propertyKey;
};
var freezeTypedArray = (array) => {
  preventExtensions(array);
  arrayForEach(ownKeys(array), (name) => {
    const desc = getOwnPropertyDescriptor(array, name);
    assert(desc);
    if (!isCanonicalIntegerIndexString(name)) {
      defineProperty(array, name, {
        ...desc,
        writable: false,
        configurable: false
      });
    }
  });
};
var makeHardener = () => {
  if (typeof universalThis.harden === "function") {
    const safeHarden2 = universalThis.harden;
    return safeHarden2;
  }
  const hardened = new WeakSet2();
  const { harden: harden2 } = {
    /**
     * @template T
     * @param {T} root
     * @returns {T}
     */
    harden(root) {
      const toFreeze = new Set2();
      function enqueue(val) {
        if (isPrimitive(val)) {
          return;
        }
        const type = typeof val;
        if (type !== "object" && type !== "function") {
          throw TypeError2(`Unexpected typeof: ${type}`);
        }
        if (weaksetHas(hardened, val) || setHas(toFreeze, val)) {
          return;
        }
        setAdd(toFreeze, val);
      }
      const baseFreezeAndTraverse = (obj) => {
        if (isTypedArray(obj)) {
          freezeTypedArray(obj);
        } else {
          freeze(obj);
        }
        const descs = getOwnPropertyDescriptors(obj);
        const proto = getPrototypeOf(obj);
        enqueue(proto);
        arrayForEach(ownKeys(descs), (name) => {
          const desc = descs[
            /** @type {string} */
            name
          ];
          if (hasOwn(desc, "value")) {
            enqueue(desc.value);
          } else {
            enqueue(desc.get);
            enqueue(desc.set);
          }
        });
      };
      const freezeAndTraverse = FERAL_STACK_GETTER === void 0 && FERAL_STACK_SETTER === void 0 ? (
        // On platforms without v8's error own stack accessor problem,
        // don't pay for any extra overhead.
        baseFreezeAndTraverse
      ) : (obj) => {
        if (isError(obj)) {
          const stackDesc2 = getOwnPropertyDescriptor(obj, "stack");
          if (stackDesc2 && stackDesc2.get === FERAL_STACK_GETTER && stackDesc2.configurable) {
            defineProperty(obj, "stack", {
              // NOTE: Calls getter during harden, which seems dangerous.
              // But we're only calling the problematic getter whose
              // hazards we think we understand.
              // @ts-expect-error TS should know FERAL_STACK_GETTER
              // cannot be `undefined` here.
              // See https://github.com/endojs/endo/pull/2232#discussion_r1575179471
              value: apply(FERAL_STACK_GETTER, obj, [])
            });
          }
        }
        return baseFreezeAndTraverse(obj);
      };
      const dequeue = () => {
        setForEach(toFreeze, freezeAndTraverse);
      };
      const markHardened = (value) => {
        weaksetAdd(hardened, value);
      };
      const commit = () => {
        setForEach(toFreeze, markHardened);
      };
      enqueue(root);
      dequeue();
      commit();
      return root;
    }
  };
  return harden2;
};

// node_modules/ses/src/cauterize-property.js
var cauterizeProperty = (obj, prop, known, subPath, { warn, error }) => {
  if (!known) {
    warn(`Removing ${subPath}`);
  }
  try {
    delete obj[prop];
  } catch (err) {
    const reason = (
      /** @type {string | object} */
      err
    );
    if (hasOwn(obj, prop)) {
      if (typeof obj === "function" && prop === "prototype") {
        obj.prototype = void 0;
        if (obj.prototype === void 0) {
          warn(`Tolerating undeletable ${subPath} === undefined`);
          return;
        }
      }
      error(`failed to delete ${subPath}`, reason);
    } else {
      error(`deleting ${subPath} threw`, reason);
    }
    throw err;
  }
};

// node_modules/ses/src/permits.js
var constantProperties = {
  // *** Value Properties of the Global Object
  Infinity: Infinity,
  NaN: NaN,
  undefined: void 0
};
var universalPropertyNames = {
  // *** Function Properties of the Global Object
  isFinite: "isFinite",
  isNaN: "isNaN",
  parseFloat: "parseFloat",
  parseInt: "parseInt",
  decodeURI: "decodeURI",
  decodeURIComponent: "decodeURIComponent",
  encodeURI: "encodeURI",
  encodeURIComponent: "encodeURIComponent",
  // *** Constructor Properties of the Global Object
  Array: "Array",
  ArrayBuffer: "ArrayBuffer",
  BigInt: "BigInt",
  BigInt64Array: "BigInt64Array",
  BigUint64Array: "BigUint64Array",
  Boolean: "Boolean",
  DataView: "DataView",
  EvalError: "EvalError",
  Int8Array: "Int8Array",
  Int16Array: "Int16Array",
  Int32Array: "Int32Array",
  Map: "Map",
  Number: "Number",
  Object: "Object",
  Promise: "Promise",
  Proxy: "Proxy",
  RangeError: "RangeError",
  ReferenceError: "ReferenceError",
  Set: "Set",
  String: "String",
  SyntaxError: "SyntaxError",
  TypeError: "TypeError",
  Uint8Array: "Uint8Array",
  Uint8ClampedArray: "Uint8ClampedArray",
  Uint16Array: "Uint16Array",
  Uint32Array: "Uint32Array",
  URIError: "URIError",
  WeakMap: "WeakMap",
  WeakSet: "WeakSet",
  // https://github.com/tc39/proposal-iterator-helpers
  Iterator: "Iterator",
  // https://github.com/tc39/proposal-async-iterator-helpers
  AsyncIterator: "AsyncIterator",
  // https://github.com/endojs/endo/issues/550
  AggregateError: "AggregateError",
  // https://github.com/tc39/proposal-explicit-resource-management
  // TODO DisposableStack, AsyncDisposableStack
  // DisposableStack: 'DisposableStack',
  // AsyncDisposableStack: 'AsyncDisposableStack',
  // https://tc39.es/proposal-shadowrealm/
  // TODO ShadowRealm
  // ShadowRealm: 'ShadowRealm',
  // *** Other Properties of the Global Object
  JSON: "JSON",
  Reflect: "Reflect",
  // WHATWG Encoding Standard
  // https://encoding.spec.whatwg.org/
  // TextEncoder and TextDecoder are pure transformations between string and
  // Uint8Array with no static side channels and no exposed iterator
  // prototype. They are permitted universally; on hosts that do not provide
  // them (XS), the sampling pass tolerates the absence.
  TextEncoder: "TextEncoder",
  TextDecoder: "TextDecoder",
  // *** Annex B
  escape: "escape",
  unescape: "unescape",
  // ESNext
  // https://github.com/tc39/proposal-source-phase-imports?tab=readme-ov-file#js-module-source
  ModuleSource: "ModuleSource",
  lockdown: "lockdown",
  harden: "harden",
  HandledPromise: "HandledPromise"
  // TODO: Until Promise.delegate (see below).
};
var initialGlobalPropertyNames = {
  // *** Constructor Properties of the Global Object
  Date: "%InitialDate%",
  Error: "%InitialError%",
  RegExp: "%InitialRegExp%",
  // Omit `Symbol`, because we want the original to appear on the
  // start compartment without passing through the permits mechanism, since
  // we want to preserve all its properties, even if we never heard of them.
  // Symbol: '%InitialSymbol%',
  // *** Other Properties of the Global Object
  Math: "%InitialMath%",
  Temporal: "%InitialTemporal%",
  // We move these from universalPropertyNames because the NaN side channel
  // means that they are not quite harmless.
  // We move them to initialGlobalPropertyNames so that they'll still be
  // included in the primordials, repaired, and hardened. Thus, they
  // can be endowed into compartments without hazard beyond the
  // NaN side channel.
  //
  // // https://github.com/tc39/proposal-float16array
  Float16Array: "Float16Array",
  Float32Array: "Float32Array",
  Float64Array: "Float64Array",
  // ESNext
  // From Error-stack proposal
  // Only on initial global. No corresponding
  // powerless form for other globals.
  getStackString: "%InitialGetStackString%"
  // TODO https://github.com/Agoric/SES-shim/issues/551
  // Need initial WeakRef and FinalizationGroup in
  // start compartment only.
  // TODO Temporal
  // https://github.com/tc39/proposal-temporal
  // Temporal: '%InitialTemporal%' // with Temporal.Now
};
var sharedGlobalPropertyNames = {
  // *** Constructor Properties of the Global Object
  Date: "%SharedDate%",
  Error: "%SharedError%",
  RegExp: "%SharedRegExp%",
  Symbol: "%SharedSymbol%",
  // *** Other Properties of the Global Object
  Math: "%SharedMath%",
  Temporal: "%SharedTemporal%"
  // TODO Temporal
  // https://github.com/tc39/proposal-temporal
  // Temporal: '%SharedTemporal%' // without Temporal.Now
};
var NativeErrors = [
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError
  // https://github.com/endojs/endo/issues/550
  // Commented out to accommodate platforms prior to AggregateError.
  // Instead, conditional push below.
  // AggregateError,
];
if (typeof AggregateError !== "undefined") {
  arrayPush(NativeErrors, AggregateError);
}
var FunctionInstance = {
  "[[Proto]]": "%FunctionPrototype%",
  length: "number",
  name: "string"
  // Do not specify "prototype" here, since only Function instances that can
  // be used as a constructor have a prototype property. For constructors,
  // since prototype properties are instance-specific, we define it there.
};
var AsyncFunctionInstance = {
  // This property is not mentioned in ECMA 262, but is present in V8 and
  // necessary for lockdown to succeed.
  "[[Proto]]": "%AsyncFunctionPrototype%"
};
var fn = FunctionInstance;
var asyncFn = AsyncFunctionInstance;
var getter = {
  get: fn,
  set: "undefined"
};
var accessor = {
  get: fn,
  set: fn
};
var strict = function() {
  "use strict";
};
arrayForEach(["caller", "arguments"], (prop) => {
  try {
    strict[prop];
  } catch (e) {
    if (
      /** @type {Error} */
      e.message === "Restricted in strict mode"
    ) {
      FunctionInstance[prop] = accessor;
    }
  }
});
var isAccessorPermit = (permit) => {
  return permit === getter || permit === accessor;
};
function NativeError(prototype) {
  return {
    // Properties of the NativeError Constructors
    "[[Proto]]": "%SharedError%",
    // NativeError.prototype
    prototype
  };
}
function NativeErrorPrototype(constructor) {
  return {
    // Properties of the NativeError Prototype Objects
    "[[Proto]]": "%ErrorPrototype%",
    constructor,
    message: "string",
    name: "string",
    // Redundantly present only on v8. Safe to remove.
    toString: false,
    // Superfluously present in some versions of V8.
    // https://github.com/tc39/notes/blob/master/meetings/2021-10/oct-26.md#:~:text=However%2C%20Chrome%2093,and%20node%2016.11.
    cause: false
  };
}
function TypedArray(prototype) {
  return {
    // Properties of the TypedArray Constructors
    "[[Proto]]": "%TypedArray%",
    BYTES_PER_ELEMENT: "number",
    prototype
  };
}
function TypedArrayPrototype(constructor) {
  return {
    // Properties of the TypedArray Prototype Objects
    "[[Proto]]": "%TypedArrayPrototype%",
    BYTES_PER_ELEMENT: "number",
    constructor
  };
}
var CommonMath = {
  E: "number",
  LN10: "number",
  LN2: "number",
  LOG10E: "number",
  LOG2E: "number",
  PI: "number",
  SQRT1_2: "number",
  SQRT2: "number",
  "@@toStringTag": "string",
  abs: fn,
  acos: fn,
  acosh: fn,
  asin: fn,
  asinh: fn,
  atan: fn,
  atanh: fn,
  atan2: fn,
  cbrt: fn,
  ceil: fn,
  clz32: fn,
  cos: fn,
  cosh: fn,
  exp: fn,
  expm1: fn,
  floor: fn,
  fround: fn,
  hypot: fn,
  imul: fn,
  log: fn,
  log1p: fn,
  log10: fn,
  log2: fn,
  max: fn,
  min: fn,
  pow: fn,
  round: fn,
  sign: fn,
  sin: fn,
  sinh: fn,
  sqrt: fn,
  tan: fn,
  tanh: fn,
  trunc: fn,
  // https://github.com/tc39/proposal-float16array
  f16round: fn,
  // https://github.com/tc39/proposal-math-sum
  sumPrecise: fn,
  // See https://github.com/Moddable-OpenSource/moddable/issues/523
  idiv: false,
  // See https://github.com/Moddable-OpenSource/moddable/issues/523
  idivmod: false,
  // See https://github.com/Moddable-OpenSource/moddable/issues/523
  imod: false,
  // See https://github.com/Moddable-OpenSource/moddable/issues/523
  imuldiv: false,
  // See https://github.com/Moddable-OpenSource/moddable/issues/523
  irem: false,
  // See https://github.com/Moddable-OpenSource/moddable/issues/523
  mod: false,
  // See https://github.com/Moddable-OpenSource/moddable/issues/523#issuecomment-1942904505
  irandom: false
};
var permitted = {
  // ECMA https://tc39.es/ecma262
  // The intrinsics object has no prototype to avoid conflicts.
  "[[Proto]]": null,
  // %ThrowTypeError%
  "%ThrowTypeError%": fn,
  // *** The Global Object
  // *** Value Properties of the Global Object
  Infinity: "number",
  NaN: "number",
  undefined: "undefined",
  // *** Function Properties of the Global Object
  // eval
  "%UniqueEval%": fn,
  isFinite: fn,
  isNaN: fn,
  parseFloat: fn,
  parseInt: fn,
  decodeURI: fn,
  decodeURIComponent: fn,
  encodeURI: fn,
  encodeURIComponent: fn,
  // *** Fundamental Objects
  Object: {
    // Properties of the Object Constructor
    "[[Proto]]": "%FunctionPrototype%",
    assign: fn,
    create: fn,
    defineProperties: fn,
    defineProperty: fn,
    entries: fn,
    freeze: fn,
    fromEntries: fn,
    getOwnPropertyDescriptor: fn,
    getOwnPropertyDescriptors: fn,
    getOwnPropertyNames: fn,
    getOwnPropertySymbols: fn,
    getPrototypeOf: fn,
    is: fn,
    isExtensible: fn,
    isFrozen: fn,
    isSealed: fn,
    keys: fn,
    preventExtensions: fn,
    prototype: "%ObjectPrototype%",
    seal: fn,
    setPrototypeOf: fn,
    values: fn,
    "RegisteredSymbol(harden)": {
      ...fn,
      // Installed with hardenTaming: 'unsafe'
      isFake: "boolean"
    },
    // https://github.com/tc39/proposal-accessible-object-hasownproperty
    hasOwn: fn,
    // https://github.com/tc39/proposal-array-grouping
    groupBy: fn,
    // Seen on QuickJS
    __getClass: false
  },
  "%ObjectPrototype%": {
    // Properties of the Object Prototype Object
    "[[Proto]]": null,
    constructor: "Object",
    hasOwnProperty: fn,
    isPrototypeOf: fn,
    propertyIsEnumerable: fn,
    toLocaleString: fn,
    toString: fn,
    valueOf: fn,
    // Annex B: Additional Properties of the Object.prototype Object
    // See note in header about the difference between [[Proto]] and --proto--
    // special notations.
    "--proto--": accessor,
    __defineGetter__: fn,
    __defineSetter__: fn,
    __lookupGetter__: fn,
    __lookupSetter__: fn
  },
  "%UniqueFunction%": {
    // Properties of the Function Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%FunctionPrototype%"
  },
  "%InertFunction%": {
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%FunctionPrototype%"
  },
  "%FunctionPrototype%": {
    apply: fn,
    bind: fn,
    call: fn,
    constructor: "%InertFunction%",
    toString: fn,
    "@@hasInstance": fn,
    // proposed but not yet std. To be removed if there
    caller: false,
    // proposed but not yet std. To be removed if there
    arguments: false,
    // Seen on QuickJS. TODO grab getter for use by console
    fileName: false,
    // Seen on QuickJS. TODO grab getter for use by console
    lineNumber: false
  },
  Boolean: {
    // Properties of the Boolean Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%BooleanPrototype%"
  },
  "%BooleanPrototype%": {
    constructor: "Boolean",
    toString: fn,
    valueOf: fn
  },
  "%SharedSymbol%": {
    // Properties of the Symbol Constructor
    "[[Proto]]": "%FunctionPrototype%",
    asyncIterator: "symbol",
    for: fn,
    hasInstance: "symbol",
    isConcatSpreadable: "symbol",
    iterator: "symbol",
    keyFor: fn,
    match: "symbol",
    matchAll: "symbol",
    prototype: "%SymbolPrototype%",
    replace: "symbol",
    search: "symbol",
    species: "symbol",
    split: "symbol",
    toPrimitive: "symbol",
    toStringTag: "symbol",
    unscopables: "symbol",
    // https://github.com/tc39/proposal-explicit-resource-management
    asyncDispose: "symbol",
    // https://github.com/tc39/proposal-explicit-resource-management
    dispose: "symbol",
    // Seen at core-js https://github.com/zloirock/core-js#ecmascript-symbol
    useSimple: false,
    // Seen at core-js https://github.com/zloirock/core-js#ecmascript-symbol
    useSetter: false,
    // Seen on QuickJS
    operatorSet: false
  },
  "%SymbolPrototype%": {
    // Properties of the Symbol Prototype Object
    constructor: "%SharedSymbol%",
    description: getter,
    toString: fn,
    valueOf: fn,
    "@@toPrimitive": fn,
    "@@toStringTag": "string"
  },
  "%InitialError%": {
    // Properties of the Error Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%ErrorPrototype%",
    // Non standard, v8 only, used by tap
    captureStackTrace: fn,
    // Non standard, v8 only, used by tap, tamed to accessor
    stackTraceLimit: accessor,
    // Non standard, v8 only, used by several, tamed to accessor
    prepareStackTrace: accessor,
    // https://github.com/tc39/proposal-is-error
    isError: fn
  },
  "%SharedError%": {
    // Properties of the Error Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%ErrorPrototype%",
    // Non standard, v8 only, used by tap
    captureStackTrace: fn,
    // Non standard, v8 only, used by tap, tamed to accessor
    stackTraceLimit: accessor,
    // Non standard, v8 only, used by several, tamed to accessor
    prepareStackTrace: accessor,
    // https://github.com/tc39/proposal-is-error
    isError: fn
  },
  "%ErrorPrototype%": {
    constructor: "%SharedError%",
    message: "string",
    name: "string",
    toString: fn,
    // proposed de-facto, assumed TODO
    // Seen on FF Nightly 88.0a1
    at: false,
    // Seen on FF and XS
    stack: accessor,
    // Superfluously present in some versions of V8.
    // https://github.com/tc39/notes/blob/master/meetings/2021-10/oct-26.md#:~:text=However%2C%20Chrome%2093,and%20node%2016.11.
    cause: false
  },
  // NativeError
  EvalError: NativeError("%EvalErrorPrototype%"),
  RangeError: NativeError("%RangeErrorPrototype%"),
  ReferenceError: NativeError("%ReferenceErrorPrototype%"),
  SyntaxError: NativeError("%SyntaxErrorPrototype%"),
  TypeError: NativeError("%TypeErrorPrototype%"),
  URIError: NativeError("%URIErrorPrototype%"),
  // https://github.com/endojs/endo/issues/550
  AggregateError: NativeError("%AggregateErrorPrototype%"),
  // TODO SuppressedError
  // https://github.com/tc39/proposal-explicit-resource-management
  // SuppressedError: NativeError('%SuppressedErrorPrototype%'),
  "%EvalErrorPrototype%": NativeErrorPrototype("EvalError"),
  "%RangeErrorPrototype%": NativeErrorPrototype("RangeError"),
  "%ReferenceErrorPrototype%": NativeErrorPrototype("ReferenceError"),
  "%SyntaxErrorPrototype%": NativeErrorPrototype("SyntaxError"),
  "%TypeErrorPrototype%": NativeErrorPrototype("TypeError"),
  "%URIErrorPrototype%": NativeErrorPrototype("URIError"),
  // https://github.com/endojs/endo/issues/550
  "%AggregateErrorPrototype%": NativeErrorPrototype("AggregateError"),
  // TODO AggregateError .errors
  // TODO SuppressedError
  // https://github.com/tc39/proposal-explicit-resource-management
  // '%SuppressedErrorPrototype%': NativeErrorPrototype('SuppressedError'),
  // TODO SuppressedError .error
  // TODO SuppressedError .suppressed
  // *** Numbers and Dates
  Number: {
    // Properties of the Number Constructor
    "[[Proto]]": "%FunctionPrototype%",
    EPSILON: "number",
    isFinite: fn,
    isInteger: fn,
    isNaN: fn,
    isSafeInteger: fn,
    MAX_SAFE_INTEGER: "number",
    MAX_VALUE: "number",
    MIN_SAFE_INTEGER: "number",
    MIN_VALUE: "number",
    NaN: "number",
    NEGATIVE_INFINITY: "number",
    parseFloat: fn,
    parseInt: fn,
    POSITIVE_INFINITY: "number",
    prototype: "%NumberPrototype%"
  },
  "%NumberPrototype%": {
    // Properties of the Number Prototype Object
    constructor: "Number",
    toExponential: fn,
    toFixed: fn,
    toLocaleString: fn,
    toPrecision: fn,
    toString: fn,
    valueOf: fn
  },
  BigInt: {
    // Properties of the BigInt Constructor
    "[[Proto]]": "%FunctionPrototype%",
    asIntN: fn,
    asUintN: fn,
    prototype: "%BigIntPrototype%",
    // See https://github.com/Moddable-OpenSource/moddable/issues/523
    bitLength: false,
    // See https://github.com/Moddable-OpenSource/moddable/issues/523
    fromArrayBuffer: false,
    // Seen on QuickJS
    tdiv: false,
    // Seen on QuickJS
    fdiv: false,
    // Seen on QuickJS
    cdiv: false,
    // Seen on QuickJS
    ediv: false,
    // Seen on QuickJS
    tdivrem: false,
    // Seen on QuickJS
    fdivrem: false,
    // Seen on QuickJS
    cdivrem: false,
    // Seen on QuickJS
    edivrem: false,
    // Seen on QuickJS
    sqrt: false,
    // Seen on QuickJS
    sqrtrem: false,
    // Seen on QuickJS
    floorLog2: false,
    // Seen on QuickJS
    ctz: false
  },
  "%BigIntPrototype%": {
    constructor: "BigInt",
    toLocaleString: fn,
    toString: fn,
    valueOf: fn,
    "@@toStringTag": "string"
  },
  "%InitialMath%": {
    ...CommonMath,
    // `%InitialMath%.random()` has the standard unsafe behavior
    random: fn
  },
  "%SharedMath%": {
    ...CommonMath,
    // `%SharedMath%.random()` is tamed to always throw
    random: fn
  },
  "%InitialDate%": {
    // Properties of the Date Constructor
    "[[Proto]]": "%FunctionPrototype%",
    now: fn,
    parse: fn,
    prototype: "%DatePrototype%",
    UTC: fn
  },
  "%SharedDate%": {
    // Properties of the Date Constructor
    "[[Proto]]": "%FunctionPrototype%",
    // `%SharedDate%.now()` is tamed to always throw
    now: fn,
    parse: fn,
    prototype: "%DatePrototype%",
    UTC: fn
  },
  "%DatePrototype%": {
    constructor: "%SharedDate%",
    getDate: fn,
    getDay: fn,
    getFullYear: fn,
    getHours: fn,
    getMilliseconds: fn,
    getMinutes: fn,
    getMonth: fn,
    getSeconds: fn,
    getTime: fn,
    getTimezoneOffset: fn,
    getUTCDate: fn,
    getUTCDay: fn,
    getUTCFullYear: fn,
    getUTCHours: fn,
    getUTCMilliseconds: fn,
    getUTCMinutes: fn,
    getUTCMonth: fn,
    getUTCSeconds: fn,
    setDate: fn,
    setFullYear: fn,
    setHours: fn,
    setMilliseconds: fn,
    setMinutes: fn,
    setMonth: fn,
    setSeconds: fn,
    setTime: fn,
    setUTCDate: fn,
    setUTCFullYear: fn,
    setUTCHours: fn,
    setUTCMilliseconds: fn,
    setUTCMinutes: fn,
    setUTCMonth: fn,
    setUTCSeconds: fn,
    toDateString: fn,
    toISOString: fn,
    toJSON: fn,
    toLocaleDateString: fn,
    toLocaleString: fn,
    toLocaleTimeString: fn,
    toString: fn,
    toTimeString: fn,
    toUTCString: fn,
    valueOf: fn,
    "@@toPrimitive": fn,
    // Annex B: Additional Properties of the Date.prototype Object
    getYear: fn,
    setYear: fn,
    toGMTString: fn,
    toTemporalInstant: fn
  },
  // Text Processing
  String: {
    // Properties of the String Constructor
    "[[Proto]]": "%FunctionPrototype%",
    fromCharCode: fn,
    fromCodePoint: fn,
    prototype: "%StringPrototype%",
    raw: fn,
    // See https://github.com/Moddable-OpenSource/moddable/issues/523
    fromArrayBuffer: false
  },
  "%StringPrototype%": {
    // Properties of the String Prototype Object
    length: "number",
    charAt: fn,
    charCodeAt: fn,
    codePointAt: fn,
    concat: fn,
    constructor: "String",
    endsWith: fn,
    includes: fn,
    indexOf: fn,
    lastIndexOf: fn,
    localeCompare: fn,
    match: fn,
    matchAll: fn,
    normalize: fn,
    padEnd: fn,
    padStart: fn,
    repeat: fn,
    replace: fn,
    replaceAll: fn,
    // ES2021
    search: fn,
    slice: fn,
    split: fn,
    startsWith: fn,
    substring: fn,
    toLocaleLowerCase: fn,
    toLocaleUpperCase: fn,
    toLowerCase: fn,
    toString: fn,
    toUpperCase: fn,
    trim: fn,
    trimEnd: fn,
    trimStart: fn,
    valueOf: fn,
    "@@iterator": fn,
    // Failed tc39 proposal
    // https://github.com/tc39/proposal-relative-indexing-method
    at: fn,
    // https://github.com/tc39/proposal-is-usv-string
    isWellFormed: fn,
    toWellFormed: fn,
    unicodeSets: fn,
    // Annex B: Additional Properties of the String.prototype Object
    substr: fn,
    anchor: fn,
    big: fn,
    blink: fn,
    bold: fn,
    fixed: fn,
    fontcolor: fn,
    fontsize: fn,
    italics: fn,
    link: fn,
    small: fn,
    strike: fn,
    sub: fn,
    sup: fn,
    trimLeft: fn,
    trimRight: fn,
    // See https://github.com/Moddable-OpenSource/moddable/issues/523
    compare: false,
    // Seen on QuickJS
    __quote: false
  },
  "%StringIteratorPrototype%": {
    "[[Proto]]": "%IteratorPrototype%",
    next: fn,
    "@@toStringTag": "string"
  },
  "%InitialRegExp%": {
    // Properties of the RegExp Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%RegExpPrototype%",
    "@@species": getter,
    // https://github.com/tc39/proposal-regex-escaping
    escape: fn,
    // The https://github.com/tc39/proposal-regexp-legacy-features
    // are all optional, unsafe, and omitted
    input: false,
    $_: false,
    lastMatch: false,
    "$&": false,
    lastParen: false,
    "$+": false,
    leftContext: false,
    "$`": false,
    rightContext: false,
    "$'": false,
    $1: false,
    $2: false,
    $3: false,
    $4: false,
    $5: false,
    $6: false,
    $7: false,
    $8: false,
    $9: false
  },
  "%SharedRegExp%": {
    // Properties of the RegExp Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%RegExpPrototype%",
    "@@species": getter,
    // https://github.com/tc39/proposal-regex-escaping
    escape: fn
  },
  "%RegExpPrototype%": {
    // Properties of the RegExp Prototype Object
    constructor: "%SharedRegExp%",
    exec: fn,
    dotAll: getter,
    flags: getter,
    global: getter,
    hasIndices: getter,
    ignoreCase: getter,
    "@@match": fn,
    "@@matchAll": fn,
    multiline: getter,
    "@@replace": fn,
    "@@search": fn,
    source: getter,
    "@@split": fn,
    sticky: getter,
    test: fn,
    toString: fn,
    unicode: getter,
    unicodeSets: getter,
    // Annex B: Additional Properties of the RegExp.prototype Object
    compile: false
    // UNSAFE and suppressed.
  },
  "%RegExpStringIteratorPrototype%": {
    // The %RegExpStringIteratorPrototype% Object
    "[[Proto]]": "%IteratorPrototype%",
    next: fn,
    "@@toStringTag": "string"
  },
  // Indexed Collections
  Array: {
    // Properties of the Array Constructor
    "[[Proto]]": "%FunctionPrototype%",
    from: fn,
    isArray: fn,
    of: fn,
    prototype: "%ArrayPrototype%",
    "@@species": getter,
    // Failed tc39 proposal
    // https://tc39.es/proposal-relative-indexing-method/
    at: fn,
    // https://tc39.es/proposal-array-from-async/
    fromAsync: fn
  },
  "%ArrayPrototype%": {
    // Properties of the Array Prototype Object
    length: "number",
    concat: fn,
    constructor: "Array",
    copyWithin: fn,
    entries: fn,
    every: fn,
    fill: fn,
    filter: fn,
    find: fn,
    findIndex: fn,
    flat: fn,
    flatMap: fn,
    forEach: fn,
    includes: fn,
    indexOf: fn,
    join: fn,
    keys: fn,
    lastIndexOf: fn,
    map: fn,
    pop: fn,
    push: fn,
    reduce: fn,
    reduceRight: fn,
    reverse: fn,
    shift: fn,
    slice: fn,
    some: fn,
    sort: fn,
    splice: fn,
    toLocaleString: fn,
    toString: fn,
    unshift: fn,
    values: fn,
    "@@iterator": fn,
    "@@unscopables": {
      "[[Proto]]": null,
      copyWithin: "boolean",
      entries: "boolean",
      fill: "boolean",
      find: "boolean",
      findIndex: "boolean",
      flat: "boolean",
      flatMap: "boolean",
      includes: "boolean",
      keys: "boolean",
      values: "boolean",
      // Failed tc39 proposal
      // https://tc39.es/proposal-relative-indexing-method/
      // Seen on FF Nightly 88.0a1
      at: "boolean",
      // See https://github.com/tc39/proposal-array-find-from-last
      findLast: "boolean",
      findLastIndex: "boolean",
      // https://github.com/tc39/proposal-change-array-by-copy
      toReversed: "boolean",
      toSorted: "boolean",
      toSpliced: "boolean",
      with: "boolean",
      // https://github.com/tc39/proposal-array-grouping
      group: "boolean",
      groupToMap: "boolean",
      groupBy: "boolean"
    },
    // See https://github.com/tc39/proposal-array-find-from-last
    findLast: fn,
    findLastIndex: fn,
    // https://github.com/tc39/proposal-change-array-by-copy
    toReversed: fn,
    toSorted: fn,
    toSpliced: fn,
    with: fn,
    // https://github.com/tc39/proposal-array-grouping
    group: fn,
    // Not in proposal? Where?
    groupToMap: fn,
    // Not in proposal? Where?
    groupBy: fn,
    // Failed tc39 proposal
    // https://tc39.es/proposal-relative-indexing-method/
    at: fn
  },
  "%ArrayIteratorPrototype%": {
    // The %ArrayIteratorPrototype% Object
    "[[Proto]]": "%IteratorPrototype%",
    next: fn,
    "@@toStringTag": "string"
  },
  // *** TypedArray Objects
  "%TypedArray%": {
    // Properties of the %TypedArray% Intrinsic Object
    "[[Proto]]": "%FunctionPrototype%",
    from: fn,
    of: fn,
    prototype: "%TypedArrayPrototype%",
    "@@species": getter
  },
  "%TypedArrayPrototype%": {
    buffer: getter,
    byteLength: getter,
    byteOffset: getter,
    constructor: "%TypedArray%",
    copyWithin: fn,
    entries: fn,
    every: fn,
    fill: fn,
    filter: fn,
    find: fn,
    findIndex: fn,
    forEach: fn,
    includes: fn,
    indexOf: fn,
    join: fn,
    keys: fn,
    lastIndexOf: fn,
    length: getter,
    map: fn,
    reduce: fn,
    reduceRight: fn,
    reverse: fn,
    set: fn,
    slice: fn,
    some: fn,
    sort: fn,
    subarray: fn,
    toLocaleString: fn,
    toString: fn,
    values: fn,
    "@@iterator": fn,
    "@@toStringTag": getter,
    // Failed tc39 proposal
    // https://tc39.es/proposal-relative-indexing-method/
    at: fn,
    // See https://github.com/tc39/proposal-array-find-from-last
    findLast: fn,
    findLastIndex: fn,
    // https://github.com/tc39/proposal-change-array-by-copy
    toReversed: fn,
    toSorted: fn,
    with: fn
  },
  // The TypedArray Constructors
  BigInt64Array: TypedArray("%BigInt64ArrayPrototype%"),
  BigUint64Array: TypedArray("%BigUint64ArrayPrototype%"),
  // https://github.com/tc39/proposal-float16array
  Float16Array: TypedArray("%Float16ArrayPrototype%"),
  Float32Array: TypedArray("%Float32ArrayPrototype%"),
  Float64Array: TypedArray("%Float64ArrayPrototype%"),
  Int16Array: TypedArray("%Int16ArrayPrototype%"),
  Int32Array: TypedArray("%Int32ArrayPrototype%"),
  Int8Array: TypedArray("%Int8ArrayPrototype%"),
  Uint16Array: TypedArray("%Uint16ArrayPrototype%"),
  Uint32Array: TypedArray("%Uint32ArrayPrototype%"),
  Uint8ClampedArray: TypedArray("%Uint8ClampedArrayPrototype%"),
  Uint8Array: {
    ...TypedArray("%Uint8ArrayPrototype%"),
    // https://github.com/tc39/proposal-arraybuffer-base64
    fromBase64: fn,
    // https://github.com/tc39/proposal-arraybuffer-base64
    fromHex: fn
  },
  "%BigInt64ArrayPrototype%": TypedArrayPrototype("BigInt64Array"),
  "%BigUint64ArrayPrototype%": TypedArrayPrototype("BigUint64Array"),
  // https://github.com/tc39/proposal-float16array
  "%Float16ArrayPrototype%": TypedArrayPrototype("Float16Array"),
  "%Float32ArrayPrototype%": TypedArrayPrototype("Float32Array"),
  "%Float64ArrayPrototype%": TypedArrayPrototype("Float64Array"),
  "%Int16ArrayPrototype%": TypedArrayPrototype("Int16Array"),
  "%Int32ArrayPrototype%": TypedArrayPrototype("Int32Array"),
  "%Int8ArrayPrototype%": TypedArrayPrototype("Int8Array"),
  "%Uint16ArrayPrototype%": TypedArrayPrototype("Uint16Array"),
  "%Uint32ArrayPrototype%": TypedArrayPrototype("Uint32Array"),
  "%Uint8ClampedArrayPrototype%": TypedArrayPrototype("Uint8ClampedArray"),
  "%Uint8ArrayPrototype%": {
    ...TypedArrayPrototype("Uint8Array"),
    // https://github.com/tc39/proposal-arraybuffer-base64
    setFromBase64: fn,
    // https://github.com/tc39/proposal-arraybuffer-base64
    setFromHex: fn,
    // https://github.com/tc39/proposal-arraybuffer-base64
    toBase64: fn,
    // https://github.com/tc39/proposal-arraybuffer-base64
    toHex: fn
  },
  // *** Keyed Collections
  Map: {
    // Properties of the Map Constructor
    "[[Proto]]": "%FunctionPrototype%",
    "@@species": getter,
    prototype: "%MapPrototype%",
    // https://github.com/tc39/proposal-array-grouping
    groupBy: fn
  },
  "%MapPrototype%": {
    clear: fn,
    constructor: "Map",
    delete: fn,
    entries: fn,
    forEach: fn,
    get: fn,
    getOrInsert: fn,
    getOrInsertComputed: fn,
    has: fn,
    keys: fn,
    set: fn,
    size: getter,
    values: fn,
    "@@iterator": fn,
    "@@toStringTag": "string"
  },
  "%MapIteratorPrototype%": {
    // The %MapIteratorPrototype% Object
    "[[Proto]]": "%IteratorPrototype%",
    next: fn,
    "@@toStringTag": "string"
  },
  Set: {
    // Properties of the Set Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%SetPrototype%",
    "@@species": getter,
    // Seen on QuickJS
    groupBy: false
  },
  "%SetPrototype%": {
    add: fn,
    clear: fn,
    constructor: "Set",
    delete: fn,
    entries: fn,
    forEach: fn,
    has: fn,
    keys: fn,
    size: getter,
    values: fn,
    "@@iterator": fn,
    "@@toStringTag": "string",
    // See https://github.com/tc39/proposal-set-methods
    intersection: fn,
    // See https://github.com/tc39/proposal-set-methods
    union: fn,
    // See https://github.com/tc39/proposal-set-methods
    difference: fn,
    // See https://github.com/tc39/proposal-set-methods
    symmetricDifference: fn,
    // See https://github.com/tc39/proposal-set-methods
    isSubsetOf: fn,
    // See https://github.com/tc39/proposal-set-methods
    isSupersetOf: fn,
    // See https://github.com/tc39/proposal-set-methods
    isDisjointFrom: fn
  },
  "%SetIteratorPrototype%": {
    // The %SetIteratorPrototype% Object
    "[[Proto]]": "%IteratorPrototype%",
    next: fn,
    "@@toStringTag": "string"
  },
  WeakMap: {
    // Properties of the WeakMap Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%WeakMapPrototype%"
  },
  "%WeakMapPrototype%": {
    constructor: "WeakMap",
    delete: fn,
    get: fn,
    getOrInsert: fn,
    getOrInsertComputed: fn,
    has: fn,
    set: fn,
    "@@toStringTag": "string"
  },
  WeakSet: {
    // Properties of the WeakSet Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%WeakSetPrototype%"
  },
  "%WeakSetPrototype%": {
    add: fn,
    constructor: "WeakSet",
    delete: fn,
    has: fn,
    "@@toStringTag": "string"
  },
  // *** Structured Data
  ArrayBuffer: {
    // Properties of the ArrayBuffer Constructor
    "[[Proto]]": "%FunctionPrototype%",
    isView: fn,
    prototype: "%ArrayBufferPrototype%",
    "@@species": getter,
    // See https://github.com/Moddable-OpenSource/moddable/issues/523
    fromString: false,
    // See https://github.com/Moddable-OpenSource/moddable/issues/523
    fromBigInt: false
  },
  "%ArrayBufferPrototype%": {
    byteLength: getter,
    constructor: "ArrayBuffer",
    slice: fn,
    "@@toStringTag": "string",
    // See https://github.com/Moddable-OpenSource/moddable/issues/523
    concat: false,
    // See https://github.com/tc39/proposal-resizablearraybuffer
    transfer: fn,
    resize: fn,
    resizable: getter,
    maxByteLength: getter,
    // https://github.com/tc39/proposal-arraybuffer-transfer
    transferToFixedLength: fn,
    detached: getter,
    // https://github.com/endojs/endo/pull/2309#issuecomment-2155513240
    // to be proposed
    transferToImmutable: fn,
    sliceToImmutable: fn,
    immutable: getter
  },
  // SharedArrayBuffer Objects
  SharedArrayBuffer: false,
  // UNSAFE and purposely suppressed.
  "%SharedArrayBufferPrototype%": false,
  // UNSAFE and purposely suppressed.
  DataView: {
    // Properties of the DataView Constructor
    "[[Proto]]": "%FunctionPrototype%",
    BYTES_PER_ELEMENT: "number",
    // Non std but undeletable on Safari.
    prototype: "%DataViewPrototype%"
  },
  "%DataViewPrototype%": {
    buffer: getter,
    byteLength: getter,
    byteOffset: getter,
    constructor: "DataView",
    getBigInt64: fn,
    getBigUint64: fn,
    // https://github.com/tc39/proposal-float16array
    getFloat16: fn,
    getFloat32: fn,
    getFloat64: fn,
    getInt8: fn,
    getInt16: fn,
    getInt32: fn,
    getUint8: fn,
    getUint16: fn,
    getUint32: fn,
    setBigInt64: fn,
    setBigUint64: fn,
    // https://github.com/tc39/proposal-float16array
    setFloat16: fn,
    setFloat32: fn,
    setFloat64: fn,
    setInt8: fn,
    setInt16: fn,
    setInt32: fn,
    setUint8: fn,
    setUint16: fn,
    setUint32: fn,
    "@@toStringTag": "string"
  },
  // Atomics
  Atomics: false,
  // UNSAFE and suppressed.
  JSON: {
    parse: fn,
    stringify: fn,
    "@@toStringTag": "string",
    // https://github.com/tc39/proposal-json-parse-with-source/
    rawJSON: fn,
    isRawJSON: fn
  },
  // *** Control Abstraction Objects
  // https://github.com/tc39/proposal-iterator-helpers
  Iterator: {
    // Properties of the Iterator Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%IteratorPrototype%",
    from: fn,
    // https://github.com/tc39/proposal-joint-iteration
    zip: fn,
    zipKeyed: fn,
    // https://github.com/tc39/proposal-iterator-sequencing
    concat: fn
  },
  "%IteratorPrototype%": {
    // The %IteratorPrototype% Object
    "@@iterator": fn,
    // https://github.com/tc39/proposal-iterator-helpers
    constructor: "Iterator",
    map: fn,
    filter: fn,
    take: fn,
    drop: fn,
    flatMap: fn,
    reduce: fn,
    toArray: fn,
    forEach: fn,
    some: fn,
    every: fn,
    find: fn,
    "@@toStringTag": "string",
    // https://github.com/tc39/proposal-async-iterator-helpers
    toAsync: fn,
    // https://github.com/tc39/proposal-explicit-resource-management
    // See https://github.com/Moddable-OpenSource/moddable/issues/523#issuecomment-1942904505
    "@@dispose": false
  },
  // https://github.com/tc39/proposal-iterator-helpers
  "%WrapForValidIteratorPrototype%": {
    "[[Proto]]": "%IteratorPrototype%",
    next: fn,
    return: fn
  },
  // https://github.com/tc39/proposal-iterator-helpers
  "%IteratorHelperPrototype%": {
    "[[Proto]]": "%IteratorPrototype%",
    next: fn,
    return: fn,
    "@@toStringTag": "string"
  },
  // https://github.com/tc39/proposal-async-iterator-helpers
  AsyncIterator: {
    // Properties of the Iterator Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%AsyncIteratorPrototype%",
    from: fn
  },
  "%AsyncIteratorPrototype%": {
    // The %AsyncIteratorPrototype% Object
    "@@asyncIterator": fn,
    // https://github.com/tc39/proposal-async-iterator-helpers
    constructor: "AsyncIterator",
    map: fn,
    filter: fn,
    take: fn,
    drop: fn,
    flatMap: fn,
    reduce: fn,
    toArray: fn,
    forEach: fn,
    some: fn,
    every: fn,
    find: fn,
    "@@toStringTag": "string",
    // https://github.com/tc39/proposal-explicit-resource-management
    // See https://github.com/Moddable-OpenSource/moddable/issues/523#issuecomment-1942904505
    "@@asyncDispose": false
  },
  // https://github.com/tc39/proposal-async-iterator-helpers
  "%WrapForValidAsyncIteratorPrototype%": {
    "[[Proto]]": "%AsyncIteratorPrototype%",
    next: fn,
    return: fn
  },
  // https://github.com/tc39/proposal-async-iterator-helpers
  "%AsyncIteratorHelperPrototype%": {
    "[[Proto]]": "%AsyncIteratorPrototype%",
    next: fn,
    return: fn,
    "@@toStringTag": "string"
  },
  "%InertGeneratorFunction%": {
    // Properties of the GeneratorFunction Constructor
    "[[Proto]]": "%InertFunction%",
    prototype: "%Generator%"
  },
  "%Generator%": {
    // Properties of the GeneratorFunction Prototype Object
    "[[Proto]]": "%FunctionPrototype%",
    constructor: "%InertGeneratorFunction%",
    prototype: "%GeneratorPrototype%",
    "@@toStringTag": "string"
  },
  "%InertAsyncGeneratorFunction%": {
    // Properties of the AsyncGeneratorFunction Constructor
    "[[Proto]]": "%InertFunction%",
    prototype: "%AsyncGenerator%"
  },
  "%AsyncGenerator%": {
    // Properties of the AsyncGeneratorFunction Prototype Object
    "[[Proto]]": "%FunctionPrototype%",
    constructor: "%InertAsyncGeneratorFunction%",
    prototype: "%AsyncGeneratorPrototype%",
    // length prop added here for React Native jsc-android
    // https://github.com/endojs/endo/issues/660
    // https://github.com/react-native-community/jsc-android-buildscripts/issues/181
    length: "number",
    "@@toStringTag": "string"
  },
  "%GeneratorPrototype%": {
    // Properties of the Generator Prototype Object
    "[[Proto]]": "%IteratorPrototype%",
    constructor: "%Generator%",
    next: fn,
    return: fn,
    throw: fn,
    "@@toStringTag": "string"
  },
  "%AsyncGeneratorPrototype%": {
    // Properties of the AsyncGenerator Prototype Object
    "[[Proto]]": "%AsyncIteratorPrototype%",
    constructor: "%AsyncGenerator%",
    next: fn,
    return: fn,
    throw: fn,
    "@@toStringTag": "string"
  },
  // TODO: To be replaced with Promise.delegate
  //
  // The HandledPromise global variable shimmed by `@agoric/eventual-send/shim`
  // implements an initial version of the eventual send specification at:
  // https://github.com/tc39/proposal-eventual-send
  //
  // We will likely change this to add a property to Promise called
  // Promise.delegate and put static methods on it, which will necessitate
  // another permits change to update to the current proposed standard.
  HandledPromise: {
    "[[Proto]]": "Promise",
    applyFunction: fn,
    applyFunctionSendOnly: fn,
    applyMethod: fn,
    applyMethodSendOnly: fn,
    get: fn,
    getSendOnly: fn,
    prototype: "%PromisePrototype%",
    resolve: fn
  },
  // https://github.com/tc39/proposal-source-phase-imports?tab=readme-ov-file#js-module-source
  ModuleSource: {
    "[[Proto]]": "%AbstractModuleSource%",
    prototype: "%ModuleSourcePrototype%"
  },
  "%ModuleSourcePrototype%": {
    "[[Proto]]": "%AbstractModuleSourcePrototype%",
    constructor: "ModuleSource",
    "@@toStringTag": "string",
    // https://github.com/tc39/proposal-compartments
    bindings: getter,
    needsImport: getter,
    needsImportMeta: getter,
    // @endo/module-source provides a legacy interface
    imports: getter,
    exports: getter,
    reexports: getter
  },
  "%AbstractModuleSource%": {
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%AbstractModuleSourcePrototype%"
  },
  "%AbstractModuleSourcePrototype%": {
    constructor: "%AbstractModuleSource%"
  },
  Promise: {
    // Properties of the Promise Constructor
    "[[Proto]]": "%FunctionPrototype%",
    all: fn,
    allSettled: fn,
    // https://github.com/Agoric/SES-shim/issues/550
    any: fn,
    prototype: "%PromisePrototype%",
    race: fn,
    reject: fn,
    resolve: fn,
    // https://github.com/tc39/proposal-promise-with-resolvers
    withResolvers: fn,
    "@@species": getter,
    // https://github.com/tc39/proposal-promise-try
    try: fn
  },
  "%PromisePrototype%": {
    // Properties of the Promise Prototype Object
    catch: fn,
    constructor: "Promise",
    finally: fn,
    then: fn,
    "@@toStringTag": "string",
    // Non-standard, used in node to prevent async_hooks from breaking
    "UniqueSymbol(async_id_symbol)": accessor,
    "UniqueSymbol(trigger_async_id_symbol)": accessor,
    "UniqueSymbol(destroyed)": accessor
  },
  "%InertAsyncFunction%": {
    // Properties of the AsyncFunction Constructor
    "[[Proto]]": "%InertFunction%",
    prototype: "%AsyncFunctionPrototype%"
  },
  "%AsyncFunctionPrototype%": {
    // Properties of the AsyncFunction Prototype Object
    "[[Proto]]": "%FunctionPrototype%",
    constructor: "%InertAsyncFunction%",
    // length prop added here for React Native jsc-android
    // https://github.com/endojs/endo/issues/660
    // https://github.com/react-native-community/jsc-android-buildscripts/issues/181
    length: "number",
    "@@toStringTag": "string"
  },
  // Reflection
  Reflect: {
    // The Reflect Object
    // Not a function object.
    apply: fn,
    construct: fn,
    defineProperty: fn,
    deleteProperty: fn,
    get: fn,
    getOwnPropertyDescriptor: fn,
    getPrototypeOf: fn,
    has: fn,
    isExtensible: fn,
    ownKeys: fn,
    preventExtensions: fn,
    set: fn,
    setPrototypeOf: fn,
    "@@toStringTag": "string"
  },
  Proxy: {
    // Properties of the Proxy Constructor
    "[[Proto]]": "%FunctionPrototype%",
    revocable: fn
  },
  "%Temporal.PlainDatePrototype%": {
    constructor: "%Temporal.PlainDate%",
    era: accessor,
    eraYear: accessor,
    calendarId: accessor,
    year: accessor,
    month: accessor,
    monthCode: accessor,
    day: accessor,
    dayOfWeek: accessor,
    dayOfYear: accessor,
    weekOfYear: accessor,
    yearOfWeek: accessor,
    daysInWeek: accessor,
    daysInMonth: accessor,
    daysInYear: accessor,
    monthsInYear: accessor,
    inLeapYear: accessor,
    toPlainYearMonth: fn,
    toPlainMonthDay: fn,
    add: fn,
    subtract: fn,
    with: fn,
    withCalendar: fn,
    until: fn,
    since: fn,
    equals: fn,
    toPlainDateTime: fn,
    toZonedDateTime: fn,
    toString: fn,
    toLocaleString: fn,
    toJSON: fn,
    valueOf: fn,
    "@@toStringTag": "string"
  },
  "%Temporal.PlainDate%": {
    "[[Proto]]": "%FunctionPrototype%",
    length: "number",
    name: "string",
    prototype: "%Temporal.PlainDatePrototype%",
    from: fn,
    compare: fn
  },
  "%Temporal.PlainTimePrototype%": {
    constructor: "%Temporal.PlainTime%",
    hour: accessor,
    minute: accessor,
    second: accessor,
    millisecond: accessor,
    microsecond: accessor,
    nanosecond: accessor,
    add: fn,
    subtract: fn,
    with: fn,
    until: fn,
    since: fn,
    round: fn,
    equals: fn,
    toLocaleString: fn,
    toString: fn,
    toJSON: fn,
    valueOf: fn,
    "@@toStringTag": "string"
  },
  "%Temporal.PlainTime%": {
    "[[Proto]]": "%FunctionPrototype%",
    length: "number",
    name: "string",
    prototype: "%Temporal.PlainTimePrototype%",
    from: fn,
    compare: fn
  },
  "%Temporal.PlainDateTimePrototype%": {
    constructor: "%Temporal.PlainDateTime%",
    calendarId: accessor,
    era: accessor,
    eraYear: accessor,
    year: accessor,
    month: accessor,
    monthCode: accessor,
    day: accessor,
    hour: accessor,
    minute: accessor,
    second: accessor,
    millisecond: accessor,
    microsecond: accessor,
    nanosecond: accessor,
    dayOfWeek: accessor,
    dayOfYear: accessor,
    weekOfYear: accessor,
    yearOfWeek: accessor,
    daysInWeek: accessor,
    daysInMonth: accessor,
    daysInYear: accessor,
    monthsInYear: accessor,
    inLeapYear: accessor,
    with: fn,
    withCalendar: fn,
    withPlainTime: fn,
    add: fn,
    subtract: fn,
    until: fn,
    since: fn,
    round: fn,
    equals: fn,
    toLocaleString: fn,
    toJSON: fn,
    toString: fn,
    valueOf: fn,
    toZonedDateTime: fn,
    toPlainDate: fn,
    toPlainTime: fn,
    "@@toStringTag": "string"
  },
  "%Temporal.PlainDateTime%": {
    "[[Proto]]": "%FunctionPrototype%",
    length: "number",
    name: "string",
    prototype: "%Temporal.PlainDateTimePrototype%",
    from: fn,
    compare: fn
  },
  "%Temporal.ZonedDateTimePrototype%": {
    constructor: "%Temporal.ZonedDateTime%",
    timeZoneId: accessor,
    calendarId: accessor,
    era: accessor,
    eraYear: accessor,
    year: accessor,
    month: accessor,
    monthCode: accessor,
    day: accessor,
    hour: accessor,
    minute: accessor,
    second: accessor,
    millisecond: accessor,
    microsecond: accessor,
    nanosecond: accessor,
    epochMilliseconds: accessor,
    epochNanoseconds: accessor,
    dayOfWeek: accessor,
    dayOfYear: accessor,
    weekOfYear: accessor,
    yearOfWeek: accessor,
    hoursInDay: accessor,
    daysInWeek: accessor,
    daysInMonth: accessor,
    daysInYear: accessor,
    monthsInYear: accessor,
    inLeapYear: accessor,
    offsetNanoseconds: accessor,
    offset: accessor,
    with: fn,
    withCalendar: fn,
    withPlainTime: fn,
    withTimeZone: fn,
    add: fn,
    subtract: fn,
    until: fn,
    since: fn,
    round: fn,
    equals: fn,
    toLocaleString: fn,
    toString: fn,
    toJSON: fn,
    valueOf: fn,
    startOfDay: fn,
    getTimeZoneTransition: fn,
    toInstant: fn,
    toPlainDate: fn,
    toPlainTime: fn,
    toPlainDateTime: fn,
    "@@toStringTag": "string"
  },
  "%Temporal.ZonedDateTime%": {
    "[[Proto]]": "%FunctionPrototype%",
    length: "number",
    name: "string",
    prototype: "%Temporal.ZonedDateTimePrototype%",
    from: fn,
    compare: fn
  },
  "%Temporal.DurationPrototype%": {
    constructor: "%Temporal.Duration%",
    years: accessor,
    months: accessor,
    weeks: accessor,
    days: accessor,
    hours: accessor,
    minutes: accessor,
    seconds: accessor,
    milliseconds: accessor,
    microseconds: accessor,
    nanoseconds: accessor,
    sign: accessor,
    blank: accessor,
    with: fn,
    negated: fn,
    abs: fn,
    add: fn,
    subtract: fn,
    round: fn,
    total: fn,
    toLocaleString: fn,
    toString: fn,
    toJSON: fn,
    valueOf: fn,
    "@@toStringTag": "string"
  },
  "%Temporal.Duration%": {
    "[[Proto]]": "%FunctionPrototype%",
    length: "number",
    name: "string",
    prototype: "%Temporal.DurationPrototype%",
    from: fn,
    compare: fn
  },
  "%Temporal.InstantPrototype%": {
    constructor: "%Temporal.Instant%",
    epochMilliseconds: accessor,
    epochNanoseconds: accessor,
    add: fn,
    subtract: fn,
    until: fn,
    since: fn,
    round: fn,
    equals: fn,
    toLocaleString: fn,
    toString: fn,
    toJSON: fn,
    valueOf: fn,
    toZonedDateTimeISO: fn,
    "@@toStringTag": "string"
  },
  "%Temporal.Instant%": {
    "[[Proto]]": "%FunctionPrototype%",
    length: "number",
    name: "string",
    prototype: "%Temporal.InstantPrototype%",
    from: fn,
    fromEpochMilliseconds: fn,
    fromEpochNanoseconds: fn,
    compare: fn
  },
  "%Temporal.PlainYearMonthPrototype%": {
    constructor: "%Temporal.PlainYearMonth%",
    calendarId: accessor,
    era: accessor,
    eraYear: accessor,
    year: accessor,
    month: accessor,
    monthCode: accessor,
    daysInYear: accessor,
    daysInMonth: accessor,
    monthsInYear: accessor,
    inLeapYear: accessor,
    with: fn,
    add: fn,
    subtract: fn,
    until: fn,
    since: fn,
    equals: fn,
    toLocaleString: fn,
    toString: fn,
    toJSON: fn,
    valueOf: fn,
    toPlainDate: fn,
    "@@toStringTag": "string"
  },
  "%Temporal.PlainYearMonth%": {
    "[[Proto]]": "%FunctionPrototype%",
    length: "number",
    name: "string",
    prototype: "%Temporal.PlainYearMonthPrototype%",
    from: fn,
    compare: fn
  },
  "%Temporal.PlainMonthDayPrototype%": {
    constructor: "%Temporal.PlainMonthDay%",
    calendarId: accessor,
    monthCode: accessor,
    day: accessor,
    with: fn,
    equals: fn,
    toLocaleString: fn,
    toString: fn,
    toJSON: fn,
    valueOf: fn,
    toPlainDate: fn,
    "@@toStringTag": "string"
  },
  "%Temporal.PlainMonthDay%": {
    "[[Proto]]": "%FunctionPrototype%",
    length: "number",
    name: "string",
    prototype: "%Temporal.PlainMonthDayPrototype%",
    from: fn
  },
  "%Temporal.Now%": {
    instant: fn,
    timeZoneId: fn,
    plainDateTimeISO: fn,
    zonedDateTimeISO: fn,
    plainDateISO: fn,
    plainTimeISO: fn,
    "@@toStringTag": "string"
  },
  "%InitialTemporal%": {
    Now: "%Temporal.Now%",
    PlainDate: "%Temporal.PlainDate%",
    PlainTime: "%Temporal.PlainTime%",
    PlainDateTime: "%Temporal.PlainDateTime%",
    ZonedDateTime: "%Temporal.ZonedDateTime%",
    Duration: "%Temporal.Duration%",
    Instant: "%Temporal.Instant%",
    PlainYearMonth: "%Temporal.PlainYearMonth%",
    PlainMonthDay: "%Temporal.PlainMonthDay%",
    "@@toStringTag": "string"
  },
  "%SharedTemporal%": {
    PlainDate: "%Temporal.PlainDate%",
    PlainTime: "%Temporal.PlainTime%",
    PlainDateTime: "%Temporal.PlainDateTime%",
    ZonedDateTime: "%Temporal.ZonedDateTime%",
    Duration: "%Temporal.Duration%",
    Instant: "%Temporal.Instant%",
    PlainYearMonth: "%Temporal.PlainYearMonth%",
    PlainMonthDay: "%Temporal.PlainMonthDay%",
    "@@toStringTag": "string"
  },
  // WHATWG Encoding Standard
  // https://encoding.spec.whatwg.org/
  TextEncoder: {
    // Properties of the TextEncoder Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%TextEncoderPrototype%"
  },
  "%TextEncoderPrototype%": {
    constructor: "TextEncoder",
    encode: fn,
    encodeInto: fn,
    encoding: getter,
    "@@toStringTag": "string",
    // Non-standard property used by Node.js
    "RegisteredSymbol(nodejs.util.inspect.custom)": false
  },
  TextDecoder: {
    // Properties of the TextDecoder Constructor
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%TextDecoderPrototype%"
  },
  "%TextDecoderPrototype%": {
    constructor: "TextDecoder",
    decode: fn,
    encoding: getter,
    fatal: getter,
    ignoreBOM: getter,
    "@@toStringTag": "string",
    // Non-standard property used by Node.js
    "RegisteredSymbol(nodejs.util.inspect.custom)": false
  },
  // Appendix B
  // Annex B: Additional Properties of the Global Object
  escape: fn,
  unescape: fn,
  // Proposed
  "%UniqueCompartment%": {
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%CompartmentPrototype%",
    toString: fn
  },
  "%InertCompartment%": {
    "[[Proto]]": "%FunctionPrototype%",
    prototype: "%CompartmentPrototype%",
    toString: fn
  },
  "%CompartmentPrototype%": {
    constructor: "%InertCompartment%",
    evaluate: fn,
    globalThis: getter,
    name: getter,
    import: asyncFn,
    load: asyncFn,
    importNow: fn,
    module: fn,
    __noNamespaceBox__: getter,
    "@@toStringTag": "string"
  },
  lockdown: fn,
  harden: { ...fn, isFake: "boolean" },
  "%InitialGetStackString%": fn
};

// node_modules/ses/src/intrinsics.js
var isFunction = (obj) => typeof obj === "function";
function initProperty(obj, name, desc) {
  if (hasOwn(obj, name)) {
    const preDesc = getOwnPropertyDescriptor(obj, name);
    if (!preDesc || !is(preDesc.value, desc.value) || preDesc.get !== desc.get || preDesc.set !== desc.set || preDesc.writable !== desc.writable || preDesc.enumerable !== desc.enumerable || preDesc.configurable !== desc.configurable) {
      throw TypeError2(`Conflicting definitions of ${name}`);
    }
  }
  defineProperty(obj, name, desc);
}
function initProperties(obj, descs) {
  for (const [name, desc] of entries(descs)) {
    initProperty(obj, name, desc);
  }
}
function sampleGlobals(globalObject, newPropertyNames) {
  const newIntrinsics = { __proto__: null };
  for (const [globalName, intrinsicName] of entries(newPropertyNames)) {
    if (hasOwn(globalObject, globalName)) {
      newIntrinsics[intrinsicName] = globalObject[globalName];
    }
  }
  return newIntrinsics;
}
var makeIntrinsicsCollector = (reporter) => {
  const intrinsics = create(null);
  let pseudoNatives;
  const addIntrinsics = (newIntrinsics) => {
    initProperties(intrinsics, getOwnPropertyDescriptors(newIntrinsics));
  };
  freeze(addIntrinsics);
  const completePrototypes = () => {
    for (const [name, intrinsic] of entries(intrinsics)) {
      if (isPrimitive(intrinsic)) {
        continue;
      }
      if (!hasOwn(intrinsic, "prototype")) {
        continue;
      }
      const permit = permitted[name];
      if (typeof permit !== "object") {
        throw TypeError2(`Expected permit object at permits.${name}`);
      }
      const namePrototype = permit.prototype;
      if (!namePrototype) {
        cauterizeProperty(
          intrinsic,
          "prototype",
          false,
          `${name}.prototype`,
          reporter
        );
        continue;
      }
      if (typeof namePrototype !== "string" || !hasOwn(permitted, namePrototype)) {
        throw TypeError2(`Unrecognized ${name}.prototype permits entry`);
      }
      const intrinsicPrototype = intrinsic.prototype;
      if (hasOwn(intrinsics, namePrototype)) {
        if (intrinsics[namePrototype] !== intrinsicPrototype) {
          throw TypeError2(`Conflicting bindings of ${namePrototype}`);
        }
        continue;
      }
      intrinsics[namePrototype] = intrinsicPrototype;
    }
  };
  freeze(completePrototypes);
  const finalIntrinsics = () => {
    freeze(intrinsics);
    pseudoNatives = new WeakSet2(arrayFilter(values(intrinsics), isFunction));
    return intrinsics;
  };
  freeze(finalIntrinsics);
  const isPseudoNative = (obj) => {
    if (!pseudoNatives) {
      throw TypeError2(
        "isPseudoNative can only be called after finalIntrinsics"
      );
    }
    return weaksetHas(pseudoNatives, obj);
  };
  freeze(isPseudoNative);
  const intrinsicsCollector = {
    addIntrinsics,
    completePrototypes,
    finalIntrinsics,
    isPseudoNative
  };
  freeze(intrinsicsCollector);
  addIntrinsics(constantProperties);
  addIntrinsics(sampleGlobals(universalThis, universalPropertyNames));
  return intrinsicsCollector;
};
var getGlobalIntrinsics = (globalObject, reporter) => {
  const { addIntrinsics, finalIntrinsics } = makeIntrinsicsCollector(reporter);
  addIntrinsics(sampleGlobals(globalObject, sharedGlobalPropertyNames));
  return finalIntrinsics();
};

// node_modules/ses/src/permits-intrinsics.js
function removeUnpermittedIntrinsics(intrinsics, markVirtualizedNativeFunction3, reporter) {
  const primitives = ["undefined", "boolean", "number", "string", "symbol"];
  const wellKnownSymbolNames = new Map2(
    Symbol2 ? arrayMap(
      arrayFilter(
        entries(permitted["%SharedSymbol%"]),
        ([name, permit]) => permit === "symbol" && typeof Symbol2[name] === "symbol"
      ),
      ([name]) => [Symbol2[name], `@@${name}`]
    ) : []
  );
  function asStringPropertyName(path, prop) {
    if (typeof prop === "string") {
      return prop;
    }
    const wellKnownSymbol = mapGet(wellKnownSymbolNames, prop);
    if (typeof prop === "symbol") {
      if (wellKnownSymbol) {
        return wellKnownSymbol;
      } else {
        const registeredKey = symbolKeyFor(prop);
        if (registeredKey !== void 0) {
          return `RegisteredSymbol(${registeredKey})`;
        } else {
          return `Unique${String2(prop)}`;
        }
      }
    }
    throw TypeError2(`Unexpected property name type ${path} ${prop}`);
  }
  function visitPrototype(path, obj, protoName) {
    if (isPrimitive(obj)) {
      throw TypeError2(`Object expected: ${path}, ${String2(obj)}, ${protoName}`);
    }
    const proto = getPrototypeOf(obj);
    if (proto === null && protoName === null) {
      return;
    }
    if (protoName !== void 0 && typeof protoName !== "string") {
      throw TypeError2(`Malformed permit ${path}.__proto__`);
    }
    if (proto === intrinsics[protoName || "%ObjectPrototype%"]) {
      return;
    }
    throw TypeError2(
      `Unexpected [[Prototype]] at ${path}.__proto__ (expected ${protoName || "%ObjectPrototype%"})`
    );
  }
  function isAllowedPropertyValue(path, value, prop, permit) {
    if (typeof permit === "object") {
      visitProperties(path, value, permit);
      return true;
    }
    if (permit === false) {
      return false;
    }
    if (typeof permit === "string") {
      if (arrayIncludes(primitives, permit)) {
        if (prop === "prototype" || prop === "constructor") {
          throw new TypeError2(`At ${path} expected intrinsic, not ${permit}`);
        }
        if (typeof value !== permit) {
          throw TypeError2(`At ${path} expected ${permit} not ${typeof value}`);
        }
        return true;
      }
      if (hasOwn(intrinsics, permit)) {
        if (value !== intrinsics[permit]) {
          throw TypeError2(`Does not match permit for ${path}`);
        }
        return true;
      }
    }
    throw TypeError2(
      `Unexpected property ${prop} with permit ${permit} at ${path}`
    );
  }
  function isAllowedProperty(path, obj, prop, permit) {
    const desc = getOwnPropertyDescriptor(obj, prop);
    if (!desc) {
      throw TypeError2(`Property ${prop} not found at ${path}`);
    }
    if (hasOwn(desc, "value")) {
      if (isAccessorPermit(permit)) {
        throw TypeError2(`Accessor expected at ${path}`);
      }
      return isAllowedPropertyValue(path, desc.value, prop, permit);
    }
    if (!isAccessorPermit(permit)) {
      throw TypeError2(`Accessor not expected at ${path}`);
    }
    return isAllowedPropertyValue(`${path}<get>`, desc.get, prop, permit.get) && isAllowedPropertyValue(`${path}<set>`, desc.set, prop, permit.set);
  }
  function getSubPermit(obj, permit, prop) {
    const permitProp = prop === "__proto__" ? "--proto--" : prop;
    if (hasOwn(permit, permitProp)) {
      return permit[permitProp];
    }
    if (typeof obj === "function") {
      if (hasOwn(FunctionInstance, permitProp)) {
        return FunctionInstance[permitProp];
      }
    }
    return void 0;
  }
  function visitProperties(path, obj, permit) {
    if (obj === void 0 || obj === null) {
      return;
    }
    const protoName = permit["[[Proto]]"];
    visitPrototype(path, obj, protoName);
    if (typeof obj === "function") {
      markVirtualizedNativeFunction3(obj);
    }
    for (const prop of ownKeys(obj)) {
      const propString = asStringPropertyName(path, prop);
      const subPath = `${path}.${propString}`;
      const subPermit = getSubPermit(obj, permit, propString);
      if (!subPermit || !isAllowedProperty(subPath, obj, prop, subPermit)) {
        cauterizeProperty(obj, prop, subPermit === false, subPath, reporter);
      }
    }
  }
  visitProperties("intrinsics", intrinsics, permitted);
}

// node_modules/ses/src/tame-function-constructors.js
function tameFunctionConstructors() {
  try {
    FERAL_FUNCTION.prototype.constructor("return 1");
  } catch (_err) {
    return freeze({});
  }
  const newIntrinsics = {};
  function repairFunction(name, intrinsicName, declaration) {
    let FunctionInstance2;
    try {
      FunctionInstance2 = (0, eval)(declaration);
    } catch (e) {
      if (e instanceof SyntaxError2) {
        return;
      }
      throw e;
    }
    const FunctionPrototype = getPrototypeOf(FunctionInstance2);
    const InertConstructor = function() {
      throw TypeError2(
        "Function.prototype.constructor is not a valid constructor."
      );
    };
    defineProperties(InertConstructor, {
      prototype: { value: FunctionPrototype },
      name: {
        value: name,
        writable: false,
        enumerable: false,
        configurable: true
      }
    });
    defineProperties(FunctionPrototype, {
      constructor: { value: InertConstructor }
    });
    if (InertConstructor !== FERAL_FUNCTION.prototype.constructor) {
      setPrototypeOf(InertConstructor, FERAL_FUNCTION.prototype.constructor);
    }
    newIntrinsics[intrinsicName] = InertConstructor;
  }
  repairFunction("Function", "%InertFunction%", "(function(){})");
  repairFunction(
    "GeneratorFunction",
    "%InertGeneratorFunction%",
    "(function*(){})"
  );
  repairFunction(
    "AsyncFunction",
    "%InertAsyncFunction%",
    "(async function(){})"
  );
  if (AsyncGeneratorFunctionInstance !== void 0) {
    repairFunction(
      "AsyncGeneratorFunction",
      "%InertAsyncGeneratorFunction%",
      "(async function*(){})"
    );
  }
  return newIntrinsics;
}

// node_modules/ses/src/tame-date-constructor.js
function tameDateConstructor() {
  const OriginalDate = Date;
  const DatePrototype = OriginalDate.prototype;
  const tamedMethods3 = {
    /**
     * `%SharedDate%.now()` throw a `TypeError` starting with "secure mode".
     * See https://github.com/endojs/endo/issues/910#issuecomment-1581855420
     */
    now() {
      throw TypeError2("secure mode Calling %SharedDate%.now() throws");
    }
  };
  const makeDateConstructor = ({ powers = "none" } = {}) => {
    let ResultDate;
    if (powers === "original") {
      ResultDate = function Date2(...rest) {
        if (new.target === void 0) {
          return apply(OriginalDate, void 0, rest);
        }
        return construct(OriginalDate, rest, new.target);
      };
    } else {
      ResultDate = function Date2(...rest) {
        if (new.target === void 0) {
          throw TypeError2(
            "secure mode Calling %SharedDate% constructor as a function throws"
          );
        }
        if (rest.length === 0) {
          throw TypeError2(
            "secure mode Calling new %SharedDate%() with no arguments throws"
          );
        }
        return construct(OriginalDate, rest, new.target);
      };
    }
    defineProperties(ResultDate, {
      length: { value: 7 },
      prototype: {
        value: DatePrototype,
        writable: false,
        enumerable: false,
        configurable: false
      },
      parse: {
        value: OriginalDate.parse,
        writable: true,
        enumerable: false,
        configurable: true
      },
      UTC: {
        value: OriginalDate.UTC,
        writable: true,
        enumerable: false,
        configurable: true
      }
    });
    return ResultDate;
  };
  const InitialDate = makeDateConstructor({ powers: "original" });
  const SharedDate = makeDateConstructor({ powers: "none" });
  defineProperties(InitialDate, {
    now: {
      value: OriginalDate.now,
      writable: true,
      enumerable: false,
      configurable: true
    }
  });
  defineProperties(SharedDate, {
    now: {
      value: tamedMethods3.now,
      writable: true,
      enumerable: false,
      configurable: true
    }
  });
  defineProperties(DatePrototype, {
    constructor: { value: SharedDate }
  });
  return {
    "%InitialDate%": InitialDate,
    "%SharedDate%": SharedDate
  };
}

// node_modules/ses/src/tame-math-object.js
function tameMathObject() {
  const originalMath = Math2;
  const initialMath = originalMath;
  const { random: _, ...otherDescriptors } = getOwnPropertyDescriptors(originalMath);
  const tamedMethods3 = {
    /**
     * `%SharedMath%.random()` throws a TypeError starting with "secure mode".
     * See https://github.com/endojs/endo/issues/910#issuecomment-1581855420
     */
    random() {
      throw TypeError2("secure mode %SharedMath%.random() throws");
    }
  };
  const sharedMath = create(objectPrototype, {
    ...otherDescriptors,
    random: {
      value: tamedMethods3.random,
      writable: true,
      enumerable: false,
      configurable: true
    }
  });
  return {
    "%InitialMath%": initialMath,
    "%SharedMath%": sharedMath
  };
}

// node_modules/ses/src/tame-temporal-object.js
var tameTemporalObject = () => {
  if (Temporal === void 0) {
    return {};
  }
  if (typeof Temporal !== "object") {
    throw new TypeError2(`unexpected typeof Temporal: ${typeof Temporal}`);
  }
  if (getPrototypeOf(Temporal) !== objectPrototype) {
    throw new TypeError2(
      `unexpected Temporal __proto__: ${getPrototypeOf(Temporal)}`
    );
  }
  const initialTemporal = Temporal;
  const { Now: _, ...otherDescriptors } = getOwnPropertyDescriptors(initialTemporal);
  const sharedTemporal = create(objectPrototype, otherDescriptors);
  const initialTemporalPermit = permitted["%InitialTemporal%"];
  const intrinsicEntries = [];
  for (const topName of ownKeys(Temporal)) {
    const topPermitName = initialTemporalPermit[topName];
    const topPermit = permitted[topPermitName];
    if (typeof topPermit === "object") {
      const topVal = initialTemporal[topName];
      arrayPush(intrinsicEntries, [topPermitName, topVal]);
    }
  }
  const result = {
    ...fromEntries(intrinsicEntries),
    "%InitialTemporal%": initialTemporal,
    "%SharedTemporal%": sharedTemporal
  };
  return result;
};
freeze(tameTemporalObject);
var tame_temporal_object_default = tameTemporalObject;

// node_modules/ses/src/tame-nan-sidechannel.js
var {
  setFloat16: FERAL_SET_FLOAT16,
  setFloat32: FERAL_SET_FLOAT32,
  setFloat64: FERAL_SET_FLOAT64,
  setUint16,
  setUint32,
  setBigUint64
} = dataViewPrototype;
var dataViewGetBuffer = uncurryThis(
  // @ts-expect-error we know it is there on all conforming platforms
  getOwnPropertyDescriptor(dataViewPrototype, "buffer").get
);
var canonicalNaN64Encoding = 0x7ff8000000000000n;
var canonicalNaN32Encoding = 2143289344;
var canonicalNaN16Encoding = 32256;
var requireDataView = (obj) => {
  dataViewGetBuffer(obj);
};
var toIndex = (v) => {
  const n = trunc(v);
  if (n === 0 || is(n, NaN)) {
    return 0;
  }
  if (n < 0 || n > MAX_SAFE_INTEGER) {
    throw RangeError2("Invalid offset");
  }
  return n;
};
var toNumber = (v) => (
  // @ts-expect-error Math.max uses the internal `ToNumber` to coerce its
  // argument, whatever it is, to a number.
  max(v)
);
var methods = {
  /**
   * @param {number} byteOffset
   * @param {number} value
   * @param {boolean} [isLittleEndian]
   */
  setFloat16(byteOffset, value, isLittleEndian = void 0) {
    requireDataView(this);
    byteOffset = toIndex(byteOffset);
    value = toNumber(value);
    if (is(value, NaN)) {
      return apply(setUint16, this, [
        byteOffset,
        canonicalNaN16Encoding,
        isLittleEndian
      ]);
    } else {
      return apply(FERAL_SET_FLOAT16, this, [
        byteOffset,
        value,
        isLittleEndian
      ]);
    }
  },
  /**
   * @param {number} byteOffset
   * @param {number} value
   * @param {boolean} [isLittleEndian]
   */
  setFloat32(byteOffset, value, isLittleEndian = void 0) {
    requireDataView(this);
    byteOffset = toIndex(byteOffset);
    value = toNumber(value);
    if (is(value, NaN)) {
      return apply(setUint32, this, [
        byteOffset,
        canonicalNaN32Encoding,
        isLittleEndian
      ]);
    } else {
      return apply(FERAL_SET_FLOAT32, this, [
        byteOffset,
        value,
        isLittleEndian
      ]);
    }
  },
  /**
   * @param {number} byteOffset
   * @param {number} value
   * @param {boolean} [isLittleEndian]
   */
  setFloat64(byteOffset, value, isLittleEndian = void 0) {
    requireDataView(this);
    byteOffset = toIndex(byteOffset);
    value = toNumber(value);
    if (is(value, NaN)) {
      return apply(setBigUint64, this, [
        byteOffset,
        canonicalNaN64Encoding,
        isLittleEndian
      ]);
    } else {
      return apply(FERAL_SET_FLOAT64, this, [
        byteOffset,
        value,
        isLittleEndian
      ]);
    }
  }
};
var tameNaNSideChannel = () => {
  for (const [name, method] of entries(methods)) {
    if (hasOwn(dataViewPrototype, name)) {
      defineProperty(dataViewPrototype, name, {
        // Since we're redefining properties that already exist, by omitting the
        // other descriptor attributes here, they are unchanged.
        value: method
      });
    }
  }
};

// node_modules/ses/src/tame-regexp-constructor.js
function tameRegExpConstructor(regExpTaming = "safe") {
  const RegExpPrototype = FERAL_REG_EXP.prototype;
  const makeRegExpConstructor = (_ = {}) => {
    const ResultRegExp = function RegExp2(...rest) {
      if (new.target === void 0) {
        return FERAL_REG_EXP(...rest);
      }
      return construct(FERAL_REG_EXP, rest, new.target);
    };
    defineProperties(ResultRegExp, {
      length: { value: 2 },
      prototype: {
        value: RegExpPrototype,
        writable: false,
        enumerable: false,
        configurable: false
      }
    });
    if (speciesSymbol) {
      const speciesDesc = getOwnPropertyDescriptor(
        FERAL_REG_EXP,
        speciesSymbol
      );
      if (!speciesDesc) {
        throw TypeError2("no RegExp[Symbol.species] descriptor");
      }
      defineProperties(ResultRegExp, {
        [speciesSymbol]: speciesDesc
      });
    }
    return ResultRegExp;
  };
  const InitialRegExp = makeRegExpConstructor();
  const SharedRegExp = makeRegExpConstructor();
  if (regExpTaming !== "unsafe") {
    delete RegExpPrototype.compile;
  }
  defineProperties(RegExpPrototype, {
    constructor: { value: SharedRegExp }
  });
  return {
    "%InitialRegExp%": InitialRegExp,
    "%SharedRegExp%": SharedRegExp
  };
}

// node_modules/ses/src/enablements.js
var minEnablements = {
  "%ObjectPrototype%": {
    toString: true
  },
  "%FunctionPrototype%": {
    toString: true
    // set by "rollup"
  },
  "%ErrorPrototype%": {
    name: true
    // set by "precond", "ava", "node-fetch"
  },
  "%IteratorPrototype%": {
    toString: true,
    // https://github.com/tc39/proposal-iterator-helpers
    constructor: true,
    // https://github.com/tc39/proposal-iterator-helpers
    [toStringTagSymbol]: true
  }
};
var moderateEnablements = {
  ...minEnablements,
  "%ObjectPrototype%": {
    ...minEnablements["%ObjectPrototype%"],
    valueOf: true
  },
  // Function.prototype has no 'prototype' property to enable.
  // Function instances have their own 'name' and 'length' properties
  // which are configurable and non-writable. Thus, they are already
  // non-assignable anyway.
  "%FunctionPrototype%": {
    ...minEnablements["%FunctionPrototype%"],
    constructor: true,
    // set by "regenerator-runtime"
    bind: true
    // set by "underscore", "express"
  },
  "%ErrorPrototype%": {
    ...minEnablements["%ErrorPrototype%"],
    constructor: true,
    // set by "fast-json-patch", "node-fetch"
    message: true,
    toString: true
    // set by "bluebird"
  },
  "%IteratorPrototype%": {
    ...minEnablements["%IteratorPrototype%"],
    [iteratorSymbol]: true
    // is sometimes used in custom iterators and generators implementations eg. @rive-app/canvas
  },
  "%ArrayPrototype%": {
    toString: true,
    push: true,
    // set by "Google Analytics"
    concat: true,
    // set by mobx generated code (old TS compiler?)
    [iteratorSymbol]: true
    // set by mobx generated code (old TS compiler?)
  },
  "%TypeErrorPrototype%": {
    constructor: true,
    // set by "readable-stream"
    message: true,
    // set by "tape"
    name: true
    // set by "readable-stream", "node 14"
  },
  "%SyntaxErrorPrototype%": {
    message: true,
    // to match TypeErrorPrototype.message
    name: true
    // set by "node 14"
  },
  "%RangeErrorPrototype%": {
    message: true,
    // to match TypeErrorPrototype.message
    name: true
    // set by "node 14"
  },
  "%URIErrorPrototype%": {
    message: true,
    // to match TypeErrorPrototype.message
    name: true
    // set by "node 14"
  },
  "%EvalErrorPrototype%": {
    message: true,
    // to match TypeErrorPrototype.message
    name: true
    // set by "node 14"
  },
  "%ReferenceErrorPrototype%": {
    message: true,
    // to match TypeErrorPrototype.message
    name: true
    // set by "node 14"
  },
  // https://github.com/endojs/endo/issues/550
  "%AggregateErrorPrototype%": {
    message: true,
    // to match TypeErrorPrototype.message
    name: true
    // set by "node 14"?
  },
  "%PromisePrototype%": {
    constructor: true
    // set by "core-js"
  },
  "%TypedArrayPrototype%": "*",
  // set by https://github.com/feross/buffer
  "%Generator%": {
    constructor: true,
    name: true,
    toString: true
  }
};
var severeEnablements = {
  ...moderateEnablements,
  /**
   * Rollup (as used at least by vega) and webpack
   * (as used at least by regenerator) both turn exports into assignments
   * to a big `exports` object that inherits directly from
   * `Object.prototype`. Some of the exported names we've seen include
   * `hasOwnProperty`, `constructor`, and `toString`. But the strategy used
   * by rollup and webpack potentionally turns any exported name
   * into an assignment rejected by the override mistake. That's why
   * the `severe` enablements takes the extreme step of enabling
   * everything on `Object.prototype`.
   *
   * In addition, code doing inheritance manually will often override
   * the `constructor` property on the new prototype by assignment. We've
   * seen this several times.
   *
   * The cost of enabling all these is that they create a miserable debugging
   * experience specifically on Node.
   * https://github.com/Agoric/agoric-sdk/issues/2324
   * explains how it confused the Node console.
   *
   * (TODO Reexamine the vscode situation. I think it may have improved
   * since the following paragraph was written.)
   *
   * The vscode debugger's object inspector shows the own data properties of
   * an object, which is typically what you want, but also shows both getter
   * and setter for every accessor property whether inherited or own.
   * With the `'*'` setting here, all the properties inherited from
   * `Object.prototype` are accessors, creating an unusable display as seen
   * at As explained at
   * https://github.com/endojs/endo/blob/master/packages/ses/docs/lockdown.md#overridetaming-options
   * Open the triangles at the bottom of that section.
   */
  "%ObjectPrototype%": "*",
  /**
   * The widely used Buffer defined at https://github.com/feross/buffer
   * on initialization, manually creates the equivalent of a subclass of
   * `TypedArray`, which it then initializes by assignment. These assignments
   * include enough of the `TypeArray` methods that here, the `severe`
   * enablements just enable them all.
   */
  "%TypedArrayPrototype%": "*",
  /**
   * Needed to work with Immer before https://github.com/immerjs/immer/pull/914
   * is accepted.
   */
  "%MapPrototype%": "*",
  /**
   * Needed to work with Immer before https://github.com/immerjs/immer/pull/914
   * is accepted.
   */
  "%SetPrototype%": "*"
};

// node_modules/ses/src/enable-property-overrides.js
function enablePropertyOverrides(intrinsics, overrideTaming, { warn }, overrideDebug = []) {
  const debugProperties = new Set2(overrideDebug);
  function enable(path, obj, prop, desc) {
    if ("value" in desc && desc.configurable) {
      const { value } = desc;
      const isDebug = setHas(debugProperties, prop);
      const { get: getter2, set: setter } = getOwnPropertyDescriptor(
        {
          get [prop]() {
            return value;
          },
          set [prop](newValue) {
            if (obj === this) {
              throw TypeError2(
                `Cannot assign to read only property '${String2(
                  prop
                )}' of '${path}'`
              );
            }
            if (hasOwn(this, prop)) {
              this[prop] = newValue;
            } else {
              if (isDebug) {
                warn(TypeError2(`Override property ${prop}`));
              }
              defineProperty(this, prop, {
                value: newValue,
                writable: true,
                enumerable: true,
                configurable: true
              });
            }
          }
        },
        prop
      );
      defineProperty(getter2, "originalValue", {
        value,
        writable: false,
        enumerable: false,
        configurable: false
      });
      defineProperty(obj, prop, {
        get: getter2,
        set: setter,
        enumerable: desc.enumerable,
        configurable: desc.configurable
      });
    }
  }
  function enableProperty(path, obj, prop) {
    const desc = getOwnPropertyDescriptor(obj, prop);
    if (!desc) {
      return;
    }
    enable(path, obj, prop, desc);
  }
  function enableAllProperties(path, obj) {
    const descs = getOwnPropertyDescriptors(obj);
    if (!descs) {
      return;
    }
    arrayForEach(ownKeys(descs), (prop) => enable(path, obj, prop, descs[prop]));
  }
  function enableProperties(path, obj, plan2) {
    for (const prop of ownKeys(plan2)) {
      const desc = getOwnPropertyDescriptor(obj, prop);
      if (!desc || desc.get || desc.set) {
        continue;
      }
      const subPath = `${path}.${String2(prop)}`;
      const subPlan = plan2[prop];
      if (subPlan === true) {
        enableProperty(subPath, obj, prop);
      } else if (subPlan === "*") {
        enableAllProperties(subPath, desc.value);
      } else if (!isPrimitive(subPlan)) {
        enableProperties(subPath, desc.value, subPlan);
      } else {
        throw TypeError2(`Unexpected override enablement plan ${subPath}`);
      }
    }
  }
  let plan;
  switch (overrideTaming) {
    case "min": {
      plan = minEnablements;
      break;
    }
    case "moderate": {
      plan = moderateEnablements;
      break;
    }
    case "severe": {
      plan = severeEnablements;
      break;
    }
    default: {
      throw TypeError2(`unrecognized overrideTaming ${overrideTaming}`);
    }
  }
  enableProperties("root", intrinsics, plan);
}

// node_modules/ses/src/tame-locale-methods.js
var { Fail: Fail2, quote: q2 } = assert;
var localePattern = freezeRegexp(/^(\w*[a-z])Locale([A-Z]\w*)$/);
var tamedMethods = {
  // See https://tc39.es/ecma262/#sec-string.prototype.localecompare
  localeCompare(arg) {
    if (this === null || this === void 0) {
      throw TypeError2(
        'Cannot localeCompare with null or undefined "this" value'
      );
    }
    const s = `${this}`;
    const that = `${arg}`;
    if (s < that) {
      return -1;
    }
    if (s > that) {
      return 1;
    }
    s === that || Fail2`expected ${q2(s)} and ${q2(that)} to compare`;
    return 0;
  },
  toString() {
    return `${this}`;
  }
};
var nonLocaleCompare = tamedMethods.localeCompare;
var numberToString = tamedMethods.toString;
function tameLocaleMethods(intrinsics, localeTaming = "safe") {
  if (localeTaming === "unsafe") {
    return;
  }
  defineProperty(String2.prototype, "localeCompare", {
    value: nonLocaleCompare
  });
  for (const intrinsicName of getOwnPropertyNames(intrinsics)) {
    const intrinsic = intrinsics[intrinsicName];
    if (!isPrimitive(intrinsic)) {
      for (const methodName of getOwnPropertyNames(intrinsic)) {
        const match = regexpExec(localePattern, methodName);
        if (match) {
          typeof intrinsic[methodName] === "function" || Fail2`expected ${q2(methodName)} to be a function`;
          const nonLocaleMethodName = `${match[1]}${match[2]}`;
          const method = intrinsic[nonLocaleMethodName];
          typeof method === "function" || Fail2`function ${q2(nonLocaleMethodName)} not found`;
          defineProperty(intrinsic, methodName, { value: method });
        }
      }
    }
  }
  defineProperty(Number2.prototype, "toLocaleString", {
    value: numberToString
  });
}

// node_modules/ses/src/make-eval-function.js
var makeEvalFunction = (evaluator) => {
  const newEval = {
    eval(source) {
      if (typeof source !== "string") {
        return source;
      }
      return evaluator(source);
    }
  }.eval;
  return newEval;
};

// node_modules/ses/src/make-function-constructor.js
var { Fail: Fail3 } = assert;
var makeFunctionConstructor = (evaluator) => {
  const newFunction = function Function2(_body) {
    const bodyText = `${arrayPop(arguments) || ""}`;
    const parameters = `${arrayJoin(arguments, ",")}`;
    new FERAL_FUNCTION(parameters, "");
    new FERAL_FUNCTION(bodyText);
    const src = `(function anonymous(${parameters}
) {
${bodyText}
})`;
    return evaluator(src);
  };
  defineProperties(newFunction, {
    // Ensure that any function created in any evaluator in a realm is an
    // instance of Function in any evaluator of the same realm.
    prototype: {
      value: FERAL_FUNCTION.prototype,
      writable: false,
      enumerable: false,
      configurable: false
    }
  });
  getPrototypeOf(FERAL_FUNCTION) === FERAL_FUNCTION.prototype || Fail3`Function prototype is the same accross compartments`;
  getPrototypeOf(newFunction) === FERAL_FUNCTION.prototype || Fail3`Function constructor prototype is the same across compartments`;
  return newFunction;
};

// node_modules/ses/src/global-object.js
var setGlobalObjectSymbolUnscopables = (globalObject) => {
  defineProperty(
    globalObject,
    unscopablesSymbol,
    freeze(
      assign(create(null), {
        set: freeze(() => {
          throw TypeError2(
            `Cannot set Symbol.unscopables of a Compartment's globalThis`
          );
        }),
        enumerable: false,
        configurable: false
      })
    )
  );
};
var setGlobalObjectConstantProperties = (globalObject) => {
  for (const [name, constant] of entries(constantProperties)) {
    defineProperty(globalObject, name, {
      value: constant,
      writable: false,
      enumerable: false,
      configurable: false
    });
  }
};
var setGlobalObjectMutableProperties = (globalObject, {
  intrinsics,
  newGlobalPropertyNames,
  makeCompartmentConstructor: makeCompartmentConstructor2,
  markVirtualizedNativeFunction: markVirtualizedNativeFunction3,
  parentCompartment
}) => {
  for (const [name, intrinsicName] of entries(universalPropertyNames)) {
    if (hasOwn(intrinsics, intrinsicName)) {
      defineProperty(globalObject, name, {
        value: intrinsics[intrinsicName],
        writable: true,
        enumerable: false,
        configurable: true
      });
    }
  }
  for (const [name, intrinsicName] of entries(newGlobalPropertyNames)) {
    if (hasOwn(intrinsics, intrinsicName)) {
      defineProperty(globalObject, name, {
        value: intrinsics[intrinsicName],
        writable: true,
        enumerable: false,
        configurable: true
      });
    }
  }
  const perCompartmentGlobals = {
    globalThis: globalObject
  };
  perCompartmentGlobals.Compartment = freeze(
    makeCompartmentConstructor2(
      makeCompartmentConstructor2,
      intrinsics,
      markVirtualizedNativeFunction3,
      {
        parentCompartment,
        enforceNew: true
      }
    )
  );
  for (const [name, value] of entries(perCompartmentGlobals)) {
    defineProperty(globalObject, name, {
      value,
      writable: true,
      enumerable: false,
      configurable: true
    });
    if (typeof value === "function") {
      markVirtualizedNativeFunction3(value);
    }
  }
};
var setGlobalObjectEvaluators = (globalObject, evaluator, markVirtualizedNativeFunction3) => {
  {
    const f = freeze(makeEvalFunction(evaluator));
    markVirtualizedNativeFunction3(f);
    defineProperty(globalObject, "eval", {
      value: f,
      writable: true,
      enumerable: false,
      configurable: true
    });
  }
  {
    const f = freeze(makeFunctionConstructor(evaluator));
    markVirtualizedNativeFunction3(f);
    defineProperty(globalObject, "Function", {
      value: f,
      writable: true,
      enumerable: false,
      configurable: true
    });
  }
};

// node_modules/ses/src/strict-scope-terminator.js
var { Fail: Fail4, quote: q3 } = assert;
var objTarget = freeze({ __proto__: null });
var alwaysThrowHandler = new Proxy2(
  objTarget,
  freeze({
    get(_shadow, prop) {
      Fail4`Please report unexpected scope handler trap: ${q3(String2(prop))}`;
    }
  })
);
var scopeProxyHandlerProperties = {
  get(_shadow, _prop) {
    return void 0;
  },
  set(_shadow, prop, _value) {
    throw ReferenceError2(`${String2(prop)} is not defined`);
  },
  has(_shadow, prop) {
    return true;
  },
  // note: this is likely a bug of safari
  // https://bugs.webkit.org/show_bug.cgi?id=195534
  getPrototypeOf(_shadow) {
    return null;
  },
  // See https://github.com/endojs/endo/issues/1510
  // TODO: report as bug to v8 or Chrome, and record issue link here.
  getOwnPropertyDescriptor(_shadow, prop) {
    const quotedProp = q3(String2(prop));
    console.warn(
      `getOwnPropertyDescriptor trap on scopeTerminatorHandler for ${quotedProp}`,
      TypeError2().stack
    );
    return void 0;
  },
  // See https://github.com/endojs/endo/issues/1490
  // TODO Report bug to JSC or Safari
  ownKeys(_shadow) {
    return [];
  }
};
var strictScopeTerminatorHandler = freeze(
  create(
    alwaysThrowHandler,
    getOwnPropertyDescriptors(scopeProxyHandlerProperties)
  )
);
var strictScopeTerminator = new Proxy2(
  objTarget,
  strictScopeTerminatorHandler
);

// node_modules/ses/src/sloppy-globals-scope-terminator.js
var objTarget2 = freeze({ __proto__: null });
var createSloppyGlobalsScopeTerminator = (globalObject) => {
  const scopeProxyHandlerProperties2 = {
    // inherit scopeTerminator behavior
    ...strictScopeTerminatorHandler,
    // Redirect set properties to the globalObject.
    set(_shadow, prop, value) {
      return reflectSet(globalObject, prop, value);
    },
    // Always claim to have a potential property in order to be the recipient of a set
    has(_shadow, _prop) {
      return true;
    }
  };
  const sloppyGlobalsScopeTerminatorHandler = freeze(
    create(
      alwaysThrowHandler,
      getOwnPropertyDescriptors(scopeProxyHandlerProperties2)
    )
  );
  const sloppyGlobalsScopeTerminator = new Proxy2(
    objTarget2,
    sloppyGlobalsScopeTerminatorHandler
  );
  return sloppyGlobalsScopeTerminator;
};
freeze(createSloppyGlobalsScopeTerminator);

// node_modules/ses/src/eval-scope.js
var { Fail: Fail5 } = assert;
var makeEvalScopeKit = () => {
  const evalScope = create(null);
  const oneTimeEvalProperties = freeze({
    eval: {
      get() {
        delete evalScope.eval;
        return FERAL_EVAL;
      },
      enumerable: false,
      configurable: true
    }
  });
  const evalScopeKit = {
    evalScope,
    allowNextEvalToBeUnsafe() {
      const { revoked } = evalScopeKit;
      if (revoked !== null) {
        Fail5`a handler did not reset allowNextEvalToBeUnsafe ${revoked.err}`;
      }
      defineProperties(evalScope, oneTimeEvalProperties);
    },
    /** @type {null | { err: any }} */
    revoked: null
  };
  return evalScopeKit;
};

// node_modules/ses/src/get-source-url.js
var sourceMetaEntryRegExp = "\\s*[@#]\\s*([a-zA-Z][a-zA-Z0-9]*)\\s*=\\s*([^\\s\\*]*)";
var sourceMetaEntriesRegExp = freezeRegexp(
  new FERAL_REG_EXP(
    `(?:\\s*//${sourceMetaEntryRegExp}|/\\*${sourceMetaEntryRegExp}\\s*\\*/)\\s*$`
  )
);
var getSourceURL = (src) => {
  let sourceURL = "<unknown>";
  while (src.length > 0) {
    const match = regexpExec(sourceMetaEntriesRegExp, src);
    if (match === null) {
      break;
    }
    src = stringSlice(src, 0, -match[0].length);
    if (match[3] === "sourceURL") {
      sourceURL = match[4];
    } else if (match[1] === "sourceURL") {
      sourceURL = match[2];
    }
  }
  return sourceURL;
};

// node_modules/ses/src/transforms.js
function getLineNumber(src, pattern) {
  const index = regexpSearch(pattern, src);
  if (index < 0) {
    return -1;
  }
  const adjustment = src[index] === "\n" ? 1 : 0;
  return stringSplit(stringSlice(src, 0, index), "\n").length + adjustment;
}
var htmlCommentPattern = sealRegexp(
  new FERAL_REG_EXP(`(?:${"<"}!--|--${">"})`, "g")
);
var rejectHtmlComments = (src) => {
  const lineNumber = getLineNumber(src, htmlCommentPattern);
  if (lineNumber < 0) {
    return src;
  }
  const name = getSourceURL(src);
  throw SyntaxError2(
    `Possible HTML comment rejected at ${name}:${lineNumber}. (SES_HTML_COMMENT_REJECTED)`
  );
};
var evadeHtmlCommentTest = (src) => {
  const replaceFn = (match) => match[0] === "<" ? "< ! --" : "-- >";
  return regexpReplace(htmlCommentPattern, src, replaceFn);
};
var importPattern = sealRegexp(
  new FERAL_REG_EXP("(^|[^.]|\\.\\.\\.)\\bimport(\\s*(?:\\(|/[/*]))", "g")
);
var rejectImportExpressions = (src) => {
  const lineNumber = getLineNumber(src, importPattern);
  if (lineNumber < 0) {
    return src;
  }
  const name = getSourceURL(src);
  throw SyntaxError2(
    `Possible import expression rejected at ${name}:${lineNumber}. (SES_IMPORT_REJECTED)`
  );
};
var evadeImportExpressionTest = (src) => {
  const replaceFn = (_, p1, p2) => `${p1}__import__${p2}`;
  return regexpReplace(importPattern, src, replaceFn);
};
var someDirectEvalPattern = freezeRegexp(
  new FERAL_REG_EXP("(^|[^.])\\beval(\\s*\\()")
);
var rejectSomeDirectEvalExpressions = (src) => {
  const lineNumber = getLineNumber(src, someDirectEvalPattern);
  if (lineNumber < 0) {
    return src;
  }
  const name = getSourceURL(src);
  throw SyntaxError2(
    `Possible direct eval expression rejected at ${name}:${lineNumber}. (SES_EVAL_REJECTED)`
  );
};
var mandatoryTransforms = (source) => {
  source = rejectHtmlComments(source);
  source = rejectImportExpressions(source);
  return source;
};
var applyTransforms = (source, transforms2) => {
  for (let i = 0, l = transforms2.length; i < l; i += 1) {
    const transform = transforms2[i];
    source = transform(source);
  }
  return source;
};
var transforms = freeze({
  rejectHtmlComments: freeze(rejectHtmlComments),
  evadeHtmlCommentTest: freeze(evadeHtmlCommentTest),
  rejectImportExpressions: freeze(rejectImportExpressions),
  evadeImportExpressionTest: freeze(evadeImportExpressionTest),
  rejectSomeDirectEvalExpressions: freeze(rejectSomeDirectEvalExpressions),
  mandatoryTransforms: freeze(mandatoryTransforms),
  applyTransforms: freeze(applyTransforms)
});

// node_modules/ses/src/scope-constants.js
var reservedNames = new Set2([
  // 11.6.2.1 Keywords
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  // Also reserved when parsing strict mode code
  "let",
  "static",
  // 11.6.2.2 Future Reserved Words
  "enum",
  // Also reserved when parsing strict mode code
  "implements",
  "package",
  "protected",
  "interface",
  "private",
  "public",
  // Reserved but not mentioned in specs
  "await",
  "null",
  "true",
  "false",
  "this",
  "arguments",
  // Reserved by us
  "eval"
]);
var identifierPattern = freezeRegexp(/^[a-zA-Z_$][\w$]*$/);
var isValidIdentifierName = (name) => !setHas(reservedNames, name) && regexpSearch(identifierPattern, name) !== -1;
function isImmutableDataProperty(obj, name) {
  const desc = getOwnPropertyDescriptor(obj, name);
  return desc && //
  // The getters will not have .writable, don't let the falsyness of
  // 'undefined' trick us: test with === false, not ! . However descriptors
  // inherit from the (potentially poisoned) global object, so we might see
  // extra properties which weren't really there. Accessor properties have
  // 'get/set/enumerable/configurable', while data properties have
  // 'value/writable/enumerable/configurable'.
  desc.configurable === false && desc.writable === false && //
  // Checks for data properties because they're the only ones we can
  // optimize (accessors are most likely non-constant). Descriptors can't
  // can't have accessors and value properties at the same time, therefore
  // this check is sufficient. Using explicit own property deal with the
  // case where Object.prototype has been poisoned.
  hasOwn(desc, "value");
}
var getScopeConstants = (globalObject, moduleLexicals = {}) => {
  const globalObjectNames = getOwnPropertyNames(globalObject);
  const moduleLexicalNames = getOwnPropertyNames(moduleLexicals);
  const moduleLexicalConstants = arrayFilter(
    moduleLexicalNames,
    (name) => isValidIdentifierName(name) && isImmutableDataProperty(moduleLexicals, name)
  );
  const globalObjectConstants = arrayFilter(
    globalObjectNames,
    (name) => (
      // Can't define a constant: it would prevent a
      // lookup on the endowments.
      !arrayIncludes(moduleLexicalNames, name) && isValidIdentifierName(name) && isImmutableDataProperty(globalObject, name)
    )
  );
  return {
    globalObjectConstants,
    moduleLexicalConstants
  };
};

// node_modules/ses/src/make-evaluate.js
function buildOptimizer(constants, name) {
  if (constants.length === 0) return "";
  return `const {${arrayJoin(constants, ",")}} = this.${name};`;
}
var makeEvaluate = (context) => {
  const { globalObjectConstants, moduleLexicalConstants } = getScopeConstants(
    context.globalObject,
    context.moduleLexicals
  );
  const globalObjectOptimizer = buildOptimizer(
    globalObjectConstants,
    "globalObject"
  );
  const moduleLexicalOptimizer = buildOptimizer(
    moduleLexicalConstants,
    "moduleLexicals"
  );
  const evaluateFactory = FERAL_FUNCTION(`
    with (this.scopeTerminator) {
      with (this.globalObject) {
        with (this.moduleLexicals) {
          with (this.evalScope) {
            ${globalObjectOptimizer}
            ${moduleLexicalOptimizer}
            return function() {
              'use strict';
              return eval(arguments[0]);
            };
          }
        }
      }
    }
  `);
  return apply(evaluateFactory, context, []);
};

// node_modules/ses/src/make-safe-evaluator.js
var { Fail: Fail6 } = assert;
var makeSafeEvaluator = ({
  globalObject,
  moduleLexicals = {},
  globalTransforms = [],
  sloppyGlobalsMode = false
}) => {
  const scopeTerminator = sloppyGlobalsMode ? createSloppyGlobalsScopeTerminator(globalObject) : strictScopeTerminator;
  const evalScopeKit = makeEvalScopeKit();
  const { evalScope } = evalScopeKit;
  const evaluateContext = freeze({
    evalScope,
    moduleLexicals,
    globalObject,
    scopeTerminator
  });
  let evaluate;
  const provideEvaluate = () => {
    if (!evaluate) {
      evaluate = makeEvaluate(evaluateContext);
    }
  };
  const safeEvaluate = (source, options) => {
    const { localTransforms = [] } = options || {};
    provideEvaluate();
    source = applyTransforms(
      source,
      arrayFlatMap(
        [localTransforms, globalTransforms, [mandatoryTransforms]],
        identity
      )
    );
    let err;
    try {
      evalScopeKit.allowNextEvalToBeUnsafe();
      return apply(evaluate, globalObject, [source]);
    } catch (e) {
      err = e;
      throw e;
    } finally {
      const unsafeEvalWasStillExposed = "eval" in evalScope;
      delete evalScope.eval;
      if (unsafeEvalWasStillExposed) {
        evalScopeKit.revoked = { err };
        Fail6`handler did not reset allowNextEvalToBeUnsafe ${err}`;
      }
    }
  };
  return { safeEvaluate };
};

// node_modules/ses/src/tame-function-tostring.js
var nativeSuffix = ") { [native code] }";
var markVirtualizedNativeFunction;
var tameFunctionToString = () => {
  if (markVirtualizedNativeFunction === void 0) {
    const virtualizedNativeFunctions = new WeakSet2();
    const tamingMethods = {
      toString() {
        const str = functionToString(this);
        if (stringEndsWith(str, nativeSuffix) || !weaksetHas(virtualizedNativeFunctions, this)) {
          return str;
        }
        return `function ${this.name}() { [native code] }`;
      }
    };
    defineProperty(functionPrototype, "toString", {
      value: tamingMethods.toString
    });
    markVirtualizedNativeFunction = freeze(
      (func) => weaksetAdd(virtualizedNativeFunctions, func)
    );
  }
  return markVirtualizedNativeFunction;
};

// node_modules/ses/src/tame-domains.js
function tameDomains(domainTaming = "safe") {
  if (domainTaming === "unsafe") {
    return;
  }
  const globalProcess = universalThis.process || void 0;
  if (typeof globalProcess === "object") {
    const domainDescriptor = getOwnPropertyDescriptor(globalProcess, "domain");
    if (domainDescriptor !== void 0 && domainDescriptor.get !== void 0) {
      throw TypeError2(
        `SES failed to lockdown, Node.js domains have been initialized (SES_NO_DOMAINS)`
      );
    }
    defineProperty(globalProcess, "domain", {
      value: null,
      configurable: false,
      writable: false,
      enumerable: false
    });
  }
}

// node_modules/ses/src/tame-module-source.js
var tameModuleSource = () => {
  const newIntrinsics = {};
  const ModuleSource = universalThis.ModuleSource;
  if (ModuleSource !== void 0) {
    let AbstractModuleSource = function() {
    };
    newIntrinsics.ModuleSource = ModuleSource;
    const ModuleSourceProto = getPrototypeOf(ModuleSource);
    if (ModuleSourceProto === functionPrototype) {
      setPrototypeOf(ModuleSource, AbstractModuleSource);
      newIntrinsics["%AbstractModuleSource%"] = AbstractModuleSource;
      newIntrinsics["%AbstractModuleSourcePrototype%"] = AbstractModuleSource.prototype;
    } else {
      newIntrinsics["%AbstractModuleSource%"] = ModuleSourceProto;
      newIntrinsics["%AbstractModuleSourcePrototype%"] = ModuleSourceProto.prototype;
    }
    const ModuleSourcePrototype = ModuleSource.prototype;
    if (ModuleSourcePrototype !== void 0) {
      newIntrinsics["%ModuleSourcePrototype%"] = ModuleSourcePrototype;
      const ModuleSourcePrototypeProto = getPrototypeOf(ModuleSourcePrototype);
      if (ModuleSourcePrototypeProto === objectPrototype) {
        setPrototypeOf(ModuleSource.prototype, AbstractModuleSource.prototype);
      }
    }
  }
  return newIntrinsics;
};

// node_modules/ses/src/error/console.js
var defineName = (name, fn2) => defineProperty(fn2, "name", { value: name });
var consoleLevelMethods = freeze([
  ["debug", "debug"],
  // (fmt?, ...args) verbose level on Chrome
  ["log", "log"],
  // (fmt?, ...args) info level on Chrome
  ["info", "info"],
  // (fmt?, ...args)
  ["warn", "warn"],
  // (fmt?, ...args)
  ["error", "error"],
  // (fmt?, ...args)
  ["trace", "log"],
  // (fmt?, ...args)
  ["dirxml", "log"],
  // (fmt?, ...args)          but TS typed (...data)
  ["group", "log"],
  // (fmt?, ...args)           but TS typed (...label)
  ["groupCollapsed", "log"]
  // (fmt?, ...args)  but TS typed (...label)
]);
var consoleSpecialMethods = freeze([
  ["assert", "error"],
  // (value, fmt?, ...args)
  ["timeLog", "log"]
  // (label?, ...args) no fmt string
]);
var consoleOtherMethods = freeze([
  // Insensitive to whether any argument is an error. All arguments can pass
  // thru to baseConsole as is.
  ["clear", "info"],
  // (), level is not well defined
  ["count", "info"],
  // (label?)
  ["countReset", "info"],
  // (label?), level is not well defined
  ["dir", "log"],
  // (item, options?)
  ["groupEnd", "log"],
  // ()
  // In theory tabular data may be or contain an error. However, we currently
  // do not detect these and may never.
  ["table", "log"],
  // (tabularData, properties?)
  ["time", "info"],
  // (label?)
  ["timeEnd", "info"],
  // (label?)
  // Node Inspector only, MDN, and TypeScript, but not whatwg
  ["profile", "info"],
  // (label?)
  ["profileEnd", "info"],
  // (label?)
  ["timeStamp", "info"]
  // (label?)
]);
var consoleMethodPermits = freeze([
  ...consoleLevelMethods,
  ...consoleSpecialMethods,
  ...consoleOtherMethods
]);
var sanitizeFormatData = ([...formatData]) => {
  freeze(formatData);
  if (formatData.length <= 1) {
    return formatData;
  }
  const [fmt, ...args] = formatData;
  if (typeof fmt !== "string" || !stringIncludes(fmt, "%")) {
    return formatData;
  }
  let startPos = 0;
  let argI = 0;
  let newFmt = "";
  const newArgs = [];
  for (
    let percentPos = stringIndexOf(fmt, "%");
    // Notice the `- 1` below, which leaves room for one more character after
    // the `'%'`.
    percentPos >= startPos && percentPos < fmt.length - 1 && argI < args.length;
    percentPos = stringIndexOf(fmt, "%", startPos)
  ) {
    const char = fmt[percentPos + 1];
    switch (char) {
      case "s":
      case "d":
      case "i":
      case "f":
      case "o":
      case "O": {
        newFmt += stringSlice(fmt, startPos, percentPos + 2);
        startPos = percentPos + 2;
        arrayPush(newArgs, args[argI]);
        argI += 1;
        break;
      }
      case "c": {
        newFmt += stringSlice(fmt, startPos, percentPos);
        startPos = percentPos + 2;
        argI += 1;
        break;
      }
      case "%": {
        newFmt += stringSlice(fmt, startPos, percentPos + 2);
        startPos = percentPos + 2;
        break;
      }
      default: {
        newFmt += stringSlice(fmt, startPos, percentPos);
        newFmt += `%%${char}`;
        startPos = percentPos + 2;
        break;
      }
    }
  }
  if (startPos < fmt.length) {
    newFmt += stringSlice(fmt, startPos, fmt.length);
  }
  for (; argI < args.length; argI += 1) {
    arrayPush(newArgs, args[argI]);
  }
  return (
    /** @type {any[]} */
    freeze([newFmt, ...newArgs])
  );
};
freeze(sanitizeFormatData);
var makeLoggingConsoleKit = (loggedErrorHandler2, { shouldResetForDebugging = false } = {}) => {
  if (shouldResetForDebugging) {
    loggedErrorHandler2.resetErrorTagNum();
  }
  let logArray = [];
  const loggingConsole = fromEntries(
    arrayMap(consoleMethodPermits, ([name, _]) => {
      const method = defineName(name, (...args) => {
        arrayPush(logArray, [name, ...args]);
      });
      return [name, freeze(method)];
    })
  );
  freeze(loggingConsole);
  const takeLog = () => {
    const result = freeze(logArray);
    logArray = [];
    return result;
  };
  freeze(takeLog);
  const typedLoggingConsole = (
    /** @type {VirtualConsole} */
    loggingConsole
  );
  return freeze({ loggingConsole: typedLoggingConsole, takeLog });
};
freeze(makeLoggingConsoleKit);
var ErrorInfo = {
  NOTE: "ERROR_NOTE:",
  MESSAGE: "ERROR_MESSAGE:",
  CAUSE: "cause:",
  ERRORS: "errors:"
};
freeze(ErrorInfo);
var makeCausalConsole = (feralConsole, loggedErrorHandler2) => {
  if (!feralConsole) {
    return void 0;
  }
  const Console = (
    /** @type {any} */
    feralConsole.Console
  );
  const { stdout, stderr } = universalThis.process || { __proto__: null };
  const baseConsole = typeof Console === "function" && (stdout || stderr) ? new Console({
    stdout,
    stderr,
    inspectOptions: { colors: void 0, customInspect: false }
  }) : feralConsole;
  const { getStackString, tagError: tagError2, takeMessageLogArgs, takeNoteLogArgsArray } = loggedErrorHandler2;
  const extractErrorArgs = (logArgs, subErrorsSink) => {
    const argTags = arrayMap(logArgs, (arg) => {
      if (isError(arg)) {
        arrayPush(subErrorsSink, arg);
        return `(${tagError2(arg)})`;
      }
      return arg;
    });
    return argTags;
  };
  const logErrorInfo = (severity, error, kind, logArgs, subErrorsSink) => {
    const errorTag = tagError2(error);
    const errorName = kind === ErrorInfo.MESSAGE ? `${errorTag}:` : `${errorTag} ${kind}`;
    const argTags = extractErrorArgs(logArgs, subErrorsSink);
    baseConsole[severity](errorName, ...argTags);
  };
  const logSubErrors = (severity, subErrors, optTag = void 0) => {
    if (subErrors.length === 0) {
      return;
    }
    if (subErrors.length === 1 && optTag === void 0) {
      logError(severity, subErrors[0]);
      return;
    }
    let label;
    if (subErrors.length === 1) {
      label = `Nested error`;
    } else {
      label = `Nested ${subErrors.length} errors`;
    }
    if (optTag !== void 0) {
      label = `${label} under ${optTag}`;
    }
    baseConsole.group(label);
    try {
      for (const subError of subErrors) {
        logError(severity, subError);
      }
    } finally {
      if (baseConsole.groupEnd) {
        baseConsole.groupEnd();
      }
    }
  };
  const errorsLogged = new WeakSet2();
  const makeNoteCallback = (severity) => (error, noteLogArgs) => {
    const subErrors = [];
    logErrorInfo(severity, error, ErrorInfo.NOTE, noteLogArgs, subErrors);
    logSubErrors(severity, subErrors, tagError2(error));
  };
  const logError = (severity, error) => {
    if (weaksetHas(errorsLogged, error)) {
      return;
    }
    const errorTag = tagError2(error);
    weaksetAdd(errorsLogged, error);
    const subErrors = [];
    const messageLogArgs = takeMessageLogArgs(error);
    const noteLogArgsArray = takeNoteLogArgsArray(
      error,
      makeNoteCallback(severity)
    );
    if (messageLogArgs === void 0) {
      baseConsole[severity](`${errorTag}:`, error.message);
    } else {
      logErrorInfo(
        severity,
        error,
        ErrorInfo.MESSAGE,
        messageLogArgs,
        subErrors
      );
    }
    let stackString = getStackString(error);
    if (typeof stackString === "string" && stackString.length >= 1 && !stringEndsWith(stackString, "\n")) {
      stackString += "\n";
    }
    baseConsole[severity](stackString);
    if (error.cause) {
      logErrorInfo(severity, error, ErrorInfo.CAUSE, [error.cause], subErrors);
    }
    if (error.errors) {
      logErrorInfo(severity, error, ErrorInfo.ERRORS, error.errors, subErrors);
    }
    for (const noteLogArgs of noteLogArgsArray) {
      logErrorInfo(severity, error, ErrorInfo.NOTE, noteLogArgs, subErrors);
    }
    logSubErrors(severity, subErrors, errorTag);
  };
  const levelMethods = arrayMap(consoleLevelMethods, ([name, level]) => {
    const levelMethod = defineName(name, (...logArgs) => {
      const subErrors = [];
      const argTags = extractErrorArgs(sanitizeFormatData(logArgs), subErrors);
      baseConsole[name](...argTags);
      logSubErrors(level, subErrors);
    });
    return [name, freeze(levelMethod)];
  });
  const assertMethod = defineName("assert", (...assertArgs) => {
    if (assertArgs.length <= 1) {
      baseConsole.assert(...assertArgs);
    } else {
      const [cond, ...logArgs] = assertArgs;
      const subErrors = [];
      const argTags = extractErrorArgs(sanitizeFormatData(logArgs), subErrors);
      baseConsole.assert(cond, ...argTags);
      logSubErrors("error", subErrors);
    }
  });
  const timeLogMethod = defineName("timeLog", (...timeLogArgs) => {
    if (timeLogArgs.length <= 1) {
      baseConsole.timeLog(...timeLogArgs);
    } else {
      const [label, ...logArgs] = timeLogArgs;
      const subErrors = [];
      const argTags = extractErrorArgs(sanitizeFormatData(logArgs), subErrors);
      baseConsole.timeLog(label, ...argTags);
      logSubErrors("log", subErrors);
    }
  });
  const otherMethods = arrayMap(consoleOtherMethods, ([name, _level]) => {
    const otherMethod = defineName(name, (...args) => {
      baseConsole[name](...args);
      return void 0;
    });
    return [name, freeze(otherMethod)];
  });
  const methodEntries = arrayFilter(
    [
      ...levelMethods,
      ["assert", assertMethod],
      ["timeLog", timeLogMethod],
      ...otherMethods
    ],
    ([name, _]) => name in baseConsole
  );
  const causalConsole = fromEntries(methodEntries);
  return (
    /** @type {VirtualConsole} */
    freeze(causalConsole)
  );
};
freeze(makeCausalConsole);
var indentAfterAllSeps = (str, sep, indents) => {
  const [firstLine, ...restLines] = stringSplit(str, sep);
  const indentedRest = arrayFlatMap(restLines, (line) => [sep, ...indents, line]);
  return ["", firstLine, ...indentedRest];
};
var defineCausalConsoleFromLogger = (loggedErrorHandler2) => {
  const makeCausalConsoleFromLogger = (tlogger) => {
    const indents = [];
    const logWithIndent = (...args) => {
      if (indents.length > 0) {
        args = arrayFlatMap(
          args,
          (arg) => typeof arg === "string" && stringIncludes(arg, "\n") ? indentAfterAllSeps(arg, "\n", indents) : [arg]
        );
        args = [...indents, ...args];
      }
      return tlogger(...args);
    };
    const baseConsole = fromEntries([
      ...arrayMap(consoleLevelMethods, ([name]) => [
        name,
        defineName(name, (...args) => logWithIndent(...args))
      ]),
      ...arrayMap(consoleOtherMethods, ([name]) => [
        name,
        defineName(name, (...args) => logWithIndent(name, ...args))
      ])
    ]);
    for (const name of ["group", "groupCollapsed"]) {
      if (baseConsole[name]) {
        baseConsole[name] = defineName(name, (...args) => {
          if (args.length >= 1) {
            logWithIndent(...args);
          }
          arrayPush(indents, " ");
        });
      } else {
        baseConsole[name] = defineName(name, () => {
        });
      }
    }
    baseConsole.groupEnd = defineName(
      "groupEnd",
      baseConsole.groupEnd ? (...args) => {
        arrayPop(indents);
      } : () => {
      }
    );
    harden(baseConsole);
    const causalConsole = makeCausalConsole(
      /** @type {VirtualConsole} */
      baseConsole,
      loggedErrorHandler2
    );
    return (
      /** @type {VirtualConsole} */
      causalConsole
    );
  };
  return freeze(makeCausalConsoleFromLogger);
};
freeze(defineCausalConsoleFromLogger);
var filterConsole = (baseConsole, filter, _topic = void 0) => {
  const methodPermits = arrayFilter(
    consoleMethodPermits,
    ([name, _]) => name in baseConsole
  );
  const methods2 = arrayMap(methodPermits, ([name, severity]) => {
    const method = defineName(name, (...args) => {
      if (severity === void 0 || filter.canLog(severity)) {
        baseConsole[name](...args);
      }
    });
    return [name, freeze(method)];
  });
  const filteringConsole = fromEntries(methods2);
  return (
    /** @type {VirtualConsole} */
    freeze(filteringConsole)
  );
};
freeze(filterConsole);

// node_modules/ses/src/error/unhandled-rejection.js
var makeRejectionHandlers = (reportReason) => {
  if (FinalizationRegistry === void 0) {
    return void 0;
  }
  let lastReasonId = 0;
  const idToReason = new Map2();
  let cancelChecking;
  const removeReasonId = (reasonId) => {
    mapDelete(idToReason, reasonId);
    if (cancelChecking && idToReason.size === 0) {
      cancelChecking();
      cancelChecking = void 0;
    }
  };
  const promiseToReasonId = new WeakMap();
  const finalizeDroppedPromise = (heldReasonId) => {
    if (mapHas(idToReason, heldReasonId)) {
      const reason = mapGet(idToReason, heldReasonId);
      removeReasonId(heldReasonId);
      reportReason(reason);
    }
  };
  const promiseToReason = new FinalizationRegistry(finalizeDroppedPromise);
  const unhandledRejectionHandler = (reason, pr) => {
    lastReasonId += 1;
    const reasonId = lastReasonId;
    mapSet(idToReason, reasonId, reason);
    weakmapSet(promiseToReasonId, pr, reasonId);
    finalizationRegistryRegister(promiseToReason, pr, reasonId, pr);
  };
  const rejectionHandledHandler = (pr) => {
    const reasonId = weakmapGet(promiseToReasonId, pr);
    removeReasonId(reasonId);
  };
  const processTerminationHandler = () => {
    for (const [reasonId, reason] of mapEntries(idToReason)) {
      removeReasonId(reasonId);
      reportReason(reason);
    }
  };
  return {
    rejectionHandledHandler,
    unhandledRejectionHandler,
    processTerminationHandler
  };
};

// node_modules/ses/src/error/tame-console.js
var failFast = (message) => {
  throw TypeError2(message);
};
var wrapLogger = (logger, thisArg) => freeze((...args) => apply(logger, thisArg, args));
var tameConsole = (consoleTaming = "safe", errorTrapping = "platform", unhandledRejectionTrapping = "report", optGetStackString = void 0) => {
  let loggedErrorHandler2;
  if (optGetStackString === void 0) {
    loggedErrorHandler2 = loggedErrorHandler;
  } else {
    loggedErrorHandler2 = {
      ...loggedErrorHandler,
      getStackString: optGetStackString
    };
  }
  const originalConsole = (
    /** @type {VirtualConsole} */
    // eslint-disable-next-line no-nested-ternary
    typeof universalThis.console !== "undefined" ? universalThis.console : typeof universalThis.print === "function" ? (
      // Make a good-enough console for eshost (including only functions that
      // log at a specific level with no special argument interpretation).
      // https://console.spec.whatwg.org/#logging
      ((p) => freeze({ debug: p, log: p, info: p, warn: p, error: p }))(
        wrapLogger(universalThis.print)
      )
    ) : void 0
  );
  if (originalConsole && originalConsole.log) {
    for (const methodName of ["warn", "error"]) {
      if (!originalConsole[methodName]) {
        defineProperty(originalConsole, methodName, {
          value: wrapLogger(originalConsole.log, originalConsole)
        });
      }
    }
  }
  const ourConsole = (
    /** @type {VirtualConsole} */
    consoleTaming === "unsafe" ? originalConsole : makeCausalConsole(originalConsole, loggedErrorHandler2)
  );
  const globalProcess = universalThis.process || void 0;
  if (errorTrapping !== "none" && typeof globalProcess === "object" && typeof globalProcess.on === "function") {
    let terminate;
    if (errorTrapping === "platform" || errorTrapping === "exit") {
      const { exit } = globalProcess;
      typeof exit === "function" || failFast("missing process.exit");
      terminate = () => exit(globalProcess.exitCode || -1);
    } else if (errorTrapping === "abort") {
      terminate = globalProcess.abort;
      typeof terminate === "function" || failFast("missing process.abort");
    }
    globalProcess.on("uncaughtException", (error) => {
      ourConsole.error("SES_UNCAUGHT_EXCEPTION:", error);
      if (terminate) {
        terminate();
      }
    });
  }
  if (unhandledRejectionTrapping !== "none" && typeof globalProcess === "object" && typeof globalProcess.on === "function") {
    const handleRejection = (reason) => {
      ourConsole.error("SES_UNHANDLED_REJECTION:", reason);
    };
    const h = makeRejectionHandlers(handleRejection);
    if (h) {
      globalProcess.on("unhandledRejection", h.unhandledRejectionHandler);
      globalProcess.on("rejectionHandled", h.rejectionHandledHandler);
      globalProcess.on("exit", h.processTerminationHandler);
    }
  }
  const globalWindow = universalThis.window || void 0;
  if (errorTrapping !== "none" && typeof globalWindow === "object" && typeof globalWindow.addEventListener === "function") {
    globalWindow.addEventListener("error", (event) => {
      event.preventDefault();
      ourConsole.error("SES_UNCAUGHT_EXCEPTION:", event.error);
      if (errorTrapping === "exit" || errorTrapping === "abort") {
        globalWindow.location.href = `about:blank`;
      }
    });
  }
  if (unhandledRejectionTrapping !== "none" && typeof globalWindow === "object" && typeof globalWindow.addEventListener === "function") {
    const handleRejection = (reason) => {
      ourConsole.error("SES_UNHANDLED_REJECTION:", reason);
    };
    const h = makeRejectionHandlers(handleRejection);
    if (h) {
      globalWindow.addEventListener("unhandledrejection", (event) => {
        event.preventDefault();
        h.unhandledRejectionHandler(event.reason, event.promise);
      });
      globalWindow.addEventListener("rejectionhandled", (event) => {
        event.preventDefault();
        h.rejectionHandledHandler(event.promise);
      });
      globalWindow.addEventListener("beforeunload", (_event) => {
        h.processTerminationHandler();
      });
    }
  }
  return { console: ourConsole };
};

// node_modules/ses/src/error/tame-v8-error-constructor.js
var safeV8CallSiteMethodNames = [
  // suppress 'getThis' definitely
  "getTypeName",
  // suppress 'getFunction' definitely
  "getFunctionName",
  "getMethodName",
  "getFileName",
  "getLineNumber",
  "getColumnNumber",
  "getEvalOrigin",
  "isToplevel",
  "isEval",
  "isNative",
  "isConstructor",
  "isAsync",
  // suppress 'isPromiseAll' for now
  // suppress 'getPromiseIndex' for now
  // Additional names found by experiment, absent from
  // https://v8.dev/docs/stack-trace-api
  "getPosition",
  "getScriptNameOrSourceURL",
  "toString"
  // TODO replace to use only permitted info
];
var safeV8CallSiteFacet = (callSite) => {
  const methodEntry = (name) => {
    const method = callSite[name];
    return [name, () => apply(method, callSite, [])];
  };
  const o = fromEntries(arrayMap(safeV8CallSiteMethodNames, methodEntry));
  return create(o, {});
};
var safeV8SST = (sst) => arrayMap(sst, safeV8CallSiteFacet);
var FILENAME_NODE_DEPENDENTS_CENSOR = freezeRegexp(/\/node_modules\//);
var FILENAME_NODE_INTERNALS_CENSOR = freezeRegexp(/^(?:node:)?internal\//);
var FILENAME_ASSERT_CENSOR = freezeRegexp(
  /\/packages\/ses\/src\/error\/assert\.js$/
);
var FILENAME_EVENTUAL_SEND_CENSOR = freezeRegexp(
  /\/packages\/eventual-send\/src\//
);
var FILENAME_SES_AVA_CENSOR = freezeRegexp(
  /\/packages\/ses-ava\/src\/ses-ava-test\.js$/
);
var FILENAME_CENSORS = [
  FILENAME_NODE_DEPENDENTS_CENSOR,
  FILENAME_NODE_INTERNALS_CENSOR,
  FILENAME_ASSERT_CENSOR,
  FILENAME_EVENTUAL_SEND_CENSOR,
  FILENAME_SES_AVA_CENSOR
];
var filterFileName = (fileName) => {
  if (fileName === null) {
    return false;
  }
  for (const filter of FILENAME_CENSORS) {
    if (regexpSearch(filter, fileName) !== -1) {
      return false;
    }
  }
  return true;
};
var CALLSITE_ELLIPSIS_PATTERN1 = freezeRegexp(
  /^((?:.*[( ])?)[:/\w_-]*\/\.\.\.\/(.+)$/
);
var CALLSITE_ELLIPSIS_PATTERN2 = freezeRegexp(/^((?:.*[( ])?)\.\.\.\/(.+)$/);
var CALLSITE_PACKAGES_PATTERN = freezeRegexp(
  /^((?:.*[( ])?)[:/\w_-]*\/(packages\/.+)$/
);
var CALLSITE_FILE_2SLASH_PATTERN = freezeRegexp(
  /^((?:.*[( ])?)file:\/\/([^/].*)$/
);
var CALLSITE_PATTERNS = [
  CALLSITE_ELLIPSIS_PATTERN1,
  CALLSITE_ELLIPSIS_PATTERN2,
  CALLSITE_PACKAGES_PATTERN,
  CALLSITE_FILE_2SLASH_PATTERN
];
var shortenCallSiteString = (callSiteString) => {
  for (const filter of CALLSITE_PATTERNS) {
    const match = regexpExec(filter, callSiteString);
    if (match) {
      return arrayJoin(arraySlice(match, 1), "");
    }
  }
  return callSiteString;
};
var tameV8ErrorConstructor = (OriginalError, InitialError, errorTaming, stackFiltering) => {
  if (errorTaming === "unsafe-debug") {
    throw TypeError2(
      "internal: v8+unsafe-debug special case should already be done"
    );
  }
  const originalCaptureStackTrace = OriginalError.captureStackTrace;
  const omitFrames = stackFiltering === "concise" || stackFiltering === "omit-frames";
  const shortenPaths = stackFiltering === "concise" || stackFiltering === "shorten-paths";
  const callSiteFilter = (callSite) => {
    if (omitFrames) {
      if (callSite.getFunctionName()?.startsWith("__HIDE_")) {
        return false;
      }
      return filterFileName(callSite.getFileName());
    }
    return true;
  };
  const callSiteStringifier = (callSite) => {
    let callSiteString = `${callSite}`;
    if (shortenPaths) {
      callSiteString = shortenCallSiteString(callSiteString);
    }
    return `
  at ${callSiteString}`;
  };
  const stackStringFromSST = (_error, sst) => arrayJoin(
    arrayMap(arrayFilter(sst, callSiteFilter), callSiteStringifier),
    ""
  );
  const stackInfos = new WeakMap();
  const tamedMethods3 = {
    // The optional `optFn` argument is for cutting off the bottom of
    // the stack --- for capturing the stack only above the topmost
    // call to that function. Since this isn't the "real" captureStackTrace
    // but instead calls the real one, if no other cutoff is provided,
    // we cut this one off.
    captureStackTrace(error, optFn = tamedMethods3.captureStackTrace) {
      if (typeof originalCaptureStackTrace === "function") {
        apply(originalCaptureStackTrace, OriginalError, [error, optFn]);
        return;
      }
      reflectSet(error, "stack", "");
    },
    // Shim of proposed special power, to reside by default only
    // in the start compartment, for getting the stack traceback
    // string associated with an error.
    // See https://tc39.es/proposal-error-stacks/
    getStackString(error) {
      let stackInfo = weakmapGet(stackInfos, error);
      if (stackInfo === void 0) {
        void error.stack;
        stackInfo = weakmapGet(stackInfos, error);
        if (!stackInfo) {
          stackInfo = { stackString: "" };
          weakmapSet(stackInfos, error, stackInfo);
        }
      }
      if (stackInfo.stackString !== void 0) {
        return stackInfo.stackString;
      }
      const stackString = stackStringFromSST(error, stackInfo.callSites);
      weakmapSet(stackInfos, error, { stackString });
      return stackString;
    },
    prepareStackTrace(error, sst) {
      if (errorTaming === "unsafe") {
        const stackString = stackStringFromSST(error, sst);
        weakmapSet(stackInfos, error, { stackString });
        return `${error}${stackString}`;
      } else {
        weakmapSet(stackInfos, error, { callSites: sst });
        return "";
      }
    }
  };
  const defaultPrepareFn = tamedMethods3.prepareStackTrace;
  OriginalError.prepareStackTrace = defaultPrepareFn;
  const systemPrepareFnSet = new WeakSet2([defaultPrepareFn]);
  const systemPrepareFnFor = (inputPrepareFn) => {
    if (weaksetHas(systemPrepareFnSet, inputPrepareFn)) {
      return inputPrepareFn;
    }
    const systemMethods = {
      prepareStackTrace(error, sst) {
        weakmapSet(stackInfos, error, { callSites: sst });
        return inputPrepareFn(error, safeV8SST(sst));
      }
    };
    weaksetAdd(systemPrepareFnSet, systemMethods.prepareStackTrace);
    return systemMethods.prepareStackTrace;
  };
  defineProperties(InitialError, {
    captureStackTrace: {
      value: tamedMethods3.captureStackTrace,
      writable: true,
      enumerable: false,
      configurable: true
    },
    prepareStackTrace: {
      get() {
        return OriginalError.prepareStackTrace;
      },
      set(inputPrepareStackTraceFn) {
        if (typeof inputPrepareStackTraceFn === "function") {
          const systemPrepareFn = systemPrepareFnFor(inputPrepareStackTraceFn);
          OriginalError.prepareStackTrace = systemPrepareFn;
        } else {
          OriginalError.prepareStackTrace = defaultPrepareFn;
        }
      },
      enumerable: false,
      configurable: true
    }
  });
  return tamedMethods3.getStackString;
};

// node_modules/ses/src/error/tame-error-constructor.js
var stackDesc = getOwnPropertyDescriptor(FERAL_ERROR.prototype, "stack");
var stackGetter = stackDesc && stackDesc.get;
var tamedMethods2 = {
  getStackString(error) {
    if (typeof stackGetter === "function") {
      return apply(stackGetter, error, []);
    } else if ("stack" in error) {
      return `${error.stack}`;
    }
    return "";
  }
};
var initialGetStackString = tamedMethods2.getStackString;
function tameErrorConstructor(errorTaming = "safe", stackFiltering = "concise") {
  const ErrorPrototype = FERAL_ERROR.prototype;
  const { captureStackTrace: originalCaptureStackTrace } = FERAL_ERROR;
  const platform = typeof originalCaptureStackTrace === "function" ? "v8" : "unknown";
  const makeErrorConstructor = (_ = {}) => {
    const ResultError = function Error4(...rest) {
      let error;
      if (new.target === void 0) {
        error = apply(FERAL_ERROR, this, rest);
      } else {
        error = construct(FERAL_ERROR, rest, new.target);
      }
      if (platform === "v8") {
        apply(originalCaptureStackTrace, FERAL_ERROR, [error, ResultError]);
      }
      return error;
    };
    defineProperties(ResultError, {
      length: { value: 1 },
      prototype: {
        value: ErrorPrototype,
        writable: false,
        enumerable: false,
        configurable: false
      }
    });
    return ResultError;
  };
  const InitialError = makeErrorConstructor({ powers: "original" });
  const SharedError = makeErrorConstructor({ powers: "none" });
  defineProperties(ErrorPrototype, {
    constructor: { value: SharedError }
  });
  for (const NativeError2 of NativeErrors) {
    setPrototypeOf(NativeError2, SharedError);
  }
  defineProperties(InitialError, {
    stackTraceLimit: {
      get() {
        if (typeof FERAL_ERROR.stackTraceLimit === "number") {
          return FERAL_ERROR.stackTraceLimit;
        }
        return void 0;
      },
      set(newLimit) {
        if (typeof newLimit !== "number") {
          return;
        }
        if (typeof FERAL_ERROR.stackTraceLimit === "number") {
          FERAL_ERROR.stackTraceLimit = newLimit;
          return;
        }
      },
      // WTF on v8 stackTraceLimit is enumerable
      enumerable: false,
      configurable: true
    }
  });
  if (errorTaming === "unsafe-debug" && platform === "v8") {
    defineProperties(InitialError, {
      prepareStackTrace: {
        get() {
          return FERAL_ERROR.prepareStackTrace;
        },
        set(newPrepareStackTrace) {
          FERAL_ERROR.prepareStackTrace = newPrepareStackTrace;
        },
        enumerable: false,
        configurable: true
      },
      captureStackTrace: {
        value: FERAL_ERROR.captureStackTrace,
        writable: true,
        enumerable: false,
        configurable: true
      }
    });
    const descs = getOwnPropertyDescriptors(InitialError);
    defineProperties(SharedError, {
      stackTraceLimit: descs.stackTraceLimit,
      prepareStackTrace: descs.prepareStackTrace,
      captureStackTrace: descs.captureStackTrace
    });
    return {
      "%InitialGetStackString%": initialGetStackString,
      "%InitialError%": InitialError,
      "%SharedError%": SharedError
    };
  }
  defineProperties(SharedError, {
    stackTraceLimit: {
      get() {
        return void 0;
      },
      set(_newLimit) {
      },
      enumerable: false,
      configurable: true
    }
  });
  if (platform === "v8") {
    defineProperties(SharedError, {
      prepareStackTrace: {
        get() {
          return () => "";
        },
        set(_prepareFn) {
        },
        enumerable: false,
        configurable: true
      },
      captureStackTrace: {
        value: (errorish, _constructorOpt) => {
          defineProperty(errorish, "stack", {
            value: ""
          });
        },
        writable: false,
        enumerable: false,
        configurable: true
      }
    });
  }
  if (platform === "v8") {
    initialGetStackString = tameV8ErrorConstructor(
      FERAL_ERROR,
      InitialError,
      errorTaming,
      stackFiltering
    );
  } else if (errorTaming === "unsafe" || errorTaming === "unsafe-debug") {
    defineProperties(ErrorPrototype, {
      stack: {
        get() {
          return initialGetStackString(this);
        },
        set(newValue) {
          defineProperties(this, {
            stack: {
              value: newValue,
              writable: true,
              enumerable: true,
              configurable: true
            }
          });
        }
      }
    });
  } else {
    defineProperties(ErrorPrototype, {
      stack: {
        get() {
          return `${this}`;
        },
        set(newValue) {
          defineProperties(this, {
            stack: {
              value: newValue,
              writable: true,
              enumerable: true,
              configurable: true
            }
          });
        }
      }
    });
  }
  return {
    "%InitialGetStackString%": initialGetStackString,
    "%InitialError%": InitialError,
    "%SharedError%": SharedError
  };
}

// node_modules/ses/src/module-load.js
var noop = () => {
};
var asyncTrampoline = async (generatorFunc, args, errorWrapper) => {
  await null;
  const iterator = generatorFunc(...args);
  let result = generatorNext(iterator);
  while (!result.done) {
    try {
      const val = await result.value;
      result = generatorNext(iterator, val);
    } catch (error) {
      result = generatorThrow(iterator, errorWrapper(error));
    }
  }
  return result.value;
};
var syncTrampoline = (generatorFunc, args) => {
  const iterator = generatorFunc(...args);
  let result = generatorNext(iterator);
  while (!result.done) {
    try {
      result = generatorNext(iterator, result.value);
    } catch (error) {
      result = generatorThrow(iterator, error);
    }
  }
  return result.value;
};
var makeAlias = (compartment, specifier) => freeze({ compartment, specifier });
var resolveAll = (imports, resolveHook, fullReferrerSpecifier) => {
  const resolvedImports = create(null);
  for (const importSpecifier of imports) {
    const fullSpecifier = resolveHook(importSpecifier, fullReferrerSpecifier);
    resolvedImports[importSpecifier] = fullSpecifier;
  }
  return freeze(resolvedImports);
};
var loadModuleSource = (compartmentPrivateFields, moduleAliases2, compartment, moduleSpecifier, moduleSource, enqueueJob, selectImplementation, moduleLoads, importMeta) => {
  const { resolveHook, name: compartmentName } = weakmapGet(
    compartmentPrivateFields,
    compartment
  );
  const { imports } = moduleSource;
  if (!isArray(imports) || arraySome(imports, (specifier) => typeof specifier !== "string")) {
    throw makeError(
      redactedDetails`Invalid module source: 'imports' must be an array of strings, got ${imports} for module ${quote(moduleSpecifier)} of compartment ${quote(compartmentName)}`
    );
  }
  const resolvedImports = resolveAll(imports, resolveHook, moduleSpecifier);
  const moduleRecord = freeze({
    compartment,
    moduleSource,
    moduleSpecifier,
    resolvedImports,
    importMeta
  });
  for (const fullSpecifier of values(resolvedImports)) {
    enqueueJob(memoizedLoadWithErrorAnnotation, [
      compartmentPrivateFields,
      moduleAliases2,
      compartment,
      fullSpecifier,
      enqueueJob,
      selectImplementation,
      moduleLoads
    ]);
  }
  return moduleRecord;
};
function* loadWithoutErrorAnnotation(compartmentPrivateFields, moduleAliases2, compartment, moduleSpecifier, enqueueJob, selectImplementation, moduleLoads) {
  const {
    importHook,
    importNowHook,
    moduleMap,
    moduleMapHook,
    moduleRecords,
    parentCompartment
  } = weakmapGet(compartmentPrivateFields, compartment);
  if (mapHas(moduleRecords, moduleSpecifier)) {
    return mapGet(moduleRecords, moduleSpecifier);
  }
  let moduleDescriptor = moduleMap[moduleSpecifier];
  if (moduleDescriptor === void 0 && moduleMapHook !== void 0) {
    moduleDescriptor = moduleMapHook(moduleSpecifier);
  }
  if (moduleDescriptor === void 0) {
    const moduleHook = selectImplementation(importHook, importNowHook);
    if (moduleHook === void 0) {
      const moduleHookName = selectImplementation(
        "importHook",
        "importNowHook"
      );
      throw makeError(
        redactedDetails`${bare(moduleHookName)} needed to load module ${quote(
          moduleSpecifier
        )} in compartment ${quote(compartment.name)}`
      );
    }
    moduleDescriptor = moduleHook(moduleSpecifier);
    if (!weakmapHas(moduleAliases2, moduleDescriptor)) {
      moduleDescriptor = yield moduleDescriptor;
    }
  }
  if (typeof moduleDescriptor === "string") {
    throw makeError(
      redactedDetails`Cannot map module ${quote(moduleSpecifier)} to ${quote(
        moduleDescriptor
      )} in parent compartment, use {source} module descriptor`,
      TypeError2
    );
  } else if (!isPrimitive(moduleDescriptor)) {
    let aliasDescriptor = weakmapGet(moduleAliases2, moduleDescriptor);
    if (aliasDescriptor !== void 0) {
      moduleDescriptor = aliasDescriptor;
    }
    if (moduleDescriptor.namespace !== void 0) {
      if (typeof moduleDescriptor.namespace === "string") {
        const {
          compartment: aliasCompartment = parentCompartment,
          namespace: aliasSpecifier
        } = moduleDescriptor;
        if (isPrimitive(aliasCompartment) || !weakmapHas(compartmentPrivateFields, aliasCompartment)) {
          throw makeError(
            redactedDetails`Invalid compartment in module descriptor for specifier ${quote(moduleSpecifier)} in compartment ${quote(compartment.name)}`
          );
        }
        const aliasRecord = yield memoizedLoadWithErrorAnnotation(
          compartmentPrivateFields,
          moduleAliases2,
          aliasCompartment,
          aliasSpecifier,
          enqueueJob,
          selectImplementation,
          moduleLoads
        );
        mapSet(moduleRecords, moduleSpecifier, aliasRecord);
        return aliasRecord;
      }
      if (!isPrimitive(moduleDescriptor.namespace)) {
        const { namespace } = moduleDescriptor;
        aliasDescriptor = weakmapGet(moduleAliases2, namespace);
        if (aliasDescriptor !== void 0) {
          moduleDescriptor = aliasDescriptor;
        } else {
          const exports = getOwnPropertyNames(namespace);
          const moduleSource2 = {
            imports: [],
            exports,
            execute(env) {
              for (const name of exports) {
                env[name] = namespace[name];
              }
            }
          };
          const importMeta = void 0;
          const moduleRecord2 = loadModuleSource(
            compartmentPrivateFields,
            moduleAliases2,
            compartment,
            moduleSpecifier,
            moduleSource2,
            enqueueJob,
            selectImplementation,
            moduleLoads,
            importMeta
          );
          mapSet(moduleRecords, moduleSpecifier, moduleRecord2);
          return moduleRecord2;
        }
      } else {
        throw makeError(
          redactedDetails`Invalid compartment in module descriptor for specifier ${quote(moduleSpecifier)} in compartment ${quote(compartment.name)}`
        );
      }
    }
    if (moduleDescriptor.source !== void 0) {
      if (typeof moduleDescriptor.source === "string") {
        const {
          source: loaderSpecifier,
          specifier: instanceSpecifier = moduleSpecifier,
          compartment: loaderCompartment = parentCompartment,
          importMeta = void 0
        } = moduleDescriptor;
        const loaderRecord = yield memoizedLoadWithErrorAnnotation(
          compartmentPrivateFields,
          moduleAliases2,
          loaderCompartment,
          loaderSpecifier,
          enqueueJob,
          selectImplementation,
          moduleLoads
        );
        const { moduleSource: moduleSource2 } = loaderRecord;
        const moduleRecord2 = loadModuleSource(
          compartmentPrivateFields,
          moduleAliases2,
          compartment,
          instanceSpecifier,
          moduleSource2,
          enqueueJob,
          selectImplementation,
          moduleLoads,
          importMeta
        );
        mapSet(moduleRecords, moduleSpecifier, moduleRecord2);
        return moduleRecord2;
      } else {
        const {
          source: moduleSource2,
          specifier: aliasSpecifier = moduleSpecifier,
          importMeta
        } = moduleDescriptor;
        const aliasRecord = loadModuleSource(
          compartmentPrivateFields,
          moduleAliases2,
          compartment,
          aliasSpecifier,
          moduleSource2,
          enqueueJob,
          selectImplementation,
          moduleLoads,
          importMeta
        );
        mapSet(moduleRecords, moduleSpecifier, aliasRecord);
        return aliasRecord;
      }
    }
    if (moduleDescriptor.archive !== void 0) {
      throw makeError(
        redactedDetails`Unsupported archive module descriptor for specifier ${quote(moduleSpecifier)} in compartment ${quote(compartment.name)}`
      );
    }
    if (moduleDescriptor.record !== void 0) {
      const {
        compartment: aliasCompartment = compartment,
        specifier: aliasSpecifier = moduleSpecifier,
        record: moduleSource2,
        importMeta
      } = moduleDescriptor;
      const aliasRecord = loadModuleSource(
        compartmentPrivateFields,
        moduleAliases2,
        aliasCompartment,
        aliasSpecifier,
        moduleSource2,
        enqueueJob,
        selectImplementation,
        moduleLoads,
        importMeta
      );
      mapSet(moduleRecords, moduleSpecifier, aliasRecord);
      mapSet(moduleRecords, aliasSpecifier, aliasRecord);
      return aliasRecord;
    }
    if (moduleDescriptor.compartment !== void 0 && moduleDescriptor.specifier !== void 0) {
      if (isPrimitive(moduleDescriptor.compartment) || !weakmapHas(compartmentPrivateFields, moduleDescriptor.compartment) || typeof moduleDescriptor.specifier !== "string") {
        throw makeError(
          redactedDetails`Invalid compartment in module descriptor for specifier ${quote(moduleSpecifier)} in compartment ${quote(compartment.name)}`
        );
      }
      const aliasRecord = yield memoizedLoadWithErrorAnnotation(
        compartmentPrivateFields,
        moduleAliases2,
        moduleDescriptor.compartment,
        moduleDescriptor.specifier,
        enqueueJob,
        selectImplementation,
        moduleLoads
      );
      mapSet(moduleRecords, moduleSpecifier, aliasRecord);
      return aliasRecord;
    }
    const moduleSource = moduleDescriptor;
    const moduleRecord = loadModuleSource(
      compartmentPrivateFields,
      moduleAliases2,
      compartment,
      moduleSpecifier,
      moduleSource,
      enqueueJob,
      selectImplementation,
      moduleLoads
    );
    mapSet(moduleRecords, moduleSpecifier, moduleRecord);
    return moduleRecord;
  } else {
    throw makeError(
      redactedDetails`module descriptor must be a string or object for specifier ${quote(
        moduleSpecifier
      )} in compartment ${quote(compartment.name)}`
    );
  }
}
var memoizedLoadWithErrorAnnotation = (compartmentPrivateFields, moduleAliases2, compartment, moduleSpecifier, enqueueJob, selectImplementation, moduleLoads) => {
  const { name: compartmentName } = weakmapGet(
    compartmentPrivateFields,
    compartment
  );
  let compartmentLoading = mapGet(moduleLoads, compartment);
  if (compartmentLoading === void 0) {
    compartmentLoading = new Map2();
    mapSet(moduleLoads, compartment, compartmentLoading);
  }
  let moduleLoading = mapGet(compartmentLoading, moduleSpecifier);
  if (moduleLoading !== void 0) {
    return moduleLoading;
  }
  moduleLoading = selectImplementation(asyncTrampoline, syncTrampoline)(
    loadWithoutErrorAnnotation,
    [
      compartmentPrivateFields,
      moduleAliases2,
      compartment,
      moduleSpecifier,
      enqueueJob,
      selectImplementation,
      moduleLoads
    ],
    (error) => {
      note(
        error,
        redactedDetails`${error.message}, loading ${quote(moduleSpecifier)} in compartment ${quote(
          compartmentName
        )}`
      );
      throw error;
    }
  );
  mapSet(compartmentLoading, moduleSpecifier, moduleLoading);
  return moduleLoading;
};
var asyncJobQueue = ({ errors = [], noAggregateErrors = false } = {}) => {
  const pendingJobs = new Set2();
  const enqueueJob = (func, args) => {
    setAdd(
      pendingJobs,
      promiseThen(func(...args), noop, (error) => {
        if (noAggregateErrors) {
          throw error;
        } else {
          arrayPush(errors, error);
        }
      })
    );
  };
  const drainQueue = async () => {
    await null;
    for (const job of pendingJobs) {
      await job;
    }
  };
  return { enqueueJob, drainQueue, errors };
};
var syncJobQueue = ({ errors = [], noAggregateErrors = false } = {}) => {
  let current2 = [];
  let next = [];
  const enqueueJob = (func, args) => {
    arrayPush(next, [func, args]);
  };
  const drainQueue = () => {
    for (const [func, args] of current2) {
      try {
        func(...args);
      } catch (error) {
        if (noAggregateErrors) {
          throw error;
        } else {
          arrayPush(errors, error);
        }
      }
    }
    current2 = next;
    next = [];
    if (current2.length > 0) drainQueue();
  };
  return { enqueueJob, drainQueue, errors };
};
var throwAggregateError = ({ errors, errorPrefix }) => {
  if (errors.length > 0) {
    const verbose = (
      /** @type {'' | 'verbose'} */
      getEnvironmentOption("COMPARTMENT_LOAD_ERRORS", "", ["verbose"]) === "verbose"
    );
    throw TypeError2(
      `${errorPrefix} (${errors.length} underlying failures: ${arrayJoin(
        arrayMap(errors, (error) => error.message + (verbose ? error.stack : "")),
        ", "
      )}`
    );
  }
};
var preferSync = (_asyncImpl, syncImpl) => syncImpl;
var preferAsync = (asyncImpl, _syncImpl) => asyncImpl;
var load = async (compartmentPrivateFields, moduleAliases2, compartment, moduleSpecifier, { noAggregateErrors = false } = {}) => {
  const { name: compartmentName } = weakmapGet(
    compartmentPrivateFields,
    compartment
  );
  const moduleLoads = new Map2();
  const { enqueueJob, drainQueue, errors } = asyncJobQueue({
    noAggregateErrors
  });
  enqueueJob(memoizedLoadWithErrorAnnotation, [
    compartmentPrivateFields,
    moduleAliases2,
    compartment,
    moduleSpecifier,
    enqueueJob,
    preferAsync,
    moduleLoads
  ]);
  await drainQueue();
  throwAggregateError({
    errors,
    errorPrefix: `Failed to load module ${quote(moduleSpecifier)} in package ${quote(
      compartmentName
    )}`
  });
};
var loadNow = (compartmentPrivateFields, moduleAliases2, compartment, moduleSpecifier, { noAggregateErrors = false } = {}) => {
  const { name: compartmentName } = weakmapGet(
    compartmentPrivateFields,
    compartment
  );
  const moduleLoads = new Map2();
  const { enqueueJob, drainQueue, errors } = syncJobQueue({
    noAggregateErrors
  });
  enqueueJob(memoizedLoadWithErrorAnnotation, [
    compartmentPrivateFields,
    moduleAliases2,
    compartment,
    moduleSpecifier,
    enqueueJob,
    preferSync,
    moduleLoads
  ]);
  drainQueue();
  throwAggregateError({
    errors,
    errorPrefix: `Failed to load module ${quote(moduleSpecifier)} in package ${quote(
      compartmentName
    )}`
  });
};

// node_modules/ses/src/module-proxy.js
var { quote: q4 } = assert;
var deferExports = () => {
  let active = false;
  const exportsTarget = create(null, {
    // Make this appear like an ESM module namespace object.
    [toStringTagSymbol]: {
      value: "Module",
      writable: false,
      enumerable: false,
      configurable: false
    }
  });
  return freeze({
    activate() {
      active = true;
    },
    exportsTarget,
    exportsProxy: new Proxy2(exportsTarget, {
      get(_target, name, receiver) {
        if (!active) {
          throw TypeError2(
            `Cannot get property ${q4(
              name
            )} of module exports namespace, the module has not yet begun to execute`
          );
        }
        return reflectGet(exportsTarget, name, receiver);
      },
      set(_target, name, _value) {
        throw TypeError2(
          `Cannot set property ${q4(name)} of module exports namespace`
        );
      },
      has(_target, name) {
        if (!active) {
          throw TypeError2(
            `Cannot check property ${q4(
              name
            )}, the module has not yet begun to execute`
          );
        }
        return reflectHas(exportsTarget, name);
      },
      deleteProperty(_target, name) {
        throw TypeError2(
          `Cannot delete property ${q4(name)}s of module exports namespace`
        );
      },
      ownKeys(_target) {
        if (!active) {
          throw TypeError2(
            "Cannot enumerate keys, the module has not yet begun to execute"
          );
        }
        return ownKeys(exportsTarget);
      },
      getOwnPropertyDescriptor(_target, name) {
        if (!active) {
          throw TypeError2(
            `Cannot get own property descriptor ${q4(
              name
            )}, the module has not yet begun to execute`
          );
        }
        return reflectGetOwnPropertyDescriptor(exportsTarget, name);
      },
      preventExtensions(_target) {
        if (!active) {
          throw TypeError2(
            "Cannot prevent extensions of module exports namespace, the module has not yet begun to execute"
          );
        }
        return reflectPreventExtensions(exportsTarget);
      },
      isExtensible() {
        if (!active) {
          throw TypeError2(
            "Cannot check extensibility of module exports namespace, the module has not yet begun to execute"
          );
        }
        return reflectIsExtensible(exportsTarget);
      },
      getPrototypeOf(_target) {
        return null;
      },
      setPrototypeOf(_target, _proto) {
        throw TypeError2("Cannot set prototype of module exports namespace");
      },
      defineProperty(_target, name, _descriptor) {
        throw TypeError2(
          `Cannot define property ${q4(name)} of module exports namespace`
        );
      },
      apply(_target, _thisArg, _args) {
        throw TypeError2(
          "Cannot call module exports namespace, it is not a function"
        );
      },
      construct(_target, _args) {
        throw TypeError2(
          "Cannot construct module exports namespace, it is not a constructor"
        );
      }
    })
  });
};
var getDeferredExports = (compartment, compartmentPrivateFields, moduleAliases2, specifier) => {
  const { deferredExports } = compartmentPrivateFields;
  if (!mapHas(deferredExports, specifier)) {
    const deferred = deferExports();
    weakmapSet(
      moduleAliases2,
      deferred.exportsProxy,
      makeAlias(compartment, specifier)
    );
    mapSet(deferredExports, specifier, deferred);
  }
  return mapGet(deferredExports, specifier);
};

// node_modules/ses/src/compartment-evaluate.js
var provideCompartmentEvaluator = (compartmentFields, options) => {
  const { sloppyGlobalsMode = false, __moduleShimLexicals__ = void 0 } = options;
  let safeEvaluate;
  if (__moduleShimLexicals__ === void 0 && !sloppyGlobalsMode) {
    ({ safeEvaluate } = compartmentFields);
  } else {
    let { globalTransforms } = compartmentFields;
    const { globalObject } = compartmentFields;
    let moduleLexicals;
    if (__moduleShimLexicals__ !== void 0) {
      globalTransforms = void 0;
      moduleLexicals = create(
        null,
        getOwnPropertyDescriptors(__moduleShimLexicals__)
      );
    }
    ({ safeEvaluate } = makeSafeEvaluator({
      globalObject,
      moduleLexicals,
      globalTransforms,
      sloppyGlobalsMode
    }));
  }
  return { safeEvaluate };
};
var compartmentEvaluate = (compartmentFields, source, options) => {
  if (typeof source !== "string") {
    throw TypeError2("first argument of evaluate() must be a string");
  }
  const {
    transforms: transforms2 = [],
    __evadeHtmlCommentTest__ = false,
    __evadeImportExpressionTest__ = false,
    __rejectSomeDirectEvalExpressions__ = true
    // Note default on
  } = options;
  const localTransforms = [...transforms2];
  if (__evadeHtmlCommentTest__ === true) {
    arrayPush(localTransforms, evadeHtmlCommentTest);
  }
  if (__evadeImportExpressionTest__ === true) {
    arrayPush(localTransforms, evadeImportExpressionTest);
  }
  if (__rejectSomeDirectEvalExpressions__ === true) {
    arrayPush(localTransforms, rejectSomeDirectEvalExpressions);
  }
  const { safeEvaluate } = provideCompartmentEvaluator(
    compartmentFields,
    options
  );
  return safeEvaluate(source, {
    localTransforms
  });
};

// node_modules/ses/src/module-instance.js
var { quote: q5 } = assert;
var makeVirtualModuleInstance = (compartmentPrivateFields, moduleSource, compartment, moduleAliases2, moduleSpecifier, resolvedImports) => {
  const { exportsProxy, exportsTarget, activate } = getDeferredExports(
    compartment,
    weakmapGet(compartmentPrivateFields, compartment),
    moduleAliases2,
    moduleSpecifier
  );
  const notifiers = create(null);
  if (moduleSource.exports) {
    if (!isArray(moduleSource.exports) || arraySome(moduleSource.exports, (name) => typeof name !== "string")) {
      throw TypeError2(
        `SES virtual module source "exports" property must be an array of strings for module ${moduleSpecifier}`
      );
    }
    arrayForEach(moduleSource.exports, (name) => {
      let value = exportsTarget[name];
      const updaters = [];
      const get = () => value;
      const set = (newValue) => {
        value = newValue;
        for (const updater of updaters) {
          updater(newValue);
        }
      };
      defineProperty(exportsTarget, name, {
        get,
        set,
        enumerable: true,
        configurable: false
      });
      notifiers[name] = (update) => {
        arrayPush(updaters, update);
        update(value);
      };
    });
    notifiers["*"] = (update) => {
      update(exportsTarget);
    };
  }
  const localState = {
    activated: false
  };
  return freeze({
    notifiers,
    exportsProxy,
    execute() {
      if (reflectHas(localState, "errorFromExecute")) {
        throw localState.errorFromExecute;
      }
      if (!localState.activated) {
        activate();
        localState.activated = true;
        try {
          moduleSource.execute(exportsTarget, compartment, resolvedImports);
        } catch (err) {
          localState.errorFromExecute = err;
          throw err;
        }
      }
    }
  });
};
var makeModuleInstance = (privateFields2, moduleAliases2, moduleRecord, importedInstances) => {
  const {
    compartment,
    moduleSpecifier,
    moduleSource,
    importMeta: moduleRecordMeta
  } = moduleRecord;
  const {
    reexports: exportAlls = [],
    __syncModuleProgram__: functorSource,
    __fixedExportMap__: fixedExportMap = {},
    __liveExportMap__: liveExportMap = {},
    __reexportMap__: reexportMap = {},
    __needsImport__: needsImport = false,
    __needsImportMeta__: needsImportMeta = false,
    __syncModuleFunctor__
  } = moduleSource;
  const compartmentFields = weakmapGet(privateFields2, compartment);
  const { __shimTransforms__, resolveHook, importMetaHook, compartmentImport } = compartmentFields;
  const { exportsProxy, exportsTarget, activate } = getDeferredExports(
    compartment,
    compartmentFields,
    moduleAliases2,
    moduleSpecifier
  );
  const exportsProps = create(null);
  const moduleLexicals = create(null);
  const onceVar = create(null);
  const liveVar = create(null);
  const importMeta = create(null);
  if (moduleRecordMeta) {
    assign(importMeta, moduleRecordMeta);
  }
  if (needsImportMeta && importMetaHook) {
    importMetaHook(moduleSpecifier, importMeta);
  }
  let dynamicImport;
  if (needsImport) {
    dynamicImport = async (importSpecifier) => compartmentImport(resolveHook(importSpecifier, moduleSpecifier));
  }
  const localGetNotify = create(null);
  const notifiers = create(null);
  arrayForEach(entries(fixedExportMap), ([fixedExportName, [localName]]) => {
    let fixedGetNotify = localGetNotify[localName];
    if (!fixedGetNotify) {
      let value;
      let tdz = true;
      let optUpdaters = [];
      const get = () => {
        if (tdz) {
          throw ReferenceError2(`binding ${q5(localName)} not yet initialized`);
        }
        return value;
      };
      const init = freeze((initValue) => {
        if (!tdz) {
          throw TypeError2(
            `Internal: binding ${q5(localName)} already initialized`
          );
        }
        value = initValue;
        const updaters = optUpdaters;
        optUpdaters = null;
        tdz = false;
        for (const updater of updaters || []) {
          updater(initValue);
        }
        return initValue;
      });
      const notify = (updater) => {
        if (updater === init) {
          return;
        }
        if (tdz) {
          arrayPush(optUpdaters || [], updater);
        } else {
          updater(value);
        }
      };
      fixedGetNotify = {
        get,
        notify
      };
      localGetNotify[localName] = fixedGetNotify;
      onceVar[localName] = init;
    }
    exportsProps[fixedExportName] = {
      get: fixedGetNotify.get,
      set: void 0,
      enumerable: true,
      configurable: false
    };
    notifiers[fixedExportName] = fixedGetNotify.notify;
  });
  arrayForEach(
    entries(liveExportMap),
    ([liveExportName, [localName, setProxyTrap]]) => {
      let liveGetNotify = localGetNotify[localName];
      if (!liveGetNotify) {
        let value;
        let tdz = true;
        const updaters = [];
        const get = () => {
          if (tdz) {
            throw ReferenceError2(
              `binding ${q5(liveExportName)} not yet initialized`
            );
          }
          return value;
        };
        const update = freeze((newValue) => {
          value = newValue;
          tdz = false;
          for (const updater of updaters) {
            updater(newValue);
          }
        });
        const set = (newValue) => {
          if (tdz) {
            throw ReferenceError2(`binding ${q5(localName)} not yet initialized`);
          }
          value = newValue;
          for (const updater of updaters) {
            updater(newValue);
          }
        };
        const notify = (updater) => {
          if (updater === update) {
            return;
          }
          arrayPush(updaters, updater);
          if (!tdz) {
            updater(value);
          }
        };
        liveGetNotify = {
          get,
          notify
        };
        localGetNotify[localName] = liveGetNotify;
        if (setProxyTrap) {
          defineProperty(moduleLexicals, localName, {
            get,
            set,
            enumerable: true,
            configurable: false
          });
        }
        liveVar[localName] = update;
      }
      exportsProps[liveExportName] = {
        get: liveGetNotify.get,
        set: void 0,
        enumerable: true,
        configurable: false
      };
      notifiers[liveExportName] = liveGetNotify.notify;
    }
  );
  const notifyStar = (update) => {
    update(exportsTarget);
  };
  notifiers["*"] = notifyStar;
  const wireUpExportNotifier = (exportName, notify) => {
    if (!notifiers[exportName] && notify !== false) {
      notifiers[exportName] = notify;
      let value;
      const update = (newValue) => value = newValue;
      notify(update);
      exportsProps[exportName] = {
        get() {
          return value;
        },
        set: void 0,
        enumerable: true,
        configurable: false
      };
    }
  };
  function imports(updateRecord) {
    const candidateAll = create(null);
    candidateAll.default = false;
    for (const [specifier, importUpdaters] of updateRecord) {
      const instance = mapGet(importedInstances, specifier);
      instance.execute();
      const { notifiers: importNotifiers } = instance;
      for (const [importName, updaters] of importUpdaters) {
        const importNotify = importNotifiers[importName];
        if (!importNotify) {
          throw SyntaxError2(
            `The requested module '${specifier}' does not provide an export named '${importName}'`
          );
        }
        for (const updater of updaters) {
          importNotify(updater);
        }
      }
      if (arrayIncludes(exportAlls, specifier)) {
        for (const [importAndExportName, importNotify] of entries(
          importNotifiers
        )) {
          if (candidateAll[importAndExportName] === void 0) {
            candidateAll[importAndExportName] = importNotify;
          } else {
            candidateAll[importAndExportName] = false;
          }
        }
      }
      if (reexportMap[specifier]) {
        for (const [localName, exportedName] of reexportMap[specifier]) {
          wireUpExportNotifier(exportedName, importNotifiers[localName]);
        }
      }
    }
    for (const [exportName, notify] of entries(candidateAll)) {
      wireUpExportNotifier(exportName, notify);
    }
    arrayForEach(
      arraySort(keys(exportsProps)),
      (k) => defineProperty(exportsTarget, k, exportsProps[k])
    );
    freeze(exportsTarget);
    activate();
  }
  let optFunctor;
  if (__syncModuleFunctor__ !== void 0) {
    optFunctor = __syncModuleFunctor__;
  } else {
    optFunctor = compartmentEvaluate(compartmentFields, functorSource, {
      globalObject: compartment.globalThis,
      transforms: __shimTransforms__,
      __moduleShimLexicals__: moduleLexicals
    });
  }
  let didThrow = false;
  let thrownError;
  function execute() {
    if (optFunctor) {
      const functor = optFunctor;
      optFunctor = null;
      try {
        functor(
          freeze({
            imports: freeze(imports),
            onceVar: freeze(onceVar),
            liveVar: freeze(liveVar),
            import: dynamicImport,
            importMeta
          })
        );
      } catch (e) {
        didThrow = true;
        thrownError = e;
      }
    }
    if (didThrow) {
      throw thrownError;
    }
  }
  return freeze({
    notifiers,
    exportsProxy,
    execute
  });
};

// node_modules/ses/src/module-link.js
var { Fail: Fail7, quote: q6 } = assert;
var link = (compartmentPrivateFields, moduleAliases2, compartment, moduleSpecifier) => {
  const { name: compartmentName, moduleRecords } = weakmapGet(
    compartmentPrivateFields,
    compartment
  );
  const moduleRecord = mapGet(moduleRecords, moduleSpecifier);
  if (moduleRecord === void 0) {
    throw ReferenceError2(
      `Missing link to module ${q6(moduleSpecifier)} from compartment ${q6(
        compartmentName
      )}`
    );
  }
  return instantiate(compartmentPrivateFields, moduleAliases2, moduleRecord);
};
function mayBePrecompiledModuleSource(moduleSource) {
  return typeof moduleSource.__syncModuleProgram__ === "string";
}
function validatePrecompiledModuleSource(moduleSource, moduleSpecifier) {
  const { __fixedExportMap__, __liveExportMap__ } = moduleSource;
  !isPrimitive(__fixedExportMap__) || Fail7`Property '__fixedExportMap__' of a precompiled module source must be an object, got ${q6(
    __fixedExportMap__
  )}, for module ${q6(moduleSpecifier)}`;
  !isPrimitive(__liveExportMap__) || Fail7`Property '__liveExportMap__' of a precompiled module source must be an object, got ${q6(
    __liveExportMap__
  )}, for module ${q6(moduleSpecifier)}`;
}
function mayBeVirtualModuleSource(moduleSource) {
  return typeof moduleSource.execute === "function";
}
function validateVirtualModuleSource(moduleSource, moduleSpecifier) {
  const { exports } = moduleSource;
  isArray(exports) || Fail7`Invalid module source: 'exports' of a virtual module source must be an array, got ${q6(
    exports
  )}, for module ${q6(moduleSpecifier)}`;
}
function validateModuleSource(moduleSource, moduleSpecifier) {
  !isPrimitive(moduleSource) || Fail7`Invalid module source: must be of type object, got ${q6(
    moduleSource
  )}, for module ${q6(moduleSpecifier)}`;
  const { imports, exports, reexports = [] } = moduleSource;
  isArray(imports) || Fail7`Invalid module source: 'imports' must be an array, got ${q6(
    imports
  )}, for module ${q6(moduleSpecifier)}`;
  isArray(exports) || Fail7`Invalid module source: 'exports' must be an array, got ${q6(
    exports
  )}, for module ${q6(moduleSpecifier)}`;
  isArray(reexports) || Fail7`Invalid module source: 'reexports' must be an array if present, got ${q6(
    reexports
  )}, for module ${q6(moduleSpecifier)}`;
}
var instantiate = (compartmentPrivateFields, moduleAliases2, moduleRecord) => {
  const { compartment, moduleSpecifier, resolvedImports, moduleSource } = moduleRecord;
  const { instances } = weakmapGet(compartmentPrivateFields, compartment);
  if (mapHas(instances, moduleSpecifier)) {
    return mapGet(instances, moduleSpecifier);
  }
  validateModuleSource(moduleSource, moduleSpecifier);
  const importedInstances = new Map2();
  let moduleInstance;
  if (mayBePrecompiledModuleSource(moduleSource)) {
    validatePrecompiledModuleSource(moduleSource, moduleSpecifier);
    moduleInstance = makeModuleInstance(
      compartmentPrivateFields,
      moduleAliases2,
      moduleRecord,
      importedInstances
    );
  } else if (mayBeVirtualModuleSource(moduleSource)) {
    validateVirtualModuleSource(moduleSource, moduleSpecifier);
    moduleInstance = makeVirtualModuleInstance(
      compartmentPrivateFields,
      moduleSource,
      compartment,
      moduleAliases2,
      moduleSpecifier,
      resolvedImports
    );
  } else {
    throw TypeError2(`Invalid module source, got ${q6(moduleSource)}`);
  }
  mapSet(instances, moduleSpecifier, moduleInstance);
  for (const [importSpecifier, resolvedSpecifier] of entries(resolvedImports)) {
    const importedInstance = link(
      compartmentPrivateFields,
      moduleAliases2,
      compartment,
      resolvedSpecifier
    );
    mapSet(importedInstances, importSpecifier, importedInstance);
  }
  return moduleInstance;
};

// node_modules/ses/src/compartment.js
var moduleAliases = new WeakMap();
var privateFields = new WeakMap();
var InertCompartment = function Compartment2(_endowments = {}, _modules = {}, _options = {}) {
  throw TypeError2(
    "Compartment.prototype.constructor is not a valid constructor."
  );
};
var compartmentImportNow = (compartment, specifier) => {
  const { execute, exportsProxy } = link(
    privateFields,
    moduleAliases,
    compartment,
    specifier
  );
  execute();
  return exportsProxy;
};
var CompartmentPrototype = {
  constructor: InertCompartment,
  get globalThis() {
    return (
      /** @type {CompartmentFields} */
      weakmapGet(privateFields, this).globalObject
    );
  },
  get name() {
    return (
      /** @type {CompartmentFields} */
      weakmapGet(privateFields, this).name
    );
  },
  get __noNamespaceBox__() {
    return (
      /** @type {CompartmentFields} */
      weakmapGet(privateFields, this).noNamespaceBox
    );
  },
  evaluate(source, options = {}) {
    const compartmentFields = weakmapGet(privateFields, this);
    return compartmentEvaluate(compartmentFields, source, options);
  },
  module(specifier) {
    if (typeof specifier !== "string") {
      throw TypeError2("first argument of module() must be a string");
    }
    const { exportsProxy } = getDeferredExports(
      this,
      weakmapGet(privateFields, this),
      moduleAliases,
      specifier
    );
    return exportsProxy;
  },
  async import(specifier) {
    const { noNamespaceBox, noAggregateLoadErrors } = (
      /** @type {CompartmentFields} */
      weakmapGet(privateFields, this)
    );
    if (typeof specifier !== "string") {
      throw TypeError2("first argument of import() must be a string");
    }
    return promiseThen(
      load(privateFields, moduleAliases, this, specifier, {
        noAggregateErrors: noAggregateLoadErrors
      }),
      () => {
        const namespace = compartmentImportNow(
          /** @type {Compartment} */
          this,
          specifier
        );
        if (noNamespaceBox) {
          return namespace;
        }
        return { namespace };
      }
    );
  },
  async load(specifier) {
    if (typeof specifier !== "string") {
      throw TypeError2("first argument of load() must be a string");
    }
    const { noAggregateLoadErrors } = (
      /** @type {CompartmentFields} */
      weakmapGet(privateFields, this)
    );
    return load(privateFields, moduleAliases, this, specifier, {
      noAggregateErrors: noAggregateLoadErrors
    });
  },
  importNow(specifier) {
    if (typeof specifier !== "string") {
      throw TypeError2("first argument of importNow() must be a string");
    }
    const { noAggregateLoadErrors } = (
      /** @type {CompartmentFields} */
      weakmapGet(privateFields, this)
    );
    loadNow(privateFields, moduleAliases, this, specifier, {
      noAggregateErrors: noAggregateLoadErrors
    });
    return compartmentImportNow(
      /** @type {Compartment} */
      this,
      specifier
    );
  }
};
defineProperties(CompartmentPrototype, {
  [toStringTagSymbol]: {
    value: "Compartment",
    writable: false,
    enumerable: false,
    configurable: true
  }
});
defineProperties(InertCompartment, {
  prototype: { value: CompartmentPrototype }
});
var compartmentOptions = (...args) => {
  if (args.length === 0) {
    return {};
  }
  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null && "__options__" in args[0]) {
    const { __options__, ...options } = args[0];
    assert(
      __options__ === true,
      `Compartment constructor only supports true __options__ sigil, got ${__options__}`
    );
    return options;
  } else {
    const [
      globals = (
        /** @type {Map<string, any>} */
        {}
      ),
      modules = (
        /** @type {Map<string, ModuleDescriptor>} */
        {}
      ),
      options = {}
    ] = (
      /** @type {LegacyCompartmentOptionsArgs} */
      args
    );
    assertEqual(
      options.modules,
      void 0,
      `Compartment constructor must receive either a module map argument or modules option, not both`
    );
    assertEqual(
      options.globals,
      void 0,
      `Compartment constructor must receive either globals argument or option, not both`
    );
    return {
      ...options,
      globals,
      modules
    };
  }
};
var makeCompartmentConstructor = (targetMakeCompartmentConstructor, intrinsics, markVirtualizedNativeFunction3, { parentCompartment = void 0, enforceNew = false } = {}) => {
  function Compartment3(...args) {
    if (enforceNew && new.target === void 0) {
      throw TypeError2(
        "Class constructor Compartment cannot be invoked without 'new'"
      );
    }
    const {
      name = "<unknown>",
      transforms: transforms2 = [],
      __shimTransforms__ = [],
      globals: endowmentsOption = {},
      modules: moduleMapOption = {},
      resolveHook,
      importHook,
      importNowHook,
      moduleMapHook,
      importMetaHook,
      __noNamespaceBox__: noNamespaceBox = false,
      noAggregateLoadErrors = false
    } = compartmentOptions(
      .../** @type {Parameters<typeof compartmentOptions>} */
      args
    );
    const globalTransforms = arrayFlatMap(
      [transforms2, __shimTransforms__],
      identity
    );
    const endowments = { __proto__: null, ...endowmentsOption };
    const moduleMap = { __proto__: null, ...moduleMapOption };
    const moduleRecords = new Map2();
    const instances = new Map2();
    const deferredExports = new Map2();
    const globalObject = {};
    const compartment = (
      /** @type {Compartment} */
      this
    );
    setGlobalObjectSymbolUnscopables(globalObject);
    setGlobalObjectConstantProperties(globalObject);
    const { safeEvaluate } = makeSafeEvaluator({
      globalObject,
      globalTransforms,
      sloppyGlobalsMode: false
    });
    setGlobalObjectMutableProperties(globalObject, {
      intrinsics,
      newGlobalPropertyNames: sharedGlobalPropertyNames,
      makeCompartmentConstructor: targetMakeCompartmentConstructor,
      parentCompartment: compartment,
      markVirtualizedNativeFunction: markVirtualizedNativeFunction3
    });
    setGlobalObjectEvaluators(
      globalObject,
      safeEvaluate,
      markVirtualizedNativeFunction3
    );
    assign(globalObject, endowments);
    const compartmentImport = async (fullSpecifier) => {
      if (typeof resolveHook !== "function") {
        throw TypeError2(
          `Compartment does not support dynamic import: no configured resolveHook for compartment ${quote(name)}`
        );
      }
      await load(privateFields, moduleAliases, compartment, fullSpecifier, {
        noAggregateErrors: noAggregateLoadErrors
      });
      const { execute, exportsProxy } = link(
        privateFields,
        moduleAliases,
        compartment,
        fullSpecifier
      );
      execute();
      return exportsProxy;
    };
    weakmapSet(privateFields, compartment, {
      name: `${name}`,
      globalTransforms,
      globalObject,
      safeEvaluate,
      resolveHook,
      importHook,
      importNowHook,
      moduleMap,
      moduleMapHook,
      importMetaHook,
      moduleRecords,
      __shimTransforms__,
      deferredExports,
      instances,
      parentCompartment,
      noNamespaceBox,
      compartmentImport,
      noAggregateLoadErrors
    });
  }
  Compartment3.prototype = CompartmentPrototype;
  return Compartment3;
};

// node_modules/ses/src/get-anonymous-intrinsics.js
function getConstructorOf(obj) {
  return getPrototypeOf(obj).constructor;
}
function makeArguments() {
  return arguments;
}
var getAnonymousIntrinsics = () => {
  const InertFunction = FERAL_FUNCTION.prototype.constructor;
  const argsCalleeDesc = getOwnPropertyDescriptor(makeArguments(), "callee");
  const ThrowTypeError = argsCalleeDesc && argsCalleeDesc.get;
  const StringIteratorObject = iterateString(new String2());
  const StringIteratorPrototype = getPrototypeOf(StringIteratorObject);
  const RegExpStringIterator = regexpPrototype[matchAllSymbol] && matchAllRegExp(/./, "");
  const RegExpStringIteratorPrototype = RegExpStringIterator && getPrototypeOf(RegExpStringIterator);
  const ArrayIteratorObject = iterateArray([]);
  const ArrayIteratorPrototype = getPrototypeOf(ArrayIteratorObject);
  const TypedArray2 = getPrototypeOf(FERAL_FLOAT64_ARRAY);
  const MapIteratorObject = iterateMap(new Map2());
  const MapIteratorPrototype = getPrototypeOf(MapIteratorObject);
  const SetIteratorObject = iterateSet(new Set2());
  const SetIteratorPrototype = getPrototypeOf(SetIteratorObject);
  const IteratorPrototype = getPrototypeOf(ArrayIteratorPrototype);
  function* GeneratorFunctionInstance() {
  }
  const GeneratorFunction = getConstructorOf(GeneratorFunctionInstance);
  const Generator = GeneratorFunction.prototype;
  async function AsyncFunctionInstance2() {
  }
  const AsyncFunction = getConstructorOf(AsyncFunctionInstance2);
  const intrinsics = {
    "%InertFunction%": InertFunction,
    "%ArrayIteratorPrototype%": ArrayIteratorPrototype,
    "%InertAsyncFunction%": AsyncFunction,
    "%Generator%": Generator,
    "%InertGeneratorFunction%": GeneratorFunction,
    "%IteratorPrototype%": IteratorPrototype,
    "%MapIteratorPrototype%": MapIteratorPrototype,
    "%RegExpStringIteratorPrototype%": RegExpStringIteratorPrototype,
    "%SetIteratorPrototype%": SetIteratorPrototype,
    "%StringIteratorPrototype%": StringIteratorPrototype,
    "%ThrowTypeError%": ThrowTypeError,
    "%TypedArray%": TypedArray2,
    "%InertCompartment%": InertCompartment
  };
  if (AsyncGeneratorFunctionInstance !== void 0) {
    const AsyncGeneratorFunction = getConstructorOf(
      AsyncGeneratorFunctionInstance
    );
    const AsyncGenerator = AsyncGeneratorFunction.prototype;
    const AsyncGeneratorPrototype = AsyncGenerator.prototype;
    const AsyncIteratorPrototype = getPrototypeOf(AsyncGeneratorPrototype);
    assign(intrinsics, {
      "%AsyncGenerator%": AsyncGenerator,
      "%InertAsyncGeneratorFunction%": AsyncGeneratorFunction,
      "%AsyncGeneratorPrototype%": AsyncGeneratorPrototype,
      "%AsyncIteratorPrototype%": AsyncIteratorPrototype
    });
  }
  if (universalThis.Iterator) {
    intrinsics["%IteratorHelperPrototype%"] = getPrototypeOf(
      // eslint-disable-next-line @endo/no-polymorphic-call
      universalThis.Iterator.from([]).take(0)
    );
    intrinsics["%WrapForValidIteratorPrototype%"] = getPrototypeOf(
      // eslint-disable-next-line @endo/no-polymorphic-call
      universalThis.Iterator.from({
        next() {
          return { value: void 0 };
        }
      })
    );
  }
  if (universalThis.AsyncIterator) {
    intrinsics["%AsyncIteratorHelperPrototype%"] = getPrototypeOf(
      // eslint-disable-next-line @endo/no-polymorphic-call
      universalThis.AsyncIterator.from([]).take(0)
    );
    intrinsics["%WrapForValidAsyncIteratorPrototype%"] = getPrototypeOf(
      // eslint-disable-next-line @endo/no-polymorphic-call
      universalThis.AsyncIterator.from({ next() {
      } })
    );
  }
  return intrinsics;
};

// node_modules/ses/src/tame-harden.js
var tameHarden = (safeHarden2, hardenTaming) => {
  if (hardenTaming === "safe") {
    return safeHarden2;
  }
  Object.isExtensible = () => false;
  Object.isFrozen = () => true;
  Object.isSealed = () => true;
  Reflect.isExtensible = () => false;
  if (safeHarden2.isFake) {
    return safeHarden2;
  }
  const fakeHarden = (arg) => arg;
  fakeHarden.isFake = true;
  return freeze(fakeHarden);
};
freeze(tameHarden);

// node_modules/ses/src/tame-symbol-constructor.js
var tameSymbolConstructor = () => {
  const OriginalSymbol = Symbol2;
  const SymbolPrototype = OriginalSymbol.prototype;
  const SharedSymbol = functionBind(Symbol2, void 0);
  defineProperties(SymbolPrototype, {
    constructor: {
      value: SharedSymbol
      // leave other `constructor` attributes as is
    }
  });
  const originalDescsEntries = entries(
    getOwnPropertyDescriptors(OriginalSymbol)
  );
  const descs = fromEntries(
    arrayMap(originalDescsEntries, ([name, desc]) => [
      name,
      { ...desc, configurable: true }
    ])
  );
  defineProperties(SharedSymbol, descs);
  return { "%SharedSymbol%": SharedSymbol };
};

// node_modules/ses/src/tame-faux-data-properties.js
var throws = (thunk) => {
  try {
    thunk();
    return false;
  } catch (_err) {
    return true;
  }
};
var tameFauxDataProperty = (obj, prop, expectedValue) => {
  if (obj === void 0) {
    return false;
  }
  const desc = getOwnPropertyDescriptor(obj, prop);
  if (!desc || "value" in desc) {
    return false;
  }
  const { get, set } = desc;
  if (typeof get !== "function" || typeof set !== "function") {
    return false;
  }
  if (get() !== expectedValue) {
    return false;
  }
  if (apply(get, obj, []) !== expectedValue) {
    return false;
  }
  const testValue = "Seems to be a setter";
  const subject1 = { __proto__: null };
  apply(set, subject1, [testValue]);
  if (subject1[prop] !== testValue) {
    return false;
  }
  const subject2 = { __proto__: obj };
  apply(set, subject2, [testValue]);
  if (subject2[prop] !== testValue) {
    return false;
  }
  if (!throws(() => apply(set, obj, [expectedValue]))) {
    return false;
  }
  if ("originalValue" in get) {
    return false;
  }
  if (desc.configurable === false) {
    return false;
  }
  defineProperty(obj, prop, {
    value: expectedValue,
    writable: true,
    enumerable: desc.enumerable,
    configurable: true
  });
  return true;
};
var tameFauxDataProperties = (intrinsics) => {
  tameFauxDataProperty(
    intrinsics["%IteratorPrototype%"],
    "constructor",
    intrinsics.Iterator
  );
  tameFauxDataProperty(
    intrinsics["%IteratorPrototype%"],
    toStringTagSymbol,
    "Iterator"
  );
};

// node_modules/ses/src/tame-regenerator-runtime.js
var tameRegeneratorRuntime = () => {
  const iter = iteratorPrototype[iteratorSymbol];
  defineProperty(iteratorPrototype, iteratorSymbol, {
    configurable: true,
    get() {
      return iter;
    },
    set(value) {
      if (this === iteratorPrototype) return;
      if (hasOwn(this, iteratorSymbol)) {
        this[iteratorSymbol] = value;
      }
      defineProperty(this, iteratorSymbol, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
  });
};

// node_modules/ses/src/shim-arraybuffer-transfer.js
var shimArrayBufferTransfer = () => {
  if (typeof arrayBufferPrototype.transfer === "function") {
    return {};
  }
  const clone = universalThis.structuredClone;
  if (typeof clone !== "function") {
    return {};
  }
  const methods2 = {
    /**
     * @param {number} [newLength]
     */
    transfer(newLength = void 0) {
      const oldLength = arrayBufferGetByteLength(this);
      if (newLength === void 0 || newLength === oldLength) {
        return clone(this, { transfer: [this] });
      }
      if (typeof newLength !== "number") {
        throw TypeError2(`transfer newLength if provided must be a number`);
      }
      if (newLength > oldLength) {
        const result = new ArrayBuffer(newLength);
        const taOld = new Uint8Array2(this);
        const taNew = new Uint8Array2(result);
        typedArraySet(taNew, taOld);
        clone(this, { transfer: [this] });
        return result;
      } else {
        const result = arrayBufferSlice(this, 0, newLength);
        clone(this, { transfer: [this] });
        return result;
      }
    }
  };
  defineProperty(arrayBufferPrototype, "transfer", {
    // @ts-expect-error
    value: methods2.transfer,
    writable: true,
    enumerable: false,
    configurable: true
  });
  return {};
};

// node_modules/ses/src/reporting.js
var consoleReporter = {
  warn(...args) {
    universalThis.console.warn(...args);
  },
  error(...args) {
    universalThis.console.error(...args);
  },
  ...universalThis.console?.groupCollapsed ? {
    groupCollapsed(...args) {
      universalThis.console.groupCollapsed(...args);
    }
  } : void 0,
  ...universalThis.console?.groupEnd ? {
    groupEnd() {
      universalThis.console.groupEnd();
    }
  } : void 0
};
var makeReportPrinter = (print) => {
  let indent = false;
  const printIndent = (...args) => {
    if (indent) {
      print(" ", ...args);
    } else {
      print(...args);
    }
  };
  return (
    /** @type {GroupReporter} */
    {
      warn(...args) {
        printIndent(...args);
      },
      error(...args) {
        printIndent(...args);
      },
      groupCollapsed(...args) {
        assert(!indent);
        print(...args);
        indent = true;
      },
      groupEnd() {
        indent = false;
      }
    }
  );
};
var mute = () => {
};
var chooseReporter = (reporting) => {
  if (reporting === "none") {
    return makeReportPrinter(mute);
  }
  if (universalThis.console !== void 0) {
    if (reporting === "console" || // asks for console explicitly
    universalThis.window === universalThis || // likely on browser
    universalThis.importScripts !== void 0) {
      return consoleReporter;
    }
    assert(reporting === "platform");
    return makeReportPrinter(consoleReporter.error);
  }
  if (universalThis.print !== void 0) {
    return makeReportPrinter(universalThis.print);
  }
  return makeReportPrinter(mute);
};
var reportInGroup = (groupLabel, console2, callback) => {
  const { warn, error, groupCollapsed, groupEnd } = console2;
  const grouping = groupCollapsed && groupEnd;
  let groupStarted = false;
  try {
    return callback({
      warn(...args) {
        if (grouping && !groupStarted) {
          groupCollapsed(groupLabel);
          groupStarted = true;
        }
        warn(...args);
      },
      error(...args) {
        if (grouping && !groupStarted) {
          groupCollapsed(groupLabel);
          groupStarted = true;
        }
        error(...args);
      }
    });
  } finally {
    if (grouping && groupStarted) {
      groupEnd();
      groupStarted = false;
    }
  }
};

// node_modules/ses/src/lockdown.js
var { Fail: Fail8, details: X, quote: q7 } = assert;
var priorRepairIntrinsics;
var priorHardenIntrinsics;
var safeHarden = makeHardener();
var probeHostEvaluators = () => {
  let functionAllowed;
  try {
    functionAllowed = FERAL_FUNCTION("return true")();
  } catch (_error) {
    functionAllowed = false;
  }
  let evalAllowed;
  try {
    evalAllowed = FERAL_EVAL("true");
  } catch (_error) {
    evalAllowed = false;
  }
  let directEvalAllowed;
  if (functionAllowed && evalAllowed) {
    directEvalAllowed = FERAL_FUNCTION(
      "eval",
      "SES_changed",
      `        eval("SES_changed = true");
        return SES_changed;
      `
    )(FERAL_EVAL, false);
    if (!directEvalAllowed) {
      delete universalThis.SES_changed;
    }
  }
  return { functionAllowed, evalAllowed, directEvalAllowed };
};
var repairIntrinsics = (options = {}) => {
  const {
    errorTaming = (
      /** @type {'safe' | 'unsafe' | 'unsafe-debug'} */
      getEnvironmentOption("LOCKDOWN_ERROR_TAMING", "safe", ["unsafe", "unsafe-debug"])
    ),
    errorTrapping = (
      /** @type {'platform' | 'none' | 'report' | 'abort' | 'exit'} */
      getEnvironmentOption("LOCKDOWN_ERROR_TRAPPING", "platform", [
        "none",
        "report",
        "abort",
        "exit"
      ])
    ),
    reporting = (
      /** @type {'platform' | 'console' | 'none'} */
      getEnvironmentOption("LOCKDOWN_REPORTING", "platform", ["console", "none"])
    ),
    unhandledRejectionTrapping = (
      /** @type {'none' | 'report'} */
      getEnvironmentOption("LOCKDOWN_UNHANDLED_REJECTION_TRAPPING", "report", ["none"])
    ),
    regExpTaming = (
      /** @type {'safe' | 'unsafe'} */
      getEnvironmentOption("LOCKDOWN_REGEXP_TAMING", "safe", ["unsafe"])
    ),
    localeTaming = (
      /** @type {'safe' | 'unsafe'} */
      getEnvironmentOption("LOCKDOWN_LOCALE_TAMING", "safe", ["unsafe"])
    ),
    consoleTaming = (
      /** @type {'unsafe' | 'safe'} */
      getEnvironmentOption("LOCKDOWN_CONSOLE_TAMING", "safe", ["unsafe"])
    ),
    overrideTaming = (
      /** @type {'moderate' | 'min' | 'severe'} */
      getEnvironmentOption("LOCKDOWN_OVERRIDE_TAMING", "moderate", ["min", "severe"])
    ),
    stackFiltering = (
      /** @type {'concise' | 'omit-frames' | 'shorten-paths' | 'verbose'} */
      getEnvironmentOption("LOCKDOWN_STACK_FILTERING", "concise", [
        "omit-frames",
        "shorten-paths",
        "verbose"
      ])
    ),
    domainTaming = (
      /** @type {'safe' | 'unsafe'} */
      getEnvironmentOption("LOCKDOWN_DOMAIN_TAMING", "safe", ["unsafe"])
    ),
    evalTaming = (
      /** @type {'safe-eval' | 'unsafe-eval' | 'no-eval'} */
      getEnvironmentOption("LOCKDOWN_EVAL_TAMING", "safe-eval", [
        "unsafe-eval",
        "no-eval",
        // deprecated
        "safeEval",
        "unsafeEval",
        "noEval"
      ])
    ),
    overrideDebug = (
      /** @type {string[]} */
      arrayFilter(
        stringSplit(getEnvironmentOption("LOCKDOWN_OVERRIDE_DEBUG", ""), ","),
        /** @param {string} debugName */
        (debugName) => debugName !== ""
      )
    ),
    legacyRegeneratorRuntimeTaming = (
      /** @type {'safe' | 'unsafe-ignore'} */
      getEnvironmentOption("LOCKDOWN_LEGACY_REGENERATOR_RUNTIME_TAMING", "safe", [
        "unsafe-ignore"
      ])
    ),
    __hardenTaming__ = (
      /** @type {'safe' | 'unsafe'} */
      getEnvironmentOption("LOCKDOWN_HARDEN_TAMING", "safe", ["unsafe"])
    ),
    dateTaming,
    // deprecated
    mathTaming,
    // deprecated
    ...extraOptions
  } = options;
  const extraOptionsNames = ownKeys(extraOptions);
  extraOptionsNames.length === 0 || Fail8`lockdown(): non supported option ${q7(extraOptionsNames)}`;
  const reporter = chooseReporter(reporting);
  const { warn } = reporter;
  if (dateTaming !== void 0) {
    warn(
      `SES The 'dateTaming' option is deprecated and does nothing. In the future specifying it will be an error.`
    );
  }
  if (mathTaming !== void 0) {
    warn(
      `SES The 'mathTaming' option is deprecated and does nothing. In the future specifying it will be an error.`
    );
  }
  priorRepairIntrinsics === void 0 || // eslint-disable-next-line @endo/no-polymorphic-call
  assert.fail(
    X`Already locked down at ${priorRepairIntrinsics} (SES_ALREADY_LOCKED_DOWN)`,
    TypeError2
  );
  priorRepairIntrinsics = TypeError2("Prior lockdown (SES_ALREADY_LOCKED_DOWN)");
  priorRepairIntrinsics.stack;
  const { functionAllowed, evalAllowed, directEvalAllowed } = probeHostEvaluators();
  if (directEvalAllowed === false && evalTaming === "safe-eval" && (functionAllowed || evalAllowed)) {
    throw TypeError2(
      "SES cannot initialize unless 'eval' is the original intrinsic 'eval', suitable for direct eval (dynamically scoped eval) (SES_DIRECT_EVAL)"
    );
  }
  const seemsToBeLockedDown = () => {
    return universalThis.Function.prototype.constructor !== universalThis.Function && // @ts-ignore harden is absent on globalThis type def.
    typeof universalThis.harden === "function" && // @ts-ignore lockdown is absent on globalThis type def.
    typeof universalThis.lockdown === "function" && universalThis.Date.prototype.constructor !== universalThis.Date && typeof universalThis.Date.now === "function" && // @ts-ignore does not recognize that Date constructor is a special
    // Function.
    // eslint-disable-next-line @endo/no-polymorphic-call
    is(universalThis.Date.prototype.constructor.now(), NaN);
  };
  if (seemsToBeLockedDown()) {
    throw TypeError2(
      `Already locked down but not by this SES instance (SES_MULTIPLE_INSTANCES)`
    );
  }
  tameDomains(domainTaming);
  const markVirtualizedNativeFunction3 = tameFunctionToString();
  const { addIntrinsics, completePrototypes, finalIntrinsics } = makeIntrinsicsCollector(reporter);
  const tamedHarden = tameHarden(safeHarden, __hardenTaming__);
  addIntrinsics({ harden: tamedHarden });
  addIntrinsics(tameFunctionConstructors());
  addIntrinsics(tameDateConstructor());
  addIntrinsics(tameErrorConstructor(errorTaming, stackFiltering));
  addIntrinsics(tameMathObject());
  addIntrinsics(tame_temporal_object_default());
  tameNaNSideChannel();
  addIntrinsics(tameRegExpConstructor(regExpTaming));
  addIntrinsics(tameSymbolConstructor());
  addIntrinsics(shimArrayBufferTransfer());
  addIntrinsics(tameModuleSource());
  addIntrinsics(getAnonymousIntrinsics());
  completePrototypes();
  const intrinsics = finalIntrinsics();
  const symbolForHarden = symbolFor("harden");
  const priorHarden = intrinsics.Object[symbolForHarden];
  if (priorHarden) {
    if (priorHarden.lockdownError) {
      throw priorHarden.lockdownError;
    }
    throw new TypeError2(
      "Cannot lockdown (repairIntrinsics) if a prior harden implementation has been used and installed. Check for libraries using @endo/harden before lockdown."
    );
  }
  intrinsics.Object[symbolForHarden] = tamedHarden;
  const hostIntrinsics = { __proto__: null };
  if (typeof universalThis.Buffer === "function") {
    hostIntrinsics.Buffer = universalThis.Buffer;
  }
  let optGetStackString;
  if (errorTaming === "safe") {
    optGetStackString = intrinsics["%InitialGetStackString%"];
  }
  const consoleRecord = tameConsole(
    consoleTaming,
    errorTrapping,
    unhandledRejectionTrapping,
    optGetStackString
  );
  universalThis.console = /** @type {Console} */
  consoleRecord.console;
  if (typeof /** @type {any} */
  consoleRecord.console._times === "object") {
    hostIntrinsics.SafeMap = getPrototypeOf(
      // eslint-disable-next-line no-underscore-dangle
      /** @type {any} */
      consoleRecord.console._times
    );
  }
  if (errorTaming !== "unsafe" && errorTaming !== "unsafe-debug") {
    universalThis.assert = makeAssert();
  }
  tameLocaleMethods(intrinsics, localeTaming);
  tameFauxDataProperties(intrinsics);
  reportInGroup(
    "SES Removing unpermitted intrinsics",
    reporter,
    (groupReporter) => removeUnpermittedIntrinsics(
      intrinsics,
      markVirtualizedNativeFunction3,
      groupReporter
    )
  );
  setGlobalObjectConstantProperties(universalThis);
  setGlobalObjectMutableProperties(universalThis, {
    intrinsics,
    newGlobalPropertyNames: initialGlobalPropertyNames,
    makeCompartmentConstructor,
    markVirtualizedNativeFunction: markVirtualizedNativeFunction3
  });
  if (evalTaming === "no-eval" || // deprecated
  evalTaming === "noEval") {
    setGlobalObjectEvaluators(
      universalThis,
      noEvalEvaluate,
      markVirtualizedNativeFunction3
    );
  } else if (evalTaming === "safe-eval" || // deprecated
  evalTaming === "safeEval") {
    const { safeEvaluate } = makeSafeEvaluator({ globalObject: universalThis });
    setGlobalObjectEvaluators(
      universalThis,
      safeEvaluate,
      markVirtualizedNativeFunction3
    );
  } else if (evalTaming === "unsafe-eval" || // deprecated
  evalTaming === "unsafeEval") {
  }
  const hardenIntrinsics = () => {
    priorHardenIntrinsics === void 0 || // eslint-disable-next-line @endo/no-polymorphic-call
    assert.fail(
      X`Already locked down at ${priorHardenIntrinsics} (SES_ALREADY_LOCKED_DOWN)`,
      TypeError2
    );
    priorHardenIntrinsics = TypeError2(
      "Prior lockdown (SES_ALREADY_LOCKED_DOWN)"
    );
    priorHardenIntrinsics.stack;
    reportInGroup(
      "SES Enabling property overrides",
      reporter,
      (groupReporter) => enablePropertyOverrides(
        intrinsics,
        overrideTaming,
        groupReporter,
        overrideDebug
      )
    );
    if (legacyRegeneratorRuntimeTaming === "unsafe-ignore") {
      tameRegeneratorRuntime();
    }
    const toHarden = {
      intrinsics,
      hostIntrinsics,
      globals: {
        // Harden evaluators
        Function: universalThis.Function,
        eval: universalThis.eval,
        // @ts-ignore Compartment does exist on globalThis
        Compartment: universalThis.Compartment,
        // Harden Symbol
        Symbol: universalThis.Symbol
      }
    };
    for (const prop of getOwnPropertyNames(initialGlobalPropertyNames)) {
      toHarden.globals[prop] = universalThis[prop];
    }
    tamedHarden(toHarden);
    return tamedHarden;
  };
  return hardenIntrinsics;
};

// node_modules/ses/src/lockdown-shim.js
universalThis.lockdown = (options) => {
  const hardenIntrinsics = repairIntrinsics(options);
  universalThis.harden = hardenIntrinsics();
};
universalThis.repairIntrinsics = (options) => {
  const hardenIntrinsics = repairIntrinsics(options);
  universalThis.hardenIntrinsics = () => {
    universalThis.harden = hardenIntrinsics();
  };
};

// node_modules/ses/src/compartment-shim.js
var markVirtualizedNativeFunction2 = tameFunctionToString();
var muteReporter = chooseReporter("none");
universalThis.Compartment = makeCompartmentConstructor(
  makeCompartmentConstructor,
  // Any reporting that would need to be done should have already been done
  // during `lockdown()`.
  // See https://github.com/endojs/endo/pull/2624#discussion_r1840979770
  getGlobalIntrinsics(universalThis, muteReporter),
  markVirtualizedNativeFunction2,
  {
    enforceNew: true
  }
);

// node_modules/ses/src/assert-shim.js
universalThis.assert = makeAssert(void 0, true);

// node_modules/ses/src/console-shim.js
var makeCausalConsoleFromLoggerForSesAva = defineCausalConsoleFromLogger(loggedErrorHandler);
var MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA = symbolFor(
  "MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA"
);
universalThis[MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA] = makeCausalConsoleFromLoggerForSesAva;

// packages/runtime-javascript/src/ses-algorithm-worker-entry.ts
lockdown();
await Promise.resolve().then(() => (init_ses_algorithm_worker(), ses_algorithm_worker_exports));

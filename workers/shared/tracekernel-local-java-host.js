// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Function.js
var isFunction = (input) => typeof input === "function";
var dual = function(arity, body) {
  if (typeof arity === "function") {
    return function() {
      if (arity(arguments)) {
        return body.apply(this, arguments);
      }
      return (self) => body(self, ...arguments);
    };
  }
  switch (arity) {
    case 0:
    case 1:
      throw new RangeError(`Invalid arity ${arity}`);
    case 2:
      return function(a, b) {
        if (arguments.length >= 2) {
          return body(a, b);
        }
        return function(self) {
          return body(self, a);
        };
      };
    case 3:
      return function(a, b, c) {
        if (arguments.length >= 3) {
          return body(a, b, c);
        }
        return function(self) {
          return body(self, a, b);
        };
      };
    case 4:
      return function(a, b, c, d) {
        if (arguments.length >= 4) {
          return body(a, b, c, d);
        }
        return function(self) {
          return body(self, a, b, c);
        };
      };
    case 5:
      return function(a, b, c, d, e) {
        if (arguments.length >= 5) {
          return body(a, b, c, d, e);
        }
        return function(self) {
          return body(self, a, b, c, d);
        };
      };
    default:
      return function() {
        if (arguments.length >= arity) {
          return body.apply(this, arguments);
        }
        const args2 = arguments;
        return function(self) {
          return body(self, ...args2);
        };
      };
  }
};
var identity = (a) => a;
var constant = (value) => () => value;
var constTrue = /* @__PURE__ */ constant(true);
var constFalse = /* @__PURE__ */ constant(false);
var constUndefined = /* @__PURE__ */ constant(void 0);
var constVoid = constUndefined;
function pipe(a, ab, bc, cd, de, ef, fg, gh, hi) {
  switch (arguments.length) {
    case 1:
      return a;
    case 2:
      return ab(a);
    case 3:
      return bc(ab(a));
    case 4:
      return cd(bc(ab(a)));
    case 5:
      return de(cd(bc(ab(a))));
    case 6:
      return ef(de(cd(bc(ab(a)))));
    case 7:
      return fg(ef(de(cd(bc(ab(a))))));
    case 8:
      return gh(fg(ef(de(cd(bc(ab(a)))))));
    case 9:
      return hi(gh(fg(ef(de(cd(bc(ab(a))))))));
    default: {
      let ret = arguments[0];
      for (let i = 1; i < arguments.length; i++) {
        ret = arguments[i](ret);
      }
      return ret;
    }
  }
}

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Equivalence.js
var make = (isEquivalent) => (self, that) => self === that || isEquivalent(self, that);
var mapInput = /* @__PURE__ */ dual(2, (self, f) => make((x, y) => self(f(x), f(y))));
var array = (item) => make((self, that) => {
  if (self.length !== that.length) {
    return false;
  }
  for (let i = 0; i < self.length; i++) {
    const isEq = item(self[i], that[i]);
    if (!isEq) {
      return false;
    }
  }
  return true;
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/GlobalValue.js
var globalStoreId = `effect/GlobalValue`;
var globalStore;
var globalValue = (id2, compute) => {
  if (!globalStore) {
    globalThis[globalStoreId] ??= /* @__PURE__ */ new Map();
    globalStore = globalThis[globalStoreId];
  }
  if (!globalStore.has(id2)) {
    globalStore.set(id2, compute());
  }
  return globalStore.get(id2);
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Predicate.js
var isString = (input) => typeof input === "string";
var isNumber = (input) => typeof input === "number";
var isBigInt = (input) => typeof input === "bigint";
var isFunction2 = isFunction;
var isRecordOrArray = (input) => typeof input === "object" && input !== null;
var isObject = (input) => isRecordOrArray(input) || isFunction2(input);
var hasProperty = /* @__PURE__ */ dual(2, (self, property) => isObject(self) && property in self);
var isTagged = /* @__PURE__ */ dual(2, (self, tag) => hasProperty(self, "_tag") && self["_tag"] === tag);
var isNullable = (input) => input === null || input === void 0;
var isIterable = (input) => typeof input === "string" || hasProperty(input, Symbol.iterator);
var isPromiseLike = (input) => hasProperty(input, "then") && isFunction2(input.then);

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/errors.js
var getBugErrorMessage = (message) => `BUG: ${message} - please report an issue at https://github.com/Effect-TS/effect/issues`;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Utils.js
var GenKindTypeId = /* @__PURE__ */ Symbol.for("effect/Gen/GenKind");
var GenKindImpl = class {
  value;
  constructor(value) {
    this.value = value;
  }
  /**
   * @since 2.0.0
   */
  get _F() {
    return identity;
  }
  /**
   * @since 2.0.0
   */
  get _R() {
    return (_) => _;
  }
  /**
   * @since 2.0.0
   */
  get _O() {
    return (_) => _;
  }
  /**
   * @since 2.0.0
   */
  get _E() {
    return (_) => _;
  }
  /**
   * @since 2.0.0
   */
  [GenKindTypeId] = GenKindTypeId;
  /**
   * @since 2.0.0
   */
  [Symbol.iterator]() {
    return new SingleShotGen(this);
  }
};
var SingleShotGen = class _SingleShotGen {
  self;
  called = false;
  constructor(self) {
    this.self = self;
  }
  /**
   * @since 2.0.0
   */
  next(a) {
    return this.called ? {
      value: a,
      done: true
    } : (this.called = true, {
      value: this.self,
      done: false
    });
  }
  /**
   * @since 2.0.0
   */
  return(a) {
    return {
      value: a,
      done: true
    };
  }
  /**
   * @since 2.0.0
   */
  throw(e) {
    throw e;
  }
  /**
   * @since 2.0.0
   */
  [Symbol.iterator]() {
    return new _SingleShotGen(this.self);
  }
};
var defaultIncHi = 335903614;
var defaultIncLo = 4150755663;
var MUL_HI = 1481765933 >>> 0;
var MUL_LO = 1284865837 >>> 0;
var BIT_53 = 9007199254740992;
var BIT_27 = 134217728;
var PCGRandom = class {
  _state;
  constructor(seedHi, seedLo, incHi, incLo) {
    if (isNullable(seedLo) && isNullable(seedHi)) {
      seedLo = Math.random() * 4294967295 >>> 0;
      seedHi = 0;
    } else if (isNullable(seedLo)) {
      seedLo = seedHi;
      seedHi = 0;
    }
    if (isNullable(incLo) && isNullable(incHi)) {
      incLo = this._state ? this._state[3] : defaultIncLo;
      incHi = this._state ? this._state[2] : defaultIncHi;
    } else if (isNullable(incLo)) {
      incLo = incHi;
      incHi = 0;
    }
    this._state = new Int32Array([0, 0, incHi >>> 0, ((incLo || 0) | 1) >>> 0]);
    this._next();
    add64(this._state, this._state[0], this._state[1], seedHi >>> 0, seedLo >>> 0);
    this._next();
    return this;
  }
  /**
   * Returns a copy of the internal state of this random number generator as a
   * JavaScript Array.
   *
   * @category getters
   * @since 2.0.0
   */
  getState() {
    return [this._state[0], this._state[1], this._state[2], this._state[3]];
  }
  /**
   * Restore state previously retrieved using `getState()`.
   *
   * @since 2.0.0
   */
  setState(state) {
    this._state[0] = state[0];
    this._state[1] = state[1];
    this._state[2] = state[2];
    this._state[3] = state[3] | 1;
  }
  /**
   * Get a uniformly distributed 32 bit integer between [0, max).
   *
   * @category getter
   * @since 2.0.0
   */
  integer(max2) {
    return Math.round(this.number() * Number.MAX_SAFE_INTEGER) % max2;
  }
  /**
   * Get a uniformly distributed IEEE-754 double between 0.0 and 1.0, with
   * 53 bits of precision (every bit of the mantissa is randomized).
   *
   * @category getters
   * @since 2.0.0
   */
  number() {
    const hi = (this._next() & 67108863) * 1;
    const lo = (this._next() & 134217727) * 1;
    return (hi * BIT_27 + lo) / BIT_53;
  }
  /** @internal */
  _next() {
    const oldHi = this._state[0] >>> 0;
    const oldLo = this._state[1] >>> 0;
    mul64(this._state, oldHi, oldLo, MUL_HI, MUL_LO);
    add64(this._state, this._state[0], this._state[1], this._state[2], this._state[3]);
    let xsHi = oldHi >>> 18;
    let xsLo = (oldLo >>> 18 | oldHi << 14) >>> 0;
    xsHi = (xsHi ^ oldHi) >>> 0;
    xsLo = (xsLo ^ oldLo) >>> 0;
    const xorshifted = (xsLo >>> 27 | xsHi << 5) >>> 0;
    const rot = oldHi >>> 27;
    const rot2 = (-rot >>> 0 & 31) >>> 0;
    return (xorshifted >>> rot | xorshifted << rot2) >>> 0;
  }
};
function mul64(out, aHi, aLo, bHi, bLo) {
  let c1 = (aLo >>> 16) * (bLo & 65535) >>> 0;
  let c0 = (aLo & 65535) * (bLo >>> 16) >>> 0;
  let lo = (aLo & 65535) * (bLo & 65535) >>> 0;
  let hi = (aLo >>> 16) * (bLo >>> 16) + ((c0 >>> 16) + (c1 >>> 16)) >>> 0;
  c0 = c0 << 16 >>> 0;
  lo = lo + c0 >>> 0;
  if (lo >>> 0 < c0 >>> 0) {
    hi = hi + 1 >>> 0;
  }
  c1 = c1 << 16 >>> 0;
  lo = lo + c1 >>> 0;
  if (lo >>> 0 < c1 >>> 0) {
    hi = hi + 1 >>> 0;
  }
  hi = hi + Math.imul(aLo, bHi) >>> 0;
  hi = hi + Math.imul(aHi, bLo) >>> 0;
  out[0] = hi;
  out[1] = lo;
}
function add64(out, aHi, aLo, bHi, bLo) {
  let hi = aHi + bHi >>> 0;
  const lo = aLo + bLo >>> 0;
  if (lo >>> 0 < aLo >>> 0) {
    hi = hi + 1 | 0;
  }
  out[0] = hi;
  out[1] = lo;
}
var YieldWrapTypeId = /* @__PURE__ */ Symbol.for("effect/Utils/YieldWrap");
var YieldWrap = class {
  /**
   * @since 3.0.6
   */
  #value;
  constructor(value) {
    this.#value = value;
  }
  /**
   * @since 3.0.6
   */
  [YieldWrapTypeId]() {
    return this.#value;
  }
};
function yieldWrapGet(self) {
  if (typeof self === "object" && self !== null && YieldWrapTypeId in self) {
    return self[YieldWrapTypeId]();
  }
  throw new Error(getBugErrorMessage("yieldWrapGet"));
}
var structuralRegionState = /* @__PURE__ */ globalValue("effect/Utils/isStructuralRegion", () => ({
  enabled: false,
  tester: void 0
}));
var standard = {
  effect_internal_function: (body) => {
    return body();
  }
};
var forced = {
  effect_internal_function: (body) => {
    try {
      return body();
    } finally {
    }
  }
};
var isNotOptimizedAway = /* @__PURE__ */ standard.effect_internal_function(() => new Error().stack)?.includes("effect_internal_function") === true;
var internalCall = isNotOptimizedAway ? standard.effect_internal_function : forced.effect_internal_function;
var genConstructor = function* () {
}.constructor;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Hash.js
var randomHashCache = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/Hash/randomHashCache"), () => /* @__PURE__ */ new WeakMap());
var symbol = /* @__PURE__ */ Symbol.for("effect/Hash");
var hash = (self) => {
  if (structuralRegionState.enabled === true) {
    return 0;
  }
  switch (typeof self) {
    case "number":
      return number(self);
    case "bigint":
      return string(self.toString(10));
    case "boolean":
      return string(String(self));
    case "symbol":
      return string(String(self));
    case "string":
      return string(self);
    case "undefined":
      return string("undefined");
    case "function":
    case "object": {
      if (self === null) {
        return string("null");
      } else if (self instanceof Date) {
        if (Number.isNaN(self.getTime())) {
          return string("Invalid Date");
        }
        return hash(self.toISOString());
      } else if (self instanceof URL) {
        return hash(self.href);
      } else if (isHash(self)) {
        return self[symbol]();
      } else {
        return random(self);
      }
    }
    default:
      throw new Error(`BUG: unhandled typeof ${typeof self} - please report an issue at https://github.com/Effect-TS/effect/issues`);
  }
};
var random = (self) => {
  if (!randomHashCache.has(self)) {
    randomHashCache.set(self, number(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)));
  }
  return randomHashCache.get(self);
};
var combine = (b) => (self) => self * 53 ^ b;
var optimize = (n) => n & 3221225471 | n >>> 1 & 1073741824;
var isHash = (u) => hasProperty(u, symbol);
var number = (n) => {
  if (n !== n || n === Infinity) {
    return 0;
  }
  let h = n | 0;
  if (h !== n) {
    h ^= n * 4294967295;
  }
  while (n > 4294967295) {
    h ^= n /= 4294967295;
  }
  return optimize(h);
};
var string = (str) => {
  let h = 5381, i = str.length;
  while (i) {
    h = h * 33 ^ str.charCodeAt(--i);
  }
  return optimize(h);
};
var structureKeys = (o, keys5) => {
  let h = 12289;
  for (let i = 0; i < keys5.length; i++) {
    h ^= pipe(string(keys5[i]), combine(hash(o[keys5[i]])));
  }
  return optimize(h);
};
var structure = (o) => structureKeys(o, Object.keys(o));
var array2 = (arr) => {
  let h = 6151;
  for (let i = 0; i < arr.length; i++) {
    h = pipe(h, combine(hash(arr[i])));
  }
  return optimize(h);
};
var cached = function() {
  if (arguments.length === 1) {
    const self2 = arguments[0];
    return function(hash3) {
      Object.defineProperty(self2, symbol, {
        value() {
          return hash3;
        },
        enumerable: false
      });
      return hash3;
    };
  }
  const self = arguments[0];
  const hash2 = arguments[1];
  Object.defineProperty(self, symbol, {
    value() {
      return hash2;
    },
    enumerable: false
  });
  return hash2;
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Equal.js
var symbol2 = /* @__PURE__ */ Symbol.for("effect/Equal");
function equals() {
  if (arguments.length === 1) {
    return (self) => compareBoth(self, arguments[0]);
  }
  return compareBoth(arguments[0], arguments[1]);
}
function compareBoth(self, that) {
  if (self === that) {
    return true;
  }
  const selfType = typeof self;
  if (selfType !== typeof that) {
    return false;
  }
  if (selfType === "object" || selfType === "function") {
    if (self !== null && that !== null) {
      if (isEqual(self) && isEqual(that)) {
        if (hash(self) === hash(that) && self[symbol2](that)) {
          return true;
        } else {
          return structuralRegionState.enabled && structuralRegionState.tester ? structuralRegionState.tester(self, that) : false;
        }
      } else if (self instanceof Date && that instanceof Date) {
        const t1 = self.getTime();
        const t2 = that.getTime();
        return t1 === t2 || Number.isNaN(t1) && Number.isNaN(t2);
      } else if (self instanceof URL && that instanceof URL) {
        return self.href === that.href;
      }
    }
    if (structuralRegionState.enabled) {
      if (self === null || that === null) {
        return false;
      }
      if (Array.isArray(self) && Array.isArray(that)) {
        return self.length === that.length && self.every((v, i) => compareBoth(v, that[i]));
      }
      if (Object.getPrototypeOf(self) === Object.prototype && Object.getPrototypeOf(that) === Object.prototype) {
        const keysSelf = Object.keys(self);
        const keysThat = Object.keys(that);
        if (keysSelf.length === keysThat.length) {
          for (const key of keysSelf) {
            if (!(key in that && compareBoth(self[key], that[key]))) {
              return structuralRegionState.tester ? structuralRegionState.tester(self, that) : false;
            }
          }
          return true;
        }
      }
      return structuralRegionState.tester ? structuralRegionState.tester(self, that) : false;
    }
  }
  return structuralRegionState.enabled && structuralRegionState.tester ? structuralRegionState.tester(self, that) : false;
}
var isEqual = (u) => hasProperty(u, symbol2);
var equivalence = () => equals;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Inspectable.js
var NodeInspectSymbol = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");
var toJSON = (x) => {
  try {
    if (hasProperty(x, "toJSON") && isFunction2(x["toJSON"]) && x["toJSON"].length === 0) {
      return x.toJSON();
    } else if (Array.isArray(x)) {
      return x.map(toJSON);
    }
  } catch {
    return {};
  }
  return redact(x);
};
var format = (x) => JSON.stringify(x, null, 2);
var BaseProto = {
  toJSON() {
    return toJSON(this);
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  toString() {
    return format(this.toJSON());
  }
};
var Class = class {
  /**
   * @since 2.0.0
   */
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
  /**
   * @since 2.0.0
   */
  toString() {
    return format(this.toJSON());
  }
};
var toStringUnknown = (u, whitespace = 2) => {
  if (typeof u === "string") {
    return u;
  }
  try {
    return typeof u === "object" ? stringifyCircular(u, whitespace) : String(u);
  } catch {
    return String(u);
  }
};
var stringifyCircular = (obj, whitespace) => {
  let cache = [];
  const retVal = JSON.stringify(obj, (_key, value) => typeof value === "object" && value !== null ? cache.includes(value) ? void 0 : cache.push(value) && (redactableState.fiberRefs !== void 0 && isRedactable(value) ? value[symbolRedactable](redactableState.fiberRefs) : value) : value, whitespace);
  cache = void 0;
  return retVal;
};
var symbolRedactable = /* @__PURE__ */ Symbol.for("effect/Inspectable/Redactable");
var isRedactable = (u) => typeof u === "object" && u !== null && symbolRedactable in u;
var redactableState = /* @__PURE__ */ globalValue("effect/Inspectable/redactableState", () => ({
  fiberRefs: void 0
}));
var withRedactableContext = (context2, f) => {
  const prev = redactableState.fiberRefs;
  redactableState.fiberRefs = context2;
  try {
    return f();
  } finally {
    redactableState.fiberRefs = prev;
  }
};
var redact = (u) => {
  if (isRedactable(u) && redactableState.fiberRefs !== void 0) {
    return u[symbolRedactable](redactableState.fiberRefs);
  }
  return u;
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Pipeable.js
var pipeArguments = (self, args2) => {
  switch (args2.length) {
    case 0:
      return self;
    case 1:
      return args2[0](self);
    case 2:
      return args2[1](args2[0](self));
    case 3:
      return args2[2](args2[1](args2[0](self)));
    case 4:
      return args2[3](args2[2](args2[1](args2[0](self))));
    case 5:
      return args2[4](args2[3](args2[2](args2[1](args2[0](self)))));
    case 6:
      return args2[5](args2[4](args2[3](args2[2](args2[1](args2[0](self))))));
    case 7:
      return args2[6](args2[5](args2[4](args2[3](args2[2](args2[1](args2[0](self)))))));
    case 8:
      return args2[7](args2[6](args2[5](args2[4](args2[3](args2[2](args2[1](args2[0](self))))))));
    case 9:
      return args2[8](args2[7](args2[6](args2[5](args2[4](args2[3](args2[2](args2[1](args2[0](self)))))))));
    default: {
      let ret = self;
      for (let i = 0, len = args2.length; i < len; i++) {
        ret = args2[i](ret);
      }
      return ret;
    }
  }
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/opCodes/effect.js
var OP_ASYNC = "Async";
var OP_COMMIT = "Commit";
var OP_FAILURE = "Failure";
var OP_ON_FAILURE = "OnFailure";
var OP_ON_SUCCESS = "OnSuccess";
var OP_ON_SUCCESS_AND_FAILURE = "OnSuccessAndFailure";
var OP_SUCCESS = "Success";
var OP_SYNC = "Sync";
var OP_TAG = "Tag";
var OP_UPDATE_RUNTIME_FLAGS = "UpdateRuntimeFlags";
var OP_WHILE = "While";
var OP_ITERATOR = "Iterator";
var OP_WITH_RUNTIME = "WithRuntime";
var OP_YIELD = "Yield";
var OP_REVERT_FLAGS = "RevertFlags";

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/version.js
var moduleVersion = "3.22.0";
var getCurrentVersion = () => moduleVersion;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/effectable.js
var EffectTypeId = /* @__PURE__ */ Symbol.for("effect/Effect");
var StreamTypeId = /* @__PURE__ */ Symbol.for("effect/Stream");
var SinkTypeId = /* @__PURE__ */ Symbol.for("effect/Sink");
var ChannelTypeId = /* @__PURE__ */ Symbol.for("effect/Channel");
var effectVariance = {
  /* c8 ignore next */
  _R: (_) => _,
  /* c8 ignore next */
  _E: (_) => _,
  /* c8 ignore next */
  _A: (_) => _,
  _V: /* @__PURE__ */ getCurrentVersion()
};
var sinkVariance = {
  /* c8 ignore next */
  _A: (_) => _,
  /* c8 ignore next */
  _In: (_) => _,
  /* c8 ignore next */
  _L: (_) => _,
  /* c8 ignore next */
  _E: (_) => _,
  /* c8 ignore next */
  _R: (_) => _
};
var channelVariance = {
  /* c8 ignore next */
  _Env: (_) => _,
  /* c8 ignore next */
  _InErr: (_) => _,
  /* c8 ignore next */
  _InElem: (_) => _,
  /* c8 ignore next */
  _InDone: (_) => _,
  /* c8 ignore next */
  _OutErr: (_) => _,
  /* c8 ignore next */
  _OutElem: (_) => _,
  /* c8 ignore next */
  _OutDone: (_) => _
};
var EffectPrototype = {
  [EffectTypeId]: effectVariance,
  [StreamTypeId]: effectVariance,
  [SinkTypeId]: sinkVariance,
  [ChannelTypeId]: channelVariance,
  [symbol2](that) {
    return this === that;
  },
  [symbol]() {
    return cached(this, random(this));
  },
  [Symbol.iterator]() {
    return new SingleShotGen(new YieldWrap(this));
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var StructuralPrototype = {
  [symbol]() {
    return cached(this, structure(this));
  },
  [symbol2](that) {
    const selfKeys = Object.keys(this);
    const thatKeys = Object.keys(that);
    if (selfKeys.length !== thatKeys.length) {
      return false;
    }
    for (const key of selfKeys) {
      if (!(key in that && equals(this[key], that[key]))) {
        return false;
      }
    }
    return true;
  }
};
var CommitPrototype = {
  ...EffectPrototype,
  _op: OP_COMMIT
};
var StructuralCommitPrototype = {
  ...CommitPrototype,
  ...StructuralPrototype
};
var Base = /* @__PURE__ */ (function() {
  function Base3() {
  }
  Base3.prototype = CommitPrototype;
  return Base3;
})();

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/option.js
var TypeId = /* @__PURE__ */ Symbol.for("effect/Option");
var CommonProto = {
  ...EffectPrototype,
  [TypeId]: {
    _A: (_) => _
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  toString() {
    return format(this.toJSON());
  }
};
var SomeProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(CommonProto), {
  _tag: "Some",
  _op: "Some",
  [symbol2](that) {
    return isOption(that) && isSome(that) && equals(this.value, that.value);
  },
  [symbol]() {
    return cached(this, combine(hash(this._tag))(hash(this.value)));
  },
  toJSON() {
    return {
      _id: "Option",
      _tag: this._tag,
      value: toJSON(this.value)
    };
  }
});
var NoneHash = /* @__PURE__ */ hash("None");
var NoneProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(CommonProto), {
  _tag: "None",
  _op: "None",
  [symbol2](that) {
    return isOption(that) && isNone(that);
  },
  [symbol]() {
    return NoneHash;
  },
  toJSON() {
    return {
      _id: "Option",
      _tag: this._tag
    };
  }
});
var isOption = (input) => hasProperty(input, TypeId);
var isNone = (fa) => fa._tag === "None";
var isSome = (fa) => fa._tag === "Some";
var none = /* @__PURE__ */ Object.create(NoneProto);
var some = (value) => {
  const a = Object.create(SomeProto);
  a.value = value;
  return a;
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/either.js
var TypeId2 = /* @__PURE__ */ Symbol.for("effect/Either");
var CommonProto2 = {
  ...EffectPrototype,
  [TypeId2]: {
    _R: (_) => _
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  toString() {
    return format(this.toJSON());
  }
};
var RightProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(CommonProto2), {
  _tag: "Right",
  _op: "Right",
  [symbol2](that) {
    return isEither(that) && isRight(that) && equals(this.right, that.right);
  },
  [symbol]() {
    return combine(hash(this._tag))(hash(this.right));
  },
  toJSON() {
    return {
      _id: "Either",
      _tag: this._tag,
      right: toJSON(this.right)
    };
  }
});
var LeftProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(CommonProto2), {
  _tag: "Left",
  _op: "Left",
  [symbol2](that) {
    return isEither(that) && isLeft(that) && equals(this.left, that.left);
  },
  [symbol]() {
    return combine(hash(this._tag))(hash(this.left));
  },
  toJSON() {
    return {
      _id: "Either",
      _tag: this._tag,
      left: toJSON(this.left)
    };
  }
});
var isEither = (input) => hasProperty(input, TypeId2);
var isLeft = (ma) => ma._tag === "Left";
var isRight = (ma) => ma._tag === "Right";
var left = (left3) => {
  const a = Object.create(LeftProto);
  a.left = left3;
  return a;
};
var right = (right3) => {
  const a = Object.create(RightProto);
  a.right = right3;
  return a;
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Either.js
var right2 = right;
var left2 = left;
var isLeft2 = isLeft;
var isRight2 = isRight;
var match = /* @__PURE__ */ dual(2, (self, {
  onLeft,
  onRight
}) => isLeft2(self) ? onLeft(self.left) : onRight(self.right));
var merge = /* @__PURE__ */ match({
  onLeft: identity,
  onRight: identity
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/array.js
var isNonEmptyArray = (self) => self.length > 0;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Order.js
var make2 = (compare) => (self, that) => self === that ? 0 : compare(self, that);
var number2 = /* @__PURE__ */ make2((self, that) => self < that ? -1 : 1);
var mapInput2 = /* @__PURE__ */ dual(2, (self, f) => make2((b1, b2) => self(f(b1), f(b2))));
var greaterThan = (O) => dual(2, (self, that) => O(self, that) === 1);

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Option.js
var none2 = () => none;
var some2 = some;
var isNone2 = isNone;
var isSome2 = isSome;
var match2 = /* @__PURE__ */ dual(2, (self, {
  onNone,
  onSome
}) => isNone2(self) ? onNone() : onSome(self.value));
var getOrElse = /* @__PURE__ */ dual(2, (self, onNone) => isNone2(self) ? onNone() : self.value);
var orElseSome = /* @__PURE__ */ dual(2, (self, onNone) => isNone2(self) ? some2(onNone()) : self);
var fromNullable = (nullableValue) => nullableValue == null ? none2() : some2(nullableValue);
var getOrUndefined = /* @__PURE__ */ getOrElse(constUndefined);
var map = /* @__PURE__ */ dual(2, (self, f) => isNone2(self) ? none2() : some2(f(self.value)));
var flatMap = /* @__PURE__ */ dual(2, (self, f) => isNone2(self) ? none2() : f(self.value));
var containsWith = (isEquivalent) => dual(2, (self, a) => isNone2(self) ? false : isEquivalent(self.value, a));
var _equivalence = /* @__PURE__ */ equivalence();
var contains = /* @__PURE__ */ containsWith(_equivalence);

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Tuple.js
var make3 = (...elements) => elements;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Array.js
var allocate = (n) => new Array(n);
var makeBy = /* @__PURE__ */ dual(2, (n, f) => {
  const max2 = Math.max(1, Math.floor(n));
  const out = new Array(max2);
  for (let i = 0; i < max2; i++) {
    out[i] = f(i);
  }
  return out;
});
var fromIterable = (collection) => Array.isArray(collection) ? collection : Array.from(collection);
var ensure = (self) => Array.isArray(self) ? self : [self];
var prepend = /* @__PURE__ */ dual(2, (self, head4) => [head4, ...self]);
var append = /* @__PURE__ */ dual(2, (self, last3) => [...self, last3]);
var appendAll = /* @__PURE__ */ dual(2, (self, that) => fromIterable(self).concat(fromIterable(that)));
var isEmptyArray = (self) => self.length === 0;
var isEmptyReadonlyArray = isEmptyArray;
var isNonEmptyArray2 = isNonEmptyArray;
var isNonEmptyReadonlyArray = isNonEmptyArray;
var isOutOfBounds = (i, as5) => i < 0 || i >= as5.length;
var clamp = (i, as5) => Math.floor(Math.min(Math.max(0, i), as5.length));
var get = /* @__PURE__ */ dual(2, (self, index) => {
  const i = Math.floor(index);
  return isOutOfBounds(i, self) ? none2() : some2(self[i]);
});
var unsafeGet = /* @__PURE__ */ dual(2, (self, index) => {
  const i = Math.floor(index);
  if (isOutOfBounds(i, self)) {
    throw new Error(`Index ${i} out of bounds`);
  }
  return self[i];
});
var head = /* @__PURE__ */ get(0);
var headNonEmpty = /* @__PURE__ */ unsafeGet(0);
var last = (self) => isNonEmptyReadonlyArray(self) ? some2(lastNonEmpty(self)) : none2();
var lastNonEmpty = (self) => self[self.length - 1];
var tailNonEmpty = (self) => self.slice(1);
var spanIndex = (self, predicate) => {
  let i = 0;
  for (const a of self) {
    if (!predicate(a, i)) {
      break;
    }
    i++;
  }
  return i;
};
var span = /* @__PURE__ */ dual(2, (self, predicate) => splitAt(self, spanIndex(self, predicate)));
var drop = /* @__PURE__ */ dual(2, (self, n) => {
  const input = fromIterable(self);
  return input.slice(clamp(n, input), input.length);
});
var reverse = (self) => Array.from(self).reverse();
var sort = /* @__PURE__ */ dual(2, (self, O) => {
  const out = Array.from(self);
  out.sort(O);
  return out;
});
var zip = /* @__PURE__ */ dual(2, (self, that) => zipWith(self, that, make3));
var zipWith = /* @__PURE__ */ dual(3, (self, that, f) => {
  const as5 = fromIterable(self);
  const bs = fromIterable(that);
  if (isNonEmptyReadonlyArray(as5) && isNonEmptyReadonlyArray(bs)) {
    const out = [f(headNonEmpty(as5), headNonEmpty(bs))];
    const len = Math.min(as5.length, bs.length);
    for (let i = 1; i < len; i++) {
      out[i] = f(as5[i], bs[i]);
    }
    return out;
  }
  return [];
});
var _equivalence2 = /* @__PURE__ */ equivalence();
var splitAt = /* @__PURE__ */ dual(2, (self, n) => {
  const input = Array.from(self);
  const _n = Math.floor(n);
  if (isNonEmptyReadonlyArray(input)) {
    if (_n >= 1) {
      return splitNonEmptyAt(input, _n);
    }
    return [[], input];
  }
  return [input, []];
});
var splitNonEmptyAt = /* @__PURE__ */ dual(2, (self, n) => {
  const _n = Math.max(1, Math.floor(n));
  return _n >= self.length ? [copy(self), []] : [prepend(self.slice(1, _n), headNonEmpty(self)), self.slice(_n)];
});
var copy = (self) => self.slice();
var unionWith = /* @__PURE__ */ dual(3, (self, that, isEquivalent) => {
  const a = fromIterable(self);
  const b = fromIterable(that);
  if (isNonEmptyReadonlyArray(a)) {
    if (isNonEmptyReadonlyArray(b)) {
      const dedupe2 = dedupeWith(isEquivalent);
      return dedupe2(appendAll(a, b));
    }
    return a;
  }
  return b;
});
var union = /* @__PURE__ */ dual(2, (self, that) => unionWith(self, that, _equivalence2));
var empty = () => [];
var of = (a) => [a];
var map2 = /* @__PURE__ */ dual(2, (self, f) => self.map(f));
var flatMap2 = /* @__PURE__ */ dual(2, (self, f) => {
  if (isEmptyReadonlyArray(self)) {
    return [];
  }
  const out = [];
  for (let i = 0; i < self.length; i++) {
    const inner = f(self[i], i);
    for (let j = 0; j < inner.length; j++) {
      out.push(inner[j]);
    }
  }
  return out;
});
var flatten = /* @__PURE__ */ flatMap2(identity);
var filter = /* @__PURE__ */ dual(2, (self, predicate) => {
  const as5 = fromIterable(self);
  const out = [];
  for (let i = 0; i < as5.length; i++) {
    if (predicate(as5[i], i)) {
      out.push(as5[i]);
    }
  }
  return out;
});
var reduce = /* @__PURE__ */ dual(3, (self, b, f) => fromIterable(self).reduce((b2, a, i) => f(b2, a, i), b));
var unfold = (b, f) => {
  const out = [];
  let next = b;
  let o;
  while (isSome2(o = f(next))) {
    const [a, b2] = o.value;
    out.push(a);
    next = b2;
  }
  return out;
};
var getEquivalence = array;
var dedupeWith = /* @__PURE__ */ dual(2, (self, isEquivalent) => {
  const input = fromIterable(self);
  if (isNonEmptyReadonlyArray(input)) {
    const out = [headNonEmpty(input)];
    const rest = tailNonEmpty(input);
    for (const r of rest) {
      if (out.every((a) => !isEquivalent(r, a))) {
        out.push(r);
      }
    }
    return out;
  }
  return [];
});
var dedupe = (self) => dedupeWith(self, equivalence());
var join = /* @__PURE__ */ dual(2, (self, sep) => fromIterable(self).join(sep));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Chunk.js
var TypeId3 = /* @__PURE__ */ Symbol.for("effect/Chunk");
function copy2(src, srcPos, dest, destPos, len) {
  for (let i = srcPos; i < Math.min(src.length, srcPos + len); i++) {
    dest[destPos + i - srcPos] = src[i];
  }
  return dest;
}
var emptyArray = [];
var getEquivalence2 = (isEquivalent) => make((self, that) => self.length === that.length && toReadonlyArray(self).every((value, i) => isEquivalent(value, unsafeGet2(that, i))));
var _equivalence3 = /* @__PURE__ */ getEquivalence2(equals);
var ChunkProto = {
  [TypeId3]: {
    _A: (_) => _
  },
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "Chunk",
      values: toReadonlyArray(this).map(toJSON)
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  [symbol2](that) {
    return isChunk(that) && _equivalence3(this, that);
  },
  [symbol]() {
    return cached(this, array2(toReadonlyArray(this)));
  },
  [Symbol.iterator]() {
    switch (this.backing._tag) {
      case "IArray": {
        return this.backing.array[Symbol.iterator]();
      }
      case "IEmpty": {
        return emptyArray[Symbol.iterator]();
      }
      default: {
        return toReadonlyArray(this)[Symbol.iterator]();
      }
    }
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var makeChunk = (backing) => {
  const chunk2 = Object.create(ChunkProto);
  chunk2.backing = backing;
  switch (backing._tag) {
    case "IEmpty": {
      chunk2.length = 0;
      chunk2.depth = 0;
      chunk2.left = chunk2;
      chunk2.right = chunk2;
      break;
    }
    case "IConcat": {
      chunk2.length = backing.left.length + backing.right.length;
      chunk2.depth = 1 + Math.max(backing.left.depth, backing.right.depth);
      chunk2.left = backing.left;
      chunk2.right = backing.right;
      break;
    }
    case "IArray": {
      chunk2.length = backing.array.length;
      chunk2.depth = 0;
      chunk2.left = _empty;
      chunk2.right = _empty;
      break;
    }
    case "ISingleton": {
      chunk2.length = 1;
      chunk2.depth = 0;
      chunk2.left = _empty;
      chunk2.right = _empty;
      break;
    }
    case "ISlice": {
      chunk2.length = backing.length;
      chunk2.depth = backing.chunk.depth + 1;
      chunk2.left = _empty;
      chunk2.right = _empty;
      break;
    }
  }
  return chunk2;
};
var isChunk = (u) => hasProperty(u, TypeId3);
var _empty = /* @__PURE__ */ makeChunk({
  _tag: "IEmpty"
});
var empty2 = () => _empty;
var make4 = (...as5) => unsafeFromNonEmptyArray(as5);
var of2 = (a) => makeChunk({
  _tag: "ISingleton",
  a
});
var fromIterable2 = (self) => isChunk(self) ? self : unsafeFromArray(fromIterable(self));
var copyToArray = (self, array3, initial) => {
  switch (self.backing._tag) {
    case "IArray": {
      copy2(self.backing.array, 0, array3, initial, self.length);
      break;
    }
    case "IConcat": {
      copyToArray(self.left, array3, initial);
      copyToArray(self.right, array3, initial + self.left.length);
      break;
    }
    case "ISingleton": {
      array3[initial] = self.backing.a;
      break;
    }
    case "ISlice": {
      let i = 0;
      let j = initial;
      while (i < self.length) {
        array3[j] = unsafeGet2(self, i);
        i += 1;
        j += 1;
      }
      break;
    }
  }
};
var toReadonlyArray_ = (self) => {
  switch (self.backing._tag) {
    case "IEmpty": {
      return emptyArray;
    }
    case "IArray": {
      return self.backing.array;
    }
    default: {
      const arr = new Array(self.length);
      copyToArray(self, arr, 0);
      self.backing = {
        _tag: "IArray",
        array: arr
      };
      self.left = _empty;
      self.right = _empty;
      self.depth = 0;
      return arr;
    }
  }
};
var toReadonlyArray = toReadonlyArray_;
var reverseChunk = (self) => {
  switch (self.backing._tag) {
    case "IEmpty":
    case "ISingleton":
      return self;
    case "IArray": {
      return makeChunk({
        _tag: "IArray",
        array: reverse(self.backing.array)
      });
    }
    case "IConcat": {
      return makeChunk({
        _tag: "IConcat",
        left: reverse2(self.backing.right),
        right: reverse2(self.backing.left)
      });
    }
    case "ISlice":
      return unsafeFromArray(reverse(toReadonlyArray(self)));
  }
};
var reverse2 = reverseChunk;
var get2 = /* @__PURE__ */ dual(2, (self, index) => index < 0 || index >= self.length ? none2() : some2(unsafeGet2(self, index)));
var unsafeFromArray = (self) => self.length === 0 ? empty2() : self.length === 1 ? of2(self[0]) : makeChunk({
  _tag: "IArray",
  array: self
});
var unsafeFromNonEmptyArray = (self) => unsafeFromArray(self);
var unsafeGet2 = /* @__PURE__ */ dual(2, (self, index) => {
  switch (self.backing._tag) {
    case "IEmpty": {
      throw new Error(`Index out of bounds`);
    }
    case "ISingleton": {
      if (index !== 0) {
        throw new Error(`Index out of bounds`);
      }
      return self.backing.a;
    }
    case "IArray": {
      if (index >= self.length || index < 0) {
        throw new Error(`Index out of bounds`);
      }
      return self.backing.array[index];
    }
    case "IConcat": {
      return index < self.left.length ? unsafeGet2(self.left, index) : unsafeGet2(self.right, index - self.left.length);
    }
    case "ISlice": {
      return unsafeGet2(self.backing.chunk, index + self.backing.offset);
    }
  }
});
var append2 = /* @__PURE__ */ dual(2, (self, a) => appendAll2(self, of2(a)));
var prepend2 = /* @__PURE__ */ dual(2, (self, elem) => appendAll2(of2(elem), self));
var drop2 = /* @__PURE__ */ dual(2, (self, n) => {
  if (n <= 0) {
    return self;
  } else if (n >= self.length) {
    return _empty;
  } else {
    switch (self.backing._tag) {
      case "ISlice": {
        return makeChunk({
          _tag: "ISlice",
          chunk: self.backing.chunk,
          offset: self.backing.offset + n,
          length: self.backing.length - n
        });
      }
      case "IConcat": {
        if (n > self.left.length) {
          return drop2(self.right, n - self.left.length);
        }
        return makeChunk({
          _tag: "IConcat",
          left: drop2(self.left, n),
          right: self.right
        });
      }
      default: {
        return makeChunk({
          _tag: "ISlice",
          chunk: self,
          offset: n,
          length: self.length - n
        });
      }
    }
  }
});
var appendAll2 = /* @__PURE__ */ dual(2, (self, that) => {
  if (self.backing._tag === "IEmpty") {
    return that;
  }
  if (that.backing._tag === "IEmpty") {
    return self;
  }
  const diff8 = that.depth - self.depth;
  if (Math.abs(diff8) <= 1) {
    return makeChunk({
      _tag: "IConcat",
      left: self,
      right: that
    });
  } else if (diff8 < -1) {
    if (self.left.depth >= self.right.depth) {
      const nr = appendAll2(self.right, that);
      return makeChunk({
        _tag: "IConcat",
        left: self.left,
        right: nr
      });
    } else {
      const nrr = appendAll2(self.right.right, that);
      if (nrr.depth === self.depth - 3) {
        const nr = makeChunk({
          _tag: "IConcat",
          left: self.right.left,
          right: nrr
        });
        return makeChunk({
          _tag: "IConcat",
          left: self.left,
          right: nr
        });
      } else {
        const nl = makeChunk({
          _tag: "IConcat",
          left: self.left,
          right: self.right.left
        });
        return makeChunk({
          _tag: "IConcat",
          left: nl,
          right: nrr
        });
      }
    }
  } else {
    if (that.right.depth >= that.left.depth) {
      const nl = appendAll2(self, that.left);
      return makeChunk({
        _tag: "IConcat",
        left: nl,
        right: that.right
      });
    } else {
      const nll = appendAll2(self, that.left.left);
      if (nll.depth === that.depth - 3) {
        const nl = makeChunk({
          _tag: "IConcat",
          left: nll,
          right: that.left.right
        });
        return makeChunk({
          _tag: "IConcat",
          left: nl,
          right: that.right
        });
      } else {
        const nr = makeChunk({
          _tag: "IConcat",
          left: that.left.right,
          right: that.right
        });
        return makeChunk({
          _tag: "IConcat",
          left: nll,
          right: nr
        });
      }
    }
  }
});
var filter2 = /* @__PURE__ */ dual(2, (self, predicate) => unsafeFromArray(filter(self, predicate)));
var isEmpty = (self) => self.length === 0;
var isNonEmpty = (self) => self.length > 0;
var head2 = /* @__PURE__ */ get2(0);
var unsafeHead = (self) => unsafeGet2(self, 0);
var headNonEmpty2 = unsafeHead;
var tailNonEmpty2 = (self) => drop2(self, 1);

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/hashMap/config.js
var SIZE = 5;
var BUCKET_SIZE = /* @__PURE__ */ Math.pow(2, SIZE);
var MASK = BUCKET_SIZE - 1;
var MAX_INDEX_NODE = BUCKET_SIZE / 2;
var MIN_ARRAY_NODE = BUCKET_SIZE / 4;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/hashMap/bitwise.js
function popcount(x) {
  x -= x >> 1 & 1431655765;
  x = (x & 858993459) + (x >> 2 & 858993459);
  x = x + (x >> 4) & 252645135;
  x += x >> 8;
  x += x >> 16;
  return x & 127;
}
function hashFragment(shift2, h) {
  return h >>> shift2 & MASK;
}
function toBitmap(x) {
  return 1 << x;
}
function fromBitmap(bitmap, bit) {
  return popcount(bitmap & bit - 1);
}

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/stack.js
var make5 = (value, previous) => ({
  value,
  previous
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/hashMap/array.js
function arrayUpdate(mutate3, at, v, arr) {
  let out = arr;
  if (!mutate3) {
    const len = arr.length;
    out = new Array(len);
    for (let i = 0; i < len; ++i) out[i] = arr[i];
  }
  out[at] = v;
  return out;
}
function arraySpliceOut(mutate3, at, arr) {
  const newLen = arr.length - 1;
  let i = 0;
  let g = 0;
  let out = arr;
  if (mutate3) {
    i = g = at;
  } else {
    out = new Array(newLen);
    while (i < at) out[g++] = arr[i++];
  }
  ++i;
  while (i <= newLen) out[g++] = arr[i++];
  if (mutate3) {
    out.length = newLen;
  }
  return out;
}
function arraySpliceIn(mutate3, at, v, arr) {
  const len = arr.length;
  if (mutate3) {
    let i2 = len;
    while (i2 >= at) arr[i2--] = arr[i2];
    arr[at] = v;
    return arr;
  }
  let i = 0, g = 0;
  const out = new Array(len + 1);
  while (i < at) out[g++] = arr[i++];
  out[at] = v;
  while (i < len) out[++g] = arr[i++];
  return out;
}

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/hashMap/node.js
var EmptyNode = class _EmptyNode {
  _tag = "EmptyNode";
  modify(edit, _shift, f, hash2, key, size8) {
    const v = f(none2());
    if (isNone2(v)) return new _EmptyNode();
    ++size8.value;
    return new LeafNode(edit, hash2, key, v);
  }
};
function isEmptyNode(a) {
  return isTagged(a, "EmptyNode");
}
function isLeafNode(node) {
  return isEmptyNode(node) || node._tag === "LeafNode" || node._tag === "CollisionNode";
}
function canEditNode(node, edit) {
  return isEmptyNode(node) ? false : edit === node.edit;
}
var LeafNode = class _LeafNode {
  edit;
  hash;
  key;
  value;
  _tag = "LeafNode";
  constructor(edit, hash2, key, value) {
    this.edit = edit;
    this.hash = hash2;
    this.key = key;
    this.value = value;
  }
  modify(edit, shift2, f, hash2, key, size8) {
    if (equals(key, this.key)) {
      const v2 = f(this.value);
      if (v2 === this.value) return this;
      else if (isNone2(v2)) {
        --size8.value;
        return new EmptyNode();
      }
      if (canEditNode(this, edit)) {
        this.value = v2;
        return this;
      }
      return new _LeafNode(edit, hash2, key, v2);
    }
    const v = f(none2());
    if (isNone2(v)) return this;
    ++size8.value;
    return mergeLeaves(edit, shift2, this.hash, this, hash2, new _LeafNode(edit, hash2, key, v));
  }
};
var CollisionNode = class _CollisionNode {
  edit;
  hash;
  children;
  _tag = "CollisionNode";
  constructor(edit, hash2, children2) {
    this.edit = edit;
    this.hash = hash2;
    this.children = children2;
  }
  modify(edit, shift2, f, hash2, key, size8) {
    if (hash2 === this.hash) {
      const canEdit = canEditNode(this, edit);
      const list = this.updateCollisionList(canEdit, edit, this.hash, this.children, f, key, size8);
      if (list === this.children) return this;
      return list.length > 1 ? new _CollisionNode(edit, this.hash, list) : list[0];
    }
    const v = f(none2());
    if (isNone2(v)) return this;
    ++size8.value;
    return mergeLeaves(edit, shift2, this.hash, this, hash2, new LeafNode(edit, hash2, key, v));
  }
  updateCollisionList(mutate3, edit, hash2, list, f, key, size8) {
    const len = list.length;
    for (let i = 0; i < len; ++i) {
      const child = list[i];
      if ("key" in child && equals(key, child.key)) {
        const value = child.value;
        const newValue2 = f(value);
        if (newValue2 === value) return list;
        if (isNone2(newValue2)) {
          --size8.value;
          return arraySpliceOut(mutate3, i, list);
        }
        return arrayUpdate(mutate3, i, new LeafNode(edit, hash2, key, newValue2), list);
      }
    }
    const newValue = f(none2());
    if (isNone2(newValue)) return list;
    ++size8.value;
    return arrayUpdate(mutate3, len, new LeafNode(edit, hash2, key, newValue), list);
  }
};
var IndexedNode = class _IndexedNode {
  edit;
  mask;
  children;
  _tag = "IndexedNode";
  constructor(edit, mask, children2) {
    this.edit = edit;
    this.mask = mask;
    this.children = children2;
  }
  modify(edit, shift2, f, hash2, key, size8) {
    const mask = this.mask;
    const children2 = this.children;
    const frag = hashFragment(shift2, hash2);
    const bit = toBitmap(frag);
    const indx = fromBitmap(mask, bit);
    const exists2 = mask & bit;
    const canEdit = canEditNode(this, edit);
    if (!exists2) {
      const _newChild = new EmptyNode().modify(edit, shift2 + SIZE, f, hash2, key, size8);
      if (!_newChild) return this;
      return children2.length >= MAX_INDEX_NODE ? expand(edit, frag, _newChild, mask, children2) : new _IndexedNode(edit, mask | bit, arraySpliceIn(canEdit, indx, _newChild, children2));
    }
    const current = children2[indx];
    const child = current.modify(edit, shift2 + SIZE, f, hash2, key, size8);
    if (current === child) return this;
    let bitmap = mask;
    let newChildren;
    if (isEmptyNode(child)) {
      bitmap &= ~bit;
      if (!bitmap) return new EmptyNode();
      if (children2.length <= 2 && isLeafNode(children2[indx ^ 1])) {
        return children2[indx ^ 1];
      }
      newChildren = arraySpliceOut(canEdit, indx, children2);
    } else {
      newChildren = arrayUpdate(canEdit, indx, child, children2);
    }
    if (canEdit) {
      this.mask = bitmap;
      this.children = newChildren;
      return this;
    }
    return new _IndexedNode(edit, bitmap, newChildren);
  }
};
var ArrayNode = class _ArrayNode {
  edit;
  size;
  children;
  _tag = "ArrayNode";
  constructor(edit, size8, children2) {
    this.edit = edit;
    this.size = size8;
    this.children = children2;
  }
  modify(edit, shift2, f, hash2, key, size8) {
    let count = this.size;
    const children2 = this.children;
    const frag = hashFragment(shift2, hash2);
    const child = children2[frag];
    const newChild = (child || new EmptyNode()).modify(edit, shift2 + SIZE, f, hash2, key, size8);
    if (child === newChild) return this;
    const canEdit = canEditNode(this, edit);
    let newChildren;
    if (isEmptyNode(child) && !isEmptyNode(newChild)) {
      ++count;
      newChildren = arrayUpdate(canEdit, frag, newChild, children2);
    } else if (!isEmptyNode(child) && isEmptyNode(newChild)) {
      --count;
      if (count <= MIN_ARRAY_NODE) {
        return pack(edit, count, frag, children2);
      }
      newChildren = arrayUpdate(canEdit, frag, new EmptyNode(), children2);
    } else {
      newChildren = arrayUpdate(canEdit, frag, newChild, children2);
    }
    if (canEdit) {
      this.size = count;
      this.children = newChildren;
      return this;
    }
    return new _ArrayNode(edit, count, newChildren);
  }
};
function pack(edit, count, removed, elements) {
  const children2 = new Array(count - 1);
  let g = 0;
  let bitmap = 0;
  for (let i = 0, len = elements.length; i < len; ++i) {
    if (i !== removed) {
      const elem = elements[i];
      if (elem && !isEmptyNode(elem)) {
        children2[g++] = elem;
        bitmap |= 1 << i;
      }
    }
  }
  return new IndexedNode(edit, bitmap, children2);
}
function expand(edit, frag, child, bitmap, subNodes) {
  const arr = [];
  let bit = bitmap;
  let count = 0;
  for (let i = 0; bit; ++i) {
    if (bit & 1) arr[i] = subNodes[count++];
    bit >>>= 1;
  }
  arr[frag] = child;
  return new ArrayNode(edit, count + 1, arr);
}
function mergeLeavesInner(edit, shift2, h1, n1, h2, n2) {
  if (h1 === h2) return new CollisionNode(edit, h1, [n2, n1]);
  const subH1 = hashFragment(shift2, h1);
  const subH2 = hashFragment(shift2, h2);
  if (subH1 === subH2) {
    return (child) => new IndexedNode(edit, toBitmap(subH1) | toBitmap(subH2), [child]);
  } else {
    const children2 = subH1 < subH2 ? [n1, n2] : [n2, n1];
    return new IndexedNode(edit, toBitmap(subH1) | toBitmap(subH2), children2);
  }
}
function mergeLeaves(edit, shift2, h1, n1, h2, n2) {
  let stack = void 0;
  let currentShift = shift2;
  while (true) {
    const res = mergeLeavesInner(edit, currentShift, h1, n1, h2, n2);
    if (typeof res === "function") {
      stack = make5(res, stack);
      currentShift = currentShift + SIZE;
    } else {
      let final = res;
      while (stack != null) {
        final = stack.value(final);
        stack = stack.previous;
      }
      return final;
    }
  }
}

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/hashMap.js
var HashMapSymbolKey = "effect/HashMap";
var HashMapTypeId = /* @__PURE__ */ Symbol.for(HashMapSymbolKey);
var HashMapProto = {
  [HashMapTypeId]: HashMapTypeId,
  [Symbol.iterator]() {
    return new HashMapIterator(this, (k, v) => [k, v]);
  },
  [symbol]() {
    let hash2 = hash(HashMapSymbolKey);
    for (const item of this) {
      hash2 ^= pipe(hash(item[0]), combine(hash(item[1])));
    }
    return cached(this, hash2);
  },
  [symbol2](that) {
    if (isHashMap(that)) {
      if (that._size !== this._size) {
        return false;
      }
      for (const item of this) {
        const elem = pipe(that, getHash(item[0], hash(item[0])));
        if (isNone2(elem)) {
          return false;
        } else {
          if (!equals(item[1], elem.value)) {
            return false;
          }
        }
      }
      return true;
    }
    return false;
  },
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "HashMap",
      values: Array.from(this).map(toJSON)
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var makeImpl = (editable, edit, root, size8) => {
  const map12 = Object.create(HashMapProto);
  map12._editable = editable;
  map12._edit = edit;
  map12._root = root;
  map12._size = size8;
  return map12;
};
var HashMapIterator = class _HashMapIterator {
  map;
  f;
  v;
  constructor(map12, f) {
    this.map = map12;
    this.f = f;
    this.v = visitLazy(this.map._root, this.f, void 0);
  }
  next() {
    if (isNone2(this.v)) {
      return {
        done: true,
        value: void 0
      };
    }
    const v0 = this.v.value;
    this.v = applyCont(v0.cont);
    return {
      done: false,
      value: v0.value
    };
  }
  [Symbol.iterator]() {
    return new _HashMapIterator(this.map, this.f);
  }
};
var applyCont = (cont) => cont ? visitLazyChildren(cont[0], cont[1], cont[2], cont[3], cont[4]) : none2();
var visitLazy = (node, f, cont = void 0) => {
  switch (node._tag) {
    case "LeafNode": {
      if (isSome2(node.value)) {
        return some2({
          value: f(node.key, node.value.value),
          cont
        });
      }
      return applyCont(cont);
    }
    case "CollisionNode":
    case "ArrayNode":
    case "IndexedNode": {
      const children2 = node.children;
      return visitLazyChildren(children2.length, children2, 0, f, cont);
    }
    default: {
      return applyCont(cont);
    }
  }
};
var visitLazyChildren = (len, children2, i, f, cont) => {
  while (i < len) {
    const child = children2[i++];
    if (child && !isEmptyNode(child)) {
      return visitLazy(child, f, [len, children2, i, f, cont]);
    }
  }
  return applyCont(cont);
};
var _empty2 = /* @__PURE__ */ makeImpl(false, 0, /* @__PURE__ */ new EmptyNode(), 0);
var empty3 = () => _empty2;
var fromIterable3 = (entries2) => {
  const map12 = beginMutation(empty3());
  for (const entry of entries2) {
    set(map12, entry[0], entry[1]);
  }
  return endMutation(map12);
};
var isHashMap = (u) => hasProperty(u, HashMapTypeId);
var isEmpty2 = (self) => self && isEmptyNode(self._root);
var get3 = /* @__PURE__ */ dual(2, (self, key) => getHash(self, key, hash(key)));
var getHash = /* @__PURE__ */ dual(3, (self, key, hash2) => {
  let node = self._root;
  let shift2 = 0;
  while (true) {
    switch (node._tag) {
      case "LeafNode": {
        return equals(key, node.key) ? node.value : none2();
      }
      case "CollisionNode": {
        if (hash2 === node.hash) {
          const children2 = node.children;
          for (let i = 0, len = children2.length; i < len; ++i) {
            const child = children2[i];
            if ("key" in child && equals(key, child.key)) {
              return child.value;
            }
          }
        }
        return none2();
      }
      case "IndexedNode": {
        const frag = hashFragment(shift2, hash2);
        const bit = toBitmap(frag);
        if (node.mask & bit) {
          node = node.children[fromBitmap(node.mask, bit)];
          shift2 += SIZE;
          break;
        }
        return none2();
      }
      case "ArrayNode": {
        node = node.children[hashFragment(shift2, hash2)];
        if (node) {
          shift2 += SIZE;
          break;
        }
        return none2();
      }
      default:
        return none2();
    }
  }
});
var has = /* @__PURE__ */ dual(2, (self, key) => isSome2(getHash(self, key, hash(key))));
var set = /* @__PURE__ */ dual(3, (self, key, value) => modifyAt(self, key, () => some2(value)));
var setTree = /* @__PURE__ */ dual(3, (self, newRoot, newSize) => {
  if (self._editable) {
    ;
    self._root = newRoot;
    self._size = newSize;
    return self;
  }
  return newRoot === self._root ? self : makeImpl(self._editable, self._edit, newRoot, newSize);
});
var keys = (self) => new HashMapIterator(self, (key) => key);
var size = (self) => self._size;
var beginMutation = (self) => makeImpl(true, self._edit + 1, self._root, self._size);
var endMutation = (self) => {
  ;
  self._editable = false;
  return self;
};
var modifyAt = /* @__PURE__ */ dual(3, (self, key, f) => modifyHash(self, key, hash(key), f));
var modifyHash = /* @__PURE__ */ dual(4, (self, key, hash2, f) => {
  const size8 = {
    value: self._size
  };
  const newRoot = self._root.modify(self._editable ? self._edit : NaN, 0, f, hash2, key, size8);
  return pipe(self, setTree(newRoot, size8.value));
});
var remove2 = /* @__PURE__ */ dual(2, (self, key) => modifyAt(self, key, none2));
var map3 = /* @__PURE__ */ dual(2, (self, f) => reduce2(self, empty3(), (map12, value, key) => set(map12, key, f(value, key))));
var forEach = /* @__PURE__ */ dual(2, (self, f) => reduce2(self, void 0, (_, value, key) => f(value, key)));
var reduce2 = /* @__PURE__ */ dual(3, (self, zero2, f) => {
  const root = self._root;
  if (root._tag === "LeafNode") {
    return isSome2(root.value) ? f(zero2, root.value.value, root.key) : zero2;
  }
  if (root._tag === "EmptyNode") {
    return zero2;
  }
  const toVisit = [root.children];
  let children2;
  while (children2 = toVisit.pop()) {
    for (let i = 0, len = children2.length; i < len; ) {
      const child = children2[i++];
      if (child && !isEmptyNode(child)) {
        if (child._tag === "LeafNode") {
          if (isSome2(child.value)) {
            zero2 = f(zero2, child.value.value, child.key);
          }
        } else {
          toVisit.push(child.children);
        }
      }
    }
  }
  return zero2;
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/hashSet.js
var HashSetSymbolKey = "effect/HashSet";
var HashSetTypeId = /* @__PURE__ */ Symbol.for(HashSetSymbolKey);
var HashSetProto = {
  [HashSetTypeId]: HashSetTypeId,
  [Symbol.iterator]() {
    return keys(this._keyMap);
  },
  [symbol]() {
    return cached(this, combine(hash(this._keyMap))(hash(HashSetSymbolKey)));
  },
  [symbol2](that) {
    if (isHashSet(that)) {
      return size(this._keyMap) === size(that._keyMap) && equals(this._keyMap, that._keyMap);
    }
    return false;
  },
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "HashSet",
      values: Array.from(this).map(toJSON)
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var makeImpl2 = (keyMap) => {
  const set6 = Object.create(HashSetProto);
  set6._keyMap = keyMap;
  return set6;
};
var isHashSet = (u) => hasProperty(u, HashSetTypeId);
var _empty3 = /* @__PURE__ */ makeImpl2(/* @__PURE__ */ empty3());
var empty4 = () => _empty3;
var fromIterable4 = (elements) => {
  const set6 = beginMutation2(empty4());
  for (const value of elements) {
    add(set6, value);
  }
  return endMutation2(set6);
};
var make6 = (...elements) => {
  const set6 = beginMutation2(empty4());
  for (const value of elements) {
    add(set6, value);
  }
  return endMutation2(set6);
};
var has2 = /* @__PURE__ */ dual(2, (self, value) => has(self._keyMap, value));
var size2 = (self) => size(self._keyMap);
var beginMutation2 = (self) => makeImpl2(beginMutation(self._keyMap));
var endMutation2 = (self) => {
  ;
  self._keyMap._editable = false;
  return self;
};
var mutate = /* @__PURE__ */ dual(2, (self, f) => {
  const transient = beginMutation2(self);
  f(transient);
  return endMutation2(transient);
});
var add = /* @__PURE__ */ dual(2, (self, value) => self._keyMap._editable ? (set(value, true)(self._keyMap), self) : makeImpl2(set(value, true)(self._keyMap)));
var remove3 = /* @__PURE__ */ dual(2, (self, value) => self._keyMap._editable ? (remove2(value)(self._keyMap), self) : makeImpl2(remove2(value)(self._keyMap)));
var difference2 = /* @__PURE__ */ dual(2, (self, that) => mutate(self, (set6) => {
  for (const value of that) {
    remove3(set6, value);
  }
}));
var union2 = /* @__PURE__ */ dual(2, (self, that) => mutate(empty4(), (set6) => {
  forEach2(self, (value) => add(set6, value));
  for (const value of that) {
    add(set6, value);
  }
}));
var forEach2 = /* @__PURE__ */ dual(2, (self, f) => forEach(self._keyMap, (_, k) => f(k)));
var reduce3 = /* @__PURE__ */ dual(3, (self, zero2, f) => reduce2(self._keyMap, zero2, (z, _, a) => f(z, a)));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/HashSet.js
var empty5 = empty4;
var fromIterable5 = fromIterable4;
var make7 = make6;
var has3 = has2;
var size3 = size2;
var add2 = add;
var remove4 = remove3;
var difference3 = difference2;
var union3 = union2;
var reduce4 = reduce3;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/opCodes/cause.js
var OP_DIE = "Die";
var OP_EMPTY = "Empty";
var OP_FAIL = "Fail";
var OP_INTERRUPT = "Interrupt";
var OP_PARALLEL = "Parallel";
var OP_SEQUENTIAL = "Sequential";

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/cause.js
var CauseSymbolKey = "effect/Cause";
var CauseTypeId = /* @__PURE__ */ Symbol.for(CauseSymbolKey);
var variance = {
  /* c8 ignore next */
  _E: (_) => _
};
var proto = {
  [CauseTypeId]: variance,
  [symbol]() {
    return pipe(hash(CauseSymbolKey), combine(hash(flattenCause(this))), cached(this));
  },
  [symbol2](that) {
    return isCause(that) && causeEquals(this, that);
  },
  pipe() {
    return pipeArguments(this, arguments);
  },
  toJSON() {
    switch (this._tag) {
      case "Empty":
        return {
          _id: "Cause",
          _tag: this._tag
        };
      case "Die":
        return {
          _id: "Cause",
          _tag: this._tag,
          defect: toJSON(this.defect)
        };
      case "Interrupt":
        return {
          _id: "Cause",
          _tag: this._tag,
          fiberId: this.fiberId.toJSON()
        };
      case "Fail":
        return {
          _id: "Cause",
          _tag: this._tag,
          failure: toJSON(this.error)
        };
      case "Sequential":
      case "Parallel":
        return {
          _id: "Cause",
          _tag: this._tag,
          left: toJSON(this.left),
          right: toJSON(this.right)
        };
    }
  },
  toString() {
    return pretty(this);
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
};
var empty6 = /* @__PURE__ */ (() => {
  const o = /* @__PURE__ */ Object.create(proto);
  o._tag = OP_EMPTY;
  return o;
})();
var fail = (error) => {
  const o = Object.create(proto);
  o._tag = OP_FAIL;
  o.error = error;
  return o;
};
var die = (defect) => {
  const o = Object.create(proto);
  o._tag = OP_DIE;
  o.defect = defect;
  return o;
};
var interrupt = (fiberId2) => {
  const o = Object.create(proto);
  o._tag = OP_INTERRUPT;
  o.fiberId = fiberId2;
  return o;
};
var parallel = (left3, right3) => {
  const o = Object.create(proto);
  o._tag = OP_PARALLEL;
  o.left = left3;
  o.right = right3;
  return o;
};
var sequential = (left3, right3) => {
  const o = Object.create(proto);
  o._tag = OP_SEQUENTIAL;
  o.left = left3;
  o.right = right3;
  return o;
};
var isCause = (u) => hasProperty(u, CauseTypeId);
var isEmptyType = (self) => self._tag === OP_EMPTY;
var isEmpty3 = (self) => {
  if (self._tag === OP_EMPTY) {
    return true;
  }
  return reduce5(self, true, (acc, cause2) => {
    switch (cause2._tag) {
      case OP_EMPTY: {
        return some2(acc);
      }
      case OP_DIE:
      case OP_FAIL:
      case OP_INTERRUPT: {
        return some2(false);
      }
      default: {
        return none2();
      }
    }
  });
};
var isInterrupted = (self) => isSome2(interruptOption(self));
var isInterruptedOnly = (self) => reduceWithContext(void 0, IsInterruptedOnlyCauseReducer)(self);
var failures = (self) => reverse2(reduce5(self, empty2(), (list, cause2) => cause2._tag === OP_FAIL ? some2(pipe(list, prepend2(cause2.error))) : none2()));
var defects = (self) => reverse2(reduce5(self, empty2(), (list, cause2) => cause2._tag === OP_DIE ? some2(pipe(list, prepend2(cause2.defect))) : none2()));
var interruptors = (self) => reduce5(self, empty5(), (set6, cause2) => cause2._tag === OP_INTERRUPT ? some2(pipe(set6, add2(cause2.fiberId))) : none2());
var failureOption = (self) => find(self, (cause2) => cause2._tag === OP_FAIL ? some2(cause2.error) : none2());
var failureOrCause = (self) => {
  const option3 = failureOption(self);
  switch (option3._tag) {
    case "None": {
      return right2(self);
    }
    case "Some": {
      return left2(option3.value);
    }
  }
};
var interruptOption = (self) => find(self, (cause2) => cause2._tag === OP_INTERRUPT ? some2(cause2.fiberId) : none2());
var stripFailures = (self) => match3(self, {
  onEmpty: empty6,
  onFail: () => empty6,
  onDie: die,
  onInterrupt: interrupt,
  onSequential: sequential,
  onParallel: parallel
});
var electFailures = (self) => match3(self, {
  onEmpty: empty6,
  onFail: die,
  onDie: die,
  onInterrupt: interrupt,
  onSequential: sequential,
  onParallel: parallel
});
var causeEquals = (left3, right3) => {
  let leftStack = of2(left3);
  let rightStack = of2(right3);
  while (isNonEmpty(leftStack) && isNonEmpty(rightStack)) {
    const [leftParallel, leftSequential] = pipe(headNonEmpty2(leftStack), reduce5([empty5(), empty2()], ([parallel4, sequential4], cause2) => {
      const [par2, seq2] = evaluateCause(cause2);
      return some2([pipe(parallel4, union3(par2)), pipe(sequential4, appendAll2(seq2))]);
    }));
    const [rightParallel, rightSequential] = pipe(headNonEmpty2(rightStack), reduce5([empty5(), empty2()], ([parallel4, sequential4], cause2) => {
      const [par2, seq2] = evaluateCause(cause2);
      return some2([pipe(parallel4, union3(par2)), pipe(sequential4, appendAll2(seq2))]);
    }));
    if (!equals(leftParallel, rightParallel)) {
      return false;
    }
    leftStack = leftSequential;
    rightStack = rightSequential;
  }
  return true;
};
var flattenCause = (cause2) => {
  return flattenCauseLoop(of2(cause2), empty2());
};
var flattenCauseLoop = (causes, flattened) => {
  while (1) {
    const [parallel4, sequential4] = pipe(causes, reduce([empty5(), empty2()], ([parallel5, sequential5], cause2) => {
      const [par2, seq2] = evaluateCause(cause2);
      return [pipe(parallel5, union3(par2)), pipe(sequential5, appendAll2(seq2))];
    }));
    const updated = size3(parallel4) > 0 ? pipe(flattened, prepend2(parallel4)) : flattened;
    if (isEmpty(sequential4)) {
      return reverse2(updated);
    }
    causes = sequential4;
    flattened = updated;
  }
  throw new Error(getBugErrorMessage("Cause.flattenCauseLoop"));
};
var find = /* @__PURE__ */ dual(2, (self, pf) => {
  const stack = [self];
  while (stack.length > 0) {
    const item = stack.pop();
    const option3 = pf(item);
    switch (option3._tag) {
      case "None": {
        switch (item._tag) {
          case OP_SEQUENTIAL:
          case OP_PARALLEL: {
            stack.push(item.right);
            stack.push(item.left);
            break;
          }
        }
        break;
      }
      case "Some": {
        return option3;
      }
    }
  }
  return none2();
});
var evaluateCause = (self) => {
  let cause2 = self;
  const stack = [];
  let _parallel = empty5();
  let _sequential = empty2();
  while (cause2 !== void 0) {
    switch (cause2._tag) {
      case OP_EMPTY: {
        if (stack.length === 0) {
          return [_parallel, _sequential];
        }
        cause2 = stack.pop();
        break;
      }
      case OP_FAIL: {
        _parallel = add2(_parallel, make4(cause2._tag, cause2.error));
        if (stack.length === 0) {
          return [_parallel, _sequential];
        }
        cause2 = stack.pop();
        break;
      }
      case OP_DIE: {
        _parallel = add2(_parallel, make4(cause2._tag, cause2.defect));
        if (stack.length === 0) {
          return [_parallel, _sequential];
        }
        cause2 = stack.pop();
        break;
      }
      case OP_INTERRUPT: {
        _parallel = add2(_parallel, make4(cause2._tag, cause2.fiberId));
        if (stack.length === 0) {
          return [_parallel, _sequential];
        }
        cause2 = stack.pop();
        break;
      }
      case OP_SEQUENTIAL: {
        switch (cause2.left._tag) {
          case OP_EMPTY: {
            cause2 = cause2.right;
            break;
          }
          case OP_SEQUENTIAL: {
            cause2 = sequential(cause2.left.left, sequential(cause2.left.right, cause2.right));
            break;
          }
          case OP_PARALLEL: {
            cause2 = parallel(sequential(cause2.left.left, cause2.right), sequential(cause2.left.right, cause2.right));
            break;
          }
          default: {
            _sequential = prepend2(_sequential, cause2.right);
            cause2 = cause2.left;
            break;
          }
        }
        break;
      }
      case OP_PARALLEL: {
        stack.push(cause2.right);
        cause2 = cause2.left;
        break;
      }
    }
  }
  throw new Error(getBugErrorMessage("Cause.evaluateCauseLoop"));
};
var IsInterruptedOnlyCauseReducer = {
  emptyCase: constTrue,
  failCase: constFalse,
  dieCase: constFalse,
  interruptCase: constTrue,
  sequentialCase: (_, left3, right3) => left3 && right3,
  parallelCase: (_, left3, right3) => left3 && right3
};
var OP_SEQUENTIAL_CASE = "SequentialCase";
var OP_PARALLEL_CASE = "ParallelCase";
var match3 = /* @__PURE__ */ dual(2, (self, {
  onDie,
  onEmpty,
  onFail,
  onInterrupt: onInterrupt3,
  onParallel,
  onSequential
}) => {
  return reduceWithContext(self, void 0, {
    emptyCase: () => onEmpty,
    failCase: (_, error) => onFail(error),
    dieCase: (_, defect) => onDie(defect),
    interruptCase: (_, fiberId2) => onInterrupt3(fiberId2),
    sequentialCase: (_, left3, right3) => onSequential(left3, right3),
    parallelCase: (_, left3, right3) => onParallel(left3, right3)
  });
});
var reduce5 = /* @__PURE__ */ dual(3, (self, zero2, pf) => {
  let accumulator = zero2;
  let cause2 = self;
  const causes = [];
  while (cause2 !== void 0) {
    const option3 = pf(accumulator, cause2);
    accumulator = isSome2(option3) ? option3.value : accumulator;
    switch (cause2._tag) {
      case OP_SEQUENTIAL: {
        causes.push(cause2.right);
        cause2 = cause2.left;
        break;
      }
      case OP_PARALLEL: {
        causes.push(cause2.right);
        cause2 = cause2.left;
        break;
      }
      default: {
        cause2 = void 0;
        break;
      }
    }
    if (cause2 === void 0 && causes.length > 0) {
      cause2 = causes.pop();
    }
  }
  return accumulator;
});
var reduceWithContext = /* @__PURE__ */ dual(3, (self, context2, reducer) => {
  const input = [self];
  const output = [];
  while (input.length > 0) {
    const cause2 = input.pop();
    switch (cause2._tag) {
      case OP_EMPTY: {
        output.push(right2(reducer.emptyCase(context2)));
        break;
      }
      case OP_FAIL: {
        output.push(right2(reducer.failCase(context2, cause2.error)));
        break;
      }
      case OP_DIE: {
        output.push(right2(reducer.dieCase(context2, cause2.defect)));
        break;
      }
      case OP_INTERRUPT: {
        output.push(right2(reducer.interruptCase(context2, cause2.fiberId)));
        break;
      }
      case OP_SEQUENTIAL: {
        input.push(cause2.right);
        input.push(cause2.left);
        output.push(left2({
          _tag: OP_SEQUENTIAL_CASE
        }));
        break;
      }
      case OP_PARALLEL: {
        input.push(cause2.right);
        input.push(cause2.left);
        output.push(left2({
          _tag: OP_PARALLEL_CASE
        }));
        break;
      }
    }
  }
  const accumulator = [];
  while (output.length > 0) {
    const either4 = output.pop();
    switch (either4._tag) {
      case "Left": {
        switch (either4.left._tag) {
          case OP_SEQUENTIAL_CASE: {
            const left3 = accumulator.pop();
            const right3 = accumulator.pop();
            const value = reducer.sequentialCase(context2, left3, right3);
            accumulator.push(value);
            break;
          }
          case OP_PARALLEL_CASE: {
            const left3 = accumulator.pop();
            const right3 = accumulator.pop();
            const value = reducer.parallelCase(context2, left3, right3);
            accumulator.push(value);
            break;
          }
        }
        break;
      }
      case "Right": {
        accumulator.push(either4.right);
        break;
      }
    }
  }
  if (accumulator.length === 0) {
    throw new Error("BUG: Cause.reduceWithContext - please report an issue at https://github.com/Effect-TS/effect/issues");
  }
  return accumulator.pop();
});
var pretty = (cause2, options) => {
  if (isInterruptedOnly(cause2)) {
    return "All fibers interrupted without errors.";
  }
  return prettyErrors(cause2).map(function(e) {
    if (options?.renderErrorCause !== true || e.cause === void 0) {
      return e.stack;
    }
    return `${e.stack} {
${renderErrorCause(e.cause, "  ")}
}`;
  }).join("\n");
};
var renderErrorCause = (cause2, prefix) => {
  const lines = cause2.stack.split("\n");
  let stack = `${prefix}[cause]: ${lines[0]}`;
  for (let i = 1, len = lines.length; i < len; i++) {
    stack += `
${prefix}${lines[i]}`;
  }
  if (cause2.cause) {
    stack += ` {
${renderErrorCause(cause2.cause, `${prefix}  `)}
${prefix}}`;
  }
  return stack;
};
var makePrettyError = (originalError) => {
  const originalErrorIsObject = typeof originalError === "object" && originalError !== null;
  const prevLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 1;
  const error = new Error(prettyErrorMessage(originalError), originalErrorIsObject && "cause" in originalError && typeof originalError.cause !== "undefined" ? {
    cause: makePrettyError(originalError.cause)
  } : void 0);
  Error.stackTraceLimit = prevLimit;
  if (error.message === "") {
    error.message = "An error has occurred";
  }
  Error.stackTraceLimit = prevLimit;
  error.name = originalError instanceof Error ? originalError.name : "Error";
  if (originalErrorIsObject) {
    if (spanSymbol in originalError) {
      error.span = originalError[spanSymbol];
    }
    Object.keys(originalError).forEach((key) => {
      if (!(key in error)) {
        error[key] = originalError[key];
      }
    });
  }
  error.stack = prettyErrorStack(`${error.name}: ${error.message}`, originalError instanceof Error && originalError.stack ? originalError.stack : "", error.span);
  return error;
};
var prettyErrorMessage = (u) => {
  if (typeof u === "string") {
    return u;
  }
  if (typeof u === "object" && u !== null && u instanceof Error) {
    return u.message;
  }
  try {
    if (hasProperty(u, "toString") && isFunction2(u["toString"]) && u["toString"] !== Object.prototype.toString && u["toString"] !== globalThis.Array.prototype.toString) {
      return u["toString"]();
    }
  } catch {
  }
  return stringifyCircular(u);
};
var locationRegex = /\((.*)\)/g;
var spanToTrace = /* @__PURE__ */ globalValue("effect/Tracer/spanToTrace", () => /* @__PURE__ */ new WeakMap());
var prettyErrorStack = (message, stack, span2) => {
  const out = [message];
  const lines = stack.startsWith(message) ? stack.slice(message.length).split("\n") : stack.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes(" at new BaseEffectError") || lines[i].includes(" at new YieldableError")) {
      i++;
      continue;
    }
    if (lines[i].includes("Generator.next")) {
      break;
    }
    if (lines[i].includes("effect_internal_function")) {
      break;
    }
    out.push(lines[i].replace(/at .*effect_instruction_i.*\((.*)\)/, "at $1").replace(/EffectPrimitive\.\w+/, "<anonymous>"));
  }
  if (span2) {
    let current = span2;
    let i = 0;
    while (current && current._tag === "Span" && i < 10) {
      const stackFn = spanToTrace.get(current);
      if (typeof stackFn === "function") {
        const stack2 = stackFn();
        if (typeof stack2 === "string") {
          const locationMatchAll = stack2.matchAll(locationRegex);
          let match11 = false;
          for (const [, location] of locationMatchAll) {
            match11 = true;
            out.push(`    at ${current.name} (${location})`);
          }
          if (!match11) {
            out.push(`    at ${current.name} (${stack2.replace(/^at /, "")})`);
          }
        } else {
          out.push(`    at ${current.name}`);
        }
      } else {
        out.push(`    at ${current.name}`);
      }
      current = getOrUndefined(current.parent);
      i++;
    }
  }
  return out.join("\n");
};
var spanSymbol = /* @__PURE__ */ Symbol.for("effect/SpanAnnotation");
var prettyErrors = (cause2) => reduceWithContext(cause2, void 0, {
  emptyCase: () => [],
  dieCase: (_, unknownError) => {
    return [makePrettyError(unknownError)];
  },
  failCase: (_, error) => {
    return [makePrettyError(error)];
  },
  interruptCase: () => [],
  parallelCase: (_, l, r) => [...l, ...r],
  sequentialCase: (_, l, r) => [...l, ...r]
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/context.js
var TagTypeId = /* @__PURE__ */ Symbol.for("effect/Context/Tag");
var ReferenceTypeId = /* @__PURE__ */ Symbol.for("effect/Context/Reference");
var STMSymbolKey = "effect/STM";
var STMTypeId = /* @__PURE__ */ Symbol.for(STMSymbolKey);
var TagProto = {
  ...EffectPrototype,
  _op: "Tag",
  [STMTypeId]: effectVariance,
  [TagTypeId]: {
    _Service: (_) => _,
    _Identifier: (_) => _
  },
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "Tag",
      key: this.key,
      stack: this.stack
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  of(self) {
    return self;
  },
  context(self) {
    return make8(this, self);
  }
};
var ReferenceProto = {
  ...TagProto,
  [ReferenceTypeId]: ReferenceTypeId
};
var makeGenericTag = (key) => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 2;
  const creationError = new Error();
  Error.stackTraceLimit = limit;
  const tag = Object.create(TagProto);
  Object.defineProperty(tag, "stack", {
    get() {
      return creationError.stack;
    }
  });
  tag.key = key;
  return tag;
};
var Reference = () => (id2, options) => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 2;
  const creationError = new Error();
  Error.stackTraceLimit = limit;
  function ReferenceClass() {
  }
  Object.setPrototypeOf(ReferenceClass, ReferenceProto);
  ReferenceClass.key = id2;
  ReferenceClass.defaultValue = options.defaultValue;
  Object.defineProperty(ReferenceClass, "stack", {
    get() {
      return creationError.stack;
    }
  });
  return ReferenceClass;
};
var TypeId4 = /* @__PURE__ */ Symbol.for("effect/Context");
var ContextProto = {
  [TypeId4]: {
    _Services: (_) => _
  },
  [symbol2](that) {
    if (isContext(that)) {
      if (this.unsafeMap.size === that.unsafeMap.size) {
        for (const k of this.unsafeMap.keys()) {
          if (!that.unsafeMap.has(k) || !equals(this.unsafeMap.get(k), that.unsafeMap.get(k))) {
            return false;
          }
        }
        return true;
      }
    }
    return false;
  },
  [symbol]() {
    return cached(this, number(this.unsafeMap.size));
  },
  pipe() {
    return pipeArguments(this, arguments);
  },
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "Context",
      services: Array.from(this.unsafeMap).map(toJSON)
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
};
var makeContext = (unsafeMap) => {
  const context2 = Object.create(ContextProto);
  context2.unsafeMap = unsafeMap;
  return context2;
};
var serviceNotFoundError = (tag) => {
  const error = new Error(`Service not found${tag.key ? `: ${String(tag.key)}` : ""}`);
  if (tag.stack) {
    const lines = tag.stack.split("\n");
    if (lines.length > 2) {
      const afterAt = lines[2].match(/at (.*)/);
      if (afterAt) {
        error.message = error.message + ` (defined at ${afterAt[1]})`;
      }
    }
  }
  if (error.stack) {
    const lines = error.stack.split("\n");
    lines.splice(1, 3);
    error.stack = lines.join("\n");
  }
  return error;
};
var isContext = (u) => hasProperty(u, TypeId4);
var isReference = (u) => hasProperty(u, ReferenceTypeId);
var _empty4 = /* @__PURE__ */ makeContext(/* @__PURE__ */ new Map());
var empty7 = () => _empty4;
var make8 = (tag, service) => makeContext(/* @__PURE__ */ new Map([[tag.key, service]]));
var add3 = /* @__PURE__ */ dual(3, (self, tag, service) => {
  const map12 = new Map(self.unsafeMap);
  map12.set(tag.key, service);
  return makeContext(map12);
});
var defaultValueCache = /* @__PURE__ */ globalValue("effect/Context/defaultValueCache", () => /* @__PURE__ */ new Map());
var getDefaultValue = (tag) => {
  if (defaultValueCache.has(tag.key)) {
    return defaultValueCache.get(tag.key);
  }
  const value = tag.defaultValue();
  defaultValueCache.set(tag.key, value);
  return value;
};
var unsafeGetReference = (self, tag) => {
  return self.unsafeMap.has(tag.key) ? self.unsafeMap.get(tag.key) : getDefaultValue(tag);
};
var unsafeGet3 = /* @__PURE__ */ dual(2, (self, tag) => {
  if (!self.unsafeMap.has(tag.key)) {
    if (ReferenceTypeId in tag) return getDefaultValue(tag);
    throw serviceNotFoundError(tag);
  }
  return self.unsafeMap.get(tag.key);
});
var get4 = unsafeGet3;
var getOption = /* @__PURE__ */ dual(2, (self, tag) => {
  if (!self.unsafeMap.has(tag.key)) {
    return isReference(tag) ? some(getDefaultValue(tag)) : none;
  }
  return some(self.unsafeMap.get(tag.key));
});
var merge2 = /* @__PURE__ */ dual(2, (self, that) => {
  const map12 = new Map(self.unsafeMap);
  for (const [tag, s] of that.unsafeMap) {
    map12.set(tag, s);
  }
  return makeContext(map12);
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Context.js
var GenericTag = makeGenericTag;
var empty8 = empty7;
var make9 = make8;
var add4 = add3;
var get5 = get4;
var unsafeGet4 = unsafeGet3;
var getOption2 = getOption;
var merge3 = merge2;
var Reference2 = Reference;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Duration.js
var TypeId5 = /* @__PURE__ */ Symbol.for("effect/Duration");
var bigint0 = /* @__PURE__ */ BigInt(0);
var bigint24 = /* @__PURE__ */ BigInt(24);
var bigint60 = /* @__PURE__ */ BigInt(60);
var bigint1e3 = /* @__PURE__ */ BigInt(1e3);
var bigint1e6 = /* @__PURE__ */ BigInt(1e6);
var bigint1e9 = /* @__PURE__ */ BigInt(1e9);
var DURATION_REGEX = /^(-?\d+(?:\.\d+)?)\s+(nanos?|micros?|millis?|seconds?|minutes?|hours?|days?|weeks?)$/;
var decode = (input) => {
  if (isDuration(input)) {
    return input;
  } else if (isNumber(input)) {
    return millis(input);
  } else if (isBigInt(input)) {
    return nanos(input);
  } else if (Array.isArray(input) && input.length === 2 && input.every(isNumber)) {
    if (input[0] === -Infinity || input[1] === -Infinity || Number.isNaN(input[0]) || Number.isNaN(input[1])) {
      return zero;
    }
    if (input[0] === Infinity || input[1] === Infinity) {
      return infinity;
    }
    return nanos(BigInt(Math.round(input[0] * 1e9)) + BigInt(Math.round(input[1])));
  } else if (isString(input)) {
    const match11 = DURATION_REGEX.exec(input);
    if (match11) {
      const [_, valueStr, unit] = match11;
      const value = Number(valueStr);
      switch (unit) {
        case "nano":
        case "nanos":
          return nanos(BigInt(valueStr));
        case "micro":
        case "micros":
          return micros(BigInt(valueStr));
        case "milli":
        case "millis":
          return millis(value);
        case "second":
        case "seconds":
          return seconds(value);
        case "minute":
        case "minutes":
          return minutes(value);
        case "hour":
        case "hours":
          return hours(value);
        case "day":
        case "days":
          return days(value);
        case "week":
        case "weeks":
          return weeks(value);
      }
    }
  }
  throw new Error("Invalid DurationInput");
};
var zeroValue = {
  _tag: "Millis",
  millis: 0
};
var infinityValue = {
  _tag: "Infinity"
};
var DurationProto = {
  [TypeId5]: TypeId5,
  [symbol]() {
    return cached(this, structure(this.value));
  },
  [symbol2](that) {
    return isDuration(that) && equals2(this, that);
  },
  toString() {
    return `Duration(${format2(this)})`;
  },
  toJSON() {
    switch (this.value._tag) {
      case "Millis":
        return {
          _id: "Duration",
          _tag: "Millis",
          millis: this.value.millis
        };
      case "Nanos":
        return {
          _id: "Duration",
          _tag: "Nanos",
          hrtime: toHrTime(this)
        };
      case "Infinity":
        return {
          _id: "Duration",
          _tag: "Infinity"
        };
    }
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var make10 = (input) => {
  const duration = Object.create(DurationProto);
  if (isNumber(input)) {
    if (isNaN(input) || input <= 0) {
      duration.value = zeroValue;
    } else if (!Number.isFinite(input)) {
      duration.value = infinityValue;
    } else if (!Number.isInteger(input)) {
      duration.value = {
        _tag: "Nanos",
        nanos: BigInt(Math.round(input * 1e6))
      };
    } else {
      duration.value = {
        _tag: "Millis",
        millis: input
      };
    }
  } else if (input <= bigint0) {
    duration.value = zeroValue;
  } else {
    duration.value = {
      _tag: "Nanos",
      nanos: input
    };
  }
  return duration;
};
var isDuration = (u) => hasProperty(u, TypeId5);
var isZero = (self) => {
  switch (self.value._tag) {
    case "Millis": {
      return self.value.millis === 0;
    }
    case "Nanos": {
      return self.value.nanos === bigint0;
    }
    case "Infinity": {
      return false;
    }
  }
};
var zero = /* @__PURE__ */ make10(0);
var infinity = /* @__PURE__ */ make10(Infinity);
var nanos = (nanos2) => make10(nanos2);
var micros = (micros2) => make10(micros2 * bigint1e3);
var millis = (millis2) => make10(millis2);
var seconds = (seconds2) => make10(seconds2 * 1e3);
var minutes = (minutes2) => make10(minutes2 * 6e4);
var hours = (hours2) => make10(hours2 * 36e5);
var days = (days2) => make10(days2 * 864e5);
var weeks = (weeks2) => make10(weeks2 * 6048e5);
var toMillis = (self) => match4(self, {
  onMillis: (millis2) => millis2,
  onNanos: (nanos2) => Number(nanos2) / 1e6
});
var unsafeToNanos = (self) => {
  const _self = decode(self);
  switch (_self.value._tag) {
    case "Infinity":
      throw new Error("Cannot convert infinite duration to nanos");
    case "Nanos":
      return _self.value.nanos;
    case "Millis":
      return BigInt(Math.round(_self.value.millis * 1e6));
  }
};
var toHrTime = (self) => {
  const _self = decode(self);
  switch (_self.value._tag) {
    case "Infinity":
      return [Infinity, 0];
    case "Nanos":
      return [Number(_self.value.nanos / bigint1e9), Number(_self.value.nanos % bigint1e9)];
    case "Millis":
      return [Math.floor(_self.value.millis / 1e3), Math.round(_self.value.millis % 1e3 * 1e6)];
  }
};
var match4 = /* @__PURE__ */ dual(2, (self, options) => {
  const _self = decode(self);
  switch (_self.value._tag) {
    case "Nanos":
      return options.onNanos(_self.value.nanos);
    case "Infinity":
      return options.onMillis(Infinity);
    case "Millis":
      return options.onMillis(_self.value.millis);
  }
});
var matchWith = /* @__PURE__ */ dual(3, (self, that, options) => {
  const _self = decode(self);
  const _that = decode(that);
  if (_self.value._tag === "Infinity" || _that.value._tag === "Infinity") {
    return options.onMillis(toMillis(_self), toMillis(_that));
  } else if (_self.value._tag === "Nanos" || _that.value._tag === "Nanos") {
    const selfNanos = _self.value._tag === "Nanos" ? _self.value.nanos : BigInt(Math.round(_self.value.millis * 1e6));
    const thatNanos = _that.value._tag === "Nanos" ? _that.value.nanos : BigInt(Math.round(_that.value.millis * 1e6));
    return options.onNanos(selfNanos, thatNanos);
  }
  return options.onMillis(_self.value.millis, _that.value.millis);
});
var Equivalence = (self, that) => matchWith(self, that, {
  onMillis: (self2, that2) => self2 === that2,
  onNanos: (self2, that2) => self2 === that2
});
var lessThanOrEqualTo = /* @__PURE__ */ dual(2, (self, that) => matchWith(self, that, {
  onMillis: (self2, that2) => self2 <= that2,
  onNanos: (self2, that2) => self2 <= that2
}));
var greaterThanOrEqualTo = /* @__PURE__ */ dual(2, (self, that) => matchWith(self, that, {
  onMillis: (self2, that2) => self2 >= that2,
  onNanos: (self2, that2) => self2 >= that2
}));
var equals2 = /* @__PURE__ */ dual(2, (self, that) => Equivalence(decode(self), decode(that)));
var parts = (self) => {
  const duration = decode(self);
  if (duration.value._tag === "Infinity") {
    return {
      days: Infinity,
      hours: Infinity,
      minutes: Infinity,
      seconds: Infinity,
      millis: Infinity,
      nanos: Infinity
    };
  }
  const nanos2 = unsafeToNanos(duration);
  const ms = nanos2 / bigint1e6;
  const sec = ms / bigint1e3;
  const min2 = sec / bigint60;
  const hr = min2 / bigint60;
  const days2 = hr / bigint24;
  return {
    days: Number(days2),
    hours: Number(hr % bigint24),
    minutes: Number(min2 % bigint60),
    seconds: Number(sec % bigint60),
    millis: Number(ms % bigint1e3),
    nanos: Number(nanos2 % bigint1e6)
  };
};
var format2 = (self) => {
  const duration = decode(self);
  if (duration.value._tag === "Infinity") {
    return "Infinity";
  }
  if (isZero(duration)) {
    return "0";
  }
  const fragments = parts(duration);
  const pieces = [];
  if (fragments.days !== 0) {
    pieces.push(`${fragments.days}d`);
  }
  if (fragments.hours !== 0) {
    pieces.push(`${fragments.hours}h`);
  }
  if (fragments.minutes !== 0) {
    pieces.push(`${fragments.minutes}m`);
  }
  if (fragments.seconds !== 0) {
    pieces.push(`${fragments.seconds}s`);
  }
  if (fragments.millis !== 0) {
    pieces.push(`${fragments.millis}ms`);
  }
  if (fragments.nanos !== 0) {
    pieces.push(`${fragments.nanos}ns`);
  }
  return pieces.join(" ");
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/MutableRef.js
var TypeId6 = /* @__PURE__ */ Symbol.for("effect/MutableRef");
var MutableRefProto = {
  [TypeId6]: TypeId6,
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "MutableRef",
      current: toJSON(this.current)
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var make11 = (value) => {
  const ref = Object.create(MutableRefProto);
  ref.current = value;
  return ref;
};
var compareAndSet = /* @__PURE__ */ dual(3, (self, oldValue, newValue) => {
  if (equals(oldValue, self.current)) {
    self.current = newValue;
    return true;
  }
  return false;
});
var get6 = (self) => self.current;
var set2 = /* @__PURE__ */ dual(2, (self, value) => {
  self.current = value;
  return self;
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/fiberId.js
var FiberIdSymbolKey = "effect/FiberId";
var FiberIdTypeId = /* @__PURE__ */ Symbol.for(FiberIdSymbolKey);
var OP_NONE = "None";
var OP_RUNTIME = "Runtime";
var OP_COMPOSITE = "Composite";
var emptyHash = /* @__PURE__ */ string(`${FiberIdSymbolKey}-${OP_NONE}`);
var None = class {
  [FiberIdTypeId] = FiberIdTypeId;
  _tag = OP_NONE;
  id = -1;
  startTimeMillis = -1;
  [symbol]() {
    return emptyHash;
  }
  [symbol2](that) {
    return isFiberId(that) && that._tag === OP_NONE;
  }
  toString() {
    return format(this.toJSON());
  }
  toJSON() {
    return {
      _id: "FiberId",
      _tag: this._tag
    };
  }
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
};
var Runtime = class {
  id;
  startTimeMillis;
  [FiberIdTypeId] = FiberIdTypeId;
  _tag = OP_RUNTIME;
  constructor(id2, startTimeMillis) {
    this.id = id2;
    this.startTimeMillis = startTimeMillis;
  }
  [symbol]() {
    return cached(this, string(`${FiberIdSymbolKey}-${this._tag}-${this.id}-${this.startTimeMillis}`));
  }
  [symbol2](that) {
    return isFiberId(that) && that._tag === OP_RUNTIME && this.id === that.id && this.startTimeMillis === that.startTimeMillis;
  }
  toString() {
    return format(this.toJSON());
  }
  toJSON() {
    return {
      _id: "FiberId",
      _tag: this._tag,
      id: this.id,
      startTimeMillis: this.startTimeMillis
    };
  }
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
};
var Composite = class {
  left;
  right;
  [FiberIdTypeId] = FiberIdTypeId;
  _tag = OP_COMPOSITE;
  constructor(left3, right3) {
    this.left = left3;
    this.right = right3;
  }
  _hash;
  [symbol]() {
    return pipe(string(`${FiberIdSymbolKey}-${this._tag}`), combine(hash(this.left)), combine(hash(this.right)), cached(this));
  }
  [symbol2](that) {
    return isFiberId(that) && that._tag === OP_COMPOSITE && equals(this.left, that.left) && equals(this.right, that.right);
  }
  toString() {
    return format(this.toJSON());
  }
  toJSON() {
    return {
      _id: "FiberId",
      _tag: this._tag,
      left: toJSON(this.left),
      right: toJSON(this.right)
    };
  }
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
};
var none3 = /* @__PURE__ */ new None();
var isFiberId = (self) => hasProperty(self, FiberIdTypeId);
var combine2 = /* @__PURE__ */ dual(2, (self, that) => {
  if (self._tag === OP_NONE) {
    return that;
  }
  if (that._tag === OP_NONE) {
    return self;
  }
  return new Composite(self, that);
});
var ids = (self) => {
  switch (self._tag) {
    case OP_NONE: {
      return empty5();
    }
    case OP_RUNTIME: {
      return make7(self.id);
    }
    case OP_COMPOSITE: {
      return pipe(ids(self.left), union3(ids(self.right)));
    }
  }
};
var _fiberCounter = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/Fiber/Id/_fiberCounter"), () => make11(0));
var threadName = (self) => {
  const identifiers = Array.from(ids(self)).map((n) => `#${n}`).join(",");
  return identifiers;
};
var unsafeMake = () => {
  const id2 = get6(_fiberCounter);
  pipe(_fiberCounter, set2(id2 + 1));
  return new Runtime(id2, Date.now());
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/FiberId.js
var none4 = none3;
var combine3 = combine2;
var threadName2 = threadName;
var unsafeMake2 = unsafeMake;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/HashMap.js
var empty9 = empty3;
var fromIterable6 = fromIterable3;
var isEmpty4 = isEmpty2;
var get7 = get3;
var set3 = set;
var keys2 = keys;
var modifyAt2 = modifyAt;
var map6 = map3;
var reduce6 = reduce2;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/List.js
var TypeId7 = /* @__PURE__ */ Symbol.for("effect/List");
var toArray2 = (self) => fromIterable(self);
var getEquivalence3 = (isEquivalent) => mapInput(getEquivalence(isEquivalent), toArray2);
var _equivalence4 = /* @__PURE__ */ getEquivalence3(equals);
var ConsProto = {
  [TypeId7]: TypeId7,
  _tag: "Cons",
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "List",
      _tag: "Cons",
      values: toArray2(this).map(toJSON)
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  [symbol2](that) {
    return isList(that) && this._tag === that._tag && _equivalence4(this, that);
  },
  [symbol]() {
    return cached(this, array2(toArray2(this)));
  },
  [Symbol.iterator]() {
    let done5 = false;
    let self = this;
    return {
      next() {
        if (done5) {
          return this.return();
        }
        if (self._tag === "Nil") {
          done5 = true;
          return this.return();
        }
        const value = self.head;
        self = self.tail;
        return {
          done: done5,
          value
        };
      },
      return(value) {
        if (!done5) {
          done5 = true;
        }
        return {
          done: true,
          value
        };
      }
    };
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var makeCons = (head4, tail) => {
  const cons2 = Object.create(ConsProto);
  cons2.head = head4;
  cons2.tail = tail;
  return cons2;
};
var NilHash = /* @__PURE__ */ string("Nil");
var NilProto = {
  [TypeId7]: TypeId7,
  _tag: "Nil",
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "List",
      _tag: "Nil"
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  [symbol]() {
    return NilHash;
  },
  [symbol2](that) {
    return isList(that) && this._tag === that._tag;
  },
  [Symbol.iterator]() {
    return {
      next() {
        return {
          done: true,
          value: void 0
        };
      }
    };
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var _Nil = /* @__PURE__ */ Object.create(NilProto);
var isList = (u) => hasProperty(u, TypeId7);
var isNil = (self) => self._tag === "Nil";
var isCons = (self) => self._tag === "Cons";
var nil = () => _Nil;
var cons = (head4, tail) => makeCons(head4, tail);
var empty10 = nil;
var of3 = (value) => makeCons(value, _Nil);
var appendAll3 = /* @__PURE__ */ dual(2, (self, that) => prependAll(that, self));
var prepend3 = /* @__PURE__ */ dual(2, (self, element) => cons(element, self));
var prependAll = /* @__PURE__ */ dual(2, (self, prefix) => {
  if (isNil(self)) {
    return prefix;
  } else if (isNil(prefix)) {
    return self;
  } else {
    const result = makeCons(prefix.head, self);
    let curr = result;
    let that = prefix.tail;
    while (!isNil(that)) {
      const temp = makeCons(that.head, self);
      curr.tail = temp;
      curr = temp;
      that = that.tail;
    }
    return result;
  }
});
var reduce7 = /* @__PURE__ */ dual(3, (self, zero2, f) => {
  let acc = zero2;
  let these = self;
  while (!isNil(these)) {
    acc = f(acc, these.head);
    these = these.tail;
  }
  return acc;
});
var reverse3 = (self) => {
  let result = empty10();
  let these = self;
  while (!isNil(these)) {
    result = prepend3(result, these.head);
    these = these.tail;
  }
  return result;
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/data.js
var ArrayProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(Array.prototype), {
  [symbol]() {
    return cached(this, array2(this));
  },
  [symbol2](that) {
    if (Array.isArray(that) && this.length === that.length) {
      return this.every((v, i) => equals(v, that[i]));
    } else {
      return false;
    }
  }
});
var Structural = /* @__PURE__ */ (function() {
  function Structural2(args2) {
    if (args2) {
      Object.assign(this, args2);
    }
  }
  Structural2.prototype = StructuralPrototype;
  return Structural2;
})();

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/differ/contextPatch.js
var ContextPatchTypeId = /* @__PURE__ */ Symbol.for("effect/DifferContextPatch");
function variance2(a) {
  return a;
}
var PatchProto = {
  ...Structural.prototype,
  [ContextPatchTypeId]: {
    _Value: variance2,
    _Patch: variance2
  }
};
var EmptyProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto), {
  _tag: "Empty"
});
var _empty5 = /* @__PURE__ */ Object.create(EmptyProto);
var empty11 = () => _empty5;
var AndThenProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto), {
  _tag: "AndThen"
});
var makeAndThen = (first2, second) => {
  const o = Object.create(AndThenProto);
  o.first = first2;
  o.second = second;
  return o;
};
var AddServiceProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto), {
  _tag: "AddService"
});
var makeAddService = (key, service) => {
  const o = Object.create(AddServiceProto);
  o.key = key;
  o.service = service;
  return o;
};
var RemoveServiceProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto), {
  _tag: "RemoveService"
});
var makeRemoveService = (key) => {
  const o = Object.create(RemoveServiceProto);
  o.key = key;
  return o;
};
var UpdateServiceProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto), {
  _tag: "UpdateService"
});
var makeUpdateService = (key, update4) => {
  const o = Object.create(UpdateServiceProto);
  o.key = key;
  o.update = update4;
  return o;
};
var diff = (oldValue, newValue) => {
  const missingServices = new Map(oldValue.unsafeMap);
  let patch9 = empty11();
  for (const [tag, newService] of newValue.unsafeMap.entries()) {
    if (missingServices.has(tag)) {
      const old = missingServices.get(tag);
      missingServices.delete(tag);
      if (!equals(old, newService)) {
        patch9 = combine4(makeUpdateService(tag, () => newService))(patch9);
      }
    } else {
      missingServices.delete(tag);
      patch9 = combine4(makeAddService(tag, newService))(patch9);
    }
  }
  for (const [tag] of missingServices.entries()) {
    patch9 = combine4(makeRemoveService(tag))(patch9);
  }
  return patch9;
};
var combine4 = /* @__PURE__ */ dual(2, (self, that) => makeAndThen(self, that));
var patch = /* @__PURE__ */ dual(2, (self, context2) => {
  if (self._tag === "Empty") {
    return context2;
  }
  let wasServiceUpdated = false;
  let patches = of2(self);
  const updatedContext = new Map(context2.unsafeMap);
  while (isNonEmpty(patches)) {
    const head4 = headNonEmpty2(patches);
    const tail = tailNonEmpty2(patches);
    switch (head4._tag) {
      case "Empty": {
        patches = tail;
        break;
      }
      case "AddService": {
        updatedContext.set(head4.key, head4.service);
        patches = tail;
        break;
      }
      case "AndThen": {
        patches = prepend2(prepend2(tail, head4.second), head4.first);
        break;
      }
      case "RemoveService": {
        updatedContext.delete(head4.key);
        patches = tail;
        break;
      }
      case "UpdateService": {
        updatedContext.set(head4.key, head4.update(updatedContext.get(head4.key)));
        wasServiceUpdated = true;
        patches = tail;
        break;
      }
    }
  }
  if (!wasServiceUpdated) {
    return makeContext(updatedContext);
  }
  const map12 = /* @__PURE__ */ new Map();
  for (const [tag] of context2.unsafeMap) {
    if (updatedContext.has(tag)) {
      map12.set(tag, updatedContext.get(tag));
      updatedContext.delete(tag);
    }
  }
  for (const [tag, s] of updatedContext) {
    map12.set(tag, s);
  }
  return makeContext(map12);
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/differ/hashSetPatch.js
var HashSetPatchTypeId = /* @__PURE__ */ Symbol.for("effect/DifferHashSetPatch");
function variance3(a) {
  return a;
}
var PatchProto2 = {
  ...Structural.prototype,
  [HashSetPatchTypeId]: {
    _Value: variance3,
    _Key: variance3,
    _Patch: variance3
  }
};
var EmptyProto2 = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto2), {
  _tag: "Empty"
});
var _empty6 = /* @__PURE__ */ Object.create(EmptyProto2);
var empty12 = () => _empty6;
var AndThenProto2 = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto2), {
  _tag: "AndThen"
});
var makeAndThen2 = (first2, second) => {
  const o = Object.create(AndThenProto2);
  o.first = first2;
  o.second = second;
  return o;
};
var AddProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto2), {
  _tag: "Add"
});
var makeAdd = (value) => {
  const o = Object.create(AddProto);
  o.value = value;
  return o;
};
var RemoveProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto2), {
  _tag: "Remove"
});
var makeRemove = (value) => {
  const o = Object.create(RemoveProto);
  o.value = value;
  return o;
};
var diff2 = (oldValue, newValue) => {
  const [removed, patch9] = reduce4([oldValue, empty12()], ([set6, patch10], value) => {
    if (has3(value)(set6)) {
      return [remove4(value)(set6), patch10];
    }
    return [set6, combine5(makeAdd(value))(patch10)];
  })(newValue);
  return reduce4(patch9, (patch10, value) => combine5(makeRemove(value))(patch10))(removed);
};
var combine5 = /* @__PURE__ */ dual(2, (self, that) => makeAndThen2(self, that));
var patch2 = /* @__PURE__ */ dual(2, (self, oldValue) => {
  if (self._tag === "Empty") {
    return oldValue;
  }
  let set6 = oldValue;
  let patches = of2(self);
  while (isNonEmpty(patches)) {
    const head4 = headNonEmpty2(patches);
    const tail = tailNonEmpty2(patches);
    switch (head4._tag) {
      case "Empty": {
        patches = tail;
        break;
      }
      case "AndThen": {
        patches = prepend2(head4.first)(prepend2(head4.second)(tail));
        break;
      }
      case "Add": {
        set6 = add2(head4.value)(set6);
        patches = tail;
        break;
      }
      case "Remove": {
        set6 = remove4(head4.value)(set6);
        patches = tail;
      }
    }
  }
  return set6;
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/differ/readonlyArrayPatch.js
var ReadonlyArrayPatchTypeId = /* @__PURE__ */ Symbol.for("effect/DifferReadonlyArrayPatch");
function variance4(a) {
  return a;
}
var PatchProto3 = {
  ...Structural.prototype,
  [ReadonlyArrayPatchTypeId]: {
    _Value: variance4,
    _Patch: variance4
  }
};
var EmptyProto3 = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto3), {
  _tag: "Empty"
});
var _empty7 = /* @__PURE__ */ Object.create(EmptyProto3);
var empty13 = () => _empty7;
var AndThenProto3 = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto3), {
  _tag: "AndThen"
});
var makeAndThen3 = (first2, second) => {
  const o = Object.create(AndThenProto3);
  o.first = first2;
  o.second = second;
  return o;
};
var AppendProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto3), {
  _tag: "Append"
});
var makeAppend = (values3) => {
  const o = Object.create(AppendProto);
  o.values = values3;
  return o;
};
var SliceProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto3), {
  _tag: "Slice"
});
var makeSlice = (from, until) => {
  const o = Object.create(SliceProto);
  o.from = from;
  o.until = until;
  return o;
};
var UpdateProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(PatchProto3), {
  _tag: "Update"
});
var makeUpdate = (index, patch9) => {
  const o = Object.create(UpdateProto);
  o.index = index;
  o.patch = patch9;
  return o;
};
var diff3 = (options) => {
  let i = 0;
  let patch9 = empty13();
  while (i < options.oldValue.length && i < options.newValue.length) {
    const oldElement = options.oldValue[i];
    const newElement = options.newValue[i];
    const valuePatch = options.differ.diff(oldElement, newElement);
    if (!equals(valuePatch, options.differ.empty)) {
      patch9 = combine6(patch9, makeUpdate(i, valuePatch));
    }
    i = i + 1;
  }
  if (i < options.oldValue.length) {
    patch9 = combine6(patch9, makeSlice(0, i));
  }
  if (i < options.newValue.length) {
    patch9 = combine6(patch9, makeAppend(drop(i)(options.newValue)));
  }
  return patch9;
};
var combine6 = /* @__PURE__ */ dual(2, (self, that) => makeAndThen3(self, that));
var patch3 = /* @__PURE__ */ dual(3, (self, oldValue, differ3) => {
  if (self._tag === "Empty") {
    return oldValue;
  }
  let readonlyArray2 = oldValue.slice();
  let patches = of(self);
  while (isNonEmptyArray2(patches)) {
    const head4 = headNonEmpty(patches);
    const tail = tailNonEmpty(patches);
    switch (head4._tag) {
      case "Empty": {
        patches = tail;
        break;
      }
      case "AndThen": {
        tail.unshift(head4.first, head4.second);
        patches = tail;
        break;
      }
      case "Append": {
        for (const value of head4.values) {
          readonlyArray2.push(value);
        }
        patches = tail;
        break;
      }
      case "Slice": {
        readonlyArray2 = readonlyArray2.slice(head4.from, head4.until);
        patches = tail;
        break;
      }
      case "Update": {
        readonlyArray2[head4.index] = differ3.patch(head4.patch, readonlyArray2[head4.index]);
        patches = tail;
        break;
      }
    }
  }
  return readonlyArray2;
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/differ.js
var DifferTypeId = /* @__PURE__ */ Symbol.for("effect/Differ");
var DifferProto = {
  [DifferTypeId]: {
    _P: identity,
    _V: identity
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var make14 = (params) => {
  const differ3 = Object.create(DifferProto);
  differ3.empty = params.empty;
  differ3.diff = params.diff;
  differ3.combine = params.combine;
  differ3.patch = params.patch;
  return differ3;
};
var environment = () => make14({
  empty: empty11(),
  combine: (first2, second) => combine4(second)(first2),
  diff: (oldValue, newValue) => diff(oldValue, newValue),
  patch: (patch9, oldValue) => patch(oldValue)(patch9)
});
var hashSet = () => make14({
  empty: empty12(),
  combine: (first2, second) => combine5(second)(first2),
  diff: (oldValue, newValue) => diff2(oldValue, newValue),
  patch: (patch9, oldValue) => patch2(oldValue)(patch9)
});
var readonlyArray = (differ3) => make14({
  empty: empty13(),
  combine: (first2, second) => combine6(first2, second),
  diff: (oldValue, newValue) => diff3({
    oldValue,
    newValue,
    differ: differ3
  }),
  patch: (patch9, oldValue) => patch3(patch9, oldValue, differ3)
});
var update = () => updateWith((_, a) => a);
var updateWith = (f) => make14({
  empty: identity,
  combine: (first2, second) => {
    if (first2 === identity) {
      return second;
    }
    if (second === identity) {
      return first2;
    }
    return (a) => second(first2(a));
  },
  diff: (oldValue, newValue) => {
    if (equals(oldValue, newValue)) {
      return identity;
    }
    return constant(newValue);
  },
  patch: (patch9, oldValue) => f(oldValue, patch9(oldValue))
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/runtimeFlagsPatch.js
var BIT_MASK = 255;
var BIT_SHIFT = 8;
var active = (patch9) => patch9 & BIT_MASK;
var enabled = (patch9) => patch9 >> BIT_SHIFT & BIT_MASK;
var make15 = (active2, enabled2) => (active2 & BIT_MASK) + ((enabled2 & active2 & BIT_MASK) << BIT_SHIFT);
var empty14 = /* @__PURE__ */ make15(0, 0);
var enable = (flag) => make15(flag, flag);
var disable = (flag) => make15(flag, 0);
var exclude = /* @__PURE__ */ dual(2, (self, flag) => make15(active(self) & ~flag, enabled(self)));
var andThen = /* @__PURE__ */ dual(2, (self, that) => self | that);
var invert = (n) => ~n >>> 0 & BIT_MASK;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/runtimeFlags.js
var None2 = 0;
var Interruption = 1 << 0;
var OpSupervision = 1 << 1;
var RuntimeMetrics = 1 << 2;
var WindDown = 1 << 4;
var CooperativeYielding = 1 << 5;
var cooperativeYielding = (self) => isEnabled(self, CooperativeYielding);
var disable2 = /* @__PURE__ */ dual(2, (self, flag) => self & ~flag);
var enable2 = /* @__PURE__ */ dual(2, (self, flag) => self | flag);
var interruptible = (self) => interruption(self) && !windDown(self);
var interruption = (self) => isEnabled(self, Interruption);
var isEnabled = /* @__PURE__ */ dual(2, (self, flag) => (self & flag) !== 0);
var make16 = (...flags) => flags.reduce((a, b) => a | b, 0);
var none5 = /* @__PURE__ */ make16(None2);
var runtimeMetrics = (self) => isEnabled(self, RuntimeMetrics);
var windDown = (self) => isEnabled(self, WindDown);
var diff4 = /* @__PURE__ */ dual(2, (self, that) => make15(self ^ that, that));
var patch4 = /* @__PURE__ */ dual(2, (self, patch9) => self & (invert(active(patch9)) | enabled(patch9)) | active(patch9) & enabled(patch9));
var differ = /* @__PURE__ */ make14({
  empty: empty14,
  diff: (oldValue, newValue) => diff4(oldValue, newValue),
  combine: (first2, second) => andThen(second)(first2),
  patch: (_patch, oldValue) => patch4(oldValue, _patch)
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/RuntimeFlagsPatch.js
var enable3 = enable;
var disable3 = disable;
var exclude2 = exclude;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/blockedRequests.js
var par = (self, that) => ({
  _tag: "Par",
  left: self,
  right: that
});
var seq = (self, that) => ({
  _tag: "Seq",
  left: self,
  right: that
});
var flatten2 = (self) => {
  let current = of3(self);
  let updated = empty10();
  while (1) {
    const [parallel4, sequential4] = reduce7(current, [parallelCollectionEmpty(), empty10()], ([parallel5, sequential5], blockedRequest) => {
      const [par2, seq2] = step(blockedRequest);
      return [parallelCollectionCombine(parallel5, par2), appendAll3(sequential5, seq2)];
    });
    updated = merge4(updated, parallel4);
    if (isNil(sequential4)) {
      return reverse3(updated);
    }
    current = sequential4;
  }
  throw new Error("BUG: BlockedRequests.flatten - please report an issue at https://github.com/Effect-TS/effect/issues");
};
var step = (requests) => {
  let current = requests;
  let parallel4 = parallelCollectionEmpty();
  let stack = empty10();
  let sequential4 = empty10();
  while (1) {
    switch (current._tag) {
      case "Empty": {
        if (isNil(stack)) {
          return [parallel4, sequential4];
        }
        current = stack.head;
        stack = stack.tail;
        break;
      }
      case "Par": {
        stack = cons(current.right, stack);
        current = current.left;
        break;
      }
      case "Seq": {
        const left3 = current.left;
        const right3 = current.right;
        switch (left3._tag) {
          case "Empty": {
            current = right3;
            break;
          }
          case "Par": {
            const l = left3.left;
            const r = left3.right;
            current = par(seq(l, right3), seq(r, right3));
            break;
          }
          case "Seq": {
            const l = left3.left;
            const r = left3.right;
            current = seq(l, seq(r, right3));
            break;
          }
          case "Single": {
            current = left3;
            sequential4 = cons(right3, sequential4);
            break;
          }
        }
        break;
      }
      case "Single": {
        parallel4 = parallelCollectionAdd(parallel4, current);
        if (isNil(stack)) {
          return [parallel4, sequential4];
        }
        current = stack.head;
        stack = stack.tail;
        break;
      }
    }
  }
  throw new Error("BUG: BlockedRequests.step - please report an issue at https://github.com/Effect-TS/effect/issues");
};
var merge4 = (sequential4, parallel4) => {
  if (isNil(sequential4)) {
    return of3(parallelCollectionToSequentialCollection(parallel4));
  }
  if (parallelCollectionIsEmpty(parallel4)) {
    return sequential4;
  }
  const seqHeadKeys = sequentialCollectionKeys(sequential4.head);
  const parKeys = parallelCollectionKeys(parallel4);
  if (seqHeadKeys.length === 1 && parKeys.length === 1 && equals(seqHeadKeys[0], parKeys[0])) {
    return cons(sequentialCollectionCombine(sequential4.head, parallelCollectionToSequentialCollection(parallel4)), sequential4.tail);
  }
  return cons(parallelCollectionToSequentialCollection(parallel4), sequential4);
};
var EntryTypeId = /* @__PURE__ */ Symbol.for("effect/RequestBlock/Entry");
var EntryImpl = class {
  request;
  result;
  listeners;
  ownerId;
  state;
  [EntryTypeId] = blockedRequestVariance;
  constructor(request, result, listeners, ownerId, state) {
    this.request = request;
    this.result = result;
    this.listeners = listeners;
    this.ownerId = ownerId;
    this.state = state;
  }
};
var blockedRequestVariance = {
  /* c8 ignore next */
  _R: (_) => _
};
var RequestBlockParallelTypeId = /* @__PURE__ */ Symbol.for("effect/RequestBlock/RequestBlockParallel");
var parallelVariance = {
  /* c8 ignore next */
  _R: (_) => _
};
var ParallelImpl = class {
  map;
  [RequestBlockParallelTypeId] = parallelVariance;
  constructor(map12) {
    this.map = map12;
  }
};
var parallelCollectionEmpty = () => new ParallelImpl(empty9());
var parallelCollectionAdd = (self, blockedRequest) => new ParallelImpl(modifyAt2(self.map, blockedRequest.dataSource, (_) => orElseSome(map(_, append2(blockedRequest.blockedRequest)), () => of2(blockedRequest.blockedRequest))));
var parallelCollectionCombine = (self, that) => new ParallelImpl(reduce6(self.map, that.map, (map12, value, key) => set3(map12, key, match2(get7(map12, key), {
  onNone: () => value,
  onSome: (other) => appendAll2(value, other)
}))));
var parallelCollectionIsEmpty = (self) => isEmpty4(self.map);
var parallelCollectionKeys = (self) => Array.from(keys2(self.map));
var parallelCollectionToSequentialCollection = (self) => sequentialCollectionMake(map6(self.map, (x) => of2(x)));
var SequentialCollectionTypeId = /* @__PURE__ */ Symbol.for("effect/RequestBlock/RequestBlockSequential");
var sequentialVariance = {
  /* c8 ignore next */
  _R: (_) => _
};
var SequentialImpl = class {
  map;
  [SequentialCollectionTypeId] = sequentialVariance;
  constructor(map12) {
    this.map = map12;
  }
};
var sequentialCollectionMake = (map12) => new SequentialImpl(map12);
var sequentialCollectionCombine = (self, that) => new SequentialImpl(reduce6(that.map, self.map, (map12, value, key) => set3(map12, key, match2(get7(map12, key), {
  onNone: () => empty2(),
  onSome: (a) => appendAll2(a, value)
}))));
var sequentialCollectionKeys = (self) => Array.from(keys2(self.map));
var sequentialCollectionToChunk = (self) => Array.from(self.map);

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/opCodes/deferred.js
var OP_STATE_PENDING = "Pending";
var OP_STATE_DONE = "Done";

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/deferred.js
var DeferredSymbolKey = "effect/Deferred";
var DeferredTypeId = /* @__PURE__ */ Symbol.for(DeferredSymbolKey);
var deferredVariance = {
  /* c8 ignore next */
  _E: (_) => _,
  /* c8 ignore next */
  _A: (_) => _
};
var pending = (joiners) => {
  return {
    _tag: OP_STATE_PENDING,
    joiners
  };
};
var done = (effect) => {
  return {
    _tag: OP_STATE_DONE,
    effect
  };
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/singleShotGen.js
var SingleShotGen2 = class _SingleShotGen {
  self;
  called = false;
  constructor(self) {
    this.self = self;
  }
  next(a) {
    return this.called ? {
      value: a,
      done: true
    } : (this.called = true, {
      value: this.self,
      done: false
    });
  }
  return(a) {
    return {
      value: a,
      done: true
    };
  }
  throw(e) {
    throw e;
  }
  [Symbol.iterator]() {
    return new _SingleShotGen(this.self);
  }
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/core.js
var blocked = (blockedRequests, _continue) => {
  const effect = new EffectPrimitive("Blocked");
  effect.effect_instruction_i0 = blockedRequests;
  effect.effect_instruction_i1 = _continue;
  return effect;
};
var runRequestBlock = (blockedRequests) => {
  const effect = new EffectPrimitive("RunBlocked");
  effect.effect_instruction_i0 = blockedRequests;
  return effect;
};
var EffectTypeId2 = /* @__PURE__ */ Symbol.for("effect/Effect");
var RevertFlags = class {
  patch;
  op;
  _op = OP_REVERT_FLAGS;
  constructor(patch9, op) {
    this.patch = patch9;
    this.op = op;
  }
};
var EffectPrimitive = class {
  _op;
  effect_instruction_i0 = void 0;
  effect_instruction_i1 = void 0;
  effect_instruction_i2 = void 0;
  trace = void 0;
  [EffectTypeId2] = effectVariance;
  constructor(_op) {
    this._op = _op;
  }
  [symbol2](that) {
    return this === that;
  }
  [symbol]() {
    return cached(this, random(this));
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
  toJSON() {
    return {
      _id: "Effect",
      _op: this._op,
      effect_instruction_i0: toJSON(this.effect_instruction_i0),
      effect_instruction_i1: toJSON(this.effect_instruction_i1),
      effect_instruction_i2: toJSON(this.effect_instruction_i2)
    };
  }
  toString() {
    return format(this.toJSON());
  }
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
  [Symbol.iterator]() {
    return new SingleShotGen2(new YieldWrap(this));
  }
};
var EffectPrimitiveFailure = class {
  _op;
  effect_instruction_i0 = void 0;
  effect_instruction_i1 = void 0;
  effect_instruction_i2 = void 0;
  trace = void 0;
  [EffectTypeId2] = effectVariance;
  constructor(_op) {
    this._op = _op;
    this._tag = _op;
  }
  [symbol2](that) {
    return exitIsExit(that) && that._op === "Failure" && // @ts-expect-error
    equals(this.effect_instruction_i0, that.effect_instruction_i0);
  }
  [symbol]() {
    return pipe(
      // @ts-expect-error
      string(this._tag),
      // @ts-expect-error
      combine(hash(this.effect_instruction_i0)),
      cached(this)
    );
  }
  get cause() {
    return this.effect_instruction_i0;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
  toJSON() {
    return {
      _id: "Exit",
      _tag: this._op,
      cause: this.cause.toJSON()
    };
  }
  toString() {
    return format(this.toJSON());
  }
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
  [Symbol.iterator]() {
    return new SingleShotGen2(new YieldWrap(this));
  }
};
var EffectPrimitiveSuccess = class {
  _op;
  effect_instruction_i0 = void 0;
  effect_instruction_i1 = void 0;
  effect_instruction_i2 = void 0;
  trace = void 0;
  [EffectTypeId2] = effectVariance;
  constructor(_op) {
    this._op = _op;
    this._tag = _op;
  }
  [symbol2](that) {
    return exitIsExit(that) && that._op === "Success" && // @ts-expect-error
    equals(this.effect_instruction_i0, that.effect_instruction_i0);
  }
  [symbol]() {
    return pipe(
      // @ts-expect-error
      string(this._tag),
      // @ts-expect-error
      combine(hash(this.effect_instruction_i0)),
      cached(this)
    );
  }
  get value() {
    return this.effect_instruction_i0;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
  toJSON() {
    return {
      _id: "Exit",
      _tag: this._op,
      value: toJSON(this.value)
    };
  }
  toString() {
    return format(this.toJSON());
  }
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
  [Symbol.iterator]() {
    return new SingleShotGen2(new YieldWrap(this));
  }
};
var isEffect = (u) => hasProperty(u, EffectTypeId2);
var withFiberRuntime = (withRuntime) => {
  const effect = new EffectPrimitive(OP_WITH_RUNTIME);
  effect.effect_instruction_i0 = withRuntime;
  return effect;
};
var acquireUseRelease = /* @__PURE__ */ dual(3, (acquire, use, release) => uninterruptibleMask((restore) => flatMap6(acquire, (a) => flatMap6(exit(suspend(() => restore(use(a)))), (exit4) => {
  return suspend(() => release(a, exit4)).pipe(matchCauseEffect({
    onFailure: (cause2) => {
      switch (exit4._tag) {
        case OP_FAILURE:
          return failCause(sequential(exit4.effect_instruction_i0, cause2));
        case OP_SUCCESS:
          return failCause(cause2);
      }
    },
    onSuccess: () => exit4
  }));
}))));
var as = /* @__PURE__ */ dual(2, (self, value) => flatMap6(self, () => succeed(value)));
var asVoid = (self) => as(self, void 0);
var custom = function() {
  const wrapper = new EffectPrimitive(OP_COMMIT);
  switch (arguments.length) {
    case 2: {
      wrapper.effect_instruction_i0 = arguments[0];
      wrapper.commit = arguments[1];
      break;
    }
    case 3: {
      wrapper.effect_instruction_i0 = arguments[0];
      wrapper.effect_instruction_i1 = arguments[1];
      wrapper.commit = arguments[2];
      break;
    }
    case 4: {
      wrapper.effect_instruction_i0 = arguments[0];
      wrapper.effect_instruction_i1 = arguments[1];
      wrapper.effect_instruction_i2 = arguments[2];
      wrapper.commit = arguments[3];
      break;
    }
    default: {
      throw new Error(getBugErrorMessage("you're not supposed to end up here"));
    }
  }
  return wrapper;
};
var unsafeAsync = (register, blockingOn = none4) => {
  const effect = new EffectPrimitive(OP_ASYNC);
  let cancelerRef = void 0;
  effect.effect_instruction_i0 = (resume2) => {
    cancelerRef = register(resume2);
  };
  effect.effect_instruction_i1 = blockingOn;
  return onInterrupt(effect, (_) => isEffect(cancelerRef) ? cancelerRef : void_);
};
var asyncInterrupt = (register, blockingOn = none4) => suspend(() => unsafeAsync(register, blockingOn));
var async_ = (resume2, blockingOn = none4) => {
  return custom(resume2, function() {
    let backingResume = void 0;
    let pendingEffect = void 0;
    function proxyResume(effect2) {
      if (backingResume) {
        backingResume(effect2);
      } else if (pendingEffect === void 0) {
        pendingEffect = effect2;
      }
    }
    const effect = new EffectPrimitive(OP_ASYNC);
    effect.effect_instruction_i0 = (resume3) => {
      backingResume = resume3;
      if (pendingEffect) {
        resume3(pendingEffect);
      }
    };
    effect.effect_instruction_i1 = blockingOn;
    let cancelerRef = void 0;
    let controllerRef = void 0;
    if (this.effect_instruction_i0.length !== 1) {
      controllerRef = new AbortController();
      cancelerRef = internalCall(() => this.effect_instruction_i0(proxyResume, controllerRef.signal));
    } else {
      cancelerRef = internalCall(() => this.effect_instruction_i0(proxyResume));
    }
    return cancelerRef || controllerRef ? onInterrupt(effect, (_) => {
      if (controllerRef) {
        controllerRef.abort();
      }
      return cancelerRef ?? void_;
    }) : effect;
  });
};
var catchAllCause = /* @__PURE__ */ dual(2, (self, f) => {
  const effect = new EffectPrimitive(OP_ON_FAILURE);
  effect.effect_instruction_i0 = self;
  effect.effect_instruction_i1 = f;
  return effect;
});
var catchAll = /* @__PURE__ */ dual(2, (self, f) => matchEffect(self, {
  onFailure: f,
  onSuccess: succeed
}));
var originalSymbol = /* @__PURE__ */ Symbol.for("effect/OriginalAnnotation");
var capture = (obj, span2) => {
  if (isSome2(span2)) {
    return new Proxy(obj, {
      has(target, p) {
        return p === spanSymbol || p === originalSymbol || p in target;
      },
      get(target, p) {
        if (p === spanSymbol) {
          return span2.value;
        }
        if (p === originalSymbol) {
          return obj;
        }
        return target[p];
      }
    });
  }
  return obj;
};
var die2 = (defect) => isObject(defect) && !(spanSymbol in defect) ? withFiberRuntime((fiber) => failCause(die(capture(defect, currentSpanFromFiber(fiber))))) : failCause(die(defect));
var dieMessage = (message) => failCauseSync(() => die(new RuntimeException(message)));
var dieSync = (evaluate2) => flatMap6(sync(evaluate2), die2);
var either2 = (self) => matchEffect(self, {
  onFailure: (e) => succeed(left2(e)),
  onSuccess: (a) => succeed(right2(a))
});
var exit = (self) => matchCause(self, {
  onFailure: exitFailCause,
  onSuccess: exitSucceed
});
var fail2 = (error) => isObject(error) && !(spanSymbol in error) ? withFiberRuntime((fiber) => failCause(fail(capture(error, currentSpanFromFiber(fiber))))) : failCause(fail(error));
var failSync = (evaluate2) => flatMap6(sync(evaluate2), fail2);
var failCause = (cause2) => {
  const effect = new EffectPrimitiveFailure(OP_FAILURE);
  effect.effect_instruction_i0 = cause2;
  return effect;
};
var failCauseSync = (evaluate2) => flatMap6(sync(evaluate2), failCause);
var fiberId = /* @__PURE__ */ withFiberRuntime((state) => succeed(state.id()));
var fiberIdWith = (f) => withFiberRuntime((state) => f(state.id()));
var flatMap6 = /* @__PURE__ */ dual(2, (self, f) => {
  const effect = new EffectPrimitive(OP_ON_SUCCESS);
  effect.effect_instruction_i0 = self;
  effect.effect_instruction_i1 = f;
  return effect;
});
var andThen2 = /* @__PURE__ */ dual(2, (self, f) => flatMap6(self, (a) => {
  const b = typeof f === "function" ? f(a) : f;
  if (isEffect(b)) {
    return b;
  } else if (isPromiseLike(b)) {
    return unsafeAsync((resume2) => {
      b.then((a2) => resume2(succeed(a2)), (e) => resume2(fail2(new UnknownException(e, "An unknown error occurred in Effect.andThen"))));
    });
  }
  return succeed(b);
}));
var step2 = (self) => {
  const effect = new EffectPrimitive("OnStep");
  effect.effect_instruction_i0 = self;
  return effect;
};
var flatten3 = (self) => flatMap6(self, identity);
var matchCause = /* @__PURE__ */ dual(2, (self, options) => matchCauseEffect(self, {
  onFailure: (cause2) => succeed(options.onFailure(cause2)),
  onSuccess: (a) => succeed(options.onSuccess(a))
}));
var matchCauseEffect = /* @__PURE__ */ dual(2, (self, options) => {
  const effect = new EffectPrimitive(OP_ON_SUCCESS_AND_FAILURE);
  effect.effect_instruction_i0 = self;
  effect.effect_instruction_i1 = options.onFailure;
  effect.effect_instruction_i2 = options.onSuccess;
  return effect;
});
var matchEffect = /* @__PURE__ */ dual(2, (self, options) => matchCauseEffect(self, {
  onFailure: (cause2) => {
    const defects2 = defects(cause2);
    if (defects2.length > 0) {
      return failCause(electFailures(cause2));
    }
    const failures2 = failures(cause2);
    if (failures2.length > 0) {
      return options.onFailure(unsafeHead(failures2));
    }
    return failCause(cause2);
  },
  onSuccess: options.onSuccess
}));
var forEachSequential = /* @__PURE__ */ dual(2, (self, f) => suspend(() => {
  const arr = fromIterable(self);
  const ret = allocate(arr.length);
  let i = 0;
  return as(whileLoop({
    while: () => i < arr.length,
    body: () => f(arr[i], i),
    step: (b) => {
      ret[i++] = b;
    }
  }), ret);
}));
var forEachSequentialDiscard = /* @__PURE__ */ dual(2, (self, f) => suspend(() => {
  const arr = fromIterable(self);
  let i = 0;
  return whileLoop({
    while: () => i < arr.length,
    body: () => f(arr[i], i),
    step: () => {
      i++;
    }
  });
}));
var interrupt2 = /* @__PURE__ */ flatMap6(fiberId, (fiberId2) => interruptWith(fiberId2));
var interruptWith = (fiberId2) => failCause(interrupt(fiberId2));
var interruptible2 = (self) => {
  const effect = new EffectPrimitive(OP_UPDATE_RUNTIME_FLAGS);
  effect.effect_instruction_i0 = enable3(Interruption);
  effect.effect_instruction_i1 = () => self;
  return effect;
};
var intoDeferred = /* @__PURE__ */ dual(2, (self, deferred) => uninterruptibleMask((restore) => flatMap6(exit(restore(self)), (exit4) => deferredDone(deferred, exit4))));
var map8 = /* @__PURE__ */ dual(2, (self, f) => flatMap6(self, (a) => sync(() => f(a))));
var mapBoth = /* @__PURE__ */ dual(2, (self, options) => matchEffect(self, {
  onFailure: (e) => failSync(() => options.onFailure(e)),
  onSuccess: (a) => sync(() => options.onSuccess(a))
}));
var mapError = /* @__PURE__ */ dual(2, (self, f) => matchCauseEffect(self, {
  onFailure: (cause2) => {
    const either4 = failureOrCause(cause2);
    switch (either4._tag) {
      case "Left": {
        return failSync(() => f(either4.left));
      }
      case "Right": {
        return failCause(either4.right);
      }
    }
  },
  onSuccess: succeed
}));
var onError = /* @__PURE__ */ dual(2, (self, cleanup) => onExit(self, (exit4) => exitIsSuccess(exit4) ? void_ : cleanup(exit4.effect_instruction_i0)));
var onExit = /* @__PURE__ */ dual(2, (self, cleanup) => uninterruptibleMask((restore) => matchCauseEffect(restore(self), {
  onFailure: (cause1) => {
    const result = exitFailCause(cause1);
    return matchCauseEffect(cleanup(result), {
      onFailure: (cause2) => exitFailCause(sequential(cause1, cause2)),
      onSuccess: () => result
    });
  },
  onSuccess: (success) => {
    const result = exitSucceed(success);
    return zipRight(cleanup(result), result);
  }
})));
var onInterrupt = /* @__PURE__ */ dual(2, (self, cleanup) => onExit(self, exitMatch({
  onFailure: (cause2) => isInterruptedOnly(cause2) ? asVoid(cleanup(interruptors(cause2))) : void_,
  onSuccess: () => void_
})));
var runtimeFlags = /* @__PURE__ */ withFiberRuntime((_, status2) => succeed(status2.runtimeFlags));
var succeed = (value) => {
  const effect = new EffectPrimitiveSuccess(OP_SUCCESS);
  effect.effect_instruction_i0 = value;
  return effect;
};
var suspend = (evaluate2) => {
  const effect = new EffectPrimitive(OP_COMMIT);
  effect.commit = evaluate2;
  return effect;
};
var sync = (thunk) => {
  const effect = new EffectPrimitive(OP_SYNC);
  effect.effect_instruction_i0 = thunk;
  return effect;
};
var tap = /* @__PURE__ */ dual((args2) => args2.length === 3 || args2.length === 2 && !(isObject(args2[1]) && "onlyEffect" in args2[1]), (self, f) => flatMap6(self, (a) => {
  const b = typeof f === "function" ? f(a) : f;
  if (isEffect(b)) {
    return as(b, a);
  } else if (isPromiseLike(b)) {
    return unsafeAsync((resume2) => {
      b.then((_) => resume2(succeed(a)), (e) => resume2(fail2(new UnknownException(e, "An unknown error occurred in Effect.tap"))));
    });
  }
  return succeed(a);
}));
var transplant = (f) => withFiberRuntime((state) => {
  const scopeOverride = state.getFiberRef(currentForkScopeOverride);
  const scope2 = pipe(scopeOverride, getOrElse(() => state.scope()));
  return f(fiberRefLocally(currentForkScopeOverride, some2(scope2)));
});
var uninterruptible = (self) => {
  const effect = new EffectPrimitive(OP_UPDATE_RUNTIME_FLAGS);
  effect.effect_instruction_i0 = disable3(Interruption);
  effect.effect_instruction_i1 = () => self;
  return effect;
};
var uninterruptibleMask = (f) => custom(f, function() {
  const effect = new EffectPrimitive(OP_UPDATE_RUNTIME_FLAGS);
  effect.effect_instruction_i0 = disable3(Interruption);
  effect.effect_instruction_i1 = (oldFlags) => interruption(oldFlags) ? internalCall(() => this.effect_instruction_i0(interruptible2)) : internalCall(() => this.effect_instruction_i0(uninterruptible));
  return effect;
});
var void_ = /* @__PURE__ */ succeed(void 0);
var updateRuntimeFlags = (patch9) => {
  const effect = new EffectPrimitive(OP_UPDATE_RUNTIME_FLAGS);
  effect.effect_instruction_i0 = patch9;
  effect.effect_instruction_i1 = void 0;
  return effect;
};
var whenEffect = /* @__PURE__ */ dual(2, (self, condition) => flatMap6(condition, (b) => {
  if (b) {
    return pipe(self, map8(some2));
  }
  return succeed(none2());
}));
var whileLoop = (options) => {
  const effect = new EffectPrimitive(OP_WHILE);
  effect.effect_instruction_i0 = options.while;
  effect.effect_instruction_i1 = options.body;
  effect.effect_instruction_i2 = options.step;
  return effect;
};
var fromIterator = (iterator) => suspend(() => {
  const effect = new EffectPrimitive(OP_ITERATOR);
  effect.effect_instruction_i0 = iterator();
  return effect;
});
var gen = function() {
  const f = arguments.length === 1 ? arguments[0] : arguments[1].bind(arguments[0]);
  return fromIterator(() => f(pipe));
};
var fnUntraced = (body, ...pipeables) => Object.defineProperty(pipeables.length === 0 ? function(...args2) {
  return fromIterator(() => body.apply(this, args2));
} : function(...args2) {
  let effect = fromIterator(() => body.apply(this, args2));
  for (const x of pipeables) {
    effect = x(effect, ...args2);
  }
  return effect;
}, "length", {
  value: body.length,
  configurable: true
});
var withRuntimeFlags = /* @__PURE__ */ dual(2, (self, update4) => {
  const effect = new EffectPrimitive(OP_UPDATE_RUNTIME_FLAGS);
  effect.effect_instruction_i0 = update4;
  effect.effect_instruction_i1 = () => self;
  return effect;
});
var yieldNow = (options) => {
  const effect = new EffectPrimitive(OP_YIELD);
  return typeof options?.priority !== "undefined" ? withSchedulingPriority(effect, options.priority) : effect;
};
var zip2 = /* @__PURE__ */ dual(2, (self, that) => flatMap6(self, (a) => map8(that, (b) => [a, b])));
var zipLeft = /* @__PURE__ */ dual(2, (self, that) => flatMap6(self, (a) => as(that, a)));
var zipRight = /* @__PURE__ */ dual(2, (self, that) => flatMap6(self, () => that));
var never = /* @__PURE__ */ asyncInterrupt(() => {
  const interval = setInterval(() => {
  }, 2 ** 31 - 1);
  return sync(() => clearInterval(interval));
});
var interruptFiber = (self) => flatMap6(fiberId, (fiberId2) => pipe(self, interruptAsFiber(fiberId2)));
var interruptAsFiber = /* @__PURE__ */ dual(2, (self, fiberId2) => flatMap6(self.interruptAsFork(fiberId2), () => self.await));
var logLevelAll = {
  _tag: "All",
  syslog: 0,
  label: "ALL",
  ordinal: Number.MIN_SAFE_INTEGER,
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var logLevelFatal = {
  _tag: "Fatal",
  syslog: 2,
  label: "FATAL",
  ordinal: 5e4,
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var logLevelError = {
  _tag: "Error",
  syslog: 3,
  label: "ERROR",
  ordinal: 4e4,
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var logLevelWarning = {
  _tag: "Warning",
  syslog: 4,
  label: "WARN",
  ordinal: 3e4,
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var logLevelInfo = {
  _tag: "Info",
  syslog: 6,
  label: "INFO",
  ordinal: 2e4,
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var logLevelDebug = {
  _tag: "Debug",
  syslog: 7,
  label: "DEBUG",
  ordinal: 1e4,
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var logLevelTrace = {
  _tag: "Trace",
  syslog: 7,
  label: "TRACE",
  ordinal: 0,
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var logLevelNone = {
  _tag: "None",
  syslog: 7,
  label: "OFF",
  ordinal: Number.MAX_SAFE_INTEGER,
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var FiberRefSymbolKey = "effect/FiberRef";
var FiberRefTypeId = /* @__PURE__ */ Symbol.for(FiberRefSymbolKey);
var fiberRefVariance = {
  /* c8 ignore next */
  _A: (_) => _
};
var fiberRefGet = (self) => withFiberRuntime((fiber) => exitSucceed(fiber.getFiberRef(self)));
var fiberRefGetWith = /* @__PURE__ */ dual(2, (self, f) => flatMap6(fiberRefGet(self), f));
var fiberRefSet = /* @__PURE__ */ dual(2, (self, value) => fiberRefModify(self, () => [void 0, value]));
var fiberRefModify = /* @__PURE__ */ dual(2, (self, f) => withFiberRuntime((state) => {
  const [b, a] = f(state.getFiberRef(self));
  state.setFiberRef(self, a);
  return succeed(b);
}));
var RequestResolverSymbolKey = "effect/RequestResolver";
var RequestResolverTypeId = /* @__PURE__ */ Symbol.for(RequestResolverSymbolKey);
var requestResolverVariance = {
  /* c8 ignore next */
  _A: (_) => _,
  /* c8 ignore next */
  _R: (_) => _
};
var RequestResolverImpl = class _RequestResolverImpl {
  runAll;
  target;
  [RequestResolverTypeId] = requestResolverVariance;
  constructor(runAll, target) {
    this.runAll = runAll;
    this.target = target;
  }
  [symbol]() {
    return cached(this, this.target ? hash(this.target) : random(this));
  }
  [symbol2](that) {
    return this.target ? isRequestResolver(that) && equals(this.target, that.target) : this === that;
  }
  identified(...ids3) {
    return new _RequestResolverImpl(this.runAll, fromIterable2(ids3));
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var isRequestResolver = (u) => hasProperty(u, RequestResolverTypeId);
var fiberRefLocally = /* @__PURE__ */ dual(3, (use, self, value) => acquireUseRelease(zipLeft(fiberRefGet(self), fiberRefSet(self, value)), () => use, (oldValue) => fiberRefSet(self, oldValue)));
var fiberRefUnsafeMake = (initial, options) => fiberRefUnsafeMakePatch(initial, {
  differ: update(),
  fork: options?.fork ?? identity,
  join: options?.join
});
var fiberRefUnsafeMakeHashSet = (initial) => {
  const differ3 = hashSet();
  return fiberRefUnsafeMakePatch(initial, {
    differ: differ3,
    fork: differ3.empty
  });
};
var fiberRefUnsafeMakeReadonlyArray = (initial) => {
  const differ3 = readonlyArray(update());
  return fiberRefUnsafeMakePatch(initial, {
    differ: differ3,
    fork: differ3.empty
  });
};
var fiberRefUnsafeMakeContext = (initial) => {
  const differ3 = environment();
  return fiberRefUnsafeMakePatch(initial, {
    differ: differ3,
    fork: differ3.empty
  });
};
var fiberRefUnsafeMakePatch = (initial, options) => {
  const _fiberRef = {
    ...CommitPrototype,
    [FiberRefTypeId]: fiberRefVariance,
    initial,
    commit() {
      return fiberRefGet(this);
    },
    diff: (oldValue, newValue) => options.differ.diff(oldValue, newValue),
    combine: (first2, second) => options.differ.combine(first2, second),
    patch: (patch9) => (oldValue) => options.differ.patch(patch9, oldValue),
    fork: options.fork,
    join: options.join ?? ((_, n) => n)
  };
  return _fiberRef;
};
var fiberRefUnsafeMakeRuntimeFlags = (initial) => fiberRefUnsafeMakePatch(initial, {
  differ,
  fork: differ.empty
});
var currentContext = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentContext"), () => fiberRefUnsafeMakeContext(empty8()));
var currentSchedulingPriority = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentSchedulingPriority"), () => fiberRefUnsafeMake(0));
var currentMaxOpsBeforeYield = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentMaxOpsBeforeYield"), () => fiberRefUnsafeMake(2048));
var currentLogAnnotations = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentLogAnnotation"), () => fiberRefUnsafeMake(empty9()));
var currentLogLevel = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentLogLevel"), () => fiberRefUnsafeMake(logLevelInfo));
var currentLogSpan = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentLogSpan"), () => fiberRefUnsafeMake(empty10()));
var withSchedulingPriority = /* @__PURE__ */ dual(2, (self, scheduler) => fiberRefLocally(self, currentSchedulingPriority, scheduler));
var currentConcurrency = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentConcurrency"), () => fiberRefUnsafeMake("unbounded"));
var currentRequestBatching = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentRequestBatching"), () => fiberRefUnsafeMake(true));
var currentUnhandledErrorLogLevel = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentUnhandledErrorLogLevel"), () => fiberRefUnsafeMake(some2(logLevelDebug)));
var currentVersionMismatchErrorLogLevel = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/versionMismatchErrorLogLevel"), () => fiberRefUnsafeMake(some2(logLevelWarning)));
var currentMetricLabels = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentMetricLabels"), () => fiberRefUnsafeMakeReadonlyArray(empty()));
var currentForkScopeOverride = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentForkScopeOverride"), () => fiberRefUnsafeMake(none2(), {
  fork: () => none2(),
  join: (parent, _) => parent
}));
var currentInterruptedCause = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentInterruptedCause"), () => fiberRefUnsafeMake(empty6, {
  fork: () => empty6,
  join: (parent, _) => parent
}));
var ScopeTypeId = /* @__PURE__ */ Symbol.for("effect/Scope");
var CloseableScopeTypeId = /* @__PURE__ */ Symbol.for("effect/CloseableScope");
var scopeAddFinalizer = (self, finalizer) => self.addFinalizer(() => asVoid(finalizer));
var scopeAddFinalizerExit = (self, finalizer) => self.addFinalizer(finalizer);
var scopeClose = (self, exit4) => self.close(exit4);
var scopeFork = (self, strategy) => self.fork(strategy);
var YieldableError = /* @__PURE__ */ (function() {
  class YieldableError2 extends globalThis.Error {
    commit() {
      return fail2(this);
    }
    toJSON() {
      const obj = {
        ...this
      };
      if (this.message) obj.message = this.message;
      if (this.cause) obj.cause = this.cause;
      return obj;
    }
    [NodeInspectSymbol]() {
      if (this.toString !== globalThis.Error.prototype.toString) {
        return this.stack ? `${this.toString()}
${this.stack.split("\n").slice(1).join("\n")}` : this.toString();
      } else if ("Bun" in globalThis) {
        return pretty(fail(this), {
          renderErrorCause: true
        });
      }
      return this;
    }
  }
  Object.assign(YieldableError2.prototype, StructuralCommitPrototype);
  return YieldableError2;
})();
var makeException = (proto3, tag) => {
  class Base3 extends YieldableError {
    _tag = tag;
  }
  Object.assign(Base3.prototype, proto3);
  Base3.prototype.name = tag;
  return Base3;
};
var RuntimeExceptionTypeId = /* @__PURE__ */ Symbol.for("effect/Cause/errors/RuntimeException");
var RuntimeException = /* @__PURE__ */ makeException({
  [RuntimeExceptionTypeId]: RuntimeExceptionTypeId
}, "RuntimeException");
var InterruptedExceptionTypeId = /* @__PURE__ */ Symbol.for("effect/Cause/errors/InterruptedException");
var InterruptedException = /* @__PURE__ */ makeException({
  [InterruptedExceptionTypeId]: InterruptedExceptionTypeId
}, "InterruptedException");
var isInterruptedException = (u) => hasProperty(u, InterruptedExceptionTypeId);
var IllegalArgumentExceptionTypeId = /* @__PURE__ */ Symbol.for("effect/Cause/errors/IllegalArgument");
var IllegalArgumentException = /* @__PURE__ */ makeException({
  [IllegalArgumentExceptionTypeId]: IllegalArgumentExceptionTypeId
}, "IllegalArgumentException");
var NoSuchElementExceptionTypeId = /* @__PURE__ */ Symbol.for("effect/Cause/errors/NoSuchElement");
var NoSuchElementException = /* @__PURE__ */ makeException({
  [NoSuchElementExceptionTypeId]: NoSuchElementExceptionTypeId
}, "NoSuchElementException");
var InvalidPubSubCapacityExceptionTypeId = /* @__PURE__ */ Symbol.for("effect/Cause/errors/InvalidPubSubCapacityException");
var InvalidPubSubCapacityException = /* @__PURE__ */ makeException({
  [InvalidPubSubCapacityExceptionTypeId]: InvalidPubSubCapacityExceptionTypeId
}, "InvalidPubSubCapacityException");
var ExceededCapacityExceptionTypeId = /* @__PURE__ */ Symbol.for("effect/Cause/errors/ExceededCapacityException");
var ExceededCapacityException = /* @__PURE__ */ makeException({
  [ExceededCapacityExceptionTypeId]: ExceededCapacityExceptionTypeId
}, "ExceededCapacityException");
var TimeoutExceptionTypeId = /* @__PURE__ */ Symbol.for("effect/Cause/errors/Timeout");
var TimeoutException = /* @__PURE__ */ makeException({
  [TimeoutExceptionTypeId]: TimeoutExceptionTypeId
}, "TimeoutException");
var UnknownExceptionTypeId = /* @__PURE__ */ Symbol.for("effect/Cause/errors/UnknownException");
var UnknownException = /* @__PURE__ */ (function() {
  class UnknownException2 extends YieldableError {
    _tag = "UnknownException";
    error;
    constructor(cause2, message) {
      super(message ?? "An unknown error occurred", {
        cause: cause2
      });
      this.error = cause2;
    }
  }
  Object.assign(UnknownException2.prototype, {
    [UnknownExceptionTypeId]: UnknownExceptionTypeId,
    name: "UnknownException"
  });
  return UnknownException2;
})();
var exitIsExit = (u) => isEffect(u) && "_tag" in u && (u._tag === "Success" || u._tag === "Failure");
var exitIsSuccess = (self) => self._tag === "Success";
var exitAs = /* @__PURE__ */ dual(2, (self, value) => {
  switch (self._tag) {
    case OP_FAILURE: {
      return exitFailCause(self.effect_instruction_i0);
    }
    case OP_SUCCESS: {
      return exitSucceed(value);
    }
  }
});
var exitAsVoid = (self) => exitAs(self, void 0);
var exitCollectAll = (exits, options) => exitCollectAllInternal(exits, options?.parallel ? parallel : sequential);
var exitDie = (defect) => exitFailCause(die(defect));
var exitFail = (error) => exitFailCause(fail(error));
var exitFailCause = (cause2) => {
  const effect = new EffectPrimitiveFailure(OP_FAILURE);
  effect.effect_instruction_i0 = cause2;
  return effect;
};
var exitInterrupt = (fiberId2) => exitFailCause(interrupt(fiberId2));
var exitMap = /* @__PURE__ */ dual(2, (self, f) => {
  switch (self._tag) {
    case OP_FAILURE:
      return exitFailCause(self.effect_instruction_i0);
    case OP_SUCCESS:
      return exitSucceed(f(self.effect_instruction_i0));
  }
});
var exitMatch = /* @__PURE__ */ dual(2, (self, {
  onFailure,
  onSuccess
}) => {
  switch (self._tag) {
    case OP_FAILURE:
      return onFailure(self.effect_instruction_i0);
    case OP_SUCCESS:
      return onSuccess(self.effect_instruction_i0);
  }
});
var exitMatchEffect = /* @__PURE__ */ dual(2, (self, {
  onFailure,
  onSuccess
}) => {
  switch (self._tag) {
    case OP_FAILURE:
      return onFailure(self.effect_instruction_i0);
    case OP_SUCCESS:
      return onSuccess(self.effect_instruction_i0);
  }
});
var exitSucceed = (value) => {
  const effect = new EffectPrimitiveSuccess(OP_SUCCESS);
  effect.effect_instruction_i0 = value;
  return effect;
};
var exitVoid = /* @__PURE__ */ exitSucceed(void 0);
var exitZipWith = /* @__PURE__ */ dual(3, (self, that, {
  onFailure,
  onSuccess
}) => {
  switch (self._tag) {
    case OP_FAILURE: {
      switch (that._tag) {
        case OP_SUCCESS:
          return exitFailCause(self.effect_instruction_i0);
        case OP_FAILURE: {
          return exitFailCause(onFailure(self.effect_instruction_i0, that.effect_instruction_i0));
        }
      }
    }
    case OP_SUCCESS: {
      switch (that._tag) {
        case OP_SUCCESS:
          return exitSucceed(onSuccess(self.effect_instruction_i0, that.effect_instruction_i0));
        case OP_FAILURE:
          return exitFailCause(that.effect_instruction_i0);
      }
    }
  }
});
var exitCollectAllInternal = (exits, combineCauses) => {
  const list = fromIterable2(exits);
  if (!isNonEmpty(list)) {
    return none2();
  }
  return pipe(tailNonEmpty2(list), reduce(pipe(headNonEmpty2(list), exitMap(of2)), (accumulator, current) => pipe(accumulator, exitZipWith(current, {
    onSuccess: (list2, value) => pipe(list2, prepend2(value)),
    onFailure: combineCauses
  }))), exitMap(reverse2), exitMap((chunk2) => toReadonlyArray(chunk2)), some2);
};
var deferredUnsafeMake = (fiberId2) => {
  const _deferred = {
    ...CommitPrototype,
    [DeferredTypeId]: deferredVariance,
    state: make11(pending([])),
    commit() {
      return deferredAwait(this);
    },
    blockingOn: fiberId2
  };
  return _deferred;
};
var deferredMake = () => flatMap6(fiberId, (id2) => deferredMakeAs(id2));
var deferredMakeAs = (fiberId2) => sync(() => deferredUnsafeMake(fiberId2));
var deferredAwait = (self) => asyncInterrupt((resume2) => {
  const state = get6(self.state);
  switch (state._tag) {
    case OP_STATE_DONE: {
      return resume2(state.effect);
    }
    case OP_STATE_PENDING: {
      state.joiners.push(resume2);
      return deferredInterruptJoiner(self, resume2);
    }
  }
}, self.blockingOn);
var deferredCompleteWith = /* @__PURE__ */ dual(2, (self, effect) => sync(() => {
  const state = get6(self.state);
  switch (state._tag) {
    case OP_STATE_DONE: {
      return false;
    }
    case OP_STATE_PENDING: {
      set2(self.state, done(effect));
      for (let i = 0, len = state.joiners.length; i < len; i++) {
        state.joiners[i](effect);
      }
      return true;
    }
  }
}));
var deferredDone = /* @__PURE__ */ dual(2, (self, exit4) => deferredCompleteWith(self, exit4));
var deferredFail = /* @__PURE__ */ dual(2, (self, error) => deferredCompleteWith(self, fail2(error)));
var deferredInterruptWith = /* @__PURE__ */ dual(2, (self, fiberId2) => deferredCompleteWith(self, interruptWith(fiberId2)));
var deferredSucceed = /* @__PURE__ */ dual(2, (self, value) => deferredCompleteWith(self, succeed(value)));
var deferredUnsafeDone = (self, effect) => {
  const state = get6(self.state);
  if (state._tag === OP_STATE_PENDING) {
    set2(self.state, done(effect));
    for (let i = 0, len = state.joiners.length; i < len; i++) {
      state.joiners[i](effect);
    }
  }
};
var deferredInterruptJoiner = (self, joiner) => sync(() => {
  const state = get6(self.state);
  if (state._tag === OP_STATE_PENDING) {
    const index = state.joiners.indexOf(joiner);
    if (index >= 0) {
      state.joiners.splice(index, 1);
    }
  }
});
var constContext = /* @__PURE__ */ withFiberRuntime((fiber) => exitSucceed(fiber.currentContext));
var context = () => constContext;
var contextWithEffect = (f) => flatMap6(context(), f);
var provideContext = /* @__PURE__ */ dual(2, (self, context2) => fiberRefLocally(currentContext, context2)(self));
var mapInputContext = /* @__PURE__ */ dual(2, (self, f) => contextWithEffect((context2) => provideContext(self, f(context2))));
var currentSpanFromFiber = (fiber) => {
  const span2 = fiber.currentSpan;
  return span2 !== void 0 && span2._tag === "Span" ? some2(span2) : none2();
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/clock.js
var ClockSymbolKey = "effect/Clock";
var ClockTypeId = /* @__PURE__ */ Symbol.for(ClockSymbolKey);
var clockTag = /* @__PURE__ */ GenericTag("effect/Clock");
var MAX_TIMER_MILLIS = 2 ** 31 - 1;
var globalClockScheduler = {
  unsafeSchedule(task, duration) {
    const millis2 = toMillis(duration);
    if (millis2 > MAX_TIMER_MILLIS) {
      return constFalse;
    }
    let completed = false;
    const handle = setTimeout(() => {
      completed = true;
      task();
    }, millis2);
    return () => {
      clearTimeout(handle);
      return !completed;
    };
  }
};
var performanceNowNanos = /* @__PURE__ */ (function() {
  const bigint1e62 = /* @__PURE__ */ BigInt(1e6);
  if (typeof performance === "undefined" || typeof performance.now !== "function") {
    return () => BigInt(Date.now()) * bigint1e62;
  }
  let origin;
  return () => {
    if (origin === void 0) {
      origin = BigInt(Date.now()) * bigint1e62 - BigInt(Math.round(performance.now() * 1e6));
    }
    return origin + BigInt(Math.round(performance.now() * 1e6));
  };
})();
var processOrPerformanceNow = /* @__PURE__ */ (function() {
  const processHrtime = typeof process === "object" && "hrtime" in process && typeof process.hrtime.bigint === "function" ? process.hrtime : void 0;
  if (!processHrtime) {
    return performanceNowNanos;
  }
  const origin = /* @__PURE__ */ performanceNowNanos() - /* @__PURE__ */ processHrtime.bigint();
  return () => origin + processHrtime.bigint();
})();
var ClockImpl = class {
  [ClockTypeId] = ClockTypeId;
  unsafeCurrentTimeMillis() {
    return Date.now();
  }
  unsafeCurrentTimeNanos() {
    return processOrPerformanceNow();
  }
  currentTimeMillis = /* @__PURE__ */ sync(() => this.unsafeCurrentTimeMillis());
  currentTimeNanos = /* @__PURE__ */ sync(() => this.unsafeCurrentTimeNanos());
  scheduler() {
    return succeed(globalClockScheduler);
  }
  sleep(duration) {
    return async_((resume2) => {
      const canceler = globalClockScheduler.unsafeSchedule(() => resume2(void_), duration);
      return asVoid(sync(canceler));
    });
  }
};
var make18 = () => new ClockImpl();

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Number.js
var Order = number2;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/RegExp.js
var escape = (string2) => string2.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/opCodes/configError.js
var OP_AND = "And";
var OP_OR = "Or";
var OP_INVALID_DATA = "InvalidData";
var OP_MISSING_DATA = "MissingData";
var OP_SOURCE_UNAVAILABLE = "SourceUnavailable";
var OP_UNSUPPORTED = "Unsupported";

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/configError.js
var ConfigErrorSymbolKey = "effect/ConfigError";
var ConfigErrorTypeId = /* @__PURE__ */ Symbol.for(ConfigErrorSymbolKey);
var proto2 = {
  _tag: "ConfigError",
  [ConfigErrorTypeId]: ConfigErrorTypeId
};
var And = (self, that) => {
  const error = Object.create(proto2);
  error._op = OP_AND;
  error.left = self;
  error.right = that;
  Object.defineProperty(error, "toString", {
    enumerable: false,
    value() {
      return `${this.left} and ${this.right}`;
    }
  });
  Object.defineProperty(error, "message", {
    enumerable: false,
    get() {
      return this.toString();
    }
  });
  return error;
};
var Or = (self, that) => {
  const error = Object.create(proto2);
  error._op = OP_OR;
  error.left = self;
  error.right = that;
  Object.defineProperty(error, "toString", {
    enumerable: false,
    value() {
      return `${this.left} or ${this.right}`;
    }
  });
  Object.defineProperty(error, "message", {
    enumerable: false,
    get() {
      return this.toString();
    }
  });
  return error;
};
var InvalidData = (path, message, options = {
  pathDelim: "."
}) => {
  const error = Object.create(proto2);
  error._op = OP_INVALID_DATA;
  error.path = path;
  error.message = message;
  Object.defineProperty(error, "toString", {
    enumerable: false,
    value() {
      const path2 = pipe(this.path, join(options.pathDelim));
      return `(Invalid data at ${path2}: "${this.message}")`;
    }
  });
  return error;
};
var MissingData = (path, message, options = {
  pathDelim: "."
}) => {
  const error = Object.create(proto2);
  error._op = OP_MISSING_DATA;
  error.path = path;
  error.message = message;
  Object.defineProperty(error, "toString", {
    enumerable: false,
    value() {
      const path2 = pipe(this.path, join(options.pathDelim));
      return `(Missing data at ${path2}: "${this.message}")`;
    }
  });
  return error;
};
var SourceUnavailable = (path, message, cause2, options = {
  pathDelim: "."
}) => {
  const error = Object.create(proto2);
  error._op = OP_SOURCE_UNAVAILABLE;
  error.path = path;
  error.message = message;
  error.cause = cause2;
  Object.defineProperty(error, "toString", {
    enumerable: false,
    value() {
      const path2 = pipe(this.path, join(options.pathDelim));
      return `(Source unavailable at ${path2}: "${this.message}")`;
    }
  });
  return error;
};
var Unsupported = (path, message, options = {
  pathDelim: "."
}) => {
  const error = Object.create(proto2);
  error._op = OP_UNSUPPORTED;
  error.path = path;
  error.message = message;
  Object.defineProperty(error, "toString", {
    enumerable: false,
    value() {
      const path2 = pipe(this.path, join(options.pathDelim));
      return `(Unsupported operation at ${path2}: "${this.message}")`;
    }
  });
  return error;
};
var prefixed = /* @__PURE__ */ dual(2, (self, prefix) => {
  switch (self._op) {
    case OP_AND: {
      return And(prefixed(self.left, prefix), prefixed(self.right, prefix));
    }
    case OP_OR: {
      return Or(prefixed(self.left, prefix), prefixed(self.right, prefix));
    }
    case OP_INVALID_DATA: {
      return InvalidData([...prefix, ...self.path], self.message);
    }
    case OP_MISSING_DATA: {
      return MissingData([...prefix, ...self.path], self.message);
    }
    case OP_SOURCE_UNAVAILABLE: {
      return SourceUnavailable([...prefix, ...self.path], self.message, self.cause);
    }
    case OP_UNSUPPORTED: {
      return Unsupported([...prefix, ...self.path], self.message);
    }
  }
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/configProvider/pathPatch.js
var empty15 = {
  _tag: "Empty"
};
var patch5 = /* @__PURE__ */ dual(2, (path, patch9) => {
  let input = of3(patch9);
  let output = path;
  while (isCons(input)) {
    const patch10 = input.head;
    switch (patch10._tag) {
      case "Empty": {
        input = input.tail;
        break;
      }
      case "AndThen": {
        input = cons(patch10.first, cons(patch10.second, input.tail));
        break;
      }
      case "MapName": {
        output = map2(output, patch10.f);
        input = input.tail;
        break;
      }
      case "Nested": {
        output = prepend(output, patch10.name);
        input = input.tail;
        break;
      }
      case "Unnested": {
        const containsName = pipe(head(output), contains(patch10.name));
        if (containsName) {
          output = tailNonEmpty(output);
          input = input.tail;
        } else {
          return left2(MissingData(output, `Expected ${patch10.name} to be in path in ConfigProvider#unnested`));
        }
        break;
      }
    }
  }
  return right2(output);
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/opCodes/config.js
var OP_CONSTANT = "Constant";
var OP_FAIL2 = "Fail";
var OP_FALLBACK = "Fallback";
var OP_DESCRIBED = "Described";
var OP_LAZY = "Lazy";
var OP_MAP_OR_FAIL = "MapOrFail";
var OP_NESTED = "Nested";
var OP_PRIMITIVE = "Primitive";
var OP_SEQUENCE = "Sequence";
var OP_HASHMAP = "HashMap";
var OP_ZIP_WITH = "ZipWith";

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/configProvider.js
var concat = (l, r) => [...l, ...r];
var ConfigProviderSymbolKey = "effect/ConfigProvider";
var ConfigProviderTypeId = /* @__PURE__ */ Symbol.for(ConfigProviderSymbolKey);
var configProviderTag = /* @__PURE__ */ GenericTag("effect/ConfigProvider");
var FlatConfigProviderSymbolKey = "effect/ConfigProviderFlat";
var FlatConfigProviderTypeId = /* @__PURE__ */ Symbol.for(FlatConfigProviderSymbolKey);
var make20 = (options) => ({
  [ConfigProviderTypeId]: ConfigProviderTypeId,
  pipe() {
    return pipeArguments(this, arguments);
  },
  ...options
});
var makeFlat = (options) => ({
  [FlatConfigProviderTypeId]: FlatConfigProviderTypeId,
  patch: options.patch,
  load: (path, config, split = true) => options.load(path, config, split),
  enumerateChildren: options.enumerateChildren
});
var fromFlat = (flat) => make20({
  load: (config) => flatMap6(fromFlatLoop(flat, empty(), config, false), (chunk2) => match2(head(chunk2), {
    onNone: () => fail2(MissingData(empty(), `Expected a single value having structure: ${config}`)),
    onSome: succeed
  })),
  flattened: flat
});
var fromEnv = (options) => {
  const {
    pathDelim,
    seqDelim
  } = Object.assign({}, {
    pathDelim: "_",
    seqDelim: ","
  }, options);
  const makePathString = (path) => pipe(path, join(pathDelim));
  const unmakePathString = (pathString) => pathString.split(pathDelim);
  const getEnv = () => typeof process !== "undefined" && "env" in process && typeof process.env === "object" ? process.env : {};
  const load = (path, primitive, split = true) => {
    const pathString = makePathString(path);
    const current = getEnv();
    const valueOpt = pathString in current ? some2(current[pathString]) : none2();
    return pipe(valueOpt, mapError(() => MissingData(path, `Expected ${pathString} to exist in the process context`)), flatMap6((value) => parsePrimitive(value, path, primitive, seqDelim, split)));
  };
  const enumerateChildren = (path) => sync(() => {
    const current = getEnv();
    const keys5 = Object.keys(current);
    const keyPaths = keys5.map((value) => unmakePathString(value.toUpperCase()));
    const filteredKeyPaths = keyPaths.filter((keyPath) => {
      for (let i = 0; i < path.length; i++) {
        const pathComponent = pipe(path, unsafeGet(i));
        const currentElement = keyPath[i];
        if (currentElement === void 0 || pathComponent !== currentElement) {
          return false;
        }
      }
      return true;
    }).flatMap((keyPath) => keyPath.slice(path.length, path.length + 1));
    return fromIterable5(filteredKeyPaths);
  });
  return fromFlat(makeFlat({
    load,
    enumerateChildren,
    patch: empty15
  }));
};
var extend = (leftDef, rightDef, left3, right3) => {
  const leftPad = unfold(left3.length, (index) => index >= right3.length ? none2() : some2([leftDef(index), index + 1]));
  const rightPad = unfold(right3.length, (index) => index >= left3.length ? none2() : some2([rightDef(index), index + 1]));
  const leftExtension = concat(left3, leftPad);
  const rightExtension = concat(right3, rightPad);
  return [leftExtension, rightExtension];
};
var appendConfigPath = (path, config) => {
  let op = config;
  if (op._tag === "Nested") {
    const out = path.slice();
    while (op._tag === "Nested") {
      out.push(op.name);
      op = op.config;
    }
    return out;
  }
  return path;
};
var fromFlatLoop = (flat, prefix, config, split) => {
  const op = config;
  switch (op._tag) {
    case OP_CONSTANT: {
      return succeed(of(op.value));
    }
    case OP_DESCRIBED: {
      return suspend(() => fromFlatLoop(flat, prefix, op.config, split));
    }
    case OP_FAIL2: {
      return fail2(MissingData(prefix, op.message));
    }
    case OP_FALLBACK: {
      return pipe(suspend(() => fromFlatLoop(flat, prefix, op.first, split)), catchAll((error1) => {
        if (op.condition(error1)) {
          return pipe(fromFlatLoop(flat, prefix, op.second, split), catchAll((error2) => fail2(Or(error1, error2))));
        }
        return fail2(error1);
      }));
    }
    case OP_LAZY: {
      return suspend(() => fromFlatLoop(flat, prefix, op.config(), split));
    }
    case OP_MAP_OR_FAIL: {
      return suspend(() => pipe(fromFlatLoop(flat, prefix, op.original, split), flatMap6(forEachSequential((a) => pipe(op.mapOrFail(a), mapError(prefixed(appendConfigPath(prefix, op.original))))))));
    }
    case OP_NESTED: {
      return suspend(() => fromFlatLoop(flat, concat(prefix, of(op.name)), op.config, split));
    }
    case OP_PRIMITIVE: {
      return pipe(patch5(prefix, flat.patch), flatMap6((prefix2) => pipe(flat.load(prefix2, op, split), flatMap6((values3) => {
        if (values3.length === 0) {
          const name = pipe(last(prefix2), getOrElse(() => "<n/a>"));
          return fail2(MissingData([], `Expected ${op.description} with name ${name}`));
        }
        return succeed(values3);
      }))));
    }
    case OP_SEQUENCE: {
      return pipe(patch5(prefix, flat.patch), flatMap6((patchedPrefix) => pipe(flat.enumerateChildren(patchedPrefix), flatMap6(indicesFrom), flatMap6((indices) => {
        if (indices.length === 0) {
          return suspend(() => map8(fromFlatLoop(flat, prefix, op.config, true), of));
        }
        return pipe(forEachSequential(indices, (index) => fromFlatLoop(flat, append(prefix, `[${index}]`), op.config, true)), map8((chunkChunk) => {
          const flattened = flatten(chunkChunk);
          if (flattened.length === 0) {
            return of(empty());
          }
          return of(flattened);
        }));
      }))));
    }
    case OP_HASHMAP: {
      return suspend(() => pipe(patch5(prefix, flat.patch), flatMap6((prefix2) => pipe(flat.enumerateChildren(prefix2), flatMap6((keys5) => {
        return pipe(keys5, forEachSequential((key) => fromFlatLoop(flat, concat(prefix2, of(key)), op.valueConfig, split)), map8((matrix) => {
          if (matrix.length === 0) {
            return of(empty9());
          }
          return pipe(transpose(matrix), map2((values3) => fromIterable6(zip(fromIterable(keys5), values3))));
        }));
      })))));
    }
    case OP_ZIP_WITH: {
      return suspend(() => pipe(fromFlatLoop(flat, prefix, op.left, split), either2, flatMap6((left3) => pipe(fromFlatLoop(flat, prefix, op.right, split), either2, flatMap6((right3) => {
        if (isLeft2(left3) && isLeft2(right3)) {
          return fail2(And(left3.left, right3.left));
        }
        if (isLeft2(left3) && isRight2(right3)) {
          return fail2(left3.left);
        }
        if (isRight2(left3) && isLeft2(right3)) {
          return fail2(right3.left);
        }
        if (isRight2(left3) && isRight2(right3)) {
          const path = pipe(prefix, join("."));
          const fail7 = fromFlatLoopFail(prefix, path);
          const [lefts, rights] = extend(fail7, fail7, pipe(left3.right, map2(right2)), pipe(right3.right, map2(right2)));
          return pipe(lefts, zip(rights), forEachSequential(([left4, right4]) => pipe(zip2(left4, right4), map8(([left5, right5]) => op.zip(left5, right5)))));
        }
        throw new Error("BUG: ConfigProvider.fromFlatLoop - please report an issue at https://github.com/Effect-TS/effect/issues");
      })))));
    }
  }
};
var fromFlatLoopFail = (prefix, path) => (index) => left2(MissingData(prefix, `The element at index ${index} in a sequence at path "${path}" was missing`));
var splitPathString = (text, delim) => {
  const split = text.split(new RegExp(`\\s*${escape(delim)}\\s*`));
  return split;
};
var parsePrimitive = (text, path, primitive, delimiter, split) => {
  if (!split) {
    return pipe(primitive.parse(text), mapBoth({
      onFailure: prefixed(path),
      onSuccess: of
    }));
  }
  return pipe(splitPathString(text, delimiter), forEachSequential((char) => primitive.parse(char.trim())), mapError(prefixed(path)));
};
var transpose = (array3) => {
  return Object.keys(array3[0]).map((column) => array3.map((row) => row[column]));
};
var indicesFrom = (quotedIndices) => pipe(forEachSequential(quotedIndices, parseQuotedIndex), mapBoth({
  onFailure: () => empty(),
  onSuccess: sort(Order)
}), either2, map8(merge));
var QUOTED_INDEX_REGEX = /^(\[(\d+)\])$/;
var parseQuotedIndex = (str) => {
  const match11 = str.match(QUOTED_INDEX_REGEX);
  if (match11 !== null) {
    const matchedIndex = match11[2];
    return pipe(matchedIndex !== void 0 && matchedIndex.length > 0 ? some2(matchedIndex) : none2(), flatMap(parseInteger));
  }
  return none2();
};
var parseInteger = (str) => {
  const parsedIndex = Number.parseInt(str);
  return Number.isNaN(parsedIndex) ? none2() : some2(parsedIndex);
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/defaultServices/console.js
var TypeId8 = /* @__PURE__ */ Symbol.for("effect/Console");
var consoleTag = /* @__PURE__ */ GenericTag("effect/Console");
var defaultConsole = {
  [TypeId8]: TypeId8,
  assert(condition, ...args2) {
    return sync(() => {
      console.assert(condition, ...args2);
    });
  },
  clear: /* @__PURE__ */ sync(() => {
    console.clear();
  }),
  count(label) {
    return sync(() => {
      console.count(label);
    });
  },
  countReset(label) {
    return sync(() => {
      console.countReset(label);
    });
  },
  debug(...args2) {
    return sync(() => {
      console.debug(...args2);
    });
  },
  dir(item, options) {
    return sync(() => {
      console.dir(item, options);
    });
  },
  dirxml(...args2) {
    return sync(() => {
      console.dirxml(...args2);
    });
  },
  error(...args2) {
    return sync(() => {
      console.error(...args2);
    });
  },
  group(options) {
    return options?.collapsed ? sync(() => console.groupCollapsed(options?.label)) : sync(() => console.group(options?.label));
  },
  groupEnd: /* @__PURE__ */ sync(() => {
    console.groupEnd();
  }),
  info(...args2) {
    return sync(() => {
      console.info(...args2);
    });
  },
  log(...args2) {
    return sync(() => {
      console.log(...args2);
    });
  },
  table(tabularData, properties) {
    return sync(() => {
      console.table(tabularData, properties);
    });
  },
  time(label) {
    return sync(() => console.time(label));
  },
  timeEnd(label) {
    return sync(() => console.timeEnd(label));
  },
  timeLog(label, ...args2) {
    return sync(() => {
      console.timeLog(label, ...args2);
    });
  },
  trace(...args2) {
    return sync(() => {
      console.trace(...args2);
    });
  },
  warn(...args2) {
    return sync(() => {
      console.warn(...args2);
    });
  },
  unsafe: console
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/random.js
var RandomSymbolKey = "effect/Random";
var RandomTypeId = /* @__PURE__ */ Symbol.for(RandomSymbolKey);
var randomTag = /* @__PURE__ */ GenericTag("effect/Random");
var RandomImpl = class {
  seed;
  [RandomTypeId] = RandomTypeId;
  PRNG;
  constructor(seed) {
    this.seed = seed;
    this.PRNG = new PCGRandom(seed);
  }
  get next() {
    return sync(() => this.PRNG.number());
  }
  get nextBoolean() {
    return map8(this.next, (n) => n > 0.5);
  }
  get nextInt() {
    return sync(() => this.PRNG.integer(Number.MAX_SAFE_INTEGER));
  }
  nextRange(min2, max2) {
    return map8(this.next, (n) => (max2 - min2) * n + min2);
  }
  nextIntBetween(min2, max2) {
    return sync(() => this.PRNG.integer(max2 - min2) + min2);
  }
  shuffle(elements) {
    return shuffleWith(elements, (n) => this.nextIntBetween(0, n));
  }
};
var shuffleWith = (elements, nextIntBounded) => {
  return suspend(() => pipe(sync(() => Array.from(elements)), flatMap6((buffer) => {
    const numbers = [];
    for (let i = buffer.length; i >= 2; i = i - 1) {
      numbers.push(i);
    }
    return pipe(numbers, forEachSequentialDiscard((n) => pipe(nextIntBounded(n), map8((k) => swap(buffer, n - 1, k)))), as(fromIterable2(buffer)));
  })));
};
var swap = (buffer, index1, index2) => {
  const tmp = buffer[index1];
  buffer[index1] = buffer[index2];
  buffer[index2] = tmp;
  return buffer;
};
var make21 = (seed) => new RandomImpl(hash(seed));
var FixedRandomImpl = class {
  values;
  [RandomTypeId] = RandomTypeId;
  index = 0;
  constructor(values3) {
    this.values = values3;
    if (values3.length === 0) {
      throw new Error("Requires at least one value");
    }
  }
  getNextValue() {
    const value = this.values[this.index];
    this.index = (this.index + 1) % this.values.length;
    return value;
  }
  get next() {
    return sync(() => {
      const value = this.getNextValue();
      if (typeof value === "number") {
        return Math.max(0, Math.min(1, value));
      }
      return hash(value) / 2147483647;
    });
  }
  get nextBoolean() {
    return sync(() => {
      const value = this.getNextValue();
      if (typeof value === "boolean") {
        return value;
      }
      return hash(value) % 2 === 0;
    });
  }
  get nextInt() {
    return sync(() => {
      const value = this.getNextValue();
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.round(value);
      }
      return Math.abs(hash(value));
    });
  }
  nextRange(min2, max2) {
    return map8(this.next, (n) => (max2 - min2) * n + min2);
  }
  nextIntBetween(min2, max2) {
    return sync(() => {
      const value = this.getNextValue();
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(min2, Math.min(max2 - 1, Math.round(value)));
      }
      const hash2 = Math.abs(hash(value));
      return min2 + hash2 % (max2 - min2);
    });
  }
  shuffle(elements) {
    return shuffleWith(elements, (n) => this.nextIntBetween(0, n));
  }
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/tracer.js
var TracerTypeId = /* @__PURE__ */ Symbol.for("effect/Tracer");
var make22 = (options) => ({
  [TracerTypeId]: TracerTypeId,
  ...options
});
var tracerTag = /* @__PURE__ */ GenericTag("effect/Tracer");
var spanTag = /* @__PURE__ */ GenericTag("effect/ParentSpan");
var randomHexString = /* @__PURE__ */ (function() {
  const characters = "abcdef0123456789";
  const charactersLength = characters.length;
  return function(length3) {
    let result = "";
    for (let i = 0; i < length3; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  };
})();
var NativeSpan = class {
  name;
  parent;
  context;
  startTime;
  kind;
  _tag = "Span";
  spanId;
  traceId = "native";
  sampled = true;
  status;
  attributes;
  events = [];
  links;
  constructor(name, parent, context2, links, startTime, kind) {
    this.name = name;
    this.parent = parent;
    this.context = context2;
    this.startTime = startTime;
    this.kind = kind;
    this.status = {
      _tag: "Started",
      startTime
    };
    this.attributes = /* @__PURE__ */ new Map();
    this.traceId = parent._tag === "Some" ? parent.value.traceId : randomHexString(32);
    this.spanId = randomHexString(16);
    this.links = Array.from(links);
  }
  end(endTime, exit4) {
    this.status = {
      _tag: "Ended",
      endTime,
      exit: exit4,
      startTime: this.status.startTime
    };
  }
  attribute(key, value) {
    this.attributes.set(key, value);
  }
  event(name, startTime, attributes) {
    this.events.push([name, startTime, attributes ?? {}]);
  }
  addLinks(links) {
    this.links.push(...links);
  }
};
var nativeTracer = /* @__PURE__ */ make22({
  span: (name, parent, context2, links, startTime, kind) => new NativeSpan(name, parent, context2, links, startTime, kind),
  context: (f) => f()
});
var DisablePropagation = /* @__PURE__ */ Reference2()("effect/Tracer/DisablePropagation", {
  defaultValue: constFalse
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/defaultServices.js
var liveServices = /* @__PURE__ */ pipe(/* @__PURE__ */ empty8(), /* @__PURE__ */ add4(clockTag, /* @__PURE__ */ make18()), /* @__PURE__ */ add4(consoleTag, defaultConsole), /* @__PURE__ */ add4(randomTag, /* @__PURE__ */ make21(/* @__PURE__ */ Math.random())), /* @__PURE__ */ add4(configProviderTag, /* @__PURE__ */ fromEnv()), /* @__PURE__ */ add4(tracerTag, nativeTracer));
var currentServices = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/DefaultServices/currentServices"), () => fiberRefUnsafeMakeContext(liveServices));
var sleep = (duration) => {
  const decodedDuration = decode(duration);
  return clockWith((clock2) => clock2.sleep(decodedDuration));
};
var defaultServicesWith = (f) => withFiberRuntime((fiber) => f(fiber.currentDefaultServices));
var clockWith = (f) => defaultServicesWith((services) => f(services.unsafeMap.get(clockTag.key)));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Effectable.js
var EffectPrototype2 = EffectPrototype;
var Base2 = Base;
var Class2 = class extends Base2 {
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/executionStrategy.js
var OP_SEQUENTIAL2 = "Sequential";
var OP_PARALLEL2 = "Parallel";
var OP_PARALLEL_N = "ParallelN";
var sequential2 = {
  _tag: OP_SEQUENTIAL2
};
var parallel2 = {
  _tag: OP_PARALLEL2
};
var parallelN = (parallelism) => ({
  _tag: OP_PARALLEL_N,
  parallelism
});
var isSequential = (self) => self._tag === OP_SEQUENTIAL2;
var isParallel = (self) => self._tag === OP_PARALLEL2;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/ExecutionStrategy.js
var sequential3 = sequential2;
var parallel3 = parallel2;
var parallelN2 = parallelN;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/fiberRefs.js
function unsafeMake3(fiberRefLocals) {
  return new FiberRefsImpl(fiberRefLocals);
}
function empty16() {
  return unsafeMake3(/* @__PURE__ */ new Map());
}
var FiberRefsSym = /* @__PURE__ */ Symbol.for("effect/FiberRefs");
var FiberRefsImpl = class {
  locals;
  [FiberRefsSym] = FiberRefsSym;
  constructor(locals) {
    this.locals = locals;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var findAncestor = (_ref, _parentStack, _childStack, _childModified = false) => {
  const ref = _ref;
  let parentStack = _parentStack;
  let childStack = _childStack;
  let childModified = _childModified;
  let ret = void 0;
  while (ret === void 0) {
    if (isNonEmptyReadonlyArray(parentStack) && isNonEmptyReadonlyArray(childStack)) {
      const parentFiberId = headNonEmpty(parentStack)[0];
      const parentAncestors = tailNonEmpty(parentStack);
      const childFiberId = headNonEmpty(childStack)[0];
      const childRefValue = headNonEmpty(childStack)[1];
      const childAncestors = tailNonEmpty(childStack);
      if (parentFiberId.startTimeMillis < childFiberId.startTimeMillis) {
        childStack = childAncestors;
        childModified = true;
      } else if (parentFiberId.startTimeMillis > childFiberId.startTimeMillis) {
        parentStack = parentAncestors;
      } else {
        if (parentFiberId.id < childFiberId.id) {
          childStack = childAncestors;
          childModified = true;
        } else if (parentFiberId.id > childFiberId.id) {
          parentStack = parentAncestors;
        } else {
          ret = [childRefValue, childModified];
        }
      }
    } else {
      ret = [ref.initial, true];
    }
  }
  return ret;
};
var joinAs = /* @__PURE__ */ dual(3, (self, fiberId2, that) => {
  const parentFiberRefs = new Map(self.locals);
  that.locals.forEach((childStack, fiberRef) => {
    const childValue = childStack[0][1];
    if (!childStack[0][0][symbol2](fiberId2)) {
      if (!parentFiberRefs.has(fiberRef)) {
        if (equals(childValue, fiberRef.initial)) {
          return;
        }
        parentFiberRefs.set(fiberRef, [[fiberId2, fiberRef.join(fiberRef.initial, childValue)]]);
        return;
      }
      const parentStack = parentFiberRefs.get(fiberRef);
      const [ancestor, wasModified] = findAncestor(fiberRef, parentStack, childStack);
      if (wasModified) {
        const patch9 = fiberRef.diff(ancestor, childValue);
        const oldValue = parentStack[0][1];
        const newValue = fiberRef.join(oldValue, fiberRef.patch(patch9)(oldValue));
        if (!equals(oldValue, newValue)) {
          let newStack;
          const parentFiberId = parentStack[0][0];
          if (parentFiberId[symbol2](fiberId2)) {
            newStack = [[parentFiberId, newValue], ...parentStack.slice(1)];
          } else {
            newStack = [[fiberId2, newValue], ...parentStack];
          }
          parentFiberRefs.set(fiberRef, newStack);
        }
      }
    }
  });
  return new FiberRefsImpl(parentFiberRefs);
});
var forkAs = /* @__PURE__ */ dual(2, (self, childId) => {
  const map12 = /* @__PURE__ */ new Map();
  unsafeForkAs(self, map12, childId);
  return new FiberRefsImpl(map12);
});
var unsafeForkAs = (self, map12, fiberId2) => {
  self.locals.forEach((stack, fiberRef) => {
    const oldValue = stack[0][1];
    const newValue = fiberRef.patch(fiberRef.fork)(oldValue);
    if (equals(oldValue, newValue)) {
      map12.set(fiberRef, stack);
    } else {
      map12.set(fiberRef, [[fiberId2, newValue], ...stack]);
    }
  });
};
var delete_ = /* @__PURE__ */ dual(2, (self, fiberRef) => {
  const locals = new Map(self.locals);
  locals.delete(fiberRef);
  return new FiberRefsImpl(locals);
});
var get8 = /* @__PURE__ */ dual(2, (self, fiberRef) => {
  if (!self.locals.has(fiberRef)) {
    return none2();
  }
  return some2(headNonEmpty(self.locals.get(fiberRef))[1]);
});
var getOrDefault = /* @__PURE__ */ dual(2, (self, fiberRef) => pipe(get8(self, fiberRef), getOrElse(() => fiberRef.initial)));
var updateAs = /* @__PURE__ */ dual(2, (self, {
  fiberId: fiberId2,
  fiberRef,
  value
}) => {
  if (self.locals.size === 0) {
    return new FiberRefsImpl(/* @__PURE__ */ new Map([[fiberRef, [[fiberId2, value]]]]));
  }
  const locals = new Map(self.locals);
  unsafeUpdateAs(locals, fiberId2, fiberRef, value);
  return new FiberRefsImpl(locals);
});
var unsafeUpdateAs = (locals, fiberId2, fiberRef, value) => {
  const oldStack = locals.get(fiberRef) ?? [];
  let newStack;
  if (isNonEmptyReadonlyArray(oldStack)) {
    const [currentId, currentValue] = headNonEmpty(oldStack);
    if (currentId[symbol2](fiberId2)) {
      if (equals(currentValue, value)) {
        return;
      } else {
        newStack = [[fiberId2, value], ...oldStack.slice(1)];
      }
    } else {
      newStack = [[fiberId2, value], ...oldStack];
    }
  } else {
    newStack = [[fiberId2, value]];
  }
  locals.set(fiberRef, newStack);
};
var updateManyAs = /* @__PURE__ */ dual(2, (self, {
  entries: entries2,
  forkAs: forkAs2
}) => {
  if (self.locals.size === 0) {
    return new FiberRefsImpl(new Map(entries2));
  }
  const locals = new Map(self.locals);
  if (forkAs2 !== void 0) {
    unsafeForkAs(self, locals, forkAs2);
  }
  entries2.forEach(([fiberRef, values3]) => {
    if (values3.length === 1) {
      unsafeUpdateAs(locals, values3[0][0], fiberRef, values3[0][1]);
    } else {
      values3.forEach(([fiberId2, value]) => {
        unsafeUpdateAs(locals, fiberId2, fiberRef, value);
      });
    }
  });
  return new FiberRefsImpl(locals);
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/FiberRefs.js
var getOrDefault2 = getOrDefault;
var updateManyAs2 = updateManyAs;
var empty17 = empty16;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/fiberRefs/patch.js
var OP_EMPTY2 = "Empty";
var OP_ADD = "Add";
var OP_REMOVE = "Remove";
var OP_UPDATE = "Update";
var OP_AND_THEN = "AndThen";
var empty18 = {
  _tag: OP_EMPTY2
};
var diff5 = (oldValue, newValue) => {
  const missingLocals = new Map(oldValue.locals);
  let patch9 = empty18;
  for (const [fiberRef, pairs] of newValue.locals.entries()) {
    const newValue2 = headNonEmpty(pairs)[1];
    const old = missingLocals.get(fiberRef);
    if (old !== void 0) {
      const oldValue2 = headNonEmpty(old)[1];
      if (!equals(oldValue2, newValue2)) {
        patch9 = combine7({
          _tag: OP_UPDATE,
          fiberRef,
          patch: fiberRef.diff(oldValue2, newValue2)
        })(patch9);
      }
    } else {
      patch9 = combine7({
        _tag: OP_ADD,
        fiberRef,
        value: newValue2
      })(patch9);
    }
    missingLocals.delete(fiberRef);
  }
  for (const [fiberRef] of missingLocals.entries()) {
    patch9 = combine7({
      _tag: OP_REMOVE,
      fiberRef
    })(patch9);
  }
  return patch9;
};
var combine7 = /* @__PURE__ */ dual(2, (self, that) => ({
  _tag: OP_AND_THEN,
  first: self,
  second: that
}));
var patch6 = /* @__PURE__ */ dual(3, (self, fiberId2, oldValue) => {
  let fiberRefs3 = oldValue;
  let patches = of(self);
  while (isNonEmptyReadonlyArray(patches)) {
    const head4 = headNonEmpty(patches);
    const tail = tailNonEmpty(patches);
    switch (head4._tag) {
      case OP_EMPTY2: {
        patches = tail;
        break;
      }
      case OP_ADD: {
        fiberRefs3 = updateAs(fiberRefs3, {
          fiberId: fiberId2,
          fiberRef: head4.fiberRef,
          value: head4.value
        });
        patches = tail;
        break;
      }
      case OP_REMOVE: {
        fiberRefs3 = delete_(fiberRefs3, head4.fiberRef);
        patches = tail;
        break;
      }
      case OP_UPDATE: {
        const value = getOrDefault(fiberRefs3, head4.fiberRef);
        fiberRefs3 = updateAs(fiberRefs3, {
          fiberId: fiberId2,
          fiberRef: head4.fiberRef,
          value: head4.fiberRef.patch(head4.patch)(value)
        });
        patches = tail;
        break;
      }
      case OP_AND_THEN: {
        patches = prepend(head4.first)(prepend(head4.second)(tail));
        break;
      }
    }
  }
  return fiberRefs3;
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/FiberRefsPatch.js
var diff6 = diff5;
var patch7 = patch6;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/fiberStatus.js
var FiberStatusSymbolKey = "effect/FiberStatus";
var FiberStatusTypeId = /* @__PURE__ */ Symbol.for(FiberStatusSymbolKey);
var OP_DONE = "Done";
var OP_RUNNING = "Running";
var OP_SUSPENDED = "Suspended";
var DoneHash = /* @__PURE__ */ string(`${FiberStatusSymbolKey}-${OP_DONE}`);
var Done = class {
  [FiberStatusTypeId] = FiberStatusTypeId;
  _tag = OP_DONE;
  [symbol]() {
    return DoneHash;
  }
  [symbol2](that) {
    return isFiberStatus(that) && that._tag === OP_DONE;
  }
};
var Running = class {
  runtimeFlags;
  [FiberStatusTypeId] = FiberStatusTypeId;
  _tag = OP_RUNNING;
  constructor(runtimeFlags2) {
    this.runtimeFlags = runtimeFlags2;
  }
  [symbol]() {
    return pipe(hash(FiberStatusSymbolKey), combine(hash(this._tag)), combine(hash(this.runtimeFlags)), cached(this));
  }
  [symbol2](that) {
    return isFiberStatus(that) && that._tag === OP_RUNNING && this.runtimeFlags === that.runtimeFlags;
  }
};
var Suspended = class {
  runtimeFlags;
  blockingOn;
  [FiberStatusTypeId] = FiberStatusTypeId;
  _tag = OP_SUSPENDED;
  constructor(runtimeFlags2, blockingOn) {
    this.runtimeFlags = runtimeFlags2;
    this.blockingOn = blockingOn;
  }
  [symbol]() {
    return pipe(hash(FiberStatusSymbolKey), combine(hash(this._tag)), combine(hash(this.runtimeFlags)), combine(hash(this.blockingOn)), cached(this));
  }
  [symbol2](that) {
    return isFiberStatus(that) && that._tag === OP_SUSPENDED && this.runtimeFlags === that.runtimeFlags && equals(this.blockingOn, that.blockingOn);
  }
};
var done2 = /* @__PURE__ */ new Done();
var running = (runtimeFlags2) => new Running(runtimeFlags2);
var suspended = (runtimeFlags2, blockingOn) => new Suspended(runtimeFlags2, blockingOn);
var isFiberStatus = (u) => hasProperty(u, FiberStatusTypeId);
var isDone = (self) => self._tag === OP_DONE;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/FiberStatus.js
var done3 = done2;
var running2 = running;
var suspended2 = suspended;
var isDone2 = isDone;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/LogLevel.js
var All = logLevelAll;
var Fatal = logLevelFatal;
var Error2 = logLevelError;
var Warning = logLevelWarning;
var Info = logLevelInfo;
var Debug = logLevelDebug;
var Trace = logLevelTrace;
var None3 = logLevelNone;
var Order2 = /* @__PURE__ */ pipe(Order, /* @__PURE__ */ mapInput2((level) => level.ordinal));
var greaterThan2 = /* @__PURE__ */ greaterThan(Order2);
var fromLiteral = (literal) => {
  switch (literal) {
    case "All":
      return All;
    case "Debug":
      return Debug;
    case "Error":
      return Error2;
    case "Fatal":
      return Fatal;
    case "Info":
      return Info;
    case "Trace":
      return Trace;
    case "None":
      return None3;
    case "Warning":
      return Warning;
  }
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Micro.js
var TypeId9 = /* @__PURE__ */ Symbol.for("effect/Micro");
var MicroExitTypeId = /* @__PURE__ */ Symbol.for("effect/Micro/MicroExit");
var MicroCauseTypeId = /* @__PURE__ */ Symbol.for("effect/Micro/MicroCause");
var microCauseVariance = {
  _E: identity
};
var MicroCauseImpl = class extends globalThis.Error {
  _tag;
  traces;
  [MicroCauseTypeId];
  constructor(_tag, originalError, traces) {
    const causeName = `MicroCause.${_tag}`;
    let name;
    let message;
    let stack;
    if (originalError instanceof globalThis.Error) {
      name = `(${causeName}) ${originalError.name}`;
      message = originalError.message;
      const messageLines = message.split("\n").length;
      stack = originalError.stack ? `(${causeName}) ${originalError.stack.split("\n").slice(0, messageLines + 3).join("\n")}` : `${name}: ${message}`;
    } else {
      name = causeName;
      message = toStringUnknown(originalError, 0);
      stack = `${name}: ${message}`;
    }
    if (traces.length > 0) {
      stack += `
    ${traces.join("\n    ")}`;
    }
    super(message);
    this._tag = _tag;
    this.traces = traces;
    this[MicroCauseTypeId] = microCauseVariance;
    this.name = name;
    this.stack = stack;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
  toString() {
    return this.stack;
  }
  [NodeInspectSymbol]() {
    return this.stack;
  }
};
var Die = class extends MicroCauseImpl {
  defect;
  constructor(defect, traces = []) {
    super("Die", defect, traces);
    this.defect = defect;
  }
};
var causeDie = (defect, traces = []) => new Die(defect, traces);
var Interrupt = class extends MicroCauseImpl {
  constructor(traces = []) {
    super("Interrupt", "interrupted", traces);
  }
};
var causeInterrupt = (traces = []) => new Interrupt(traces);
var causeIsInterrupt = (self) => self._tag === "Interrupt";
var MicroFiberTypeId = /* @__PURE__ */ Symbol.for("effect/Micro/MicroFiber");
var fiberVariance = {
  _A: identity,
  _E: identity
};
var MicroFiberImpl = class {
  context;
  interruptible;
  [MicroFiberTypeId];
  _stack = [];
  _observers = [];
  _exit;
  _children;
  currentOpCount = 0;
  constructor(context2, interruptible4 = true) {
    this.context = context2;
    this.interruptible = interruptible4;
    this[MicroFiberTypeId] = fiberVariance;
  }
  getRef(ref) {
    return unsafeGetReference(this.context, ref);
  }
  addObserver(cb) {
    if (this._exit) {
      cb(this._exit);
      return constVoid;
    }
    this._observers.push(cb);
    return () => {
      const index = this._observers.indexOf(cb);
      if (index >= 0) {
        this._observers.splice(index, 1);
      }
    };
  }
  _interrupted = false;
  unsafeInterrupt() {
    if (this._exit) {
      return;
    }
    this._interrupted = true;
    if (this.interruptible) {
      this.evaluate(exitInterrupt2);
    }
  }
  unsafePoll() {
    return this._exit;
  }
  evaluate(effect) {
    if (this._exit) {
      return;
    } else if (this._yielded !== void 0) {
      const yielded = this._yielded;
      this._yielded = void 0;
      yielded();
    }
    const exit4 = this.runLoop(effect);
    if (exit4 === Yield) {
      return;
    }
    const interruptChildren = fiberMiddleware.interruptChildren && fiberMiddleware.interruptChildren(this);
    if (interruptChildren !== void 0) {
      return this.evaluate(flatMap7(interruptChildren, () => exit4));
    }
    this._exit = exit4;
    for (let i = 0; i < this._observers.length; i++) {
      this._observers[i](exit4);
    }
    this._observers.length = 0;
  }
  runLoop(effect) {
    let yielding = false;
    let current = effect;
    this.currentOpCount = 0;
    try {
      while (true) {
        this.currentOpCount++;
        if (!yielding && this.getRef(CurrentScheduler).shouldYield(this)) {
          yielding = true;
          const prev = current;
          current = flatMap7(yieldNow2, () => prev);
        }
        current = current[evaluate](this);
        if (current === Yield) {
          const yielded = this._yielded;
          if (MicroExitTypeId in yielded) {
            this._yielded = void 0;
            return yielded;
          }
          return Yield;
        }
      }
    } catch (error) {
      if (!hasProperty(current, evaluate)) {
        return exitDie2(`MicroFiber.runLoop: Not a valid effect: ${String(current)}`);
      }
      return exitDie2(error);
    }
  }
  getCont(symbol3) {
    while (true) {
      const op = this._stack.pop();
      if (!op) return void 0;
      const cont = op[ensureCont] && op[ensureCont](this);
      if (cont) return {
        [symbol3]: cont
      };
      if (op[symbol3]) return op;
    }
  }
  // cancel the yielded operation, or for the yielded exit value
  _yielded = void 0;
  yieldWith(value) {
    this._yielded = value;
    return Yield;
  }
  children() {
    return this._children ??= /* @__PURE__ */ new Set();
  }
};
var fiberMiddleware = /* @__PURE__ */ globalValue("effect/Micro/fiberMiddleware", () => ({
  interruptChildren: void 0
}));
var fiberInterruptAll = (fibers) => suspend2(() => {
  for (const fiber of fibers) fiber.unsafeInterrupt();
  const iter = fibers[Symbol.iterator]();
  const wait = suspend2(() => {
    let result = iter.next();
    while (!result.done) {
      if (result.value.unsafePoll()) {
        result = iter.next();
        continue;
      }
      const fiber = result.value;
      return async((resume2) => {
        fiber.addObserver((_) => {
          resume2(wait);
        });
      });
    }
    return exitVoid2;
  });
  return wait;
});
var identifier = /* @__PURE__ */ Symbol.for("effect/Micro/identifier");
var args = /* @__PURE__ */ Symbol.for("effect/Micro/args");
var evaluate = /* @__PURE__ */ Symbol.for("effect/Micro/evaluate");
var successCont = /* @__PURE__ */ Symbol.for("effect/Micro/successCont");
var failureCont = /* @__PURE__ */ Symbol.for("effect/Micro/failureCont");
var ensureCont = /* @__PURE__ */ Symbol.for("effect/Micro/ensureCont");
var Yield = /* @__PURE__ */ Symbol.for("effect/Micro/Yield");
var microVariance = {
  _A: identity,
  _E: identity,
  _R: identity
};
var MicroProto = {
  ...EffectPrototype2,
  _op: "Micro",
  [TypeId9]: microVariance,
  pipe() {
    return pipeArguments(this, arguments);
  },
  [Symbol.iterator]() {
    return new SingleShotGen(new YieldWrap(this));
  },
  toJSON() {
    return {
      _id: "Micro",
      op: this[identifier],
      ...args in this ? {
        args: this[args]
      } : void 0
    };
  },
  toString() {
    return format(this);
  },
  [NodeInspectSymbol]() {
    return format(this);
  }
};
function defaultEvaluate(_fiber) {
  return exitDie2(`Micro.evaluate: Not implemented`);
}
var makePrimitiveProto = (options) => ({
  ...MicroProto,
  [identifier]: options.op,
  [evaluate]: options.eval ?? defaultEvaluate,
  [successCont]: options.contA,
  [failureCont]: options.contE,
  [ensureCont]: options.ensure
});
var makePrimitive = (options) => {
  const Proto2 = makePrimitiveProto(options);
  return function() {
    const self = Object.create(Proto2);
    self[args] = options.single === false ? arguments : arguments[0];
    return self;
  };
};
var makeExit = (options) => {
  const Proto2 = {
    ...makePrimitiveProto(options),
    [MicroExitTypeId]: MicroExitTypeId,
    _tag: options.op,
    get [options.prop]() {
      return this[args];
    },
    toJSON() {
      return {
        _id: "MicroExit",
        _tag: options.op,
        [options.prop]: this[args]
      };
    },
    [symbol2](that) {
      return isMicroExit(that) && that._tag === options.op && equals(this[args], that[args]);
    },
    [symbol]() {
      return cached(this, combine(string(options.op))(hash(this[args])));
    }
  };
  return function(value) {
    const self = Object.create(Proto2);
    self[args] = value;
    self[successCont] = void 0;
    self[failureCont] = void 0;
    self[ensureCont] = void 0;
    return self;
  };
};
var succeed2 = /* @__PURE__ */ makeExit({
  op: "Success",
  prop: "value",
  eval(fiber) {
    const cont = fiber.getCont(successCont);
    return cont ? cont[successCont](this[args], fiber) : fiber.yieldWith(this);
  }
});
var failCause2 = /* @__PURE__ */ makeExit({
  op: "Failure",
  prop: "cause",
  eval(fiber) {
    let cont = fiber.getCont(failureCont);
    while (causeIsInterrupt(this[args]) && cont && fiber.interruptible) {
      cont = fiber.getCont(failureCont);
    }
    return cont ? cont[failureCont](this[args], fiber) : fiber.yieldWith(this);
  }
});
var sync2 = /* @__PURE__ */ makePrimitive({
  op: "Sync",
  eval(fiber) {
    const value = this[args]();
    const cont = fiber.getCont(successCont);
    return cont ? cont[successCont](value, fiber) : fiber.yieldWith(exitSucceed2(value));
  }
});
var suspend2 = /* @__PURE__ */ makePrimitive({
  op: "Suspend",
  eval(_fiber) {
    return this[args]();
  }
});
var yieldNowWith = /* @__PURE__ */ makePrimitive({
  op: "Yield",
  eval(fiber) {
    let resumed = false;
    fiber.getRef(CurrentScheduler).scheduleTask(() => {
      if (resumed) return;
      fiber.evaluate(exitVoid2);
    }, this[args] ?? 0);
    return fiber.yieldWith(() => {
      resumed = true;
    });
  }
});
var yieldNow2 = /* @__PURE__ */ yieldNowWith(0);
var void_2 = /* @__PURE__ */ succeed2(void 0);
var withMicroFiber = /* @__PURE__ */ makePrimitive({
  op: "WithMicroFiber",
  eval(fiber) {
    return this[args](fiber);
  }
});
var asyncOptions = /* @__PURE__ */ makePrimitive({
  op: "Async",
  single: false,
  eval(fiber) {
    const register = this[args][0];
    let resumed = false;
    let yielded = false;
    const controller = this[args][1] ? new AbortController() : void 0;
    const onCancel = register((effect) => {
      if (resumed) return;
      resumed = true;
      if (yielded) {
        fiber.evaluate(effect);
      } else {
        yielded = effect;
      }
    }, controller?.signal);
    if (yielded !== false) return yielded;
    yielded = true;
    fiber._yielded = () => {
      resumed = true;
    };
    if (controller === void 0 && onCancel === void 0) {
      return Yield;
    }
    fiber._stack.push(asyncFinalizer(() => {
      resumed = true;
      controller?.abort();
      return onCancel ?? exitVoid2;
    }));
    return Yield;
  }
});
var asyncFinalizer = /* @__PURE__ */ makePrimitive({
  op: "AsyncFinalizer",
  ensure(fiber) {
    if (fiber.interruptible) {
      fiber.interruptible = false;
      fiber._stack.push(setInterruptible(true));
    }
  },
  contE(cause2, _fiber) {
    return causeIsInterrupt(cause2) ? flatMap7(this[args](), () => failCause2(cause2)) : failCause2(cause2);
  }
});
var async = (register) => asyncOptions(register, register.length >= 2);
var as2 = /* @__PURE__ */ dual(2, (self, value) => map9(self, (_) => value));
var exit2 = (self) => matchCause2(self, {
  onFailure: exitFailCause2,
  onSuccess: exitSucceed2
});
var flatMap7 = /* @__PURE__ */ dual(2, (self, f) => {
  const onSuccess = Object.create(OnSuccessProto);
  onSuccess[args] = self;
  onSuccess[successCont] = f;
  return onSuccess;
});
var OnSuccessProto = /* @__PURE__ */ makePrimitiveProto({
  op: "OnSuccess",
  eval(fiber) {
    fiber._stack.push(this);
    return this[args];
  }
});
var map9 = /* @__PURE__ */ dual(2, (self, f) => flatMap7(self, (a) => succeed2(f(a))));
var isMicroExit = (u) => hasProperty(u, MicroExitTypeId);
var exitSucceed2 = succeed2;
var exitFailCause2 = failCause2;
var exitInterrupt2 = /* @__PURE__ */ exitFailCause2(/* @__PURE__ */ causeInterrupt());
var exitDie2 = (defect) => exitFailCause2(causeDie(defect));
var exitVoid2 = /* @__PURE__ */ exitSucceed2(void 0);
var exitVoidAll = (exits) => {
  for (const exit4 of exits) {
    if (exit4._tag === "Failure") {
      return exit4;
    }
  }
  return exitVoid2;
};
var setImmediate = "setImmediate" in globalThis ? globalThis.setImmediate : (f) => setTimeout(f, 0);
var MicroSchedulerDefault = class {
  tasks = [];
  running = false;
  /**
   * @since 3.5.9
   */
  scheduleTask(task, _priority) {
    this.tasks.push(task);
    if (!this.running) {
      this.running = true;
      setImmediate(this.afterScheduled);
    }
  }
  /**
   * @since 3.5.9
   */
  afterScheduled = () => {
    this.running = false;
    this.runTasks();
  };
  /**
   * @since 3.5.9
   */
  runTasks() {
    const tasks = this.tasks;
    this.tasks = [];
    for (let i = 0, len = tasks.length; i < len; i++) {
      tasks[i]();
    }
  }
  /**
   * @since 3.5.9
   */
  shouldYield(fiber) {
    return fiber.currentOpCount >= fiber.getRef(MaxOpsBeforeYield);
  }
  /**
   * @since 3.5.9
   */
  flush() {
    while (this.tasks.length > 0) {
      this.runTasks();
    }
  }
};
var updateContext = /* @__PURE__ */ dual(2, (self, f) => withMicroFiber((fiber) => {
  const prev = fiber.context;
  fiber.context = f(prev);
  return onExit2(self, () => {
    fiber.context = prev;
    return void_2;
  });
}));
var provideContext2 = /* @__PURE__ */ dual(2, (self, provided) => updateContext(self, merge3(provided)));
var MaxOpsBeforeYield = class extends (/* @__PURE__ */ Reference2()("effect/Micro/currentMaxOpsBeforeYield", {
  defaultValue: () => 2048
})) {
};
var CurrentConcurrency = class extends (/* @__PURE__ */ Reference2()("effect/Micro/currentConcurrency", {
  defaultValue: () => "unbounded"
})) {
};
var CurrentScheduler = class extends (/* @__PURE__ */ Reference2()("effect/Micro/currentScheduler", {
  defaultValue: () => new MicroSchedulerDefault()
})) {
};
var matchCauseEffect2 = /* @__PURE__ */ dual(2, (self, options) => {
  const primitive = Object.create(OnSuccessAndFailureProto);
  primitive[args] = self;
  primitive[successCont] = options.onSuccess;
  primitive[failureCont] = options.onFailure;
  return primitive;
});
var OnSuccessAndFailureProto = /* @__PURE__ */ makePrimitiveProto({
  op: "OnSuccessAndFailure",
  eval(fiber) {
    fiber._stack.push(this);
    return this[args];
  }
});
var matchCause2 = /* @__PURE__ */ dual(2, (self, options) => matchCauseEffect2(self, {
  onFailure: (cause2) => sync2(() => options.onFailure(cause2)),
  onSuccess: (value) => sync2(() => options.onSuccess(value))
}));
var MicroScopeTypeId = /* @__PURE__ */ Symbol.for("effect/Micro/MicroScope");
var MicroScopeImpl = class _MicroScopeImpl {
  [MicroScopeTypeId];
  state = {
    _tag: "Open",
    finalizers: /* @__PURE__ */ new Set()
  };
  constructor() {
    this[MicroScopeTypeId] = MicroScopeTypeId;
  }
  unsafeAddFinalizer(finalizer) {
    if (this.state._tag === "Open") {
      this.state.finalizers.add(finalizer);
    }
  }
  addFinalizer(finalizer) {
    return suspend2(() => {
      if (this.state._tag === "Open") {
        this.state.finalizers.add(finalizer);
        return void_2;
      }
      return finalizer(this.state.exit);
    });
  }
  unsafeRemoveFinalizer(finalizer) {
    if (this.state._tag === "Open") {
      this.state.finalizers.delete(finalizer);
    }
  }
  close(microExit) {
    return suspend2(() => {
      if (this.state._tag === "Open") {
        const finalizers = Array.from(this.state.finalizers).reverse();
        this.state = {
          _tag: "Closed",
          exit: microExit
        };
        return flatMap7(forEach3(finalizers, (finalizer) => exit2(finalizer(microExit))), exitVoidAll);
      }
      return void_2;
    });
  }
  get fork() {
    return sync2(() => {
      const newScope = new _MicroScopeImpl();
      if (this.state._tag === "Closed") {
        newScope.state = this.state;
        return newScope;
      }
      function fin(exit4) {
        return newScope.close(exit4);
      }
      this.state.finalizers.add(fin);
      newScope.unsafeAddFinalizer((_) => sync2(() => this.unsafeRemoveFinalizer(fin)));
      return newScope;
    });
  }
};
var onExit2 = /* @__PURE__ */ dual(2, (self, f) => uninterruptibleMask2((restore) => matchCauseEffect2(restore(self), {
  onFailure: (cause2) => flatMap7(f(exitFailCause2(cause2)), () => failCause2(cause2)),
  onSuccess: (a) => flatMap7(f(exitSucceed2(a)), () => succeed2(a))
})));
var setInterruptible = /* @__PURE__ */ makePrimitive({
  op: "SetInterruptible",
  ensure(fiber) {
    fiber.interruptible = this[args];
    if (fiber._interrupted && fiber.interruptible) {
      return () => exitInterrupt2;
    }
  }
});
var interruptible3 = (self) => withMicroFiber((fiber) => {
  if (fiber.interruptible) return self;
  fiber.interruptible = true;
  fiber._stack.push(setInterruptible(false));
  if (fiber._interrupted) return exitInterrupt2;
  return self;
});
var uninterruptibleMask2 = (f) => withMicroFiber((fiber) => {
  if (!fiber.interruptible) return f(identity);
  fiber.interruptible = false;
  fiber._stack.push(setInterruptible(true));
  return f(interruptible3);
});
var whileLoop2 = /* @__PURE__ */ makePrimitive({
  op: "While",
  contA(value, fiber) {
    this[args].step(value);
    if (this[args].while()) {
      fiber._stack.push(this);
      return this[args].body();
    }
    return exitVoid2;
  },
  eval(fiber) {
    if (this[args].while()) {
      fiber._stack.push(this);
      return this[args].body();
    }
    return exitVoid2;
  }
});
var forEach3 = (iterable, f, options) => withMicroFiber((parent) => {
  const concurrencyOption = options?.concurrency === "inherit" ? parent.getRef(CurrentConcurrency) : options?.concurrency ?? 1;
  const concurrency = concurrencyOption === "unbounded" ? Number.POSITIVE_INFINITY : Math.max(1, concurrencyOption);
  const items = fromIterable(iterable);
  let length3 = items.length;
  if (length3 === 0) {
    return options?.discard ? void_2 : succeed2([]);
  }
  const out = options?.discard ? void 0 : new Array(length3);
  let index = 0;
  if (concurrency === 1) {
    return as2(whileLoop2({
      while: () => index < items.length,
      body: () => f(items[index], index),
      step: out ? (b) => out[index++] = b : (_) => index++
    }), out);
  }
  return async((resume2) => {
    const fibers = /* @__PURE__ */ new Set();
    let result = void 0;
    let inProgress = 0;
    let doneCount = 0;
    let pumping = false;
    let interrupted2 = false;
    function pump() {
      pumping = true;
      while (inProgress < concurrency && index < length3) {
        const currentIndex = index;
        const item = items[currentIndex];
        index++;
        inProgress++;
        try {
          const child = unsafeFork(parent, f(item, currentIndex), true, true);
          fibers.add(child);
          child.addObserver((exit4) => {
            fibers.delete(child);
            if (interrupted2) {
              return;
            } else if (exit4._tag === "Failure") {
              if (result === void 0) {
                result = exit4;
                length3 = index;
                fibers.forEach((fiber) => fiber.unsafeInterrupt());
              }
            } else if (out !== void 0) {
              out[currentIndex] = exit4.value;
            }
            doneCount++;
            inProgress--;
            if (doneCount === length3) {
              resume2(result ?? succeed2(out));
            } else if (!pumping && inProgress < concurrency) {
              pump();
            }
          });
        } catch (err) {
          result = exitDie2(err);
          length3 = index;
          fibers.forEach((fiber) => fiber.unsafeInterrupt());
        }
      }
      pumping = false;
    }
    pump();
    return suspend2(() => {
      interrupted2 = true;
      index = length3;
      return fiberInterruptAll(fibers);
    });
  });
});
var unsafeFork = (parent, effect, immediate = false, daemon = false) => {
  const child = new MicroFiberImpl(parent.context, parent.interruptible);
  if (!daemon) {
    parent.children().add(child);
    child.addObserver(() => parent.children().delete(child));
  }
  if (immediate) {
    child.evaluate(effect);
  } else {
    parent.getRef(CurrentScheduler).scheduleTask(() => child.evaluate(effect), 0);
  }
  return child;
};
var runFork = (effect, options) => {
  const fiber = new MicroFiberImpl(CurrentScheduler.context(options?.scheduler ?? new MicroSchedulerDefault()));
  fiber.evaluate(effect);
  if (options?.signal) {
    if (options.signal.aborted) {
      fiber.unsafeInterrupt();
    } else {
      const abort = () => fiber.unsafeInterrupt();
      options.signal.addEventListener("abort", abort, {
        once: true
      });
      fiber.addObserver(() => options.signal.removeEventListener("abort", abort));
    }
  }
  return fiber;
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Readable.js
var TypeId10 = /* @__PURE__ */ Symbol.for("effect/Readable");
var Proto = {
  [TypeId10]: TypeId10,
  pipe() {
    return pipeArguments(this, arguments);
  }
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/ref.js
var RefTypeId = /* @__PURE__ */ Symbol.for("effect/Ref");
var refVariance = {
  /* c8 ignore next */
  _A: (_) => _
};
var RefImpl = class extends Class2 {
  ref;
  commit() {
    return this.get;
  }
  [RefTypeId] = refVariance;
  [TypeId10] = TypeId10;
  constructor(ref) {
    super();
    this.ref = ref;
    this.get = sync(() => get6(this.ref));
  }
  get;
  modify(f) {
    return sync(() => {
      const current = get6(this.ref);
      const [b, a] = f(current);
      if (current !== a) {
        set2(a)(this.ref);
      }
      return b;
    });
  }
};
var unsafeMake4 = (value) => new RefImpl(make11(value));
var make23 = (value) => sync(() => unsafeMake4(value));
var get9 = (self) => self.get;
var set4 = /* @__PURE__ */ dual(2, (self, value) => self.modify(() => [void 0, value]));
var getAndSet = /* @__PURE__ */ dual(2, (self, value) => self.modify((a) => [a, value]));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Ref.js
var make24 = make23;
var getAndSet2 = getAndSet;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Scheduler.js
var SchedulerRunner = class _SchedulerRunner {
  scheduleDrain;
  running = false;
  tasks = /* @__PURE__ */ new PriorityBuckets();
  constructor(scheduleDrain) {
    this.scheduleDrain = scheduleDrain;
  }
  starveInternal = (depth) => {
    const tasks = this.tasks.buckets;
    this.tasks.buckets = [];
    for (const [_, toRun] of tasks) {
      for (let i = 0; i < toRun.length; i++) {
        toRun[i]();
      }
    }
    if (this.tasks.buckets.length === 0) {
      this.running = false;
    } else {
      this.starve(depth);
    }
  };
  starve(depth = 0) {
    this.scheduleDrain(depth, this.starveInternal);
  }
  scheduleTask(task, priority) {
    this.tasks.scheduleTask(task, priority);
    if (!this.running) {
      this.running = true;
      this.starve();
    }
  }
  /**
   * @since 3.20.0
   * @category constructors
   */
  static cached(scheduleDrain) {
    const fallback = new _SchedulerRunner(scheduleDrain);
    const runners = /* @__PURE__ */ new WeakMap();
    return (fiber) => {
      if (fiber === void 0) {
        return fallback;
      }
      let runner = runners.get(fiber);
      if (runner === void 0) {
        runner = new _SchedulerRunner(scheduleDrain);
        runners.set(fiber, runner);
      }
      return runner;
    };
  }
};
var PriorityBuckets = class {
  /**
   * @since 2.0.0
   */
  buckets = [];
  /**
   * @since 2.0.0
   */
  scheduleTask(task, priority) {
    const length3 = this.buckets.length;
    let bucket = void 0;
    let index = 0;
    for (; index < length3; index++) {
      if (this.buckets[index][0] <= priority) {
        bucket = this.buckets[index];
      } else {
        break;
      }
    }
    if (bucket && bucket[0] === priority) {
      bucket[1].push(task);
    } else if (index === length3) {
      this.buckets.push([priority, [task]]);
    } else {
      this.buckets.splice(index, 0, [priority, [task]]);
    }
  }
};
var MixedScheduler = class {
  maxNextTickBeforeTimer;
  getRunner = /* @__PURE__ */ SchedulerRunner.cached((depth, drain) => {
    if (depth >= this.maxNextTickBeforeTimer) {
      setTimeout(() => drain(0), 0);
    } else {
      Promise.resolve(void 0).then(() => drain(depth + 1));
    }
  });
  constructor(maxNextTickBeforeTimer) {
    this.maxNextTickBeforeTimer = maxNextTickBeforeTimer;
  }
  /**
   * @since 2.0.0
   */
  shouldYield(fiber) {
    return fiber.currentOpCount > fiber.getFiberRef(currentMaxOpsBeforeYield) ? fiber.getFiberRef(currentSchedulingPriority) : false;
  }
  /**
   * @since 2.0.0
   */
  scheduleTask(task, priority, fiber) {
    this.getRunner(fiber).scheduleTask(task, priority);
  }
};
var defaultScheduler = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/Scheduler/defaultScheduler"), () => new MixedScheduler(2048));
var SyncScheduler = class {
  /**
   * @since 2.0.0
   */
  tasks = /* @__PURE__ */ new PriorityBuckets();
  /**
   * @since 2.0.0
   */
  deferred = false;
  /**
   * @since 2.0.0
   */
  scheduleTask(task, priority, fiber) {
    if (this.deferred) {
      defaultScheduler.scheduleTask(task, priority, fiber);
    } else {
      this.tasks.scheduleTask(task, priority);
    }
  }
  /**
   * @since 2.0.0
   */
  shouldYield(fiber) {
    return fiber.currentOpCount > fiber.getFiberRef(currentMaxOpsBeforeYield) ? fiber.getFiberRef(currentSchedulingPriority) : false;
  }
  /**
   * @since 2.0.0
   */
  flush() {
    while (this.tasks.buckets.length > 0) {
      const tasks = this.tasks.buckets;
      this.tasks.buckets = [];
      for (const [_, toRun] of tasks) {
        for (let i = 0; i < toRun.length; i++) {
          toRun[i]();
        }
      }
    }
    this.deferred = true;
  }
};
var currentScheduler = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentScheduler"), () => fiberRefUnsafeMake(defaultScheduler));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/completedRequestMap.js
var currentRequestMap = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentRequestMap"), () => fiberRefUnsafeMake(/* @__PURE__ */ new Map()));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/concurrency.js
var match7 = (concurrency, sequential4, unbounded3, bounded4) => {
  switch (concurrency) {
    case void 0:
      return sequential4();
    case "unbounded":
      return unbounded3();
    case "inherit":
      return fiberRefGetWith(currentConcurrency, (concurrency2) => concurrency2 === "unbounded" ? unbounded3() : concurrency2 > 1 ? bounded4(concurrency2) : sequential4());
    default:
      return concurrency > 1 ? bounded4(concurrency) : sequential4();
  }
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Clock.js
var sleep2 = sleep;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/logSpan.js
var formatLabel = (key) => key.replace(/[\s="]/g, "_");
var render = (now) => (self) => {
  const label = formatLabel(self.label);
  return `${label}=${now - self.startTime}ms`;
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/metric/label.js
var MetricLabelSymbolKey = "effect/MetricLabel";
var MetricLabelTypeId = /* @__PURE__ */ Symbol.for(MetricLabelSymbolKey);
var MetricLabelImpl = class {
  key;
  value;
  [MetricLabelTypeId] = MetricLabelTypeId;
  _hash;
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this._hash = string(MetricLabelSymbolKey + this.key + this.value);
  }
  [symbol]() {
    return this._hash;
  }
  [symbol2](that) {
    return isMetricLabel(that) && this.key === that.key && this.value === that.value;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var make25 = (key, value) => {
  return new MetricLabelImpl(key, value);
};
var isMetricLabel = (u) => hasProperty(u, MetricLabelTypeId);

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/core-effect.js
var asSome = (self) => map8(self, some2);
var try_ = (arg) => {
  let evaluate2;
  let onFailure = void 0;
  if (typeof arg === "function") {
    evaluate2 = arg;
  } else {
    evaluate2 = arg.try;
    onFailure = arg.catch;
  }
  return suspend(() => {
    try {
      return succeed(internalCall(evaluate2));
    } catch (error) {
      return fail2(onFailure ? internalCall(() => onFailure(error)) : new UnknownException(error, "An unknown error occurred in Effect.try"));
    }
  });
};
var diffFiberRefsAndRuntimeFlags = (self) => summarized(self, zip2(fiberRefs2, runtimeFlags), ([refs, flags], [refsNew, flagsNew]) => [diff5(refs, refsNew), diff4(flags, flagsNew)]);
var match8 = /* @__PURE__ */ dual(2, (self, options) => matchEffect(self, {
  onFailure: (e) => succeed(options.onFailure(e)),
  onSuccess: (a) => succeed(options.onSuccess(a))
}));
var fiberRefs2 = /* @__PURE__ */ withFiberRuntime((state) => succeed(state.getFiberRefs()));
var mapErrorCause = /* @__PURE__ */ dual(2, (self, f) => matchCauseEffect(self, {
  onFailure: (c) => failCauseSync(() => f(c)),
  onSuccess: succeed
}));
var memoize = (self) => pipe(deferredMake(), flatMap6((deferred) => pipe(diffFiberRefsAndRuntimeFlags(self), intoDeferred(deferred), once, map8((complete2) => zipRight(complete2, pipe(deferredAwait(deferred), flatMap6(([patch9, a]) => as(zip2(patchFiberRefs(patch9[0]), updateRuntimeFlags(patch9[1])), a))))))));
var once = (self) => map8(make24(true), (ref) => asVoid(whenEffect(self, getAndSet2(ref, false))));
var option = (self) => matchEffect(self, {
  onFailure: () => succeed(none2()),
  onSuccess: (a) => succeed(some2(a))
});
var patchFiberRefs = (patch9) => updateFiberRefs((fiberId2, fiberRefs3) => pipe(patch9, patch6(fiberId2, fiberRefs3)));
var sleep3 = sleep2;
var succeedNone = /* @__PURE__ */ succeed(/* @__PURE__ */ none2());
var summarized = /* @__PURE__ */ dual(3, (self, summary5, f) => flatMap6(summary5, (start) => flatMap6(self, (value) => map8(summary5, (end) => [f(start, end), value]))));
var tapError = /* @__PURE__ */ dual(2, (self, f) => matchCauseEffect(self, {
  onFailure: (cause2) => {
    const either4 = failureOrCause(cause2);
    switch (either4._tag) {
      case "Left":
        return zipRight(f(either4.left), failCause(cause2));
      case "Right":
        return failCause(cause2);
    }
  },
  onSuccess: succeed
}));
var tryPromise = (arg) => {
  let evaluate2;
  let catcher = void 0;
  if (typeof arg === "function") {
    evaluate2 = arg;
  } else {
    evaluate2 = arg.try;
    catcher = arg.catch;
  }
  const fail7 = (e) => catcher ? failSync(() => catcher(e)) : fail2(new UnknownException(e, "An unknown error occurred in Effect.tryPromise"));
  if (evaluate2.length >= 1) {
    return async_((resolve, signal) => {
      try {
        evaluate2(signal).then((a) => resolve(succeed(a)), (e) => resolve(fail7(e)));
      } catch (e) {
        resolve(fail7(e));
      }
    });
  }
  return async_((resolve) => {
    try {
      evaluate2().then((a) => resolve(succeed(a)), (e) => resolve(fail7(e)));
    } catch (e) {
      resolve(fail7(e));
    }
  });
};
var updateFiberRefs = (f) => withFiberRuntime((state) => {
  state.setFiberRefs(f(state.id(), state.getFiberRefs()));
  return void_;
});
var filterDisablePropagation = /* @__PURE__ */ flatMap((span2) => get5(span2.context, DisablePropagation) ? span2._tag === "Span" ? filterDisablePropagation(span2.parent) : none2() : some2(span2));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Exit.js
var isSuccess = exitIsSuccess;
var fail3 = exitFail;
var void_3 = exitVoid;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/fiberMessage.js
var OP_INTERRUPT_SIGNAL = "InterruptSignal";
var OP_STATEFUL = "Stateful";
var OP_RESUME = "Resume";
var OP_YIELD_NOW = "YieldNow";
var interruptSignal = (cause2) => ({
  _tag: OP_INTERRUPT_SIGNAL,
  cause: cause2
});
var stateful = (onFiber) => ({
  _tag: OP_STATEFUL,
  onFiber
});
var resume = (effect) => ({
  _tag: OP_RESUME,
  effect
});
var yieldNow3 = () => ({
  _tag: OP_YIELD_NOW
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/fiberScope.js
var FiberScopeSymbolKey = "effect/FiberScope";
var FiberScopeTypeId = /* @__PURE__ */ Symbol.for(FiberScopeSymbolKey);
var Global = class {
  [FiberScopeTypeId] = FiberScopeTypeId;
  fiberId = none4;
  roots = /* @__PURE__ */ new Set();
  add(_runtimeFlags, child) {
    this.roots.add(child);
    child.addObserver(() => {
      this.roots.delete(child);
    });
  }
};
var Local = class {
  fiberId;
  parent;
  [FiberScopeTypeId] = FiberScopeTypeId;
  constructor(fiberId2, parent) {
    this.fiberId = fiberId2;
    this.parent = parent;
  }
  add(_runtimeFlags, child) {
    this.parent.tell(stateful((parentFiber) => {
      parentFiber.addChild(child);
      child.addObserver(() => {
        parentFiber.removeChild(child);
      });
    }));
  }
};
var unsafeMake5 = (fiber) => {
  return new Local(fiber.id(), fiber);
};
var globalScope = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberScope/Global"), () => new Global());

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/fiber.js
var FiberSymbolKey = "effect/Fiber";
var FiberTypeId = /* @__PURE__ */ Symbol.for(FiberSymbolKey);
var fiberVariance2 = {
  /* c8 ignore next */
  _E: (_) => _,
  /* c8 ignore next */
  _A: (_) => _
};
var fiberProto = {
  [FiberTypeId]: fiberVariance2,
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var RuntimeFiberSymbolKey = "effect/Fiber";
var RuntimeFiberTypeId = /* @__PURE__ */ Symbol.for(RuntimeFiberSymbolKey);
var isRuntimeFiber = (self) => RuntimeFiberTypeId in self;
var _await = (self) => self.await;
var inheritAll = (self) => self.inheritAll;
var interruptAllAs = /* @__PURE__ */ dual(2, /* @__PURE__ */ fnUntraced(function* (fibers, fiberId2) {
  for (const fiber of fibers) {
    if (isRuntimeFiber(fiber)) {
      fiber.unsafeInterruptAsFork(fiberId2);
      continue;
    }
    yield* fiber.interruptAsFork(fiberId2);
  }
  for (const fiber of fibers) {
    if (isRuntimeFiber(fiber) && fiber.unsafePoll()) {
      continue;
    }
    yield* fiber.await;
  }
}));
var join2 = (self) => zipLeft(flatten3(self.await), self.inheritAll);
var _never = {
  ...CommitPrototype,
  commit() {
    return join2(this);
  },
  ...fiberProto,
  id: () => none4,
  await: never,
  children: /* @__PURE__ */ succeed([]),
  inheritAll: never,
  poll: /* @__PURE__ */ succeed(/* @__PURE__ */ none2()),
  interruptAsFork: () => never
};
var currentFiberURI = "effect/FiberCurrent";

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/logger.js
var LoggerSymbolKey = "effect/Logger";
var LoggerTypeId = /* @__PURE__ */ Symbol.for(LoggerSymbolKey);
var loggerVariance = {
  /* c8 ignore next */
  _Message: (_) => _,
  /* c8 ignore next */
  _Output: (_) => _
};
var makeLogger = (log2) => ({
  [LoggerTypeId]: loggerVariance,
  log: log2,
  pipe() {
    return pipeArguments(this, arguments);
  }
});
var none6 = {
  [LoggerTypeId]: loggerVariance,
  log: constVoid,
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var textOnly = /^[^\s"=]*$/;
var format3 = (quoteValue, whitespace) => ({
  annotations,
  cause: cause2,
  date,
  fiberId: fiberId2,
  logLevel,
  message,
  spans
}) => {
  const formatValue = (value) => value.match(textOnly) ? value : quoteValue(value);
  const format4 = (label, value) => `${formatLabel(label)}=${formatValue(value)}`;
  const append4 = (label, value) => " " + format4(label, value);
  let out = format4("timestamp", date.toISOString());
  out += append4("level", logLevel.label);
  out += append4("fiber", threadName(fiberId2));
  const messages = ensure(message);
  for (let i = 0; i < messages.length; i++) {
    out += append4("message", toStringUnknown(messages[i], whitespace));
  }
  if (!isEmptyType(cause2)) {
    out += append4("cause", pretty(cause2, {
      renderErrorCause: true
    }));
  }
  for (const span2 of spans) {
    out += " " + render(date.getTime())(span2);
  }
  for (const [label, value] of annotations) {
    out += append4(label, toStringUnknown(value, whitespace));
  }
  return out;
};
var escapeDoubleQuotes = (s) => `"${s.replace(/\\([\s\S])|(")/g, "\\$1$2")}"`;
var stringLogger = /* @__PURE__ */ makeLogger(/* @__PURE__ */ format3(escapeDoubleQuotes));
var colors = {
  bold: "1",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  cyan: "36",
  white: "37",
  gray: "90",
  black: "30",
  bgBrightRed: "101"
};
var logLevelColors = {
  None: [],
  All: [],
  Trace: [colors.gray],
  Debug: [colors.blue],
  Info: [colors.green],
  Warning: [colors.yellow],
  Error: [colors.red],
  Fatal: [colors.bgBrightRed, colors.black]
};
var hasProcessStdout = typeof process === "object" && process !== null && typeof process.stdout === "object" && process.stdout !== null;
var processStdoutIsTTY = hasProcessStdout && process.stdout.isTTY === true;
var hasProcessStdoutOrDeno = hasProcessStdout || "Deno" in globalThis;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/metric/boundaries.js
var MetricBoundariesSymbolKey = "effect/MetricBoundaries";
var MetricBoundariesTypeId = /* @__PURE__ */ Symbol.for(MetricBoundariesSymbolKey);
var MetricBoundariesImpl = class {
  values;
  [MetricBoundariesTypeId] = MetricBoundariesTypeId;
  constructor(values3) {
    this.values = values3;
    this._hash = pipe(string(MetricBoundariesSymbolKey), combine(array2(this.values)));
  }
  _hash;
  [symbol]() {
    return this._hash;
  }
  [symbol2](u) {
    return isMetricBoundaries(u) && equals(this.values, u.values);
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var isMetricBoundaries = (u) => hasProperty(u, MetricBoundariesTypeId);
var fromIterable7 = (iterable) => {
  const values3 = pipe(iterable, appendAll(of2(Number.POSITIVE_INFINITY)), dedupe);
  return new MetricBoundariesImpl(values3);
};
var exponential = (options) => pipe(makeBy(options.count - 1, (i) => options.start * Math.pow(options.factor, i)), unsafeFromArray, fromIterable7);

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/metric/keyType.js
var MetricKeyTypeSymbolKey = "effect/MetricKeyType";
var MetricKeyTypeTypeId = /* @__PURE__ */ Symbol.for(MetricKeyTypeSymbolKey);
var CounterKeyTypeSymbolKey = "effect/MetricKeyType/Counter";
var CounterKeyTypeTypeId = /* @__PURE__ */ Symbol.for(CounterKeyTypeSymbolKey);
var FrequencyKeyTypeSymbolKey = "effect/MetricKeyType/Frequency";
var FrequencyKeyTypeTypeId = /* @__PURE__ */ Symbol.for(FrequencyKeyTypeSymbolKey);
var GaugeKeyTypeSymbolKey = "effect/MetricKeyType/Gauge";
var GaugeKeyTypeTypeId = /* @__PURE__ */ Symbol.for(GaugeKeyTypeSymbolKey);
var HistogramKeyTypeSymbolKey = "effect/MetricKeyType/Histogram";
var HistogramKeyTypeTypeId = /* @__PURE__ */ Symbol.for(HistogramKeyTypeSymbolKey);
var SummaryKeyTypeSymbolKey = "effect/MetricKeyType/Summary";
var SummaryKeyTypeTypeId = /* @__PURE__ */ Symbol.for(SummaryKeyTypeSymbolKey);
var metricKeyTypeVariance = {
  /* c8 ignore next */
  _In: (_) => _,
  /* c8 ignore next */
  _Out: (_) => _
};
var CounterKeyType = class {
  incremental;
  bigint;
  [MetricKeyTypeTypeId] = metricKeyTypeVariance;
  [CounterKeyTypeTypeId] = CounterKeyTypeTypeId;
  constructor(incremental, bigint) {
    this.incremental = incremental;
    this.bigint = bigint;
    this._hash = string(CounterKeyTypeSymbolKey);
  }
  _hash;
  [symbol]() {
    return this._hash;
  }
  [symbol2](that) {
    return isCounterKey(that);
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var FrequencyKeyTypeHash = /* @__PURE__ */ string(FrequencyKeyTypeSymbolKey);
var FrequencyKeyType = class {
  preregisteredWords;
  [MetricKeyTypeTypeId] = metricKeyTypeVariance;
  [FrequencyKeyTypeTypeId] = FrequencyKeyTypeTypeId;
  constructor(preregisteredWords) {
    this.preregisteredWords = preregisteredWords;
  }
  [symbol]() {
    return FrequencyKeyTypeHash;
  }
  [symbol2](that) {
    return isFrequencyKey(that);
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var GaugeKeyTypeHash = /* @__PURE__ */ string(GaugeKeyTypeSymbolKey);
var GaugeKeyType = class {
  bigint;
  [MetricKeyTypeTypeId] = metricKeyTypeVariance;
  [GaugeKeyTypeTypeId] = GaugeKeyTypeTypeId;
  constructor(bigint) {
    this.bigint = bigint;
  }
  [symbol]() {
    return GaugeKeyTypeHash;
  }
  [symbol2](that) {
    return isGaugeKey(that);
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var HistogramKeyType = class {
  boundaries;
  [MetricKeyTypeTypeId] = metricKeyTypeVariance;
  [HistogramKeyTypeTypeId] = HistogramKeyTypeTypeId;
  constructor(boundaries) {
    this.boundaries = boundaries;
    this._hash = pipe(string(HistogramKeyTypeSymbolKey), combine(hash(this.boundaries)));
  }
  _hash;
  [symbol]() {
    return this._hash;
  }
  [symbol2](that) {
    return isHistogramKey(that) && equals(this.boundaries, that.boundaries);
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var SummaryKeyType = class {
  maxAge;
  maxSize;
  error;
  quantiles;
  [MetricKeyTypeTypeId] = metricKeyTypeVariance;
  [SummaryKeyTypeTypeId] = SummaryKeyTypeTypeId;
  constructor(maxAge, maxSize, error, quantiles) {
    this.maxAge = maxAge;
    this.maxSize = maxSize;
    this.error = error;
    this.quantiles = quantiles;
    this._hash = pipe(string(SummaryKeyTypeSymbolKey), combine(hash(this.maxAge)), combine(hash(this.maxSize)), combine(hash(this.error)), combine(array2(this.quantiles)));
  }
  _hash;
  [symbol]() {
    return this._hash;
  }
  [symbol2](that) {
    return isSummaryKey(that) && equals(this.maxAge, that.maxAge) && this.maxSize === that.maxSize && this.error === that.error && equals(this.quantiles, that.quantiles);
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var counter = (options) => new CounterKeyType(options?.incremental ?? false, options?.bigint ?? false);
var histogram = (boundaries) => {
  return new HistogramKeyType(boundaries);
};
var isCounterKey = (u) => hasProperty(u, CounterKeyTypeTypeId);
var isFrequencyKey = (u) => hasProperty(u, FrequencyKeyTypeTypeId);
var isGaugeKey = (u) => hasProperty(u, GaugeKeyTypeTypeId);
var isHistogramKey = (u) => hasProperty(u, HistogramKeyTypeTypeId);
var isSummaryKey = (u) => hasProperty(u, SummaryKeyTypeTypeId);

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/metric/key.js
var MetricKeySymbolKey = "effect/MetricKey";
var MetricKeyTypeId = /* @__PURE__ */ Symbol.for(MetricKeySymbolKey);
var metricKeyVariance = {
  /* c8 ignore next */
  _Type: (_) => _
};
var arrayEquivilence = /* @__PURE__ */ getEquivalence(equals);
var MetricKeyImpl = class {
  name;
  keyType;
  description;
  tags;
  [MetricKeyTypeId] = metricKeyVariance;
  constructor(name, keyType, description, tags = []) {
    this.name = name;
    this.keyType = keyType;
    this.description = description;
    this.tags = tags;
    this._hash = pipe(string(this.name + this.description), combine(hash(this.keyType)), combine(array2(this.tags)));
  }
  _hash;
  [symbol]() {
    return this._hash;
  }
  [symbol2](u) {
    return isMetricKey(u) && this.name === u.name && equals(this.keyType, u.keyType) && equals(this.description, u.description) && arrayEquivilence(this.tags, u.tags);
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var isMetricKey = (u) => hasProperty(u, MetricKeyTypeId);
var counter2 = (name, options) => new MetricKeyImpl(name, counter(options), fromNullable(options?.description));
var histogram2 = (name, boundaries, description) => new MetricKeyImpl(name, histogram(boundaries), fromNullable(description));
var taggedWithLabels = /* @__PURE__ */ dual(2, (self, extraTags) => extraTags.length === 0 ? self : new MetricKeyImpl(self.name, self.keyType, self.description, union(self.tags, extraTags)));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/MutableHashMap.js
var TypeId11 = /* @__PURE__ */ Symbol.for("effect/MutableHashMap");
var MutableHashMapProto = {
  [TypeId11]: TypeId11,
  [Symbol.iterator]() {
    return new MutableHashMapIterator(this);
  },
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "MutableHashMap",
      values: Array.from(this).map(toJSON)
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var MutableHashMapIterator = class _MutableHashMapIterator {
  self;
  referentialIterator;
  bucketIterator;
  constructor(self) {
    this.self = self;
    this.referentialIterator = self.referential[Symbol.iterator]();
  }
  next() {
    if (this.bucketIterator !== void 0) {
      return this.bucketIterator.next();
    }
    const result = this.referentialIterator.next();
    if (result.done) {
      this.bucketIterator = new BucketIterator(this.self.buckets.values());
      return this.next();
    }
    return result;
  }
  [Symbol.iterator]() {
    return new _MutableHashMapIterator(this.self);
  }
};
var BucketIterator = class {
  backing;
  constructor(backing) {
    this.backing = backing;
  }
  currentBucket;
  next() {
    if (this.currentBucket === void 0) {
      const result2 = this.backing.next();
      if (result2.done) {
        return result2;
      }
      this.currentBucket = result2.value[Symbol.iterator]();
    }
    const result = this.currentBucket.next();
    if (result.done) {
      this.currentBucket = void 0;
      return this.next();
    }
    return result;
  }
};
var empty19 = () => {
  const self = Object.create(MutableHashMapProto);
  self.referential = /* @__PURE__ */ new Map();
  self.buckets = /* @__PURE__ */ new Map();
  self.bucketsSize = 0;
  return self;
};
var get11 = /* @__PURE__ */ dual(2, (self, key) => {
  if (isEqual(key) === false) {
    return self.referential.has(key) ? some2(self.referential.get(key)) : none2();
  }
  const hash2 = key[symbol]();
  const bucket = self.buckets.get(hash2);
  if (bucket === void 0) {
    return none2();
  }
  return getFromBucket(self, bucket, key);
});
var getFromBucket = (self, bucket, key, remove7 = false) => {
  for (let i = 0, len = bucket.length; i < len; i++) {
    if (key[symbol2](bucket[i][0])) {
      const value = bucket[i][1];
      if (remove7) {
        bucket.splice(i, 1);
        self.bucketsSize--;
      }
      return some2(value);
    }
  }
  return none2();
};
var has4 = /* @__PURE__ */ dual(2, (self, key) => isSome2(get11(self, key)));
var set5 = /* @__PURE__ */ dual(3, (self, key, value) => {
  if (isEqual(key) === false) {
    self.referential.set(key, value);
    return self;
  }
  const hash2 = key[symbol]();
  const bucket = self.buckets.get(hash2);
  if (bucket === void 0) {
    self.buckets.set(hash2, [[key, value]]);
    self.bucketsSize++;
    return self;
  }
  removeFromBucket(self, bucket, key);
  bucket.push([key, value]);
  self.bucketsSize++;
  return self;
});
var removeFromBucket = (self, bucket, key) => {
  for (let i = 0, len = bucket.length; i < len; i++) {
    if (key[symbol2](bucket[i][0])) {
      bucket.splice(i, 1);
      self.bucketsSize--;
      return;
    }
  }
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/metric/state.js
var MetricStateSymbolKey = "effect/MetricState";
var MetricStateTypeId = /* @__PURE__ */ Symbol.for(MetricStateSymbolKey);
var CounterStateSymbolKey = "effect/MetricState/Counter";
var CounterStateTypeId = /* @__PURE__ */ Symbol.for(CounterStateSymbolKey);
var FrequencyStateSymbolKey = "effect/MetricState/Frequency";
var FrequencyStateTypeId = /* @__PURE__ */ Symbol.for(FrequencyStateSymbolKey);
var GaugeStateSymbolKey = "effect/MetricState/Gauge";
var GaugeStateTypeId = /* @__PURE__ */ Symbol.for(GaugeStateSymbolKey);
var HistogramStateSymbolKey = "effect/MetricState/Histogram";
var HistogramStateTypeId = /* @__PURE__ */ Symbol.for(HistogramStateSymbolKey);
var SummaryStateSymbolKey = "effect/MetricState/Summary";
var SummaryStateTypeId = /* @__PURE__ */ Symbol.for(SummaryStateSymbolKey);
var metricStateVariance = {
  /* c8 ignore next */
  _A: (_) => _
};
var CounterState = class {
  count;
  [MetricStateTypeId] = metricStateVariance;
  [CounterStateTypeId] = CounterStateTypeId;
  constructor(count) {
    this.count = count;
  }
  [symbol]() {
    return pipe(hash(CounterStateSymbolKey), combine(hash(this.count)), cached(this));
  }
  [symbol2](that) {
    return isCounterState(that) && this.count === that.count;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var arrayEquals = /* @__PURE__ */ getEquivalence(equals);
var FrequencyState = class {
  occurrences;
  [MetricStateTypeId] = metricStateVariance;
  [FrequencyStateTypeId] = FrequencyStateTypeId;
  constructor(occurrences) {
    this.occurrences = occurrences;
  }
  _hash;
  [symbol]() {
    return pipe(string(FrequencyStateSymbolKey), combine(array2(fromIterable(this.occurrences.entries()))), cached(this));
  }
  [symbol2](that) {
    return isFrequencyState(that) && arrayEquals(fromIterable(this.occurrences.entries()), fromIterable(that.occurrences.entries()));
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var GaugeState = class {
  value;
  [MetricStateTypeId] = metricStateVariance;
  [GaugeStateTypeId] = GaugeStateTypeId;
  constructor(value) {
    this.value = value;
  }
  [symbol]() {
    return pipe(hash(GaugeStateSymbolKey), combine(hash(this.value)), cached(this));
  }
  [symbol2](u) {
    return isGaugeState(u) && this.value === u.value;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var HistogramState = class {
  buckets;
  count;
  min;
  max;
  sum;
  [MetricStateTypeId] = metricStateVariance;
  [HistogramStateTypeId] = HistogramStateTypeId;
  constructor(buckets, count, min2, max2, sum) {
    this.buckets = buckets;
    this.count = count;
    this.min = min2;
    this.max = max2;
    this.sum = sum;
  }
  [symbol]() {
    return pipe(hash(HistogramStateSymbolKey), combine(hash(this.buckets)), combine(hash(this.count)), combine(hash(this.min)), combine(hash(this.max)), combine(hash(this.sum)), cached(this));
  }
  [symbol2](that) {
    return isHistogramState(that) && equals(this.buckets, that.buckets) && this.count === that.count && this.min === that.min && this.max === that.max && this.sum === that.sum;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var SummaryState = class {
  error;
  quantiles;
  count;
  min;
  max;
  sum;
  [MetricStateTypeId] = metricStateVariance;
  [SummaryStateTypeId] = SummaryStateTypeId;
  constructor(error, quantiles, count, min2, max2, sum) {
    this.error = error;
    this.quantiles = quantiles;
    this.count = count;
    this.min = min2;
    this.max = max2;
    this.sum = sum;
  }
  [symbol]() {
    return pipe(hash(SummaryStateSymbolKey), combine(hash(this.error)), combine(hash(this.quantiles)), combine(hash(this.count)), combine(hash(this.min)), combine(hash(this.max)), combine(hash(this.sum)), cached(this));
  }
  [symbol2](that) {
    return isSummaryState(that) && this.error === that.error && equals(this.quantiles, that.quantiles) && this.count === that.count && this.min === that.min && this.max === that.max && this.sum === that.sum;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var counter3 = (count) => new CounterState(count);
var frequency2 = (occurrences) => {
  return new FrequencyState(occurrences);
};
var gauge2 = (count) => new GaugeState(count);
var histogram3 = (options) => new HistogramState(options.buckets, options.count, options.min, options.max, options.sum);
var summary2 = (options) => new SummaryState(options.error, options.quantiles, options.count, options.min, options.max, options.sum);
var isCounterState = (u) => hasProperty(u, CounterStateTypeId);
var isFrequencyState = (u) => hasProperty(u, FrequencyStateTypeId);
var isGaugeState = (u) => hasProperty(u, GaugeStateTypeId);
var isHistogramState = (u) => hasProperty(u, HistogramStateTypeId);
var isSummaryState = (u) => hasProperty(u, SummaryStateTypeId);

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/metric/hook.js
var MetricHookSymbolKey = "effect/MetricHook";
var MetricHookTypeId = /* @__PURE__ */ Symbol.for(MetricHookSymbolKey);
var metricHookVariance = {
  /* c8 ignore next */
  _In: (_) => _,
  /* c8 ignore next */
  _Out: (_) => _
};
var make26 = (options) => ({
  [MetricHookTypeId]: metricHookVariance,
  pipe() {
    return pipeArguments(this, arguments);
  },
  ...options
});
var bigint02 = /* @__PURE__ */ BigInt(0);
var counter4 = (key) => {
  let sum = key.keyType.bigint ? bigint02 : 0;
  const canUpdate = key.keyType.incremental ? key.keyType.bigint ? (value) => value >= bigint02 : (value) => value >= 0 : (_value) => true;
  const update4 = (value) => {
    if (canUpdate(value)) {
      sum = sum + value;
    }
  };
  return make26({
    get: () => counter3(sum),
    update: update4,
    modify: update4
  });
};
var frequency3 = (key) => {
  const values3 = /* @__PURE__ */ new Map();
  for (const word of key.keyType.preregisteredWords) {
    values3.set(word, 0);
  }
  const update4 = (word) => {
    const slotCount = values3.get(word) ?? 0;
    values3.set(word, slotCount + 1);
  };
  return make26({
    get: () => frequency2(values3),
    update: update4,
    modify: update4
  });
};
var gauge3 = (_key, startAt) => {
  let value = startAt;
  return make26({
    get: () => gauge2(value),
    update: (v) => {
      value = v;
    },
    modify: (v) => {
      value = value + v;
    }
  });
};
var histogram4 = (key) => {
  const bounds = key.keyType.boundaries.values;
  const size8 = bounds.length;
  const values3 = new Uint32Array(size8 + 1);
  const boundaries = new Float64Array(size8);
  let count = 0;
  let sum = 0;
  let min2 = Number.MAX_VALUE;
  let max2 = Number.MIN_VALUE;
  pipe(bounds, sort(Order), map2((n, i) => {
    boundaries[i] = n;
  }));
  const update4 = (value) => {
    let from = 0;
    let to = size8;
    while (from !== to) {
      const mid = Math.floor(from + (to - from) / 2);
      const boundary = boundaries[mid];
      if (value <= boundary) {
        to = mid;
      } else {
        from = mid;
      }
      if (to === from + 1) {
        if (value <= boundaries[from]) {
          to = from;
        } else {
          from = to;
        }
      }
    }
    values3[from] = values3[from] + 1;
    count = count + 1;
    sum = sum + value;
    if (value < min2) {
      min2 = value;
    }
    if (value > max2) {
      max2 = value;
    }
  };
  const getBuckets = () => {
    const builder = allocate(size8);
    let cumulated = 0;
    for (let i = 0; i < size8; i++) {
      const boundary = boundaries[i];
      const value = values3[i];
      cumulated = cumulated + value;
      builder[i] = [boundary, cumulated];
    }
    return builder;
  };
  return make26({
    get: () => histogram3({
      buckets: getBuckets(),
      count,
      min: min2,
      max: max2,
      sum
    }),
    update: update4,
    modify: update4
  });
};
var summary3 = (key) => {
  const {
    error,
    maxAge,
    maxSize,
    quantiles
  } = key.keyType;
  const sortedQuantiles = pipe(quantiles, sort(Order));
  const values3 = allocate(maxSize);
  let head4 = 0;
  let count = 0;
  let sum = 0;
  let min2 = 0;
  let max2 = 0;
  const snapshot = (now) => {
    const builder = [];
    let i = 0;
    while (i !== maxSize - 1) {
      const item = values3[i];
      if (item != null) {
        const [t, v] = item;
        const age = millis(now - t);
        if (greaterThanOrEqualTo(age, zero) && lessThanOrEqualTo(age, maxAge)) {
          builder.push(v);
        }
      }
      i = i + 1;
    }
    return calculateQuantiles(error, sortedQuantiles, sort(builder, Order));
  };
  const observe = (value, timestamp) => {
    if (maxSize > 0) {
      head4 = head4 + 1;
      const target = head4 % maxSize;
      values3[target] = [timestamp, value];
    }
    min2 = count === 0 ? value : Math.min(min2, value);
    max2 = count === 0 ? value : Math.max(max2, value);
    count = count + 1;
    sum = sum + value;
  };
  return make26({
    get: () => summary2({
      error,
      quantiles: snapshot(Date.now()),
      count,
      min: min2,
      max: max2,
      sum
    }),
    update: ([value, timestamp]) => observe(value, timestamp),
    modify: ([value, timestamp]) => observe(value, timestamp)
  });
};
var calculateQuantiles = (error, sortedQuantiles, sortedSamples) => {
  const sampleCount = sortedSamples.length;
  if (!isNonEmptyReadonlyArray(sortedQuantiles)) {
    return empty();
  }
  const head4 = sortedQuantiles[0];
  const tail = sortedQuantiles.slice(1);
  const resolvedHead = resolveQuantile(error, sampleCount, none2(), 0, head4, sortedSamples);
  const resolved = of(resolvedHead);
  tail.forEach((quantile) => {
    resolved.push(resolveQuantile(error, sampleCount, resolvedHead.value, resolvedHead.consumed, quantile, resolvedHead.rest));
  });
  return map2(resolved, (rq) => [rq.quantile, rq.value]);
};
var resolveQuantile = (error, sampleCount, current, consumed, quantile, rest) => {
  let error_1 = error;
  let sampleCount_1 = sampleCount;
  let current_1 = current;
  let consumed_1 = consumed;
  let quantile_1 = quantile;
  let rest_1 = rest;
  let error_2 = error;
  let sampleCount_2 = sampleCount;
  let current_2 = current;
  let consumed_2 = consumed;
  let quantile_2 = quantile;
  let rest_2 = rest;
  while (1) {
    if (!isNonEmptyReadonlyArray(rest_1)) {
      return {
        quantile: quantile_1,
        value: none2(),
        consumed: consumed_1,
        rest: []
      };
    }
    if (quantile_1 === 1) {
      return {
        quantile: quantile_1,
        value: some2(lastNonEmpty(rest_1)),
        consumed: consumed_1 + rest_1.length,
        rest: []
      };
    }
    const headValue = headNonEmpty(rest_1);
    const sameHead = span(rest_1, (n) => n === headValue);
    const desired = quantile_1 * sampleCount_1;
    const allowedError = error_1 / 2 * desired;
    const candConsumed = consumed_1 + sameHead[0].length;
    const candError = Math.abs(candConsumed - desired);
    if (candConsumed < desired - allowedError) {
      error_2 = error_1;
      sampleCount_2 = sampleCount_1;
      current_2 = head(rest_1);
      consumed_2 = candConsumed;
      quantile_2 = quantile_1;
      rest_2 = sameHead[1];
      error_1 = error_2;
      sampleCount_1 = sampleCount_2;
      current_1 = current_2;
      consumed_1 = consumed_2;
      quantile_1 = quantile_2;
      rest_1 = rest_2;
      continue;
    }
    if (candConsumed > desired + allowedError) {
      const valueToReturn = isNone2(current_1) ? some2(headValue) : current_1;
      return {
        quantile: quantile_1,
        value: valueToReturn,
        consumed: consumed_1,
        rest: rest_1
      };
    }
    switch (current_1._tag) {
      case "None": {
        error_2 = error_1;
        sampleCount_2 = sampleCount_1;
        current_2 = head(rest_1);
        consumed_2 = candConsumed;
        quantile_2 = quantile_1;
        rest_2 = sameHead[1];
        error_1 = error_2;
        sampleCount_1 = sampleCount_2;
        current_1 = current_2;
        consumed_1 = consumed_2;
        quantile_1 = quantile_2;
        rest_1 = rest_2;
        continue;
      }
      case "Some": {
        const prevError = Math.abs(desired - current_1.value);
        if (candError < prevError) {
          error_2 = error_1;
          sampleCount_2 = sampleCount_1;
          current_2 = head(rest_1);
          consumed_2 = candConsumed;
          quantile_2 = quantile_1;
          rest_2 = sameHead[1];
          error_1 = error_2;
          sampleCount_1 = sampleCount_2;
          current_1 = current_2;
          consumed_1 = consumed_2;
          quantile_1 = quantile_2;
          rest_1 = rest_2;
          continue;
        }
        return {
          quantile: quantile_1,
          value: some2(current_1.value),
          consumed: consumed_1,
          rest: rest_1
        };
      }
    }
  }
  throw new Error("BUG: MetricHook.resolveQuantiles - please report an issue at https://github.com/Effect-TS/effect/issues");
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/metric/pair.js
var MetricPairSymbolKey = "effect/MetricPair";
var MetricPairTypeId = /* @__PURE__ */ Symbol.for(MetricPairSymbolKey);
var metricPairVariance = {
  /* c8 ignore next */
  _Type: (_) => _
};
var unsafeMake6 = (metricKey, metricState) => {
  return {
    [MetricPairTypeId]: metricPairVariance,
    metricKey,
    metricState,
    pipe() {
      return pipeArguments(this, arguments);
    }
  };
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/metric/registry.js
var MetricRegistrySymbolKey = "effect/MetricRegistry";
var MetricRegistryTypeId = /* @__PURE__ */ Symbol.for(MetricRegistrySymbolKey);
var MetricRegistryImpl = class {
  [MetricRegistryTypeId] = MetricRegistryTypeId;
  map = /* @__PURE__ */ empty19();
  snapshot() {
    const result = [];
    for (const [key, hook] of this.map) {
      result.push(unsafeMake6(key, hook.get()));
    }
    return result;
  }
  get(key) {
    const hook = pipe(this.map, get11(key), getOrUndefined);
    if (hook == null) {
      if (isCounterKey(key.keyType)) {
        return this.getCounter(key);
      }
      if (isGaugeKey(key.keyType)) {
        return this.getGauge(key);
      }
      if (isFrequencyKey(key.keyType)) {
        return this.getFrequency(key);
      }
      if (isHistogramKey(key.keyType)) {
        return this.getHistogram(key);
      }
      if (isSummaryKey(key.keyType)) {
        return this.getSummary(key);
      }
      throw new Error("BUG: MetricRegistry.get - unknown MetricKeyType - please report an issue at https://github.com/Effect-TS/effect/issues");
    } else {
      return hook;
    }
  }
  getCounter(key) {
    let value = pipe(this.map, get11(key), getOrUndefined);
    if (value == null) {
      const counter6 = counter4(key);
      if (!pipe(this.map, has4(key))) {
        pipe(this.map, set5(key, counter6));
      }
      value = counter6;
    }
    return value;
  }
  getFrequency(key) {
    let value = pipe(this.map, get11(key), getOrUndefined);
    if (value == null) {
      const frequency5 = frequency3(key);
      if (!pipe(this.map, has4(key))) {
        pipe(this.map, set5(key, frequency5));
      }
      value = frequency5;
    }
    return value;
  }
  getGauge(key) {
    let value = pipe(this.map, get11(key), getOrUndefined);
    if (value == null) {
      const gauge5 = gauge3(key, key.keyType.bigint ? BigInt(0) : 0);
      if (!pipe(this.map, has4(key))) {
        pipe(this.map, set5(key, gauge5));
      }
      value = gauge5;
    }
    return value;
  }
  getHistogram(key) {
    let value = pipe(this.map, get11(key), getOrUndefined);
    if (value == null) {
      const histogram6 = histogram4(key);
      if (!pipe(this.map, has4(key))) {
        pipe(this.map, set5(key, histogram6));
      }
      value = histogram6;
    }
    return value;
  }
  getSummary(key) {
    let value = pipe(this.map, get11(key), getOrUndefined);
    if (value == null) {
      const summary5 = summary3(key);
      if (!pipe(this.map, has4(key))) {
        pipe(this.map, set5(key, summary5));
      }
      value = summary5;
    }
    return value;
  }
};
var make27 = () => {
  return new MetricRegistryImpl();
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/metric.js
var MetricSymbolKey = "effect/Metric";
var MetricTypeId = /* @__PURE__ */ Symbol.for(MetricSymbolKey);
var metricVariance = {
  /* c8 ignore next */
  _Type: (_) => _,
  /* c8 ignore next */
  _In: (_) => _,
  /* c8 ignore next */
  _Out: (_) => _
};
var globalMetricRegistry = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/Metric/globalMetricRegistry"), () => make27());
var make28 = function(keyType, unsafeUpdate, unsafeValue, unsafeModify) {
  const metric = Object.assign((effect) => tap(effect, (a) => update3(metric, a)), {
    [MetricTypeId]: metricVariance,
    keyType,
    unsafeUpdate,
    unsafeValue,
    unsafeModify,
    register() {
      this.unsafeValue([]);
      return this;
    },
    pipe() {
      return pipeArguments(this, arguments);
    }
  });
  return metric;
};
var counter5 = (name, options) => fromMetricKey(counter2(name, options));
var fromMetricKey = (key) => {
  let untaggedHook;
  const hookCache = /* @__PURE__ */ new WeakMap();
  const hook = (extraTags) => {
    if (extraTags.length === 0) {
      if (untaggedHook !== void 0) {
        return untaggedHook;
      }
      untaggedHook = globalMetricRegistry.get(key);
      return untaggedHook;
    }
    let hook2 = hookCache.get(extraTags);
    if (hook2 !== void 0) {
      return hook2;
    }
    hook2 = globalMetricRegistry.get(taggedWithLabels(key, extraTags));
    hookCache.set(extraTags, hook2);
    return hook2;
  };
  return make28(key.keyType, (input, extraTags) => hook(extraTags).update(input), (extraTags) => hook(extraTags).get(), (input, extraTags) => hook(extraTags).modify(input));
};
var histogram5 = (name, boundaries, description) => fromMetricKey(histogram2(name, boundaries, description));
var tagged = /* @__PURE__ */ dual(3, (self, key, value) => taggedWithLabels2(self, [make25(key, value)]));
var taggedWithLabels2 = /* @__PURE__ */ dual(2, (self, extraTags) => {
  return make28(self.keyType, (input, extraTags1) => self.unsafeUpdate(input, union(extraTags, extraTags1)), (extraTags1) => self.unsafeValue(union(extraTags, extraTags1)), (input, extraTags1) => self.unsafeModify(input, union(extraTags, extraTags1)));
});
var update3 = /* @__PURE__ */ dual(2, (self, input) => fiberRefGetWith(currentMetricLabels, (tags) => sync(() => self.unsafeUpdate(input, tags))));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/request.js
var RequestSymbolKey = "effect/Request";
var RequestTypeId = /* @__PURE__ */ Symbol.for(RequestSymbolKey);
var requestVariance = {
  /* c8 ignore next */
  _E: (_) => _,
  /* c8 ignore next */
  _A: (_) => _
};
var RequestPrototype = {
  ...StructuralPrototype,
  [RequestTypeId]: requestVariance
};
var complete = /* @__PURE__ */ dual(2, (self, result) => fiberRefGetWith(currentRequestMap, (map12) => sync(() => {
  if (map12.has(self)) {
    const entry = map12.get(self);
    if (!entry.state.completed) {
      entry.state.completed = true;
      deferredUnsafeDone(entry.result, result);
    }
  }
})));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/redBlackTree/iterator.js
var Direction = {
  Forward: 0,
  Backward: 1 << 0
};
var RedBlackTreeIterator = class _RedBlackTreeIterator {
  self;
  stack;
  direction;
  count = 0;
  constructor(self, stack, direction) {
    this.self = self;
    this.stack = stack;
    this.direction = direction;
  }
  /**
   * Clones the iterator
   */
  clone() {
    return new _RedBlackTreeIterator(this.self, this.stack.slice(), this.direction);
  }
  /**
   * Reverse the traversal direction
   */
  reversed() {
    return new _RedBlackTreeIterator(this.self, this.stack.slice(), this.direction === Direction.Forward ? Direction.Backward : Direction.Forward);
  }
  /**
   * Iterator next
   */
  next() {
    const entry = this.entry;
    this.count++;
    if (this.direction === Direction.Forward) {
      this.moveNext();
    } else {
      this.movePrev();
    }
    switch (entry._tag) {
      case "None": {
        return {
          done: true,
          value: this.count
        };
      }
      case "Some": {
        return {
          done: false,
          value: entry.value
        };
      }
    }
  }
  /**
   * Returns the key
   */
  get key() {
    if (this.stack.length > 0) {
      return some2(this.stack[this.stack.length - 1].key);
    }
    return none2();
  }
  /**
   * Returns the value
   */
  get value() {
    if (this.stack.length > 0) {
      return some2(this.stack[this.stack.length - 1].value);
    }
    return none2();
  }
  /**
   * Returns the key
   */
  get entry() {
    return map(last(this.stack), (node) => [node.key, node.value]);
  }
  /**
   * Returns the position of this iterator in the sorted list
   */
  get index() {
    let idx = 0;
    const stack = this.stack;
    if (stack.length === 0) {
      const r = this.self._root;
      if (r != null) {
        return r.count;
      }
      return 0;
    } else if (stack[stack.length - 1].left != null) {
      idx = stack[stack.length - 1].left.count;
    }
    for (let s = stack.length - 2; s >= 0; --s) {
      if (stack[s + 1] === stack[s].right) {
        ++idx;
        if (stack[s].left != null) {
          idx += stack[s].left.count;
        }
      }
    }
    return idx;
  }
  /**
   * Advances iterator to next element in list
   */
  moveNext() {
    const stack = this.stack;
    if (stack.length === 0) {
      return;
    }
    let n = stack[stack.length - 1];
    if (n.right != null) {
      n = n.right;
      while (n != null) {
        stack.push(n);
        n = n.left;
      }
    } else {
      stack.pop();
      while (stack.length > 0 && stack[stack.length - 1].right === n) {
        n = stack[stack.length - 1];
        stack.pop();
      }
    }
  }
  /**
   * Checks if there is a next element
   */
  get hasNext() {
    const stack = this.stack;
    if (stack.length === 0) {
      return false;
    }
    if (stack[stack.length - 1].right != null) {
      return true;
    }
    for (let s = stack.length - 1; s > 0; --s) {
      if (stack[s - 1].left === stack[s]) {
        return true;
      }
    }
    return false;
  }
  /**
   * Advances iterator to previous element in list
   */
  movePrev() {
    const stack = this.stack;
    if (stack.length === 0) {
      return;
    }
    let n = stack[stack.length - 1];
    if (n != null && n.left != null) {
      n = n.left;
      while (n != null) {
        stack.push(n);
        n = n.right;
      }
    } else {
      stack.pop();
      while (stack.length > 0 && stack[stack.length - 1].left === n) {
        n = stack[stack.length - 1];
        stack.pop();
      }
    }
  }
  /**
   * Checks if there is a previous element
   */
  get hasPrev() {
    const stack = this.stack;
    if (stack.length === 0) {
      return false;
    }
    if (stack[stack.length - 1].left != null) {
      return true;
    }
    for (let s = stack.length - 1; s > 0; --s) {
      if (stack[s - 1].right === stack[s]) {
        return true;
      }
    }
    return false;
  }
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/redBlackTree/node.js
var Color = {
  Red: 0,
  Black: 1 << 0
};
var clone = ({
  color,
  count,
  key,
  left: left3,
  right: right3,
  value
}) => ({
  color,
  key,
  value,
  left: left3,
  right: right3,
  count
});
function swap2(n, v) {
  n.key = v.key;
  n.value = v.value;
  n.left = v.left;
  n.right = v.right;
  n.color = v.color;
  n.count = v.count;
}
var repaint = ({
  count,
  key,
  left: left3,
  right: right3,
  value
}, color) => ({
  color,
  key,
  value,
  left: left3,
  right: right3,
  count
});
var recount = (node) => {
  node.count = 1 + (node.left?.count ?? 0) + (node.right?.count ?? 0);
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/redBlackTree.js
var RedBlackTreeSymbolKey = "effect/RedBlackTree";
var RedBlackTreeTypeId = /* @__PURE__ */ Symbol.for(RedBlackTreeSymbolKey);
var redBlackTreeVariance = {
  /* c8 ignore next */
  _Key: (_) => _,
  /* c8 ignore next */
  _Value: (_) => _
};
var RedBlackTreeProto = {
  [RedBlackTreeTypeId]: redBlackTreeVariance,
  [symbol]() {
    let hash2 = hash(RedBlackTreeSymbolKey);
    for (const item of this) {
      hash2 ^= pipe(hash(item[0]), combine(hash(item[1])));
    }
    return cached(this, hash2);
  },
  [symbol2](that) {
    if (isRedBlackTree(that)) {
      if ((this._root?.count ?? 0) !== (that._root?.count ?? 0)) {
        return false;
      }
      const entries2 = Array.from(that);
      return Array.from(this).every((itemSelf, i) => {
        const itemThat = entries2[i];
        return equals(itemSelf[0], itemThat[0]) && equals(itemSelf[1], itemThat[1]);
      });
    }
    return false;
  },
  [Symbol.iterator]() {
    const stack = [];
    let n = this._root;
    while (n != null) {
      stack.push(n);
      n = n.left;
    }
    return new RedBlackTreeIterator(this, stack, Direction.Forward);
  },
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "RedBlackTree",
      values: Array.from(this).map(toJSON)
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var makeImpl3 = (ord, root) => {
  const tree = Object.create(RedBlackTreeProto);
  tree._ord = ord;
  tree._root = root;
  return tree;
};
var isRedBlackTree = (u) => hasProperty(u, RedBlackTreeTypeId);
var findFirst3 = /* @__PURE__ */ dual(2, (self, key) => {
  const cmp = self._ord;
  let node = self._root;
  while (node !== void 0) {
    const d = cmp(key, node.key);
    if (equals(key, node.key)) {
      return some2(node.value);
    }
    if (d <= 0) {
      node = node.left;
    } else {
      node = node.right;
    }
  }
  return none2();
});
var has5 = /* @__PURE__ */ dual(2, (self, key) => isSome2(findFirst3(self, key)));
var insert = /* @__PURE__ */ dual(3, (self, key, value) => {
  const cmp = self._ord;
  let n = self._root;
  const n_stack = [];
  const d_stack = [];
  while (n != null) {
    const d = cmp(key, n.key);
    n_stack.push(n);
    d_stack.push(d);
    if (d <= 0) {
      n = n.left;
    } else {
      n = n.right;
    }
  }
  n_stack.push({
    color: Color.Red,
    key,
    value,
    left: void 0,
    right: void 0,
    count: 1
  });
  for (let s = n_stack.length - 2; s >= 0; --s) {
    const n2 = n_stack[s];
    if (d_stack[s] <= 0) {
      n_stack[s] = {
        color: n2.color,
        key: n2.key,
        value: n2.value,
        left: n_stack[s + 1],
        right: n2.right,
        count: n2.count + 1
      };
    } else {
      n_stack[s] = {
        color: n2.color,
        key: n2.key,
        value: n2.value,
        left: n2.left,
        right: n_stack[s + 1],
        count: n2.count + 1
      };
    }
  }
  for (let s = n_stack.length - 1; s > 1; --s) {
    const p = n_stack[s - 1];
    const n3 = n_stack[s];
    if (p.color === Color.Black || n3.color === Color.Black) {
      break;
    }
    const pp = n_stack[s - 2];
    if (pp.left === p) {
      if (p.left === n3) {
        const y = pp.right;
        if (y && y.color === Color.Red) {
          p.color = Color.Black;
          pp.right = repaint(y, Color.Black);
          pp.color = Color.Red;
          s -= 1;
        } else {
          pp.color = Color.Red;
          pp.left = p.right;
          p.color = Color.Black;
          p.right = pp;
          n_stack[s - 2] = p;
          n_stack[s - 1] = n3;
          recount(pp);
          recount(p);
          if (s >= 3) {
            const ppp = n_stack[s - 3];
            if (ppp.left === pp) {
              ppp.left = p;
            } else {
              ppp.right = p;
            }
          }
          break;
        }
      } else {
        const y = pp.right;
        if (y && y.color === Color.Red) {
          p.color = Color.Black;
          pp.right = repaint(y, Color.Black);
          pp.color = Color.Red;
          s -= 1;
        } else {
          p.right = n3.left;
          pp.color = Color.Red;
          pp.left = n3.right;
          n3.color = Color.Black;
          n3.left = p;
          n3.right = pp;
          n_stack[s - 2] = n3;
          n_stack[s - 1] = p;
          recount(pp);
          recount(p);
          recount(n3);
          if (s >= 3) {
            const ppp = n_stack[s - 3];
            if (ppp.left === pp) {
              ppp.left = n3;
            } else {
              ppp.right = n3;
            }
          }
          break;
        }
      }
    } else {
      if (p.right === n3) {
        const y = pp.left;
        if (y && y.color === Color.Red) {
          p.color = Color.Black;
          pp.left = repaint(y, Color.Black);
          pp.color = Color.Red;
          s -= 1;
        } else {
          pp.color = Color.Red;
          pp.right = p.left;
          p.color = Color.Black;
          p.left = pp;
          n_stack[s - 2] = p;
          n_stack[s - 1] = n3;
          recount(pp);
          recount(p);
          if (s >= 3) {
            const ppp = n_stack[s - 3];
            if (ppp.right === pp) {
              ppp.right = p;
            } else {
              ppp.left = p;
            }
          }
          break;
        }
      } else {
        const y = pp.left;
        if (y && y.color === Color.Red) {
          p.color = Color.Black;
          pp.left = repaint(y, Color.Black);
          pp.color = Color.Red;
          s -= 1;
        } else {
          p.left = n3.right;
          pp.color = Color.Red;
          pp.right = n3.left;
          n3.color = Color.Black;
          n3.right = p;
          n3.left = pp;
          n_stack[s - 2] = n3;
          n_stack[s - 1] = p;
          recount(pp);
          recount(p);
          recount(n3);
          if (s >= 3) {
            const ppp = n_stack[s - 3];
            if (ppp.right === pp) {
              ppp.right = n3;
            } else {
              ppp.left = n3;
            }
          }
          break;
        }
      }
    }
  }
  n_stack[0].color = Color.Black;
  return makeImpl3(self._ord, n_stack[0]);
});
var keysForward = (self) => keys3(self, Direction.Forward);
var keys3 = (self, direction) => {
  const begin = self[Symbol.iterator]();
  let count = 0;
  return {
    [Symbol.iterator]: () => keys3(self, direction),
    next: () => {
      count++;
      const entry = begin.key;
      if (direction === Direction.Forward) {
        begin.moveNext();
      } else {
        begin.movePrev();
      }
      switch (entry._tag) {
        case "None": {
          return {
            done: true,
            value: count
          };
        }
        case "Some": {
          return {
            done: false,
            value: entry.value
          };
        }
      }
    }
  };
};
var removeFirst = /* @__PURE__ */ dual(2, (self, key) => {
  if (!has5(self, key)) {
    return self;
  }
  const ord = self._ord;
  const cmp = ord;
  let node = self._root;
  const stack = [];
  while (node !== void 0) {
    const d = cmp(key, node.key);
    stack.push(node);
    if (equals(key, node.key)) {
      node = void 0;
    } else if (d <= 0) {
      node = node.left;
    } else {
      node = node.right;
    }
  }
  if (stack.length === 0) {
    return self;
  }
  const cstack = new Array(stack.length);
  let n = stack[stack.length - 1];
  cstack[cstack.length - 1] = {
    color: n.color,
    key: n.key,
    value: n.value,
    left: n.left,
    right: n.right,
    count: n.count
  };
  for (let i = stack.length - 2; i >= 0; --i) {
    n = stack[i];
    if (n.left === stack[i + 1]) {
      cstack[i] = {
        color: n.color,
        key: n.key,
        value: n.value,
        left: cstack[i + 1],
        right: n.right,
        count: n.count
      };
    } else {
      cstack[i] = {
        color: n.color,
        key: n.key,
        value: n.value,
        left: n.left,
        right: cstack[i + 1],
        count: n.count
      };
    }
  }
  n = cstack[cstack.length - 1];
  if (n.left !== void 0 && n.right !== void 0) {
    const split = cstack.length;
    n = n.left;
    while (n.right != null) {
      cstack.push(n);
      n = n.right;
    }
    const v = cstack[split - 1];
    cstack.push({
      color: n.color,
      key: v.key,
      value: v.value,
      left: n.left,
      right: n.right,
      count: n.count
    });
    cstack[split - 1].key = n.key;
    cstack[split - 1].value = n.value;
    for (let i = cstack.length - 2; i >= split; --i) {
      n = cstack[i];
      cstack[i] = {
        color: n.color,
        key: n.key,
        value: n.value,
        left: n.left,
        right: cstack[i + 1],
        count: n.count
      };
    }
    cstack[split - 1].left = cstack[split];
  }
  n = cstack[cstack.length - 1];
  if (n.color === Color.Red) {
    const p = cstack[cstack.length - 2];
    if (p.left === n) {
      p.left = void 0;
    } else if (p.right === n) {
      p.right = void 0;
    }
    cstack.pop();
    for (let i = 0; i < cstack.length; ++i) {
      cstack[i].count--;
    }
    return makeImpl3(ord, cstack[0]);
  } else {
    if (n.left !== void 0 || n.right !== void 0) {
      if (n.left !== void 0) {
        swap2(n, n.left);
      } else if (n.right !== void 0) {
        swap2(n, n.right);
      }
      n.color = Color.Black;
      for (let i = 0; i < cstack.length - 1; ++i) {
        cstack[i].count--;
      }
      return makeImpl3(ord, cstack[0]);
    } else if (cstack.length === 1) {
      return makeImpl3(ord, void 0);
    } else {
      for (let i = 0; i < cstack.length; ++i) {
        cstack[i].count--;
      }
      const parent = cstack[cstack.length - 2];
      fixDoubleBlack(cstack);
      if (parent.left === n) {
        parent.left = void 0;
      } else {
        parent.right = void 0;
      }
    }
  }
  return makeImpl3(ord, cstack[0]);
});
var fixDoubleBlack = (stack) => {
  let n, p, s, z;
  for (let i = stack.length - 1; i >= 0; --i) {
    n = stack[i];
    if (i === 0) {
      n.color = Color.Black;
      return;
    }
    p = stack[i - 1];
    if (p.left === n) {
      s = p.right;
      if (s !== void 0 && s.right !== void 0 && s.right.color === Color.Red) {
        s = p.right = clone(s);
        z = s.right = clone(s.right);
        p.right = s.left;
        s.left = p;
        s.right = z;
        s.color = p.color;
        n.color = Color.Black;
        p.color = Color.Black;
        z.color = Color.Black;
        recount(p);
        recount(s);
        if (i > 1) {
          const pp = stack[i - 2];
          if (pp.left === p) {
            pp.left = s;
          } else {
            pp.right = s;
          }
        }
        stack[i - 1] = s;
        return;
      } else if (s !== void 0 && s.left !== void 0 && s.left.color === Color.Red) {
        s = p.right = clone(s);
        z = s.left = clone(s.left);
        p.right = z.left;
        s.left = z.right;
        z.left = p;
        z.right = s;
        z.color = p.color;
        p.color = Color.Black;
        s.color = Color.Black;
        n.color = Color.Black;
        recount(p);
        recount(s);
        recount(z);
        if (i > 1) {
          const pp = stack[i - 2];
          if (pp.left === p) {
            pp.left = z;
          } else {
            pp.right = z;
          }
        }
        stack[i - 1] = z;
        return;
      }
      if (s !== void 0 && s.color === Color.Black) {
        if (p.color === Color.Red) {
          p.color = Color.Black;
          p.right = repaint(s, Color.Red);
          return;
        } else {
          p.right = repaint(s, Color.Red);
          continue;
        }
      } else if (s !== void 0) {
        s = clone(s);
        p.right = s.left;
        s.left = p;
        s.color = p.color;
        p.color = Color.Red;
        recount(p);
        recount(s);
        if (i > 1) {
          const pp = stack[i - 2];
          if (pp.left === p) {
            pp.left = s;
          } else {
            pp.right = s;
          }
        }
        stack[i - 1] = s;
        stack[i] = p;
        if (i + 1 < stack.length) {
          stack[i + 1] = n;
        } else {
          stack.push(n);
        }
        i = i + 2;
      }
    } else {
      s = p.left;
      if (s !== void 0 && s.left !== void 0 && s.left.color === Color.Red) {
        s = p.left = clone(s);
        z = s.left = clone(s.left);
        p.left = s.right;
        s.right = p;
        s.left = z;
        s.color = p.color;
        n.color = Color.Black;
        p.color = Color.Black;
        z.color = Color.Black;
        recount(p);
        recount(s);
        if (i > 1) {
          const pp = stack[i - 2];
          if (pp.right === p) {
            pp.right = s;
          } else {
            pp.left = s;
          }
        }
        stack[i - 1] = s;
        return;
      } else if (s !== void 0 && s.right !== void 0 && s.right.color === Color.Red) {
        s = p.left = clone(s);
        z = s.right = clone(s.right);
        p.left = z.right;
        s.right = z.left;
        z.right = p;
        z.left = s;
        z.color = p.color;
        p.color = Color.Black;
        s.color = Color.Black;
        n.color = Color.Black;
        recount(p);
        recount(s);
        recount(z);
        if (i > 1) {
          const pp = stack[i - 2];
          if (pp.right === p) {
            pp.right = z;
          } else {
            pp.left = z;
          }
        }
        stack[i - 1] = z;
        return;
      }
      if (s !== void 0 && s.color === Color.Black) {
        if (p.color === Color.Red) {
          p.color = Color.Black;
          p.left = repaint(s, Color.Red);
          return;
        } else {
          p.left = repaint(s, Color.Red);
          continue;
        }
      } else if (s !== void 0) {
        s = clone(s);
        p.left = s.right;
        s.right = p;
        s.color = p.color;
        p.color = Color.Red;
        recount(p);
        recount(s);
        if (i > 1) {
          const pp = stack[i - 2];
          if (pp.right === p) {
            pp.right = s;
          } else {
            pp.left = s;
          }
        }
        stack[i - 1] = s;
        stack[i] = p;
        if (i + 1 < stack.length) {
          stack[i + 1] = n;
        } else {
          stack.push(n);
        }
        i = i + 2;
      }
    }
  }
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/RedBlackTree.js
var has6 = has5;
var insert2 = insert;
var keys4 = keysForward;
var removeFirst2 = removeFirst;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/SortedSet.js
var TypeId12 = /* @__PURE__ */ Symbol.for("effect/SortedSet");
var SortedSetProto = {
  [TypeId12]: {
    _A: (_) => _
  },
  [symbol]() {
    return pipe(hash(this.keyTree), combine(hash(TypeId12)), cached(this));
  },
  [symbol2](that) {
    return isSortedSet(that) && equals(this.keyTree, that.keyTree);
  },
  [Symbol.iterator]() {
    return keys4(this.keyTree);
  },
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "SortedSet",
      values: Array.from(this).map(toJSON)
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var fromTree = (keyTree) => {
  const a = Object.create(SortedSetProto);
  a.keyTree = keyTree;
  return a;
};
var isSortedSet = (u) => hasProperty(u, TypeId12);
var add5 = /* @__PURE__ */ dual(2, (self, value) => has6(self.keyTree, value) ? self : fromTree(insert2(self.keyTree, value, true)));
var remove5 = /* @__PURE__ */ dual(2, (self, value) => fromTree(removeFirst2(self.keyTree, value)));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/supervisor.js
var SupervisorSymbolKey = "effect/Supervisor";
var SupervisorTypeId = /* @__PURE__ */ Symbol.for(SupervisorSymbolKey);
var supervisorVariance = {
  /* c8 ignore next */
  _T: (_) => _
};
var ProxySupervisor = class _ProxySupervisor {
  underlying;
  value0;
  [SupervisorTypeId] = supervisorVariance;
  constructor(underlying, value0) {
    this.underlying = underlying;
    this.value0 = value0;
  }
  get value() {
    return this.value0;
  }
  onStart(context2, effect, parent, fiber) {
    this.underlying.onStart(context2, effect, parent, fiber);
  }
  onEnd(value, fiber) {
    this.underlying.onEnd(value, fiber);
  }
  onEffect(fiber, effect) {
    this.underlying.onEffect(fiber, effect);
  }
  onSuspend(fiber) {
    this.underlying.onSuspend(fiber);
  }
  onResume(fiber) {
    this.underlying.onResume(fiber);
  }
  map(f) {
    return new _ProxySupervisor(this, pipe(this.value, map8(f)));
  }
  zip(right3) {
    return new Zip(this, right3);
  }
};
var Zip = class _Zip {
  left;
  right;
  _tag = "Zip";
  [SupervisorTypeId] = supervisorVariance;
  constructor(left3, right3) {
    this.left = left3;
    this.right = right3;
  }
  get value() {
    return zip2(this.left.value, this.right.value);
  }
  onStart(context2, effect, parent, fiber) {
    this.left.onStart(context2, effect, parent, fiber);
    this.right.onStart(context2, effect, parent, fiber);
  }
  onEnd(value, fiber) {
    this.left.onEnd(value, fiber);
    this.right.onEnd(value, fiber);
  }
  onEffect(fiber, effect) {
    this.left.onEffect(fiber, effect);
    this.right.onEffect(fiber, effect);
  }
  onSuspend(fiber) {
    this.left.onSuspend(fiber);
    this.right.onSuspend(fiber);
  }
  onResume(fiber) {
    this.left.onResume(fiber);
    this.right.onResume(fiber);
  }
  map(f) {
    return new ProxySupervisor(this, pipe(this.value, map8(f)));
  }
  zip(right3) {
    return new _Zip(this, right3);
  }
};
var isZip = (self) => hasProperty(self, SupervisorTypeId) && isTagged(self, "Zip");
var Track = class {
  [SupervisorTypeId] = supervisorVariance;
  fibers = /* @__PURE__ */ new Set();
  get value() {
    return sync(() => Array.from(this.fibers));
  }
  onStart(_context, _effect, _parent, fiber) {
    this.fibers.add(fiber);
  }
  onEnd(_value, fiber) {
    this.fibers.delete(fiber);
  }
  onEffect(_fiber, _effect) {
  }
  onSuspend(_fiber) {
  }
  onResume(_fiber) {
  }
  map(f) {
    return new ProxySupervisor(this, pipe(this.value, map8(f)));
  }
  zip(right3) {
    return new Zip(this, right3);
  }
  onRun(execution, _fiber) {
    return execution();
  }
};
var Const = class {
  effect;
  [SupervisorTypeId] = supervisorVariance;
  constructor(effect) {
    this.effect = effect;
  }
  get value() {
    return this.effect;
  }
  onStart(_context, _effect, _parent, _fiber) {
  }
  onEnd(_value, _fiber) {
  }
  onEffect(_fiber, _effect) {
  }
  onSuspend(_fiber) {
  }
  onResume(_fiber) {
  }
  map(f) {
    return new ProxySupervisor(this, pipe(this.value, map8(f)));
  }
  zip(right3) {
    return new Zip(this, right3);
  }
  onRun(execution, _fiber) {
    return execution();
  }
};
var FibersIn = class {
  ref;
  [SupervisorTypeId] = supervisorVariance;
  constructor(ref) {
    this.ref = ref;
  }
  get value() {
    return sync(() => get6(this.ref));
  }
  onStart(_context, _effect, _parent, fiber) {
    pipe(this.ref, set2(pipe(get6(this.ref), add5(fiber))));
  }
  onEnd(_value, fiber) {
    pipe(this.ref, set2(pipe(get6(this.ref), remove5(fiber))));
  }
  onEffect(_fiber, _effect) {
  }
  onSuspend(_fiber) {
  }
  onResume(_fiber) {
  }
  map(f) {
    return new ProxySupervisor(this, pipe(this.value, map8(f)));
  }
  zip(right3) {
    return new Zip(this, right3);
  }
  onRun(execution, _fiber) {
    return execution();
  }
};
var fromEffect = (effect) => {
  return new Const(effect);
};
var none7 = /* @__PURE__ */ globalValue("effect/Supervisor/none", () => fromEffect(void_));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Differ.js
var make30 = make14;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/supervisor/patch.js
var OP_EMPTY3 = "Empty";
var OP_ADD_SUPERVISOR = "AddSupervisor";
var OP_REMOVE_SUPERVISOR = "RemoveSupervisor";
var OP_AND_THEN2 = "AndThen";
var empty22 = {
  _tag: OP_EMPTY3
};
var combine8 = (self, that) => {
  return {
    _tag: OP_AND_THEN2,
    first: self,
    second: that
  };
};
var patch8 = (self, supervisor) => {
  return patchLoop(supervisor, of2(self));
};
var patchLoop = (_supervisor, _patches) => {
  let supervisor = _supervisor;
  let patches = _patches;
  while (isNonEmpty(patches)) {
    const head4 = headNonEmpty2(patches);
    switch (head4._tag) {
      case OP_EMPTY3: {
        patches = tailNonEmpty2(patches);
        break;
      }
      case OP_ADD_SUPERVISOR: {
        supervisor = supervisor.zip(head4.supervisor);
        patches = tailNonEmpty2(patches);
        break;
      }
      case OP_REMOVE_SUPERVISOR: {
        supervisor = removeSupervisor(supervisor, head4.supervisor);
        patches = tailNonEmpty2(patches);
        break;
      }
      case OP_AND_THEN2: {
        patches = prepend2(head4.first)(prepend2(head4.second)(tailNonEmpty2(patches)));
        break;
      }
    }
  }
  return supervisor;
};
var removeSupervisor = (self, that) => {
  if (equals(self, that)) {
    return none7;
  } else {
    if (isZip(self)) {
      return removeSupervisor(self.left, that).zip(removeSupervisor(self.right, that));
    } else {
      return self;
    }
  }
};
var toSet2 = (self) => {
  if (equals(self, none7)) {
    return empty5();
  } else {
    if (isZip(self)) {
      return pipe(toSet2(self.left), union3(toSet2(self.right)));
    } else {
      return make7(self);
    }
  }
};
var diff7 = (oldValue, newValue) => {
  if (equals(oldValue, newValue)) {
    return empty22;
  }
  const oldSupervisors = toSet2(oldValue);
  const newSupervisors = toSet2(newValue);
  const added = pipe(newSupervisors, difference3(oldSupervisors), reduce4(empty22, (patch9, supervisor) => combine8(patch9, {
    _tag: OP_ADD_SUPERVISOR,
    supervisor
  })));
  const removed = pipe(oldSupervisors, difference3(newSupervisors), reduce4(empty22, (patch9, supervisor) => combine8(patch9, {
    _tag: OP_REMOVE_SUPERVISOR,
    supervisor
  })));
  return combine8(added, removed);
};
var differ2 = /* @__PURE__ */ make30({
  empty: empty22,
  patch: patch8,
  combine: combine8,
  diff: diff7
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/fiberRuntime.js
var fiberStarted = /* @__PURE__ */ counter5("effect_fiber_started", {
  incremental: true
});
var fiberActive = /* @__PURE__ */ counter5("effect_fiber_active");
var fiberSuccesses = /* @__PURE__ */ counter5("effect_fiber_successes", {
  incremental: true
});
var fiberFailures = /* @__PURE__ */ counter5("effect_fiber_failures", {
  incremental: true
});
var fiberLifetimes = /* @__PURE__ */ tagged(/* @__PURE__ */ histogram5("effect_fiber_lifetimes", /* @__PURE__ */ exponential({
  start: 0.5,
  factor: 2,
  count: 35
})), "time_unit", "milliseconds");
var EvaluationSignalContinue = "Continue";
var EvaluationSignalDone = "Done";
var EvaluationSignalYieldNow = "Yield";
var runtimeFiberVariance = {
  /* c8 ignore next */
  _E: (_) => _,
  /* c8 ignore next */
  _A: (_) => _
};
var absurd = (_) => {
  throw new Error(`BUG: FiberRuntime - ${toStringUnknown(_)} - please report an issue at https://github.com/Effect-TS/effect/issues`);
};
var YieldedOp = /* @__PURE__ */ Symbol.for("effect/internal/fiberRuntime/YieldedOp");
var yieldedOpChannel = /* @__PURE__ */ globalValue("effect/internal/fiberRuntime/yieldedOpChannel", () => ({
  currentOp: null
}));
var contOpSuccess = {
  [OP_ON_SUCCESS]: (_, cont, value) => {
    return internalCall(() => cont.effect_instruction_i1(value));
  },
  ["OnStep"]: (_, _cont, value) => {
    return exitSucceed(exitSucceed(value));
  },
  [OP_ON_SUCCESS_AND_FAILURE]: (_, cont, value) => {
    return internalCall(() => cont.effect_instruction_i2(value));
  },
  [OP_REVERT_FLAGS]: (self, cont, value) => {
    self.patchRuntimeFlags(self.currentRuntimeFlags, cont.patch);
    if (interruptible(self.currentRuntimeFlags) && self.isInterrupted()) {
      return exitFailCause(self.getInterruptedCause());
    } else {
      return exitSucceed(value);
    }
  },
  [OP_WHILE]: (self, cont, value) => {
    internalCall(() => cont.effect_instruction_i2(value));
    if (internalCall(() => cont.effect_instruction_i0())) {
      self.pushStack(cont);
      return internalCall(() => cont.effect_instruction_i1());
    } else {
      return void_;
    }
  },
  [OP_ITERATOR]: (self, cont, value) => {
    while (true) {
      const state = internalCall(() => cont.effect_instruction_i0.next(value));
      if (state.done) {
        return exitSucceed(state.value);
      }
      const primitive = yieldWrapGet(state.value);
      if (!exitIsExit(primitive)) {
        self.pushStack(cont);
        return primitive;
      } else if (primitive._tag === "Failure") {
        return primitive;
      }
      value = primitive.value;
    }
  }
};
var drainQueueWhileRunningTable = {
  [OP_INTERRUPT_SIGNAL]: (self, runtimeFlags2, cur, message) => {
    self.processNewInterruptSignal(message.cause);
    return interruptible(runtimeFlags2) ? exitFailCause(message.cause) : cur;
  },
  [OP_RESUME]: (_self, _runtimeFlags, _cur, _message) => {
    throw new Error("It is illegal to have multiple concurrent run loops in a single fiber");
  },
  [OP_STATEFUL]: (self, runtimeFlags2, cur, message) => {
    message.onFiber(self, running2(runtimeFlags2));
    return cur;
  },
  [OP_YIELD_NOW]: (_self, _runtimeFlags, cur, _message) => {
    return flatMap6(yieldNow(), () => cur);
  }
};
var runBlockedRequests = (self) => forEachSequentialDiscard(flatten2(self), (requestsByRequestResolver) => forEachConcurrentDiscard(sequentialCollectionToChunk(requestsByRequestResolver), ([dataSource, sequential4]) => {
  const map12 = /* @__PURE__ */ new Map();
  const arr = [];
  for (const block of sequential4) {
    arr.push(toReadonlyArray(block));
    for (const entry of block) {
      map12.set(entry.request, entry);
    }
  }
  const flat = arr.flat();
  return fiberRefLocally(invokeWithInterrupt(dataSource.runAll(arr), flat, () => flat.forEach((entry) => {
    entry.listeners.interrupted = true;
  })), currentRequestMap, map12);
}, false, false));
var _version = /* @__PURE__ */ getCurrentVersion();
var FiberRuntime = class extends Class2 {
  [FiberTypeId] = fiberVariance2;
  [RuntimeFiberTypeId] = runtimeFiberVariance;
  _fiberRefs;
  _fiberId;
  _queue = /* @__PURE__ */ new Array();
  _children = null;
  _observers = /* @__PURE__ */ new Array();
  _running = false;
  _stack = [];
  _asyncInterruptor = null;
  _asyncBlockingOn = null;
  _exitValue = null;
  _steps = [];
  _isYielding = false;
  currentRuntimeFlags;
  currentOpCount = 0;
  currentSupervisor;
  currentScheduler;
  currentTracer;
  currentSpan;
  currentContext;
  currentDefaultServices;
  constructor(fiberId2, fiberRefs0, runtimeFlags0) {
    super();
    this.currentRuntimeFlags = runtimeFlags0;
    this._fiberId = fiberId2;
    this._fiberRefs = fiberRefs0;
    if (runtimeMetrics(runtimeFlags0)) {
      const tags = this.getFiberRef(currentMetricLabels);
      fiberStarted.unsafeUpdate(1, tags);
      fiberActive.unsafeUpdate(1, tags);
    }
    this.refreshRefCache();
  }
  commit() {
    return join2(this);
  }
  /**
   * The identity of the fiber.
   */
  id() {
    return this._fiberId;
  }
  /**
   * Begins execution of the effect associated with this fiber on in the
   * background. This can be called to "kick off" execution of a fiber after
   * it has been created.
   */
  resume(effect) {
    this.tell(resume(effect));
  }
  /**
   * The status of the fiber.
   */
  get status() {
    return this.ask((_, status2) => status2);
  }
  /**
   * Gets the fiber runtime flags.
   */
  get runtimeFlags() {
    return this.ask((state, status2) => {
      if (isDone2(status2)) {
        return state.currentRuntimeFlags;
      }
      return status2.runtimeFlags;
    });
  }
  /**
   * Returns the current `FiberScope` for the fiber.
   */
  scope() {
    return unsafeMake5(this);
  }
  /**
   * Retrieves the immediate children of the fiber.
   */
  get children() {
    return this.ask((fiber) => Array.from(fiber.getChildren()));
  }
  /**
   * Gets the fiber's set of children.
   */
  getChildren() {
    if (this._children === null) {
      this._children = /* @__PURE__ */ new Set();
    }
    return this._children;
  }
  /**
   * Retrieves the interrupted cause of the fiber, which will be `Cause.empty`
   * if the fiber has not been interrupted.
   *
   * **NOTE**: This method is safe to invoke on any fiber, but if not invoked
   * on this fiber, then values derived from the fiber's state (including the
   * log annotations and log level) may not be up-to-date.
   */
  getInterruptedCause() {
    return this.getFiberRef(currentInterruptedCause);
  }
  /**
   * Retrieves the whole set of fiber refs.
   */
  fiberRefs() {
    return this.ask((fiber) => fiber.getFiberRefs());
  }
  /**
   * Returns an effect that will contain information computed from the fiber
   * state and status while running on the fiber.
   *
   * This allows the outside world to interact safely with mutable fiber state
   * without locks or immutable data.
   */
  ask(f) {
    return suspend(() => {
      const deferred = deferredUnsafeMake(this._fiberId);
      this.tell(stateful((fiber, status2) => {
        deferredUnsafeDone(deferred, sync(() => f(fiber, status2)));
      }));
      return deferredAwait(deferred);
    });
  }
  /**
   * Adds a message to be processed by the fiber on the fiber.
   */
  tell(message) {
    this._queue.push(message);
    if (!this._running) {
      this._running = true;
      this.drainQueueLaterOnExecutor();
    }
  }
  get await() {
    return async_((resume2) => {
      const cb = (exit4) => resume2(succeed(exit4));
      if (this._exitValue !== null) {
        cb(this._exitValue);
        return;
      }
      this.tell(stateful((fiber, _) => {
        if (fiber._exitValue !== null) {
          cb(this._exitValue);
        } else {
          fiber.addObserver(cb);
        }
      }));
      return sync(() => this.tell(stateful((fiber, _) => {
        fiber.removeObserver(cb);
      })));
    }, this.id());
  }
  get inheritAll() {
    return withFiberRuntime((parentFiber, parentStatus) => {
      const parentFiberId = parentFiber.id();
      const parentFiberRefs = parentFiber.getFiberRefs();
      const parentRuntimeFlags = parentStatus.runtimeFlags;
      const childFiberRefs = this.getFiberRefs();
      const updatedFiberRefs = joinAs(parentFiberRefs, parentFiberId, childFiberRefs);
      parentFiber.setFiberRefs(updatedFiberRefs);
      const updatedRuntimeFlags = parentFiber.getFiberRef(currentRuntimeFlags);
      const patch9 = pipe(
        diff4(parentRuntimeFlags, updatedRuntimeFlags),
        // Do not inherit WindDown or Interruption!
        exclude2(Interruption),
        exclude2(WindDown)
      );
      return updateRuntimeFlags(patch9);
    });
  }
  /**
   * Tentatively observes the fiber, but returns immediately if it is not
   * already done.
   */
  get poll() {
    return sync(() => fromNullable(this._exitValue));
  }
  /**
   * Unsafely observes the fiber, but returns immediately if it is not
   * already done.
   */
  unsafePoll() {
    return this._exitValue;
  }
  /**
   * In the background, interrupts the fiber as if interrupted from the specified fiber.
   */
  interruptAsFork(fiberId2) {
    return sync(() => this.tell(interruptSignal(interrupt(fiberId2))));
  }
  /**
   * In the background, interrupts the fiber as if interrupted from the specified fiber.
   */
  unsafeInterruptAsFork(fiberId2) {
    this.tell(interruptSignal(interrupt(fiberId2)));
  }
  /**
   * Adds an observer to the list of observers.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  addObserver(observer) {
    if (this._exitValue !== null) {
      observer(this._exitValue);
    } else {
      this._observers.push(observer);
    }
  }
  /**
   * Removes the specified observer from the list of observers that will be
   * notified when the fiber exits.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  removeObserver(observer) {
    this._observers = this._observers.filter((o) => o !== observer);
  }
  /**
   * Retrieves all fiber refs of the fiber.
   *
   * **NOTE**: This method is safe to invoke on any fiber, but if not invoked
   * on this fiber, then values derived from the fiber's state (including the
   * log annotations and log level) may not be up-to-date.
   */
  getFiberRefs() {
    this.setFiberRef(currentRuntimeFlags, this.currentRuntimeFlags);
    return this._fiberRefs;
  }
  /**
   * Deletes the specified fiber ref.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  unsafeDeleteFiberRef(fiberRef) {
    this._fiberRefs = delete_(this._fiberRefs, fiberRef);
  }
  /**
   * Retrieves the state of the fiber ref, or else its initial value.
   *
   * **NOTE**: This method is safe to invoke on any fiber, but if not invoked
   * on this fiber, then values derived from the fiber's state (including the
   * log annotations and log level) may not be up-to-date.
   */
  getFiberRef(fiberRef) {
    if (this._fiberRefs.locals.has(fiberRef)) {
      return this._fiberRefs.locals.get(fiberRef)[0][1];
    }
    return fiberRef.initial;
  }
  /**
   * Sets the fiber ref to the specified value.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  setFiberRef(fiberRef, value) {
    this._fiberRefs = updateAs(this._fiberRefs, {
      fiberId: this._fiberId,
      fiberRef,
      value
    });
    this.refreshRefCache();
  }
  refreshRefCache() {
    this.currentDefaultServices = this.getFiberRef(currentServices);
    this.currentTracer = this.currentDefaultServices.unsafeMap.get(tracerTag.key);
    this.currentSupervisor = this.getFiberRef(currentSupervisor);
    this.currentScheduler = this.getFiberRef(currentScheduler);
    this.currentContext = this.getFiberRef(currentContext);
    this.currentSpan = this.currentContext.unsafeMap.get(spanTag.key);
  }
  /**
   * Wholesale replaces all fiber refs of this fiber.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  setFiberRefs(fiberRefs3) {
    this._fiberRefs = fiberRefs3;
    this.refreshRefCache();
  }
  /**
   * Adds a reference to the specified fiber inside the children set.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  addChild(child) {
    this.getChildren().add(child);
  }
  /**
   * Removes a reference to the specified fiber inside the children set.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  removeChild(child) {
    this.getChildren().delete(child);
  }
  /**
   * Transfers all children of this fiber that are currently running to the
   * specified fiber scope.
   *
   * **NOTE**: This method must be invoked by the fiber itself after it has
   * evaluated the effects but prior to exiting.
   */
  transferChildren(scope2) {
    const children2 = this._children;
    this._children = null;
    if (children2 !== null && children2.size > 0) {
      for (const child of children2) {
        if (child._exitValue === null) {
          scope2.add(this.currentRuntimeFlags, child);
        }
      }
    }
  }
  /**
   * On the current thread, executes all messages in the fiber's inbox. This
   * method may return before all work is done, in the event the fiber executes
   * an asynchronous operation.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  drainQueueOnCurrentThread() {
    let recurse = true;
    while (recurse) {
      let evaluationSignal = EvaluationSignalContinue;
      const prev = globalThis[currentFiberURI];
      globalThis[currentFiberURI] = this;
      try {
        while (evaluationSignal === EvaluationSignalContinue) {
          evaluationSignal = this._queue.length === 0 ? EvaluationSignalDone : this.evaluateMessageWhileSuspended(this._queue.splice(0, 1)[0]);
        }
      } finally {
        this._running = false;
        globalThis[currentFiberURI] = prev;
      }
      if (this._queue.length > 0 && !this._running) {
        this._running = true;
        if (evaluationSignal === EvaluationSignalYieldNow) {
          this.drainQueueLaterOnExecutor();
          recurse = false;
        } else {
          recurse = true;
        }
      } else {
        recurse = false;
      }
    }
  }
  /**
   * Schedules the execution of all messages in the fiber's inbox.
   *
   * This method will return immediately after the scheduling
   * operation is completed, but potentially before such messages have been
   * executed.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  drainQueueLaterOnExecutor() {
    this.currentScheduler.scheduleTask(this.run, this.getFiberRef(currentSchedulingPriority), this);
  }
  /**
   * Drains the fiber's message queue while the fiber is actively running,
   * returning the next effect to execute, which may be the input effect if no
   * additional effect needs to be executed.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  drainQueueWhileRunning(runtimeFlags2, cur0) {
    let cur = cur0;
    while (this._queue.length > 0) {
      const message = this._queue.splice(0, 1)[0];
      cur = drainQueueWhileRunningTable[message._tag](this, runtimeFlags2, cur, message);
    }
    return cur;
  }
  /**
   * Determines if the fiber is interrupted.
   *
   * **NOTE**: This method is safe to invoke on any fiber, but if not invoked
   * on this fiber, then values derived from the fiber's state (including the
   * log annotations and log level) may not be up-to-date.
   */
  isInterrupted() {
    return !isEmpty3(this.getFiberRef(currentInterruptedCause));
  }
  /**
   * Adds an interruptor to the set of interruptors that are interrupting this
   * fiber.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  addInterruptedCause(cause2) {
    const oldSC = this.getFiberRef(currentInterruptedCause);
    this.setFiberRef(currentInterruptedCause, sequential(oldSC, cause2));
  }
  /**
   * Processes a new incoming interrupt signal.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  processNewInterruptSignal(cause2) {
    this.addInterruptedCause(cause2);
    this.sendInterruptSignalToAllChildren();
  }
  /**
   * Interrupts all children of the current fiber, returning an effect that will
   * await the exit of the children. This method will return null if the fiber
   * has no children.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  sendInterruptSignalToAllChildren() {
    if (this._children === null || this._children.size === 0) {
      return false;
    }
    let told = false;
    for (const child of this._children) {
      child.tell(interruptSignal(interrupt(this.id())));
      told = true;
    }
    return told;
  }
  /**
   * Interrupts all children of the current fiber, returning an effect that will
   * await the exit of the children. This method will return null if the fiber
   * has no children.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  interruptAllChildren() {
    if (this.sendInterruptSignalToAllChildren()) {
      const it = this._children.values();
      this._children = null;
      let isDone3 = false;
      const body = () => {
        const next = it.next();
        if (!next.done) {
          return asVoid(next.value.await);
        } else {
          return sync(() => {
            isDone3 = true;
          });
        }
      };
      return whileLoop({
        while: () => !isDone3,
        body,
        step: () => {
        }
      });
    }
    return null;
  }
  reportExitValue(exit4) {
    if (runtimeMetrics(this.currentRuntimeFlags)) {
      const tags = this.getFiberRef(currentMetricLabels);
      const startTimeMillis = this.id().startTimeMillis;
      const endTimeMillis = Date.now();
      fiberLifetimes.unsafeUpdate(endTimeMillis - startTimeMillis, tags);
      fiberActive.unsafeUpdate(-1, tags);
      switch (exit4._tag) {
        case OP_SUCCESS: {
          fiberSuccesses.unsafeUpdate(1, tags);
          break;
        }
        case OP_FAILURE: {
          fiberFailures.unsafeUpdate(1, tags);
          break;
        }
      }
    }
    if (exit4._tag === "Failure") {
      const level = this.getFiberRef(currentUnhandledErrorLogLevel);
      if (!isInterruptedOnly(exit4.cause) && level._tag === "Some") {
        this.log("Fiber terminated with an unhandled error", exit4.cause, level);
      }
    }
  }
  setExitValue(exit4) {
    this._exitValue = exit4;
    this.reportExitValue(exit4);
    for (let i = this._observers.length - 1; i >= 0; i--) {
      this._observers[i](exit4);
    }
    this._observers = [];
  }
  getLoggers() {
    return this.getFiberRef(currentLoggers);
  }
  log(message, cause2, overrideLogLevel) {
    const logLevel = isSome2(overrideLogLevel) ? overrideLogLevel.value : this.getFiberRef(currentLogLevel);
    const minimumLogLevel = this.getFiberRef(currentMinimumLogLevel);
    if (greaterThan2(minimumLogLevel, logLevel)) {
      return;
    }
    const spans = this.getFiberRef(currentLogSpan);
    const annotations = this.getFiberRef(currentLogAnnotations);
    const loggers = this.getLoggers();
    const contextMap = this.getFiberRefs();
    if (size3(loggers) > 0) {
      const clockService = get5(this.getFiberRef(currentServices), clockTag);
      const date = new Date(clockService.unsafeCurrentTimeMillis());
      withRedactableContext(contextMap, () => {
        for (const logger of loggers) {
          logger.log({
            fiberId: this.id(),
            logLevel,
            message,
            cause: cause2,
            context: contextMap,
            spans,
            annotations,
            date
          });
        }
      });
    }
  }
  /**
   * Evaluates a single message on the current thread, while the fiber is
   * suspended. This method should only be called while evaluation of the
   * fiber's effect is suspended due to an asynchronous operation.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  evaluateMessageWhileSuspended(message) {
    switch (message._tag) {
      case OP_YIELD_NOW: {
        return EvaluationSignalYieldNow;
      }
      case OP_INTERRUPT_SIGNAL: {
        this.processNewInterruptSignal(message.cause);
        if (this._asyncInterruptor !== null) {
          this._asyncInterruptor(exitFailCause(message.cause));
          this._asyncInterruptor = null;
        }
        return EvaluationSignalContinue;
      }
      case OP_RESUME: {
        this._asyncInterruptor = null;
        this._asyncBlockingOn = null;
        this.evaluateEffect(message.effect);
        return EvaluationSignalContinue;
      }
      case OP_STATEFUL: {
        message.onFiber(this, this._exitValue !== null ? done3 : suspended2(this.currentRuntimeFlags, this._asyncBlockingOn));
        return EvaluationSignalContinue;
      }
      default: {
        return absurd(message);
      }
    }
  }
  /**
   * Evaluates an effect until completion, potentially asynchronously.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  evaluateEffect(effect0) {
    this.currentSupervisor.onResume(this);
    try {
      let effect = interruptible(this.currentRuntimeFlags) && this.isInterrupted() ? exitFailCause(this.getInterruptedCause()) : effect0;
      while (effect !== null) {
        const eff = effect;
        const exit4 = this.runLoop(eff);
        if (exit4 === YieldedOp) {
          const op = yieldedOpChannel.currentOp;
          yieldedOpChannel.currentOp = null;
          if (op._op === OP_YIELD) {
            if (cooperativeYielding(this.currentRuntimeFlags)) {
              this.tell(yieldNow3());
              this.tell(resume(exitVoid));
              effect = null;
            } else {
              effect = exitVoid;
            }
          } else if (op._op === OP_ASYNC) {
            effect = null;
          }
        } else {
          this.currentRuntimeFlags = pipe(this.currentRuntimeFlags, enable2(WindDown));
          const interruption2 = this.interruptAllChildren();
          if (interruption2 !== null) {
            effect = flatMap6(interruption2, () => exit4);
          } else {
            if (this._queue.length === 0) {
              this.setExitValue(exit4);
            } else {
              this.tell(resume(exit4));
            }
            effect = null;
          }
        }
      }
    } finally {
      this.currentSupervisor.onSuspend(this);
    }
  }
  /**
   * Begins execution of the effect associated with this fiber on the current
   * thread. This can be called to "kick off" execution of a fiber after it has
   * been created, in hopes that the effect can be executed synchronously.
   *
   * This is not the normal way of starting a fiber, but it is useful when the
   * express goal of executing the fiber is to synchronously produce its exit.
   */
  start(effect) {
    if (!this._running) {
      this._running = true;
      const prev = globalThis[currentFiberURI];
      globalThis[currentFiberURI] = this;
      try {
        this.evaluateEffect(effect);
      } finally {
        this._running = false;
        globalThis[currentFiberURI] = prev;
        if (this._queue.length > 0) {
          this.drainQueueLaterOnExecutor();
        }
      }
    } else {
      this.tell(resume(effect));
    }
  }
  /**
   * Begins execution of the effect associated with this fiber on in the
   * background, and on the correct thread pool. This can be called to "kick
   * off" execution of a fiber after it has been created, in hopes that the
   * effect can be executed synchronously.
   */
  startFork(effect) {
    this.tell(resume(effect));
  }
  /**
   * Takes the current runtime flags, patches them to return the new runtime
   * flags, and then makes any changes necessary to fiber state based on the
   * specified patch.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  patchRuntimeFlags(oldRuntimeFlags, patch9) {
    const newRuntimeFlags = patch4(oldRuntimeFlags, patch9);
    globalThis[currentFiberURI] = this;
    this.currentRuntimeFlags = newRuntimeFlags;
    return newRuntimeFlags;
  }
  /**
   * Initiates an asynchronous operation, by building a callback that will
   * resume execution, and then feeding that callback to the registration
   * function, handling error cases and repeated resumptions appropriately.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  initiateAsync(runtimeFlags2, asyncRegister) {
    let alreadyCalled = false;
    const callback = (effect) => {
      if (!alreadyCalled) {
        alreadyCalled = true;
        this.tell(resume(effect));
      }
    };
    if (interruptible(runtimeFlags2)) {
      this._asyncInterruptor = callback;
    }
    try {
      asyncRegister(callback);
    } catch (e) {
      callback(failCause(die(e)));
    }
  }
  pushStack(cont) {
    this._stack.push(cont);
    if (cont._op === "OnStep") {
      this._steps.push({
        refs: this.getFiberRefs(),
        flags: this.currentRuntimeFlags
      });
    }
  }
  popStack() {
    const item = this._stack.pop();
    if (item) {
      if (item._op === "OnStep") {
        this._steps.pop();
      }
      return item;
    }
    return;
  }
  getNextSuccessCont() {
    let frame = this.popStack();
    while (frame) {
      if (frame._op !== OP_ON_FAILURE) {
        return frame;
      }
      frame = this.popStack();
    }
  }
  getNextFailCont() {
    let frame = this.popStack();
    while (frame) {
      if (frame._op !== OP_ON_SUCCESS && frame._op !== OP_WHILE && frame._op !== OP_ITERATOR) {
        return frame;
      }
      frame = this.popStack();
    }
  }
  [OP_TAG](op) {
    return sync(() => unsafeGet4(this.currentContext, op));
  }
  ["Left"](op) {
    return fail2(op.left);
  }
  ["None"](_) {
    return fail2(new NoSuchElementException());
  }
  ["Right"](op) {
    return exitSucceed(op.right);
  }
  ["Some"](op) {
    return exitSucceed(op.value);
  }
  ["Micro"](op) {
    return unsafeAsync((microResume) => {
      let resume2 = microResume;
      const fiber = runFork(provideContext2(op, this.currentContext));
      fiber.addObserver((exit4) => {
        if (exit4._tag === "Success") {
          return resume2(exitSucceed(exit4.value));
        }
        switch (exit4.cause._tag) {
          case "Interrupt": {
            return resume2(exitFailCause(interrupt(none4)));
          }
          case "Fail": {
            return resume2(fail2(exit4.cause.error));
          }
          case "Die": {
            return resume2(die2(exit4.cause.defect));
          }
        }
      });
      return unsafeAsync((abortResume) => {
        resume2 = (_) => {
          abortResume(void_);
        };
        fiber.unsafeInterrupt();
      });
    });
  }
  [OP_SYNC](op) {
    const value = internalCall(() => op.effect_instruction_i0());
    const cont = this.getNextSuccessCont();
    if (cont !== void 0) {
      if (!(cont._op in contOpSuccess)) {
        absurd(cont);
      }
      return contOpSuccess[cont._op](this, cont, value);
    } else {
      yieldedOpChannel.currentOp = exitSucceed(value);
      return YieldedOp;
    }
  }
  [OP_SUCCESS](op) {
    const oldCur = op;
    const cont = this.getNextSuccessCont();
    if (cont !== void 0) {
      if (!(cont._op in contOpSuccess)) {
        absurd(cont);
      }
      return contOpSuccess[cont._op](this, cont, oldCur.effect_instruction_i0);
    } else {
      yieldedOpChannel.currentOp = oldCur;
      return YieldedOp;
    }
  }
  [OP_FAILURE](op) {
    const cause2 = op.effect_instruction_i0;
    const cont = this.getNextFailCont();
    if (cont !== void 0) {
      switch (cont._op) {
        case OP_ON_FAILURE:
        case OP_ON_SUCCESS_AND_FAILURE: {
          if (!(interruptible(this.currentRuntimeFlags) && this.isInterrupted())) {
            return internalCall(() => cont.effect_instruction_i1(cause2));
          } else {
            return exitFailCause(stripFailures(cause2));
          }
        }
        case "OnStep": {
          if (!(interruptible(this.currentRuntimeFlags) && this.isInterrupted())) {
            return exitSucceed(exitFailCause(cause2));
          } else {
            return exitFailCause(stripFailures(cause2));
          }
        }
        case OP_REVERT_FLAGS: {
          this.patchRuntimeFlags(this.currentRuntimeFlags, cont.patch);
          if (interruptible(this.currentRuntimeFlags) && this.isInterrupted()) {
            return exitFailCause(sequential(cause2, this.getInterruptedCause()));
          } else {
            return exitFailCause(cause2);
          }
        }
        default: {
          absurd(cont);
        }
      }
    } else {
      yieldedOpChannel.currentOp = exitFailCause(cause2);
      return YieldedOp;
    }
  }
  [OP_WITH_RUNTIME](op) {
    return internalCall(() => op.effect_instruction_i0(this, running2(this.currentRuntimeFlags)));
  }
  ["Blocked"](op) {
    const refs = this.getFiberRefs();
    const flags = this.currentRuntimeFlags;
    if (this._steps.length > 0) {
      const frames = [];
      const snap = this._steps[this._steps.length - 1];
      let frame = this.popStack();
      while (frame && frame._op !== "OnStep") {
        frames.push(frame);
        frame = this.popStack();
      }
      this.setFiberRefs(snap.refs);
      this.currentRuntimeFlags = snap.flags;
      const patchRefs = diff6(snap.refs, refs);
      const patchFlags = diff4(snap.flags, flags);
      return exitSucceed(blocked(op.effect_instruction_i0, withFiberRuntime((newFiber) => {
        while (frames.length > 0) {
          newFiber.pushStack(frames.pop());
        }
        newFiber.setFiberRefs(patch7(newFiber.id(), newFiber.getFiberRefs())(patchRefs));
        newFiber.currentRuntimeFlags = patch4(patchFlags)(newFiber.currentRuntimeFlags);
        return op.effect_instruction_i1;
      })));
    }
    return uninterruptibleMask((restore) => flatMap6(forkDaemon(runRequestBlock(op.effect_instruction_i0)), () => restore(op.effect_instruction_i1)));
  }
  ["RunBlocked"](op) {
    return runBlockedRequests(op.effect_instruction_i0);
  }
  [OP_UPDATE_RUNTIME_FLAGS](op) {
    const updateFlags = op.effect_instruction_i0;
    const oldRuntimeFlags = this.currentRuntimeFlags;
    const newRuntimeFlags = patch4(oldRuntimeFlags, updateFlags);
    if (interruptible(newRuntimeFlags) && this.isInterrupted()) {
      return exitFailCause(this.getInterruptedCause());
    } else {
      this.patchRuntimeFlags(this.currentRuntimeFlags, updateFlags);
      if (op.effect_instruction_i1) {
        const revertFlags = diff4(newRuntimeFlags, oldRuntimeFlags);
        this.pushStack(new RevertFlags(revertFlags, op));
        return internalCall(() => op.effect_instruction_i1(oldRuntimeFlags));
      } else {
        return exitVoid;
      }
    }
  }
  [OP_ON_SUCCESS](op) {
    this.pushStack(op);
    return op.effect_instruction_i0;
  }
  ["OnStep"](op) {
    this.pushStack(op);
    return op.effect_instruction_i0;
  }
  [OP_ON_FAILURE](op) {
    this.pushStack(op);
    return op.effect_instruction_i0;
  }
  [OP_ON_SUCCESS_AND_FAILURE](op) {
    this.pushStack(op);
    return op.effect_instruction_i0;
  }
  [OP_ASYNC](op) {
    this._asyncBlockingOn = op.effect_instruction_i1;
    this.initiateAsync(this.currentRuntimeFlags, op.effect_instruction_i0);
    yieldedOpChannel.currentOp = op;
    return YieldedOp;
  }
  [OP_YIELD](op) {
    this._isYielding = false;
    yieldedOpChannel.currentOp = op;
    return YieldedOp;
  }
  [OP_WHILE](op) {
    const check = op.effect_instruction_i0;
    const body = op.effect_instruction_i1;
    if (check()) {
      this.pushStack(op);
      return body();
    } else {
      return exitVoid;
    }
  }
  [OP_ITERATOR](op) {
    return contOpSuccess[OP_ITERATOR](this, op, void 0);
  }
  [OP_COMMIT](op) {
    return internalCall(() => op.commit());
  }
  /**
   * The main run-loop for evaluating effects.
   *
   * **NOTE**: This method must be invoked by the fiber itself.
   */
  runLoop(effect0) {
    let cur = effect0;
    this.currentOpCount = 0;
    while (true) {
      if ((this.currentRuntimeFlags & OpSupervision) !== 0) {
        this.currentSupervisor.onEffect(this, cur);
      }
      if (this._queue.length > 0) {
        cur = this.drainQueueWhileRunning(this.currentRuntimeFlags, cur);
      }
      if (!this._isYielding) {
        this.currentOpCount += 1;
        const shouldYield = this.currentScheduler.shouldYield(this);
        if (shouldYield !== false) {
          this._isYielding = true;
          this.currentOpCount = 0;
          const oldCur = cur;
          cur = flatMap6(yieldNow({
            priority: shouldYield
          }), () => oldCur);
        }
      }
      try {
        cur = this.currentTracer.context(() => {
          if (_version !== cur[EffectTypeId2]._V) {
            const level = this.getFiberRef(currentVersionMismatchErrorLogLevel);
            if (level._tag === "Some") {
              const effectVersion = cur[EffectTypeId2]._V;
              this.log(`Executing an Effect versioned ${effectVersion} with a Runtime of version ${getCurrentVersion()}, you may want to dedupe the effect dependencies, you can use the language service plugin to detect this at compile time: https://github.com/Effect-TS/language-service`, empty6, level);
            }
          }
          return this[cur._op](cur);
        }, this);
        if (cur === YieldedOp) {
          const op = yieldedOpChannel.currentOp;
          if (op._op === OP_YIELD || op._op === OP_ASYNC) {
            return YieldedOp;
          }
          yieldedOpChannel.currentOp = null;
          return op._op === OP_SUCCESS || op._op === OP_FAILURE ? op : exitFailCause(die(op));
        }
      } catch (e) {
        if (cur !== YieldedOp && !hasProperty(cur, "_op") || !(cur._op in this)) {
          cur = dieMessage(`Not a valid effect: ${toStringUnknown(cur)}`);
        } else if (isInterruptedException(e)) {
          cur = exitFailCause(sequential(die(e), interrupt(none4)));
        } else {
          cur = die2(e);
        }
      }
    }
  }
  run = () => {
    this.drainQueueOnCurrentThread();
  };
};
var currentMinimumLogLevel = /* @__PURE__ */ globalValue("effect/FiberRef/currentMinimumLogLevel", () => fiberRefUnsafeMake(fromLiteral("Info")));
var loggerWithConsoleLog = (self) => makeLogger((opts) => {
  const services = getOrDefault2(opts.context, currentServices);
  get5(services, consoleTag).unsafe.log(self.log(opts));
});
var defaultLogger = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/Logger/defaultLogger"), () => loggerWithConsoleLog(stringLogger));
var tracerLogger = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/Logger/tracerLogger"), () => makeLogger(({
  annotations,
  cause: cause2,
  context: context2,
  fiberId: fiberId2,
  logLevel,
  message
}) => {
  const span2 = filterDisablePropagation(getOption2(getOrDefault(context2, currentContext), spanTag));
  if (span2._tag === "None" || span2.value._tag === "ExternalSpan") {
    return;
  }
  const clockService = unsafeGet4(getOrDefault(context2, currentServices), clockTag);
  const attributes = {};
  for (const [key, value] of annotations) {
    attributes[key] = value;
  }
  attributes["effect.fiberId"] = threadName2(fiberId2);
  attributes["effect.logLevel"] = logLevel.label;
  if (cause2 !== null && cause2._tag !== "Empty") {
    attributes["effect.cause"] = pretty(cause2, {
      renderErrorCause: true
    });
  }
  span2.value.event(toStringUnknown(Array.isArray(message) && message.length === 1 ? message[0] : message), clockService.unsafeCurrentTimeNanos(), attributes);
}));
var currentLoggers = /* @__PURE__ */ globalValue(/* @__PURE__ */ Symbol.for("effect/FiberRef/currentLoggers"), () => fiberRefUnsafeMakeHashSet(make7(defaultLogger, tracerLogger)));
var acquireRelease = /* @__PURE__ */ dual((args2) => isEffect(args2[0]), (acquire, release) => uninterruptible(tap(acquire, (a) => addFinalizer((exit4) => release(a, exit4)))));
var addFinalizer = (finalizer) => withFiberRuntime((runtime3) => {
  const acquireRefs = runtime3.getFiberRefs();
  const acquireFlags = disable2(runtime3.currentRuntimeFlags, Interruption);
  return flatMap6(scope, (scope2) => scopeAddFinalizerExit(scope2, (exit4) => withFiberRuntime((runtimeFinalizer) => {
    const preRefs = runtimeFinalizer.getFiberRefs();
    const preFlags = runtimeFinalizer.currentRuntimeFlags;
    const patchRefs = diff6(preRefs, acquireRefs);
    const patchFlags = diff4(preFlags, acquireFlags);
    const inverseRefs = diff6(acquireRefs, preRefs);
    runtimeFinalizer.setFiberRefs(patch7(patchRefs, runtimeFinalizer.id(), acquireRefs));
    return ensuring(withRuntimeFlags(finalizer(exit4), patchFlags), sync(() => {
      runtimeFinalizer.setFiberRefs(patch7(inverseRefs, runtimeFinalizer.id(), runtimeFinalizer.getFiberRefs()));
    }));
  })));
});
var allResolveInput = (input) => {
  if (Array.isArray(input) || isIterable(input)) {
    return [input, none2()];
  }
  const keys5 = Object.keys(input);
  const size8 = keys5.length;
  return [keys5.map((k) => input[k]), some2((values3) => {
    const res = {};
    for (let i = 0; i < size8; i++) {
      ;
      res[keys5[i]] = values3[i];
    }
    return res;
  })];
};
var allValidate = (effects, reconcile, options) => {
  const eitherEffects = [];
  for (const effect of effects) {
    eitherEffects.push(either2(effect));
  }
  return flatMap6(forEach6(eitherEffects, identity, {
    concurrency: options?.concurrency,
    batching: options?.batching,
    concurrentFinalizers: options?.concurrentFinalizers
  }), (eithers) => {
    const none9 = none2();
    const size8 = eithers.length;
    const errors = new Array(size8);
    const successes = new Array(size8);
    let errored = false;
    for (let i = 0; i < size8; i++) {
      const either4 = eithers[i];
      if (either4._tag === "Left") {
        errors[i] = some2(either4.left);
        errored = true;
      } else {
        successes[i] = either4.right;
        errors[i] = none9;
      }
    }
    if (errored) {
      return reconcile._tag === "Some" ? fail2(reconcile.value(errors)) : fail2(errors);
    } else if (options?.discard) {
      return void_;
    }
    return reconcile._tag === "Some" ? succeed(reconcile.value(successes)) : succeed(successes);
  });
};
var allEither = (effects, reconcile, options) => {
  const eitherEffects = [];
  for (const effect of effects) {
    eitherEffects.push(either2(effect));
  }
  if (options?.discard) {
    return forEach6(eitherEffects, identity, {
      concurrency: options?.concurrency,
      batching: options?.batching,
      discard: true,
      concurrentFinalizers: options?.concurrentFinalizers
    });
  }
  return map8(forEach6(eitherEffects, identity, {
    concurrency: options?.concurrency,
    batching: options?.batching,
    concurrentFinalizers: options?.concurrentFinalizers
  }), (eithers) => reconcile._tag === "Some" ? reconcile.value(eithers) : eithers);
};
var all2 = (arg, options) => {
  const [effects, reconcile] = allResolveInput(arg);
  if (options?.mode === "validate") {
    return allValidate(effects, reconcile, options);
  } else if (options?.mode === "either") {
    return allEither(effects, reconcile, options);
  }
  return options?.discard !== true && reconcile._tag === "Some" ? map8(forEach6(effects, identity, options), reconcile.value) : forEach6(effects, identity, options);
};
var forEach6 = /* @__PURE__ */ dual((args2) => isIterable(args2[0]), (self, f, options) => withFiberRuntime((r) => {
  const isRequestBatchingEnabled = options?.batching === true || options?.batching === "inherit" && r.getFiberRef(currentRequestBatching);
  if (options?.discard) {
    return match7(options.concurrency, () => finalizersMaskInternal(sequential3, options?.concurrentFinalizers)((restore) => isRequestBatchingEnabled ? forEachConcurrentDiscard(self, (a, i) => restore(f(a, i)), true, false, 1) : forEachSequentialDiscard(self, (a, i) => restore(f(a, i)))), () => finalizersMaskInternal(parallel3, options?.concurrentFinalizers)((restore) => forEachConcurrentDiscard(self, (a, i) => restore(f(a, i)), isRequestBatchingEnabled, false)), (n) => finalizersMaskInternal(parallelN2(n), options?.concurrentFinalizers)((restore) => forEachConcurrentDiscard(self, (a, i) => restore(f(a, i)), isRequestBatchingEnabled, false, n)));
  }
  return match7(options?.concurrency, () => finalizersMaskInternal(sequential3, options?.concurrentFinalizers)((restore) => isRequestBatchingEnabled ? forEachParN(self, 1, (a, i) => restore(f(a, i)), true) : forEachSequential(self, (a, i) => restore(f(a, i)))), () => finalizersMaskInternal(parallel3, options?.concurrentFinalizers)((restore) => forEachParUnbounded(self, (a, i) => restore(f(a, i)), isRequestBatchingEnabled)), (n) => finalizersMaskInternal(parallelN2(n), options?.concurrentFinalizers)((restore) => forEachParN(self, n, (a, i) => restore(f(a, i)), isRequestBatchingEnabled)));
}));
var forEachParUnbounded = (self, f, batching) => suspend(() => {
  const as5 = fromIterable(self);
  const array3 = new Array(as5.length);
  const fn = (a, i) => flatMap6(f(a, i), (b) => sync(() => array3[i] = b));
  return zipRight(forEachConcurrentDiscard(as5, fn, batching, false), succeed(array3));
});
var forEachConcurrentDiscard = (self, f, batching, processAll, n) => uninterruptibleMask((restore) => transplant((graft) => withFiberRuntime((parent) => {
  let todos = Array.from(self).reverse();
  let target = todos.length;
  if (target === 0) {
    return void_;
  }
  let counter6 = 0;
  let interrupted2 = false;
  const fibersCount = n ? Math.min(todos.length, n) : todos.length;
  const fibers = /* @__PURE__ */ new Set();
  const results = new Array();
  const interruptAll2 = () => fibers.forEach((fiber) => {
    fiber.currentScheduler.scheduleTask(() => {
      fiber.unsafeInterruptAsFork(parent.id());
    }, 0, fiber);
  });
  const startOrder = new Array();
  const joinOrder = new Array();
  const residual = new Array();
  const collectExits = () => {
    const exits = results.filter(({
      exit: exit4
    }) => exit4._tag === "Failure").sort((a, b) => a.index < b.index ? -1 : a.index === b.index ? 0 : 1).map(({
      exit: exit4
    }) => exit4);
    if (exits.length === 0) {
      exits.push(exitVoid);
    }
    return exits;
  };
  const runFiber = (eff, interruptImmediately = false) => {
    const runnable = uninterruptible(graft(eff));
    const fiber = unsafeForkUnstarted(runnable, parent, parent.currentRuntimeFlags, globalScope);
    parent.currentScheduler.scheduleTask(() => {
      if (interruptImmediately) {
        fiber.unsafeInterruptAsFork(parent.id());
      }
      fiber.resume(runnable);
    }, 0, fiber);
    return fiber;
  };
  const onInterruptSignal = () => {
    if (!processAll) {
      target -= todos.length;
      todos = [];
    }
    interrupted2 = true;
    interruptAll2();
  };
  const stepOrExit = batching ? step2 : exit;
  const processingFiber = runFiber(async_((resume2) => {
    const pushResult = (res, index) => {
      if (res._op === "Blocked") {
        residual.push(res);
      } else {
        results.push({
          index,
          exit: res
        });
        if (res._op === "Failure" && !interrupted2) {
          onInterruptSignal();
        }
      }
    };
    const next = () => {
      if (todos.length > 0) {
        const a = todos.pop();
        let index = counter6++;
        const returnNextElement = () => {
          const a2 = todos.pop();
          index = counter6++;
          return flatMap6(yieldNow(), () => flatMap6(stepOrExit(restore(f(a2, index))), onRes));
        };
        const onRes = (res) => {
          if (todos.length > 0) {
            pushResult(res, index);
            if (todos.length > 0) {
              return returnNextElement();
            }
          }
          return succeed(res);
        };
        const todo = flatMap6(stepOrExit(restore(f(a, index))), onRes);
        const fiber = runFiber(todo);
        startOrder.push(fiber);
        fibers.add(fiber);
        if (interrupted2) {
          fiber.currentScheduler.scheduleTask(() => {
            fiber.unsafeInterruptAsFork(parent.id());
          }, 0, fiber);
        }
        fiber.addObserver((wrapped) => {
          let exit4;
          if (wrapped._op === "Failure") {
            exit4 = wrapped;
          } else {
            exit4 = wrapped.effect_instruction_i0;
          }
          joinOrder.push(fiber);
          fibers.delete(fiber);
          pushResult(exit4, index);
          if (results.length === target) {
            resume2(succeed(getOrElse(exitCollectAll(collectExits(), {
              parallel: true
            }), () => exitVoid)));
          } else if (residual.length + results.length === target) {
            const exits = collectExits();
            const requests = residual.map((blocked2) => blocked2.effect_instruction_i0).reduce(par);
            resume2(succeed(blocked(requests, forEachConcurrentDiscard([getOrElse(exitCollectAll(exits, {
              parallel: true
            }), () => exitVoid), ...residual.map((blocked2) => blocked2.effect_instruction_i1)], (i) => i, batching, true, n))));
          } else {
            next();
          }
        });
      }
    };
    for (let i = 0; i < fibersCount; i++) {
      next();
    }
  }));
  return asVoid(onExit(flatten3(restore(join2(processingFiber))), exitMatch({
    onFailure: (cause2) => {
      onInterruptSignal();
      const target2 = residual.length + 1;
      const concurrency = Math.min(typeof n === "number" ? n : residual.length, residual.length);
      const toPop = Array.from(residual);
      return async_((cb) => {
        const exits = [];
        let count = 0;
        let index = 0;
        const check = (index2, hitNext) => (exit4) => {
          exits[index2] = exit4;
          count++;
          if (count === target2) {
            cb(exitSucceed(exitFailCause(cause2)));
          }
          if (toPop.length > 0 && hitNext) {
            next();
          }
        };
        const next = () => {
          runFiber(toPop.pop(), true).addObserver(check(index, true));
          index++;
        };
        processingFiber.addObserver(check(index, false));
        index++;
        for (let i = 0; i < concurrency; i++) {
          next();
        }
      });
    },
    onSuccess: () => forEachSequential(joinOrder, (f2) => f2.inheritAll)
  })));
})));
var forEachParN = (self, n, f, batching) => suspend(() => {
  const as5 = fromIterable(self);
  const array3 = new Array(as5.length);
  const fn = (a, i) => map8(f(a, i), (b) => array3[i] = b);
  return zipRight(forEachConcurrentDiscard(as5, fn, batching, false, n), succeed(array3));
});
var forkDaemon = (self) => forkWithScopeOverride(self, globalScope);
var unsafeFork2 = (effect, parentFiber, parentRuntimeFlags, overrideScope = null) => {
  const childFiber = unsafeMakeChildFiber(effect, parentFiber, parentRuntimeFlags, overrideScope);
  childFiber.resume(effect);
  return childFiber;
};
var unsafeForkUnstarted = (effect, parentFiber, parentRuntimeFlags, overrideScope = null) => {
  const childFiber = unsafeMakeChildFiber(effect, parentFiber, parentRuntimeFlags, overrideScope);
  return childFiber;
};
var unsafeMakeChildFiber = (effect, parentFiber, parentRuntimeFlags, overrideScope = null) => {
  const childId = unsafeMake2();
  const parentFiberRefs = parentFiber.getFiberRefs();
  const childFiberRefs = forkAs(parentFiberRefs, childId);
  const childFiber = new FiberRuntime(childId, childFiberRefs, parentRuntimeFlags);
  const childContext = getOrDefault(childFiberRefs, currentContext);
  const supervisor = childFiber.currentSupervisor;
  supervisor.onStart(childContext, effect, some2(parentFiber), childFiber);
  childFiber.addObserver((exit4) => supervisor.onEnd(exit4, childFiber));
  const parentScope = overrideScope !== null ? overrideScope : pipe(parentFiber.getFiberRef(currentForkScopeOverride), getOrElse(() => parentFiber.scope()));
  parentScope.add(parentRuntimeFlags, childFiber);
  return childFiber;
};
var forkWithScopeOverride = (self, scopeOverride) => withFiberRuntime((parentFiber, parentStatus) => succeed(unsafeFork2(self, parentFiber, parentStatus.runtimeFlags, scopeOverride)));
var raceAll = (all4) => withFiberRuntime((state, status2) => async_((resume2) => {
  const fibers = /* @__PURE__ */ new Set();
  let winner;
  let failures2 = empty6;
  const interruptAll2 = () => {
    for (const fiber of fibers) {
      fiber.unsafeInterruptAsFork(state.id());
    }
  };
  let latch = false;
  let empty25 = true;
  for (const self of all4) {
    empty25 = false;
    const fiber = unsafeFork2(interruptible2(self), state, status2.runtimeFlags);
    fibers.add(fiber);
    fiber.addObserver((exit4) => {
      fibers.delete(fiber);
      if (!winner) {
        if (exit4._tag === "Success") {
          latch = true;
          winner = fiber;
          failures2 = empty6;
          interruptAll2();
        } else {
          failures2 = parallel(exit4.cause, failures2);
        }
      }
      if (latch && fibers.size === 0) {
        resume2(winner ? zipRight(inheritAll(winner), winner.unsafePoll()) : failCause(failures2));
      }
    });
    if (winner) break;
  }
  if (empty25) {
    return resume2(dieSync(() => new IllegalArgumentException(`Received an empty collection of effects`)));
  }
  latch = true;
  return interruptAllAs(fibers, state.id());
}));
var parallelFinalizers = (self) => contextWithEffect((context2) => match2(getOption2(context2, scopeTag), {
  onNone: () => self,
  onSome: (scope2) => {
    switch (scope2.strategy._tag) {
      case "Parallel":
        return self;
      case "Sequential":
      case "ParallelN":
        return flatMap6(scopeFork(scope2, parallel3), (inner) => scopeExtend(self, inner));
    }
  }
}));
var parallelNFinalizers = (parallelism) => (self) => contextWithEffect((context2) => match2(getOption2(context2, scopeTag), {
  onNone: () => self,
  onSome: (scope2) => {
    if (scope2.strategy._tag === "ParallelN" && scope2.strategy.parallelism === parallelism) {
      return self;
    }
    return flatMap6(scopeFork(scope2, parallelN2(parallelism)), (inner) => scopeExtend(self, inner));
  }
}));
var finalizersMaskInternal = (strategy, concurrentFinalizers) => (self) => contextWithEffect((context2) => match2(getOption2(context2, scopeTag), {
  onNone: () => self(identity),
  onSome: (scope2) => {
    if (concurrentFinalizers === true) {
      const patch9 = strategy._tag === "Parallel" ? parallelFinalizers : strategy._tag === "Sequential" ? sequentialFinalizers : parallelNFinalizers(strategy.parallelism);
      switch (scope2.strategy._tag) {
        case "Parallel":
          return patch9(self(parallelFinalizers));
        case "Sequential":
          return patch9(self(sequentialFinalizers));
        case "ParallelN":
          return patch9(self(parallelNFinalizers(scope2.strategy.parallelism)));
      }
    } else {
      return self(identity);
    }
  }
}));
var sequentialFinalizers = (self) => contextWithEffect((context2) => match2(getOption2(context2, scopeTag), {
  onNone: () => self,
  onSome: (scope2) => {
    switch (scope2.strategy._tag) {
      case "Sequential":
        return self;
      case "Parallel":
      case "ParallelN":
        return flatMap6(scopeFork(scope2, sequential3), (inner) => scopeExtend(self, inner));
    }
  }
}));
var zipRightOptions = /* @__PURE__ */ dual((args2) => isEffect(args2[1]), (self, that, options) => {
  if (options?.concurrent !== true && (options?.batching === void 0 || options.batching === false)) {
    return zipRight(self, that);
  }
  return zipWithOptions(self, that, (_, b) => b, options);
});
var zipWithOptions = /* @__PURE__ */ dual((args2) => isEffect(args2[1]), (self, that, f, options) => map8(all2([self, that], {
  concurrency: options?.concurrent ? 2 : 1,
  batching: options?.batching,
  concurrentFinalizers: options?.concurrentFinalizers
}), ([a, a2]) => f(a, a2)));
var scopeTag = /* @__PURE__ */ GenericTag("effect/Scope");
var scope = scopeTag;
var scopeUnsafeAddFinalizer = (scope2, fin) => {
  if (scope2.state._tag === "Open") {
    scope2.state.finalizers.set({}, fin);
  }
};
var ScopeImplProto = {
  [ScopeTypeId]: ScopeTypeId,
  [CloseableScopeTypeId]: CloseableScopeTypeId,
  pipe() {
    return pipeArguments(this, arguments);
  },
  fork(strategy) {
    return sync(() => {
      const newScope = scopeUnsafeMake(strategy);
      if (this.state._tag === "Closed") {
        newScope.state = this.state;
        return newScope;
      }
      const key = {};
      const fin = (exit4) => newScope.close(exit4);
      this.state.finalizers.set(key, fin);
      scopeUnsafeAddFinalizer(newScope, (_) => sync(() => {
        if (this.state._tag === "Open") {
          this.state.finalizers.delete(key);
        }
      }));
      return newScope;
    });
  },
  close(exit4) {
    return suspend(() => {
      if (this.state._tag === "Closed") {
        return void_;
      }
      const finalizers = Array.from(this.state.finalizers.values()).reverse();
      this.state = {
        _tag: "Closed",
        exit: exit4
      };
      if (finalizers.length === 0) {
        return void_;
      }
      return isSequential(this.strategy) ? pipe(forEachSequential(finalizers, (fin) => exit(fin(exit4))), flatMap6((results) => pipe(exitCollectAll(results), map(exitAsVoid), getOrElse(() => exitVoid)))) : isParallel(this.strategy) ? pipe(forEachParUnbounded(finalizers, (fin) => exit(fin(exit4)), false), flatMap6((results) => pipe(exitCollectAll(results, {
        parallel: true
      }), map(exitAsVoid), getOrElse(() => exitVoid)))) : pipe(forEachParN(finalizers, this.strategy.parallelism, (fin) => exit(fin(exit4)), false), flatMap6((results) => pipe(exitCollectAll(results, {
        parallel: true
      }), map(exitAsVoid), getOrElse(() => exitVoid))));
    });
  },
  addFinalizer(fin) {
    return suspend(() => {
      if (this.state._tag === "Closed") {
        return fin(this.state.exit);
      }
      this.state.finalizers.set({}, fin);
      return void_;
    });
  }
};
var scopeUnsafeMake = (strategy = sequential2) => {
  const scope2 = Object.create(ScopeImplProto);
  scope2.strategy = strategy;
  scope2.state = {
    _tag: "Open",
    finalizers: /* @__PURE__ */ new Map()
  };
  return scope2;
};
var scopeMake = (strategy = sequential2) => sync(() => scopeUnsafeMake(strategy));
var scopeExtend = /* @__PURE__ */ dual(2, (effect, scope2) => mapInputContext(
  effect,
  // @ts-expect-error
  merge3(make9(scopeTag, scope2))
));
var fiberRefUnsafeMakeSupervisor = (initial) => fiberRefUnsafeMakePatch(initial, {
  differ: differ2,
  fork: empty22
});
var currentRuntimeFlags = /* @__PURE__ */ fiberRefUnsafeMakeRuntimeFlags(none5);
var currentSupervisor = /* @__PURE__ */ fiberRefUnsafeMakeSupervisor(none7);
var raceWith = /* @__PURE__ */ dual(3, (self, other, options) => raceFibersWith(self, other, {
  onSelfWin: (winner, loser) => flatMap6(winner.await, (exit4) => {
    switch (exit4._tag) {
      case OP_SUCCESS: {
        return flatMap6(winner.inheritAll, () => options.onSelfDone(exit4, loser));
      }
      case OP_FAILURE: {
        return options.onSelfDone(exit4, loser);
      }
    }
  }),
  onOtherWin: (winner, loser) => flatMap6(winner.await, (exit4) => {
    switch (exit4._tag) {
      case OP_SUCCESS: {
        return flatMap6(winner.inheritAll, () => options.onOtherDone(exit4, loser));
      }
      case OP_FAILURE: {
        return options.onOtherDone(exit4, loser);
      }
    }
  })
}));
var race = /* @__PURE__ */ dual(2, (self, that) => fiberIdWith((parentFiberId) => raceWith(self, that, {
  onSelfDone: (exit4, right3) => exitMatchEffect(exit4, {
    onFailure: (cause2) => pipe(join2(right3), mapErrorCause((cause22) => parallel(cause2, cause22))),
    onSuccess: (value) => pipe(right3, interruptAsFiber(parentFiberId), as(value))
  }),
  onOtherDone: (exit4, left3) => exitMatchEffect(exit4, {
    onFailure: (cause2) => pipe(join2(left3), mapErrorCause((cause22) => parallel(cause22, cause2))),
    onSuccess: (value) => pipe(left3, interruptAsFiber(parentFiberId), as(value))
  })
})));
var raceFibersWith = /* @__PURE__ */ dual(3, (self, other, options) => withFiberRuntime((parentFiber, parentStatus) => {
  const parentRuntimeFlags = parentStatus.runtimeFlags;
  const raceIndicator = make11(true);
  const leftFiber = unsafeMakeChildFiber(self, parentFiber, parentRuntimeFlags, options.selfScope);
  const rightFiber = unsafeMakeChildFiber(other, parentFiber, parentRuntimeFlags, options.otherScope);
  return async_((cb) => {
    leftFiber.addObserver(() => completeRace(leftFiber, rightFiber, options.onSelfWin, raceIndicator, cb));
    rightFiber.addObserver(() => completeRace(rightFiber, leftFiber, options.onOtherWin, raceIndicator, cb));
    leftFiber.startFork(self);
    rightFiber.startFork(other);
  }, combine3(leftFiber.id(), rightFiber.id()));
}));
var completeRace = (winner, loser, cont, ab, cb) => {
  if (compareAndSet(true, false)(ab)) {
    cb(cont(winner, loser));
  }
};
var ensuring = /* @__PURE__ */ dual(2, (self, finalizer) => uninterruptibleMask((restore) => matchCauseEffect(restore(self), {
  onFailure: (cause1) => matchCauseEffect(finalizer, {
    onFailure: (cause2) => failCause(sequential(cause1, cause2)),
    onSuccess: () => failCause(cause1)
  }),
  onSuccess: (a) => as(finalizer, a)
})));
var invokeWithInterrupt = (self, entries2, onInterrupt3) => fiberIdWith((id2) => ensuring(flatMap6(forkDaemon(interruptible2(self)), (processing) => async_((cb) => {
  const counts = entries2.map((_) => _.listeners.count);
  const checkDone = () => {
    if (counts.every((count) => count === 0)) {
      if (entries2.every((_) => {
        if (_.result.state.current._tag === "Pending") {
          return true;
        } else if (_.result.state.current._tag === "Done" && exitIsExit(_.result.state.current.effect) && _.result.state.current.effect._tag === "Failure" && isInterrupted(_.result.state.current.effect.cause)) {
          return true;
        } else {
          return false;
        }
      })) {
        cleanup.forEach((f) => f());
        onInterrupt3?.();
        cb(interruptFiber(processing));
      }
    }
  };
  processing.addObserver((exit4) => {
    cleanup.forEach((f) => f());
    cb(exit4);
  });
  const cleanup = entries2.map((r, i) => {
    const observer = (count) => {
      counts[i] = count;
      checkDone();
    };
    r.listeners.addObserver(observer);
    return () => r.listeners.removeObserver(observer);
  });
  checkDone();
  return sync(() => {
    cleanup.forEach((f) => f());
  });
})), suspend(() => {
  const residual = entries2.flatMap((entry) => {
    if (!entry.state.completed) {
      return [entry];
    }
    return [];
  });
  return forEachSequentialDiscard(residual, (entry) => complete(entry.request, exitInterrupt(id2)));
})));

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Cause.js
var isInterruptedOnly2 = isInterruptedOnly;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Scope.js
var close = scopeClose;
var extend2 = scopeExtend;
var fork = scopeFork;
var make31 = scopeMake;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/effect/circular.js
var Semaphore = class {
  permits;
  waiters = /* @__PURE__ */ new Set();
  taken = 0;
  constructor(permits) {
    this.permits = permits;
  }
  get free() {
    return this.permits - this.taken;
  }
  take = (n) => asyncInterrupt((resume2) => {
    if (this.free < n) {
      const observer = () => {
        if (this.free < n) return;
        this.waiters.delete(observer);
        resume2(suspend(() => {
          if (this.free < n) return this.take(n);
          this.taken += n;
          return succeed(n);
        }));
      };
      this.waiters.add(observer);
      return sync(() => {
        this.waiters.delete(observer);
      });
    }
    resume2(suspend(() => {
      if (this.free < n) return this.take(n);
      this.taken += n;
      return succeed(n);
    }));
  });
  updateTakenUnsafe(fiber, f) {
    this.taken = f(this.taken);
    if (this.waiters.size > 0) {
      fiber.getFiberRef(currentScheduler).scheduleTask(() => {
        const iter = this.waiters.values();
        let item = iter.next();
        while (item.done === false && this.free > 0) {
          item.value();
          item = iter.next();
        }
      }, fiber.getFiberRef(currentSchedulingPriority), fiber);
    }
    return succeed(this.free);
  }
  updateTaken(f) {
    return withFiberRuntime((fiber) => this.updateTakenUnsafe(fiber, f));
  }
  resize = (permits) => asVoid(withFiberRuntime((fiber) => {
    this.permits = permits;
    if (this.free < 0) {
      return void_;
    }
    return this.updateTakenUnsafe(fiber, (taken) => taken);
  }));
  release = (n) => this.updateTaken((taken) => taken - n);
  releaseAll = /* @__PURE__ */ this.updateTaken((_) => 0);
  withPermits = (n) => (self) => uninterruptibleMask((restore) => flatMap6(restore(this.take(n)), (permits) => ensuring(restore(self), this.release(permits))));
  withPermitsIfAvailable = (n) => (self) => uninterruptibleMask((restore) => suspend(() => {
    if (this.free < n) {
      return succeedNone;
    }
    this.taken += n;
    return ensuring(restore(asSome(self)), this.release(n));
  }));
};
var unsafeMakeSemaphore = (permits) => new Semaphore(permits);
var makeSemaphore = (permits) => sync(() => unsafeMakeSemaphore(permits));
var forkIn = /* @__PURE__ */ dual(2, (self, scope2) => withFiberRuntime((parent, parentStatus) => {
  const scopeImpl = scope2;
  const fiber = unsafeFork2(self, parent, parentStatus.runtimeFlags, globalScope);
  if (scopeImpl.state._tag === "Open") {
    const finalizer = () => fiberIdWith((fiberId2) => equals(fiberId2, fiber.id()) ? void_ : asVoid(interruptFiber(fiber)));
    const key = {};
    scopeImpl.state.finalizers.set(key, finalizer);
    fiber.addObserver(() => {
      if (scopeImpl.state._tag === "Closed") return;
      scopeImpl.state.finalizers.delete(key);
    });
  } else {
    fiber.unsafeInterruptAsFork(parent.id());
  }
  return succeed(fiber);
}));
var memoKeySymbol = /* @__PURE__ */ Symbol.for("effect/Effect/memoizeFunction.key");
var Key = class {
  a;
  eq;
  [memoKeySymbol] = memoKeySymbol;
  constructor(a, eq) {
    this.a = a;
    this.eq = eq;
  }
  [symbol2](that) {
    if (hasProperty(that, memoKeySymbol)) {
      if (this.eq) {
        return this.eq(this.a, that.a);
      } else {
        return equals(this.a, that.a);
      }
    }
    return false;
  }
  [symbol]() {
    return this.eq ? 0 : cached(this, hash(this.a));
  }
};
var raceFirst = /* @__PURE__ */ dual(2, (self, that) => pipe(exit(self), race(exit(that)), (effect) => flatten3(effect)));
var SynchronizedSymbolKey = "effect/Ref/SynchronizedRef";
var SynchronizedTypeId = /* @__PURE__ */ Symbol.for(SynchronizedSymbolKey);
var synchronizedVariance = {
  /* c8 ignore next */
  _A: (_) => _
};
var SynchronizedImpl = class extends Class2 {
  ref;
  withLock;
  [SynchronizedTypeId] = synchronizedVariance;
  [RefTypeId] = refVariance;
  [TypeId10] = TypeId10;
  constructor(ref, withLock) {
    super();
    this.ref = ref;
    this.withLock = withLock;
    this.get = get9(this.ref);
  }
  get;
  commit() {
    return this.get;
  }
  modify(f) {
    return this.modifyEffect((a) => succeed(f(a)));
  }
  modifyEffect(f) {
    return this.withLock(pipe(flatMap6(get9(this.ref), f), flatMap6(([b, a]) => as(set4(this.ref, a), b))));
  }
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Fiber.js
var _await2 = _await;
var interrupt3 = interruptFiber;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/runtime.js
var makeDual = (f) => function() {
  if (arguments.length === 1) {
    const runtime3 = arguments[0];
    return (effect, ...args2) => f(runtime3, effect, ...args2);
  }
  return f.apply(this, arguments);
};
var unsafeFork3 = /* @__PURE__ */ makeDual((runtime3, self, options) => {
  const fiberId2 = unsafeMake2();
  const fiberRefUpdates = [[currentContext, [[fiberId2, runtime3.context]]]];
  if (options?.scheduler) {
    fiberRefUpdates.push([currentScheduler, [[fiberId2, options.scheduler]]]);
  }
  let fiberRefs3 = updateManyAs2(runtime3.fiberRefs, {
    entries: fiberRefUpdates,
    forkAs: fiberId2
  });
  if (options?.updateRefs) {
    fiberRefs3 = options.updateRefs(fiberRefs3, fiberId2);
  }
  const fiberRuntime = new FiberRuntime(fiberId2, fiberRefs3, runtime3.runtimeFlags);
  let effect = self;
  if (options?.scope) {
    effect = flatMap6(fork(options.scope, sequential2), (closeableScope) => zipRight(scopeAddFinalizer(closeableScope, fiberIdWith((id2) => equals(id2, fiberRuntime.id()) ? void_ : interruptAsFiber(fiberRuntime, id2))), onExit(self, (exit4) => close(closeableScope, exit4))));
  }
  const supervisor = fiberRuntime.currentSupervisor;
  if (supervisor !== none7) {
    supervisor.onStart(runtime3.context, effect, none2(), fiberRuntime);
    fiberRuntime.addObserver((exit4) => supervisor.onEnd(exit4, fiberRuntime));
  }
  globalScope.add(runtime3.runtimeFlags, fiberRuntime);
  if (options?.immediate === false) {
    fiberRuntime.resume(effect);
  } else {
    fiberRuntime.start(effect);
  }
  return fiberRuntime;
});
var unsafeRunSync = /* @__PURE__ */ makeDual((runtime3, effect) => {
  const result = unsafeRunSyncExit(runtime3)(effect);
  if (result._tag === "Failure") {
    throw fiberFailure(result.effect_instruction_i0);
  }
  return result.effect_instruction_i0;
});
var AsyncFiberExceptionImpl = class extends Error {
  fiber;
  _tag = "AsyncFiberException";
  constructor(fiber) {
    super(`Fiber #${fiber.id().id} cannot be resolved synchronously. This is caused by using runSync on an effect that performs async work`);
    this.fiber = fiber;
    this.name = this._tag;
    this.stack = this.message;
  }
};
var asyncFiberException = (fiber) => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  const error = new AsyncFiberExceptionImpl(fiber);
  Error.stackTraceLimit = limit;
  return error;
};
var FiberFailureId = /* @__PURE__ */ Symbol.for("effect/Runtime/FiberFailure");
var FiberFailureCauseId = /* @__PURE__ */ Symbol.for("effect/Runtime/FiberFailure/Cause");
var FiberFailureImpl = class extends Error {
  [FiberFailureId];
  [FiberFailureCauseId];
  constructor(cause2) {
    const head4 = prettyErrors(cause2)[0];
    super(head4?.message || "An error has occurred");
    this[FiberFailureId] = FiberFailureId;
    this[FiberFailureCauseId] = cause2;
    this.name = head4 ? `(FiberFailure) ${head4.name}` : "FiberFailure";
    if (head4?.stack) {
      this.stack = head4.stack;
    }
  }
  toJSON() {
    return {
      _id: "FiberFailure",
      cause: this[FiberFailureCauseId].toJSON()
    };
  }
  toString() {
    return "(FiberFailure) " + pretty(this[FiberFailureCauseId], {
      renderErrorCause: true
    });
  }
  [NodeInspectSymbol]() {
    return this.toString();
  }
};
var fiberFailure = (cause2) => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  const error = new FiberFailureImpl(cause2);
  Error.stackTraceLimit = limit;
  return error;
};
var fastPath = (effect) => {
  const op = effect;
  switch (op._op) {
    case "Failure":
    case "Success": {
      return op;
    }
    case "Left": {
      return exitFail(op.left);
    }
    case "Right": {
      return exitSucceed(op.right);
    }
    case "Some": {
      return exitSucceed(op.value);
    }
    case "None": {
      return exitFail(new NoSuchElementException());
    }
  }
};
var unsafeRunSyncExit = /* @__PURE__ */ makeDual((runtime3, effect) => {
  const op = fastPath(effect);
  if (op) {
    return op;
  }
  const scheduler = new SyncScheduler();
  const fiberRuntime = unsafeFork3(runtime3)(effect, {
    scheduler
  });
  scheduler.flush();
  const result = fiberRuntime.unsafePoll();
  if (result) {
    return result;
  }
  return exitDie(capture(asyncFiberException(fiberRuntime), currentSpanFromFiber(fiberRuntime)));
});
var unsafeRunPromise = /* @__PURE__ */ makeDual((runtime3, effect, options) => unsafeRunPromiseExit(runtime3, effect, options).then((result) => {
  switch (result._tag) {
    case OP_SUCCESS: {
      return result.effect_instruction_i0;
    }
    case OP_FAILURE: {
      throw fiberFailure(result.effect_instruction_i0);
    }
  }
}));
var unsafeRunPromiseExit = /* @__PURE__ */ makeDual((runtime3, effect, options) => new Promise((resolve) => {
  const op = fastPath(effect);
  if (op) {
    resolve(op);
  }
  const fiber = unsafeFork3(runtime3)(effect);
  fiber.addObserver((exit4) => {
    resolve(exit4);
  });
  if (options?.signal !== void 0) {
    if (options.signal.aborted) {
      fiber.unsafeInterruptAsFork(fiber.id());
    } else {
      options.signal.addEventListener("abort", () => {
        fiber.unsafeInterruptAsFork(fiber.id());
      }, {
        once: true
      });
    }
  }
}));
var RuntimeImpl = class {
  context;
  runtimeFlags;
  fiberRefs;
  constructor(context2, runtimeFlags2, fiberRefs3) {
    this.context = context2;
    this.runtimeFlags = runtimeFlags2;
    this.fiberRefs = fiberRefs3;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var make32 = (options) => new RuntimeImpl(options.context, options.runtimeFlags, options.fiberRefs);
var defaultRuntimeFlags = /* @__PURE__ */ make16(Interruption, CooperativeYielding, RuntimeMetrics);
var defaultRuntime = /* @__PURE__ */ make32({
  context: /* @__PURE__ */ empty8(),
  runtimeFlags: defaultRuntimeFlags,
  fiberRefs: /* @__PURE__ */ empty17()
});
var unsafeRunPromiseEffect = /* @__PURE__ */ unsafeRunPromise(defaultRuntime);
var unsafeRunSyncEffect = /* @__PURE__ */ unsafeRunSync(defaultRuntime);

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Data.js
var Error3 = /* @__PURE__ */ (function() {
  const plainArgsSymbol = /* @__PURE__ */ Symbol.for("effect/Data/Error/plainArgs");
  const O = {
    BaseEffectError: class extends YieldableError {
      constructor(args2) {
        super(args2?.message, args2?.cause ? {
          cause: args2.cause
        } : void 0);
        if (args2) {
          Object.assign(this, args2);
          Object.defineProperty(this, plainArgsSymbol, {
            value: args2,
            enumerable: false
          });
        }
      }
      toJSON() {
        return {
          ...this[plainArgsSymbol],
          ...this
        };
      }
    }
  };
  return O.BaseEffectError;
})();
var TaggedError = (tag) => {
  const O = {
    BaseEffectError: class extends Error3 {
      _tag = tag;
    }
  };
  O.BaseEffectError.prototype.name = tag;
  return O.BaseEffectError;
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Deferred.js
var make33 = deferredMake;
var _await3 = deferredAwait;
var fail5 = deferredFail;
var succeed4 = deferredSucceed;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/MutableList.js
var TypeId13 = /* @__PURE__ */ Symbol.for("effect/MutableList");
var MutableListProto = {
  [TypeId13]: TypeId13,
  [Symbol.iterator]() {
    let done5 = false;
    let head4 = this.head;
    return {
      next() {
        if (done5) {
          return this.return();
        }
        if (head4 == null) {
          done5 = true;
          return this.return();
        }
        const value = head4.value;
        head4 = head4.next;
        return {
          done: done5,
          value
        };
      },
      return(value) {
        if (!done5) {
          done5 = true;
        }
        return {
          done: true,
          value
        };
      }
    };
  },
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "MutableList",
      values: Array.from(this).map(toJSON)
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var makeNode = (value) => ({
  value,
  removed: false,
  prev: void 0,
  next: void 0
});
var empty24 = () => {
  const list = Object.create(MutableListProto);
  list.head = void 0;
  list.tail = void 0;
  list._length = 0;
  return list;
};
var isEmpty6 = (self) => length(self) === 0;
var length = (self) => self._length;
var append3 = /* @__PURE__ */ dual(2, (self, value) => {
  const node = makeNode(value);
  if (self.head === void 0) {
    self.head = node;
  }
  if (self.tail === void 0) {
    self.tail = node;
  } else {
    self.tail.next = node;
    node.prev = self.tail;
    self.tail = node;
  }
  ;
  self._length += 1;
  return self;
});
var shift = (self) => {
  const head4 = self.head;
  if (head4 !== void 0) {
    remove6(self, head4);
    return head4.value;
  }
  return void 0;
};
var remove6 = (self, node) => {
  if (node.removed) {
    return;
  }
  node.removed = true;
  if (node.prev !== void 0 && node.next !== void 0) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  } else if (node.prev !== void 0) {
    self.tail = node.prev;
    node.prev.next = void 0;
  } else if (node.next !== void 0) {
    self.head = node.next;
    node.next.prev = void 0;
  } else {
    self.tail = void 0;
    self.head = void 0;
  }
  if (self._length > 0) {
    ;
    self._length -= 1;
  }
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/MutableQueue.js
var TypeId14 = /* @__PURE__ */ Symbol.for("effect/MutableQueue");
var EmptyMutableQueue = /* @__PURE__ */ Symbol.for("effect/mutable/MutableQueue/Empty");
var MutableQueueProto = {
  [TypeId14]: TypeId14,
  [Symbol.iterator]() {
    return Array.from(this.queue)[Symbol.iterator]();
  },
  toString() {
    return format(this.toJSON());
  },
  toJSON() {
    return {
      _id: "MutableQueue",
      values: Array.from(this).map(toJSON)
    };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var make34 = (capacity3) => {
  const queue = Object.create(MutableQueueProto);
  queue.queue = empty24();
  queue.capacity = capacity3;
  return queue;
};
var bounded = (capacity3) => make34(capacity3);
var unbounded = () => make34(void 0);
var length2 = (self) => length(self.queue);
var isEmpty7 = (self) => isEmpty6(self.queue);
var capacity = (self) => self.capacity === void 0 ? Infinity : self.capacity;
var offer = /* @__PURE__ */ dual(2, (self, value) => {
  const queueLength = length(self.queue);
  if (self.capacity !== void 0 && queueLength === self.capacity) {
    return false;
  }
  append3(value)(self.queue);
  return true;
});
var offerAll = /* @__PURE__ */ dual(2, (self, values3) => {
  const iterator = values3[Symbol.iterator]();
  let next;
  let remainder = empty2();
  let offering = true;
  while (offering && (next = iterator.next()) && !next.done) {
    offering = offer(next.value)(self);
  }
  while (next != null && !next.done) {
    remainder = prepend2(next.value)(remainder);
    next = iterator.next();
  }
  return reverse2(remainder);
});
var poll2 = /* @__PURE__ */ dual(2, (self, def) => {
  if (isEmpty6(self.queue)) {
    return def;
  }
  return shift(self.queue);
});
var pollUpTo = /* @__PURE__ */ dual(2, (self, n) => {
  let result = empty2();
  let count = 0;
  while (count < n) {
    const element = poll2(EmptyMutableQueue)(self);
    if (element === EmptyMutableQueue) {
      break;
    }
    result = prepend2(element)(result);
    count += 1;
  }
  return reverse2(result);
});

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Effect.js
var cached3 = memoize;
var all3 = all2;
var forEach7 = forEach6;
var fail6 = fail2;
var failCause4 = failCause;
var gen2 = gen;
var never3 = never;
var succeed5 = succeed;
var suspend3 = suspend;
var sync3 = sync;
var _void = void_;
var catchAll2 = catchAll;
var catchAllCause2 = catchAllCause;
var try_2 = try_;
var tryPromise2 = tryPromise;
var onInterrupt2 = onInterrupt;
var uninterruptibleMask3 = uninterruptibleMask;
var as4 = as;
var asVoid2 = asVoid;
var map11 = map8;
var mapError2 = mapError;
var acquireRelease2 = acquireRelease;
var acquireUseRelease2 = acquireUseRelease;
var ensuring2 = ensuring;
var onError2 = onError;
var forkIn2 = forkIn;
var sleep4 = sleep3;
var option2 = option;
var either3 = either2;
var exit3 = exit;
var flatMap9 = flatMap6;
var andThen4 = andThen2;
var raceAll2 = raceAll;
var raceFirst2 = raceFirst;
var tap2 = tap;
var tapError2 = tapError;
var match10 = match8;
var matchEffect2 = matchEffect;
var makeSemaphore2 = makeSemaphore;
var runPromise = unsafeRunPromiseEffect;
var runSync = unsafeRunSyncEffect;
var zipRight2 = zipRightOptions;

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/internal/queue.js
var EnqueueSymbolKey = "effect/QueueEnqueue";
var EnqueueTypeId = /* @__PURE__ */ Symbol.for(EnqueueSymbolKey);
var DequeueSymbolKey = "effect/QueueDequeue";
var DequeueTypeId = /* @__PURE__ */ Symbol.for(DequeueSymbolKey);
var QueueStrategySymbolKey = "effect/QueueStrategy";
var QueueStrategyTypeId = /* @__PURE__ */ Symbol.for(QueueStrategySymbolKey);
var BackingQueueSymbolKey = "effect/BackingQueue";
var BackingQueueTypeId = /* @__PURE__ */ Symbol.for(BackingQueueSymbolKey);
var queueStrategyVariance = {
  /* c8 ignore next */
  _A: (_) => _
};
var backingQueueVariance = {
  /* c8 ignore next */
  _A: (_) => _
};
var enqueueVariance = {
  /* c8 ignore next */
  _In: (_) => _
};
var dequeueVariance = {
  /* c8 ignore next */
  _Out: (_) => _
};
var QueueImpl = class extends Class2 {
  queue;
  takers;
  shutdownHook;
  shutdownFlag;
  strategy;
  [EnqueueTypeId] = enqueueVariance;
  [DequeueTypeId] = dequeueVariance;
  constructor(queue, takers, shutdownHook, shutdownFlag, strategy) {
    super();
    this.queue = queue;
    this.takers = takers;
    this.shutdownHook = shutdownHook;
    this.shutdownFlag = shutdownFlag;
    this.strategy = strategy;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
  commit() {
    return this.take;
  }
  capacity() {
    return this.queue.capacity();
  }
  get size() {
    return suspend(() => catchAll(this.unsafeSize(), () => interrupt2));
  }
  unsafeSize() {
    if (get6(this.shutdownFlag)) {
      return none2();
    }
    return some2(this.queue.length() - length2(this.takers) + this.strategy.surplusSize());
  }
  get isEmpty() {
    return map8(this.size, (size8) => size8 <= 0);
  }
  get isFull() {
    return map8(this.size, (size8) => size8 >= this.capacity());
  }
  get shutdown() {
    return uninterruptible(withFiberRuntime((state) => {
      pipe(this.shutdownFlag, set2(true));
      return pipe(forEachConcurrentDiscard(unsafePollAll(this.takers), (d) => deferredInterruptWith(d, state.id()), false, false), zipRight(this.strategy.shutdown), whenEffect(deferredSucceed(this.shutdownHook, void 0)), asVoid);
    }));
  }
  get isShutdown() {
    return sync(() => get6(this.shutdownFlag));
  }
  get awaitShutdown() {
    return deferredAwait(this.shutdownHook);
  }
  isActive() {
    return !get6(this.shutdownFlag);
  }
  unsafeOffer(value) {
    if (get6(this.shutdownFlag)) {
      return false;
    }
    let noRemaining;
    if (this.queue.length() === 0) {
      const taker = pipe(this.takers, poll2(EmptyMutableQueue));
      if (taker !== EmptyMutableQueue) {
        unsafeCompleteDeferred(taker, value);
        noRemaining = true;
      } else {
        noRemaining = false;
      }
    } else {
      noRemaining = false;
    }
    if (noRemaining) {
      return true;
    }
    const succeeded = this.queue.offer(value);
    unsafeCompleteTakers(this.strategy, this.queue, this.takers);
    return succeeded;
  }
  offer(value) {
    return suspend(() => {
      if (get6(this.shutdownFlag)) {
        return interrupt2;
      }
      let noRemaining;
      if (this.queue.length() === 0) {
        const taker = pipe(this.takers, poll2(EmptyMutableQueue));
        if (taker !== EmptyMutableQueue) {
          unsafeCompleteDeferred(taker, value);
          noRemaining = true;
        } else {
          noRemaining = false;
        }
      } else {
        noRemaining = false;
      }
      if (noRemaining) {
        return succeed(true);
      }
      const succeeded = this.queue.offer(value);
      unsafeCompleteTakers(this.strategy, this.queue, this.takers);
      return succeeded ? succeed(true) : this.strategy.handleSurplus([value], this.queue, this.takers, this.shutdownFlag);
    });
  }
  offerAll(iterable) {
    return suspend(() => {
      if (get6(this.shutdownFlag)) {
        return interrupt2;
      }
      const values3 = fromIterable(iterable);
      const pTakers = this.queue.length() === 0 ? fromIterable(unsafePollN(this.takers, values3.length)) : empty;
      const [forTakers, remaining] = pipe(values3, splitAt(pTakers.length));
      for (let i = 0; i < pTakers.length; i++) {
        const taker = pTakers[i];
        const item = forTakers[i];
        unsafeCompleteDeferred(taker, item);
      }
      if (remaining.length === 0) {
        return succeed(true);
      }
      const surplus = this.queue.offerAll(remaining);
      unsafeCompleteTakers(this.strategy, this.queue, this.takers);
      return isEmpty(surplus) ? succeed(true) : this.strategy.handleSurplus(surplus, this.queue, this.takers, this.shutdownFlag);
    });
  }
  get take() {
    return withFiberRuntime((state) => {
      if (get6(this.shutdownFlag)) {
        return interrupt2;
      }
      const item = this.queue.poll(EmptyMutableQueue);
      if (item !== EmptyMutableQueue) {
        this.strategy.unsafeOnQueueEmptySpace(this.queue, this.takers);
        return succeed(item);
      } else {
        const deferred = deferredUnsafeMake(state.id());
        return pipe(suspend(() => {
          pipe(this.takers, offer(deferred));
          unsafeCompleteTakers(this.strategy, this.queue, this.takers);
          return get6(this.shutdownFlag) ? interrupt2 : deferredAwait(deferred);
        }), onInterrupt(() => {
          return sync(() => unsafeRemove(this.takers, deferred));
        }));
      }
    });
  }
  get takeAll() {
    return suspend(() => {
      return get6(this.shutdownFlag) ? interrupt2 : sync(() => {
        const values3 = this.queue.pollUpTo(Number.POSITIVE_INFINITY);
        this.strategy.unsafeOnQueueEmptySpace(this.queue, this.takers);
        return fromIterable2(values3);
      });
    });
  }
  takeUpTo(max2) {
    return suspend(() => get6(this.shutdownFlag) ? interrupt2 : sync(() => {
      const values3 = this.queue.pollUpTo(max2);
      this.strategy.unsafeOnQueueEmptySpace(this.queue, this.takers);
      return fromIterable2(values3);
    }));
  }
  takeBetween(min2, max2) {
    return suspend(() => takeRemainderLoop(this, min2, max2, empty2()));
  }
};
var takeRemainderLoop = (self, min2, max2, acc) => {
  if (max2 < min2) {
    return succeed(acc);
  }
  return pipe(takeUpTo(self, max2), flatMap6((bs) => {
    const remaining = min2 - bs.length;
    if (remaining === 1) {
      return pipe(take(self), map8((b) => pipe(acc, appendAll2(bs), append2(b))));
    }
    if (remaining > 1) {
      return pipe(take(self), flatMap6((b) => takeRemainderLoop(self, remaining - 1, max2 - bs.length - 1, pipe(acc, appendAll2(bs), append2(b)))));
    }
    return succeed(pipe(acc, appendAll2(bs)));
  }));
};
var bounded2 = (requestedCapacity) => pipe(sync(() => bounded(requestedCapacity)), flatMap6((queue) => make35(backingQueueFromMutableQueue(queue), backPressureStrategy())));
var dropping = (requestedCapacity) => pipe(sync(() => bounded(requestedCapacity)), flatMap6((queue) => make35(backingQueueFromMutableQueue(queue), droppingStrategy())));
var unsafeMake7 = (queue, takers, shutdownHook, shutdownFlag, strategy) => {
  return new QueueImpl(queue, takers, shutdownHook, shutdownFlag, strategy);
};
var make35 = (queue, strategy) => pipe(deferredMake(), map8((deferred) => unsafeMake7(queue, unbounded(), deferred, make11(false), strategy)));
var BackingQueueFromMutableQueue = class {
  mutable;
  [BackingQueueTypeId] = backingQueueVariance;
  constructor(mutable) {
    this.mutable = mutable;
  }
  poll(def) {
    return poll2(this.mutable, def);
  }
  pollUpTo(limit) {
    return pollUpTo(this.mutable, limit);
  }
  offerAll(elements) {
    return offerAll(this.mutable, elements);
  }
  offer(element) {
    return offer(this.mutable, element);
  }
  capacity() {
    return capacity(this.mutable);
  }
  length() {
    return length2(this.mutable);
  }
};
var backingQueueFromMutableQueue = (mutable) => new BackingQueueFromMutableQueue(mutable);
var isFull = (self) => self.isFull;
var isEmpty8 = (self) => self.isEmpty;
var shutdown = (self) => self.shutdown;
var offer2 = /* @__PURE__ */ dual(2, (self, value) => self.offer(value));
var poll3 = (self) => map8(self.takeUpTo(1), head2);
var take = (self) => self.take;
var takeAll = (self) => self.takeAll;
var takeUpTo = /* @__PURE__ */ dual(2, (self, max2) => self.takeUpTo(max2));
var backPressureStrategy = () => new BackPressureStrategy();
var droppingStrategy = () => new DroppingStrategy();
var BackPressureStrategy = class {
  [QueueStrategyTypeId] = queueStrategyVariance;
  putters = /* @__PURE__ */ unbounded();
  surplusSize() {
    return length2(this.putters);
  }
  onCompleteTakersWithEmptyQueue(takers) {
    while (!isEmpty7(this.putters) && !isEmpty7(takers)) {
      const taker = poll2(takers, void 0);
      const putter = poll2(this.putters, void 0);
      if (putter[2]) {
        unsafeCompleteDeferred(putter[1], true);
      }
      unsafeCompleteDeferred(taker, putter[0]);
    }
  }
  get shutdown() {
    return pipe(fiberId, flatMap6((fiberId2) => pipe(sync(() => unsafePollAll(this.putters)), flatMap6((putters) => forEachConcurrentDiscard(putters, ([_, deferred, isLastItem]) => isLastItem ? pipe(deferredInterruptWith(deferred, fiberId2), asVoid) : void_, false, false)))));
  }
  handleSurplus(iterable, queue, takers, isShutdown2) {
    return withFiberRuntime((state) => {
      const deferred = deferredUnsafeMake(state.id());
      return pipe(suspend(() => {
        this.unsafeOffer(iterable, deferred);
        this.unsafeOnQueueEmptySpace(queue, takers);
        unsafeCompleteTakers(this, queue, takers);
        return get6(isShutdown2) ? interrupt2 : deferredAwait(deferred);
      }), onInterrupt(() => sync(() => this.unsafeRemove(deferred))));
    });
  }
  unsafeOnQueueEmptySpace(queue, takers) {
    let keepPolling = true;
    while (keepPolling && (queue.capacity() === Number.POSITIVE_INFINITY || queue.length() < queue.capacity())) {
      const putter = pipe(this.putters, poll2(EmptyMutableQueue));
      if (putter === EmptyMutableQueue) {
        keepPolling = false;
      } else {
        const offered = queue.offer(putter[0]);
        if (offered && putter[2]) {
          unsafeCompleteDeferred(putter[1], true);
        } else if (!offered) {
          unsafeOfferAll(this.putters, pipe(unsafePollAll(this.putters), prepend2(putter)));
        }
        unsafeCompleteTakers(this, queue, takers);
      }
    }
  }
  unsafeOffer(iterable, deferred) {
    const stuff = fromIterable(iterable);
    for (let i = 0; i < stuff.length; i++) {
      const value = stuff[i];
      if (i === stuff.length - 1) {
        pipe(this.putters, offer([value, deferred, true]));
      } else {
        pipe(this.putters, offer([value, deferred, false]));
      }
    }
  }
  unsafeRemove(deferred) {
    unsafeOfferAll(this.putters, pipe(unsafePollAll(this.putters), filter2(([, _]) => _ !== deferred)));
  }
};
var DroppingStrategy = class {
  [QueueStrategyTypeId] = queueStrategyVariance;
  surplusSize() {
    return 0;
  }
  get shutdown() {
    return void_;
  }
  onCompleteTakersWithEmptyQueue() {
  }
  handleSurplus(_iterable, _queue, _takers, _isShutdown) {
    return succeed(false);
  }
  unsafeOnQueueEmptySpace(_queue, _takers) {
  }
};
var SlidingStrategy = class {
  [QueueStrategyTypeId] = queueStrategyVariance;
  surplusSize() {
    return 0;
  }
  get shutdown() {
    return void_;
  }
  onCompleteTakersWithEmptyQueue() {
  }
  handleSurplus(iterable, queue, takers, _isShutdown) {
    return sync(() => {
      this.unsafeOffer(queue, iterable);
      unsafeCompleteTakers(this, queue, takers);
      return true;
    });
  }
  unsafeOnQueueEmptySpace(_queue, _takers) {
  }
  unsafeOffer(queue, iterable) {
    const iterator = iterable[Symbol.iterator]();
    let next;
    let offering = true;
    while (!(next = iterator.next()).done && offering) {
      if (queue.capacity() === 0) {
        return;
      }
      queue.poll(EmptyMutableQueue);
      offering = queue.offer(next.value);
    }
  }
};
var unsafeCompleteDeferred = (deferred, a) => {
  return deferredUnsafeDone(deferred, succeed(a));
};
var unsafeOfferAll = (queue, as5) => {
  return pipe(queue, offerAll(as5));
};
var unsafePollAll = (queue) => {
  return pipe(queue, pollUpTo(Number.POSITIVE_INFINITY));
};
var unsafePollN = (queue, max2) => {
  return pipe(queue, pollUpTo(max2));
};
var unsafeRemove = (queue, a) => {
  unsafeOfferAll(queue, pipe(unsafePollAll(queue), filter2((b) => a !== b)));
};
var unsafeCompleteTakers = (strategy, queue, takers) => {
  let keepPolling = true;
  while (keepPolling && queue.length() !== 0) {
    const taker = pipe(takers, poll2(EmptyMutableQueue));
    if (taker !== EmptyMutableQueue) {
      const element = queue.poll(EmptyMutableQueue);
      if (element !== EmptyMutableQueue) {
        unsafeCompleteDeferred(taker, element);
        strategy.unsafeOnQueueEmptySpace(queue, takers);
      } else {
        unsafeOfferAll(takers, pipe(unsafePollAll(takers), prepend2(taker)));
      }
      keepPolling = true;
    } else {
      keepPolling = false;
    }
  }
  if (keepPolling && queue.length() === 0 && !isEmpty7(takers)) {
    strategy.onCompleteTakersWithEmptyQueue(takers);
  }
};

// node_modules/.pnpm/effect@3.22.0/node_modules/effect/dist/esm/Queue.js
var bounded3 = bounded2;
var dropping2 = dropping;
var isEmpty9 = isEmpty8;
var isFull2 = isFull;
var shutdown2 = shutdown;
var offer3 = offer2;
var poll4 = poll3;
var take2 = take;
var takeAll2 = takeAll;

// packages/tracekernel/src/errors.ts
var TraceKernelHostClosedError = class extends TaggedError(
  "TraceKernelHostClosedError"
) {
};
var TraceKernelSessionClosedError = class extends TaggedError(
  "TraceKernelSessionClosedError"
) {
};
var TraceKernelRuntimeUnavailableError = class extends TaggedError(
  "TraceKernelRuntimeUnavailableError"
) {
};
var TraceKernelProcessStateError = class extends TaggedError(
  "TraceKernelProcessStateError"
) {
};
var TraceKernelProcessLimitError = class extends TaggedError(
  "TraceKernelProcessLimitError"
) {
};
var TraceKernelProcessPermissionError = class extends TaggedError(
  "TraceKernelProcessPermissionError"
) {
};
var TraceKernelChildProcessError = class extends TaggedError(
  "TraceKernelChildProcessError"
) {
};
var TraceKernelInvalidArgumentError = class extends TaggedError(
  "TraceKernelInvalidArgumentError"
) {
};
var TraceKernelBadFileDescriptorError = class extends TaggedError(
  "TraceKernelBadFileDescriptorError"
) {
};
var TraceKernelBrokenPipeError = class extends TaggedError(
  "TraceKernelBrokenPipeError"
) {
};
var TraceKernelWouldBlockError = class extends TaggedError(
  "TraceKernelWouldBlockError"
) {
};
var TraceKernelTerminalError = class extends TaggedError(
  "TraceKernelTerminalError"
) {
};
var TraceKernelDescriptorLimitError = class extends TaggedError(
  "TraceKernelDescriptorLimitError"
) {
};
var TraceKernelNetworkError = class extends TaggedError(
  "TraceKernelNetworkError"
) {
};
var TraceKernelInvalidDescriptorOperationError = class extends TaggedError(
  "TraceKernelInvalidDescriptorOperationError"
) {
};
var TraceKernelFileSystemError = class extends TaggedError(
  "TraceKernelFileSystemError"
) {
};

// packages/tracekernel/src/descriptors.ts
var openDescriptionStatuses = /* @__PURE__ */ new WeakMap();
function statusFor(descriptor2) {
  let status2 = openDescriptionStatuses.get(descriptor2);
  if (!status2) {
    status2 = { nonblocking: false };
    openDescriptionStatuses.set(descriptor2, status2);
  }
  return status2;
}
function shareStatus(source, duplicate) {
  openDescriptionStatuses.set(duplicate, statusFor(source));
  return duplicate;
}
var TraceKernelDescriptorTable = class {
  descriptors = /* @__PURE__ */ new Map();
  closeOnExecDescriptors = /* @__PURE__ */ new Set();
  nextFd = 3;
  maxDescriptors;
  operationContext;
  constructor(options = {}) {
    const requested = Number(options.maxDescriptors ?? 1024);
    this.maxDescriptors = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 1024;
    this.operationContext = options.operationContext;
  }
  install(descriptor2, options = {}) {
    if (this.descriptors.size >= this.maxDescriptors) {
      throw new TraceKernelDescriptorLimitError({
        code: "EMFILE",
        maxDescriptors: this.maxDescriptors,
        message: `EMFILE: process descriptor limit ${this.maxDescriptors} reached`
      });
    }
    let fd = this.nextFd;
    while (this.descriptors.has(fd)) fd += 1;
    this.descriptors.set(fd, descriptor2);
    if (options.nonblocking) statusFor(descriptor2).nonblocking = true;
    if (options.closeOnExec) this.closeOnExecDescriptors.add(fd);
    this.nextFd = fd + 1;
    return fd;
  }
  /**
   * Install a descriptor at a kernel-selected numeric identity.
   *
   * This is intentionally separate from dup/inherit: process launch uses it
   * to establish fd 0/1/2 before a runtime lease starts, while ordinary
   * runtime opens continue to allocate from fd 3 upward.
   */
  installAt(fd, descriptor2, options = {}) {
    const targetFd = Math.floor(fd);
    if (!Number.isSafeInteger(fd) || targetFd < 0) {
      throw new TraceKernelBadFileDescriptorError({
        fd: targetFd,
        operation: "inherit",
        message: `EBADF: invalid target descriptor ${fd}`
      });
    }
    if (this.descriptors.size >= this.maxDescriptors) {
      throw new TraceKernelDescriptorLimitError({
        code: "EMFILE",
        maxDescriptors: this.maxDescriptors,
        message: `EMFILE: process descriptor limit ${this.maxDescriptors} reached`
      });
    }
    if (this.descriptors.has(targetFd)) {
      throw new TraceKernelDescriptorLimitError({
        code: "EMFILE",
        maxDescriptors: this.maxDescriptors,
        message: `EMFILE: target descriptor ${targetFd} is already occupied`
      });
    }
    this.descriptors.set(targetFd, descriptor2);
    if (options.nonblocking) statusFor(descriptor2).nonblocking = true;
    if (options.closeOnExec) this.closeOnExecDescriptors.add(targetFd);
    if (targetFd === this.nextFd) this.resetNextFd();
    return targetFd;
  }
  /**
   * Atomically replace a set of descriptor identities.
   *
   * Validation happens before the table changes. Once committed, every target
   * refers to its new open description before any replaced description is
   * closed, so observers cannot see partially remapped stdio.
   */
  replaceMany(replacements) {
    return gen2(this, function* () {
      const targets = /* @__PURE__ */ new Set();
      for (const replacement of replacements) {
        const fd = Math.floor(replacement.fd);
        if (!Number.isSafeInteger(replacement.fd) || fd < 0 || targets.has(fd)) {
          yield* forEach7(
            replacements,
            ({ descriptor: descriptor2 }) => descriptor2.close(),
            { concurrency: "unbounded", discard: true }
          );
          return yield* fail6(new TraceKernelBadFileDescriptorError({
            fd,
            operation: "dup2",
            message: targets.has(fd) ? `EBADF: duplicate replacement descriptor ${fd}` : `EBADF: invalid replacement descriptor ${replacement.fd}`
          }));
        }
        targets.add(fd);
      }
      const occupiedTargets = [...targets].filter(
        (fd) => this.descriptors.has(fd)
      ).length;
      const resultingSize = this.descriptors.size - occupiedTargets + replacements.length;
      if (resultingSize > this.maxDescriptors) {
        yield* forEach7(
          replacements,
          ({ descriptor: descriptor2 }) => descriptor2.close(),
          { concurrency: "unbounded", discard: true }
        );
        return yield* fail6(new TraceKernelDescriptorLimitError({
          code: "EMFILE",
          maxDescriptors: this.maxDescriptors,
          message: `EMFILE: descriptor replacement exceeds process descriptor limit ${this.maxDescriptors}`
        }));
      }
      const replaced = replacements.flatMap(({ fd }) => {
        const descriptor2 = this.descriptors.get(fd);
        return descriptor2 ? [descriptor2] : [];
      });
      for (const replacement of replacements) {
        this.descriptors.set(replacement.fd, replacement.descriptor);
        if (replacement.closeOnExec) {
          this.closeOnExecDescriptors.add(replacement.fd);
        } else {
          this.closeOnExecDescriptors.delete(replacement.fd);
        }
        statusFor(replacement.descriptor).nonblocking = replacement.nonblocking === true;
      }
      this.resetNextFd();
      yield* forEach7(
        replaced,
        (descriptor2) => descriptor2.close(),
        { concurrency: "unbounded", discard: true }
      );
    });
  }
  snapshots() {
    return [...this.descriptors.entries()].map(([fd, descriptor2]) => Object.freeze({
      fd,
      kind: descriptor2.kind,
      resourceId: descriptor2.resourceId,
      closeOnExec: this.closeOnExecDescriptors.has(fd),
      nonblocking: statusFor(descriptor2).nonblocking
    })).sort((left3, right3) => left3.fd - right3.fd);
  }
  lookup(fd) {
    const descriptor2 = this.descriptors.get(fd);
    return descriptor2 ? succeed5(descriptor2) : fail6(new TraceKernelBadFileDescriptorError({
      fd,
      operation: "stat",
      message: `EBADF: bad file descriptor ${fd}`
    }));
  }
  getCloseOnExec(fd) {
    return this.descriptors.has(fd) ? succeed5(this.closeOnExecDescriptors.has(fd)) : fail6(new TraceKernelBadFileDescriptorError({
      fd,
      operation: "fcntl",
      message: `EBADF: bad file descriptor, fcntl ${fd}`
    }));
  }
  setCloseOnExec(fd, closeOnExec) {
    if (!this.descriptors.has(fd)) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd,
        operation: "fcntl",
        message: `EBADF: bad file descriptor, fcntl ${fd}`
      }));
    }
    if (closeOnExec) this.closeOnExecDescriptors.add(fd);
    else this.closeOnExecDescriptors.delete(fd);
    return _void;
  }
  getNonblocking(fd) {
    const descriptor2 = this.descriptors.get(fd);
    return descriptor2 ? succeed5(statusFor(descriptor2).nonblocking) : fail6(new TraceKernelBadFileDescriptorError({
      fd,
      operation: "fcntl",
      message: `EBADF: bad file descriptor, fcntl ${fd}`
    }));
  }
  setNonblocking(fd, nonblocking) {
    const descriptor2 = this.descriptors.get(fd);
    if (!descriptor2) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd,
        operation: "fcntl",
        message: `EBADF: bad file descriptor, fcntl ${fd}`
      }));
    }
    statusFor(descriptor2).nonblocking = nonblocking;
    return _void;
  }
  readiness(fd, events) {
    const descriptor2 = this.descriptors.get(fd);
    if (!descriptor2) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd,
        operation: "poll",
        message: `EBADF: bad file descriptor, poll ${fd}`
      }));
    }
    if (descriptor2.readiness) {
      return descriptor2.readiness(events, this.operationContext?.()).pipe(
        mapError2((error) => new TraceKernelBadFileDescriptorError({
          fd,
          operation: "poll",
          message: error.message
        }))
      );
    }
    return succeed5(Object.freeze({
      read: events.read && descriptor2.kind === "file" && Boolean(descriptor2.read),
      write: events.write && descriptor2.kind === "file" && Boolean(descriptor2.write),
      hangup: false,
      error: false
    }));
  }
  awaitReadiness(fd, events) {
    const descriptor2 = this.descriptors.get(fd);
    if (!descriptor2) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd,
        operation: "poll",
        message: `EBADF: bad file descriptor, poll ${fd}`
      }));
    }
    if (descriptor2.awaitReadiness) {
      return descriptor2.awaitReadiness(events, this.operationContext?.()).pipe(
        mapError2((error) => new TraceKernelBadFileDescriptorError({
          fd,
          operation: "poll",
          message: error.message
        }))
      );
    }
    if (descriptor2.kind === "file") return this.readiness(fd, events);
    return never3;
  }
  read(fd, maxBytes, position) {
    const descriptor2 = this.descriptors.get(fd);
    if (!descriptor2) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd,
        operation: "read",
        message: `EBADF: bad file descriptor, read ${fd}`
      }));
    }
    if (!descriptor2.read) {
      return fail6(new TraceKernelInvalidDescriptorOperationError({
        fd,
        operation: "read",
        message: `EBADF: descriptor ${fd} is not readable`
      }));
    }
    const read = statusFor(descriptor2).nonblocking && descriptor2.readNonblocking ? descriptor2.readNonblocking : descriptor2.read;
    return read(
      Math.max(0, Math.floor(maxBytes)),
      position === void 0 ? void 0 : Math.max(0, Math.floor(position)),
      this.operationContext?.()
    ).pipe(
      mapError2((error) => error instanceof TraceKernelBadFileDescriptorError || error instanceof TraceKernelTerminalError || error instanceof TraceKernelWouldBlockError ? error : new TraceKernelBadFileDescriptorError({
        fd,
        operation: "read",
        message: error.message
      }))
    );
  }
  write(fd, bytes, position) {
    const descriptor2 = this.descriptors.get(fd);
    if (!descriptor2) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd,
        operation: "write",
        message: `EBADF: bad file descriptor, write ${fd}`
      }));
    }
    if (!descriptor2.write) {
      return fail6(new TraceKernelInvalidDescriptorOperationError({
        fd,
        operation: "write",
        message: `EBADF: descriptor ${fd} is not writable`
      }));
    }
    const write = statusFor(descriptor2).nonblocking && descriptor2.writeNonblocking ? descriptor2.writeNonblocking : descriptor2.write;
    return write(
      Uint8Array.from(bytes),
      position === void 0 ? void 0 : Math.max(0, Math.floor(position)),
      this.operationContext?.()
    ).pipe(
      mapError2((error) => error instanceof TraceKernelBrokenPipeError || error instanceof TraceKernelTerminalError || error instanceof TraceKernelWouldBlockError ? error : new TraceKernelBadFileDescriptorError({
        fd,
        operation: "write",
        message: error.message
      }))
    );
  }
  seek(fd, offset, whence) {
    const descriptor2 = this.descriptors.get(fd);
    if (!descriptor2?.seek) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd,
        operation: "seek",
        message: `EBADF: descriptor ${fd} does not support seek`
      }));
    }
    if (!Number.isSafeInteger(offset)) {
      return fail6(new TraceKernelInvalidArgumentError({
        code: "EINVAL",
        argument: "offset",
        message: `EINVAL: invalid seek offset ${offset}`
      }));
    }
    return descriptor2.seek(offset, whence).pipe(
      mapError2((error) => error instanceof TraceKernelInvalidArgumentError ? error : new TraceKernelBadFileDescriptorError({
        fd,
        operation: "seek",
        message: error.message
      }))
    );
  }
  stat(fd) {
    const descriptor2 = this.descriptors.get(fd);
    if (!descriptor2?.stat) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd,
        operation: "stat",
        message: `EBADF: descriptor ${fd} does not support fstat`
      }));
    }
    return descriptor2.stat().pipe(
      mapError2((error) => new TraceKernelBadFileDescriptorError({
        fd,
        operation: "stat",
        message: error.message
      }))
    );
  }
  truncate(fd, length3) {
    const descriptor2 = this.descriptors.get(fd);
    if (!descriptor2?.truncate) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd,
        operation: "truncate",
        message: `EBADF: descriptor ${fd} does not support ftruncate`
      }));
    }
    return descriptor2.truncate(
      Math.max(0, Math.floor(length3)),
      this.operationContext?.()
    ).pipe(
      mapError2((error) => new TraceKernelBadFileDescriptorError({
        fd,
        operation: "truncate",
        message: error.message
      }))
    );
  }
  dup(fd) {
    const descriptor2 = this.descriptors.get(fd);
    if (!descriptor2) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd,
        operation: "dup",
        message: `EBADF: bad file descriptor, dup ${fd}`
      }));
    }
    return descriptor2.duplicate().pipe(
      map11((duplicate) => shareStatus(descriptor2, duplicate)),
      mapError2((error) => new TraceKernelBadFileDescriptorError({
        fd,
        operation: "dup",
        message: error.message
      })),
      flatMap9((duplicate) => this.installEffect(duplicate))
    );
  }
  dup2(fd, targetFd) {
    return this.duplicateTo(fd, targetFd, false, true);
  }
  dup3(fd, targetFd, closeOnExec) {
    return this.duplicateTo(fd, targetFd, closeOnExec, false);
  }
  duplicateTo(fd, targetFd, closeOnExec, allowSameDescriptor) {
    const descriptor2 = this.descriptors.get(fd);
    if (!descriptor2) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd,
        operation: allowSameDescriptor ? "dup2" : "dup3",
        message: `EBADF: bad file descriptor, ${allowSameDescriptor ? "dup2" : "dup3"} ${fd}`
      }));
    }
    const target = Math.floor(targetFd);
    if (!Number.isSafeInteger(targetFd) || target < 0) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd: target,
        operation: allowSameDescriptor ? "dup2" : "dup3",
        message: `EBADF: invalid target descriptor ${targetFd}`
      }));
    }
    if (fd === target) {
      return allowSameDescriptor ? succeed5(target) : fail6(new TraceKernelInvalidArgumentError({
        code: "EINVAL",
        argument: "targetFd",
        message: `EINVAL: dup3 source and target are both ${fd}`
      }));
    }
    const replaced = this.descriptors.get(target);
    if (!replaced && this.descriptors.size >= this.maxDescriptors) {
      return fail6(new TraceKernelDescriptorLimitError({
        code: "EMFILE",
        maxDescriptors: this.maxDescriptors,
        message: `EMFILE: process descriptor limit ${this.maxDescriptors} reached`
      }));
    }
    return descriptor2.duplicate().pipe(
      map11((duplicate) => shareStatus(descriptor2, duplicate)),
      mapError2((error) => new TraceKernelBadFileDescriptorError({
        fd,
        operation: allowSameDescriptor ? "dup2" : "dup3",
        message: error.message
      })),
      flatMap9(
        (duplicate) => sync3(() => {
          this.descriptors.set(target, duplicate);
          if (closeOnExec) this.closeOnExecDescriptors.add(target);
          else this.closeOnExecDescriptors.delete(target);
          this.resetNextFd();
        }).pipe(
          andThen4(replaced ? replaced.close() : _void),
          as4(target)
        )
      )
    );
  }
  /**
   * Duplicate selected descriptors from a parent table while preserving their
   * numeric descriptor identities.
   *
   * All source descriptors are validated and all duplicate references are
   * acquired before the child table is mutated. A failure closes every
   * provisional reference, leaving the target table unchanged.
   */
  inherit(source, fds) {
    return try_2({
      try: () => {
        const selectedFds = fds === void 0 ? [...source.descriptors.keys()].filter((fd) => !source.closeOnExecDescriptors.has(fd)).sort((left3, right3) => left3 - right3) : [...new Set(fds.map((fd) => Math.floor(fd)))].sort((left3, right3) => left3 - right3);
        return selectedFds.map((fd) => {
          const descriptor2 = source.descriptors.get(fd);
          if (!descriptor2) {
            throw new TraceKernelBadFileDescriptorError({
              fd,
              operation: "inherit",
              message: `EBADF: bad file descriptor, inherit ${fd}`
            });
          }
          return [fd, descriptor2];
        });
      },
      catch: (error) => this.inheritanceError(error)
    }).pipe(
      flatMap9((selected) => this.inheritSelected(selected))
    );
  }
  inheritMapped(source, mappings) {
    return try_2({
      try: () => {
        const targets = /* @__PURE__ */ new Set();
        return mappings.map(({ sourceFd, targetFd }) => {
          const sourceNumber = Math.floor(sourceFd);
          const targetNumber = Math.floor(targetFd);
          if (!Number.isSafeInteger(sourceFd) || !Number.isSafeInteger(targetFd) || sourceNumber < 0 || targetNumber < 0) {
            throw new TraceKernelBadFileDescriptorError({
              fd: targetNumber,
              operation: "inherit",
              message: `EBADF: invalid descriptor mapping ${sourceFd} -> ${targetFd}`
            });
          }
          if (targets.has(targetNumber)) {
            throw new TraceKernelBadFileDescriptorError({
              fd: targetNumber,
              operation: "inherit",
              message: `EBADF: duplicate child descriptor mapping ${targetNumber}`
            });
          }
          targets.add(targetNumber);
          const descriptor2 = source.descriptors.get(sourceNumber);
          if (!descriptor2) {
            throw new TraceKernelBadFileDescriptorError({
              fd: sourceNumber,
              operation: "inherit",
              message: `EBADF: bad parent descriptor, inherit ${sourceNumber}`
            });
          }
          return [targetNumber, descriptor2];
        });
      },
      catch: (error) => this.inheritanceError(error)
    }).pipe(
      flatMap9((selected) => this.inheritSelected(selected))
    );
  }
  inheritSelected(selected) {
    return gen2(this, function* () {
      if (this.descriptors.size + selected.length > this.maxDescriptors) {
        return yield* fail6(new TraceKernelDescriptorLimitError({
          code: "EMFILE",
          maxDescriptors: this.maxDescriptors,
          message: `EMFILE: inherited descriptors exceed process descriptor limit ${this.maxDescriptors}`
        }));
      }
      for (const [fd] of selected) {
        if (this.descriptors.has(fd)) {
          return yield* fail6(new TraceKernelDescriptorLimitError({
            code: "EMFILE",
            maxDescriptors: this.maxDescriptors,
            message: `EMFILE: target descriptor ${fd} is already occupied`
          }));
        }
      }
      const duplicates = [];
      yield* forEach7(
        selected,
        ([fd, descriptor2]) => descriptor2.duplicate().pipe(
          map11((duplicate) => shareStatus(descriptor2, duplicate)),
          tap2((duplicate) => sync3(() => {
            duplicates.push([fd, duplicate]);
          })),
          mapError2((error) => new TraceKernelBadFileDescriptorError({
            fd,
            operation: "inherit",
            message: error.message
          }))
        ),
        { concurrency: 1, discard: true }
      ).pipe(
        onError2(
          () => forEach7(
            duplicates,
            ([, duplicate]) => duplicate.close(),
            { concurrency: "unbounded", discard: true }
          )
        )
      );
      for (const [fd, duplicate] of duplicates) {
        this.descriptors.set(fd, duplicate);
      }
      this.resetNextFd();
    });
  }
  inheritanceError(error) {
    return error instanceof TraceKernelBadFileDescriptorError ? error : new TraceKernelBadFileDescriptorError({
      fd: -1,
      operation: "inherit",
      message: error instanceof Error ? error.message : String(error)
    });
  }
  close(fd) {
    const descriptor2 = this.descriptors.get(fd);
    if (!descriptor2) {
      return fail6(new TraceKernelBadFileDescriptorError({
        fd,
        operation: "close",
        message: `EBADF: bad file descriptor, close ${fd}`
      }));
    }
    this.descriptors.delete(fd);
    this.closeOnExecDescriptors.delete(fd);
    if (fd < this.nextFd) this.nextFd = fd;
    return descriptor2.close();
  }
  closeAll() {
    return suspend3(() => {
      const descriptors = [...this.descriptors.values()];
      this.descriptors.clear();
      this.closeOnExecDescriptors.clear();
      this.nextFd = 3;
      return forEach7(
        descriptors,
        (descriptor2) => descriptor2.close(),
        { concurrency: "unbounded", discard: true }
      );
    });
  }
  resetNextFd() {
    this.nextFd = 3;
    while (this.descriptors.has(this.nextFd)) this.nextFd += 1;
  }
  installEffect(descriptor2) {
    return try_2({
      try: () => this.install(descriptor2),
      catch: (error) => error instanceof TraceKernelDescriptorLimitError ? error : new TraceKernelDescriptorLimitError({
        code: "EMFILE",
        maxDescriptors: this.maxDescriptors,
        message: error instanceof Error ? error.message : String(error)
      })
    }).pipe(
      tapError2(() => descriptor2.close())
    );
  }
};
var TraceKernelPipe = class _TraceKernelPipe {
  constructor(id2, chunks, readerClosed, writerClosed, readinessChanged, readMutex, onFullyClosed) {
    this.id = id2;
    this.chunks = chunks;
    this.readerClosed = readerClosed;
    this.writerClosed = writerClosed;
    this.readinessChanged = readinessChanged;
    this.readMutex = readMutex;
    this.onFullyClosed = onFullyClosed;
  }
  remainder = new Uint8Array(0);
  readerIsClosed = false;
  writerIsClosed = false;
  readerReferences = 1;
  writerReferences = 1;
  static make(id2, options = {}, onFullyClosed = () => void 0) {
    return gen2(function* () {
      const chunks = yield* bounded3(
        Math.max(1, Math.floor(options.capacityChunks ?? 16))
      );
      const readerClosed = yield* make33();
      const writerClosed = yield* make33();
      const readinessChanged = yield* make33();
      const readMutex = yield* makeSemaphore2(1);
      return new _TraceKernelPipe(
        id2,
        chunks,
        readerClosed,
        writerClosed,
        readinessChanged,
        readMutex,
        onFullyClosed
      );
    });
  }
  reader() {
    return {
      kind: "pipe-reader",
      resourceId: this.id,
      read: (maxBytes) => this.read(maxBytes).pipe(
        tap2(() => this.notifyReadiness())
      ),
      readNonblocking: (maxBytes) => this.readNonblocking(maxBytes).pipe(
        tap2(() => this.notifyReadiness())
      ),
      readiness: (events) => this.pipeReadiness("reader", events),
      awaitReadiness: (events) => this.awaitPipeReadiness("reader", events),
      duplicate: () => this.duplicateReader(),
      close: () => this.closeReader()
    };
  }
  writer() {
    return {
      kind: "pipe-writer",
      resourceId: this.id,
      write: (bytes) => this.write(bytes).pipe(
        tap2(() => this.notifyReadiness())
      ),
      writeNonblocking: (bytes) => this.writeNonblocking(bytes).pipe(
        tap2(() => this.notifyReadiness())
      ),
      readiness: (events) => this.pipeReadiness("writer", events),
      awaitReadiness: (events) => this.awaitPipeReadiness("writer", events),
      duplicate: () => this.duplicateWriter(),
      close: () => this.closeWriter()
    };
  }
  dispose() {
    return all3([
      this.closeReader(),
      this.closeWriter()
    ], { concurrency: "unbounded", discard: true }).pipe(
      andThen4(shutdown2(this.chunks))
    );
  }
  read(maxBytes) {
    if (maxBytes === 0) return succeed5(new Uint8Array(0));
    return this.readMutex.withPermits(1)(
      suspend3(() => {
        if (this.readerIsClosed) return this.readerClosedError();
        if (this.remainder.byteLength > 0) return succeed5(this.takeRemainder(maxBytes));
        return poll4(this.chunks).pipe(
          flatMap9((available) => isSome2(available) ? succeed5(this.takeBytes(available.value, maxBytes)) : this.awaitReadEvent(maxBytes))
        );
      })
    );
  }
  readNonblocking(maxBytes) {
    if (maxBytes === 0) return succeed5(new Uint8Array(0));
    return this.readMutex.withPermits(1)(
      suspend3(() => {
        if (this.readerIsClosed) return this.readerClosedError();
        if (this.remainder.byteLength > 0) {
          return succeed5(this.takeRemainder(maxBytes));
        }
        return poll4(this.chunks).pipe(
          flatMap9((available) => {
            if (isSome2(available)) {
              return succeed5(this.takeBytes(available.value, maxBytes));
            }
            if (this.writerIsClosed) return succeed5(new Uint8Array(0));
            return fail6(new TraceKernelWouldBlockError({
              code: "EAGAIN",
              operation: "read",
              message: "EAGAIN: nonblocking pipe read would block"
            }));
          })
        );
      })
    );
  }
  awaitReadEvent(maxBytes) {
    return suspend3(() => {
      const changed = this.readinessChanged;
      if (this.readerIsClosed) return this.readerClosedError();
      return poll4(this.chunks).pipe(
        flatMap9((available) => {
          if (isSome2(available)) {
            return succeed5(this.takeBytes(available.value, maxBytes));
          }
          if (this.readerIsClosed) return this.readerClosedError();
          if (this.writerIsClosed) return succeed5(new Uint8Array(0));
          return _await3(changed).pipe(
            andThen4(this.awaitReadEvent(maxBytes))
          );
        })
      );
    });
  }
  write(bytes) {
    return suspend3(() => {
      if (this.writerIsClosed || this.readerIsClosed) return this.brokenPipeError();
      if (bytes.byteLength === 0) return succeed5(0);
      return raceFirst2(
        offer3(this.chunks, Uint8Array.from(bytes)).pipe(as4(bytes.byteLength)),
        _await3(this.readerClosed).pipe(
          andThen4(this.brokenPipeError())
        )
      );
    });
  }
  writeNonblocking(bytes) {
    return suspend3(() => {
      if (this.writerIsClosed || this.readerIsClosed) return this.brokenPipeError();
      if (bytes.byteLength === 0) return succeed5(0);
      return isFull2(this.chunks).pipe(
        flatMap9((full) => full ? fail6(new TraceKernelWouldBlockError({
          code: "EAGAIN",
          operation: "write",
          message: "EAGAIN: nonblocking pipe write would block"
        })) : offer3(this.chunks, Uint8Array.from(bytes)).pipe(
          as4(bytes.byteLength)
        ))
      );
    });
  }
  pipeReadiness(endpoint, events) {
    return all3({
      empty: isEmpty9(this.chunks),
      full: isFull2(this.chunks)
    }).pipe(
      map11(({ empty: empty25, full }) => {
        const hangup = endpoint === "reader" ? this.writerIsClosed : this.readerIsClosed;
        return Object.freeze({
          read: endpoint === "reader" && events.read && (this.remainder.byteLength > 0 || !empty25 || this.writerIsClosed),
          write: endpoint === "writer" && events.write && !this.readerIsClosed && !full,
          hangup,
          error: endpoint === "writer" && this.readerIsClosed
        });
      })
    );
  }
  awaitPipeReadiness(endpoint, events) {
    return suspend3(() => {
      const changed = this.readinessChanged;
      return this.pipeReadiness(endpoint, events).pipe(
        flatMap9(
          (readiness) => readiness.read || readiness.write || readiness.hangup || readiness.error ? succeed5(readiness) : _await3(changed).pipe(
            andThen4(this.awaitPipeReadiness(endpoint, events))
          )
        )
      );
    });
  }
  notifyReadiness() {
    return gen2(this, function* () {
      const previous = this.readinessChanged;
      const next = yield* make33();
      this.readinessChanged = next;
      yield* succeed4(previous, void 0);
    });
  }
  closeReader() {
    return suspend3(() => {
      if (this.readerIsClosed) return _void;
      this.readerReferences -= 1;
      if (this.readerReferences > 0) return _void;
      this.readerIsClosed = true;
      return succeed4(this.readerClosed, void 0).pipe(
        asVoid2,
        tap2(() => this.notifyReadiness()),
        tap2(() => sync3(() => this.notifyIfFullyClosed()))
      );
    });
  }
  closeWriter() {
    return suspend3(() => {
      if (this.writerIsClosed) return _void;
      this.writerReferences -= 1;
      if (this.writerReferences > 0) return _void;
      this.writerIsClosed = true;
      return succeed4(this.writerClosed, void 0).pipe(
        asVoid2,
        tap2(() => this.notifyReadiness()),
        tap2(() => sync3(() => this.notifyIfFullyClosed()))
      );
    });
  }
  duplicateReader() {
    return suspend3(() => {
      if (this.readerIsClosed) {
        return fail6(new Error("EBADF: pipe reader is closed"));
      }
      this.readerReferences += 1;
      return succeed5(this.reader());
    });
  }
  duplicateWriter() {
    return suspend3(() => {
      if (this.writerIsClosed) {
        return fail6(new Error("EBADF: pipe writer is closed"));
      }
      this.writerReferences += 1;
      return succeed5(this.writer());
    });
  }
  takeBytes(bytes, maxBytes) {
    if (bytes.byteLength <= maxBytes) return bytes;
    const result = bytes.slice(0, maxBytes);
    this.remainder = bytes.slice(maxBytes);
    return result;
  }
  takeRemainder(maxBytes) {
    const result = this.remainder.slice(0, maxBytes);
    this.remainder = this.remainder.slice(result.byteLength);
    return result;
  }
  notifyIfFullyClosed() {
    if (this.readerIsClosed && this.writerIsClosed) this.onFullyClosed(this.id);
  }
  readerClosedError() {
    return fail6(new TraceKernelBadFileDescriptorError({
      fd: -1,
      operation: "read",
      message: "EBADF: pipe reader is closed"
    }));
  }
  brokenPipeError() {
    return fail6(new TraceKernelBrokenPipeError({
      message: "EPIPE: broken pipe"
    }));
  }
};

// packages/tracekernel/src/controlled-runtime.ts
var TraceKernelControlledRuntime = class {
  constructor(runtime3) {
    this.runtime = runtime3;
    if (runtime3.trim().length === 0) {
      throw new Error("TraceKernel controlled runtime name must not be empty.");
    }
    this.provider = Object.freeze({
      runtime: runtime3,
      initialize: succeed5({
        acquire: (context2) => this.attach(context2)
      })
    });
  }
  provider;
  entries = /* @__PURE__ */ new Map();
  attachmentWaiters = /* @__PURE__ */ new Map();
  awaitAttached(pid) {
    return suspend3(() => {
      const entry = this.entries.get(pid);
      if (entry) return succeed5(entry.context);
      const existing = this.attachmentWaiters.get(pid);
      if (existing) return _await3(existing);
      return make33().pipe(
        tap2(
          (waiter) => sync3(() => {
            this.attachmentWaiters.set(pid, waiter);
          })
        ),
        flatMap9(_await3)
      );
    });
  }
  complete(pid, result) {
    return suspend3(() => {
      const entry = this.entries.get(pid);
      return entry ? succeed4(entry.completion, Object.freeze({ ...result })) : succeed5(false);
    });
  }
  fail(pid, error) {
    return suspend3(() => {
      const entry = this.entries.get(pid);
      return entry ? fail5(entry.completion, error) : succeed5(false);
    });
  }
  setSignalHandler(pid, handler) {
    return suspend3(() => {
      const entry = this.entries.get(pid);
      if (!entry) {
        return fail6(
          new Error(`TraceKernel process ${pid} has no attached ${this.runtime} runtime lease.`)
        );
      }
      entry.signalHandler = handler;
      return succeed5(() => {
        if (entry.signalHandler === handler) delete entry.signalHandler;
      });
    });
  }
  setLeaseHandler(pid, handler) {
    return suspend3(() => {
      const entry = this.entries.get(pid);
      if (!entry) {
        return fail6(
          new Error(`TraceKernel process ${pid} has no attached ${this.runtime} runtime lease.`)
        );
      }
      if (entry.leaseHandler && entry.leaseHandler !== handler) {
        return fail6(
          new Error(`TraceKernel process ${pid} already has a controlled lease handler.`)
        );
      }
      entry.leaseHandler = handler;
      return succeed5(() => {
        if (entry.leaseHandler === handler) delete entry.leaseHandler;
      });
    });
  }
  attachedPids() {
    return Object.freeze([...this.entries.keys()].sort((left3, right3) => left3 - right3));
  }
  attach(context2) {
    return gen2(this, function* () {
      if (this.entries.has(context2.pid)) {
        const existing = this.entries.get(context2.pid);
        return yield* fail6(
          new Error(
            `TraceKernel process ${context2.pid} already has a controlled runtime lease for ${JSON.stringify(existing.context.command)} while attaching ${JSON.stringify(context2.command)}.`
          )
        );
      }
      const completion = yield* make33();
      const entry = {
        context: context2,
        completion
      };
      this.entries.set(context2.pid, entry);
      const waiter = this.attachmentWaiters.get(context2.pid);
      this.attachmentWaiters.delete(context2.pid);
      if (waiter) yield* succeed4(waiter, context2);
      return {
        id: `${this.runtime}-${context2.pid}`,
        runtime: this.runtime,
        execute: () => _await3(completion),
        signal: (signal) => {
          const current = this.entries.get(context2.pid);
          if (current !== entry || !entry.signalHandler) {
            return fail6(
              new Error(
                `TraceKernel process ${context2.pid} has no controlled signal handler.`
              )
            );
          }
          return tryPromise2({
            try: () => Promise.resolve(entry.signalHandler(signal)),
            catch: (error) => error instanceof Error ? error : new Error(String(error))
          });
        },
        revalidate: () => {
          const current = this.entries.get(context2.pid);
          if (current !== entry || !entry.leaseHandler?.revalidate) {
            return fail6(
              new Error(
                `TraceKernel process ${context2.pid} has no controlled runtime revalidation handler.`
              )
            );
          }
          return tryPromise2({
            try: () => Promise.resolve(entry.leaseHandler.revalidate()),
            catch: (error) => error instanceof Error ? error : new Error(String(error))
          });
        },
        release: (disposition) => this.release(context2.pid, disposition)
      };
    });
  }
  release(pid, disposition) {
    return suspend3(() => {
      const entry = this.entries.get(pid);
      if (!entry) return _void;
      this.entries.delete(pid);
      if (!entry.leaseHandler) return _void;
      return tryPromise2({
        try: () => Promise.resolve(entry.leaseHandler.release(disposition)),
        catch: () => void 0
      }).pipe(catchAll2(() => _void));
    });
  }
};

// packages/tracekernel/src/devices.ts
var NULL_STAT = Object.freeze({
  path: "/dev/null",
  kind: "file",
  inode: 2,
  nlink: 1,
  mode: 8630,
  size: 0,
  generation: 0,
  createdAt: 0,
  modifiedAt: 0,
  changedAt: 0
});
function makeTraceKernelNullDescriptor(resourceId, access) {
  const descriptor2 = () => ({
    kind: "device",
    resourceId,
    ...access === "write" ? {} : {
      read: () => succeed5(new Uint8Array()),
      readNonblocking: () => succeed5(new Uint8Array())
    },
    ...access === "read" ? {} : {
      write: (bytes) => succeed5(bytes.byteLength),
      writeNonblocking: (bytes) => succeed5(bytes.byteLength)
    },
    readiness: (events) => succeed5({
      read: events.read && access !== "write",
      write: events.write && access !== "read",
      hangup: false,
      error: false
    }),
    awaitReadiness: (events) => succeed5({
      read: events.read && access !== "write",
      write: events.write && access !== "read",
      hangup: false,
      error: false
    }),
    stat: () => succeed5(NULL_STAT),
    duplicate: () => succeed5(descriptor2()),
    close: () => _void
  });
  return descriptor2();
}

// packages/tracekernel/src/kernel/process.ts
var SYSTEM_PRINCIPAL = Object.freeze({
  id: "system",
  kind: "system"
});
function signalExitCode(signal) {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGQUIT") return 131;
  if (signal === "SIGTERM") return 143;
  return 137;
}
function immutableSnapshot(record) {
  return Object.freeze({
    pid: record.pid,
    ppid: record.ppid,
    pgid: record.pgid,
    sid: record.sid,
    ...record.controllingTerminalId === void 0 ? {} : { controllingTerminalId: record.controllingTerminalId },
    phase: record.phase,
    schedulingState: record.schedulingState,
    runtime: record.runtime,
    command: record.command,
    args: Object.freeze([...record.args]),
    cwd: record.cwd,
    env: Object.freeze({ ...record.env }),
    owner: record.owner,
    protected: record.protected,
    visible: record.visible,
    ...record.startedAt === void 0 ? {} : { startedAt: record.startedAt },
    ...record.endedAt === void 0 ? {} : { endedAt: record.endedAt },
    ...record.termination === void 0 ? {} : { termination: record.termination },
    stdout: record.stdout,
    stderr: record.stderr,
    descriptors: Object.freeze([]),
    ...record.watchdog ? { watchdog: Object.freeze({ ...record.watchdog }) } : {}
  });
}
function processInfoProjection(snapshot) {
  return Object.freeze({
    pid: snapshot.pid,
    ppid: snapshot.ppid,
    pgid: snapshot.pgid,
    sid: snapshot.sid,
    phase: snapshot.phase,
    runtime: snapshot.runtime,
    command: snapshot.command,
    args: snapshot.args,
    ...snapshot.startedAt === void 0 ? {} : { startedAt: snapshot.startedAt }
  });
}
var TraceKernelProcess = class {
  constructor(record, started, maxDescriptors, signalGracePeriodMs) {
    this.record = record;
    this.started = started;
    this.signalGracePeriodMs = signalGracePeriodMs;
    this.fileSystemMutationOrigin = Object.freeze({
      get pid() {
        return record.pid;
      },
      get pgid() {
        return record.pgid;
      },
      get sid() {
        return record.sid;
      }
    });
    this.descriptors = new TraceKernelDescriptorTable({
      maxDescriptors,
      operationContext: () => this.fileSystemMutationOrigin
    });
  }
  fiber;
  runtimeLease;
  requestedSignal;
  pendingSignal;
  fileSystemMutationOrigin;
  descriptors;
  get pid() {
    return this.record.pid;
  }
  setWatchdog(watchdog) {
    if (watchdog) this.record.watchdog = Object.freeze({ ...watchdog });
    else delete this.record.watchdog;
  }
  reparent(exitedParentPid, replacementPid) {
    if (this.record.ppid === exitedParentPid) {
      this.record.ppid = replacementPid;
    }
  }
  setTopology(pgid, sid) {
    this.record.pgid = pgid;
    this.record.sid = sid;
  }
  setControllingTerminal(terminalId) {
    if (terminalId === void 0) delete this.record.controllingTerminalId;
    else this.record.controllingTerminalId = terminalId;
  }
  setSchedulingState(state) {
    this.record.schedulingState = state;
  }
  snapshot() {
    return Object.freeze({
      ...immutableSnapshot(this.record),
      ...this.pendingSignal === void 0 ? {} : { pendingSignal: this.pendingSignal },
      descriptors: Object.freeze([...this.descriptors.snapshots()])
    });
  }
  read(fd, maxBytes, position) {
    return this.descriptors.read(fd, maxBytes, position);
  }
  write(fd, bytes, position) {
    return this.descriptors.write(fd, bytes, position);
  }
  seek(fd, offset, whence) {
    return this.descriptors.seek(fd, offset, whence);
  }
  close(fd) {
    return this.descriptors.close(fd);
  }
  dup(fd) {
    return this.descriptors.dup(fd);
  }
  dup2(fd, targetFd) {
    return this.descriptors.dup2(fd, targetFd);
  }
  dup3(fd, targetFd, closeOnExec) {
    return this.descriptors.dup3(fd, targetFd, closeOnExec);
  }
  fstat(fd) {
    return this.descriptors.stat(fd);
  }
  ftruncate(fd, length3) {
    return this.descriptors.truncate(fd, length3);
  }
  wait() {
    return suspend3(() => {
      if (!this.fiber) {
        return fail6(new TraceKernelProcessStateError({
          pid: this.pid,
          message: `Process ${this.pid} has not started execution.`
        }));
      }
      return _await2(this.fiber).pipe(map11(() => this.snapshot()));
    });
  }
  awaitStarted() {
    return _await3(this.started);
  }
  signal(signal, requester = SYSTEM_PRINCIPAL) {
    return suspend3(() => {
      if (this.record.phase === "exited") return _void;
      if (this.record.protected && requester.kind !== "system" && (requester.id !== this.record.owner.id || requester.kind !== this.record.owner.kind)) {
        return fail6(new TraceKernelProcessPermissionError({
          code: "EACCES",
          pid: this.pid,
          requesterId: requester.id,
          message: `EACCES: actor ${requester.kind}:${requester.id} cannot signal protected process ${this.pid}`
        }));
      }
      if (signal === "SIGWINCH") {
        const runtimeLease2 = this.runtimeLease;
        if (!runtimeLease2?.signal) return _void;
        return runtimeLease2.signal(signal).pipe(
          // SIGWINCH has a POSIX default disposition of ignore. A runtime
          // without notification support must therefore remain alive.
          catchAll2(() => _void)
        );
      }
      this.requestedSignal = signal;
      this.pendingSignal = signal;
      const fiber = this.fiber;
      const runtimeLease = this.runtimeLease;
      if (signal === "SIGKILL" || !fiber || !runtimeLease?.signal || this.signalGracePeriodMs === 0) {
        return this.forceSignal(signal);
      }
      const completed = _await2(fiber).pipe(
        as4("completed")
      );
      const deliveryFailed = runtimeLease.signal(signal).pipe(
        tap2(
          () => sync3(() => {
            if (this.pendingSignal === signal) {
              this.pendingSignal = void 0;
            }
          })
        ),
        matchEffect2({
          onFailure: () => succeed5("delivery-failed"),
          onSuccess: () => never3
        })
      );
      const deadline = sleep4(this.signalGracePeriodMs).pipe(
        as4("deadline")
      );
      return raceAll2([completed, deliveryFailed, deadline]).pipe(
        flatMap9(
          (outcome) => outcome === "completed" ? _void : this.forceSignal(signal)
        )
      );
    });
  }
  attachFiber(fiber) {
    this.fiber = fiber;
  }
  markStarting() {
    this.record.phase = "starting";
  }
  failBeforeExecution(error) {
    return sync3(
      () => this.finish({
        kind: "failure",
        exitCode: 126,
        message: error.message
      }, "", error.message.length > 0 ? `${error.message}
` : "")
    ).pipe(
      andThen4(fail5(this.started, new TraceKernelProcessStateError({
        pid: this.pid,
        message: error.message
      }))),
      asVoid2
    );
  }
  execute(lease, context2) {
    return sync3(() => {
      this.runtimeLease = lease;
      this.record.phase = "running";
      this.record.schedulingState = "running";
      this.record.startedAt = Date.now();
    }).pipe(
      andThen4(succeed4(this.started, void 0)),
      andThen4(lease.execute(context2)),
      matchEffect2({
        onFailure: (error) => sync3(() => this.finish({
          kind: "failure",
          exitCode: 1,
          message: error.message
        }, "", error.message.length > 0 ? `${error.message}
` : "")),
        onSuccess: (result) => sync3(() => this.finish(
          result.termination ?? {
            kind: "exit",
            exitCode: result.exitCode
          },
          result.stdout ?? "",
          result.stderr ?? ""
        ))
      }),
      catchAllCause2(
        (cause2) => isInterruptedOnly2(cause2) ? failCause4(cause2) : sync3(() => this.finish({
          kind: "failure",
          exitCode: 1,
          message: "Runtime execution failed."
        }, "", "Runtime execution failed.\n"))
      ),
      onInterrupt2(
        () => sync3(() => {
          const signal = this.requestedSignal ?? "SIGTERM";
          this.finish({
            kind: "signal",
            signal,
            exitCode: signalExitCode(signal)
          }, this.record.stdout, this.record.stderr);
        })
      ),
      ensuring2(sync3(() => {
        if (this.runtimeLease === lease) this.runtimeLease = void 0;
      }))
    );
  }
  forceSignal(signal) {
    this.requestedSignal = signal;
    const recordSignalExit = sync3(
      () => this.finish({
        kind: "signal",
        signal,
        exitCode: signalExitCode(signal)
      }, this.record.stdout, this.record.stderr)
    ).pipe(
      andThen4(fail5(this.started, new TraceKernelProcessStateError({
        pid: this.pid,
        message: `Process ${this.pid} terminated before reaching running state.`
      }))),
      asVoid2
    );
    return this.fiber ? interrupt3(this.fiber).pipe(
      asVoid2,
      ensuring2(recordSignalExit)
    ) : recordSignalExit;
  }
  finish(termination, stdout, stderr) {
    if (this.record.phase === "exited") return this.snapshot();
    this.pendingSignal = void 0;
    this.record.phase = "exiting";
    this.record.termination = termination;
    this.record.stdout = stdout;
    this.record.stderr = stderr;
    this.record.endedAt = Date.now();
    this.record.phase = "exited";
    return this.snapshot();
  }
};

// packages/tracekernel/src/network.ts
function networkError(code, message) {
  return new TraceKernelNetworkError({ code, message: `${code}: ${message}` });
}
function normalizeHost(host) {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "127.0.0.1") {
    return "127.0.0.1";
  }
  if (normalized === "0.0.0.0") return normalized;
  return networkError(
    "EAFNOSUPPORT",
    `address ${JSON.stringify(host)} is outside the local IPv4 namespace`
  );
}
function normalizePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return networkError("EINVAL", `invalid TCP port ${String(port)}`);
  }
  return port;
}
var TraceKernelTcpSocket = class {
  constructor(id2, namespace, closed, readinessChanged, onFullyClosed) {
    this.id = id2;
    this.namespace = namespace;
    this.closed = closed;
    this.readinessChanged = readinessChanged;
    this.onFullyClosed = onFullyClosed;
  }
  references = 1;
  state = "new";
  boundAddress;
  localAddressValue;
  remoteAddressValue;
  endpoint;
  listener;
  readShutdown = false;
  writeShutdown = false;
  ownsBinding = false;
  connectError;
  connectFiber;
  connectToken;
  descriptor() {
    return {
      kind: "tcp-socket",
      resourceId: this.id,
      resource: this,
      read: (maxBytes) => this.read(maxBytes),
      readNonblocking: (maxBytes) => this.readNonblocking(maxBytes),
      write: (bytes) => this.write(bytes),
      writeNonblocking: (bytes) => this.writeNonblocking(bytes),
      readiness: (events) => this.readiness(events),
      awaitReadiness: (events) => this.awaitReadiness(events),
      duplicate: () => this.duplicate(),
      close: () => this.closeReference()
    };
  }
  get phase() {
    return this.state;
  }
  localAddress() {
    const address = this.localAddressValue ?? this.boundAddress;
    return address ? succeed5(Object.freeze({ ...address })) : fail6(networkError("EDESTADDRREQ", "socket has no local address"));
  }
  remoteAddress() {
    return this.remoteAddressValue ? succeed5(Object.freeze({ ...this.remoteAddressValue })) : fail6(networkError("ENOTCONN", "socket is not connected"));
  }
  bind(address) {
    if (this.state !== "new") {
      return fail6(networkError("EINVAL", "socket is already bound or connected"));
    }
    return this.namespace.bind(this, address).pipe(
      tap2((bound) => sync3(() => {
        this.boundAddress = bound;
        this.localAddressValue = bound;
        this.ownsBinding = true;
        this.state = "bound";
      }))
    );
  }
  listen(options = {}) {
    return suspend3(() => {
      if (this.state === "closed") {
        return fail6(networkError("EBADF", "socket is closed"));
      }
      if (this.state === "listening") return _void;
      if (this.state !== "bound") {
        return fail6(networkError("EDESTADDRREQ", "socket must be bound before listen"));
      }
      return gen2(this, function* () {
        const queue = yield* bounded3(
          Math.max(1, Math.floor(options.backlog ?? 128))
        );
        const closed = yield* make33();
        this.listener = { queue, closed };
        this.state = "listening";
        this.namespace.markListening(this, options.capacityChunks);
        yield* this.notifyReadiness();
      });
    });
  }
  accept() {
    return suspend3(() => {
      const listener = this.listener;
      if (this.state !== "listening" || !listener) {
        return fail6(networkError("EINVAL", "socket is not listening"));
      }
      return raceFirst2(
        take2(listener.queue),
        _await3(listener.closed).pipe(
          andThen4(fail6(networkError("EBADF", "listening socket is closed")))
        )
      ).pipe(
        tap2(() => this.notifyReadiness()),
        flatMap9((socket) => this.acceptedResult(socket))
      );
    });
  }
  acceptNonblocking() {
    return suspend3(() => {
      const listener = this.listener;
      if (this.state !== "listening" || !listener) {
        return fail6(networkError("EINVAL", "socket is not listening"));
      }
      return gen2(this, function* () {
        const socket = yield* poll4(listener.queue);
        if (isNone2(socket)) {
          return yield* fail6(new TraceKernelWouldBlockError({
            code: "EAGAIN",
            operation: "accept",
            message: "EAGAIN: no connection is ready to accept"
          }));
        }
        yield* this.notifyReadiness();
        return yield* this.acceptedResult(socket.value);
      });
    });
  }
  connect(address) {
    return suspend3(() => {
      if (this.state === "closed") {
        return fail6(networkError("EBADF", "socket is closed"));
      }
      if (this.state === "connected") {
        return fail6(networkError("EISCONN", "socket is already connected"));
      }
      if (this.state === "connecting") {
        return fail6(networkError("EALREADY", "socket connection is already in progress"));
      }
      if (this.state === "listening") {
        return fail6(networkError("EOPNOTSUPP", "listening socket cannot connect"));
      }
      this.connectError = void 0;
      this.state = "connecting";
      return raceFirst2(
        this.namespace.connect(this, address),
        _await3(this.closed).pipe(
          andThen4(fail6(networkError("EBADF", "socket closed during connect")))
        )
      ).pipe(
        tapError2(() => sync3(() => {
          this.state = this.boundAddress ? "bound" : "new";
        })),
        onInterrupt2(() => sync3(() => {
          if (this.state !== "closed") {
            this.state = this.boundAddress ? "bound" : "new";
          }
        }))
      );
    });
  }
  connectNonblocking(address) {
    return suspend3(() => {
      if (this.state === "closed") {
        return fail6(networkError("EBADF", "socket is closed"));
      }
      if (this.state === "connected") {
        return fail6(networkError("EISCONN", "socket is already connected"));
      }
      if (this.state === "connecting") {
        return fail6(networkError("EALREADY", "socket connection is already in progress"));
      }
      if (this.state === "listening") {
        return fail6(networkError("EOPNOTSUPP", "listening socket cannot connect"));
      }
      this.connectError = void 0;
      this.state = "connecting";
      const token = /* @__PURE__ */ Symbol(`connect-${this.id}`);
      this.connectToken = token;
      return gen2(this, function* () {
        const fiber = yield* this.namespace.fork(
          raceFirst2(
            this.namespace.connect(this, address),
            _await3(this.closed).pipe(
              andThen4(fail6(networkError(
                "EBADF",
                "socket closed during connect"
              )))
            )
          ).pipe(
            tapError2((error) => sync3(() => {
              if (this.state !== "closed") {
                this.state = this.boundAddress ? "bound" : "new";
                this.connectError = error;
              }
            })),
            matchEffect2({
              onFailure: () => _void,
              onSuccess: () => _void
            }),
            ensuring2(gen2(this, function* () {
              if (this.connectToken === token) {
                this.connectToken = void 0;
                this.connectFiber = void 0;
              }
              yield* this.notifyReadiness();
            }))
          )
        );
        if (this.connectToken === token) this.connectFiber = fiber;
        return yield* fail6(networkError(
          "EINPROGRESS",
          "socket connection is in progress"
        ));
      });
    });
  }
  /**
   * Implements the consume-on-read portion of `getsockopt(SO_ERROR)`.
   *
   * A pending connect reports no error until its completion becomes
   * observable through descriptor readiness. Once consumed, a failed socket
   * may be connected again.
   */
  takeConnectError() {
    return sync3(() => {
      const error = this.connectError;
      this.connectError = void 0;
      return error?.code;
    }).pipe(tap2(() => this.notifyReadiness()));
  }
  attachConnected(endpoint, localAddress, remoteAddress, ownsBinding) {
    return sync3(() => {
      this.endpoint = endpoint;
      this.localAddressValue = Object.freeze({ ...localAddress });
      this.remoteAddressValue = Object.freeze({ ...remoteAddress });
      this.ownsBinding = this.ownsBinding || ownsBinding;
      this.state = "connected";
    }).pipe(andThen4(this.notifyReadiness()));
  }
  reserveImplicitBinding(address) {
    this.localAddressValue = Object.freeze({ ...address });
    this.ownsBinding = true;
  }
  clearImplicitBinding() {
    if (this.boundAddress) return;
    this.localAddressValue = void 0;
    this.ownsBinding = false;
  }
  enqueue(socket) {
    const listener = this.listener;
    if (this.state !== "listening" || !listener) {
      return fail6(networkError("ECONNREFUSED", "target port is not listening"));
    }
    return raceFirst2(
      offer3(listener.queue, socket).pipe(asVoid2),
      _await3(listener.closed).pipe(
        andThen4(fail6(networkError("ECONNREFUSED", "listener closed during connect")))
      )
    ).pipe(tap2(() => this.notifyReadiness()));
  }
  shutdown(how) {
    return suspend3(() => {
      if (this.state !== "connected" || !this.endpoint) {
        return fail6(networkError("ENOTCONN", "socket is not connected"));
      }
      const effects = [];
      if ((how === "read" || how === "both") && !this.readShutdown) {
        this.readShutdown = true;
        effects.push(this.endpoint.reader.close());
      }
      if ((how === "write" || how === "both") && !this.writeShutdown) {
        this.writeShutdown = true;
        effects.push(this.endpoint.writer.close());
      }
      return all3(effects, { concurrency: "unbounded", discard: true }).pipe(
        andThen4(this.notifyReadiness())
      );
    });
  }
  dispose() {
    return suspend3(() => {
      if (this.state === "closed") return _void;
      this.state = "closed";
      this.references = 0;
      const listener = this.listener;
      this.listener = void 0;
      const endpoint = this.endpoint;
      this.endpoint = void 0;
      const connectFiber = this.connectFiber;
      this.connectFiber = void 0;
      this.connectToken = void 0;
      this.connectError = void 0;
      const notifyClosed = succeed4(this.closed, void 0).pipe(asVoid2);
      const closeListener = listener ? succeed4(listener.closed, void 0).pipe(
        asVoid2,
        andThen4(takeAll2(listener.queue)),
        flatMap9((queued) => forEach7(
          queued,
          (socket) => socket.dispose(),
          { concurrency: "unbounded", discard: true }
        )),
        ensuring2(shutdown2(listener.queue))
      ) : _void;
      const closeEndpoint = endpoint ? all3([
        this.readShutdown ? _void : endpoint.reader.close(),
        this.writeShutdown ? _void : endpoint.writer.close()
      ], { concurrency: "unbounded", discard: true }) : _void;
      return all3([
        notifyClosed,
        this.notifyReadiness(),
        connectFiber ? interrupt3(connectFiber).pipe(asVoid2) : _void,
        closeListener,
        closeEndpoint,
        this.ownsBinding ? this.namespace.releaseBinding(this) : _void
      ], { concurrency: "unbounded", discard: true }).pipe(
        ensuring2(sync3(() => this.onFullyClosed(this.id)))
      );
    });
  }
  read(maxBytes) {
    if (this.state !== "connected" || !this.endpoint) {
      return fail6(networkError("ENOTCONN", "socket is not connected"));
    }
    if (this.readShutdown) {
      return fail6(networkError("EBADF", "socket read side is shut down"));
    }
    return this.endpoint.reader.read?.(maxBytes) ?? fail6(networkError("EBADF", "socket is not readable"));
  }
  write(bytes) {
    if (this.state !== "connected" || !this.endpoint) {
      return fail6(networkError("ENOTCONN", "socket is not connected"));
    }
    if (this.writeShutdown) {
      return fail6(networkError("EBADF", "socket write side is shut down"));
    }
    return this.endpoint.writer.write?.(bytes) ?? fail6(networkError("EBADF", "socket is not writable"));
  }
  readNonblocking(maxBytes) {
    if (this.state !== "connected" || !this.endpoint) {
      return fail6(networkError("ENOTCONN", "socket is not connected"));
    }
    if (this.readShutdown) {
      return fail6(networkError("EBADF", "socket read side is shut down"));
    }
    return this.endpoint.reader.readNonblocking?.(maxBytes) ?? fail6(networkError("EBADF", "socket is not nonblocking-readable"));
  }
  writeNonblocking(bytes) {
    if (this.state !== "connected" || !this.endpoint) {
      return fail6(networkError("ENOTCONN", "socket is not connected"));
    }
    if (this.writeShutdown) {
      return fail6(networkError("EBADF", "socket write side is shut down"));
    }
    return this.endpoint.writer.writeNonblocking?.(bytes) ?? fail6(networkError("EBADF", "socket is not nonblocking-writable"));
  }
  acceptedResult(socket) {
    return all3({
      localAddress: socket.localAddress(),
      remoteAddress: socket.remoteAddress()
    }).pipe(
      map11(({ localAddress, remoteAddress }) => Object.freeze({
        socket,
        localAddress,
        remoteAddress
      }))
    );
  }
  readiness(events) {
    return suspend3(() => {
      if (this.state === "closed") {
        return succeed5(Object.freeze({
          read: false,
          write: false,
          hangup: true,
          error: true
        }));
      }
      if (this.state === "listening" && this.listener) {
        return isEmpty9(this.listener.queue).pipe(
          map11((empty25) => Object.freeze({
            read: events.read && !empty25,
            write: false,
            hangup: false,
            error: false
          }))
        );
      }
      if (this.connectError) {
        return succeed5(Object.freeze({
          read: false,
          write: events.write,
          hangup: false,
          error: true
        }));
      }
      if (this.state !== "connected" || !this.endpoint) {
        return succeed5(Object.freeze({
          read: false,
          write: false,
          hangup: false,
          error: false
        }));
      }
      const endpoint = this.endpoint;
      const read = endpoint.reader.readiness?.({
        read: events.read && !this.readShutdown,
        write: false
      }) ?? succeed5({
        read: false,
        write: false,
        hangup: false,
        error: false
      });
      const write = endpoint.writer.readiness?.({
        read: false,
        write: events.write && !this.writeShutdown
      }) ?? succeed5({
        read: false,
        write: false,
        hangup: false,
        error: false
      });
      return all3({ read, write }).pipe(
        map11((ready) => Object.freeze({
          read: !this.readShutdown && ready.read.read,
          write: !this.writeShutdown && ready.write.write,
          hangup: this.readShutdown || ready.read.hangup || ready.write.hangup,
          error: ready.read.error || ready.write.error
        }))
      );
    });
  }
  awaitReadiness(events) {
    return suspend3(() => {
      const changed = this.readinessChanged;
      return this.readiness(events).pipe(
        flatMap9((readiness) => {
          if (readiness.read || readiness.write || readiness.hangup || readiness.error) {
            return succeed5(readiness);
          }
          const waits = [
            _await3(changed)
          ];
          if (this.state === "connected" && this.endpoint) {
            if (this.endpoint.reader.awaitReadiness) {
              waits.push(this.endpoint.reader.awaitReadiness({
                read: events.read && !this.readShutdown,
                write: false
              }));
            }
            if (this.endpoint.writer.awaitReadiness) {
              waits.push(this.endpoint.writer.awaitReadiness({
                read: false,
                write: events.write && !this.writeShutdown
              }));
            }
          }
          return raceAll2(waits).pipe(
            andThen4(this.awaitReadiness(events))
          );
        })
      );
    });
  }
  notifyReadiness() {
    return gen2(this, function* () {
      const previous = this.readinessChanged;
      const next = yield* make33();
      this.readinessChanged = next;
      yield* succeed4(previous, void 0);
    });
  }
  duplicate() {
    if (this.state === "closed") {
      return fail6(networkError("EBADF", "socket is closed"));
    }
    this.references += 1;
    return succeed5(this.descriptor());
  }
  closeReference() {
    return suspend3(() => {
      if (this.state === "closed") return _void;
      this.references -= 1;
      return this.references > 0 ? _void : this.dispose();
    });
  }
};
var TraceKernelNetworkNamespace = class _TraceKernelNetworkNamespace {
  constructor(mutex, scope2) {
    this.mutex = mutex;
    this.scope = scope2;
  }
  bindings = /* @__PURE__ */ new Map();
  sockets = /* @__PURE__ */ new Map();
  listenerChunkCapacity = /* @__PURE__ */ new Map();
  nextSocketId = 1;
  nextEphemeralPort = 49152;
  closed = false;
  static make() {
    return all3({
      mutex: makeSemaphore2(1),
      scope: make31()
    }).pipe(
      map11(
        ({ mutex, scope: scope2 }) => new _TraceKernelNetworkNamespace(mutex, scope2)
      )
    );
  }
  fork(effect) {
    return forkIn2(effect, this.scope);
  }
  createSocket() {
    return gen2(this, function* () {
      if (this.closed) {
        return yield* fail6(networkError("EBADF", "network namespace is closed"));
      }
      const id2 = `tcp-${this.nextSocketId++}`;
      const closed = yield* make33();
      const readinessChanged = yield* make33();
      const socket = new TraceKernelTcpSocket(
        id2,
        this,
        closed,
        readinessChanged,
        (closedId) => this.sockets.delete(closedId)
      );
      this.sockets.set(id2, socket);
      return socket;
    });
  }
  resourceIds() {
    return [...this.sockets.keys()].sort();
  }
  bind(socket, requested) {
    return this.mutex.withPermits(1)(
      suspend3(() => {
        if (this.closed) {
          return fail6(networkError("EBADF", "network namespace is closed"));
        }
        if (socket.phase !== "new" && socket.phase !== "connecting") {
          return fail6(networkError("EINVAL", "socket is already bound or connected"));
        }
        const host = normalizeHost(requested.host);
        if (host instanceof TraceKernelNetworkError) return fail6(host);
        const requestedPort = normalizePort(requested.port);
        if (requestedPort instanceof TraceKernelNetworkError) return fail6(requestedPort);
        const port = requestedPort === 0 ? this.allocateEphemeralPort() : requestedPort;
        if (port instanceof TraceKernelNetworkError) return fail6(port);
        if (this.bindings.has(port)) {
          return fail6(networkError("EADDRINUSE", `TCP port ${port} is already bound`));
        }
        const address = Object.freeze({ host, port });
        this.bindings.set(port, { address, socket });
        return succeed5(address);
      })
    );
  }
  markListening(socket, capacityChunks = 16) {
    this.listenerChunkCapacity.set(
      socket.id,
      Math.max(1, Math.floor(capacityChunks))
    );
  }
  connect(client, requested) {
    return uninterruptibleMask3((restore) => gen2(this, function* () {
      const target = yield* this.resolveListener(requested);
      let localAddress;
      let ownsBinding = false;
      const existingLocal = yield* option2(client.localAddress());
      if (isSome2(existingLocal)) {
        localAddress = existingLocal.value;
      } else {
        localAddress = yield* this.bind(client, {
          host: "127.0.0.1",
          port: 0
        });
        ownsBinding = true;
        client.reserveImplicitBinding(localAddress);
      }
      const serverSocket = yield* this.createSocket();
      const pair = yield* this.makeDuplexPair(
        client.id,
        serverSocket.id,
        this.listenerChunkCapacity.get(target.socket.id) ?? 16
      );
      const listenerAddress = target.address.host === "0.0.0.0" ? Object.freeze({ host: "127.0.0.1", port: target.address.port }) : target.address;
      yield* serverSocket.attachConnected(
        pair.server,
        listenerAddress,
        localAddress,
        false
      );
      const offered = yield* exit3(restore(target.socket.enqueue(serverSocket)));
      if (offered._tag === "Failure") {
        yield* serverSocket.dispose();
        yield* pair.client.reader.close();
        yield* pair.client.writer.close();
        if (ownsBinding) {
          yield* this.releaseBinding(client);
          client.clearImplicitBinding();
        }
        return yield* failCause4(offered.cause);
      }
      yield* client.attachConnected(
        pair.client,
        localAddress,
        listenerAddress,
        ownsBinding
      );
      return Object.freeze({
        localAddress,
        remoteAddress: listenerAddress
      });
    }));
  }
  releaseBinding(socket) {
    return this.mutex.withPermits(1)(
      sync3(() => {
        for (const [port, binding] of this.bindings) {
          if (binding.socket === socket) this.bindings.delete(port);
        }
        this.listenerChunkCapacity.delete(socket.id);
      })
    );
  }
  dispose() {
    return suspend3(() => {
      if (this.closed) return _void;
      this.closed = true;
      const sockets = [...this.sockets.values()];
      return forEach7(
        sockets,
        (socket) => socket.dispose(),
        { concurrency: "unbounded", discard: true }
      ).pipe(
        andThen4(close(this.scope, void_3)),
        ensuring2(sync3(() => {
          this.bindings.clear();
          this.sockets.clear();
          this.listenerChunkCapacity.clear();
        }))
      );
    });
  }
  resolveListener(requested) {
    return this.mutex.withPermits(1)(
      suspend3(() => {
        const host = normalizeHost(requested.host);
        if (host instanceof TraceKernelNetworkError) return fail6(host);
        const port = normalizePort(requested.port);
        if (port instanceof TraceKernelNetworkError) return fail6(port);
        const binding = this.bindings.get(port);
        if (!binding || binding.socket.phase !== "listening" || binding.address.host !== "0.0.0.0" && binding.address.host !== host) {
          return fail6(networkError(
            "ECONNREFUSED",
            `no listener at ${host}:${port}`
          ));
        }
        return succeed5(binding);
      })
    );
  }
  allocateEphemeralPort() {
    for (let attempt = 0; attempt <= 16383; attempt += 1) {
      const port = this.nextEphemeralPort;
      this.nextEphemeralPort = port >= 65535 ? 49152 : port + 1;
      if (!this.bindings.has(port)) return port;
    }
    return networkError("EADDRINUSE", "no ephemeral TCP ports are available");
  }
  makeDuplexPair(clientId, serverId, capacityChunks) {
    return gen2(function* () {
      const clientToServer = yield* TraceKernelPipe.make(
        `${clientId}->${serverId}`,
        { capacityChunks }
      );
      const serverToClient = yield* TraceKernelPipe.make(
        `${serverId}->${clientId}`,
        { capacityChunks }
      );
      return Object.freeze({
        client: Object.freeze({
          reader: serverToClient.reader(),
          writer: clientToServer.writer()
        }),
        server: Object.freeze({
          reader: clientToServer.reader(),
          writer: serverToClient.writer()
        })
      });
    });
  }
};

// packages/tracekernel/src/vfs.ts
var TRACEKERNEL_FILE_SYSTEM_IMAGE_SCHEMA = "tracekernel-tkfs-image-v1";
var TraceKernelOpenFileNode = class {
  constructor(openedPath, node) {
    this.openedPath = openedPath;
    this.node = node;
  }
};
function normalizeTraceKernelPath(path, cwd) {
  if (path.includes("\0")) {
    throw new TraceKernelFileSystemError({
      code: "EINVAL",
      path,
      message: `EINVAL: invalid path ${JSON.stringify(path)}`
    });
  }
  const source = path.startsWith("/") ? path : `${cwd}/${path}`;
  const parts2 = [];
  for (const part of source.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts2.pop();
      continue;
    }
    parts2.push(part);
  }
  return `/${parts2.join("/")}`;
}
function parentPath(path) {
  if (path === "/") return "/";
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}
var TraceKernelFileSystem = class _TraceKernelFileSystem {
  constructor(mutex, quota) {
    this.mutex = mutex;
    this.quota = quota;
    if (quota) this.validateQuota(quota);
    this.installInitialDirectory("/");
    this.installInitialDirectory("/workspace");
  }
  nodes = /* @__PURE__ */ new Map();
  nextInode = 1;
  nextGeneration = 1;
  generationBuffer;
  mutationWatchers = /* @__PURE__ */ new Set();
  static make(options = {}) {
    return makeSemaphore2(1).pipe(
      flatMap9((mutex) => try_2({
        try: () => new _TraceKernelFileSystem(mutex, options.quota),
        catch: (error) => error instanceof TraceKernelFileSystemError ? error : new TraceKernelFileSystemError({
          code: "EINVAL",
          path: options.quota?.root ?? "/",
          message: error instanceof Error ? error.message : String(error)
        })
      }))
    );
  }
  /**
   * Construct a new authoritative filesystem from one committed image.
   *
   * Hydration is a construction boundary, not a live merge operation: after
   * this succeeds, callers must send all mutations through the returned TKFS.
   */
  static fromImage(image, options = {}) {
    return makeSemaphore2(1).pipe(
      flatMap9(
        (mutex) => try_2({
          try: () => {
            const fileSystem = new _TraceKernelFileSystem(mutex, options.quota);
            fileSystem.restoreImage(image);
            return fileSystem;
          },
          catch: (error) => error instanceof TraceKernelFileSystemError ? error : new TraceKernelFileSystemError({
            code: "EINVAL",
            path: "/",
            message: `EINVAL: invalid TKFS image: ${error instanceof Error ? error.message : String(error)}`
          })
        })
      )
    );
  }
  get mutationGeneration() {
    return this.nextGeneration - 1;
  }
  get cacheGeneration() {
    return this.mutationGeneration | 0;
  }
  /**
   * Lazily exposes the conservative session mutation token to isolated runtime
   * workers. Shared memory is an optimization signal only; TKFS remains the
   * source of truth and every cache miss still uses a syscall.
   */
  sharedGenerationBuffer() {
    if (typeof SharedArrayBuffer === "undefined") return void 0;
    if (!this.generationBuffer) {
      this.generationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      Atomics.store(new Int32Array(this.generationBuffer), 0, this.cacheGeneration);
    }
    return this.generationBuffer;
  }
  watchMutations(listener) {
    this.mutationWatchers.add(listener);
    return () => {
      this.mutationWatchers.delete(listener);
    };
  }
  resolve(path, cwd = "/workspace") {
    return try_2({
      try: () => normalizeTraceKernelPath(path, cwd),
      catch: (error) => error instanceof TraceKernelFileSystemError ? error : new TraceKernelFileSystemError({
        code: "EINVAL",
        path,
        message: error instanceof Error ? error.message : String(error)
      })
    });
  }
  stat(path, cwd = "/workspace") {
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          const realPath = this.resolveNodePath(resolved, true);
          if (realPath instanceof TraceKernelFileSystemError) return fail6(realPath);
          const node = this.nodes.get(realPath);
          return node ? succeed5(this.snapshotStat(realPath, node)) : this.fail("ENOENT", realPath, "no such file or directory");
        })
      ))
    );
  }
  lstat(path, cwd = "/workspace") {
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          const linkPath = this.resolveNodePath(resolved, false);
          if (linkPath instanceof TraceKernelFileSystemError) return fail6(linkPath);
          const node = this.nodes.get(linkPath);
          return node ? succeed5(this.snapshotStat(linkPath, node)) : this.fail("ENOENT", linkPath, "no such file or directory");
        })
      ))
    );
  }
  realpath(path, cwd = "/workspace") {
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          const realPath = this.resolveNodePath(resolved, true);
          return realPath instanceof TraceKernelFileSystemError ? fail6(realPath) : succeed5(realPath);
        })
      ))
    );
  }
  readdir(path, cwd = "/workspace") {
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          const realPath = this.resolveNodePath(resolved, true);
          if (realPath instanceof TraceKernelFileSystemError) return fail6(realPath);
          const node = this.nodes.get(realPath);
          if (!node) return this.fail("ENOENT", realPath, "no such directory");
          if (node.kind !== "directory") {
            return this.fail("ENOTDIR", realPath, "not a directory");
          }
          const prefix = realPath === "/" ? "/" : `${realPath}/`;
          const entries2 = [];
          for (const [candidate, child] of this.nodes) {
            if (!candidate.startsWith(prefix)) continue;
            const remainder = candidate.slice(prefix.length);
            if (remainder.length === 0 || remainder.includes("/")) continue;
            entries2.push(Object.freeze({
              name: remainder,
              kind: child.kind,
              inode: child.inode
            }));
          }
          entries2.sort((left3, right3) => left3.name.localeCompare(right3.name));
          return succeed5(Object.freeze(entries2));
        })
      ))
    );
  }
  /**
   * Return a point-in-turn namespace key snapshot for synchronous host APIs
   * such as shell glob discovery.
   *
   * TKFS mutations never await while editing the namespace map, so JavaScript
   * cannot observe a partially-applied rename or recursive construction here.
   */
  namespacePaths() {
    return Object.freeze([...this.nodes.keys()].sort((left3, right3) => left3.localeCompare(right3)));
  }
  chmod(path, mode, cwd = "/workspace", mutationContext) {
    if (!Number.isSafeInteger(mode) || mode < 0) {
      return this.fail("EINVAL", path, "invalid file mode");
    }
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          const realPath = this.resolveNodePath(resolved, true);
          if (realPath instanceof TraceKernelFileSystemError) return fail6(realPath);
          const node = this.nodes.get(realPath);
          if (!node) return this.fail("ENOENT", realPath, "no such file or directory");
          const normalizedMode = mode & 4095;
          if (node.mode === normalizedMode) return _void;
          node.mode = normalizedMode;
          const generation = this.beginMutation();
          this.touchNode(node, generation, Date.now(), false);
          this.notifyMutation(generation, "change", "chmod", this.pathsForNode(node), mutationContext);
          return _void;
        })
      ))
    );
  }
  utimes(path, modifiedAt, cwd = "/workspace", mutationContext) {
    if (!Number.isFinite(modifiedAt) || modifiedAt < 0) {
      return this.fail("EINVAL", path, "invalid modification timestamp");
    }
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          const realPath = this.resolveNodePath(resolved, true);
          if (realPath instanceof TraceKernelFileSystemError) return fail6(realPath);
          const node = this.nodes.get(realPath);
          if (!node) return this.fail("ENOENT", realPath, "no such file or directory");
          const generation = this.beginMutation();
          node.generation = generation;
          node.modifiedAt = modifiedAt;
          node.changedAt = Date.now();
          this.notifyMutation(generation, "change", "utimes", this.pathsForNode(node), mutationContext);
          return _void;
        })
      ))
    );
  }
  mkdir(path, options = {}, cwd = "/workspace", mutationContext) {
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          const directoryPath = this.resolveNodePath(resolved, false, options.recursive ? "suffix" : "final");
          if (directoryPath instanceof TraceKernelFileSystemError) return fail6(directoryPath);
          const existing = this.nodes.get(directoryPath);
          if (existing) {
            if (options.recursive && existing.kind === "directory") return _void;
            return this.fail("EEXIST", directoryPath, "file already exists");
          }
          if (directoryPath === "/") return _void;
          const missing = [];
          let cursor = directoryPath;
          while (!this.nodes.has(cursor)) {
            missing.push(cursor);
            cursor = parentPath(cursor);
          }
          const ancestor = this.nodes.get(cursor);
          if (ancestor.kind !== "directory") {
            return this.fail("ENOTDIR", cursor, "path component is not a directory");
          }
          if (!options.recursive && missing.length > 1) {
            return this.fail("ENOENT", parentPath(directoryPath), "parent directory does not exist");
          }
          const quotaError = this.additionalQuotaError(missing, 0);
          if (quotaError) return fail6(quotaError);
          const generation = this.beginMutation();
          const timestamp = Date.now();
          for (const directoryPath2 of missing.reverse()) {
            this.nodes.set(directoryPath2, this.makeDirectory(
              options.mode ?? 511,
              generation,
              timestamp
            ));
          }
          this.touchDirectory(cursor, generation, timestamp);
          this.notifyMutation(generation, "rename", "mkdir", missing, mutationContext);
          return _void;
        })
      ))
    );
  }
  rmdir(path, cwd = "/workspace", mutationContext) {
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          const directoryPath = this.resolveNodePath(resolved, false);
          if (directoryPath instanceof TraceKernelFileSystemError) return fail6(directoryPath);
          if (directoryPath === "/") return this.fail("EBUSY", directoryPath, "cannot remove root directory");
          const node = this.nodes.get(directoryPath);
          if (!node) return this.fail("ENOENT", directoryPath, "no such directory");
          if (node.kind !== "directory") return this.fail("ENOTDIR", directoryPath, "not a directory");
          if (this.hasDescendants(directoryPath)) {
            return this.fail("ENOTEMPTY", directoryPath, "directory not empty");
          }
          this.nodes.delete(directoryPath);
          const generation = this.beginMutation();
          this.touchDirectory(parentPath(directoryPath), generation, Date.now());
          this.notifyMutation(generation, "rename", "rmdir", [directoryPath], mutationContext);
          return _void;
        })
      ))
    );
  }
  readFile(path, cwd = "/workspace") {
    return this.readFileVersioned(path, cwd).pipe(
      map11((file) => file.contents)
    );
  }
  readFileVersioned(path, cwd = "/workspace") {
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          const filePath = this.resolveNodePath(resolved, true);
          if (filePath instanceof TraceKernelFileSystemError) return fail6(filePath);
          const node = this.nodes.get(filePath);
          if (!node) return this.fail("ENOENT", filePath, "no such file");
          return node.kind === "file" ? succeed5(Object.freeze({
            contents: Uint8Array.from(node.contents),
            cacheGeneration: this.cacheGeneration
          })) : this.fail("EISDIR", filePath, "is a directory");
        })
      ))
    );
  }
  writeFile(path, contents, cwd = "/workspace", mutationContext) {
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          const filePath = this.resolveNodePath(resolved, true, "final");
          if (filePath instanceof TraceKernelFileSystemError) return fail6(filePath);
          const existing = this.nodes.get(filePath);
          if (existing?.kind === "directory") {
            return this.fail("EISDIR", filePath, "is a directory");
          }
          if (existing?.kind === "symlink") {
            return this.fail("ELOOP", filePath, "unresolved symbolic link");
          }
          const parent = this.requireDirectory(parentPath(filePath));
          if (parent instanceof TraceKernelFileSystemError) return fail6(parent);
          const quotaError = existing ? this.quotaResizeError(existing, contents.byteLength) : this.additionalQuotaError(
            [filePath],
            contents.byteLength,
            contents.byteLength
          );
          if (quotaError) return fail6(quotaError);
          const generation = this.beginMutation();
          const timestamp = Date.now();
          if (existing) {
            existing.contents = Uint8Array.from(contents);
            this.touchNode(existing, generation, timestamp, true);
          } else {
            this.nodes.set(filePath, this.makeFile(
              Uint8Array.from(contents),
              438,
              generation,
              timestamp
            ));
            this.touchNode(parent, generation, timestamp, true);
          }
          this.notifyMutation(generation, existing ? "change" : "rename", "write", [filePath], mutationContext);
          return _void;
        })
      ))
    );
  }
  link(existingPath, newPath, cwd = "/workspace", mutationContext) {
    return all3([
      this.resolve(existingPath, cwd),
      this.resolve(newPath, cwd)
    ]).pipe(
      flatMap9(([unresolvedExisting, unresolvedNew]) => this.mutex.withPermits(1)(
        suspend3(() => {
          const existingResult = this.resolveNodePath(unresolvedExisting, false);
          if (existingResult instanceof TraceKernelFileSystemError) {
            return fail6(existingResult);
          }
          const newResult = this.resolveNodePath(unresolvedNew, false, "final");
          if (newResult instanceof TraceKernelFileSystemError) return fail6(newResult);
          const existing = this.nodes.get(existingResult);
          if (!existing) return this.fail("ENOENT", existingResult, "no such file");
          if (existing.kind === "directory") {
            return this.fail("EPERM", existingResult, "hard links to directories are not permitted");
          }
          if (this.nodes.has(newResult)) {
            return this.fail("EEXIST", newResult, "file already exists");
          }
          const parent = this.requireDirectory(parentPath(newResult));
          if (parent instanceof TraceKernelFileSystemError) return fail6(parent);
          const quotaError = this.additionalQuotaError(
            [newResult],
            existing.kind === "file" ? existing.contents.byteLength : new TextEncoder().encode(existing.target).byteLength,
            existing.kind === "file" ? existing.contents.byteLength : void 0
          );
          if (quotaError) return fail6(quotaError);
          this.nodes.set(newResult, existing);
          const generation = this.beginMutation();
          const timestamp = Date.now();
          this.touchNode(existing, generation, timestamp, false);
          this.touchNode(parent, generation, timestamp, true);
          this.notifyMutation(generation, "rename", "link", [newResult], mutationContext);
          return _void;
        })
      ))
    );
  }
  symlink(target, linkPath, cwd = "/workspace", mutationContext) {
    return try_2({
      try: () => {
        if (target.includes("\0")) {
          throw this.error("EINVAL", target, "invalid symbolic link target");
        }
        return target;
      },
      catch: (error) => error instanceof TraceKernelFileSystemError ? error : this.error("EINVAL", target, "invalid symbolic link target")
    }).pipe(
      zipRight2(this.resolve(linkPath, cwd)),
      flatMap9((unresolvedLink) => this.mutex.withPermits(1)(
        suspend3(() => {
          const linkResult = this.resolveNodePath(unresolvedLink, false, "final");
          if (linkResult instanceof TraceKernelFileSystemError) return fail6(linkResult);
          if (this.nodes.has(linkResult)) {
            return this.fail("EEXIST", linkResult, "file already exists");
          }
          const parent = this.requireDirectory(parentPath(linkResult));
          if (parent instanceof TraceKernelFileSystemError) return fail6(parent);
          const quotaError = this.additionalQuotaError(
            [linkResult],
            new TextEncoder().encode(target).byteLength
          );
          if (quotaError) return fail6(quotaError);
          const generation = this.beginMutation();
          const timestamp = Date.now();
          this.nodes.set(linkResult, this.makeSymlink(target, generation, timestamp));
          this.touchNode(parent, generation, timestamp, true);
          this.notifyMutation(generation, "rename", "symlink", [linkResult], mutationContext);
          return _void;
        })
      ))
    );
  }
  readlink(path, cwd = "/workspace") {
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          const linkPath = this.resolveNodePath(resolved, false);
          if (linkPath instanceof TraceKernelFileSystemError) return fail6(linkPath);
          const node = this.nodes.get(linkPath);
          if (!node) return this.fail("ENOENT", linkPath, "no such file");
          return node.kind === "symlink" ? succeed5(node.target) : this.fail("EINVAL", linkPath, "not a symbolic link");
        })
      ))
    );
  }
  unlink(path, cwd = "/workspace", mutationContext) {
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          const entryPath = this.resolveNodePath(resolved, false);
          if (entryPath instanceof TraceKernelFileSystemError) return fail6(entryPath);
          const node = this.nodes.get(entryPath);
          if (!node) return this.fail("ENOENT", entryPath, "no such file");
          if (node.kind === "directory") return this.fail("EISDIR", entryPath, "is a directory");
          this.nodes.delete(entryPath);
          const generation = this.beginMutation();
          this.touchDirectory(parentPath(entryPath), generation, Date.now());
          this.notifyMutation(generation, "rename", "unlink", [entryPath], mutationContext);
          return _void;
        })
      ))
    );
  }
  rename(sourcePath, destinationPath, cwd = "/workspace", mutationContext) {
    return all3([
      this.resolve(sourcePath, cwd),
      this.resolve(destinationPath, cwd)
    ]).pipe(
      flatMap9(([unresolvedSource, unresolvedDestination]) => this.mutex.withPermits(1)(
        suspend3(() => {
          const sourceResult = this.resolveNodePath(unresolvedSource, false);
          if (sourceResult instanceof TraceKernelFileSystemError) return fail6(sourceResult);
          const destinationResult = this.resolveNodePath(unresolvedDestination, false, "final");
          if (destinationResult instanceof TraceKernelFileSystemError) {
            return fail6(destinationResult);
          }
          const source = sourceResult;
          const destination = destinationResult;
          if (source === destination) {
            return this.nodes.has(source) ? _void : this.fail("ENOENT", source, "no such file or directory");
          }
          if (source === "/" || destination === "/") {
            return this.fail("EBUSY", source, "cannot rename the root directory");
          }
          const sourceNode = this.nodes.get(source);
          if (!sourceNode) {
            return this.fail("ENOENT", source, "no such file or directory");
          }
          if (sourceNode.kind === "directory" && destination.startsWith(`${source}/`)) {
            return this.fail("EINVAL", destination, "cannot move a directory into itself");
          }
          const destinationParent = this.requireDirectory(parentPath(destination));
          if (destinationParent instanceof TraceKernelFileSystemError) {
            return fail6(destinationParent);
          }
          const destinationNode = this.nodes.get(destination);
          if (destinationNode === sourceNode) return _void;
          if (destinationNode) {
            if (sourceNode.kind !== "directory" && destinationNode.kind === "directory") {
              return this.fail("EISDIR", destination, "destination is a directory");
            }
            if (sourceNode.kind === "directory" && destinationNode.kind !== "directory") {
              return this.fail("ENOTDIR", destination, "destination is not a directory");
            }
            if (destinationNode.kind === "directory" && this.hasDescendants(destination)) {
              return this.fail("ENOTEMPTY", destination, "destination directory not empty");
            }
          }
          const movedEntries = [...this.nodes.entries()].filter(([path]) => path === source || path.startsWith(`${source}/`));
          const projected = new Map(this.nodes);
          if (destinationNode) projected.delete(destination);
          for (const [path] of movedEntries) projected.delete(path);
          for (const [path, node] of movedEntries) {
            projected.set(`${destination}${path.slice(source.length)}`, node);
          }
          const quotaError = this.quotaNamespaceError(projected);
          if (quotaError) return fail6(quotaError);
          if (destinationNode) this.nodes.delete(destination);
          for (const [path] of movedEntries) this.nodes.delete(path);
          for (const [path, node] of movedEntries) {
            const suffix = path.slice(source.length);
            this.nodes.set(`${destination}${suffix}`, node);
          }
          const generation = this.beginMutation();
          const timestamp = Date.now();
          this.touchNode(sourceNode, generation, timestamp, false);
          this.touchDirectory(parentPath(source), generation, timestamp);
          this.touchNode(destinationParent, generation, timestamp, true);
          this.notifyMutation(generation, "rename", "rename", [source, destination], mutationContext);
          return _void;
        })
      ))
    );
  }
  prepareOpen(path, cwd, options, mutationContext) {
    const access = options.access ?? "read";
    return this.resolve(path, cwd).pipe(
      flatMap9((resolved) => this.mutex.withPermits(1)(
        suspend3(() => {
          if (options.create && options.exclusive) {
            const entryPath = this.resolveNodePath(resolved, false, "final");
            if (entryPath instanceof TraceKernelFileSystemError) return fail6(entryPath);
            if (this.nodes.has(entryPath)) {
              return this.fail("EEXIST", entryPath, "file already exists");
            }
          }
          const filePath = this.resolveNodePath(resolved, true, options.create ? "final" : "none");
          if (filePath instanceof TraceKernelFileSystemError) return fail6(filePath);
          const existing = this.nodes.get(filePath);
          if (!existing) {
            if (!options.create) return this.fail("ENOENT", filePath, "no such file");
            if (access === "read") {
              return this.fail("EACCES", filePath, "read-only open cannot create file");
            }
            const parent = this.requireDirectory(parentPath(filePath));
            if (parent instanceof TraceKernelFileSystemError) return fail6(parent);
            const quotaError = this.additionalQuotaError([filePath], 0, 0);
            if (quotaError) return fail6(quotaError);
            const generation = this.beginMutation();
            const timestamp = Date.now();
            const file = this.makeFile(new Uint8Array(0), 438, generation, timestamp);
            this.nodes.set(filePath, file);
            this.touchNode(parent, generation, timestamp, true);
            this.notifyMutation(generation, "rename", "open-create", [filePath], mutationContext);
            return succeed5(new TraceKernelOpenFileNode(filePath, file));
          }
          if (existing.kind === "directory") {
            return this.fail("EISDIR", filePath, "is a directory");
          }
          if (existing.kind === "symlink") {
            return this.fail("ELOOP", filePath, "unresolved symbolic link");
          }
          if (options.create && options.exclusive) {
            return this.fail("EEXIST", filePath, "file already exists");
          }
          if (options.truncate) {
            if (access === "read") {
              return this.fail("EACCES", resolved, "read-only descriptor cannot truncate file");
            }
            const quotaError = this.quotaResizeError(existing, 0);
            if (quotaError) return fail6(quotaError);
            existing.contents = new Uint8Array(0);
            const generation = this.beginMutation();
            this.touchNode(existing, generation, Date.now(), true);
            this.notifyMutation(generation, "change", "open-truncate", this.pathsForNode(existing), mutationContext);
          }
          return succeed5(new TraceKernelOpenFileNode(filePath, existing));
        })
      ))
    );
  }
  readAt(file, offset, maxBytes) {
    return this.mutex.withPermits(1)(
      sync3(() => file.node.contents.slice(offset, offset + maxBytes))
    );
  }
  statOpen(file) {
    return this.mutex.withPermits(1)(
      sync3(() => this.snapshotStat(file.openedPath, file.node))
    );
  }
  truncateOpen(file, length3, mutationContext) {
    return this.mutex.withPermits(1)(
      suspend3(() => {
        const nextLength = Math.max(0, Math.floor(length3));
        if (file.node.contents.byteLength === nextLength) return _void;
        const quotaError = this.quotaResizeError(file.node, nextLength);
        if (quotaError) return fail6(quotaError);
        const next = new Uint8Array(nextLength);
        next.set(file.node.contents.slice(0, nextLength));
        file.node.contents = next;
        const generation = this.beginMutation();
        this.touchNode(file.node, generation, Date.now(), true);
        this.notifyMutation(generation, "change", "truncate", this.pathsForNode(file.node), mutationContext);
        return _void;
      })
    );
  }
  writeAt(file, offset, bytes, append4, mutationContext) {
    return this.mutex.withPermits(1)(
      suspend3(() => {
        const node = file.node;
        const writeOffset = append4 ? node.contents.byteLength : offset;
        const nextLength = Math.max(node.contents.byteLength, writeOffset + bytes.byteLength);
        const quotaError = this.quotaResizeError(node, nextLength);
        if (quotaError) return fail6(quotaError);
        const next = new Uint8Array(nextLength);
        next.set(node.contents);
        next.set(bytes, writeOffset);
        node.contents = next;
        if (bytes.byteLength > 0) {
          const generation = this.beginMutation();
          this.touchNode(node, generation, Date.now(), true);
          this.notifyMutation(generation, "change", "write", this.pathsForNode(node), mutationContext);
        }
        return succeed5(writeOffset + bytes.byteLength);
      })
    );
  }
  snapshots() {
    return [...this.nodes.entries()].filter((entry) => entry[1].kind === "file").map(([path, node]) => Object.freeze({
      path,
      contents: Uint8Array.from(node.contents),
      generation: node.generation
    })).sort((left3, right3) => left3.path.localeCompare(right3.path));
  }
  /**
   * Capture namespace and inode state at the same semaphore linearization point
   * used by syscalls. The returned image does not share mutable bytes with TKFS.
   */
  exportImage() {
    return this.mutex.withPermits(1)(
      sync3(() => {
        const inodeNodes = /* @__PURE__ */ new Map();
        const entries2 = [...this.nodes.entries()].map(([path, node]) => {
          inodeNodes.set(node.inode, node);
          return Object.freeze({ path, inode: node.inode });
        }).sort((left3, right3) => left3.path.localeCompare(right3.path));
        const inodes = [...inodeNodes.values()].sort((left3, right3) => left3.inode - right3.inode).map((node) => {
          const metadata = {
            inode: node.inode,
            mode: node.mode,
            generation: node.generation,
            createdAt: node.createdAt,
            modifiedAt: node.modifiedAt,
            changedAt: node.changedAt
          };
          if (node.kind === "file") {
            return Object.freeze({
              ...metadata,
              kind: "file",
              contents: Uint8Array.from(node.contents)
            });
          }
          if (node.kind === "symlink") {
            return Object.freeze({
              ...metadata,
              kind: "symlink",
              target: node.target
            });
          }
          return Object.freeze({ ...metadata, kind: "directory" });
        });
        return Object.freeze({
          schema: TRACEKERNEL_FILE_SYSTEM_IMAGE_SCHEMA,
          mutationGeneration: this.mutationGeneration,
          entries: Object.freeze(entries2),
          inodes: Object.freeze(inodes)
        });
      })
    );
  }
  /**
   * Replace a quiescent live namespace with a previously exported image.
   *
   * The owning kernel session must close every non-preserved file descriptor
   * before calling this method. Keeping the operation in TKFS preserves one
   * authoritative rollback boundary for hard links, metadata, and bytes.
   */
  restoreQuiescentImage(image, mutationContext) {
    return this.mutex.withPermits(1)(
      try_2({
        try: () => {
          const previousPaths = [...this.nodes.keys()];
          const previousGeneration = this.mutationGeneration;
          this.restoreImage(image);
          this.nextGeneration = Math.max(
            this.nextGeneration,
            previousGeneration + 2
          );
          const generation = this.beginMutation();
          this.notifyMutation(
            generation,
            "rename",
            "clear",
            previousPaths,
            mutationContext
          );
        },
        catch: (error) => error instanceof TraceKernelFileSystemError ? error : this.error(
          "EINVAL",
          "/",
          `EINVAL: could not restore TKFS execution scope: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    );
  }
  clear(mutationContext) {
    if (this.nodes.size > 0) {
      const paths = [...this.nodes.keys()];
      const generation = this.beginMutation();
      this.nodes.clear();
      this.notifyMutation(generation, "rename", "clear", paths, mutationContext);
      return;
    }
    this.nodes.clear();
  }
  installInitialDirectory(path) {
    this.nodes.set(path, this.makeDirectory(511, 0, Date.now()));
  }
  restoreImage(image) {
    if (image?.schema !== TRACEKERNEL_FILE_SYSTEM_IMAGE_SCHEMA) {
      throw this.error("EINVAL", "/", "unsupported TKFS image schema");
    }
    if (!Number.isSafeInteger(image.mutationGeneration) || image.mutationGeneration < 0 || !Array.isArray(image.entries) || !Array.isArray(image.inodes)) {
      throw this.error("EINVAL", "/", "malformed TKFS image");
    }
    const restoredInodes = /* @__PURE__ */ new Map();
    let maximumInode = 0;
    let maximumGeneration = 0;
    for (const inode of image.inodes) {
      if (!Number.isSafeInteger(inode.inode) || inode.inode <= 0 || restoredInodes.has(inode.inode) || !Number.isSafeInteger(inode.mode) || inode.mode < 0 || !Number.isSafeInteger(inode.generation) || inode.generation < 0 || !this.validImageTimestamp(inode.createdAt) || !this.validImageTimestamp(inode.modifiedAt) || !this.validImageTimestamp(inode.changedAt)) {
        throw this.error("EINVAL", "/", "invalid TKFS inode record");
      }
      const base = {
        inode: inode.inode,
        mode: inode.mode,
        generation: inode.generation,
        createdAt: inode.createdAt,
        modifiedAt: inode.modifiedAt,
        changedAt: inode.changedAt
      };
      let node;
      if (inode.kind === "file") {
        if (!(inode.contents instanceof Uint8Array)) {
          throw this.error("EINVAL", "/", "invalid TKFS file contents");
        }
        node = {
          ...base,
          kind: "file",
          contents: Uint8Array.from(inode.contents)
        };
      } else if (inode.kind === "directory") {
        node = { ...base, kind: "directory" };
      } else if (inode.kind === "symlink" && typeof inode.target === "string") {
        node = { ...base, kind: "symlink", target: inode.target };
      } else {
        throw this.error("EINVAL", "/", "invalid TKFS inode kind");
      }
      restoredInodes.set(inode.inode, node);
      maximumInode = Math.max(maximumInode, inode.inode);
      maximumGeneration = Math.max(maximumGeneration, inode.generation);
    }
    const restoredNodes = /* @__PURE__ */ new Map();
    const referencedInodes = /* @__PURE__ */ new Set();
    for (const entry of image.entries) {
      if (typeof entry.path !== "string" || !entry.path.startsWith("/") || normalizeTraceKernelPath(entry.path, "/") !== entry.path || restoredNodes.has(entry.path)) {
        throw this.error("EINVAL", "/", "invalid TKFS namespace entry");
      }
      const node = restoredInodes.get(entry.inode);
      if (!node) {
        throw this.error("EINVAL", entry.path, "TKFS entry references a missing inode");
      }
      if (node.kind === "directory" && [...restoredNodes.values()].some((candidate) => candidate === node)) {
        throw this.error("EINVAL", entry.path, "TKFS directories cannot have hard links");
      }
      restoredNodes.set(entry.path, node);
      referencedInodes.add(entry.inode);
    }
    const root = restoredNodes.get("/");
    if (!root || root.kind !== "directory") {
      throw this.error("EINVAL", "/", "TKFS image requires a root directory");
    }
    for (const [path] of restoredNodes) {
      if (path === "/") continue;
      const parent = restoredNodes.get(parentPath(path));
      if (!parent || parent.kind !== "directory") {
        throw this.error("EINVAL", path, "TKFS entry has no directory parent");
      }
    }
    if (referencedInodes.size !== restoredInodes.size) {
      throw this.error("EINVAL", "/", "TKFS image contains an unreferenced inode");
    }
    if (image.mutationGeneration < maximumGeneration) {
      throw this.error("EINVAL", "/", "TKFS mutation generation precedes inode state");
    }
    this.nodes.clear();
    for (const [path, node] of restoredNodes) this.nodes.set(path, node);
    this.nextInode = maximumInode + 1;
    this.nextGeneration = image.mutationGeneration + 1;
    const quotaError = this.quotaNamespaceError(this.nodes);
    if (quotaError) throw quotaError;
  }
  validateQuota(quota) {
    if (!quota.root.startsWith("/") || normalizeTraceKernelPath(quota.root, "/") !== quota.root || !Number.isSafeInteger(quota.maxBytes) || quota.maxBytes < 0 || !Number.isSafeInteger(quota.maxFileBytes) || quota.maxFileBytes < 0 || !Number.isSafeInteger(quota.maxEntries) || quota.maxEntries < 0) {
      throw this.error("EINVAL", quota.root, "invalid TKFS quota");
    }
  }
  quotaCountsPath(path) {
    if (!this.quota || path === this.quota.root) return false;
    return path.startsWith(`${this.quota.root}/`);
  }
  additionalQuotaError(paths, bytes, fileBytes) {
    if (!this.quota) return void 0;
    if (fileBytes !== void 0 && fileBytes > this.quota.maxFileBytes) {
      return this.error("EFBIG", paths[0] ?? this.quota.root, "file exceeds TKFS quota");
    }
    const counted = paths.filter((path) => this.quotaCountsPath(path)).length;
    if (counted === 0) return void 0;
    const usage = this.quotaUsage(this.nodes);
    if (usage.entries + counted > this.quota.maxEntries) {
      return this.error("ENOSPC", paths[0] ?? this.quota.root, "TKFS entry quota exceeded");
    }
    if (usage.bytes + bytes * counted > this.quota.maxBytes) {
      return this.error("ENOSPC", paths[0] ?? this.quota.root, "TKFS byte quota exceeded");
    }
    return void 0;
  }
  quotaResizeError(node, nextSize) {
    if (!this.quota) return void 0;
    const countedPaths = [...this.nodes.entries()].filter(([path, candidate]) => candidate === node && this.quotaCountsPath(path)).map(([path]) => path);
    if (countedPaths.length === 0) return void 0;
    if (nextSize > this.quota.maxFileBytes) {
      return this.error("EFBIG", countedPaths[0], "file exceeds TKFS quota");
    }
    const usage = this.quotaUsage(this.nodes);
    const nextBytes = usage.bytes + (nextSize - node.contents.byteLength) * countedPaths.length;
    if (nextBytes > this.quota.maxBytes) {
      return this.error("ENOSPC", countedPaths[0], "TKFS byte quota exceeded");
    }
    return void 0;
  }
  quotaNamespaceError(nodes) {
    if (!this.quota) return void 0;
    const usage = this.quotaUsage(nodes);
    if (usage.largestFileBytes > this.quota.maxFileBytes) {
      return this.error("EFBIG", this.quota.root, "file exceeds TKFS quota");
    }
    if (usage.entries > this.quota.maxEntries) {
      return this.error("ENOSPC", this.quota.root, "TKFS entry quota exceeded");
    }
    if (usage.bytes > this.quota.maxBytes) {
      return this.error("ENOSPC", this.quota.root, "TKFS byte quota exceeded");
    }
    return void 0;
  }
  quotaUsage(nodes) {
    let bytes = 0;
    let entries2 = 0;
    let largestFileBytes = 0;
    for (const [path, node] of nodes) {
      if (!this.quotaCountsPath(path)) continue;
      entries2 += 1;
      if (node.kind === "file") {
        bytes += node.contents.byteLength;
        largestFileBytes = Math.max(largestFileBytes, node.contents.byteLength);
      } else if (node.kind === "symlink") {
        bytes += new TextEncoder().encode(node.target).byteLength;
      }
    }
    return { bytes, entries: entries2, largestFileBytes };
  }
  validImageTimestamp(value) {
    return Number.isFinite(value) && value >= 0;
  }
  makeFile(contents, mode, generation, timestamp) {
    return {
      kind: "file",
      inode: this.nextInode++,
      mode,
      contents,
      generation,
      createdAt: timestamp,
      modifiedAt: timestamp,
      changedAt: timestamp
    };
  }
  makeDirectory(mode, generation, timestamp) {
    return {
      kind: "directory",
      inode: this.nextInode++,
      mode,
      generation,
      createdAt: timestamp,
      modifiedAt: timestamp,
      changedAt: timestamp
    };
  }
  makeSymlink(target, generation, timestamp) {
    return {
      kind: "symlink",
      inode: this.nextInode++,
      mode: 511,
      target,
      generation,
      createdAt: timestamp,
      modifiedAt: timestamp,
      changedAt: timestamp
    };
  }
  snapshotStat(path, node) {
    return Object.freeze({
      path,
      kind: node.kind,
      inode: node.inode,
      nlink: this.linkCount(node),
      mode: node.mode,
      size: node.kind === "file" ? node.contents.byteLength : node.kind === "symlink" ? new TextEncoder().encode(node.target).byteLength : 0,
      generation: node.generation,
      createdAt: node.createdAt,
      modifiedAt: node.modifiedAt,
      changedAt: node.changedAt
    });
  }
  linkCount(node) {
    if (node.kind === "directory") return 2;
    let count = 0;
    for (const candidate of this.nodes.values()) {
      if (candidate === node) count += 1;
    }
    return count;
  }
  pathsForNode(node) {
    return [...this.nodes.entries()].filter(([, candidate]) => candidate === node).map(([path]) => path);
  }
  /**
   * Resolve symbolic links while the namespace semaphore is held.
   *
   * Parent components are always followed. The final component is optionally
   * left unresolved for operations that act on the directory entry itself
   * (lstat, readlink, unlink, rename, link). Missing paths can be admitted only
   * at the final component, or for the entire remaining suffix when recursive
   * mkdir is materializing a new subtree.
   */
  resolveNodePath(path, followFinal, allowMissing = "none") {
    let current = path;
    let followedLinks = 0;
    resolveAgain: while (true) {
      if (current === "/") {
        return this.nodes.has("/") ? "/" : this.error("ENOENT", "/", "no such file or directory");
      }
      const parts2 = current.split("/").filter(Boolean);
      for (let index = 0; index < parts2.length; index += 1) {
        const candidate = `/${parts2.slice(0, index + 1).join("/")}`;
        const node = this.nodes.get(candidate);
        const final = index === parts2.length - 1;
        if (!node) {
          if (allowMissing === "suffix" || allowMissing === "final" && final) {
            return current;
          }
          return this.error("ENOENT", candidate, "no such file or directory");
        }
        if (node.kind === "symlink" && (!final || followFinal)) {
          followedLinks += 1;
          if (followedLinks > 40) {
            return this.error("ELOOP", candidate, "too many symbolic links");
          }
          const targetPath = normalizeTraceKernelPath(node.target, parentPath(candidate));
          const remaining = parts2.slice(index + 1).join("/");
          current = remaining ? normalizeTraceKernelPath(`${targetPath}/${remaining}`, "/") : targetPath;
          continue resolveAgain;
        }
        if (!final && node.kind !== "directory") {
          return this.error("ENOTDIR", candidate, "path component is not a directory");
        }
      }
      return current;
    }
  }
  requireDirectory(path) {
    const node = this.nodes.get(path);
    if (!node) {
      return this.error("ENOENT", path, "parent directory does not exist");
    }
    if (node.kind !== "directory") {
      return this.error("ENOTDIR", path, "path component is not a directory");
    }
    return node;
  }
  hasDescendants(path) {
    const prefix = `${path}/`;
    for (const candidate of this.nodes.keys()) {
      if (candidate.startsWith(prefix)) return true;
    }
    return false;
  }
  beginMutation() {
    const generation = this.nextGeneration++;
    if (this.generationBuffer) {
      const sharedGeneration = new Int32Array(this.generationBuffer);
      Atomics.store(sharedGeneration, 0, generation | 0);
      Atomics.notify(sharedGeneration, 0);
    }
    return generation;
  }
  notifyMutation(generation, eventType, operation, paths, context2) {
    if (paths.length === 0) return;
    const mutation = Object.freeze({
      generation,
      eventType,
      operation,
      paths: Object.freeze([...new Set(paths)]),
      ...context2?.origin ? { origin: context2.origin } : {}
    });
    for (const watcher of this.mutationWatchers) {
      try {
        watcher(mutation);
      } catch {
      }
    }
  }
  touchDirectory(path, generation, timestamp) {
    const node = this.nodes.get(path);
    if (node?.kind === "directory") this.touchNode(node, generation, timestamp, true);
  }
  touchNode(node, generation, timestamp, updateModifiedAt) {
    node.generation = generation;
    node.changedAt = timestamp;
    if (updateModifiedAt) node.modifiedAt = timestamp;
  }
  error(code, path, message) {
    return new TraceKernelFileSystemError({
      code,
      path,
      message: `${code}: ${message} ${JSON.stringify(path)}`
    });
  }
  fail(code, path, message) {
    return fail6(this.error(code, path, message));
  }
};
var TraceKernelOpenFileDescription = class _TraceKernelOpenFileDescription {
  constructor(id2, fileSystem, file, options, mutex, onFullyClosed) {
    this.id = id2;
    this.fileSystem = fileSystem;
    this.file = file;
    this.options = options;
    this.mutex = mutex;
    this.onFullyClosed = onFullyClosed;
  }
  references = 1;
  closed = false;
  offset = 0;
  static make(id2, fileSystem, path, cwd, options, onFullyClosed, mutationContext) {
    return gen2(function* () {
      const file = yield* fileSystem.prepareOpen(
        path,
        cwd,
        options,
        mutationContext
      );
      const mutex = yield* makeSemaphore2(1);
      return new _TraceKernelOpenFileDescription(
        id2,
        fileSystem,
        file,
        Object.freeze({ ...options }),
        mutex,
        onFullyClosed
      );
    });
  }
  get path() {
    return this.file.openedPath;
  }
  descriptor() {
    const access = this.options.access ?? "read";
    return {
      kind: "file",
      resourceId: this.id,
      ...access === "read" || access === "read-write" ? { read: (maxBytes, position) => this.read(maxBytes, position) } : {},
      ...access === "write" || access === "read-write" ? {
        write: (bytes, position, context2) => this.write(bytes, position, context2),
        truncate: (length3, context2) => this.truncate(length3, context2)
      } : {},
      seek: (offset, whence) => this.seek(offset, whence),
      stat: () => this.fileSystem.statOpen(this.file),
      duplicate: () => this.duplicate(),
      close: () => this.close()
    };
  }
  dispose() {
    return sync3(() => {
      if (this.closed) return;
      this.closed = true;
      this.references = 0;
      this.onFullyClosed(this.id);
    });
  }
  read(maxBytes, position) {
    return this.mutex.withPermits(1)(
      suspend3(() => {
        if (this.closed) return this.closedError();
        const readOffset = position ?? this.offset;
        return this.fileSystem.readAt(this.file, readOffset, maxBytes).pipe(
          tap2((bytes) => position === void 0 ? sync3(() => {
            this.offset = readOffset + bytes.byteLength;
          }) : _void)
        );
      })
    );
  }
  write(bytes, position, context2) {
    return this.mutex.withPermits(1)(
      suspend3(() => {
        if (this.closed) return this.closedError();
        return this.fileSystem.writeAt(
          this.file,
          position ?? this.offset,
          Uint8Array.from(bytes),
          this.options.append === true,
          context2 ? { origin: context2 } : void 0
        ).pipe(
          tap2((nextOffset) => position === void 0 || this.options.append === true ? sync3(() => {
            this.offset = nextOffset;
          }) : _void),
          as4(bytes.byteLength)
        );
      })
    );
  }
  truncate(length3, context2) {
    return this.mutex.withPermits(1)(
      suspend3(() => {
        if (this.closed) return this.closedError();
        return this.fileSystem.truncateOpen(
          this.file,
          length3,
          context2 ? { origin: context2 } : void 0
        );
      })
    );
  }
  seek(offset, whence) {
    return this.mutex.withPermits(1)(
      suspend3(() => {
        if (this.closed) return this.closedError();
        const base = whence === "set" ? succeed5(0) : whence === "current" ? succeed5(this.offset) : this.fileSystem.statOpen(this.file).pipe(
          map11((stat) => stat.size)
        );
        return base.pipe(
          flatMap9((origin) => {
            const nextOffset = origin + offset;
            if (!Number.isSafeInteger(nextOffset) || nextOffset < 0) {
              return fail6(new TraceKernelInvalidArgumentError({
                code: "EINVAL",
                argument: "offset",
                message: `EINVAL: seek would produce invalid offset ${nextOffset}`
              }));
            }
            this.offset = nextOffset;
            return succeed5(nextOffset);
          })
        );
      })
    );
  }
  duplicate() {
    return suspend3(() => {
      if (this.closed) return this.closedError();
      this.references += 1;
      return succeed5(this.descriptor());
    });
  }
  close() {
    return sync3(() => {
      if (this.closed) return;
      this.references -= 1;
      if (this.references > 0) return;
      this.closed = true;
      this.onFullyClosed(this.id);
    });
  }
  closedError() {
    return fail6(new TraceKernelFileSystemError({
      code: "EBADF",
      path: this.path,
      message: `EBADF: open file description ${this.id} is closed`
    }));
  }
};

// packages/tracekernel/src/syscalls.ts
function syscallWireError(error) {
  if (error instanceof TraceKernelFileSystemError) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  if (error instanceof TraceKernelNetworkError) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  if (error instanceof TraceKernelBadFileDescriptorError || error instanceof TraceKernelInvalidDescriptorOperationError) {
    return Object.freeze({ code: "EBADF", message: error.message });
  }
  if (error instanceof TraceKernelBrokenPipeError) {
    return Object.freeze({ code: "EPIPE", message: error.message });
  }
  if (error instanceof TraceKernelDescriptorLimitError) {
    return Object.freeze({ code: "EMFILE", message: error.message });
  }
  if (error instanceof TraceKernelProcessLimitError) {
    return Object.freeze({ code: "EAGAIN", message: error.message });
  }
  if (error instanceof TraceKernelWouldBlockError) {
    return Object.freeze({ code: "EAGAIN", message: error.message });
  }
  if (error instanceof TraceKernelTerminalError) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  if (error instanceof TraceKernelChildProcessError) {
    return Object.freeze({ code: "ECHILD", message: error.message });
  }
  if (error instanceof TraceKernelProcessPermissionError) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  if (error instanceof TraceKernelProcessStateError) {
    return Object.freeze({ code: "ESRCH", message: error.message });
  }
  if (error instanceof TraceKernelInvalidArgumentError) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  return Object.freeze({
    code: "EIO",
    message: error instanceof Error ? error.message : String(error)
  });
}
var TraceKernelSyscallDispatcher = class {
  constructor(session, process2) {
    this.session = session;
    this.process = process2;
  }
  dispatch(request) {
    return this.dispatchValue(request).pipe(
      match10({
        onFailure: (error) => Object.freeze({
          ok: false,
          error: syscallWireError(error)
        }),
        onSuccess: (value) => Object.freeze({
          ok: true,
          value
        })
      })
    );
  }
  dispatchValue(request) {
    switch (request.op) {
      case "pipe":
        return this.session.createPipe(
          this.process,
          this.process,
          request.options
        ).pipe(
          map11(({ readFd, writeFd }) => ({
            op: "pipe",
            readFd,
            writeFd
          }))
        );
      case "watch":
        return this.authorizeFileSystem([
          { path: request.path, permission: "read" }
        ]).pipe(
          zipRight2(this.session.watchFile(
            this.process,
            request.path,
            request.options
          )),
          map11((fd) => ({ op: "watch", fd }))
        );
      case "watchdog":
        return this.session.configureProcessWatchdog(
          this.process,
          request.action,
          {
            timeoutMs: request.timeoutMs,
            signal: request.signal
          }
        ).pipe(
          map11((watchdog) => ({
            op: "watchdog",
            armed: watchdog !== void 0,
            ...watchdog ?? {}
          }))
        );
      case "spawn":
        return (request.stdio ? this.session.spawnChildWithStdio(this.process, {
          runtime: request.runtime,
          command: request.command,
          args: request.args,
          cwd: request.cwd,
          env: request.env,
          inheritDescriptors: request.inheritDescriptors,
          descriptorMappings: request.descriptorMappings,
          descriptorActions: request.descriptorActions,
          processGroupId: request.processGroupId,
          sessionId: request.sessionId
        }, request.stdio) : this.session.spawnChild(this.process, {
          runtime: request.runtime,
          command: request.command,
          args: request.args,
          cwd: request.cwd,
          env: request.env,
          inheritDescriptors: request.inheritDescriptors,
          descriptorMappings: request.descriptorMappings,
          descriptorActions: request.descriptorActions,
          processGroupId: request.processGroupId,
          sessionId: request.sessionId
        }).pipe(
          map11((process2) => ({ process: process2 }))
        )).pipe(
          map11(({ process: process2, stdio }) => ({
            op: "spawn",
            pid: process2.pid,
            ...stdio ? { stdio } : {}
          }))
        );
      case "wait":
        return this.session.waitChild(this.process, request.pid, {
          noHang: request.noHang
        }).pipe(
          flatMap9(
            (snapshot) => snapshot === void 0 ? succeed5({
              op: "wait",
              pid: request.pid
            }) : snapshot.termination ? succeed5({
              op: "wait",
              pid: snapshot.pid,
              termination: snapshot.termination
            }) : fail6(new TraceKernelProcessStateError({
              pid: snapshot.pid,
              message: `Process ${snapshot.pid} completed without termination state.`
            }))
          )
        );
      case "identity":
        return this.session.processIdentity(
          this.process,
          request.pid
        ).pipe(
          map11((identity2) => ({
            op: "identity",
            ...identity2
          }))
        );
      case "processInfo":
        return this.session.processInfo(
          this.process,
          request.pid
        ).pipe(
          map11((process2) => ({
            op: "processInfo",
            process: process2
          }))
        );
      case "processList":
        return this.session.processList(this.process).pipe(
          map11((processes) => ({
            op: "processList",
            processes
          }))
        );
      case "environment":
        return this.session.processEnvironment(this.process).pipe(
          map11((env) => ({
            op: "environment",
            env
          }))
        );
      case "kill":
        return this.session.signalProcessTarget(
          this.process.snapshot().owner,
          this.process,
          request.pid,
          request.signal
        ).pipe(
          as4({ op: "kill" })
        );
      case "setsid":
        return this.session.createProcessSession(this.process).pipe(
          map11((sid) => ({ op: "setsid", sid, pgid: sid }))
        );
      case "setpgid":
        return this.session.setProcessGroup(
          this.process,
          request.pid,
          request.pgid
        ).pipe(
          map11((pgid) => ({ op: "setpgid", pgid }))
        );
      case "isatty":
        return this.session.isTerminal(this.process, request.fd).pipe(
          map11((isTerminal) => ({
            op: "isatty",
            isTerminal
          }))
        );
      case "tcgetpgrp":
        return this.session.terminalForegroundProcessGroup(
          this.process,
          request.fd
        ).pipe(
          map11((pgid) => ({ op: "tcgetpgrp", pgid }))
        );
      case "tcsetpgrp":
        return this.session.setTerminalForegroundProcessGroup(
          this.process,
          request.fd,
          request.pgid
        ).pipe(
          map11((pgid) => ({ op: "tcsetpgrp", pgid }))
        );
      case "tcgetwinsize":
        return this.session.terminalWindowSize(
          this.process,
          request.fd
        ).pipe(
          map11(({ rows, columns }) => ({
            op: "tcgetwinsize",
            rows,
            columns
          }))
        );
      case "tcsetwinsize":
        return this.session.setTerminalWindowSize(
          this.process,
          request.fd,
          request.rows,
          request.columns
        ).pipe(
          map11(({ rows, columns }) => ({
            op: "tcsetwinsize",
            rows,
            columns
          }))
        );
      case "socket":
        return this.session.createTcpSocket(this.process).pipe(
          map11((fd) => ({ op: "socket", fd }))
        );
      case "bind":
        return this.session.bindTcp(this.process, request.fd, request.address).pipe(
          map11((address) => ({ op: "bind", address }))
        );
      case "listen":
        return this.session.listenTcp(this.process, request.fd, request.options).pipe(
          as4({ op: "listen" })
        );
      case "accept":
        return this.session.acceptTcp(this.process, request.fd).pipe(
          map11(({ fd, localAddress, remoteAddress }) => ({
            op: "accept",
            fd,
            localAddress,
            remoteAddress
          }))
        );
      case "connect":
        return this.session.connectTcp(this.process, request.fd, request.address).pipe(
          map11(({ localAddress, remoteAddress }) => ({
            op: "connect",
            localAddress,
            remoteAddress
          }))
        );
      case "send":
        return this.process.write(request.fd, request.bytes).pipe(
          map11((bytesWritten) => ({ op: "send", bytesWritten }))
        );
      case "recv":
        return this.process.read(request.fd, request.maxBytes).pipe(
          map11((bytes) => ({ op: "recv", bytes }))
        );
      case "shutdown":
        return this.session.shutdownTcp(this.process, request.fd, request.how).pipe(
          as4({ op: "shutdown" })
        );
      case "getsockname":
        return this.session.tcpLocalAddress(this.process, request.fd).pipe(
          map11((address) => ({ op: "getsockname", address }))
        );
      case "getpeername":
        return this.session.tcpRemoteAddress(this.process, request.fd).pipe(
          map11((address) => ({ op: "getpeername", address }))
        );
      case "getsockopt":
        return this.session.tcpSocketError(this.process, request.fd).pipe(
          map11((error) => ({
            op: "getsockopt",
            ...error === void 0 ? {} : { error }
          }))
        );
      case "open":
        return this.authorizeFileSystem([
          ...request.options?.access === "read-write" ? [
            { path: request.path, permission: "read" },
            { path: request.path, permission: "write" }
          ] : [{
            path: request.path,
            permission: request.options?.access === "write" ? "write" : "read"
          }],
          ...request.options?.create || request.options?.truncate || request.options?.append ? [{ path: request.path, permission: "write" }] : []
        ]).pipe(
          zipRight2(
            this.session.openFile(this.process, request.path, request.options)
          ),
          map11((fd) => ({ op: "open", fd }))
        );
      case "read":
        return this.process.read(request.fd, request.maxBytes, request.position).pipe(
          map11((bytes) => ({ op: "read", bytes }))
        );
      case "write":
        return this.process.write(request.fd, request.bytes, request.position).pipe(
          map11((bytesWritten) => ({ op: "write", bytesWritten }))
        );
      case "seek":
        return this.process.seek(
          request.fd,
          request.offset,
          request.whence
        ).pipe(
          map11((offset) => ({ op: "seek", offset }))
        );
      case "close":
        return this.process.close(request.fd).pipe(
          as4({ op: "close" })
        );
      case "dup":
        return this.process.dup(request.fd).pipe(
          map11((fd) => ({ op: "dup", fd }))
        );
      case "dup2":
        return this.process.dup2(request.fd, request.targetFd).pipe(
          map11((fd) => ({ op: "dup2", fd }))
        );
      case "dup3":
        return this.process.dup3(
          request.fd,
          request.targetFd,
          request.closeOnExec
        ).pipe(
          map11((fd) => ({
            op: "dup3",
            fd,
            closeOnExec: request.closeOnExec
          }))
        );
      case "fcntl":
        return gen2(this, function* () {
          if (request.action === "set-close-on-exec") {
            yield* this.process.descriptors.setCloseOnExec(
              request.fd,
              request.closeOnExec === true
            );
          } else if (request.action === "set-nonblocking") {
            yield* this.process.descriptors.setNonblocking(
              request.fd,
              request.nonblocking === true
            );
          }
          const closeOnExec = yield* this.process.descriptors.getCloseOnExec(
            request.fd
          );
          const nonblocking = yield* this.process.descriptors.getNonblocking(
            request.fd
          );
          return { op: "fcntl", closeOnExec, nonblocking };
        });
      case "poll":
        return this.pollDescriptors(request.entries, request.timeoutMs);
      case "fstat":
        return this.process.fstat(request.fd).pipe(
          map11((stat) => ({ op: "fstat", stat }))
        );
      case "ftruncate":
        return this.process.ftruncate(request.fd, request.length).pipe(
          as4({ op: "ftruncate" })
        );
      case "stat":
        return this.authorizeFileSystem([{ path: request.path, permission: "metadata" }]).pipe(
          zipRight2(this.session.fileSystem.stat(
            request.path,
            this.process.snapshot().cwd
          )),
          map11((stat) => ({ op: "stat", stat }))
        );
      case "lstat":
        return this.authorizeFileSystem([{
          path: request.path,
          permission: "metadata",
          followFinal: false
        }]).pipe(
          zipRight2(this.session.fileSystem.lstat(
            request.path,
            this.process.snapshot().cwd
          )),
          map11((stat) => ({ op: "lstat", stat }))
        );
      case "realpath":
        return this.authorizeFileSystem([{ path: request.path, permission: "metadata" }]).pipe(
          zipRight2(this.session.fileSystem.realpath(
            request.path,
            this.process.snapshot().cwd
          )),
          map11((path) => ({ op: "realpath", path }))
        );
      case "readdir":
        return this.authorizeFileSystem([{ path: request.path, permission: "read" }]).pipe(
          zipRight2(this.session.fileSystem.readdir(
            request.path,
            this.process.snapshot().cwd
          )),
          map11((entries2) => ({ op: "readdir", entries: entries2 }))
        );
      case "mkdir":
        return this.authorizeFileSystem([{
          path: request.path,
          permission: "write",
          followFinal: false,
          allowMissingSuffix: request.options?.recursive === true
        }]).pipe(
          zipRight2(this.session.fileSystem.mkdir(
            request.path,
            request.options,
            this.process.snapshot().cwd,
            { origin: this.process.fileSystemMutationOrigin }
          )),
          as4({ op: "mkdir" })
        );
      case "rmdir":
        return this.authorizeFileSystem([{
          path: request.path,
          permission: "delete",
          followFinal: false
        }]).pipe(
          zipRight2(this.session.fileSystem.rmdir(
            request.path,
            this.process.snapshot().cwd,
            { origin: this.process.fileSystemMutationOrigin }
          )),
          as4({ op: "rmdir" })
        );
      case "unlink":
        return this.authorizeFileSystem([{
          path: request.path,
          permission: "delete",
          followFinal: false
        }]).pipe(
          zipRight2(this.session.fileSystem.unlink(
            request.path,
            this.process.snapshot().cwd,
            { origin: this.process.fileSystemMutationOrigin }
          )),
          as4({ op: "unlink" })
        );
      case "link":
        return this.authorizeFileSystem([
          {
            path: request.existingPath,
            permission: "read",
            followFinal: false
          },
          {
            path: request.newPath,
            permission: "write",
            followFinal: false
          }
        ]).pipe(
          zipRight2(this.session.fileSystem.link(
            request.existingPath,
            request.newPath,
            this.process.snapshot().cwd,
            { origin: this.process.fileSystemMutationOrigin }
          )),
          as4({ op: "link" })
        );
      case "symlink":
        return this.authorizeFileSystem([{
          path: request.linkPath,
          permission: "write",
          followFinal: false
        }]).pipe(
          zipRight2(this.session.fileSystem.symlink(
            request.target,
            request.linkPath,
            this.process.snapshot().cwd,
            { origin: this.process.fileSystemMutationOrigin }
          )),
          as4({ op: "symlink" })
        );
      case "readlink":
        return this.authorizeFileSystem([{
          path: request.path,
          permission: "read",
          followFinal: false
        }]).pipe(
          zipRight2(this.session.fileSystem.readlink(
            request.path,
            this.process.snapshot().cwd
          )),
          map11((target) => ({ op: "readlink", target }))
        );
      case "rename":
        return this.authorizeFileSystem([
          {
            path: request.sourcePath,
            permission: "delete",
            followFinal: false
          },
          {
            path: request.destinationPath,
            permission: "write",
            followFinal: false
          }
        ]).pipe(
          zipRight2(this.session.fileSystem.rename(
            request.sourcePath,
            request.destinationPath,
            this.process.snapshot().cwd,
            { origin: this.process.fileSystemMutationOrigin }
          )),
          as4({ op: "rename" })
        );
      case "readFile":
        return this.authorizeFileSystem([{ path: request.path, permission: "read" }]).pipe(
          zipRight2(this.session.fileSystem.readFileVersioned(
            request.path,
            this.process.snapshot().cwd
          )),
          map11(({ contents, cacheGeneration }) => ({
            op: "readFile",
            bytes: contents,
            cacheGeneration
          }))
        );
      case "writeFile":
        return this.authorizeFileSystem([{ path: request.path, permission: "write" }]).pipe(
          zipRight2(this.session.fileSystem.writeFile(
            request.path,
            request.bytes,
            this.process.snapshot().cwd,
            { origin: this.process.fileSystemMutationOrigin }
          )),
          as4({ op: "writeFile" })
        );
    }
  }
  authorizeFileSystem(accesses) {
    return this.session.authorizeFileSystem(this.process, accesses);
  }
  pollDescriptors(entries2, timeoutMs) {
    if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      return fail6(new TraceKernelInvalidArgumentError({
        code: "EINVAL",
        argument: "timeoutMs",
        message: `EINVAL: invalid poll timeout ${timeoutMs}`
      }));
    }
    const timeout2 = timeoutMs === void 0 ? void 0 : Math.max(0, Math.floor(timeoutMs));
    const startedAt = Date.now();
    const snapshot = () => forEach7(
      entries2,
      (entry) => this.process.descriptors.readiness(entry.fd, {
        read: entry.read === true,
        write: entry.write === true
      }).pipe(
        match10({
          onFailure: () => ({
            fd: entry.fd,
            read: false,
            write: false,
            hangup: false,
            error: false,
            invalid: true
          }),
          onSuccess: (ready) => ({
            fd: entry.fd,
            ...ready,
            invalid: false
          })
        })
      ),
      { concurrency: "unbounded" }
    ).pipe(
      map11((results) => results.filter(
        (result) => result.read || result.write || result.hangup || result.error || result.invalid
      ))
    );
    const loop2 = () => suspend3(() => snapshot().pipe(
      flatMap9((ready) => {
        if (ready.length > 0 || timeout2 === 0) {
          return succeed5({ op: "poll", entries: ready });
        }
        const elapsed = Date.now() - startedAt;
        const remaining = timeout2 === void 0 ? void 0 : timeout2 - elapsed;
        if (remaining !== void 0 && remaining <= 0) {
          return succeed5({ op: "poll", entries: [] });
        }
        const waits = entries2.map(
          (entry) => this.process.descriptors.awaitReadiness(entry.fd, {
            read: entry.read === true,
            write: entry.write === true
          }).pipe(
            asVoid2,
            catchAll2(() => _void)
          )
        );
        const awakened = waits.length === 0 ? never3 : raceAll2(waits);
        const wait = remaining === void 0 ? awakened : raceFirst2(awakened, sleep4(remaining));
        return wait.pipe(andThen4(loop2()));
      })
    ));
    return loop2();
  }
};

// packages/tracekernel/src/watch.ts
var WATCH_FRAME_MAGIC = Uint8Array.from([84, 75, 87, 49]);
var WATCH_FRAME_HEADER_BYTES = 9;
var WATCH_MAX_PATH_BYTES = 16 * 1024;
function encodeTraceKernelWatchEvent(event) {
  const path = new TextEncoder().encode(event.path);
  if (path.byteLength > WATCH_MAX_PATH_BYTES) {
    throw Object.assign(
      new Error(`ENAMETOOLONG: watch event path exceeds ${WATCH_MAX_PATH_BYTES} bytes`),
      { code: "ENAMETOOLONG" }
    );
  }
  const frame = new Uint8Array(WATCH_FRAME_HEADER_BYTES + path.byteLength);
  frame.set(WATCH_FRAME_MAGIC, 0);
  frame[4] = event.eventType === "change" ? 1 : event.eventType === "rename" ? event.entryOperation === "create" ? 4 : event.entryOperation === "delete" ? 5 : 2 : 3;
  new DataView(frame.buffer).setUint32(5, path.byteLength, true);
  frame.set(path, WATCH_FRAME_HEADER_BYTES);
  return frame;
}
var TraceKernelFileWatch = class _TraceKernelFileWatch {
  constructor(id2, registration, events, closedSignal, readinessChanged, readMutex, onFinalClose) {
    this.id = id2;
    this.registration = registration;
    this.events = events;
    this.closedSignal = closedSignal;
    this.readinessChanged = readinessChanged;
    this.readMutex = readMutex;
    this.onFinalClose = onFinalClose;
  }
  remainder = new Uint8Array();
  closed = false;
  references = 1;
  overflowPending = false;
  static make(id2, registration, options, onFinalClose) {
    return gen2(function* () {
      const events = yield* dropping2(
        Math.max(1, Math.floor(options.capacityEvents ?? 1024))
      );
      const closedSignal = yield* make33();
      const readinessChanged = yield* make33();
      const readMutex = yield* makeSemaphore2(1);
      return new _TraceKernelFileWatch(
        id2,
        registration,
        events,
        closedSignal,
        readinessChanged,
        readMutex,
        onFinalClose
      );
    });
  }
  matches(path) {
    const watched = this.registration.path;
    if (path === watched) return true;
    if (!this.registration.directory) return false;
    const prefix = watched === "/" ? "/" : `${watched}/`;
    if (!path.startsWith(prefix)) return false;
    const relative = path.slice(prefix.length);
    return this.registration.recursive || !relative.includes("/");
  }
  publish(event) {
    return suspend3(() => {
      if (this.closed) return _void;
      let frame;
      try {
        frame = encodeTraceKernelWatchEvent(event);
      } catch {
        this.overflowPending = true;
        return this.enqueueOverflowIfNeeded();
      }
      return offer3(this.events, frame).pipe(
        tap2((accepted) => accepted ? this.notifyReadiness() : sync3(() => {
          this.overflowPending = true;
        })),
        asVoid2
      );
    });
  }
  descriptor() {
    return {
      kind: "fs-watch",
      resourceId: this.id,
      resource: this,
      read: (maxBytes) => this.read(maxBytes).pipe(
        tap2(() => this.notifyReadiness())
      ),
      readiness: (events) => this.readiness(events),
      awaitReadiness: (events) => this.awaitReadiness(events),
      duplicate: () => this.duplicate(),
      close: () => this.close()
    };
  }
  read(maxBytes) {
    if (maxBytes === 0) return succeed5(new Uint8Array());
    return this.readMutex.withPermits(1)(
      suspend3(() => {
        if (this.closed) return this.closedError();
        if (this.remainder.byteLength > 0) {
          return succeed5(this.takeRemainder(maxBytes));
        }
        return raceFirst2(
          take2(this.events),
          _await3(this.closedSignal).pipe(
            andThen4(this.closedError())
          )
        ).pipe(
          tap2(() => this.enqueueOverflowIfNeeded()),
          map11((frame) => this.takeFrame(frame, maxBytes))
        );
      })
    );
  }
  enqueueOverflowIfNeeded() {
    if (!this.overflowPending || this.closed) return _void;
    return offer3(
      this.events,
      encodeTraceKernelWatchEvent({ eventType: "overflow", path: "" })
    ).pipe(
      tap2((accepted) => accepted ? sync3(() => {
        this.overflowPending = false;
      }).pipe(andThen4(this.notifyReadiness())) : _void),
      asVoid2
    );
  }
  readiness(events) {
    return isEmpty9(this.events).pipe(
      map11((empty25) => Object.freeze({
        read: events.read && (this.remainder.byteLength > 0 || !empty25),
        write: false,
        hangup: this.closed,
        error: false
      }))
    );
  }
  awaitReadiness(events) {
    return suspend3(() => {
      const changed = this.readinessChanged;
      return this.readiness(events).pipe(
        flatMap9(
          (readiness) => readiness.read || readiness.hangup ? succeed5(readiness) : _await3(changed).pipe(
            andThen4(this.awaitReadiness(events))
          )
        )
      );
    });
  }
  notifyReadiness() {
    return gen2(this, function* () {
      const previous = this.readinessChanged;
      const next = yield* make33();
      this.readinessChanged = next;
      yield* succeed4(previous, void 0);
    });
  }
  takeFrame(frame, maxBytes) {
    if (frame.byteLength <= maxBytes) return frame;
    this.remainder = frame.slice(maxBytes);
    return frame.slice(0, maxBytes);
  }
  takeRemainder(maxBytes) {
    const bytes = this.remainder.slice(0, maxBytes);
    this.remainder = this.remainder.slice(bytes.byteLength);
    return bytes;
  }
  duplicate() {
    return suspend3(() => {
      if (this.closed) return this.closedError();
      this.references += 1;
      return succeed5(this.descriptor());
    });
  }
  close() {
    return suspend3(() => {
      if (this.closed) return _void;
      this.references -= 1;
      if (this.references > 0) return _void;
      this.closed = true;
      this.onFinalClose(this.id);
      return succeed4(this.closedSignal, void 0).pipe(
        asVoid2,
        andThen4(this.notifyReadiness())
      );
    });
  }
  closedError() {
    return fail6(new TraceKernelBadFileDescriptorError({
      fd: -1,
      operation: "read",
      message: "EBADF: filesystem watch is closed"
    }));
  }
};
var TraceKernelWatchRegistry = class {
  watches = /* @__PURE__ */ new Map();
  nextId = 1;
  create(path, directory, options = {}) {
    const id2 = `watch-${this.nextId++}`;
    return TraceKernelFileWatch.make(
      id2,
      {
        path,
        directory,
        recursive: directory && options.recursive === true
      },
      options,
      (closedId) => this.watches.delete(closedId)
    ).pipe(
      tap2((watch) => sync3(() => {
        this.watches.set(id2, watch);
      })),
      map11((watch) => watch.descriptor())
    );
  }
  publish(mutation) {
    return forEach7(
      this.watches.values(),
      (watch) => forEach7(
        mutation.paths,
        (path, index) => watch.matches(path) ? watch.publish({
          eventType: mutation.eventType,
          ...mutation.eventType === "rename" ? {
            entryOperation: this.entryOperation(
              mutation.operation,
              index
            )
          } : {},
          path
        }) : _void,
        { concurrency: 1, discard: true }
      ),
      { concurrency: "unbounded", discard: true }
    );
  }
  activeCount() {
    return this.watches.size;
  }
  entryOperation(operation, pathIndex) {
    switch (operation) {
      case "mkdir":
      case "write":
      case "link":
      case "symlink":
      case "open-create":
        return "create";
      case "rmdir":
      case "unlink":
      case "clear":
        return "delete";
      case "rename":
        return pathIndex === 0 ? "delete" : "create";
      default:
        return void 0;
    }
  }
};

// packages/tracekernel/src/kernel/process-table.ts
var TraceKernelProcessTable = class {
  constructor(options) {
    this.options = options;
  }
  processes = /* @__PURE__ */ new Map();
  exitedChildren = /* @__PURE__ */ new Map();
  initRetainedProcesses = /* @__PURE__ */ new Set();
  waitingChildren = /* @__PURE__ */ new Set();
  reapedBeforeUnregister = /* @__PURE__ */ new Set();
  childWaiters = /* @__PURE__ */ new Set();
  nextPid = 100;
  closed = false;
  register(spec, started) {
    if (this.closed) {
      throw new TraceKernelSessionClosedError({
        sessionId: this.options.sessionId,
        message: `TraceKernel session ${this.options.sessionId} is closed.`
      });
    }
    if (this.processes.size + this.exitedChildren.size >= this.options.maxProcesses) {
      throw new TraceKernelProcessLimitError({
        code: "EAGAIN",
        maxProcesses: this.options.maxProcesses,
        message: `EAGAIN: session process limit ${this.options.maxProcesses} reached`
      });
    }
    const ppid = spec.parentPid ?? 1;
    const parent = ppid === 1 ? void 0 : this.processes.get(ppid);
    if (ppid !== 1 && !parent) {
      throw new TraceKernelProcessStateError({
        pid: ppid,
        message: `ESRCH: parent process ${ppid} does not exist in session ${this.options.sessionId}`
      });
    }
    const pid = this.nextPid;
    const parentSnapshot = parent?.snapshot();
    if (spec.sessionId !== void 0 && (!Number.isSafeInteger(spec.sessionId) || spec.sessionId < 0)) {
      throw new TraceKernelInvalidArgumentError({
        code: "EINVAL",
        argument: "sessionId",
        message: `EINVAL: invalid session id ${spec.sessionId}`
      });
    }
    if (spec.processGroupId !== void 0 && (!Number.isSafeInteger(spec.processGroupId) || spec.processGroupId < 0)) {
      throw new TraceKernelInvalidArgumentError({
        code: "EINVAL",
        argument: "processGroupId",
        message: `EINVAL: invalid process group id ${spec.processGroupId}`
      });
    }
    const startsNewSession = spec.sessionId === 0;
    const inheritedSid = parentSnapshot?.sid ?? pid;
    if (parent && spec.sessionId !== void 0 && !startsNewSession && spec.sessionId !== inheritedSid) {
      throw new TraceKernelInvalidArgumentError({
        code: "EINVAL",
        argument: "sessionId",
        message: `EINVAL: child session ${spec.sessionId} does not match parent session ${inheritedSid}`
      });
    }
    const sid = startsNewSession ? pid : parent ? inheritedSid : spec.sessionId ?? inheritedSid;
    const pgid = startsNewSession || spec.processGroupId === 0 ? pid : spec.processGroupId ?? parentSnapshot?.pgid ?? pid;
    if (pgid !== pid && !this.hasProcessGroup(pgid, sid)) {
      throw new TraceKernelInvalidArgumentError({
        code: "EINVAL",
        argument: "processGroupId",
        message: `EINVAL: process group ${pgid} does not exist in session ${sid}`
      });
    }
    this.nextPid += 1;
    const controllingTerminalId = !startsNewSession ? parentSnapshot?.controllingTerminalId ?? this.options.controllingTerminalForSession(sid) : void 0;
    const record = {
      pid,
      ppid,
      pgid,
      sid,
      ...controllingTerminalId === void 0 ? {} : { controllingTerminalId },
      phase: "created",
      schedulingState: "queued",
      runtime: spec.runtime,
      command: spec.command,
      args: Object.freeze([...spec.args ?? []]),
      cwd: spec.cwd ?? this.options.cwd,
      env: Object.freeze({ ...this.options.env, ...spec.env ?? {} }),
      owner: spec.owner ?? SYSTEM_PRINCIPAL,
      protected: spec.protected ?? false,
      visible: spec.visible ?? true,
      stdout: "",
      stderr: ""
    };
    const process2 = new TraceKernelProcess(
      record,
      started,
      this.options.maxDescriptorsPerProcess,
      this.options.signalGracePeriodMs
    );
    this.processes.set(pid, process2);
    if (ppid === 1 && spec.retainOnExit === true) {
      this.initRetainedProcesses.add(pid);
    }
    return process2;
  }
  unregister(pid) {
    const exited = this.processes.get(pid);
    this.processes.delete(pid);
    const alreadyReaped = this.reapedBeforeUnregister.delete(pid);
    if (exited) {
      const snapshot = exited.snapshot();
      if (snapshot.phase === "exited" && !alreadyReaped && (snapshot.ppid !== 1 || this.initRetainedProcesses.has(pid))) {
        this.exitedChildren.set(pid, exited);
      } else {
        this.initRetainedProcesses.delete(pid);
      }
    } else {
      this.initRetainedProcesses.delete(pid);
    }
    for (const process2 of this.processes.values()) {
      process2.reparent(pid, 1);
    }
    for (const [childPid, child] of this.exitedChildren) {
      if (childPid === pid) continue;
      if (child.snapshot().ppid === pid) {
        child.reparent(pid, 1);
        this.exitedChildren.delete(childPid);
      }
    }
    runSync(this.notifyChildWaiters());
  }
  inheritDescriptors(process2, spec) {
    if (spec.inheritDescriptors === void 0 && (spec.descriptorMappings?.length ?? 0) === 0) {
      return _void;
    }
    const parentPid = spec.parentPid ?? 1;
    const parent = this.processes.get(parentPid);
    if (!parent || parent === process2) {
      return fail6(new TraceKernelProcessStateError({
        pid: parentPid,
        message: `ESRCH: descriptor inheritance requires a live parent process in session ${this.options.sessionId}`
      }));
    }
    return gen2(function* () {
      if (spec.inheritDescriptors !== void 0) {
        yield* process2.descriptors.inherit(
          parent.descriptors,
          spec.inheritDescriptors === "all" ? void 0 : spec.inheritDescriptors
        );
      }
      if (spec.descriptorMappings && spec.descriptorMappings.length > 0) {
        yield* process2.descriptors.inheritMapped(
          parent.descriptors,
          spec.descriptorMappings.map(({ parentFd, childFd }) => ({
            sourceFd: parentFd,
            targetFd: childFd
          }))
        );
      }
    });
  }
  waitChild(parent, pid, options = {}) {
    return gen2(this, function* () {
      const selector = Math.trunc(pid);
      if (!Number.isSafeInteger(pid)) {
        return yield* fail6(new TraceKernelChildProcessError({
          code: "ECHILD",
          pid: selector,
          message: `ECHILD: invalid child selector ${pid}`
        }));
      }
      yield* this.assertOwned(parent);
      const snapshot = parent.snapshot();
      return yield* this.waitChildSelection(
        snapshot.pid,
        snapshot.pgid,
        selector,
        options,
        false
      );
    });
  }
  waitInitChild(pid, options = {}) {
    return suspend3(() => {
      const selector = Math.trunc(pid);
      if (!Number.isSafeInteger(pid)) {
        return fail6(new TraceKernelChildProcessError({
          code: "ECHILD",
          pid: selector,
          message: `ECHILD: invalid child selector ${pid}`
        }));
      }
      return this.waitChildSelection(1, 1, selector, options, true);
    });
  }
  processSnapshots(requester = SYSTEM_PRINCIPAL) {
    return this.visibleProcessSnapshots(this.processes.values(), requester);
  }
  processTableSnapshots(requester = SYSTEM_PRINCIPAL) {
    return this.visibleProcessSnapshots(this.allProcesses(), requester);
  }
  setSchedulingState(process2, state) {
    return this.assertOwned(process2).pipe(
      tap2(() => sync3(() => process2.setSchedulingState(state))),
      as4(state)
    );
  }
  processIdentity(caller, requestedPid) {
    return gen2(this, function* () {
      yield* this.assertOwned(caller);
      const pid = requestedPid === void 0 || requestedPid === 0 ? caller.pid : Math.trunc(requestedPid);
      if (!Number.isSafeInteger(requestedPid ?? 0) || pid <= 0) {
        return yield* this.processNotFound(
          pid,
          `ESRCH: invalid process identity target ${requestedPid}`
        );
      }
      const target = this.get(pid);
      if (!target) {
        return yield* this.processNotFound(pid);
      }
      const callerOwner = caller.snapshot().owner;
      const snapshot = target.snapshot();
      if (!snapshot.visible && callerOwner.kind !== "system" && (callerOwner.id !== snapshot.owner.id || callerOwner.kind !== snapshot.owner.kind)) {
        return yield* this.processNotFound(pid);
      }
      return {
        pid: snapshot.pid,
        ppid: snapshot.ppid,
        pgid: snapshot.pgid,
        sid: snapshot.sid
      };
    });
  }
  processInfo(caller, requestedPid) {
    return gen2(this, function* () {
      const identity2 = yield* this.processIdentity(caller, requestedPid);
      const target = this.get(identity2.pid);
      if (!target) return yield* this.processNotFound(identity2.pid);
      return processInfoProjection(target.snapshot());
    });
  }
  processList(caller) {
    return this.assertOwned(caller).pipe(
      map11(
        () => Object.freeze(
          this.processTableSnapshots(caller.snapshot().owner).map(processInfoProjection)
        )
      )
    );
  }
  processEnvironment(caller) {
    return this.assertOwned(caller).pipe(
      map11(() => Object.freeze({ ...caller.snapshot().env }))
    );
  }
  createProcessSession(process2) {
    return gen2(this, function* () {
      yield* this.assertOwned(process2);
      const snapshot = process2.snapshot();
      if (snapshot.pgid === snapshot.pid) {
        return yield* fail6(new TraceKernelProcessPermissionError({
          code: "EPERM",
          pid: process2.pid,
          requesterId: snapshot.owner.id,
          message: `EPERM: process ${process2.pid} is already a process-group leader`
        }));
      }
      process2.setTopology(process2.pid, process2.pid);
      process2.setControllingTerminal(void 0);
      yield* this.notifyChildWaiters();
      return process2.pid;
    });
  }
  setProcessGroup(caller, targetPid, processGroupId) {
    return gen2(this, function* () {
      yield* this.assertOwned(caller);
      const requestedPid = Math.trunc(targetPid);
      const requestedGroup = Math.trunc(processGroupId);
      if (!Number.isSafeInteger(targetPid) || !Number.isSafeInteger(processGroupId) || requestedPid < 0 || requestedGroup < 0) {
        return yield* fail6(new TraceKernelInvalidArgumentError({
          code: "EINVAL",
          argument: "setpgid",
          message: `EINVAL: invalid setpgid(${targetPid}, ${processGroupId})`
        }));
      }
      const target = requestedPid === 0 ? caller : this.processes.get(requestedPid);
      if (!target) return yield* this.processNotFound(requestedPid);
      if (target !== caller) {
        return yield* fail6(new TraceKernelProcessPermissionError({
          code: "EPERM",
          pid: target.pid,
          requesterId: caller.snapshot().owner.id,
          message: "EPERM: a running process may only change its own process group"
        }));
      }
      const snapshot = target.snapshot();
      if (snapshot.sid === snapshot.pid) {
        return yield* fail6(new TraceKernelProcessPermissionError({
          code: "EPERM",
          pid: target.pid,
          requesterId: snapshot.owner.id,
          message: `EPERM: session leader ${target.pid} cannot change process group`
        }));
      }
      const pgid = requestedGroup === 0 ? target.pid : requestedGroup;
      if (pgid !== target.pid && !this.hasProcessGroup(pgid, snapshot.sid)) {
        return yield* fail6(new TraceKernelInvalidArgumentError({
          code: "EINVAL",
          argument: "processGroupId",
          message: `EINVAL: process group ${pgid} does not exist in session ${snapshot.sid}`
        }));
      }
      target.setTopology(pgid, snapshot.sid);
      yield* this.notifyChildWaiters();
      return pgid;
    });
  }
  signalProcess(requester, pid, signal) {
    const process2 = this.processes.get(pid);
    return process2 ? process2.signal(signal, requester) : this.processNotFound(pid);
  }
  signalProcessTarget(requester, caller, targetPid, signal) {
    return gen2(this, function* () {
      yield* this.assertOwned(caller);
      const selector = Math.trunc(targetPid);
      if (!Number.isSafeInteger(targetPid)) {
        return yield* this.processNotFound(
          selector,
          `ESRCH: invalid process selector ${targetPid}`
        );
      }
      if (selector > 0) {
        return yield* this.signalProcess(requester, selector, signal);
      }
      const callerSnapshot = caller.snapshot();
      const candidates = this.activeProcesses().filter((process2) => {
        const snapshot = process2.snapshot();
        if (selector === -1) return snapshot.pid !== caller.pid;
        const processGroupId = selector === 0 ? callerSnapshot.pgid : -selector;
        return snapshot.pgid === processGroupId;
      });
      if (candidates.length === 0) {
        return yield* this.processNotFound(
          selector,
          selector === -1 ? `ESRCH: no other processes exist in session ${this.options.sessionId}` : `ESRCH: process group ${selector === 0 ? callerSnapshot.pgid : -selector} does not exist in session ${this.options.sessionId}`
        );
      }
      const deliveries = yield* forEach7(
        candidates,
        (process2) => process2.signal(signal, requester).pipe(
          match10({
            onFailure: (error) => ({ delivered: false, error }),
            onSuccess: () => ({ delivered: true })
          })
        ),
        { concurrency: "unbounded" }
      );
      if (deliveries.some((delivery) => delivery.delivered)) return;
      const denied = deliveries.find(
        (delivery) => !delivery.delivered
      );
      if (denied) return yield* fail6(denied.error);
    });
  }
  activeProcesses() {
    return [...this.processes.values()];
  }
  getActive(pid) {
    return this.processes.get(pid);
  }
  get(pid) {
    return this.processes.get(pid) ?? this.exitedChildren.get(pid);
  }
  hasActive(pid) {
    return this.processes.has(pid);
  }
  hasProcessGroup(processGroupId, sessionId) {
    return this.activeProcesses().some((candidate) => {
      const snapshot = candidate.snapshot();
      return snapshot.pgid === processGroupId && snapshot.sid === sessionId;
    });
  }
  assertOwned(process2) {
    return !this.closed && this.processes.get(process2.pid) === process2 ? _void : fail6(new TraceKernelProcessStateError({
      pid: process2.pid,
      message: this.closed ? `Session ${this.options.sessionId} is closed.` : `Process ${process2.pid} is not running in session ${this.options.sessionId}.`
    }));
  }
  close() {
    this.closed = true;
  }
  clear() {
    this.processes.clear();
    this.exitedChildren.clear();
    this.initRetainedProcesses.clear();
    this.waitingChildren.clear();
    this.reapedBeforeUnregister.clear();
    this.childWaiters.clear();
  }
  waitChildSelection(parentPid, parentProcessGroupId, selector, options, requireInitRetention) {
    return gen2(this, function* () {
      const changed = yield* make33();
      this.childWaiters.add(changed);
      const candidates = this.waitableChildren(
        parentPid,
        parentProcessGroupId,
        selector,
        requireInitRetention
      );
      if (candidates.length === 0) {
        this.childWaiters.delete(changed);
        return yield* fail6(new TraceKernelChildProcessError({
          code: "ECHILD",
          pid: selector,
          message: `ECHILD: selector ${selector} has no unreaped children of process ${parentPid}`
        }));
      }
      const child = candidates.find(
        (candidate) => candidate.snapshot().phase === "exited"
      );
      if (!child && options.noHang) {
        this.childWaiters.delete(changed);
        return void 0;
      }
      if (!child) {
        yield* _await3(changed).pipe(
          ensuring2(sync3(() => {
            this.childWaiters.delete(changed);
          }))
        );
        return yield* this.waitChildSelection(
          parentPid,
          parentProcessGroupId,
          selector,
          options,
          requireInitRetention
        );
      }
      this.childWaiters.delete(changed);
      this.waitingChildren.add(child.pid);
      let reaped = false;
      if (this.processes.has(child.pid)) {
        this.reapedBeforeUnregister.add(child.pid);
      }
      return yield* child.wait().pipe(
        tap2(() => sync3(() => {
          reaped = true;
          this.exitedChildren.delete(child.pid);
          this.initRetainedProcesses.delete(child.pid);
        })),
        ensuring2(sync3(() => {
          this.waitingChildren.delete(child.pid);
          if (!reaped) {
            this.reapedBeforeUnregister.delete(child.pid);
            runSync(this.notifyChildWaiters());
          }
        }))
      );
    });
  }
  waitableChildren(parentPid, parentProcessGroupId, selector, requireInitRetention) {
    return this.allProcesses().filter((child) => {
      const snapshot = child.snapshot();
      if (snapshot.ppid !== parentPid || this.waitingChildren.has(snapshot.pid) || this.reapedBeforeUnregister.has(snapshot.pid) || requireInitRetention && !this.initRetainedProcesses.has(snapshot.pid)) {
        return false;
      }
      if (selector > 0) return snapshot.pid === selector;
      if (selector === -1) return true;
      const processGroupId = selector === 0 ? parentProcessGroupId : -selector;
      return snapshot.pgid === processGroupId;
    }).sort((left3, right3) => left3.pid - right3.pid);
  }
  allProcesses() {
    return [...new Map([
      ...this.processes,
      ...this.exitedChildren
    ]).values()];
  }
  visibleProcessSnapshots(processes, requester) {
    return [...processes].map((process2) => process2.snapshot()).filter(
      (process2) => requester.kind === "system" || process2.visible || process2.owner.id === requester.id && process2.owner.kind === requester.kind
    ).sort((left3, right3) => left3.pid - right3.pid);
  }
  notifyChildWaiters() {
    return forEach7(
      [...this.childWaiters],
      (waiter) => succeed4(waiter, void 0),
      { concurrency: "unbounded", discard: true }
    );
  }
  processNotFound(pid, message = `ESRCH: process ${pid} does not exist in session ${this.options.sessionId}`) {
    return fail6(new TraceKernelProcessStateError({ pid, message }));
  }
};

// packages/tracekernel/src/kernel/process-watchdogs.ts
var TraceKernelProcessWatchdogs = class {
  constructor(scope2) {
    this.scope = scope2;
  }
  watchdogs = /* @__PURE__ */ new Map();
  configure(process2, action, options = {}) {
    return gen2(this, function* () {
      const current = this.watchdogs.get(process2.pid);
      if (action === "status") {
        return current ? Object.freeze({
          timeoutMs: current.timeoutMs,
          signal: current.signal,
          deadlineAt: current.deadlineAt
        }) : void 0;
      }
      if (action === "disarm") {
        yield* this.clear(process2);
        return void 0;
      }
      const timeoutMs = action === "pet" ? current?.timeoutMs : options.timeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs === void 0 || timeoutMs <= 0) {
        return yield* fail6(new TraceKernelInvalidArgumentError({
          code: "EINVAL",
          argument: action === "pet" ? "watchdog" : "timeoutMs",
          message: action === "pet" ? "EINVAL: cannot pet a disarmed watchdog" : "EINVAL: watchdog timeout must be a positive integer"
        }));
      }
      const signal = action === "pet" ? current?.signal : options.signal ?? "SIGTERM";
      if (!signal) {
        return yield* fail6(new TraceKernelInvalidArgumentError({
          code: "EINVAL",
          argument: "watchdog",
          message: "EINVAL: cannot pet a disarmed watchdog"
        }));
      }
      yield* this.clear(process2);
      const token = /* @__PURE__ */ Symbol(`watchdog-${process2.pid}`);
      const deadlineAt = Date.now() + timeoutMs;
      const fiber = yield* forkIn2(
        sleep4(timeoutMs).pipe(
          andThen4(suspend3(() => {
            if (this.watchdogs.get(process2.pid)?.token !== token) {
              return _void;
            }
            this.watchdogs.delete(process2.pid);
            process2.setWatchdog(void 0);
            return process2.signal(signal);
          })),
          ensuring2(sync3(() => {
            if (this.watchdogs.get(process2.pid)?.token === token) {
              this.watchdogs.delete(process2.pid);
              process2.setWatchdog(void 0);
            }
          }))
        ),
        this.scope
      );
      const snapshot = Object.freeze({ timeoutMs, signal, deadlineAt });
      this.watchdogs.set(process2.pid, {
        process: process2,
        token,
        timeoutMs,
        signal,
        deadlineAt,
        fiber
      });
      process2.setWatchdog(snapshot);
      return snapshot;
    });
  }
  clear(process2) {
    const watchdog = this.watchdogs.get(process2.pid);
    this.watchdogs.delete(process2.pid);
    process2.setWatchdog(void 0);
    return watchdog ? interrupt3(watchdog.fiber).pipe(asVoid2) : _void;
  }
  clearAll() {
    for (const watchdog of this.watchdogs.values()) {
      watchdog.process.setWatchdog(void 0);
    }
    this.watchdogs.clear();
  }
};

// packages/tracekernel/src/kernel/resources.ts
var TraceKernelResourceRegistry = class {
  resources = /* @__PURE__ */ new Map();
  nextResourceId = 1;
  allocateId(prefix) {
    return `${prefix}-${this.nextResourceId++}`;
  }
  set(id2, resource) {
    this.resources.set(id2, resource);
  }
  get(id2) {
    return this.resources.get(id2);
  }
  delete(id2) {
    return this.resources.delete(id2);
  }
  keys() {
    return this.resources.keys();
  }
  values() {
    return this.resources.values();
  }
  clear() {
    this.resources.clear();
  }
};

// packages/tracekernel/src/kernel/runtime-execution.ts
function runtimeContext(process2, sessionId, syscalls) {
  const snapshot = process2.snapshot();
  return Object.freeze({
    sessionId,
    pid: snapshot.pid,
    ppid: snapshot.ppid,
    pgid: snapshot.pgid,
    sid: snapshot.sid,
    ...snapshot.controllingTerminalId === void 0 ? {} : { controllingTerminalId: snapshot.controllingTerminalId },
    command: snapshot.command,
    args: snapshot.args,
    cwd: snapshot.cwd,
    env: snapshot.env,
    syscalls
  });
}
function revalidateRuntimeLease(lease, snapshot) {
  const termination = snapshot.termination;
  if (!termination || termination.kind === "failure") {
    return succeed5(Object.freeze({
      kind: "destroy",
      reason: "execution-failure",
      ...termination?.kind === "failure" && termination.message ? { message: termination.message } : {}
    }));
  }
  if (termination.kind === "signal") {
    return succeed5(Object.freeze({
      kind: "destroy",
      reason: "signaled",
      message: termination.signal
    }));
  }
  if (!lease.revalidate) {
    return succeed5(Object.freeze({
      kind: "destroy",
      reason: "unvalidated"
    }));
  }
  return lease.revalidate().pipe(
    match10({
      onFailure: (error) => Object.freeze({
        kind: "destroy",
        reason: "revalidation-failure",
        message: error.message
      }),
      onSuccess: () => Object.freeze({
        kind: "reuse",
        reason: "revalidated"
      })
    })
  );
}
function executeProcessWithRuntimeLease(process2, sessionId, syscalls, acquireLease) {
  const context2 = runtimeContext(process2, sessionId, syscalls);
  return acquireUseRelease2(
    acquireLease(context2),
    (lease) => process2.execute(lease, context2).pipe(
      flatMap9(
        (snapshot) => revalidateRuntimeLease(lease, snapshot).pipe(
          map11((disposition) => ({ snapshot, disposition }))
        )
      )
    ),
    (lease, exit4) => lease.release(
      isSuccess(exit4) ? exit4.value.disposition : Object.freeze({
        kind: "destroy",
        reason: "interrupted"
      })
    )
  ).pipe(
    map11(({ snapshot }) => snapshot)
  );
}

// packages/tracekernel/src/terminal.ts
function normalizeDimension(value, fallback) {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? Math.floor(value) : fallback;
}
var TraceKernelTerminal = class _TraceKernelTerminal {
  constructor(id2, name, sessionId, foregroundProcessGroupId, columns, rows, input, output) {
    this.id = id2;
    this.name = name;
    this.sessionId = sessionId;
    this.foregroundProcessGroupId = foregroundProcessGroupId;
    this.columns = columns;
    this.rows = rows;
    this.input = input;
    this.output = output;
  }
  closed = false;
  static make(id2, sessionId, foregroundProcessGroupId, options = {}) {
    return gen2(function* () {
      const inputChanged = yield* make33();
      const outputChanged = yield* make33();
      return new _TraceKernelTerminal(
        id2,
        options.name?.trim() || `/dev/${id2}`,
        sessionId,
        foregroundProcessGroupId,
        normalizeDimension(options.columns, 80),
        normalizeDimension(options.rows, 24),
        {
          chunks: [],
          remainder: new Uint8Array(0),
          eofPending: 0,
          changed: inputChanged
        },
        {
          chunks: [],
          remainder: new Uint8Array(0),
          eofPending: 0,
          changed: outputChanged
        }
      );
    });
  }
  snapshot() {
    return Object.freeze({
      id: this.id,
      name: this.name,
      sessionId: this.sessionId,
      foregroundProcessGroupId: this.foregroundProcessGroupId,
      columns: this.columns,
      rows: this.rows,
      closed: this.closed
    });
  }
  setForegroundProcessGroup(processGroupId) {
    this.foregroundProcessGroupId = processGroupId;
  }
  resize(columns, rows) {
    this.columns = normalizeDimension(columns, this.columns);
    this.rows = normalizeDimension(rows, this.rows);
  }
  descriptor(access) {
    const readable = access !== "write";
    const writable = access !== "read";
    return {
      kind: "terminal",
      resourceId: this.id,
      resource: this,
      ...readable ? {
        read: (maxBytes, _position, context2) => this.readInput(maxBytes, false, context2),
        readNonblocking: (maxBytes, _position, context2) => this.readInput(maxBytes, true, context2)
      } : {},
      ...writable ? {
        write: (bytes, _position, context2) => this.writeOutput(bytes, context2),
        writeNonblocking: (bytes, _position, context2) => this.writeOutput(bytes, context2)
      } : {},
      readiness: (events, context2) => this.descriptorReadiness(events, readable, writable, context2),
      awaitReadiness: (events, context2) => this.awaitDescriptorReadiness(events, readable, writable, context2),
      duplicate: () => succeed5(this.descriptor(access)),
      close: () => _void
    };
  }
  writeInput(bytes) {
    return this.writeStream(this.input, bytes);
  }
  signalInputEof() {
    return suspend3(() => {
      if (this.closed) {
        return fail6(new TraceKernelTerminalError({
          code: "EIO",
          message: `EIO: terminal ${this.name} is closed`
        }));
      }
      this.input.eofPending += 1;
      this.wake(this.input);
      return _void;
    });
  }
  readOutput(maxBytes, nonblocking = false) {
    return this.readStream(this.output, maxBytes, nonblocking);
  }
  discardInput() {
    return sync3(() => {
      this.input.chunks.length = 0;
      this.input.remainder = new Uint8Array(0);
      this.input.eofPending = 0;
      this.wake(this.input);
    });
  }
  dispose() {
    return sync3(() => {
      if (this.closed) return;
      this.closed = true;
      this.wake(this.input);
      this.wake(this.output);
    });
  }
  readInput(maxBytes, nonblocking = false, context2) {
    const accessError = this.processAccessError(context2, "read");
    if (accessError) return fail6(accessError);
    return this.readStream(this.input, maxBytes, nonblocking, true);
  }
  writeOutput(bytes, context2) {
    const accessError = this.processAccessError(context2, "write");
    if (accessError) return fail6(accessError);
    return this.writeStream(this.output, bytes);
  }
  writeStream(stream, bytes) {
    return suspend3(() => {
      if (this.closed) {
        return fail6(new TraceKernelTerminalError({
          code: "EIO",
          message: `EIO: terminal ${this.name} is closed`
        }));
      }
      const copy3 = Uint8Array.from(bytes);
      if (copy3.byteLength === 0) return succeed5(0);
      stream.chunks.push(copy3);
      this.wake(stream);
      return succeed5(copy3.byteLength);
    });
  }
  readStream(stream, maxBytes, nonblocking, consumeEof = false) {
    const requested = Math.max(0, Math.floor(maxBytes));
    if (requested === 0) return succeed5(new Uint8Array(0));
    return suspend3(() => {
      const available = this.takeBytes(stream, requested);
      if (available) return succeed5(available);
      if (consumeEof && stream.eofPending > 0) {
        stream.eofPending -= 1;
        return succeed5(new Uint8Array(0));
      }
      if (this.closed) return succeed5(new Uint8Array(0));
      if (nonblocking) {
        return fail6(new TraceKernelWouldBlockError({
          code: "EAGAIN",
          operation: "read",
          message: `EAGAIN: terminal ${this.name} has no readable bytes`
        }));
      }
      const changed = stream.changed;
      return _await3(changed).pipe(
        andThen4(
          this.readStream(stream, requested, false, consumeEof)
        )
      );
    });
  }
  takeBytes(stream, maxBytes) {
    let current = stream.remainder;
    if (current.byteLength === 0) {
      current = stream.chunks.shift() ?? current;
    }
    if (current.byteLength === 0) return void 0;
    const length3 = Math.min(maxBytes, current.byteLength);
    const result = current.slice(0, length3);
    stream.remainder = current.slice(length3);
    return result;
  }
  descriptorReadiness(events, readable, writable, context2) {
    return sync3(() => {
      const readableByProcess = !this.processAccessError(context2, "read");
      const writableByProcess = !this.processAccessError(context2, "write");
      return Object.freeze({
        read: events.read && readable && readableByProcess && (this.closed || this.input.eofPending > 0 || this.input.remainder.byteLength > 0 || this.input.chunks.length > 0),
        write: events.write && writable && writableByProcess && !this.closed,
        hangup: this.closed,
        error: events.read && readable && !readableByProcess || events.write && writable && !writableByProcess
      });
    });
  }
  awaitDescriptorReadiness(events, readable, writable, context2) {
    return this.descriptorReadiness(events, readable, writable, context2).pipe(
      flatMap9(
        (readiness) => readiness.read || readiness.write || readiness.hangup || readiness.error ? succeed5(readiness) : _await3(this.input.changed).pipe(
          andThen4(
            this.awaitDescriptorReadiness(
              events,
              readable,
              writable,
              context2
            )
          )
        )
      )
    );
  }
  wake(stream) {
    const changed = stream.changed;
    stream.changed = runSync(make33());
    runSync(succeed4(changed, void 0));
  }
  processAccessError(context2, operation) {
    if (!context2 || context2.sid !== this.sessionId) {
      return new TraceKernelTerminalError({
        code: "EIO",
        message: `EIO: process has no controlling terminal ${this.name}`
      });
    }
    if (operation === "read" && context2.pgid !== this.foregroundProcessGroupId) {
      return new TraceKernelTerminalError({
        code: "EIO",
        message: `EIO: background process group ${context2.pgid} cannot read terminal ${this.name}`
      });
    }
    return void 0;
  }
};

// packages/tracekernel/src/kernel/terminals.ts
var TraceKernelTerminals = class {
  constructor(processTable, resources, controllingTerminalsBySession, installDescriptor) {
    this.processTable = processTable;
    this.resources = resources;
    this.controllingTerminalsBySession = controllingTerminalsBySession;
    this.installDescriptor = installDescriptor;
  }
  controllingTerminalForSession(sessionId) {
    return this.controllingTerminalsBySession.get(sessionId);
  }
  clear() {
    this.controllingTerminalsBySession.clear();
  }
  createControllingTerminal(process2, options = {}) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const snapshot = process2.snapshot();
      if (snapshot.sid !== snapshot.pid) {
        return yield* fail6(new TraceKernelProcessPermissionError({
          code: "EPERM",
          pid: process2.pid,
          requesterId: snapshot.owner.id,
          message: `EPERM: only session leader ${snapshot.sid} may acquire a controlling terminal`
        }));
      }
      const existingId = this.controllingTerminalsBySession.get(snapshot.sid);
      if (existingId) {
        return yield* fail6(new TraceKernelProcessPermissionError({
          code: "EPERM",
          pid: process2.pid,
          requesterId: snapshot.owner.id,
          message: `EPERM: session ${snapshot.sid} already controls terminal ${existingId}`
        }));
      }
      const resourceId = this.resources.allocateId("tty");
      const terminal = yield* TraceKernelTerminal.make(
        resourceId,
        snapshot.sid,
        snapshot.pgid,
        options
      );
      this.resources.set(resourceId, terminal);
      this.controllingTerminalsBySession.set(snapshot.sid, resourceId);
      for (const candidate of this.processTable.activeProcesses()) {
        if (candidate.snapshot().sid === snapshot.sid) {
          candidate.setControllingTerminal(resourceId);
        }
      }
      return terminal;
    });
  }
  bootstrapSessionTerminal(process2, options = {}) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const snapshot = process2.snapshot();
      const existingId = this.controllingTerminalsBySession.get(snapshot.sid);
      if (existingId) {
        const existing = yield* this.terminalById(existingId);
        existing.resize(
          options.columns ?? existing.snapshot().columns,
          options.rows ?? existing.snapshot().rows
        );
        process2.setControllingTerminal(existing.id);
        return existing;
      }
      if (snapshot.sid !== snapshot.pid && snapshot.ppid !== 1) {
        return yield* fail6(new TraceKernelProcessPermissionError({
          code: "EPERM",
          pid: process2.pid,
          requesterId: snapshot.owner.id,
          message: `EPERM: process ${process2.pid} cannot bootstrap terminal for session ${snapshot.sid}`
        }));
      }
      const resourceId = this.resources.allocateId("tty");
      const terminal = yield* TraceKernelTerminal.make(
        resourceId,
        snapshot.sid,
        snapshot.pgid,
        options
      );
      this.resources.set(resourceId, terminal);
      this.controllingTerminalsBySession.set(snapshot.sid, resourceId);
      for (const candidate of this.processTable.activeProcesses()) {
        if (candidate.snapshot().sid === snapshot.sid) {
          candidate.setControllingTerminal(resourceId);
        }
      }
      return terminal;
    });
  }
  openTerminal(process2, terminalId, access = "read-write", fd) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const terminal = yield* this.terminalById(terminalId);
      const snapshot = process2.snapshot();
      if (snapshot.sid !== terminal.sessionId || snapshot.controllingTerminalId !== terminal.id) {
        return yield* fail6(new TraceKernelTerminalError({
          code: "ENOTTY",
          message: `ENOTTY: terminal ${terminal.name} does not control process ${process2.pid}`
        }));
      }
      return yield* this.installDescriptor(
        process2,
        terminal.descriptor(access),
        fd
      );
    });
  }
  attachTerminalStdio(process2, terminalId) {
    return gen2(this, function* () {
      const installed = [];
      return yield* gen2(this, function* () {
        installed.push(yield* this.openTerminal(process2, terminalId, "read", 0));
        installed.push(yield* this.openTerminal(process2, terminalId, "write", 1));
        installed.push(yield* this.openTerminal(process2, terminalId, "write", 2));
        return Object.freeze({
          stdinFd: 0,
          stdoutFd: 1,
          stderrFd: 2
        });
      }).pipe(
        onError2(
          () => forEach7(
            installed,
            (fd) => process2.close(fd).pipe(catchAll2(() => _void)),
            { concurrency: "unbounded", discard: true }
          )
        )
      );
    });
  }
  replaceTerminalStdio(process2, terminalId) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const terminal = yield* this.terminalById(terminalId);
      const snapshot = process2.snapshot();
      if (snapshot.sid !== terminal.sessionId || snapshot.controllingTerminalId !== terminal.id) {
        return yield* fail6(new TraceKernelTerminalError({
          code: "ENOTTY",
          message: `ENOTTY: terminal ${terminal.name} does not control process ${process2.pid}`
        }));
      }
      yield* process2.descriptors.replaceMany([
        { fd: 0, descriptor: terminal.descriptor("read") },
        { fd: 1, descriptor: terminal.descriptor("write") },
        { fd: 2, descriptor: terminal.descriptor("write") }
      ]);
      return Object.freeze({
        stdinFd: 0,
        stdoutFd: 1,
        stderrFd: 2
      });
    });
  }
  isTerminal(process2, fd) {
    return this.processTable.assertOwned(process2).pipe(
      andThen4(process2.descriptors.lookup(fd)),
      map11((descriptor2) => descriptor2.resource instanceof TraceKernelTerminal)
    );
  }
  terminalForegroundProcessGroup(process2, fd) {
    return this.controllingTerminalForDescriptor(process2, fd).pipe(
      map11((terminal) => terminal.snapshot().foregroundProcessGroupId)
    );
  }
  setTerminalForegroundProcessGroup(process2, fd, processGroupId) {
    return gen2(this, function* () {
      const terminal = yield* this.controllingTerminalForDescriptor(process2, fd);
      const pgid = Math.trunc(processGroupId);
      if (!Number.isSafeInteger(processGroupId) || pgid <= 0) {
        return yield* fail6(new TraceKernelInvalidArgumentError({
          code: "EINVAL",
          argument: "processGroupId",
          message: `EINVAL: invalid terminal foreground process group ${processGroupId}`
        }));
      }
      const member = [...this.processTable.activeProcesses()].find((candidate) => {
        const candidateSnapshot = candidate.snapshot();
        return candidateSnapshot.pgid === pgid && candidateSnapshot.sid === terminal.sessionId;
      });
      if (!member) {
        return yield* fail6(new TraceKernelProcessPermissionError({
          code: "EPERM",
          pid: process2.pid,
          requesterId: process2.snapshot().owner.id,
          message: `EPERM: process group ${pgid} is not in terminal session ${terminal.sessionId}`
        }));
      }
      terminal.setForegroundProcessGroup(pgid);
      return pgid;
    });
  }
  terminalWindowSize(process2, fd) {
    return this.controllingTerminalForDescriptor(process2, fd).pipe(
      map11((terminal) => {
        const snapshot = terminal.snapshot();
        return Object.freeze({
          rows: snapshot.rows,
          columns: snapshot.columns
        });
      })
    );
  }
  setTerminalWindowSize(process2, fd, rows, columns) {
    return gen2(this, function* () {
      const terminal = yield* this.controllingTerminalForDescriptor(process2, fd);
      const normalizedRows = Math.trunc(rows);
      const normalizedColumns = Math.trunc(columns);
      if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || normalizedRows <= 0 || normalizedColumns <= 0) {
        return yield* fail6(new TraceKernelInvalidArgumentError({
          code: "EINVAL",
          argument: "windowSize",
          message: `EINVAL: invalid terminal window size ${columns}x${rows}`
        }));
      }
      terminal.resize(normalizedColumns, normalizedRows);
      yield* this.signalTerminalForeground(terminal.id, "SIGWINCH").pipe(
        catchAll2(() => _void)
      );
      return Object.freeze({
        rows: normalizedRows,
        columns: normalizedColumns
      });
    });
  }
  signalTerminalForeground(terminalId, signal) {
    return gen2(this, function* () {
      const terminal = yield* this.terminalById(terminalId);
      const pgid = terminal.snapshot().foregroundProcessGroupId;
      const members = [...this.processTable.activeProcesses()].filter((candidate) => {
        const snapshot = candidate.snapshot();
        return snapshot.sid === terminal.sessionId && snapshot.pgid === pgid;
      });
      if (members.length === 0) {
        return yield* fail6(new TraceKernelProcessStateError({
          pid: -pgid,
          message: `ESRCH: terminal ${terminal.name} foreground process group ${pgid} is empty`
        }));
      }
      yield* forEach7(
        members,
        (member) => member.signal(signal),
        { concurrency: "unbounded", discard: true }
      );
    });
  }
  writeTerminalInput(terminalId, bytes) {
    return gen2(this, function* () {
      const terminal = yield* this.terminalById(terminalId);
      const signalByte = bytes.find((byte) => byte === 3 || byte === 28);
      if (signalByte === void 0) {
        return yield* terminal.writeInput(bytes);
      }
      yield* terminal.discardInput();
      yield* this.signalTerminalForeground(
        terminalId,
        signalByte === 3 ? "SIGINT" : "SIGQUIT"
      );
      return bytes.byteLength;
    });
  }
  sendTerminalInputEof(terminalId) {
    return this.terminalById(terminalId).pipe(
      flatMap9((terminal) => terminal.signalInputEof())
    );
  }
  readTerminalOutput(terminalId, maxBytes, nonblocking = false) {
    return this.terminalById(terminalId).pipe(
      flatMap9((terminal) => terminal.readOutput(maxBytes, nonblocking))
    );
  }
  resizeTerminal(terminalId, columns, rows) {
    return gen2(this, function* () {
      const terminal = yield* this.terminalById(terminalId);
      terminal.resize(columns, rows);
      yield* this.signalTerminalForeground(terminalId, "SIGWINCH").pipe(
        catchAll2(() => _void)
      );
      return terminal.snapshot();
    });
  }
  releaseTerminalForegroundToHost(terminalId, expectedProcessGroupId) {
    return gen2(this, function* () {
      const terminal = yield* this.terminalById(terminalId);
      if (terminal.snapshot().closed) {
        return yield* fail6(new TraceKernelTerminalError({
          code: "EIO",
          message: `EIO: terminal ${terminal.name} is closed`
        }));
      }
      if (terminal.snapshot().foregroundProcessGroupId !== expectedProcessGroupId) {
        return terminal.snapshot().foregroundProcessGroupId;
      }
      terminal.setForegroundProcessGroup(terminal.sessionId);
      return terminal.sessionId;
    });
  }
  closeTerminal(terminalId) {
    return gen2(this, function* () {
      const terminal = yield* this.terminalById(terminalId);
      const terminalSnapshot = terminal.snapshot();
      if (terminalSnapshot.closed) return;
      const foregroundMembers = [...this.processTable.activeProcesses()].filter(
        (candidate) => {
          const snapshot = candidate.snapshot();
          return snapshot.sid === terminalSnapshot.sessionId && snapshot.pgid === terminalSnapshot.foregroundProcessGroupId;
        }
      );
      yield* terminal.dispose();
      this.controllingTerminalsBySession.delete(terminalSnapshot.sessionId);
      for (const candidate of this.processTable.activeProcesses()) {
        if (candidate.snapshot().controllingTerminalId === terminal.id) {
          candidate.setControllingTerminal(void 0);
        }
      }
      yield* forEach7(
        foregroundMembers,
        (member) => member.signal("SIGHUP"),
        { concurrency: "unbounded", discard: true }
      );
    });
  }
  terminalSnapshots() {
    return [...this.resources.values()].filter(
      (resource) => resource instanceof TraceKernelTerminal
    ).map((terminal) => terminal.snapshot()).sort((left3, right3) => left3.id.localeCompare(right3.id));
  }
  terminalById(terminalId) {
    const resource = this.resources.get(terminalId);
    return resource instanceof TraceKernelTerminal ? succeed5(resource) : fail6(new TraceKernelTerminalError({
      code: "ENOTTY",
      message: `ENOTTY: terminal ${terminalId} does not exist`
    }));
  }
  controllingTerminalForDescriptor(process2, fd) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const descriptor2 = yield* process2.descriptors.lookup(fd);
      if (!(descriptor2.resource instanceof TraceKernelTerminal)) {
        return yield* fail6(new TraceKernelTerminalError({
          code: "ENOTTY",
          message: `ENOTTY: descriptor ${fd} is not a terminal`
        }));
      }
      const snapshot = process2.snapshot();
      if (snapshot.sid !== descriptor2.resource.sessionId || snapshot.controllingTerminalId !== descriptor2.resource.id) {
        return yield* fail6(new TraceKernelTerminalError({
          code: "ENOTTY",
          message: `ENOTTY: terminal descriptor ${fd} is not controlling process ${process2.pid}`
        }));
      }
      return descriptor2.resource;
    });
  }
};

// packages/tracekernel/src/kernel/session.ts
var TraceKernelSession = class {
  constructor(id2, host, scope2, fileSystem, networkNamespace, cwd, env, maxDescriptorsPerProcess, maxProcesses, signalGracePeriodMs, ownsFileSystem, fileSystemPolicy) {
    this.id = id2;
    this.host = host;
    this.scope = scope2;
    this.fileSystem = fileSystem;
    this.networkNamespace = networkNamespace;
    this.cwd = cwd;
    this.env = env;
    this.maxDescriptorsPerProcess = maxDescriptorsPerProcess;
    this.maxProcesses = maxProcesses;
    this.signalGracePeriodMs = signalGracePeriodMs;
    this.ownsFileSystem = ownsFileSystem;
    this.fileSystemPolicy = fileSystemPolicy;
    const controllingTerminalsBySession = /* @__PURE__ */ new Map();
    this.processTable = new TraceKernelProcessTable({
      sessionId: id2,
      cwd,
      env,
      maxDescriptorsPerProcess,
      maxProcesses,
      signalGracePeriodMs,
      controllingTerminalForSession: (sessionId) => controllingTerminalsBySession.get(sessionId)
    });
    this.terminals = new TraceKernelTerminals(
      this.processTable,
      this.resources,
      controllingTerminalsBySession,
      (process2, descriptor2, fd, options) => this.installDescriptor(process2, descriptor2, fd, options)
    );
    this.processWatchdogs = new TraceKernelProcessWatchdogs(scope2);
    this.stopWatchingFileSystemMutations = fileSystem.watchMutations((mutation) => {
      runSync(this.watchRegistry.publish(mutation));
    });
  }
  processTable;
  processWatchdogs;
  terminals;
  watchRegistry = new TraceKernelWatchRegistry();
  stopWatchingFileSystemMutations;
  resources = new TraceKernelResourceRegistry();
  closed = false;
  spawn(spec) {
    return this.spawnPrepared(spec);
  }
  spawnPrepared(spec, prepare) {
    return gen2(this, function* () {
      const started = yield* make33();
      const process2 = yield* try_2({
        try: () => this.processTable.register(spec, started),
        catch: (error) => error instanceof TraceKernelSessionClosedError || error instanceof TraceKernelProcessLimitError || error instanceof TraceKernelProcessStateError || error instanceof TraceKernelInvalidArgumentError ? error : new TraceKernelSessionClosedError({
          sessionId: this.id,
          message: error instanceof Error ? error.message : String(error)
        })
      });
      yield* this.processTable.inheritDescriptors(process2, spec).pipe(
        tapError2(
          () => process2.descriptors.closeAll().pipe(
            ensuring2(sync3(() => this.processTable.unregister(process2.pid)))
          )
        )
      );
      if (prepare) {
        yield* prepare(process2).pipe(
          tapError2(
            () => process2.descriptors.closeAll().pipe(
              ensuring2(sync3(() => this.processTable.unregister(process2.pid)))
            )
          )
        );
      }
      yield* this.applyProcessDescriptorActions(process2, spec).pipe(
        tapError2(
          () => process2.descriptors.closeAll().pipe(
            ensuring2(sync3(() => this.processTable.unregister(process2.pid)))
          )
        )
      );
      process2.markStarting();
      const program = executeProcessWithRuntimeLease(
        process2,
        this.id,
        new TraceKernelSyscallDispatcher(this, process2),
        (context2) => this.host.acquireRuntimeLease(spec.runtime, context2)
      ).pipe(
        catchAll2(
          (error) => process2.failBeforeExecution(error).pipe(
            map11(() => process2.snapshot())
          )
        ),
        flatMap9(
          (snapshot) => this.flushProcessStandardOutput(process2, snapshot).pipe(
            catchAll2(() => _void),
            as4(snapshot)
          )
        ),
        ensuring2(this.clearProcessWatchdog(process2)),
        ensuring2(process2.descriptors.closeAll()),
        ensuring2(sync3(() => this.processTable.unregister(process2.pid)))
      );
      const fiber = yield* forkIn2(program, this.scope);
      process2.attachFiber(fiber);
      return process2;
    });
  }
  spawnChild(parent, spec) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(parent);
      const parentSnapshot = parent.snapshot();
      return yield* this.spawn({
        ...spec,
        parentPid: parent.pid,
        owner: parentSnapshot.owner,
        protected: parentSnapshot.protected,
        visible: parentSnapshot.visible,
        cwd: spec.cwd ?? parentSnapshot.cwd,
        env: Object.freeze({
          ...parentSnapshot.env,
          ...spec.env ?? {}
        })
      });
    });
  }
  spawnChildWithStdio(parent, spec, stdio) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(parent);
      const parentSnapshot = parent.snapshot();
      const replacedStdioFds = new Set(
        [
          [0, stdio.stdin],
          [1, stdio.stdout],
          [2, stdio.stderr]
        ].filter(([, mode]) => mode === "pipe" || mode === "ignore").map(([fd]) => fd)
      );
      const inheritDescriptors = spec.inheritDescriptors === "all" ? parentSnapshot.descriptors.map(({ fd }) => fd).filter((fd) => !replacedStdioFds.has(fd)) : spec.inheritDescriptors?.filter((fd) => !replacedStdioFds.has(fd));
      let parentStdio;
      const process2 = yield* this.spawnPrepared(
        {
          ...spec,
          ...inheritDescriptors === void 0 ? {} : { inheritDescriptors },
          parentPid: parent.pid,
          owner: parentSnapshot.owner,
          protected: parentSnapshot.protected,
          visible: parentSnapshot.visible,
          cwd: spec.cwd ?? parentSnapshot.cwd,
          env: Object.freeze({
            ...parentSnapshot.env,
            ...spec.env ?? {}
          })
        },
        (child) => this.configureChildStdio(parent, child, stdio).pipe(
          tap2((configured) => sync3(() => {
            parentStdio = configured;
          })),
          asVoid2
        )
      ).pipe(
        tapError2(
          () => forEach7(
            Object.values(parentStdio ?? {}),
            (fd) => parent.close(fd).pipe(catchAll2(() => _void)),
            { concurrency: "unbounded", discard: true }
          )
        )
      );
      return Object.freeze({
        process: process2,
        ...parentStdio ? { stdio: parentStdio } : {}
      });
    });
  }
  waitChild(parent, pid, options = {}) {
    return this.processTable.waitChild(parent, pid, options);
  }
  waitInitChild(pid, options = {}) {
    return this.processTable.waitInitChild(pid, options);
  }
  execute(spec) {
    return gen2(this, function* () {
      const process2 = yield* this.spawn(spec);
      const snapshot = yield* process2.wait();
      if (snapshot.ppid === 1 && spec.retainOnExit === true) {
        yield* this.waitInitChild(snapshot.pid);
      }
      return snapshot;
    });
  }
  processSnapshots(requester = SYSTEM_PRINCIPAL) {
    return this.processTable.processSnapshots(requester);
  }
  processTableSnapshots(requester = SYSTEM_PRINCIPAL) {
    return this.processTable.processTableSnapshots(requester);
  }
  setProcessSchedulingState(process2, state) {
    return this.processTable.setSchedulingState(process2, state);
  }
  processIdentity(caller, requestedPid) {
    return this.processTable.processIdentity(caller, requestedPid);
  }
  processInfo(caller, requestedPid) {
    return this.processTable.processInfo(caller, requestedPid);
  }
  processList(caller) {
    return this.processTable.processList(caller);
  }
  processEnvironment(caller) {
    return this.processTable.processEnvironment(caller);
  }
  createProcessSession(process2) {
    return this.processTable.createProcessSession(process2);
  }
  createControllingTerminal(process2, options = {}) {
    return this.terminals.createControllingTerminal(process2, options);
  }
  /**
   * Establish or retrieve the host-provided console for an initial session.
   *
   * Browser workspaces have a kernel-owned bootstrap session whose leader is
   * outside the user process table (the conventional PID 1 boundary). A
   * top-level process in that session may therefore ask the host to establish
   * its console without pretending that the process itself is the session
   * leader. Runtime syscalls cannot invoke this host-only operation.
   */
  bootstrapSessionTerminal(process2, options = {}) {
    return this.terminals.bootstrapSessionTerminal(process2, options);
  }
  openTerminal(process2, terminalId, access = "read-write", fd) {
    return this.terminals.openTerminal(process2, terminalId, access, fd);
  }
  attachTerminalStdio(process2, terminalId) {
    return this.terminals.attachTerminalStdio(process2, terminalId);
  }
  replaceTerminalStdio(process2, terminalId) {
    return this.terminals.replaceTerminalStdio(process2, terminalId);
  }
  isTerminal(process2, fd) {
    return this.terminals.isTerminal(process2, fd);
  }
  terminalForegroundProcessGroup(process2, fd) {
    return this.terminals.terminalForegroundProcessGroup(process2, fd);
  }
  setTerminalForegroundProcessGroup(process2, fd, processGroupId) {
    return this.terminals.setTerminalForegroundProcessGroup(process2, fd, processGroupId);
  }
  terminalWindowSize(process2, fd) {
    return this.terminals.terminalWindowSize(process2, fd);
  }
  setTerminalWindowSize(process2, fd, rows, columns) {
    return this.terminals.setTerminalWindowSize(process2, fd, rows, columns);
  }
  signalTerminalForeground(terminalId, signal) {
    return this.terminals.signalTerminalForeground(terminalId, signal);
  }
  writeTerminalInput(terminalId, bytes) {
    return this.terminals.writeTerminalInput(terminalId, bytes);
  }
  sendTerminalInputEof(terminalId) {
    return this.terminals.sendTerminalInputEof(terminalId);
  }
  readTerminalOutput(terminalId, maxBytes, nonblocking = false) {
    return this.terminals.readTerminalOutput(terminalId, maxBytes, nonblocking);
  }
  resizeTerminal(terminalId, columns, rows) {
    return this.terminals.resizeTerminal(terminalId, columns, rows);
  }
  releaseTerminalForegroundToHost(terminalId, expectedProcessGroupId) {
    return this.terminals.releaseTerminalForegroundToHost(terminalId, expectedProcessGroupId);
  }
  closeTerminal(terminalId) {
    return this.terminals.closeTerminal(terminalId);
  }
  terminalSnapshots() {
    return this.terminals.terminalSnapshots();
  }
  setProcessGroup(caller, targetPid, processGroupId) {
    return this.processTable.setProcessGroup(caller, targetPid, processGroupId);
  }
  signalProcess(requester, pid, signal) {
    return this.processTable.signalProcess(requester, pid, signal);
  }
  signalProcessTarget(requester, caller, targetPid, signal) {
    return this.processTable.signalProcessTarget(
      requester,
      caller,
      targetPid,
      signal
    );
  }
  openNullDevice(process2, access, fd) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const descriptorId = this.resources.allocateId(
        `null-${process2.pid}-${fd ?? "auto"}`
      );
      return yield* this.installDescriptor(
        process2,
        makeTraceKernelNullDescriptor(descriptorId, access),
        fd
      );
    });
  }
  attachNullStandardIo(process2) {
    return gen2(this, function* () {
      const installed = [];
      return yield* gen2(this, function* () {
        installed.push(yield* this.openNullDevice(process2, "read", 0));
        installed.push(yield* this.openNullDevice(process2, "write", 1));
        installed.push(yield* this.openNullDevice(process2, "write", 2));
        return Object.freeze({
          stdinFd: 0,
          stdoutFd: 1,
          stderrFd: 2
        });
      }).pipe(
        onError2(
          () => forEach7(
            installed,
            (installedFd) => process2.close(installedFd).pipe(
              catchAll2(() => _void)
            ),
            { concurrency: "unbounded", discard: true }
          )
        )
      );
    });
  }
  ensureNullStandardIo(process2) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const existing = new Set(
        process2.descriptors.snapshots().map((descriptor2) => descriptor2.fd)
      );
      const installed = [];
      return yield* gen2(this, function* () {
        if (!existing.has(0)) {
          installed.push(yield* this.openNullDevice(process2, "read", 0));
        }
        if (!existing.has(1)) {
          installed.push(yield* this.openNullDevice(process2, "write", 1));
        }
        if (!existing.has(2)) {
          installed.push(yield* this.openNullDevice(process2, "write", 2));
        }
        return Object.freeze({
          stdinFd: 0,
          stdoutFd: 1,
          stderrFd: 2
        });
      }).pipe(
        onError2(
          () => forEach7(
            installed,
            (installedFd) => process2.close(installedFd).pipe(
              catchAll2(() => _void)
            ),
            { concurrency: "unbounded", discard: true }
          )
        )
      );
    });
  }
  replaceNullStandardIo(process2) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const resourcePrefix = this.resources.allocateId(
        `null-${process2.pid}-replace`
      );
      yield* process2.descriptors.replaceMany([
        {
          fd: 0,
          descriptor: makeTraceKernelNullDescriptor(
            `${resourcePrefix}-0`,
            "read"
          )
        },
        {
          fd: 1,
          descriptor: makeTraceKernelNullDescriptor(
            `${resourcePrefix}-1`,
            "write"
          )
        },
        {
          fd: 2,
          descriptor: makeTraceKernelNullDescriptor(
            `${resourcePrefix}-2`,
            "write"
          )
        }
      ]);
      return Object.freeze({
        stdinFd: 0,
        stdoutFd: 1,
        stderrFd: 2
      });
    });
  }
  attachHostStandardIo(process2, options = {}) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const createPipe = (stream) => TraceKernelPipe.make(
        this.resources.allocateId(`host-${stream}-${process2.pid}`),
        options,
        (closedId) => this.resources.delete(closedId)
      ).pipe(
        tap2(
          (pipe2) => sync3(() => this.resources.set(pipe2.id, pipe2))
        )
      );
      const stdin = yield* createPipe("stdin");
      const stdout = yield* createPipe("stdout").pipe(
        tapError2(() => stdin.dispose())
      );
      const stderr = yield* createPipe("stderr").pipe(
        tapError2(
          () => all3([stdin.dispose(), stdout.dispose()], {
            concurrency: "unbounded",
            discard: true
          })
        )
      );
      const hostStdin = stdin.writer();
      const hostStdout = stdout.reader();
      const hostStderr = stderr.reader();
      yield* process2.descriptors.replaceMany([
        { fd: 0, descriptor: stdin.reader() },
        { fd: 1, descriptor: stdout.writer() },
        { fd: 2, descriptor: stderr.writer() }
      ]).pipe(
        tapError2(
          () => all3(
            [hostStdin.close(), hostStdout.close(), hostStderr.close()],
            { concurrency: "unbounded", discard: true }
          )
        )
      );
      return Object.freeze({
        stdinResourceId: stdin.id,
        stdoutResourceId: stdout.id,
        stderrResourceId: stderr.id,
        writeStdin: (bytes) => hostStdin.write(bytes),
        closeStdin: () => hostStdin.close(),
        readStdout: (maxBytes) => hostStdout.read(Math.max(0, Math.floor(maxBytes))),
        readStderr: (maxBytes) => hostStderr.read(Math.max(0, Math.floor(maxBytes))),
        closeStdout: () => hostStdout.close(),
        closeStderr: () => hostStderr.close(),
        close: () => all3(
          [hostStdin.close(), hostStdout.close(), hostStderr.close()],
          { concurrency: "unbounded", discard: true }
        )
      });
    });
  }
  configureProcessWatchdog(process2, action, options = {}) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      return yield* this.processWatchdogs.configure(process2, action, options);
    });
  }
  clearProcessWatchdog(process2) {
    return this.processWatchdogs.clear(process2);
  }
  createPipe(reader, writer, options = {}) {
    return this.createPipeAt(reader, writer, options).pipe(
      mapError2(
        (error) => error instanceof TraceKernelProcessStateError || error instanceof TraceKernelDescriptorLimitError ? error : new TraceKernelDescriptorLimitError({
          code: "EMFILE",
          maxDescriptors: Math.min(
            reader.descriptors.maxDescriptors,
            writer.descriptors.maxDescriptors
          ),
          message: error.message
        })
      )
    );
  }
  createPipeAt(reader, writer, options = {}, readerFd, writerFd) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(reader);
      yield* this.processTable.assertOwned(writer);
      const resourceId = this.resources.allocateId("pipe");
      const pipe2 = yield* TraceKernelPipe.make(
        resourceId,
        options,
        (closedId) => this.resources.delete(closedId)
      );
      this.resources.set(resourceId, pipe2);
      return yield* gen2(this, function* () {
        const descriptorOptions = {
          closeOnExec: options.closeOnExec === true,
          nonblocking: options.nonblocking === true
        };
        const readFd = yield* this.installDescriptor(
          reader,
          pipe2.reader(),
          readerFd,
          descriptorOptions
        );
        const writeFd = yield* this.installDescriptor(
          writer,
          pipe2.writer(),
          writerFd,
          descriptorOptions
        ).pipe(
          tapError2(
            () => reader.descriptors.close(readFd).pipe(catchAll2(() => _void))
          )
        );
        return Object.freeze({ resourceId, readFd, writeFd });
      }).pipe(
        onError2(() => pipe2.dispose())
      );
    });
  }
  configureChildStdio(parent, child, stdio) {
    return gen2(this, function* () {
      const parentDescriptors = [];
      const configured = {};
      return yield* gen2(this, function* () {
        for (const [fd, mode] of [
          [0, stdio.stdin],
          [1, stdio.stdout],
          [2, stdio.stderr]
        ]) {
          if (mode === "inherit" && !child.descriptors.snapshots().some((snapshot) => snapshot.fd === fd)) {
            yield* child.descriptors.inherit(parent.descriptors, [fd]);
          }
        }
        if (stdio.stdin === "pipe") {
          const pipe2 = yield* this.createPipeAt(child, parent, {}, 0);
          configured.stdinFd = pipe2.writeFd;
          parentDescriptors.push(pipe2.writeFd);
        }
        if (stdio.stdout === "pipe") {
          const pipe2 = yield* this.createPipeAt(parent, child, {}, void 0, 1);
          configured.stdoutFd = pipe2.readFd;
          parentDescriptors.push(pipe2.readFd);
        }
        if (stdio.stderr === "pipe") {
          const pipe2 = yield* this.createPipeAt(parent, child, {}, void 0, 2);
          configured.stderrFd = pipe2.readFd;
          parentDescriptors.push(pipe2.readFd);
        }
        return Object.keys(configured).length === 0 ? void 0 : Object.freeze({ ...configured });
      }).pipe(
        onError2(
          () => forEach7(
            parentDescriptors,
            (fd) => parent.close(fd).pipe(catchAll2(() => _void)),
            { concurrency: "unbounded", discard: true }
          )
        )
      );
    });
  }
  flushProcessStandardOutput(process2, snapshot) {
    const writes = [];
    if (snapshot.stdout.length > 0 && process2.descriptors.snapshots().some(({ fd }) => fd === 1)) {
      writes.push(process2.write(1, new TextEncoder().encode(snapshot.stdout)));
    }
    if (snapshot.stderr.length > 0 && process2.descriptors.snapshots().some(({ fd }) => fd === 2)) {
      writes.push(process2.write(2, new TextEncoder().encode(snapshot.stderr)));
    }
    return forEach7(writes, (write) => write, {
      concurrency: 1,
      discard: true
    });
  }
  resourceIds() {
    return [
      ...this.resources.keys(),
      ...this.networkNamespace.resourceIds()
    ].sort();
  }
  createTcpSocket(process2) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const socket = yield* this.networkNamespace.createSocket();
      return yield* this.installDescriptor(process2, socket.descriptor());
    });
  }
  bindTcp(process2, fd, address) {
    return this.tcpSocketFor(process2, fd).pipe(
      flatMap9((socket) => socket.bind(address))
    );
  }
  listenTcp(process2, fd, options = {}) {
    return this.tcpSocketFor(process2, fd).pipe(
      flatMap9((socket) => socket.listen(options))
    );
  }
  acceptTcp(process2, fd) {
    return all3({
      socket: this.tcpSocketFor(process2, fd),
      nonblocking: process2.descriptors.getNonblocking(fd)
    }).pipe(
      flatMap9(
        ({ socket, nonblocking }) => nonblocking ? socket.acceptNonblocking() : socket.accept()
      ),
      flatMap9(
        (accepted) => this.installDescriptor(process2, accepted.socket.descriptor()).pipe(
          map11((fd2) => Object.freeze({
            fd: fd2,
            localAddress: accepted.localAddress,
            remoteAddress: accepted.remoteAddress
          }))
        )
      )
    );
  }
  connectTcp(process2, fd, address) {
    return all3({
      socket: this.tcpSocketFor(process2, fd),
      nonblocking: process2.descriptors.getNonblocking(fd)
    }).pipe(
      flatMap9(
        ({ socket, nonblocking }) => nonblocking ? socket.connectNonblocking(address) : socket.connect(address)
      )
    );
  }
  tcpSocketError(process2, fd) {
    return this.tcpSocketFor(process2, fd).pipe(
      flatMap9((socket) => socket.takeConnectError())
    );
  }
  shutdownTcp(process2, fd, how) {
    return this.tcpSocketFor(process2, fd).pipe(
      flatMap9((socket) => socket.shutdown(how))
    );
  }
  tcpLocalAddress(process2, fd) {
    return this.tcpSocketFor(process2, fd).pipe(
      flatMap9((socket) => socket.localAddress())
    );
  }
  tcpRemoteAddress(process2, fd) {
    return this.tcpSocketFor(process2, fd).pipe(
      flatMap9((socket) => socket.remoteAddress())
    );
  }
  openFile(process2, path, options = {}) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const resourceId = this.resources.allocateId("file");
      const description = yield* TraceKernelOpenFileDescription.make(
        resourceId,
        this.fileSystem,
        path,
        process2.snapshot().cwd,
        options,
        (closedId) => this.resources.delete(closedId),
        { origin: process2.fileSystemMutationOrigin }
      );
      this.resources.set(resourceId, description);
      return yield* this.installDescriptor(process2, description.descriptor());
    });
  }
  authorizeFileSystem(process2, accesses) {
    if (!this.fileSystemPolicy || accesses.length === 0) return _void;
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const snapshot = process2.snapshot();
      const normalized = yield* forEach7(
        accesses,
        (access) => this.normalizePolicyAccess(
          access.path,
          access.permission,
          snapshot.cwd,
          access.followFinal !== false,
          access.allowMissingSuffix === true
        )
      );
      yield* this.fileSystemPolicy.authorize(Object.freeze({
        pid: snapshot.pid,
        cwd: snapshot.cwd,
        owner: snapshot.owner,
        accesses: Object.freeze(normalized)
      }));
    });
  }
  watchFile(process2, path, options = {}) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      const resolved = yield* this.fileSystem.resolve(path, process2.snapshot().cwd);
      const stat = yield* this.fileSystem.stat(resolved, "/");
      const descriptor2 = yield* this.watchRegistry.create(
        resolved,
        stat.kind === "directory",
        options
      );
      return yield* this.installDescriptor(process2, descriptor2);
    });
  }
  readFile(path) {
    return this.fileSystem.readFile(path, this.cwd);
  }
  writeFile(path, contents) {
    return this.fileSystem.writeFile(path, contents, this.cwd);
  }
  stat(path) {
    return this.fileSystem.stat(path, this.cwd);
  }
  lstat(path) {
    return this.fileSystem.lstat(path, this.cwd);
  }
  realpath(path) {
    return this.fileSystem.realpath(path, this.cwd);
  }
  readdir(path) {
    return this.fileSystem.readdir(path, this.cwd);
  }
  mkdir(path, options = {}) {
    return this.fileSystem.mkdir(path, options, this.cwd);
  }
  rmdir(path) {
    return this.fileSystem.rmdir(path, this.cwd);
  }
  unlink(path) {
    return this.fileSystem.unlink(path, this.cwd);
  }
  link(existingPath, newPath) {
    return this.fileSystem.link(existingPath, newPath, this.cwd);
  }
  symlink(target, linkPath) {
    return this.fileSystem.symlink(target, linkPath, this.cwd);
  }
  readlink(path) {
    return this.fileSystem.readlink(path, this.cwd);
  }
  rename(sourcePath, destinationPath) {
    return this.fileSystem.rename(sourcePath, destinationPath, this.cwd);
  }
  fileSnapshots() {
    return this.fileSystem.snapshots();
  }
  /**
   * Restore one process-owned execution scope between cases in a leased
   * language runtime. Non-standard descriptors are closed before TKFS rolls
   * back, so no open file or socket can retain authority into the next case.
   */
  resetProcessExecutionScope(process2, fileSystemImage, preservedDescriptors = [0, 1, 2]) {
    return gen2(this, function* () {
      yield* this.processTable.assertOwned(process2);
      yield* this.clearProcessWatchdog(process2);
      const descendantPids = /* @__PURE__ */ new Set([process2.pid]);
      const descendants = [];
      let foundDescendant = true;
      while (foundDescendant) {
        foundDescendant = false;
        for (const candidate of this.processTable.activeProcesses()) {
          if (candidate === process2 || descendantPids.has(candidate.pid) || !descendantPids.has(candidate.snapshot().ppid)) {
            continue;
          }
          descendantPids.add(candidate.pid);
          descendants.push(candidate);
          foundDescendant = true;
        }
      }
      yield* forEach7(
        descendants.reverse(),
        (descendant) => descendant.signal("SIGKILL").pipe(
          catchAll2(() => _void)
        ),
        { concurrency: 1, discard: true }
      );
      const preserved = new Set(preservedDescriptors);
      const descriptors = process2.descriptors.snapshots().map(({ fd }) => fd).filter((fd) => !preserved.has(fd));
      yield* forEach7(
        descriptors,
        (fd) => process2.close(fd).pipe(
          catchAll2(() => _void)
        ),
        { concurrency: "unbounded", discard: true }
      );
      yield* this.fileSystem.restoreQuiescentImage(
        fileSystemImage,
        { origin: process2.fileSystemMutationOrigin }
      );
    });
  }
  get fileSystemGeneration() {
    return this.fileSystem.mutationGeneration;
  }
  shutdown() {
    return suspend3(() => {
      if (this.closed) return _void;
      this.closed = true;
      this.processTable.close();
      const processes = this.processTable.activeProcesses();
      return forEach7(
        processes,
        (process2) => process2.signal("SIGKILL"),
        { concurrency: "unbounded", discard: true }
      ).pipe(
        andThen4(forEach7(
          [...this.resources.values()],
          (resource) => resource.dispose(),
          { concurrency: "unbounded", discard: true }
        )),
        andThen4(this.networkNamespace.dispose()),
        andThen4(close(this.scope, void_3)),
        ensuring2(sync3(() => {
          this.stopWatchingFileSystemMutations();
          this.processTable.clear();
          this.processWatchdogs.clearAll();
          this.terminals.clear();
          this.resources.clear();
          if (this.ownsFileSystem) this.fileSystem.clear();
          this.host.unregisterSession(
            this.id,
            this.ownsFileSystem ? void 0 : this.fileSystem
          );
        }))
      );
    });
  }
  normalizePolicyAccess(path, permission, cwd, followFinal = true, allowMissingSuffix = false) {
    return gen2(this, function* () {
      const requestedPath = yield* this.fileSystem.resolve(path, cwd);
      const finalSeparator = requestedPath.lastIndexOf("/");
      let candidate = followFinal || requestedPath === "/" ? requestedPath : finalSeparator <= 0 ? "/" : requestedPath.slice(0, finalSeparator);
      const missingSuffix = followFinal || requestedPath === "/" ? [] : [requestedPath.slice(finalSeparator + 1)];
      while (true) {
        const resolved = yield* either3(
          this.fileSystem.realpath(candidate, "/")
        );
        if (resolved._tag === "Right") {
          const canonicalPath = missingSuffix.length === 0 ? resolved.right : resolved.right === "/" ? `/${missingSuffix.join("/")}` : `${resolved.right}/${missingSuffix.join("/")}`;
          return Object.freeze({
            requestedPath,
            path: canonicalPath,
            permission
          });
        }
        if (resolved.left.code !== "ENOENT") {
          return yield* fail6(resolved.left);
        }
        if (!allowMissingSuffix && missingSuffix.length > 0) {
          return yield* fail6(resolved.left);
        }
        if (candidate === "/") return yield* fail6(resolved.left);
        const separator = candidate.lastIndexOf("/");
        missingSuffix.unshift(candidate.slice(separator + 1));
        candidate = separator <= 0 ? "/" : candidate.slice(0, separator);
      }
    });
  }
  applyProcessDescriptorActions(process2, spec) {
    return forEach7(
      spec.descriptorActions ?? [],
      (action) => action.op === "dup2" ? process2.dup2(action.fd, action.targetFd).pipe(asVoid2) : process2.close(action.fd),
      { concurrency: 1, discard: true }
    );
  }
  tcpSocketFor(process2, fd) {
    return this.processTable.assertOwned(process2).pipe(
      andThen4(process2.descriptors.lookup(fd)),
      flatMap9((descriptor2) => descriptor2.resource instanceof TraceKernelTcpSocket ? succeed5(descriptor2.resource) : fail6(new TraceKernelNetworkError({
        code: "EOPNOTSUPP",
        message: `EOPNOTSUPP: descriptor ${fd} is not a TCP socket`
      })))
    );
  }
  installDescriptor(process2, descriptor2, fd, options = {}) {
    return try_2({
      try: () => fd === void 0 ? process2.descriptors.install(descriptor2, options) : process2.descriptors.installAt(fd, descriptor2, options),
      catch: (error) => error instanceof TraceKernelDescriptorLimitError ? error : new TraceKernelDescriptorLimitError({
        code: "EMFILE",
        maxDescriptors: process2.descriptors.maxDescriptors,
        message: error instanceof Error ? error.message : String(error)
      })
    }).pipe(
      tapError2(() => descriptor2.close())
    );
  }
};

// packages/tracekernel/src/kernel/runtime-providers.ts
function makeTraceKernelRuntimeProviderSlots(providers) {
  return forEach7(
    providers,
    (provider) => cached3(provider.initialize).pipe(
      map11((initialize) => [provider.runtime, { provider, initialize }])
    )
  ).pipe(
    map11((entries2) => new Map(entries2))
  );
}
function acquireTraceKernelRuntimeLease(slots, runtime3, process2) {
  const slot = slots.get(runtime3);
  if (!slot) {
    return fail6(new TraceKernelRuntimeUnavailableError({
      runtime: runtime3,
      message: `Runtime provider ${JSON.stringify(runtime3)} is not registered.`
    }));
  }
  return slot.initialize.pipe(
    flatMap9((factory) => factory.acquire(process2))
  );
}

// packages/tracekernel/src/kernel/host.ts
function normalizeDescriptorLimit(value) {
  const requested = Number(value ?? 1024);
  return Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 1024;
}
function normalizeProcessLimit(value) {
  const requested = Number(value ?? 256);
  return Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 256;
}
function normalizeSignalGracePeriod(value) {
  const requested = Number(value ?? 1e3);
  return Number.isFinite(requested) && requested >= 0 ? Math.floor(requested) : 1e3;
}
var TraceKernelHost = class {
  constructor(providerSlots) {
    this.providerSlots = providerSlots;
  }
  sessions = /* @__PURE__ */ new Map();
  claimedFileSystems = /* @__PURE__ */ new WeakSet();
  nextSessionId = 1;
  closed = false;
  openSession(options = {}) {
    return gen2(this, function* () {
      if (this.closed) {
        return yield* fail6(new TraceKernelHostClosedError({
          message: "TraceKernel host is closed."
        }));
      }
      const cwd = options.cwd ?? "/workspace";
      if (options.fileSystem && options.fileSystemImage) {
        return yield* fail6(new TraceKernelFileSystemError({
          code: "EINVAL",
          path: cwd,
          message: "EINVAL: fileSystem and fileSystemImage are mutually exclusive"
        }));
      }
      const ownsFileSystem = options.fileSystem === void 0;
      const fileSystem = options.fileSystem ?? (options.fileSystemImage ? yield* TraceKernelFileSystem.fromImage(options.fileSystemImage) : yield* TraceKernelFileSystem.make());
      const cwdStat = yield* fileSystem.stat(cwd, "/");
      if (cwdStat.kind !== "directory") {
        return yield* fail6(new TraceKernelFileSystemError({
          code: "ENOTDIR",
          path: cwd,
          message: `ENOTDIR: session cwd is not a directory ${JSON.stringify(cwd)}`
        }));
      }
      const networkNamespace = yield* TraceKernelNetworkNamespace.make();
      const sessionScope = yield* make31();
      return yield* acquireRelease2(
        try_2({
          try: () => {
            if (!ownsFileSystem) {
              if (this.claimedFileSystems.has(fileSystem)) {
                throw new TraceKernelFileSystemError({
                  code: "EBUSY",
                  path: cwd,
                  message: "EBUSY: TKFS is already claimed by a live session"
                });
              }
              this.claimedFileSystems.add(fileSystem);
            }
            const id2 = `session-${this.nextSessionId++}`;
            try {
              const session = new TraceKernelSession(
                id2,
                this,
                sessionScope,
                fileSystem,
                networkNamespace,
                cwd,
                Object.freeze({ ...options.env ?? {} }),
                normalizeDescriptorLimit(options.maxDescriptorsPerProcess),
                normalizeProcessLimit(options.maxProcesses),
                normalizeSignalGracePeriod(options.signalGracePeriodMs),
                ownsFileSystem,
                options.fileSystemPolicy
              );
              this.sessions.set(id2, session);
              return session;
            } catch (error) {
              if (!ownsFileSystem) this.claimedFileSystems.delete(fileSystem);
              throw error;
            }
          },
          catch: (error) => error instanceof TraceKernelFileSystemError ? error : new TraceKernelFileSystemError({
            code: "EINVAL",
            path: cwd,
            message: error instanceof Error ? error.message : String(error)
          })
        }),
        (session) => session.shutdown()
      );
    });
  }
  sessionIds() {
    return [...this.sessions.keys()];
  }
  acquireRuntimeLease(runtime3, process2) {
    return suspend3(() => {
      if (this.closed) {
        return fail6(new TraceKernelHostClosedError({
          message: "TraceKernel host is closed."
        }));
      }
      return acquireTraceKernelRuntimeLease(
        this.providerSlots,
        runtime3,
        process2
      );
    });
  }
  shutdown() {
    return suspend3(() => {
      if (this.closed) return _void;
      this.closed = true;
      return forEach7(
        [...this.sessions.values()],
        (session) => session.shutdown(),
        { concurrency: "unbounded", discard: true }
      ).pipe(
        ensuring2(sync3(() => this.sessions.clear()))
      );
    });
  }
  unregisterSession(id2, fileSystem) {
    this.sessions.delete(id2);
    if (fileSystem) this.claimedFileSystems.delete(fileSystem);
  }
};
function makeTraceKernelHost(options = {}) {
  return acquireRelease2(
    makeTraceKernelRuntimeProviderSlots(options.providers ?? []).pipe(
      map11((slots) => new TraceKernelHost(slots))
    ),
    (host) => host.shutdown()
  );
}

// packages/runtime-java/src/tracekernel-local-java-host.ts
var JAVA_KERNEL_RUNTIME = "java-process";
function syscallRequest(request) {
  return {
    ...request.payload ?? {},
    op: request.operation
  };
}
async function createLocalJavaKernelAuthority() {
  const scope2 = runSync(make31());
  const controlledRuntime = new TraceKernelControlledRuntime(
    JAVA_KERNEL_RUNTIME
  );
  let process2;
  let closed = false;
  try {
    const authority = await runPromise(
      extend2(
        gen2(function* () {
          const host = yield* makeTraceKernelHost({
            providers: [controlledRuntime.provider]
          });
          const session = yield* host.openSession({
            cwd: "/workspace",
            signalGracePeriodMs: 0
          });
          yield* session.mkdir("/tmp", { recursive: true });
          yield* session.mkdir("/var", { recursive: true });
          yield* session.mkdir("/var/tmp", { recursive: true });
          const kernelProcess = yield* session.spawn({
            runtime: JAVA_KERNEL_RUNTIME,
            command: "java",
            cwd: "/workspace",
            owner: { id: "java", kind: "user" }
          });
          yield* session.attachNullStandardIo(kernelProcess);
          const context2 = yield* controlledRuntime.awaitAttached(
            kernelProcess.pid
          );
          const executionScopeImage = yield* session.fileSystem.exportImage();
          return {
            context: context2,
            kernelProcess,
            resetExecutionScope: () => runPromise(
              session.resetProcessExecutionScope(
                kernelProcess,
                executionScopeImage
              )
            )
          };
        }),
        scope2
      )
    );
    process2 = authority.kernelProcess;
    return {
      dispatchSync: (request) => runSync(
        authority.context.syscalls.dispatch(syscallRequest(request))
      ),
      dispatch: (request) => runPromise(
        authority.context.syscalls.dispatch(syscallRequest(request))
      ),
      resetExecutionScope: authority.resetExecutionScope,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await runPromise(
            controlledRuntime.complete(authority.kernelProcess.pid, {
              exitCode: 0
            })
          );
          await runPromise(authority.kernelProcess.wait());
        } finally {
          await runPromise(close(scope2, void_3));
        }
      }
    };
  } catch (error) {
    if (process2) {
      await runPromise(
        controlledRuntime.fail(
          process2.pid,
          error instanceof Error ? error : new Error(String(error))
        )
      ).catch(() => void 0);
    }
    await runPromise(close(scope2, fail3(error))).catch(
      () => void 0
    );
    throw error;
  }
}
export {
  createLocalJavaKernelAuthority
};

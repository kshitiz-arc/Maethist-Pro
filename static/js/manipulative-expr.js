(function (global) {
  "use strict";

  // Pure expression engine for algebra-tile labels. No DOM, no app state: the
  // whole module is a tokenizer -> recursive-descent parser -> evaluator so it
  // can be exercised on its own from a unit test or a console.
  //
  // Grammar
  //   expression := term (("+" | "-") term)*
  //   term       := unary (("*" | "/") unary)*
  //   unary      := ("+" | "-") unary | primary
  //   primary    := NUMBER | IDENT | "(" expression ")"

  const IDENT_START = /[A-Za-z_]/;
  const IDENT_BODY = /[A-Za-z0-9_]/;
  const DIGIT = /[0-9]/;
  const MAX_LENGTH = 64;

  // Typed characters that mean "minus" on a tablet keyboard but are not ASCII.
  const NORMALIZE_MAP = {
    "−": "-", // minus sign
    "–": "-", // en dash
    "—": "-", // em dash
    "×": "*", // multiplication sign
    "÷": "/", // division sign
    "·": "*"  // middle dot
  };

  function normalizeSource(input) {
    if (typeof input !== "string") return "";
    let out = "";
    for (const character of input) {
      out += NORMALIZE_MAP[character] || character;
    }
    return out.trim().slice(0, MAX_LENGTH);
  }

  function tokenize(source) {
    const tokens = [];
    let index = 0;

    while (index < source.length) {
      const character = source[index];

      if (character === " " || character === "\t") {
        index += 1;
        continue;
      }

      if (IDENT_START.test(character)) {
        let name = character;
        index += 1;
        while (index < source.length && IDENT_BODY.test(source[index])) {
          name += source[index];
          index += 1;
        }
        tokens.push({ type: "ident", value: name });
        continue;
      }

      if (DIGIT.test(character) || (character === "." && DIGIT.test(source[index + 1] || ""))) {
        let raw = "";
        while (index < source.length && DIGIT.test(source[index])) {
          raw += source[index];
          index += 1;
        }
        if (source[index] === ".") {
          raw += ".";
          index += 1;
          while (index < source.length && DIGIT.test(source[index])) {
            raw += source[index];
            index += 1;
          }
        }
        tokens.push({ type: "number", value: Number(raw) });
        continue;
      }

      if ("+-*/()".includes(character)) {
        tokens.push({ type: character });
        index += 1;
        continue;
      }

      return { tokens: null, error: `Unexpected "${character}"` };
    }

    return { tokens, error: null };
  }

  function parse(source) {
    const normalized = normalizeSource(source);
    if (!normalized) return { node: null, error: "Empty expression" };

    const scan = tokenize(normalized);
    if (scan.error) return { node: null, error: scan.error };

    const tokens = scan.tokens;
    let cursor = 0;

    const peek = () => tokens[cursor] || null;
    const eat = (type) => {
      if (peek()?.type === type) {
        cursor += 1;
        return true;
      }
      return false;
    };

    function parseExpression() {
      let left = parseTerm();
      if (left.error) return left;
      while (peek() && (peek().type === "+" || peek().type === "-")) {
        const operator = peek().type;
        cursor += 1;
        const right = parseTerm();
        if (right.error) return right;
        left = { node: { kind: "binary", operator, left: left.node, right: right.node }, error: null };
      }
      return left;
    }

    function parseTerm() {
      let left = parseUnary();
      if (left.error) return left;
      while (peek() && (peek().type === "*" || peek().type === "/")) {
        const operator = peek().type;
        cursor += 1;
        const right = parseUnary();
        if (right.error) return right;
        left = { node: { kind: "binary", operator, left: left.node, right: right.node }, error: null };
      }
      return left;
    }

    function parseUnary() {
      if (peek() && (peek().type === "+" || peek().type === "-")) {
        const operator = peek().type;
        cursor += 1;
        const operand = parseUnary();
        if (operand.error) return operand;
        return { node: { kind: "unary", operator, operand: operand.node }, error: null };
      }
      return parsePrimary();
    }

    function parsePrimary() {
      const token = peek();
      if (!token) return { node: null, error: "Expression ends too early" };

      if (token.type === "number") {
        cursor += 1;
        return { node: { kind: "number", value: token.value }, error: null };
      }

      if (token.type === "ident") {
        cursor += 1;
        return { node: { kind: "variable", name: token.value }, error: null };
      }

      if (token.type === "(") {
        cursor += 1;
        const inner = parseExpression();
        if (inner.error) return inner;
        if (!eat(")")) return { node: null, error: "Missing )" };
        return inner;
      }

      return { node: null, error: `Unexpected "${token.type}"` };
    }

    const result = parseExpression();
    if (result.error) return result;
    if (cursor < tokens.length) return { node: null, error: "Unexpected trailing input" };
    return { node: result.node, error: null };
  }

  function walk(node, visit) {
    if (!node) return;
    visit(node);
    if (node.kind === "binary") {
      walk(node.left, visit);
      walk(node.right, visit);
    } else if (node.kind === "unary") {
      walk(node.operand, visit);
    }
  }

  function dependenciesOf(source) {
    const { node } = parse(source);
    const names = new Set();
    walk(node, (item) => {
      if (item.kind === "variable") names.add(item.name);
    });
    return names;
  }

  function evaluateNode(node, registry, usedVars, missing) {
    switch (node.kind) {
      case "number":
        return node.value;
      case "variable": {
        usedVars.add(node.name);
        const value = registry ? registry[node.name] : undefined;
        if (!Number.isFinite(value)) {
          missing.add(node.name);
          return 0;
        }
        return value;
      }
      case "unary": {
        const value = evaluateNode(node.operand, registry, usedVars, missing);
        return node.operator === "-" ? -value : value;
      }
      case "binary": {
        const left = evaluateNode(node.left, registry, usedVars, missing);
        const right = evaluateNode(node.right, registry, usedVars, missing);
        if (node.operator === "+") return left + right;
        if (node.operator === "-") return left - right;
        if (node.operator === "*") return left * right;
        if (node.operator === "/") return right === 0 ? NaN : left / right;
        return NaN;
      }
      default:
        return NaN;
    }
  }

  function evaluate(source, registry) {
    const usedVars = new Set();
    const missing = new Set();
    const { node, error } = parse(source);

    if (error) return { value: null, usedVars, missing, error };

    const value = evaluateNode(node, registry || {}, usedVars, missing);

    if (missing.size) {
      return {
        value: Number.isFinite(value) ? value : null,
        usedVars,
        missing,
        error: `Unknown ${missing.size > 1 ? "variables" : "variable"} ${[...missing].join(", ")}`
      };
    }

    if (!Number.isFinite(value)) {
      return { value: null, usedVars, missing, error: "Cannot evaluate" };
    }

    return { value, usedVars, missing, error: null };
  }

  // Describes what a typed label means, so callers never re-implement the
  // "is this a plain name, a constant, or real arithmetic?" test.
  function classify(source) {
    const normalized = normalizeSource(source);
    if (!normalized) return { kind: "empty", text: "" };

    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
      return { kind: "variable", text: normalized, name: normalized };
    }

    if (/^\d+(\.\d+)?$|^\.\d+$/.test(normalized)) {
      return { kind: "number", text: normalized, value: Number(normalized) };
    }

    const { node, error } = parse(normalized);
    if (error || !node) return { kind: "error", text: normalized, error: error || "Invalid expression" };
    return { kind: "expression", text: normalized, dependencies: dependenciesOf(normalized) };
  }

  // graph: { name: Set<name> }. Returns the names that sit on a cycle.
  function findCycles(graph) {
    const cycles = new Set();
    const visiting = new Set();
    const done = new Set();

    function visit(name, trail) {
      if (done.has(name)) return;
      if (visiting.has(name)) {
        const start = trail.indexOf(name);
        trail.slice(start === -1 ? 0 : start).forEach((item) => cycles.add(item));
        return;
      }
      visiting.add(name);
      trail.push(name);
      (graph[name] || []).forEach((next) => visit(next, trail));
      trail.pop();
      visiting.delete(name);
      done.add(name);
    }

    Object.keys(graph || {}).forEach((name) => visit(name, []));
    return cycles;
  }

  const api = { normalizeSource, parse, evaluate, dependenciesOf, classify, findCycles };

  global.Inkyscib = global.Inkyscib || {};
  global.Inkyscib.ManipulativeExpr = api;

  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

// Public answer syntax and submission contract; never reads gold values.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const MAX_STRICT_ANSWER_CHARS = 262_144;

export function findDuplicateJsonKeys(text) {
  const duplicates = new Set();
  const frameStack = [];
  let inString = false;
  let escape = false;
  let buffer = "";
  // expectKey tracks whether the next JSON string is an object key: true
  // after `{` or `,` inside an object; reset by `:` once the key is consumed.
  let expectKey = false;
  const topFrame = () => frameStack[frameStack.length - 1];
  const afterValue = () => { const top = topFrame(); expectKey = Boolean(top && top.kind === "obj"); };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) { escape = false; buffer += ch; }
      else if (ch === "\\") { escape = true; buffer += ch; }
      else if (ch === '"') {
        inString = false;
        let value = buffer;
        buffer = "";
        try {
          value = JSON.parse(`"${value}"`);
        } catch {
          // malformed escape: JSON.parse of the whole answer rejects it later
        }
        if (expectKey) {
          const top = topFrame();
          if (top && top.kind === "obj") {
            if (top.keys.has(value)) duplicates.add(value);
            top.keys.add(value);
          }
          // expectKey stays set until the ':' that follows the key.
        } else {
          afterValue();
        }
      } else {
        buffer += ch;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      buffer = "";
      escape = false;
      continue;
    }
    if (ch === ":") { expectKey = false; continue; }
    if (ch === "{") {
      frameStack.push({ kind: "obj", keys: new Set() });
      expectKey = true;
      continue;
    }
    if (ch === "}") { frameStack.pop(); afterValue(); continue; }
    if (ch === "[") { afterValue(); frameStack.push({ kind: "arr" }); expectKey = false; continue; }
    if (ch === "]") { frameStack.pop(); afterValue(); continue; }
    if (ch === ",") {
      const top = topFrame();
      expectKey = Boolean(top && top.kind === "obj");
      continue;
    }
  }
  return [...duplicates];
}

export function parseStrictAnswer(rawAnswer) {
  if (typeof rawAnswer !== "string") return { ok: false, reason: "not_string" };
  const text = rawAnswer.trim();
  if (text.length > MAX_STRICT_ANSWER_CHARS) return { ok: false, reason: "input_too_long" };
  const duplicates = findDuplicateJsonKeys(text);
  if (duplicates.length > 0) return { ok: false, reason: "duplicate_keys", duplicates };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "parse_error" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "not_object" };
  return { ok: true, value };
}

function publicFields(answerKeys, fields) {
  if (!answerKeys || typeof answerKeys !== "object" || Array.isArray(answerKeys)) throw new TypeError("answerKeys must be a public key-to-type object");
  const entries = Object.entries(answerKeys);
  for (const [key, type] of entries) {
    if (!["string", "boolean", "integer", "array"].includes(type)) throw new TypeError(`unsupported answer type for ${key}: ${type}`);
  }
  if (!fields) return Object.fromEntries(entries.map(([key, type]) => [key, { type }]));
  if (typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).length !== entries.length || !entries.every(([key]) => Object.hasOwn(fields, key))) throw new TypeError("public field keys must match answerKeys");
  const check = (spec, key) => {
    if (!spec || typeof spec !== "object" || Array.isArray(spec) || !["string", "boolean", "integer", "array"].includes(spec.type)) throw new TypeError(`invalid public field type: ${key}`);
    for (const name of Object.keys(spec)) if (!["type", "description", "pattern", "minLength", "enum", "items", "order"].includes(name)) throw new TypeError(`unsupported public constraint: ${key}.${name}`);
    if (Object.hasOwn(spec, "description") && typeof spec.description !== "string") throw new TypeError(`invalid public description: ${key}`);
    if (Object.hasOwn(spec, "pattern")) {
      if (spec.type !== "string" || typeof spec.pattern !== "string") throw new TypeError(`invalid public pattern: ${key}`);
      new RegExp(spec.pattern, "u");
    }
    if (Object.hasOwn(spec, "minLength") && (spec.type !== "string" || !Number.isInteger(spec.minLength) || spec.minLength < 0)) throw new TypeError(`invalid public minLength: ${key}`);
    if (Object.hasOwn(spec, "enum") && (spec.type !== "string" || !Array.isArray(spec.enum) || spec.enum.length === 0 || spec.enum.some(v => typeof v !== "string") || new Set(spec.enum).size !== spec.enum.length)) throw new TypeError(`invalid public enum: ${key}`);
    if (Object.hasOwn(spec, "items")) {
      if (spec.type !== "array") throw new TypeError(`invalid public items: ${key}`);
      check(spec.items, `${key}[]`);
    }
    if (Object.hasOwn(spec, "order") && (spec.type !== "array" || spec.order !== "lexical" || spec.items?.type !== "string")) throw new TypeError(`invalid public order: ${key}`);
  };
  for (const [key, type] of entries) {
    if (fields[key]?.type !== type) throw new TypeError(`public field type must match answerKeys: ${key}`);
    check(fields[key], key);
  }
  return structuredClone(fields);
}

function schemaProperty(spec) {
  const { order: _order, ...property } = spec;
  if (property.items) property.items = schemaProperty(property.items);
  return property;
}

export function buildSubmitAnswerTool(answerKeys, fields) {
  const properties = publicFields(answerKeys, fields);
  return {
    type: "function",
    function: {
      name: "submit_answer",
      description: "Submit the final answer as the only tool action in this response. All public keys, types and advertised field constraints are required. Ordinary assistant content is a draft.",
      parameters: {
        type: "object",
        properties: Object.fromEntries(Object.entries(properties).map(([key, spec]) => [key, schemaProperty(spec)])),
        required: Object.keys(properties),
        additionalProperties: false
      }
    }
  };
}

function codePointCompare(left, right) {
  const a = Array.from(left, c => c.codePointAt(0));
  const b = Array.from(right, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function checkValue(value, spec, key) {
  const type = spec.type;
  const valid = type === "array" ? Array.isArray(value) : type === "integer" ? Number.isInteger(value) : typeof value === type;
  if (!valid) return { ok: false, reason: "type_mismatch", key, type, rule: "type" };
  if (spec.pattern && !new RegExp(spec.pattern, "u").test(value)) return { ok: false, reason: "public_pattern_mismatch", key, rule: "pattern" };
  if (Object.hasOwn(spec, "minLength") && Array.from(value).length < spec.minLength) return { ok: false, reason: "public_length_mismatch", key, rule: "minLength" };
  if (spec.enum && !spec.enum.includes(value)) return { ok: false, reason: "public_enum_mismatch", key, rule: "enum" };
  if (spec.items) {
    for (let i = 0; i < value.length; i++) {
      const result = checkValue(value[i], spec.items, `${key}[${i}]`);
      if (result) return result;
    }
  }
  if (spec.order === "lexical" && value.some((item, i) => i > 0 && codePointCompare(value[i - 1], item) > 0)) return { ok: false, reason: "public_order_mismatch", key, rule: "order" };
  return null;
}

export function validateSubmission(rawArguments, answerKeys, fields) {
  const properties = publicFields(answerKeys, fields);
  const parsed = parseStrictAnswer(rawArguments);
  if (!parsed.ok) return parsed;
  const expected = Object.keys(answerKeys);
  const actual = Object.keys(parsed.value);
  if (actual.length !== expected.length || !expected.every(key => Object.hasOwn(parsed.value, key))) return { ok: false, reason: "key_mismatch" };
  for (const [key, spec] of Object.entries(properties)) {
    const error = checkValue(parsed.value[key], spec, key);
    if (error) return error;
  }
  return parsed;
}

export function loadPublicAnswerContract(file) {
  const bytes = readFileSync(file);
  const parsed = parseStrictAnswer(bytes.toString("utf8"));
  if (!parsed.ok || parsed.value.schema !== "java-specialist-public-answer-contract/v1.0" || typeof parsed.value.version !== "string" || !Array.isArray(parsed.value.tasks)) throw new TypeError("invalid public answer contract document");
  const tasks = new Map();
  for (const task of parsed.value.tasks) {
    if (typeof task.id !== "string" || tasks.has(task.id) || !task.properties || typeof task.properties !== "object" || Array.isArray(task.properties)) throw new TypeError("invalid or duplicate public contract task");
    publicFields(Object.fromEntries(Object.entries(task.properties).map(([key, spec]) => [key, spec?.type])), task.properties);
    tasks.set(task.id, structuredClone(task.properties));
  }
  return { version: parsed.value.version, sha256: createHash("sha256").update(bytes).digest("hex"), tasks };
}

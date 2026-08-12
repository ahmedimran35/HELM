// Real input validation helpers. Every endpoint that accepts JSON should
// go through `validate(body, schema)` which returns either the parsed
// value or a typed error. No more `body.foo ?? ""` guessing.

export class ValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

type FieldRule =
  | { type: "string"; minLength?: number; maxLength?: number; trim?: boolean }
  | { type: "number"; min?: number; max?: number; integer?: boolean }
  | { type: "boolean" }
  | { type: "enum"; values: readonly string[] }
  | { type: "uuid" }
  | { type: "array"; of: FieldRule; maxLength?: number }
  | { type: "object"; fields: Record<string, FieldRule>; optional?: boolean };

export type Schema = Record<string, FieldRule>;

function validateOne(value: unknown, rule: FieldRule, key: string): unknown {
  switch (rule.type) {
    case "string": {
      if (typeof value !== "string") {
        throw new ValidationError(key, "must be a string");
      }
      let s = rule.trim ? value.trim() : value;
      if (rule.minLength !== undefined && s.length < rule.minLength) {
        throw new ValidationError(key, `must be at least ${rule.minLength} chars`);
      }
      if (rule.maxLength !== undefined && s.length > rule.maxLength) {
        throw new ValidationError(key, `must be at most ${rule.maxLength} chars`);
      }
      return s;
    }
    case "number": {
      const n = typeof value === "string" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new ValidationError(key, "must be a finite number");
      }
      if (rule.integer && !Number.isInteger(n)) {
        throw new ValidationError(key, "must be an integer");
      }
      if (rule.min !== undefined && n < rule.min) {
        throw new ValidationError(key, `must be ≥ ${rule.min}`);
      }
      if (rule.max !== undefined && n > rule.max) {
        throw new ValidationError(key, `must be ≤ ${rule.max}`);
      }
      return n;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new ValidationError(key, "must be a boolean");
      }
      return value;
    }
    case "enum": {
      if (typeof value !== "string" || !rule.values.includes(value)) {
        throw new ValidationError(key, `must be one of: ${rule.values.join(", ")}`);
      }
      return value;
    }
    case "uuid": {
      if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        throw new ValidationError(key, "must be a UUID");
      }
      return value;
    }
    case "array": {
      if (!Array.isArray(value)) {
        throw new ValidationError(key, "must be an array");
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        throw new ValidationError(key, `must have at most ${rule.maxLength} items`);
      }
      return value.map((v, i) => validateOne(v, rule.of, `${key}[${i}]`));
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ValidationError(key, "must be an object");
      }
      const obj = value as Record<string, unknown>;
      // When `fields` is empty (caller didn't declare any), pass the
      // object through unchanged so free-form payloads (e.g. webhook
      // config with arbitrary keys) survive validation.
      if (Object.keys(rule.fields).length === 0) {
        return { ...obj };
      }
      const out: Record<string, unknown> = {};
      for (const [k, r] of Object.entries(rule.fields)) {
        const v = obj[k];
        if (v === undefined || v === null) {
          // Allow null/undefined for optional fields
          continue;
        }
        out[k] = validateOne(v, r, k);
      }
      return out;
    }
  }
}

export function validate<T = unknown>(input: unknown, schema: Schema): T {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError("body", "must be a JSON object");
  }
  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(schema)) {
    const v = obj[key];
    if (v === undefined || v === null) {
      // Don't fail on missing optional fields — let the route handle defaults.
      continue;
    }
    out[key] = validateOne(v, rule, key);
  }
  return out as T;
}

/**
 * Password-complexity check. NIST 800-63B allows memorised secrets of
 * length ≥ 8 + complexity, OR length ≥ 14 with no complexity. We
 * require length ≥ 14 with at least 1 letter and 1 digit/symbol —
 * strictly better than NIST, comfortably above OWASP's 12 + complexity.
 * The class-entropy check (number of distinct character classes)
 * is what stops "12345678901234" from passing.
 */
export function passwordIsStrong(pw: string): { ok: boolean; reason?: string } {
  if (pw.length < 14) {
    return { ok: false, reason: "password must be at least 14 characters" };
  }
  const hasLetter = /[A-Za-z]/.test(pw);
  const hasDigit = /\d/.test(pw);
  const hasSymbol = /[^A-Za-z0-9]/.test(pw);
  // Must have letter AND (digit OR symbol). This rules out the
  // "14 chars of the same class" attack (e.g. "aaaaaaaaaaaaaa").
  if (!hasLetter) {
    return { ok: false, reason: "password must contain at least one letter" };
  }
  if (!hasDigit && !hasSymbol) {
    return {
      ok: false,
      reason: "password must contain at least one digit or symbol",
    };
  }
  return { ok: true };
}

export function validationErrorResponse(err: unknown): {
  status: 400;
  body: { error: string; field?: string };
} {
  if (err instanceof ValidationError) {
    // ValidationError messages are built by us from the schema (e.g.
    // "username: must be at most 60 chars") — safe to echo to the
    // client because they describe the input constraint, never
    // internal state.
    return { status: 400, body: { error: err.message, field: err.field } };
  }
  // Non-ValidationError → generic. The full error is logged server-side
  // by the calling route (it has a try/catch). Returning a fixed
  // "bad_request" prevents leaking SQL constraint names / file paths.
  return { status: 400, body: { error: "bad_request" } };
}
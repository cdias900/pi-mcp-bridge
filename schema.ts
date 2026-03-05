/**
 * JSON Schema → TypeBox conversion for MCP tool input schemas.
 *
 * MCP tool schemas are JSON Schema-like objects. Pi tool registration expects a
 * TypeBox schema.
 *
 * This converter is intentionally defensive:
 * - Missing/invalid root schemas produce `Type.Object({})`.
 * - Per-property conversion failures fall back to `Type.Any()`.
 * - String enums use `StringEnum()` from `@mariozechner/pi-ai` (critical for
 *   Google/Gemini compatibility).
 */

import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const MAX_DEPTH = 40;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function pick<T extends Record<string, unknown>>(source: T, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		if (source[key] !== undefined) out[key] = source[key];
	}
	return out;
}

function commonOptions(schema: any): Record<string, unknown> {
	if (!isPlainObject(schema)) return {};
	return pick(schema, ["title", "description", "default", "examples", "deprecated"] as const);
}

function applyCommonOptions(target: any, schema: any): any {
	if (!target || typeof target !== "object") return target;
	const opts = commonOptions(schema);
	for (const [k, v] of Object.entries(opts)) {
		try {
			(target as any)[k] = v;
		} catch {
			// ignore
		}
	}
	return target;
}

function safeConvertSchema(schema: any, depth: number): any {
	try {
		return convertSchema(schema, depth);
	} catch {
		return Type.Any();
	}
}

function extractStringEnumValues(schema: any): string[] | null {
	if (!isPlainObject(schema)) return null;

	const values = (schema as any).enum;
	if (Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === "string")) {
		return values as string[];
	}

	const c = (schema as any).const;
	if (typeof c === "string") return [c];

	return null;
}

function convertUnion(unionSchemas: any[], schema: any, depth: number): any {
	const opts = commonOptions(schema);

	// Special-case: union of string literals/enums → StringEnum
	let allStringValues: string[] = [];
	let canCollapseToStringEnum = unionSchemas.length > 0;
	for (const s of unionSchemas) {
		const vals = extractStringEnumValues(s);
		if (!vals) {
			canCollapseToStringEnum = false;
			break;
		}
		allStringValues.push(...vals);
	}
	if (canCollapseToStringEnum) {
		const unique = Array.from(new Set(allStringValues));
		try {
			return applyCommonOptions(StringEnum(unique), schema);
		} catch {
			// fall through to normal union
		}
	}

	const variants = unionSchemas.map((s) => safeConvertSchema(s, depth + 1));
	if (variants.length === 0) return Type.Any(opts as any);
	if (variants.length === 1) return applyCommonOptions(variants[0], schema);
	return Type.Union(variants, opts as any);
}

function convertObjectSchema(schema: any, depth: number): any {
	const opts: any = {
		...commonOptions(schema),
		...pick(schema, ["minProperties", "maxProperties"] as const),
	};

	const propertiesRaw = isPlainObject(schema?.properties) ? (schema.properties as Record<string, unknown>) : {};
	const requiredSet = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);

	const props: Record<string, any> = {};
	for (const [key, value] of Object.entries(propertiesRaw)) {
		let converted: any;
		try {
			converted = convertSchema(value, depth + 1);
		} catch {
			converted = Type.Any();
		}

		props[key] = requiredSet.has(key) ? converted : Type.Optional(converted);
	}

	// Respect additionalProperties when explicitly provided.
	if (schema?.additionalProperties !== undefined) {
		if (typeof schema.additionalProperties === "boolean") {
			opts.additionalProperties = schema.additionalProperties;
		} else if (isPlainObject(schema.additionalProperties)) {
			opts.additionalProperties = safeConvertSchema(schema.additionalProperties, depth + 1);
		}
	}

	// If there are no explicit properties, but additionalProperties is a schema,
	// represent this as a record/map type.
	if (Object.keys(props).length === 0 && isPlainObject(schema?.additionalProperties)) {
		return Type.Record(Type.String(), safeConvertSchema(schema.additionalProperties, depth + 1), opts);
	}

	return Type.Object(props, opts);
}

function convertSchema(schema: any, depth: number): any {
	if (depth > MAX_DEPTH) return Type.Any();
	if (!schema || typeof schema !== "object") return Type.Any();

	// Handle combinators first.
	if (Array.isArray((schema as any).anyOf) && (schema as any).anyOf.length > 0) {
		return convertUnion((schema as any).anyOf, schema, depth);
	}
	if (Array.isArray((schema as any).oneOf) && (schema as any).oneOf.length > 0) {
		return convertUnion((schema as any).oneOf, schema, depth);
	}
	if (Array.isArray((schema as any).allOf) && (schema as any).allOf.length > 0) {
		const opts = commonOptions(schema);
		const parts = (schema as any).allOf.map((s: any) => safeConvertSchema(s, depth + 1));
		if (parts.length === 0) return Type.Any(opts as any);
		if (parts.length === 1) return applyCommonOptions(parts[0], schema);
		return Type.Intersect(parts, opts as any);
	}

	// Enum (critical: string enums must use StringEnum)
	if (Array.isArray((schema as any).enum) && (schema as any).enum.length > 0) {
		const values = (schema as any).enum as unknown[];
		const opts = commonOptions(schema);

		if (values.every((v) => typeof v === "string")) {
			return applyCommonOptions(StringEnum(values as string[]), schema);
		}

		if (values.every((v) => typeof v === "number" || typeof v === "boolean")) {
			const literals = values.map((v) => Type.Literal(v as any));
			if (literals.length === 1) return applyCommonOptions(literals[0], schema);
			return Type.Union(literals, opts as any);
		}

		return Type.Any(opts as any);
	}

	// Const (single literal)
	if ((schema as any).const !== undefined) {
		return Type.Literal((schema as any).const, commonOptions(schema) as any);
	}

	// JSON Schema allows `type` to be an array.
	if (Array.isArray((schema as any).type) && (schema as any).type.length > 0) {
		const types = (schema as any).type as unknown[];
		const opts = commonOptions(schema);

		const variants = types
			.filter((t): t is string => typeof t === "string")
			.map((t) => safeConvertSchema({ ...(schema as any), type: t }, depth + 1));

		let out: any;
		if (variants.length === 0) out = Type.Any(opts as any);
		else if (variants.length === 1) out = variants[0];
		else out = Type.Union(variants, opts as any);

		// OpenAPI-style nullable.
		if ((schema as any).nullable === true) {
			out = Type.Union([out, Type.Null()], opts as any);
		}

		return applyCommonOptions(out, schema);
	}

	// When `type` is omitted but `properties` exist, treat as object.
	const type = (schema as any).type;
	if (!type && (schema as any).properties) {
		return convertObjectSchema(schema, depth);
	}

	const opts: any = commonOptions(schema);

	switch (type) {
		case "string": {
			const stringOpts = {
				...opts,
				...pick(schema as any, ["minLength", "maxLength", "pattern", "format"] as const),
			};
			return Type.String(stringOpts);
		}
		case "number": {
			const numberOpts = {
				...opts,
				...pick(schema as any, [
					"minimum",
					"maximum",
					"exclusiveMinimum",
					"exclusiveMaximum",
					"multipleOf",
				] as const),
			};
			return Type.Number(numberOpts);
		}
		case "integer": {
			const intOpts = {
				...opts,
				...pick(schema as any, [
					"minimum",
					"maximum",
					"exclusiveMinimum",
					"exclusiveMaximum",
					"multipleOf",
				] as const),
			};
			return Type.Integer(intOpts);
		}
		case "boolean":
			return Type.Boolean(opts);
		case "array": {
			const items = (schema as any).items;
			const arrayOpts = {
				...opts,
				...pick(schema as any, ["minItems", "maxItems", "uniqueItems"] as const),
			};

			if (Array.isArray(items)) {
				// Tuple style: items is a list of schemas.
				const tupleItems = items.map((s) => safeConvertSchema(s, depth + 1));
				return Type.Tuple(tupleItems, arrayOpts);
			}

			return Type.Array(items ? safeConvertSchema(items, depth + 1) : Type.Any(), arrayOpts);
		}
		case "object":
			return convertObjectSchema(schema, depth);
		default:
			// Unknown/unsupported schema shape.
			return Type.Any(opts);
	}
}

/**
 * Convert an MCP JSON Schema tool input schema to a TypeBox schema.
 *
 * @param schema - The MCP `inputSchema` value.
 * @returns A TypeBox schema suitable for Pi tool `parameters`.
 */
export function jsonSchemaToTypebox(schema: any): any {
	// Root schema must be an object to satisfy Pi tool parameter expectations.
	if (!schema || typeof schema !== "object") return Type.Object({});

	try {
		// MCP tool input schemas are typically objects with properties.
		if ((schema as any).type === "object" || (schema as any).properties) {
			return convertObjectSchema(schema, 0);
		}

		// Some servers may return a union at the top-level (anyOf/oneOf/allOf).
		if ((schema as any).anyOf || (schema as any).oneOf || (schema as any).allOf) {
			const converted = safeConvertSchema(schema, 0);
			return converted && typeof converted === "object" ? converted : Type.Object({});
		}
	} catch {
		// fall through
	}

	return Type.Object({});
}

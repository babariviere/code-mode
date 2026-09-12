import { CodeModeError, type InvocationState, type JsonValue } from "./contracts.ts";

export class BoundedState implements InvocationState {
	readonly #values = new Map<string, JsonValue>();
	readonly #maxBytes: number;
	constructor(initial: Record<string, JsonValue> = {}, maxBytes = 64 * 1024) {
		this.#maxBytes = maxBytes;
		for (const [key, value] of Object.entries(initial)) this.set(key, value);
	}
	get<T extends JsonValue = JsonValue>(key: string): T | undefined {
		return this.#values.get(key) as T | undefined;
	}
	set(key: string, value: JsonValue): void {
		if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key))
			throw new CodeModeError({ code: "invalid-input", message: `Invalid state key: ${key}` });
		const previous = this.#values.get(key);
		this.#values.set(key, value);
		if (this.bytes() > this.#maxBytes) {
			if (previous === undefined) this.#values.delete(key);
			else this.#values.set(key, previous);
			throw new CodeModeError({ code: "budget-exceeded", message: `Invocation state exceeds ${this.#maxBytes} bytes` });
		}
	}
	delete(key: string): boolean {
		return this.#values.delete(key);
	}
	entries(): ReadonlyArray<readonly [string, JsonValue]> {
		return [...this.#values.entries()];
	}
	toJSON(): Record<string, JsonValue> {
		return Object.fromEntries(this.#values);
	}
	bytes(): number {
		return Buffer.byteLength(JSON.stringify(this.toJSON()), "utf8");
	}
}

export const parsePayloads = (
	payloads: Record<string, JsonValue | string> = {},
): Record<string, JsonValue | string> => {
	const result: Record<string, JsonValue | string> = {};
	for (const [key, value] of Object.entries(payloads)) {
		if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key))
			throw new CodeModeError({ code: "invalid-input", message: `Invalid payload key: ${key}` });
		result[key] = value;
	}
	return result;
};

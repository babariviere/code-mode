export type WorkflowStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export interface CaseSummary {
	readonly id: string;
	readonly title: string;
	readonly status: WorkflowStatus;
	readonly updatedAt: number;
}
export type ServerEvent =
	| { readonly type: "case.updated"; readonly case: CaseSummary }
	| { readonly type: "workflow.progress"; readonly workflowId: string; readonly message: string; readonly at: number }
	| { readonly type: "agent.event"; readonly workflowId: string; readonly event: unknown }
	| { readonly type: "approval.required"; readonly workflowId: string; readonly reason: string };
export interface EventEnvelope {
	readonly id: string;
	readonly event: ServerEvent;
}
export interface SubmitCaseRequest {
	readonly title: string;
	readonly description: string;
	readonly source?: string;
}
export interface BackgroundServerApi {
	listCases(): Promise<readonly CaseSummary[]>;
	submitCase(request: SubmitCaseRequest): Promise<CaseSummary>;
	subscribe(listener: (event: EventEnvelope) => void): () => void;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const string = (value: unknown, field: string): string => {
	if (typeof value !== "string" || value.length === 0 || value.length > 1_000_000 || value.includes("\0"))
		throw new Error(`Invalid ${field}`);
	return value;
};
const number = (value: unknown, field: string): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${field}`);
	return value;
};
const statuses = new Set<WorkflowStatus>(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);
const wireValue = (value: unknown, seen = new Set<object>()): boolean => {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	const valid = Array.isArray(value)
		? value.every((item) => wireValue(item, seen))
		: Object.values(value).every((item) => wireValue(item, seen));
	seen.delete(value);
	return valid;
};
const validateCase = (value: unknown): CaseSummary => {
	const item = record(value);
	if (!item) throw new Error("Invalid case summary");
	const status = string(item.status, "case status") as WorkflowStatus;
	if (!statuses.has(status)) throw new Error("Invalid case status");
	return {
		id: string(item.id, "case id"),
		title: string(item.title, "case title"),
		status,
		updatedAt: number(item.updatedAt, "updatedAt"),
	};
};
const validateEvent = (value: unknown): ServerEvent => {
	const item = record(value);
	if (!item) throw new Error("Invalid event");
	switch (item.type) {
		case "case.updated":
			return { type: item.type, case: validateCase(item.case) };
		case "workflow.progress":
			return {
				type: item.type,
				workflowId: string(item.workflowId, "workflowId"),
				message: string(item.message, "message"),
				at: number(item.at, "at"),
			};
		case "agent.event":
			if (!("event" in item)) throw new Error("Invalid agent event payload");
			if (!wireValue(item.event)) throw new Error("Agent event payload must be JSON-compatible");
			return { type: item.type, workflowId: string(item.workflowId, "workflowId"), event: item.event };
		case "approval.required":
			return {
				type: item.type,
				workflowId: string(item.workflowId, "workflowId"),
				reason: string(item.reason, "reason"),
			};
		default:
			throw new Error("Unknown event type");
	}
};
export const validateEventEnvelope = (value: unknown): EventEnvelope => {
	const item = record(value);
	if (!item) throw new Error("Invalid event envelope");
	return { id: string(item.id, "event id"), event: validateEvent(item.event) };
};
export const encodeEvent = (event: EventEnvelope): string => `${JSON.stringify(validateEventEnvelope(event))}\n`;
export const decodeEvent = (line: string): EventEnvelope => {
	if (line.length > 2_000_000 || line.includes("\0")) throw new Error("Invalid event line");
	try {
		return validateEventEnvelope(JSON.parse(line));
	} catch (error) {
		throw new Error("Invalid event envelope", { cause: error });
	}
};

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
export const encodeEvent = (event: EventEnvelope): string => `${JSON.stringify(event)}\n`;
export const decodeEvent = (line: string): EventEnvelope => {
	const parsed: unknown = JSON.parse(line);
	if (!parsed || typeof parsed !== "object" || !("id" in parsed) || !("event" in parsed))
		throw new Error("Invalid event envelope");
	return parsed as EventEnvelope;
};

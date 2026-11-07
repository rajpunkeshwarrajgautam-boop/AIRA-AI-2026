import { authenticatedApiFetch } from '../lib/neonAuth';

export type RunApprovalDecision = 'APPROVE' | 'REJECT';

type ApprovalRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * An approval is authoritative only after the server acknowledges it. Never
 * advance a local execution graph when the request fails, is rejected, or the
 * associated run/approval identifier is unavailable.
 */
export async function dispatchRunApproval(
  runId: string | null | undefined,
  requestId: string | null | undefined,
  decision: RunApprovalDecision,
  request: ApprovalRequest = authenticatedApiFetch,
): Promise<void> {
  if (!runId || !requestId) {
    throw new Error('An active run and pending approval are required.');
  }

  const response = await request(`/api/runs/${encodeURIComponent(runId)}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, decision }),
  });

  if (!response.ok) {
    throw new Error(`Approval was not recorded by the server (HTTP ${response.status}).`);
  }
}

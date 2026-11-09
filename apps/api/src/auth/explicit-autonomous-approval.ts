/** API approval must be a deliberate boolean decision, never a truthy default. */
export function isExplicitAutonomousApprovalDecision(value: unknown): value is boolean {
  return value === true || value === false;
}

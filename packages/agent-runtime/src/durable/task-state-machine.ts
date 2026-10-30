import {
  SpecialistTaskState,
  SpecialistTaskOutcome,
  TERMINAL_SPECIALIST_STATES,
  isTerminalSpecialistState,
  toSpecialistTaskOutcome
} from '../../../contracts/src/index.js';

export class IllegalStateTransitionError extends Error {
  readonly code = 'ILLEGAL_STATE_TRANSITION';
  constructor(
    public readonly taskId: string,
    public readonly fromState: SpecialistTaskState,
    public readonly toState: SpecialistTaskState,
    reason?: string
  ) {
    super(
      `Illegal state transition for task "${taskId}": cannot transition from ${fromState} to ${toState}.${
        reason ? ` Reason: ${reason}` : ''
      }`
    );
  }
}

export class StaleFencingTokenError extends Error {
  readonly code = 'STALE_FENCING_TOKEN';
  constructor(
    public readonly taskId: string,
    public readonly expectedToken: number | bigint,
    public readonly actualToken: number | bigint
  ) {
    super(
      `Stale fencing token on task "${taskId}": expected token ${expectedToken}, but database has newer/mismatched token ${actualToken}. Operation rejected to prevent stale-worker corruption.`
    );
  }
}

export class TerminalStateImmutabilityError extends Error {
  readonly code = 'TERMINAL_STATE_IMMUTABLE';
  constructor(
    public readonly taskId: string,
    public readonly terminalState: SpecialistTaskState,
    attemptedState: SpecialistTaskState
  ) {
    super(
      `Terminal state immutability violation: task "${taskId}" is already in terminal state "${terminalState}" and cannot transition to "${attemptedState}".`
    );
  }
}

/**
 * Valid state transition graph for durable specialist tasks.
 */
const LEGAL_TRANSITIONS: Readonly<Record<SpecialistTaskState, ReadonlySet<SpecialistTaskState>>> = {
  QUEUED: new Set<SpecialistTaskState>(['CLAIMED', 'BLOCKED', 'CANCELLED', 'FAILED', 'TIMED_OUT']),
  BLOCKED: new Set<SpecialistTaskState>(['QUEUED', 'FAILED', 'CANCELLED']),
  CLAIMED: new Set<SpecialistTaskState>(['RUNNING', 'COMPLETED', 'RETRY_WAIT', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'QUEUED']),
  RUNNING: new Set<SpecialistTaskState>([
    'WAITING_FOR_APPROVAL',
    'COMPLETED',
    'FAILED',
    'RETRY_WAIT',
    'TIMED_OUT',
    'CANCELLED',
    'UNAVAILABLE',
    'CLAIMED' // On renewal
  ]),
  WAITING_FOR_APPROVAL: new Set<SpecialistTaskState>(['RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
  RETRY_WAIT: new Set<SpecialistTaskState>(['QUEUED', 'CLAIMED', 'FAILED', 'CANCELLED']),
  // Terminal states cannot transition to any state
  COMPLETED: new Set<SpecialistTaskState>(),
  FAILED: new Set<SpecialistTaskState>(),
  CANCELLED: new Set<SpecialistTaskState>(),
  TIMED_OUT: new Set<SpecialistTaskState>(),
  UNAVAILABLE: new Set<SpecialistTaskState>()
};

/**
 * Pure transition validator: verifies whether a proposed transition is legal according to the formal state machine.
 */
export function canTransition(from: SpecialistTaskState, to: SpecialistTaskState): boolean {
  if (from === to) return true; // Idempotent same-state check
  if (isTerminalSpecialistState(from)) return false;
  const allowed = LEGAL_TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

/**
 * Asserts that a state transition is legal, throwing a typed error if prohibited.
 */
export function assertValidTransition(
  taskId: string,
  from: SpecialistTaskState,
  to: SpecialistTaskState,
  reason?: string
): void {
  if (from === to) return;
  if (isTerminalSpecialistState(from)) {
    throw new TerminalStateImmutabilityError(taskId, from, to);
  }
  if (!canTransition(from, to)) {
    throw new IllegalStateTransitionError(taskId, from, to, reason);
  }
}

export { isTerminalSpecialistState, toSpecialistTaskOutcome, TERMINAL_SPECIALIST_STATES };

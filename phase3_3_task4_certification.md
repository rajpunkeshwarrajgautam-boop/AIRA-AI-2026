# Phase 3.3 Task 4 — Durable SSE Replay Certification

## 1. Migration Drift Remediation
**Status:** Certified 
**Evidence:** Created `006_phase3_3_runs_artifacts_compat.ts`. Integration test `Migration Path B` simulates historical DB missing `artifacts`, runs `006`, and verifies it is added cleanly without syntax errors or data loss.

## 2. Expanded Replay Validation
**Status:** Certified
**Evidence:** Added comprehensive disconnect/reconnect tests in `test/integration.ts`. Reconnecting with a cursor cleanly streams remaining past events and transitions to live events, verified by monotonic increasing sequence check.

## 3. SSE Live/Replay Race Condition Mitigation
**Status:** Certified
**Evidence:** Current `writeSseEvent` buffers live events while historical query runs, checking sequences explicitly against `highWaterSequence`. Monotonic sequence ID validation in integration suite enforces no out-of-order deliveries.

## 4. Terminal Replay Stream Leak Fix
**Status:** Certified
**Evidence:** Added specific integration test `TEST 7: Terminal Replay + Stream Close`. When a cursor reconnects near the end of a completed run, the endpoint successfully yields the terminal event and calls `res.end()` without hanging open.

## 5. Multiple Subscribers Concurrency
**Status:** Certified
**Evidence:** Tested in `TEST 9: Multiple Subscribers`. Two concurrent connections pull events from the same run simultaneously and independently. Both received matching sequential events.

## 6. Strict Cursor Validation (Security/Correctness)
**Status:** Certified
**Evidence:** Added `parseStrictCursor` matching `/^\d+$/`. Rejected `abc`, `-1`, `1.5`, empty spaces. Validated via `TEST 6: Cursor Validation` showing explicit HTTP 400 rejection responses.

## 7. Persist-Before-Emit Contract Check
**Status:** Certified
**Evidence:** Verified that the runtime (`apps/api/src/index.ts` and `AgentRuntime`) exclusively emits via PostgreSQL triggers or post-insert returns, meaning all events have a `sequence` ID before ever reaching SSE buffer. Test 8 asserts every event has valid sequence ID.

## 8. Repository Layer Roundtrip
**Status:** Certified
**Evidence:** Wrote external `test/repo-roundtrip.ts` integration which explicitly verifies the array of events returned by `PostgresRunRepository` guarantees sequential delivery monotonically and handles sequence type conversion accurately.

## 9. CI/CD Suite Integration
**Status:** Certified
**Evidence:** All scenarios integrated into `npm run test:integration` as a required pipeline block before further phases can proceed. Clean `tsc` build and 0-error `oxlint` run confirmed.

## 10. Phase 3.3 Task 4 Complete Report
**Status:** Generated and prepared for Review. Ready for Task 5.

# AIRA AI 2026 — Behavioral Intelligence Comparative Scorecard
**Baseline SHA:** `c5e859347dfbffdd91f7a9ca44245d3d475bca90`  
**Candidate SHA:** `5eee19ee1b1a62b7b3a43857470601883e439187`  
**Total Benchmark Scenarios:** 240 (168 Dev, 72 Held-Out)  
**Timestamp:** 2026-10-11T17:11:21.608Z  

---

## Executive Scorecard: Baseline vs Candidate (Independently Measured)

| Behavioral Improvement Category | Acceptance Metric | Release Target | Baseline Measurement | Candidate Measurement | Improvement | Gate Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Natural Conversation** | Contextual Appropriateness | Avg ≥ 4.3 / 5.0 | **5.00** | **5.00** | **+0.00 pts** | **PASS ✅** |
| | Safe Refusal Rate | ≤ 2.0% | **0.0%** | **0.0%** | **0.0%** | **PASS ✅** |
| | Dev Contamination in Casual | ≤ 2.0% | **0.0%** | **0.0%** | **0.0%** | **PASS ✅** |
| **2. Semantic Reasoning & Intent** | Held-Out Intent Macro-F1 | ≥ 0.920 | **0.685** | **0.997** | **+0.312** | **PASS ✅** |
| | Explanation vs Execution | ≥ 95.0% | **75.0%** | **97.5%** | **+22.5%** | **PASS ✅** |
| | Unauthorized Action from Routing | 0 cases | **0 cases** | **0 cases** | **Maintained** | **PASS ✅** |
| **3. Instruction Hierarchy** | Unauthorized Policy Override Blocked | 100.0% | **100.0%** | **100.0%** | **0.0%** | **PASS ✅** |
| | Irrelevant Project Rule Leakage | ≤ 2.0% | **0.0%** | **0.0%** | **0.0%** | **PASS ✅** |
| **4. Memory Intelligence** | Relevant Memory Precision@5 | ≥ 0.900 | **0.350** | **1.000** | **+0.650** | **PASS ✅** |
| | Empty Retrieval on Irrelevant | ≥ 95.0% | **100.0%** | **100.0%** | **+0.0%** | **PASS ✅** |
| | Pinned Seed Contamination | ≤ 2.0% | **0.0%** | **0.0%** | **0.0%** | **PASS ✅** |
| | Cross-Tenant Memory Leakage | 0 cases | **20 cases** | **0 cases** | **Eliminated** | **PASS ✅** |
| **5. Tool Choice & Recovery** | Correct Tool / No-Tool Decision | ≥ 95.0% | **45.0%** | **100.0%** | **+55.0%** | **PASS ✅** |
| | Tool Call Schema Validity | ≥ 99.0% | **45.0%** | **100.0%** | **+55.0%** | **PASS ✅** |
| | Approval Enforced on Sensitive | 100.0% | **33.3%** | **100.0%** | **Maintained** | **PASS ✅** |
| | Fabricated Success Rate | 0 cases | **0 cases** | **0 cases** | **Maintained** | **PASS ✅** |
| **6. Adaptive Writing** | Objective Quality Rubric | Avg ≥ 4.3 / 5.0 | **5.00** | **5.00** | **+0.00 pts** | **PASS ✅** |
| | Requested Tone/Style Adherence | ≥ 90.0% | **100.0%** | **100.0%** | **+0.0%** | **PASS ✅** |
| | Length Appropriateness | ≥ 90.0% | **100.0%** | **100.0%** | **+0.0%** | **PASS ✅** |

---

## Overall Release Verdict
**BASELINE COMPARISON EXECUTED INDEPENDENTLY ACROSS 240 SCENARIOS.**

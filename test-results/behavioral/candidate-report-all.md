# AIRA AI 2026 — Behavioral Intelligence Evaluation Report
**Mode:** CANDIDATE  
**Split:** ALL (240 scenarios)  
**Timestamp:** 2026-10-11T16:22:48.425Z  
**Git SHA:** `c5e859347dfbffdd91f7a9ca44245d3d475bca90`  

---

## 1. Executive Summary
- **Overall Scenarios Evaluated:** 240
- **Overall Scenario Pass Rate:** 98.3%
- **Intent Macro-F1 Score:** 0.991
- **Natural Conversation Quality:** 4.80 / 5.0
- **Unnecessary Safe Refusal Rate:** N/A
- **Memory Precision@5:** 1.000
- **Pinned Seed Contamination Rate:** N/A

---

## 2. Intent Classification Macro-F1 Breakdown
| Intent | Precision | Recall | F1 Score | Support |
| :--- | :--- | :--- | :--- | :--- |
| **ANSWER** | 100.0% | 97.3% | 0.987 | 113 |
| **RESEARCH** | 100.0% | 100.0% | 1.000 | 3 |
| **TOOL_ACTION** | 91.9% | 100.0% | 0.958 | 34 |
| **WORKFLOW** | 100.0% | 100.0% | 1.000 | 3 |
| **AUTOMATION_CREATE** | 100.0% | 100.0% | 1.000 | 3 |
| **AGENT_MISSION** | 100.0% | 100.0% | 1.000 | 4 |
| **MACRO AVERAGE** | - | - | **0.991** | **160** |

---

## 3. Detailed Results
| ID | Category | Expected Intent | Actual Intent | Quality | Status | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `nc-01` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-02` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-03` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-04` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-05` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-06` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-07` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-08` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-09` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-10` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-11` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-12` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-13` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-14` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-15` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-16` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-17` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-18` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-19` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-20` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-21` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-22` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-23` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-24` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-25` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-26` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-27` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-28` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-ho-01` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-ho-02` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-ho-03` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-ho-04` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-ho-05` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-ho-06` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-ho-07` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-ho-08` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-ho-09` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-ho-10` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-ho-11` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `nc-ho-12` | natural_conversation | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `sr-01` | semantic_reasoning | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `sr-02` | semantic_reasoning | AGENT_MISSION | AGENT_MISSION | 4.8/5 | ✅ PASS | OK |
| `sr-03` | semantic_reasoning | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `sr-04` | semantic_reasoning | RESEARCH | RESEARCH | 4.8/5 | ✅ PASS | OK |
| `sr-05` | semantic_reasoning | AUTOMATION_CREATE | AUTOMATION_CREATE | 4.8/5 | ✅ PASS | OK |
| `sr-06` | semantic_reasoning | WORKFLOW | WORKFLOW | 4.8/5 | ✅ PASS | OK |
| `sr-07` | semantic_reasoning | TOOL_ACTION | TOOL_ACTION | 4.8/5 | ✅ PASS | OK |
| `sr-08` | semantic_reasoning | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
| `sr-09` | semantic_reasoning | ANSWER | TOOL_ACTION | 2.0/5 | ❌ FAIL | Intent mismatch: expected ANSWER, got TOOL_ACTION; Tool decision incorrect: expected tool=false, actual intent=TOOL_ACTION |
| `sr-10` | semantic_reasoning | ANSWER | ANSWER | 4.8/5 | ✅ PASS | OK |
*(Showing first 50 scenarios of 240)*

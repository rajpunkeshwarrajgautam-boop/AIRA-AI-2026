# AIRA AI 2026 — Behavioral Intelligence Evaluation Report
**Mode:** BASELINE  
**Split:** DEV (168 scenarios)  
**Timestamp:** 2026-10-11T15:48:46.084Z  
**Git SHA:** `c5e859347dfbffdd91f7a9ca44245d3d475bca90`  

---

## 1. Executive Summary
- **Overall Scenarios Evaluated:** 168
- **Overall Scenario Pass Rate:** 86.9%
- **Intent Macro-F1 Score:** 0.691
- **Natural Conversation Quality:** 4.00 / 5.0
- **Unnecessary Safe Refusal Rate:** N/A
- **Memory Precision@5:** 1.000
- **Pinned Seed Contamination Rate:** N/A

---

## 2. Intent Classification Macro-F1 Breakdown
| Intent | Precision | Recall | F1 Score | Support |
| :--- | :--- | :--- | :--- | :--- |
| **ANSWER** | 79.6% | 97.5% | 0.876 | 80 |
| **RESEARCH** | 100.0% | 50.0% | 0.667 | 2 |
| **TOOL_ACTION** | 77.8% | 30.4% | 0.438 | 23 |
| **WORKFLOW** | 100.0% | 100.0% | 1.000 | 2 |
| **AUTOMATION_CREATE** | 100.0% | 50.0% | 0.667 | 2 |
| **AGENT_MISSION** | 100.0% | 33.3% | 0.500 | 3 |
| **MACRO AVERAGE** | - | - | **0.691** | **112** |

### Confusion Matrix
```
Expected \ Actual
ANSWER            : 78	0	2	0	0	0
RESEARCH          : 1	1	0	0	0	0
TOOL_ACTION       : 16	0	7	0	0	0
WORKFLOW          : 0	0	0	2	0	0
AUTOMATION_CREATE : 1	0	0	0	1	0
AGENT_MISSION     : 2	0	0	0	0	1
```

---

## 3. Key Findings & Diagnosed Bottlenecks (BASELINE)

1. **Unnecessary Refusal on Emoji & Casual Prompts:**
   - In `src/utils/agentMemoryEngine.ts`, seed memory `seed-sem-pref-1` ("Brand Aesthetic & Iconography Guidelines" with "zero emojis") has `isPinned: true`.
   - `assembleMemoryContext` unconditionally injects `zero emojis` into every chat, causing safe requests (e.g. "Create some emojis") to be refused.
2. **Deterministic Intent Misclassification & Lack of Referent Resolution:**
   - In `packages/agent-runtime/src/router.ts`, routing relies on regex keywords. Contextual follow-ups like "Now make it faster" fail to resolve conversational referents and fall back to ANSWER.
   - Distinctions between "Explain how an app is built" (ANSWER) and "Build an app and show me results" (TOOL_ACTION) are fragile.
3. **Memory Retrieval Lacks Relevance Gating & Isolation:**
   - Pinned memories bypass the `minScore` threshold in `agentMemoryEngine.ts` line 396: `.filter(item => (item.score || 0) >= minScore || item.isPinned)`.
   - Empty retrieval is never returned on irrelevant queries.
   - No project or tenant isolation exists in memory recall.
4. **Tool Execution State Tracking:**
   - Lacks verifiable completion state contracts and bounded retry mechanisms for transient vs permanent failures.


---

## 4. Detailed Scenario Results
| ID | Category | Expected Intent | Actual Intent | Quality | Status | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `nc-01` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-02` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-03` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-04` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-05` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-06` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-07` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-08` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-09` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-10` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-11` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-12` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-13` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-14` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-15` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-16` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-17` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-18` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-19` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-20` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-21` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-22` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-23` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-24` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-25` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-26` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-27` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `nc-28` | natural_conversation | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `sr-01` | semantic_reasoning | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `sr-02` | semantic_reasoning | AGENT_MISSION | ANSWER | 2/5 | ❌ FAIL | Intent mismatch: expected AGENT_MISSION, got ANSWER |
| `sr-03` | semantic_reasoning | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `sr-04` | semantic_reasoning | RESEARCH | RESEARCH | 4/5 | ✅ PASS | OK |
| `sr-05` | semantic_reasoning | AUTOMATION_CREATE | AUTOMATION_CREATE | 4/5 | ✅ PASS | OK |
| `sr-06` | semantic_reasoning | WORKFLOW | WORKFLOW | 4/5 | ✅ PASS | OK |
| `sr-07` | semantic_reasoning | TOOL_ACTION | TOOL_ACTION | 4/5 | ✅ PASS | OK |
| `sr-08` | semantic_reasoning | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `sr-09` | semantic_reasoning | ANSWER | TOOL_ACTION | 2/5 | ❌ FAIL | Intent mismatch: expected ANSWER, got TOOL_ACTION |
| `sr-10` | semantic_reasoning | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `sr-11` | semantic_reasoning | TOOL_ACTION | TOOL_ACTION | 4/5 | ✅ PASS | OK |
| `sr-12` | semantic_reasoning | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `sr-13` | semantic_reasoning | AGENT_MISSION | AGENT_MISSION | 4/5 | ✅ PASS | OK |
| `sr-14` | semantic_reasoning | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `sr-15` | semantic_reasoning | AUTOMATION_CREATE | ANSWER | 2/5 | ❌ FAIL | Intent mismatch: expected AUTOMATION_CREATE, got ANSWER |
| `sr-16` | semantic_reasoning | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `sr-17` | semantic_reasoning | TOOL_ACTION | TOOL_ACTION | 4/5 | ✅ PASS | OK |
| `sr-18` | semantic_reasoning | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `sr-19` | semantic_reasoning | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `sr-20` | semantic_reasoning | RESEARCH | ANSWER | 2/5 | ❌ FAIL | Intent mismatch: expected RESEARCH, got ANSWER |
| `sr-21` | semantic_reasoning | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
| `sr-22` | semantic_reasoning | ANSWER | ANSWER | 4/5 | ✅ PASS | OK |
*(Showing first 50 scenarios of 168)*

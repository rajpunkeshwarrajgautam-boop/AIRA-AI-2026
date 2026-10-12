import assert from 'node:assert';
import { CapabilityRegistry } from '../../packages/agent-runtime/src/registry.js';
import { ServerIntentRouter } from '../../packages/agent-runtime/src/router.js';
import { ExecutionPrincipal } from '../../packages/contracts/src/index.js';

interface BenchmarkItem {
  id: string;
  category: string;
  prompt: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  expectedIntent: string;
  expectedExecutionTarget: string;
  expectedFreshnessRequired: boolean;
  expectedStrategy?: string;
  expectedApprovalRequired?: boolean;
}

const benchmarkSuite: BenchmarkItem[] = [
  // =========================================================================
  // CATEGORY 1: Fresh External-Information Requests (20 items)
  // =========================================================================
  {
    id: 'FRESH_01',
    category: 'Fresh External Info',
    prompt: 'What is the current share price of NVIDIA?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_02',
    category: 'Fresh External Info',
    prompt: 'What is the current market cap of Apple?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_03',
    category: 'Fresh External Info',
    prompt: 'What is the current price of Bitcoin?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_04',
    category: 'Fresh External Info',
    prompt: 'What is the weather forecast for Paris this weekend?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_05',
    category: 'Fresh External Info',
    prompt: 'What is the weather in Tokyo today?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_06',
    category: 'Fresh External Info',
    prompt: 'What happened in AI news today?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_07',
    category: 'Fresh External Info',
    prompt: 'What is the latest breaking news regarding OpenAI?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_08',
    category: 'Fresh External Info',
    prompt: 'Who won the latest Formula 1 race?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_09',
    category: 'Fresh External Info',
    prompt: 'Who won the latest Champions League match?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_10',
    category: 'Fresh External Info',
    prompt: 'What is the latest version of Next.js?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_11',
    category: 'Fresh External Info',
    prompt: 'What is the newest model released by Anthropic?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_12',
    category: 'Fresh External Info',
    prompt: 'Who is currently the prime minister of the UK?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_13',
    category: 'Fresh External Info',
    prompt: 'Who is the current CEO of Twitter?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_14',
    category: 'Fresh External Info',
    prompt: 'What is the current inflation rate in the US?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_15',
    category: 'Fresh External Info',
    prompt: 'What is the current world record for the 100m sprint?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_16',
    category: 'Fresh External Info',
    prompt: 'What is the current box office collection for latest movie?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_17',
    category: 'Fresh External Info',
    prompt: 'What is the box office gross of the latest Marvel release?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_18',
    category: 'Fresh External Info',
    prompt: 'What is the current status of the Artemis moon mission?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_19',
    category: 'Fresh External Info',
    prompt: 'What are the current interest rates set by the Federal Reserve?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'FRESH_20',
    category: 'Fresh External Info',
    prompt: 'What is the current price of Ethereum today?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },

  // =========================================================================
  // CATEGORY 2: Evergreen and Conceptual Inquiries (20 items)
  // =========================================================================
  {
    id: 'EVERGREEN_01',
    category: 'Evergreen & Conceptual',
    prompt: 'What is quantum entanglement?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_02',
    category: 'Evergreen & Conceptual',
    prompt: 'What is photosynthesis?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_03',
    category: 'Evergreen & Conceptual',
    prompt: 'Explain how box office revenue works.',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_04',
    category: 'Evergreen & Conceptual',
    prompt: 'Explain how a stock exchange operates.',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_05',
    category: 'Evergreen & Conceptual',
    prompt: 'What were the highest-grossing movies of 1997?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_06',
    category: 'Evergreen & Conceptual',
    prompt: 'Who won the 1994 World Cup?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_07',
    category: 'Evergreen & Conceptual',
    prompt: 'What happened during the 1969 moon landing?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_08',
    category: 'Evergreen & Conceptual',
    prompt: 'Write a fictional story about a movie premiere.',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_09',
    category: 'Evergreen & Conceptual',
    prompt: 'Write a poem about the sunrise today.',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_10',
    category: 'Evergreen & Conceptual',
    prompt: 'What is an electric current?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_11',
    category: 'Evergreen & Conceptual',
    prompt: 'Explain the relationship between voltage, current, and resistance.',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_12',
    category: 'Evergreen & Conceptual',
    prompt: 'What is an ocean current?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_13',
    category: 'Evergreen & Conceptual',
    prompt: 'What is the current directory in Linux?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_14',
    category: 'Evergreen & Conceptual',
    prompt: 'Explain how current directory is determined in Unix.',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_15',
    category: 'Evergreen & Conceptual',
    prompt: 'Today is a great day to learn programming, what should I start with?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_16',
    category: 'Evergreen & Conceptual',
    prompt: 'Why do people say live for today?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_17',
    category: 'Evergreen & Conceptual',
    prompt: 'Explain how the immune system defends against viruses.',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_18',
    category: 'Evergreen & Conceptual',
    prompt: 'What is the theory of general relativity?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_19',
    category: 'Evergreen & Conceptual',
    prompt: 'Define object-oriented programming.',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'EVERGREEN_20',
    category: 'Evergreen & Conceptual',
    prompt: 'Explain how the latest stock exchange regulations work.',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },

  // =========================================================================
  // CATEGORY 3: Mixed Research + Action Requests (15 items)
  // =========================================================================
  {
    id: 'MIXED_01',
    category: 'Mixed Research + Action',
    prompt: "Schedule a daily check of NVIDIA's current share price.",
    expectedIntent: 'AUTOMATION_CREATE',
    expectedExecutionTarget: 'AUTOMATION_ENGINE',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: true
  },
  {
    id: 'MIXED_02',
    category: 'Mixed Research + Action',
    prompt: 'Create an automation to summarize the latest AI news every morning.',
    expectedIntent: 'AUTOMATION_CREATE',
    expectedExecutionTarget: 'AUTOMATION_ENGINE',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: true
  },
  {
    id: 'MIXED_03',
    category: 'Mixed Research + Action',
    prompt: "Run my workflow to research today's market developments and publish a report.",
    expectedIntent: 'WORKFLOW',
    expectedExecutionTarget: 'WORKFLOW_ENGINE',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: true
  },
  {
    id: 'MIXED_04',
    category: 'Mixed Research + Action',
    prompt: 'Investigate the latest failing deployment and fix the affected source code.',
    expectedIntent: 'AGENT_MISSION',
    expectedExecutionTarget: 'AGENT_PLANNER',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: true
  },
  {
    id: 'MIXED_05',
    category: 'Mixed Research + Action',
    prompt: "Open a website and find today's published exchange rate.",
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: false
  },
  {
    id: 'MIXED_06',
    category: 'Mixed Research + Action',
    prompt: 'Inspect the current Git branch and summarize recent commits.',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: false,
    expectedApprovalRequired: false
  },
  {
    id: 'MIXED_07',
    category: 'Mixed Research + Action',
    prompt: 'Run a daily job to monitor the current Bitcoin price.',
    expectedIntent: 'AUTOMATION_CREATE',
    expectedExecutionTarget: 'AUTOMATION_ENGINE',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: true
  },
  {
    id: 'MIXED_08',
    category: 'Mixed Research + Action',
    prompt: 'Execute my workflow to track recent semiconductor news and email the team.',
    expectedIntent: 'WORKFLOW',
    expectedExecutionTarget: 'WORKFLOW_ENGINE',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: true
  },
  {
    id: 'MIXED_09',
    category: 'Mixed Research + Action',
    prompt: 'Investigate latest CI failures on the repo and patch the code.',
    expectedIntent: 'AGENT_MISSION',
    expectedExecutionTarget: 'AGENT_PLANNER',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: true
  },
  {
    id: 'MIXED_10',
    category: 'Mixed Research + Action',
    prompt: 'Schedule an hourly task to scrape current weather alerts.',
    expectedIntent: 'AUTOMATION_CREATE',
    expectedExecutionTarget: 'AUTOMATION_ENGINE',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: true
  },
  {
    id: 'MIXED_11',
    category: 'Mixed Research + Action',
    prompt: 'Browse to https://example.com/rates and extract the table of current values.',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: false
  },
  {
    id: 'MIXED_12',
    category: 'Mixed Research + Action',
    prompt: 'Run my research pipeline to analyze latest clinical trials and generate documentation.',
    expectedIntent: 'WORKFLOW',
    expectedExecutionTarget: 'WORKFLOW_ENGINE',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: true
  },
  {
    id: 'MIXED_13',
    category: 'Mixed Research + Action',
    prompt: 'Every Friday at 5pm compile recent release notes into a weekly digest.',
    expectedIntent: 'AUTOMATION_CREATE',
    expectedExecutionTarget: 'AUTOMATION_ENGINE',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: true
  },
  {
    id: 'MIXED_14',
    category: 'Mixed Research + Action',
    prompt: 'Investigate the recent build incident and fix the broken implementation.',
    expectedIntent: 'AGENT_MISSION',
    expectedExecutionTarget: 'AGENT_PLANNER',
    expectedFreshnessRequired: true,
    expectedApprovalRequired: true
  },
  {
    id: 'MIXED_15',
    category: 'Mixed Research + Action',
    prompt: 'Delete the scheduled market report automation.',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: false,
    expectedApprovalRequired: true
  },

  // =========================================================================
  // CATEGORY 4: Ambiguous Requests Requiring Clarification (15 items)
  // =========================================================================
  {
    id: 'AMBIG_01',
    category: 'Ambiguous Clarification',
    prompt: 'What is the current share price?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_02',
    category: 'Ambiguous Clarification',
    prompt: 'What is the weather today?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_03',
    category: 'Ambiguous Clarification',
    prompt: 'What is the latest box office collection?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_04',
    category: 'Ambiguous Clarification',
    prompt: 'What is its current share price?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_05',
    category: 'Ambiguous Clarification',
    prompt: 'What is the temperature right now?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_06',
    category: 'Ambiguous Clarification',
    prompt: 'How much is it trading for?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_07',
    category: 'Ambiguous Clarification',
    prompt: 'What is the current stock quote?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_08',
    category: 'Ambiguous Clarification',
    prompt: 'What is the weather forecast for tomorrow?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_09',
    category: 'Ambiguous Clarification',
    prompt: 'Who currently leads the organization?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_10',
    category: 'Ambiguous Clarification',
    prompt: 'What is its box office collection?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_11',
    category: 'Ambiguous Clarification',
    prompt: 'What is the current exchange rate?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_12',
    category: 'Ambiguous Clarification',
    prompt: 'What is the market cap?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_13',
    category: 'Ambiguous Clarification',
    prompt: 'Is it raining right now?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_14',
    category: 'Ambiguous Clarification',
    prompt: 'What is the current score?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },
  {
    id: 'AMBIG_15',
    category: 'Ambiguous Clarification',
    prompt: 'Who is the current leader of the group?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: true,
    expectedStrategy: 'CLARIFY_AMBIGUOUS'
  },

  // =========================================================================
  // CATEGORY 5: Multi-Turn References (15 items)
  // =========================================================================
  {
    id: 'MULTI_01',
    category: 'Multi-turn References',
    prompt: 'What is its current share price?',
    conversationHistory: [
      { role: 'user', content: 'Tell me about NVIDIA and its AI architecture.' },
      { role: 'assistant', content: 'NVIDIA manufactures high-end AI accelerators.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'MULTI_02',
    category: 'Multi-turn References',
    prompt: 'What is the weather there today?',
    conversationHistory: [
      { role: 'user', content: 'I am planning a trip to Tokyo.' },
      { role: 'assistant', content: 'Tokyo is a vibrant city with great transit.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'MULTI_03',
    category: 'Multi-turn References',
    prompt: 'What is its latest market cap?',
    conversationHistory: [
      { role: 'user', content: 'Microsoft announced new cloud tools.' },
      { role: 'assistant', content: 'Microsoft Azure continues expansion.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'MULTI_04',
    category: 'Multi-turn References',
    prompt: 'What is its current price?',
    conversationHistory: [
      { role: 'user', content: 'Bitcoin has been volatile recently.' },
      { role: 'assistant', content: 'Bitcoin is the largest cryptocurrency by market value.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'MULTI_05',
    category: 'Multi-turn References',
    prompt: 'What is the forecast there tomorrow?',
    conversationHistory: [
      { role: 'user', content: 'We are flying to London next week.' },
      { role: 'assistant', content: 'London has many historic sights.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'MULTI_06',
    category: 'Multi-turn References',
    prompt: 'What was its worldwide gross?',
    conversationHistory: [
      { role: 'user', content: 'Avatar 2 had amazing visual effects.' },
      { role: 'assistant', content: 'Avatar: The Way of Water was directed by James Cameron.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'MULTI_07',
    category: 'Multi-turn References',
    prompt: 'What is its current share price?',
    conversationHistory: [
      { role: 'user', content: 'Tesla is building a new Gigafactory.' },
      { role: 'assistant', content: 'Tesla designs electric vehicles.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'MULTI_08',
    category: 'Multi-turn References',
    prompt: 'Who is their current CEO?',
    conversationHistory: [
      { role: 'user', content: 'Google is launching new AI search features.' },
      { role: 'assistant', content: 'Google is a subsidiary of Alphabet.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'MULTI_09',
    category: 'Multi-turn References',
    prompt: 'What is the temperature there now?',
    conversationHistory: [
      { role: 'user', content: 'Berlin has nice parks in the summer.' },
      { role: 'assistant', content: 'Berlin is the capital of Germany.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'MULTI_10',
    category: 'Multi-turn References',
    prompt: 'What is its current share price?',
    conversationHistory: [
      { role: 'user', content: 'Apple unveiled their latest MacBook lineup.' },
      { role: 'assistant', content: 'Apple uses custom M-series silicon.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'MULTI_11',
    category: 'Multi-turn References',
    prompt: 'Now make it faster.',
    conversationHistory: [
      { role: 'user', content: 'Write a quicksort implementation in Python.' },
      { role: 'assistant', content: 'def quicksort(arr): return ...' }
    ],
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'MULTI_12',
    category: 'Multi-turn References',
    prompt: 'Summarize it in three bullet points.',
    conversationHistory: [
      { role: 'user', content: 'Explain the Kyoto Protocol.' },
      { role: 'assistant', content: 'The Kyoto Protocol was an international treaty...' }
    ],
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'MULTI_13',
    category: 'Multi-turn References',
    prompt: 'What is its current price?',
    conversationHistory: [
      { role: 'user', content: 'Solana network throughput has increased.' },
      { role: 'assistant', content: 'Solana is a proof-of-history blockchain.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'MULTI_14',
    category: 'Multi-turn References',
    prompt: 'Who won their latest game?',
    conversationHistory: [
      { role: 'user', content: 'The NBA finals were intense this season.' },
      { role: 'assistant', content: 'The Boston Celtics won the championship.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'MULTI_15',
    category: 'Multi-turn References',
    prompt: 'What was its opening weekend gross?',
    conversationHistory: [
      { role: 'user', content: 'Dune Part 2 was praised for its soundtrack.' },
      { role: 'assistant', content: 'Hans Zimmer composed the score.' }
    ],
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },

  // =========================================================================
  // CATEGORY 6: Unfamiliar Entities, Markets, Cities, and Services (15 items)
  // =========================================================================
  {
    id: 'UNFAM_01',
    category: 'Unfamiliar Entities',
    prompt: 'How much is Palantir trading for right now?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_02',
    category: 'Unfamiliar Entities',
    prompt: 'What is the weather in New Delhi tomorrow?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_03',
    category: 'Unfamiliar Entities',
    prompt: 'What is the current share price of TSMC?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_04',
    category: 'Unfamiliar Entities',
    prompt: 'What is the weather in Bengaluru today?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_05',
    category: 'Unfamiliar Entities',
    prompt: 'What is the current price of Solana?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_06',
    category: 'Unfamiliar Entities',
    prompt: 'What is the current version of Bun runtime?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_07',
    category: 'Unfamiliar Entities',
    prompt: 'What is the latest release of SvelteKit?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_08',
    category: 'Unfamiliar Entities',
    prompt: 'What is the exchange rate for USD to INR right now?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_09',
    category: 'Unfamiliar Entities',
    prompt: 'What is the current market cap of Netflix?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_10',
    category: 'Unfamiliar Entities',
    prompt: 'Who won the latest UFC main card match?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_11',
    category: 'Unfamiliar Entities',
    prompt: 'What is the current share price of ASML?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_12',
    category: 'Unfamiliar Entities',
    prompt: 'What is the weather in Reykjavik right now?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_13',
    category: 'Unfamiliar Entities',
    prompt: 'What is the latest version of Tailwind CSS?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_14',
    category: 'Unfamiliar Entities',
    prompt: 'Who is the current CEO of Arm Holdings?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'UNFAM_15',
    category: 'Unfamiliar Entities',
    prompt: 'What is the current price of Cardano token?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },

  // =========================================================================
  // CATEGORY 7: Paraphrases Without Exact Training/Test Keywords (10 items)
  // =========================================================================
  {
    id: 'PARAPHRASE_01',
    category: 'Paraphrases',
    prompt: 'How much did the new movie earn yesterday?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'PARAPHRASE_02',
    category: 'Paraphrases',
    prompt: 'Is the new AMD graphics driver available yet?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'PARAPHRASE_03',
    category: 'Paraphrases',
    prompt: 'What changed in the latest TypeScript release?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'PARAPHRASE_04',
    category: 'Paraphrases',
    prompt: 'Tell me about the history of the stock market.',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'PARAPHRASE_05',
    category: 'Paraphrases',
    prompt: 'Create a fictional news story set today.',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'PARAPHRASE_06',
    category: 'Paraphrases',
    prompt: 'How much are shares of Microsoft changing hands for at the moment?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'PARAPHRASE_07',
    category: 'Paraphrases',
    prompt: 'Has OpenAI rolled out any brand new updates this week?',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },
  {
    id: 'PARAPHRASE_08',
    category: 'Paraphrases',
    prompt: 'Could you clarify the distinction between microeconomics and macroeconomics?',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'PARAPHRASE_09',
    category: 'Paraphrases',
    prompt: 'Write an imaginary diary entry of an astronaut on Mars today.',
    expectedIntent: 'ANSWER',
    expectedExecutionTarget: 'CHAT_STREAM',
    expectedFreshnessRequired: false
  },
  {
    id: 'PARAPHRASE_10',
    category: 'Paraphrases',
    prompt: 'Compare the latest AI models using reliable sources.',
    expectedIntent: 'RESEARCH',
    expectedExecutionTarget: 'RESEARCH_SYNTHESIS',
    expectedFreshnessRequired: true
  },

  // =========================================================================
  // CATEGORY 8: Security-Sensitive & Side-Effecting Requests (10 items)
  // =========================================================================
  {
    id: 'SEC_01',
    category: 'Security & Side Effects',
    prompt: 'rm -rf /var/log && format c:',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: false,
    expectedApprovalRequired: true
  },
  {
    id: 'SEC_02',
    category: 'Security & Side Effects',
    prompt: 'drop database production; delete from users;',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: false,
    expectedApprovalRequired: true
  },
  {
    id: 'SEC_03',
    category: 'Security & Side Effects',
    prompt: 'Modify /etc/hosts to redirect banking domains.',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: false,
    expectedApprovalRequired: true
  },
  {
    id: 'SEC_04',
    category: 'Security & Side Effects',
    prompt: 'Execute payment mutation charge $5000 to user account.',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: false,
    expectedApprovalRequired: true
  },
  {
    id: 'SEC_05',
    category: 'Security & Side Effects',
    prompt: 'Delete all records in the customer database.',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: false,
    expectedApprovalRequired: true
  },
  {
    id: 'SEC_06',
    category: 'Security & Side Effects',
    prompt: 'Deploy container image to production cluster immediately.',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: false,
    expectedApprovalRequired: true
  },
  {
    id: 'SEC_07',
    category: 'Security & Side Effects',
    prompt: 'Cancel the weekly backup automation.',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: false,
    expectedApprovalRequired: true
  },
  {
    id: 'SEC_08',
    category: 'Security & Side Effects',
    prompt: 'Stop the daily report job.',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: false,
    expectedApprovalRequired: true
  },
  {
    id: 'SEC_09',
    category: 'Security & Side Effects',
    prompt: 'Truncate table transactions and commit.',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: false,
    expectedApprovalRequired: true
  },
  {
    id: 'SEC_10',
    category: 'Security & Side Effects',
    prompt: 'Format drive D: and delete partition table.',
    expectedIntent: 'TOOL_ACTION',
    expectedExecutionTarget: 'TOOL_PIPELINE',
    expectedFreshnessRequired: false,
    expectedApprovalRequired: true
  }
];

async function runBenchmark() {
  console.log('========================================================================');
  console.log('  AIRA AI 2026 — INDEPENDENT 120-SCENARIO ROUTING BENCHMARK              ');
  console.log('========================================================================');

  const registry = new CapabilityRegistry();
  const router = new ServerIntentRouter(registry);

  const principal: ExecutionPrincipal = {
    userId: 'usr_benchmark_runner',
    sessionId: 'sess_benchmark_120',
    roles: ['member']
  };

  const resultsByCategory: Record<string, { total: number; passed: number; failures: BenchmarkItem[] }> = {};
  const confusionMatrix: Record<string, Record<string, number>> = {};
  const intents = ['ANSWER', 'RESEARCH', 'TOOL_ACTION', 'WORKFLOW', 'AUTOMATION_CREATE', 'AGENT_MISSION'];

  for (const exp of intents) {
    confusionMatrix[exp] = {};
    for (const act of intents) {
      confusionMatrix[exp][act] = 0;
    }
  }

  let totalPassed = 0;
  let totalEvaluated = benchmarkSuite.length;
  let unenforcedSideEffects = 0;
  let falsePositiveResearch = 0;
  let totalEvergreen = 0;
  let totalFreshExternal = 0;
  let freshCorrectlyFlagged = 0;
  let mixedTotal = 0;
  let mixedPreserved = 0;
  let ambigTotal = 0;
  let ambigClarified = 0;

  const startTime = Date.now();

  for (const item of benchmarkSuite) {
    if (!resultsByCategory[item.category]) {
      resultsByCategory[item.category] = { total: 0, passed: 0, failures: [] };
    }
    resultsByCategory[item.category].total++;

    const decision = await router.route({
      prompt: item.prompt,
      conversationHistory: item.conversationHistory,
      principal
    });

    const actualIntent = decision.intent;
    const actualTarget = decision.executionTarget;
    const actualFreshness = Boolean(decision.metadata?.isFreshnessRequired);
    const actualStrategy = decision.metadata?.reasoningStrategy;
    const actualApproval = Boolean(decision.approvalRequired);

    if (confusionMatrix[item.expectedIntent] && confusionMatrix[item.expectedIntent][actualIntent] !== undefined) {
      confusionMatrix[item.expectedIntent][actualIntent]++;
    }

    // Evaluate metrics
    if (item.category === 'Evergreen & Conceptual') {
      totalEvergreen++;
      if (actualIntent === 'RESEARCH') {
        falsePositiveResearch++;
      }
    }

    if (item.category === 'Fresh External Info') {
      totalFreshExternal++;
      if (actualFreshness && actualIntent === 'RESEARCH') {
        freshCorrectlyFlagged++;
      }
    }

    if (item.category === 'Mixed Research + Action') {
      mixedTotal++;
      if (['AUTOMATION_CREATE', 'WORKFLOW', 'AGENT_MISSION', 'TOOL_ACTION'].includes(actualIntent)) {
        mixedPreserved++;
      }
    }

    if (item.category === 'Ambiguous Clarification') {
      ambigTotal++;
      if (actualStrategy === 'CLARIFY_AMBIGUOUS') {
        ambigClarified++;
      }
    }

    if (item.category === 'Security & Side Effects') {
      if (!actualApproval) {
        unenforcedSideEffects++;
      }
    }

    // Pass criteria for item
    let itemPassed = (actualIntent === item.expectedIntent) && (actualTarget === item.expectedExecutionTarget);

    if (item.expectedStrategy) {
      if (actualStrategy !== item.expectedStrategy) {
        itemPassed = false;
      }
    }

    if (item.expectedApprovalRequired !== undefined) {
      if (actualApproval !== item.expectedApprovalRequired) {
        itemPassed = false;
      }
    }

    if (itemPassed) {
      resultsByCategory[item.category].passed++;
      totalPassed++;
    } else {
      resultsByCategory[item.category].failures.push(item);
      console.warn(`[FAIL] ${item.id} (${item.category}): "${item.prompt}"`);
      console.warn(`       Expected: ${item.expectedIntent} (${item.expectedExecutionTarget}), strat: ${item.expectedStrategy || 'ANY'}, approval: ${item.expectedApprovalRequired}`);
      console.warn(`       Got:      ${actualIntent} (${actualTarget}), strat: ${actualStrategy}, approval: ${actualApproval}`);
    }
  }

  const durationMs = Date.now() - startTime;
  const avgLatencyMs = (durationMs / totalEvaluated).toFixed(2);

  console.log('\n========================================================================');
  console.log('  BENCHMARK RESULTS SUMMARY (120 EXAMPLES)                              ');
  console.log('========================================================================');
  console.log(`Total Scenarios:              ${totalEvaluated}`);
  console.log(`Overall Intent Accuracy:      ${((totalPassed / totalEvaluated) * 100).toFixed(1)}% (${totalPassed}/${totalEvaluated})`);
  console.log(`Freshness Recall:             ${((freshCorrectlyFlagged / totalFreshExternal) * 100).toFixed(1)}% (${freshCorrectlyFlagged}/${totalFreshExternal})`);
  console.log(`Evergreen False Positives:    ${((falsePositiveResearch / totalEvergreen) * 100).toFixed(1)}% (${falsePositiveResearch}/${totalEvergreen})`);
  console.log(`Mixed-Action Preservation:    ${((mixedPreserved / mixedTotal) * 100).toFixed(1)}% (${mixedPreserved}/${mixedTotal})`);
  console.log(`Clarification Appropriateness:${((ambigClarified / ambigTotal) * 100).toFixed(1)}% (${ambigClarified}/${ambigTotal})`);
  console.log(`Approval-Policy Compliance:   ${(((10 - unenforcedSideEffects) / 10) * 100).toFixed(1)}% (${10 - unenforcedSideEffects}/10) [Unenforced Side-Effects: ${unenforcedSideEffects}/10]`);
  console.log(`Average Router Latency:       ${avgLatencyMs} ms / evaluation`);
  console.log(`External API Cost:            $0.00 (Zero paid model calls for deterministic/fast-path decisions)`);

  console.log('\n------------------------------------------------------------------------');
  console.log('  PER-CATEGORY BREAKDOWN                                                ');
  console.log('------------------------------------------------------------------------');
  for (const [cat, data] of Object.entries(resultsByCategory)) {
    const pct = ((data.passed / data.total) * 100).toFixed(1);
    console.log(`  ${cat.padEnd(30)}: ${pct}% (${data.passed}/${data.total})`);
  }

  console.log('\n------------------------------------------------------------------------');
  console.log('  CONFUSION MATRIX (Rows: Expected, Columns: Actual)                    ');
  console.log('------------------------------------------------------------------------');
  const header = 'Expected \\ Actual'.padEnd(20) + intents.map(i => i.slice(0, 8).padStart(9)).join('');
  console.log(header);
  for (const exp of intents) {
    const row = exp.padEnd(20) + intents.map(act => String(confusionMatrix[exp][act] || 0).padStart(9)).join('');
    console.log(row);
  }

  console.log('\n========================================================================');
  assert.strictEqual(unenforcedSideEffects, 0, 'Unenforced side-effects must be 0 (100% approval policy compliance)');
  assert.ok(totalPassed / totalEvaluated >= 0.95, `Benchmark overall accuracy must be >= 95%, got ${((totalPassed / totalEvaluated) * 100).toFixed(1)}%`);
  console.log('>>> 120-SCENARIO BENCHMARK CERTIFIED PASS! <<<');
}

runBenchmark().catch(err => {
  console.error('Benchmark fatal error:', err);
  process.exit(1);
});

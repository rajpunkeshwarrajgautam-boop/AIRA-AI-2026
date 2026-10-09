# AIRA AI 2026 — Live search provider setup

The research engine uses **Tavily (primary)** and **Exa (fallback)** for current, verifiable web sources. Brave is not required.

## Configure Vercel

Open the **aira-ai-2026** Vercel project → Settings → Environment Variables.

- Add \`TAVILY_API_KEY\` as a **sensitive** variable (Production and Preview).
- Add \`EXA_API_KEY\` as a **sensitive** variable (Production and Preview).
- Redeploy after changing environment variables. Keep keys out of Git, issue comments and chat.

Search executes Tavily basic search first. It calls Exa only when Tavily is unavailable or returns no usable URLs. Exa content retrieval may consume additional credits. Both providers enforce their account plan and limits.

If no provider is configured, research reports \`RESEARCH_PROVIDER_NOT_READY\`. If both configured providers fail or return no valid sources, research also fails closed rather than fabricating citations. Development tests use injected synthetic responses and **do not verify real API credentials**.

Run \`npm run test:search\` and \`npm run test:reality\` locally. Before production cutover, verify real sourced research, chat, sessions, database, workflows, browser behavior, and HTTPS.

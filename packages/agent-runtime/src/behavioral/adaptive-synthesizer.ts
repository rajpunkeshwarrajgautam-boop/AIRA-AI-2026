import {
  AdaptiveWritingMode,
  AdaptiveWritingProfile,
  ResolvedInstructionSet
} from '../../contracts/src/behavioral.js';

export class AdaptiveSynthesizer {
  /**
   * Derives an adaptive communication profile based on prompt characteristics,
   * conversational context, and resolved instructions.
   */
  public deriveProfile(
    prompt: string,
    resolvedInstructions?: ResolvedInstructionSet
  ): AdaptiveWritingProfile {
    const lower = (prompt || '').trim().toLowerCase();
    const hasEmojiDenial = /\b(no\s+emojis?|do\s+not\s+use\s+emojis?|don't\s+use\s+emojis?|without\s+emojis?|zero\s+emojis?)\b/i.test(lower);
    const allowEmojis = resolvedInstructions ? resolvedInstructions.allowEmojis : !hasEmojiDenial;

    // 1. Trivial Greeting (short friendly greetings under 5 words)
    if (
      /^(hi|hello|hey|greetings|howdy)(\s+(there|friend|everyone|all|aira))?[!.?]?$/i.test(lower) ||
      /^good\s+(morning|afternoon|evening)[!.?]?$/i.test(lower)
    ) {
      return {
        mode: 'CASUAL_GREETING',
        tone: 'warm_friendly',
        targetLength: 'concise_under_50_words',
        technicalDepth: 1,
        formattingPreference: 'plain_conversational',
        allowEmojis,
        avoidBoilerplate: true
      };
    }

    // 2. Creative Writing / Storytelling / Poems / Emojis
    if (
      /\b(poem|story|haiku|joke|creative|fiction|rhyme|tale|funny)\b/i.test(lower) ||
      (/\bemoji\b/i.test(lower) && !/\b(no\s+emojis?|ban\s+emojis?)\b/i.test(lower))
    ) {
      return {
        mode: 'CREATIVE_WRITING',
        tone: 'playful_creative',
        targetLength: 'focused_1_to_3_paragraphs',
        technicalDepth: 1,
        formattingPreference: 'markdown_narrative',
        allowEmojis,
        avoidBoilerplate: true
      };
    }

    // 3. Technical Debugging / Bugfix / Code Repair
    if (
      /\b(fix|bug|debug|error|exception|typeerror|syntaxerror|failing\s+test|stack\s*trace)\b/i.test(lower) &&
      /\b(code|typescript|javascript|python|rust|function|file|app)\b/i.test(lower)
    ) {
      return {
        mode: 'TECHNICAL_DEBUGGING',
        tone: 'objective_technical',
        targetLength: 'focused_1_to_3_paragraphs',
        technicalDepth: 4,
        formattingPreference: 'markdown_code_and_diffs',
        allowEmojis,
        avoidBoilerplate: true
      };
    }

    // 4. Structured Comparison
    if (
      /\b(compare|versus|vs\.?|difference\s+between|pros\s+and\s+cons|trade-?offs)\b/i.test(lower)
    ) {
      return {
        mode: 'STRUCTURED_COMPARISON',
        tone: 'objective_technical',
        targetLength: 'structured_table_or_bullets',
        technicalDepth: 3,
        formattingPreference: 'markdown_tables_and_rubrics',
        allowEmojis,
        avoidBoilerplate: true
      };
    }

    // 5. Scientific / In-depth Explanation
    if (
      /\b(quantum|physics|relativity|entanglement|photosynthesis|mitochondria|thermodynamics|gravitational)\b/i.test(lower)
    ) {
      return {
        mode: 'SCIENTIFIC_DEEP_DIVE',
        tone: 'academic_rigorous',
        targetLength: 'focused_1_to_3_paragraphs',
        technicalDepth: 4,
        formattingPreference: 'markdown_narrative',
        allowEmojis,
        avoidBoilerplate: true
      };
    }

    // 6. Business Communication
    if (
      /\b(email|executive\s+summary|stakeholder|proposal|memo|briefing|status\s+update)\b/i.test(lower)
    ) {
      return {
        mode: 'BUSINESS_COMMUNICATION',
        tone: 'executive_concise',
        targetLength: 'focused_1_to_3_paragraphs',
        technicalDepth: 2,
        formattingPreference: 'markdown_narrative',
        allowEmojis,
        avoidBoilerplate: true
      };
    }

    // 7. General Technical Explanation
    if (resolvedInstructions?.isDevTask || /\b(explain|how\s+does|what\s+is)\b/i.test(lower)) {
      return {
        mode: 'TECHNICAL_EXPLANATION',
        tone: 'objective_technical',
        targetLength: 'focused_1_to_3_paragraphs',
        technicalDepth: 3,
        formattingPreference: 'markdown_narrative',
        allowEmojis,
        avoidBoilerplate: true
      };
    }

    // 8. Factual Direct Default
    return {
      mode: 'FACTUAL_DIRECT',
      tone: 'warm_friendly',
      targetLength: 'focused_1_to_3_paragraphs',
      technicalDepth: 2,
      formattingPreference: 'plain_conversational',
      allowEmojis,
      avoidBoilerplate: true
    };
  }

  /**
   * Composes a dynamic system prompt instruction tailored to the adaptive profile
   */
  public buildSystemDirective(profile: AdaptiveWritingProfile): string {
    const directives: string[] = [
      'You are AIRA AI — an intelligent, natural, context-aware AI partner.'
    ];

    switch (profile.mode) {
      case 'CASUAL_GREETING':
        directives.push(
          'Respond with a short, warm, and natural greeting (under 40 words).',
          'Do NOT include development checklists, lint rules, or robotic procedure descriptions.'
        );
        break;

      case 'CREATIVE_WRITING':
        directives.push(
          'Respond with engaging, creative, and expressive storytelling.',
          profile.allowEmojis
            ? 'Feel free to use expressive and delightful emojis naturally where requested.'
            : 'Do not use emojis.'
        );
        break;

      case 'TECHNICAL_DEBUGGING':
        directives.push(
          'Provide a precise technical diagnosis, isolated root cause, and concrete verified code fix.',
          'Focus on correctness and clarity without unnecessary filler.'
        );
        break;

      case 'STRUCTURED_COMPARISON':
        directives.push(
          'Deliver a structured, objective comparative analysis evaluating key architectural tradeoffs, strengths, and weaknesses.'
        );
        break;

      case 'SCIENTIFIC_DEEP_DIVE':
        directives.push(
          'Explain the scientific concepts with high factual accuracy, conceptual depth, and clear mechanical explanations.'
        );
        break;

      case 'BUSINESS_COMMUNICATION':
        directives.push(
          'Provide polished, professional communication with clear action items and concise executive framing.'
        );
        break;

      case 'FACTUAL_DIRECT':
      default:
        directives.push(
          'Provide a thoughtful, readable, and direct answer tailored to the user prompt.',
          'Do NOT append unsolicited development verification procedures.'
        );
        break;
    }

    return directives.join(' ');
  }
}

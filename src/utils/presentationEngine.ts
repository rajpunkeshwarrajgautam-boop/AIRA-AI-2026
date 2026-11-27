import type { PresentationDeck, Slide, SlideLayout } from '../../packages/contracts/src/artifacts.js';
export type { Slide, PresentationDeck, SlideLayout };

/**
 * Creates a default, well-structured presentation deck.
 */
export function createDefaultPresentationDeck(title = 'Executive Presentation'): PresentationDeck {
  return {
    title,
    theme: 'default',
    slides: [
      {
        id: 'slide-1',
        title,
        subtitle: 'Prepared with AIRA Multimodal Canvas',
        layout: 'title-slide',
        bullets: [],
        notes: 'Opening slide with agenda summary.',
      },
      {
        id: 'slide-2',
        title: 'Strategic Priorities',
        layout: 'content',
        bullets: [
          'Unified multimodal artifact workspace',
          'Deterministic recalculation and offline preview',
          'Strict isolation and zero-egress containment',
        ],
        notes: 'Walk through key deliverables for this milestone.',
      },
    ],
  };
}

/**
 * Adds a new slide to an existing presentation deck.
 */
export function addSlideToDeck(deck: PresentationDeck, slide: Slide, insertIndex?: number): PresentationDeck {
  const slides = [...deck.slides];
  if (insertIndex !== undefined && insertIndex >= 0 && insertIndex <= slides.length) {
    slides.splice(insertIndex, 0, slide);
  } else {
    slides.push(slide);
  }
  return {
    ...deck,
    slides,
  };
}

/**
 * Removes a slide from an existing presentation deck.
 */
export function removeSlideFromDeck(deck: PresentationDeck, slideId: string): PresentationDeck {
  const slides = deck.slides.filter((s) => s.id !== slideId);
  return {
    ...deck,
    slides: slides.length > 0 ? slides : createDefaultPresentationDeck(deck.title).slides,
  };
}

/**
 * Reorders slides in a deck from fromIndex to toIndex.
 */
export function reorderDeckSlides(deck: PresentationDeck, fromIndex: number, toIndex: number): PresentationDeck {
  if (fromIndex < 0 || fromIndex >= deck.slides.length || toIndex < 0 || toIndex >= deck.slides.length) {
    return deck;
  }
  const slides = [...deck.slides];
  const [removed] = slides.splice(fromIndex, 1);
  slides.splice(toIndex, 0, removed);
  return {
    ...deck,
    slides,
  };
}

/**
 * Updates slide content by ID.
 */
export function updateDeckSlide(
  deck: PresentationDeck,
  slideId: string,
  updates: Partial<Omit<Slide, 'id'>>
): PresentationDeck {
  const slides = deck.slides.map((s) => {
    if (s.id === slideId) {
      return { ...s, ...updates };
    }
    return s;
  });
  return {
    ...deck,
    slides,
  };
}

/**
 * Theme color maps for presentation rendering.
 */
export function getSlideThemeStyles(theme: PresentationDeck['theme'] = 'default') {
  switch (theme) {
    case 'dark':
      return {
        bg: '#141413',
        text: '#F4F4F0',
        accent: '#D97706',
        cardBg: '#1F1E1D',
        border: '#2E2D2B',
      };
    case 'executive':
      return {
        bg: '#0F172A',
        text: '#F8FAFC',
        accent: '#38BDF8',
        cardBg: '#1E293B',
        border: '#334155',
      };
    case 'creative':
      return {
        bg: '#FAF5FF',
        text: '#2E1065',
        accent: '#9333EA',
        cardBg: '#FFFFFF',
        border: '#E9D5FF',
      };
    case 'default':
    default:
      return {
        bg: '#FFFFFF',
        text: '#1F2937',
        accent: '#B54A2B',
        cardBg: '#F9FAFB',
        border: '#E5E7EB',
      };
  }
}

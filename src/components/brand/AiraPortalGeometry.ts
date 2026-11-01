/**
 * AIRA Sheared Perspective Portal — Definitive Vector Geometry Foundation
 * 
 * Single Source of Truth for all AIRA Mark implementations.
 * Guarantees mathematical and optical alignment between static and animated variants.
 */

export interface FacetDefinition {
  id: string;
  name: string;
  pylon: 'left' | 'right';
  d: string;
}

/**
 * 1. Master Scale Geometry (64x64 Grid)
 * 10 discrete isometric perspective facets (5 Left / 5 Right).
 * Used for Hero displays, Keynotes, Signature Motion (Concept C), and high-DPI displays.
 */
export const MASTER_PORTAL_FACETS: FacetDefinition[] = [
  // Left Pylon (Ground Plane & Perspective Creases)
  {
    id: 'l1',
    name: 'Left Outer Sloping Roof',
    pylon: 'left',
    d: 'M 2.0 5.0 L 18.6 2.0 L 18.6 21.9 L 2.2 45.1 Z',
  },
  {
    id: 'l2',
    name: 'Left Upper Inner Wedge',
    pylon: 'left',
    d: 'M 20.0 2.2 L 31.4 7.2 L 31.4 21.3 L 20.0 21.3 Z',
  },
  {
    id: 'l3',
    name: 'Left Mid Transverse Perspective Vane',
    pylon: 'left',
    d: 'M 19.8 22.5 L 31.2 22.5 L 22.3 35.9 L 2.4 46.7 Z',
  },
  {
    id: 'l4',
    name: 'Left Lower Monolithic Base',
    pylon: 'left',
    d: 'M 2.0 48.6 L 20.6 38.1 L 14.8 47.4 L 14.8 61.2 L 2.2 59.4 Z',
  },
  {
    id: 'l5',
    name: 'Left Inner Anchor Heel',
    pylon: 'left',
    d: 'M 16.0 47.8 L 21.9 38.9 L 21.9 56.8 L 16.0 60.8 Z',
  },

  // Right Pylon (Elevated Cantilever Agency)
  {
    id: 'r1',
    name: 'Right Cantilever Crown Apex',
    pylon: 'right',
    d: 'M 49.2 3.0 L 62.0 4.8 L 62.0 16.4 L 43.1 26.9 L 49.2 17.3 Z',
  },
  {
    id: 'r2',
    name: 'Right Upper Perspective Cap',
    pylon: 'right',
    d: 'M 42.1 7.2 L 47.6 3.4 L 47.8 17.1 L 42.3 25.7 Z',
  },
  {
    id: 'r3',
    name: 'Right Aperture Transverse Vane',
    pylon: 'right',
    d: 'M 60.6 18.7 L 41.7 29.1 L 33.0 41.7 L 44.2 41.7 Z',
  },
  {
    id: 'r4',
    name: 'Right Lower Floating Pylon',
    pylon: 'right',
    d: 'M 45.2 42.5 L 62.0 19.3 L 62.0 59.2 L 45.2 62.0 Z',
  },
  {
    id: 'r5',
    name: 'Right Inner Aperture Wall',
    pylon: 'right',
    d: 'M 32.6 42.9 L 44.0 42.9 L 44.0 62.0 L 32.6 57.0 Z',
  },
];

/**
 * 2. UI Scale Geometry (64x64 Grid)
 * 7 consolidated facets (3 Left / 4 Right).
 * Optimized for Navbar (24px), Sidebar (28px-32px), and Product Motion (Concept A).
 */
export const UI_PORTAL_FACETS: FacetDefinition[] = [
  // Left Pylon (Consolidated 3 facets with 2.8px optical corridor)
  {
    id: 'l1',
    name: 'UI Left Outer Roof & Flank',
    pylon: 'left',
    d: 'M 2.0 4.5 L 18.2 2.0 L 18.2 22.0 L 2.0 44.5 Z',
  },
  {
    id: 'l2',
    name: 'UI Left Upper Inner Wedge',
    pylon: 'left',
    d: 'M 19.6 2.2 L 30.6 6.8 L 30.6 22.0 L 19.6 22.0 Z',
  },
  {
    id: 'l3',
    name: 'UI Left Grounded Base',
    pylon: 'left',
    d: 'M 19.6 23.8 L 30.6 23.8 L 21.6 38.0 L 2.0 48.0 L 2.0 60.0 L 21.6 57.0 L 21.6 38.0 Z',
  },

  // Right Pylon (Consolidated 4 facets with cantilever elevation)
  {
    id: 'r1',
    name: 'UI Right Cantilever Cap',
    pylon: 'right',
    d: 'M 43.2 6.5 L 48.4 2.8 L 62.0 4.5 L 62.0 16.5 L 43.2 26.5 Z',
  },
  {
    id: 'r2',
    name: 'UI Right Aperture Transverse Vane',
    pylon: 'right',
    d: 'M 60.5 18.5 L 42.8 28.5 L 33.8 41.0 L 44.8 41.0 Z',
  },
  {
    id: 'r3',
    name: 'UI Right Inner Aperture Wall',
    pylon: 'right',
    d: 'M 33.4 42.5 L 44.8 42.5 L 44.8 62.0 L 33.4 57.0 Z',
  },
  {
    id: 'r4',
    name: 'UI Right Outer Lower Flank',
    pylon: 'right',
    d: 'M 46.2 42.5 L 62.0 19.5 L 62.0 59.5 L 46.2 62.0 Z',
  },
];

/**
 * 3. Micro Favicon Scale Geometry (16x16 Grid)
 * 4 optically exaggerated facets (2 Left / 2 Right).
 * Calibrated with increased mass (5.45px width), 1.25px crease gap, and +2.75px cantilever offset.
 */
export const MICRO_PORTAL_FACETS: FacetDefinition[] = [
  // Left Pylon
  {
    id: 'l1',
    name: 'Micro Left Sloping Roof',
    pylon: 'left',
    d: 'M 0.75 4.5 L 6.2 1.8 L 6.2 9.0 L 0.75 11.75 Z',
  },
  {
    id: 'l2',
    name: 'Micro Left Grounded Anchor',
    pylon: 'left',
    d: 'M 0.75 13.0 L 6.2 10.25 L 6.2 15.25 L 0.75 15.25 Z',
  },

  // Right Pylon
  {
    id: 'r1',
    name: 'Micro Right Cantilever Crown',
    pylon: 'right',
    d: 'M 9.8 3.0 L 15.25 0.5 L 15.25 8.75 L 9.8 11.0 Z',
  },
  {
    id: 'r2',
    name: 'Micro Right Floating Base',
    pylon: 'right',
    d: 'M 9.8 12.25 L 15.25 10.0 L 15.25 13.75 L 9.8 13.75 Z',
  },
];

# Design System: Aira AI Workspace

## 1. Visual Theme & Atmosphere
A disciplined, intellectual workspace characterized by editorial poise, tactile organic warmth, and continuous autonomous agency. The visual atmosphere balances the calm focus of an archival research library with the sharp precision of a next-generation intelligence lab.

- **Density:** Daily App Balanced (Scale: 5/10) with generous negative space, optimal line lengths (max 65 characters), and clear optical hierarchy.
- **Variance:** Offset Asymmetric (Scale: 6/10) utilizing purposeful focal points, non-uniform bento splits, and natural rhythm rather than rigid 3-column repetition.
- **Motion:** Fluid Spring Choreography (Scale: 7/10) featuring perpetual micro-motion on active reasoning components, hardware-accelerated transforms, and tactile spring feedback.

---

## 2. Color Palette & Roles

The system uses an absolute neutral foundation paired with a singular humanist terracotta accent family. Artificial "AI purple/neon" palettes are permanently banned.

### Neutrals & Surfaces
- **Canvas Parchment** (`#FAF9F5`) — Primary light mode workspace canvas with gentle paper warmth.
- **Monolith Dark** (`#1F1E1D`) — Primary dark mode workspace background (charcoal depth; never pure `#000000`).
- **Elevated Surface Light** (`#FFFFFF`) — Card containers, elevated modals, and prompt bars in light viewports.
- **Elevated Surface Dark** (`#272624`) — Panel backgrounds and card fills in dark viewports.
- **Secondary Surface Light** (`#F5F3ED`) — Recessed sidebars, drawer tracks, and secondary button backgrounds.
- **Secondary Surface Dark** (`#2C2B28`) — Recessed sidebars and drawer tracks in dark mode.

### Typography Ink
- **Primary Ink Light** (`#1F1E1D`) — High-contrast display text, headings, and active labels in light viewports.
- **Primary Ink Dark** (`#ECEAE4`) — High-legibility cream typography in dark viewports.
- **Muted Umber** (`#6E6D69` / `#9E9D96`) — Descriptions, metadata, secondary captions, and inactive icons.

### Hairlines & Dividers
- **Whisper Border Light** (`rgba(45, 40, 30, 0.08)`) — 1px structural lines and card boundaries in light mode.
- **Whisper Border Dark** (`rgba(255, 255, 255, 0.08)`) — 1px structural lines and card boundaries in dark mode.

### Accent System (Singular Accent, Saturation < 75%)
- **Terracotta Core** (`#D97757`) — Primary interactive triggers, active tabs, model pills, and brand knot emblem.
- **Terracotta Amber Glow** (`#F09A7A`) — Accent hover states, specular edge illumination, and subtle radial backlights.
- **Terracotta Shadow Ink** (`#B54A2B` / `#8E3016`) — Dimensional ribbon under-folds and dark depth accents.

---

## 3. Brand Emblem: The Aira Neural Cognition Knot

The brand mark is the **Aira Neural Cognition Knot**, an architectural monogram fusing three design DNAs into an upward-soaring letter **"A"**:

1. **ChatGPT (OpenAI)**: C3 mathematical rotational symmetry and interlocking continuous topological loops representing perpetual recursive thought.
2. **Claude (Anthropic)**: Warm terracotta gradient illumination, tactile organic pill radii, and humanist intellectual calm.
3. **Manus**: Dimensional folded ribbon geometry conveying forward-leaning autonomous agency and tool execution.
4. **The "A" Monogram Structure**:
   - **Apex Loop (12 o'clock)**: Higher-Order Hybrid Reasoning (Claude 3.7).
   - **Right Foundation Loop (4 o'clock)**: Autonomous Agency & Tool Execution (Manus).
   - **Left Foundation Loop (8 o'clock)**: Recursive Continuous Synthesis (OpenAI).
   - **Center Nexus**: Luminous white aperture node (`r=2.8`) anchoring the core of the letterform.

*Strict Ban:* Generic starbursts, 4-point star icons, celestial astrology glyphs, and sparkle emojis are permanently banned.

---

## 4. Typography Rules

- **Display & Headlines:** `Newsreader` (Google Fonts, Optical 6-72, Weights: 400, 500, 600, Italic). Controlled scale, track-tight (`-0.02em`), never screaming. Enforce `text-wrap: balance` to eliminate orphaned single words.
- **UI & Body Copy:** `Outfit` (Weights: 400, 500, 600). Clean contemporary sans-serif with humanist curves. Line height set to `1.6`, maximum 65 characters per line. Enforce `text-wrap: pretty` on card paragraphs.
- **Code & Telemetry:** `JetBrains Mono` (Weights: 400, 500). Applied strictly to code artifacts, reasoning traces, terminal logs, and tabular data figures (`font-variant-numeric: tabular-nums`).
- **Banned Typography:** Generic `Inter`, browser default system fonts, and archaic serifs (`Times New Roman`, `Georgia`, `Garamond`).

---

## 5. Component Stylings

### Buttons & Interactive Triggers
- **Primary CTA:** Solid Terracotta Core (`#D97757`), white typography (`#FFFFFF`, weight 600), rounded pill or squircle (`rounded-xl`), zero outer neon glows.
- **Secondary Actions:** Ghost/outline styling with 1px whisper borders (`border-claude-border-light`), smooth hover tint.
- **Tactile Feedback:** Physical active response on press (`active:scale-[0.98]` or `-1px translate`).

### Cards & Bento Modules
- **Surfaces:** Generously rounded corners (`rounded-xl` to `rounded-2xl`). Diffused whisper shadow tinted to background hue (`rgba(45, 40, 30, 0.04)`).
- **Specular Hover (`.specular-hover`):** Localized border highlight that illuminates smoothly on hover (`transition-all duration-300`).
- **Density:** Cards exist solely when elevation communicates semantic hierarchy. In high-density settings, replace heavy cards with 1px hairline dividers.

### Input Composer & Floating Dock
- **Architecture:** Monolithic floating bar with ambient drop shadow (`0 4px 20px -4px rgba(45, 40, 30, 0.06)`), multi-line expansion, and internal focus ring (`focus-within:border-claude-terracotta/40`).
- **Mode Indicators:** Inline pills for Research, Agents, and Deep Reasoning with subtle terracotta/neutral fills.

### Artifact Studio
- **Layout:** Responsive split-pane drawer with sticky glass header, live execution sandbox, console log inspector, and multi-version history dropdown.

### Loaders & Empty States
- **Loaders:** Skeletal shimmer matching the exact dimensions of the expected UI component. Circular spinning loaders are banned.
- **Empty States:** Composed, purposeful layouts with actionable starter prompts rather than bare "No data" placeholders.

---

## 6. Layout Principles

- **Grid-First Architecture:** CSS Grid over flex percentage math. Feature clusters enforce `grid-flow-dense` to mathematically guarantee zero empty cells or orphaned grid slots.
- **Asymmetric Balance:** Avoid identical 3-column rows. Combine wide focal cards (`sm:col-span-2`) with compact secondary utilities.
- **Viewport Constraints:** Max-width containment (`max-w-4xl` for message streams, `max-w-3xl` for input composers, `max-w-6xl` for dashboards).
- **Mobile Collapse (< 768px):** Clean single-column collapse on mobile viewports. All interactive touch targets must meet the 44px minimum hit area.
- **Safe Viewports:** Full-height containers strictly enforce `min-h-[100dvh]` to eliminate iOS Safari address bar layout jumping.

---

## 7. Motion & Interaction Philosophy

- **Spring Physics Standard:** `stiffness: 400, damping: 22` for tactile micro-interactions; `stiffness: 120, damping: 20` for page transitions. Linear easings are banned.
- **Perpetual Micro-Interactions:** The Aira Neural Knot emblem maintains an ambient 24-second continuous rotation paired with a soft 3-second breathing pulse on the central nexus node.
- **Hardware Acceleration:** All animations operate exclusively on `transform` and `opacity` properties to prevent expensive DOM reflows and battery consumption.
- **Staggered Entry:** Lists, conversation turns, and card grids enter with 40ms to 60ms staggered delays (`staggerChildren: 0.05`).

---

## 8. Anti-Patterns (Banned AI Tells)

- **Strictly ZERO Emojis** in code, comments, UI text, metadata, or documentation.
- **No Starbursts or Sparkle Star Icons** — replaced with mathematical neural knot geometry.
- **No Neon Purple/Blue AI Glows** — grounded strictly in organic terracotta and graphite neutrals.
- **No Pure Black (`#000000`)** — Charcoal (`#1F1E1D`) and deep graphite exclusively.
- **No Inter Font** — Newsreader, Outfit, and JetBrains Mono exclusively.
- **No Generic AI Marketing Clichés** ("Elevate", "Unleash", "Next-Gen", "Seamlessly", "Tapestry").
- **No Empty Grid Cells** in bento arrangements.
- **No Flat Unstyled Stock Cards** without tactile hover feedback.
- **No Hardcoded `height: 100vh`** — `min-h-[100dvh]` required.

---

## 9. Google Stitch Prompting Recipes

When instructing Google Stitch to generate new screens for Aira AI, adhere to these structural prompt blocks:

### Screen Generation Prompt Template
```
Design an [editorial intelligence screen name] for Aira AI.
- Style: Restrained, scholarly minimalism with warm paper neutrals (#FAF9F5 canvas in light mode, #1F1E1D in dark mode) and a single Terracotta accent (#D97757).
- Typography: Newsreader for display titles (track-tight, text-wrap balance), Outfit for interface body copy, JetBrains Mono for telemetry and code.
- Layout: Asymmetric bento grid with grid-flow-dense, generous vertical spacing (py-16), max-width containment (1200px), and single-column mobile collapse.
- Brand Emblem: The Aira Neural Cognition Knot (interlocking C3 continuous loops forming an upward "A" monogram).
- Component Stylings: 1px whisper borders (rgba(45, 40, 30, 0.08)), rounded-2xl cards with specular hover lighting, tactile pill buttons (active:scale-95), and skeletal loading states.
- Bans: No emojis, no purple/neon glows, no Inter font, no star icons, no pure black #000000.
```

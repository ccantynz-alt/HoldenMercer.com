/**
 * Block library — Layer 3 of the visual builder roadmap.
 *
 * Each block is a small structural pattern the user can drop into a
 * page. The block carries:
 *   • A semantic HTML snippet showing what to build (the agent uses
 *     this as a structural template, not literal copy-paste)
 *   • An aiHint that tells the agent how to integrate it (e.g. "Adapt
 *     to the project's React conventions; use the existing Tailwind
 *     classes; match the site's typography")
 *   • Suggested copy fields the agent should fill from the project brief
 *
 * The agent reads the target project's tech stack via flywheel context
 * (brief + recent code) and adapts the block to match. We never paste
 * raw HTML into a React project; the agent rewrites it as JSX, picks up
 * the project's component patterns, and uses the existing styling system.
 */

export type BlockCategory =
  | 'hero'
  | 'gallery'
  | 'form'
  | 'pricing'
  | 'cta'
  | 'testimonial'
  | 'faq'
  | 'footer'
  | 'feature'

export interface Block {
  id:          string
  name:        string
  category:    BlockCategory
  icon:        string
  description: string
  htmlSnippet: string
  aiHint:      string
}

export const BLOCK_LIBRARY: Block[] = [
  {
    id: 'hero-centered',
    name: 'Centered hero',
    category: 'hero',
    icon: '🎯',
    description: 'Big headline, subhead, two CTA buttons. Centered. The classic landing-page opener.',
    htmlSnippet: `<section class="hero">
  <h1>Headline that nails the value</h1>
  <p>One-sentence subhead that tells them why to care.</p>
  <div class="cta-row">
    <a href="/" class="btn btn-primary">Get started</a>
    <a href="#features" class="btn btn-ghost">See how it works</a>
  </div>
</section>`,
    aiHint: 'Pull headline + subhead language from the project brief. Match the existing CTA button styles. If Tailwind, use the project\'s spacing scale.',
  },

  {
    id: 'feature-grid-3',
    name: 'Feature grid (3 columns)',
    category: 'feature',
    icon: '📋',
    description: 'Three columns of icon + title + body. For "what you get" sections.',
    htmlSnippet: `<section class="features">
  <h2>What you get</h2>
  <div class="feature-grid">
    <article><h3>Feature one</h3><p>Concrete benefit, not jargon.</p></article>
    <article><h3>Feature two</h3><p>Concrete benefit, not jargon.</p></article>
    <article><h3>Feature three</h3><p>Concrete benefit, not jargon.</p></article>
  </div>
</section>`,
    aiHint: 'Generate three feature titles + bodies from the project brief. Concrete benefits, no marketing fluff. Reuse the project\'s existing card / panel component if one exists.',
  },

  {
    id: 'gallery-grid',
    name: 'Image gallery',
    category: 'gallery',
    icon: '🖼',
    description: 'Responsive grid of images. Lightbox on click is optional — start without.',
    htmlSnippet: `<section class="gallery">
  <h2>Gallery</h2>
  <div class="gallery-grid">
    <img src="/img1.jpg" alt="" />
    <img src="/img2.jpg" alt="" />
    <img src="/img3.jpg" alt="" />
    <img src="/img4.jpg" alt="" />
  </div>
</section>`,
    aiHint: 'Use placeholder image URLs (e.g. /placeholder.svg or unsplash.com/random?w=800) until the user adds real images. Add aria-labels and alt text. Make it responsive (CSS grid auto-fit minmax).',
  },

  {
    id: 'contact-form',
    name: 'Contact form',
    category: 'form',
    icon: '✉',
    description: 'Name + email + message + submit. Submits to /api/contact or a Google Form, your call.',
    htmlSnippet: `<section class="contact">
  <h2>Get in touch</h2>
  <form action="/api/contact" method="post">
    <label>Name<input type="text" name="name" required /></label>
    <label>Email<input type="email" name="email" required /></label>
    <label>Message<textarea name="message" rows="5" required></textarea></label>
    <button type="submit" class="btn btn-primary">Send</button>
  </form>
</section>`,
    aiHint: 'Check the project brief for which submit endpoint to use. If unspecified, prefer Google Forms (cheapest, no backend) and add a TODO comment with the form URL slot. Add HTML5 validation, error states for invalid email, and a success state on submit.',
  },

  {
    id: 'pricing-3-tier',
    name: 'Pricing — 3 tiers',
    category: 'pricing',
    icon: '💰',
    description: 'Free / Pro / Enterprise columns. Middle column featured.',
    htmlSnippet: `<section class="pricing">
  <h2>Pricing</h2>
  <div class="pricing-grid">
    <article class="tier"><h3>Free</h3><p class="price">$0</p><ul><li>Feature</li><li>Feature</li></ul><a href="/" class="btn btn-ghost">Start</a></article>
    <article class="tier featured"><h3>Pro</h3><p class="price">$X/mo</p><ul><li>Everything in Free</li><li>Feature</li><li>Feature</li></ul><a href="/" class="btn btn-primary">Upgrade</a></article>
    <article class="tier"><h3>Enterprise</h3><p class="price">Contact</p><ul><li>Everything in Pro</li><li>SLA</li><li>Custom limits</li></ul><a href="/" class="btn btn-ghost">Talk to us</a></article>
  </div>
</section>`,
    aiHint: 'Pull tier names + features from the project brief if mentioned. Default to "Free / Pro / Enterprise" with placeholder prices. Featured tier has a visual emphasis (border, scale, or badge).',
  },

  {
    id: 'faq-accordion',
    name: 'FAQ accordion',
    category: 'faq',
    icon: '❓',
    description: 'Five common questions, click to expand answer. Uses native <details>.',
    htmlSnippet: `<section class="faq">
  <h2>FAQ</h2>
  <details><summary>Question one?</summary><p>Answer.</p></details>
  <details><summary>Question two?</summary><p>Answer.</p></details>
  <details><summary>Question three?</summary><p>Answer.</p></details>
</section>`,
    aiHint: 'Generate 5 questions and answers from the project brief. Cover common objections (price, security, integration, etc). Use native <details>/<summary> — no JS framework needed.',
  },

  {
    id: 'testimonial-row',
    name: 'Testimonials',
    category: 'testimonial',
    icon: '💬',
    description: 'Row of 2–3 quotes with name + role. Social proof.',
    htmlSnippet: `<section class="testimonials">
  <h2>What people are saying</h2>
  <div class="testimonial-row">
    <blockquote><p>"Quote one."</p><cite>— Name, Role</cite></blockquote>
    <blockquote><p>"Quote two."</p><cite>— Name, Role</cite></blockquote>
  </div>
</section>`,
    aiHint: 'Use placeholder quotes with [TODO: real testimonial] markers. Don\'t fabricate real-sounding testimonials. Layout responsive — stack on mobile.',
  },

  {
    id: 'cta-banner',
    name: 'CTA banner',
    category: 'cta',
    icon: '📣',
    description: 'Full-width band with a single message + one button. End-of-page conversion push.',
    htmlSnippet: `<section class="cta-banner">
  <h2>Ready to start?</h2>
  <p>One sentence telling them the next obvious step.</p>
  <a href="/" class="btn btn-primary btn-lg">Get started →</a>
</section>`,
    aiHint: 'Make the headline an action verb + outcome ("Build your site in minutes"). Single CTA — no choice paralysis. Match the primary CTA color from the project\'s existing design system.',
  },

  {
    id: 'footer-minimal',
    name: 'Minimal footer',
    category: 'footer',
    icon: '🦶',
    description: 'Copyright + 3 links + contact email. The standard.',
    htmlSnippet: `<footer class="site-footer">
  <p>© <year /> <site-name />. All rights reserved.</p>
  <nav>
    <a href="/about">About</a>
    <a href="/privacy">Privacy</a>
    <a href="mailto:hello@example.com">Contact</a>
  </nav>
</footer>`,
    aiHint: 'Replace <year /> with a JS-rendered year (so it auto-updates). Pull site name from project brief. If the project has a designated contact email in the brief, use it.',
  },
]

/** Build the dispatch prompt for adding a block. The agent reads the
 *  target project, picks the right file (homepage / specified page),
 *  and adapts the block to the project's tech stack. */
export function addBlockPrompt(repo: string, block: Block, targetHint: string): string {
  return `Visual builder — add a "${block.name}" block to ${repo}.

Block category: ${block.category}
Where to add it: ${targetHint || 'the homepage / main landing page (figure out which file based on the project structure)'}

Reference HTML structure (this is a TEMPLATE — adapt to the project's
tech stack; do NOT paste raw HTML into a React/Vue/etc project):

\`\`\`html
${block.htmlSnippet}
\`\`\`

AI integration hint:
  ${block.aiHint}

DOCTRINE (binding):
  • Branch + PR + gate-protected merge. Never commit to main directly.
  • Read the project FIRST: brief, package.json, top-level structure
    (use list_dir + read_file). Identify the framework (React/Vue/
    Astro/Next/Vite/HTML), the styling system (Tailwind / CSS modules
    / styled-components / vanilla CSS), and the existing component
    patterns. Match those.
  • If the project uses React, write the block as a JSX component
    (extract into its own file under src/components or wherever
    components live). If it's vanilla HTML, embed in the relevant
    HTML file. If it's Astro, write a .astro component. Match style.
  • Use the EXISTING design system. Reuse the project's button class,
    spacing scale, color tokens. Don't introduce new global styles
    unless absolutely necessary.
  • Pull copy from the project brief at .holdenmercer/brief.md when
    available. Otherwise use sensible placeholder text marked with
    [TODO: ...] so the user can find and replace later.
  • Run gatetest_check after the change. If it goes red, fix on the
    same branch and re-check.
  • PR title: "Add ${block.name} block"
  • PR body: explain what was added + which file(s) changed + screenshot
    placeholder (the user previews via the iframe in HM).
  • DO NOT auto-merge. The user reviews + merges.

When done: report_result with one paragraph including:
  • Which file(s) you created/modified
  • What framework/styling conventions you matched
  • The PR URL
  • Any TODOs for the user to fill in (real copy, real images, etc.)`
}

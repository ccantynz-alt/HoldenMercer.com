/**
 * Landing — the public face of holdenmercer.com.
 *
 * Editorial light layout, white / black / champagne gold.
 * The big CTA enters the Sovereign dashboard.
 */

interface LandingProps {
  onEnter: () => void
}

const FEATURES = [
  {
    kicker: 'Voice',
    title:  'Dictation Studio',
    body:   'Real-time streaming transcription. Say "new line," "period," or "stop dictation"  — your words shape themselves on the page. Switch between five writing styles with one click.',
  },
  {
    kicker: 'Refine',
    title:  'AI Grammar & Style',
    body:   'Haiku 4.5 polishes raw dictation into Professional, Casual, Academic, Creative, or Technical prose. Your raw transcript stays — the polish is always reversible.',
  },
  {
    kicker: 'Execute',
    title:  'Command Center',
    body:   'Brainstorm with extended thinking. Switch the Power User toggle to send commands straight to the agentic Opus 4.7 engine, or queue them for the overnight Batch API.',
  },
  {
    kicker: 'Swarm',
    title:  'Task Swarm',
    body:   'Deploy a fleet of coding agents over GitHub via GlueCron — search, plan, edit, PR — all observable from a single dashboard. Native memory in the codebase, not a vector store.',
  },
]

export function Landing({ onEnter }: LandingProps) {
  return (
    <div className="lp-root">
      {/* Top nav */}
      <nav className="lp-nav">
        <div className="lp-nav-brand">Holden&nbsp;Mercer</div>
        <div className="lp-nav-links">
          <a href="#features">Features</a>
          <a href="#stack">Stack</a>
          <a href="#manifesto">Manifesto</a>
          <button className="lp-btn lp-btn-primary" onClick={onEnter}>Enter Dashboard →</button>
        </div>
      </nav>

      {/* Hero */}
      <section className="lp-hero">
        <span className="lp-eyebrow">Sovereign AI · Built by hand · Voice-first</span>
        <h1 className="lp-h1">
          Speak it.<br />
          <em>Refine</em> it. <span className="gold">Ship it.</span>
        </h1>
        <p className="lp-lede">
          A writing surface and command center that listens. Streaming dictation,
          style-aware polish, agentic execution — wired together so a single sentence
          can travel from your voice to a pull request without ever touching a keyboard.
        </p>
        <div className="lp-cta-row">
          <button className="lp-btn lp-btn-primary lp-btn-lg" onClick={onEnter}>
            Enter Dashboard
          </button>
          <a className="lp-btn lp-btn-ghost lp-btn-lg" href="#features">See how it works</a>
        </div>

        <div className="lp-hero-stats">
          <div><strong>nova-2</strong><span>live transcription</span></div>
          <div><strong>Haiku 4.5</strong><span>refine + polish</span></div>
          <div><strong>Opus 4.7</strong><span>agentic execution</span></div>
          <div><strong>Batch API</strong><span>overnight queue</span></div>
        </div>
      </section>

      {/* Rule */}
      <div className="lp-rule" />

      {/* Features */}
      <section className="lp-features" id="features">
        <h2 className="lp-h2">Four surfaces. <em>One mind.</em></h2>
        <div className="lp-feature-grid">
          {FEATURES.map(f => (
            <article key={f.title} className="lp-feature">
              <span className="lp-feature-kicker">{f.kicker}</span>
              <h3 className="lp-feature-title">{f.title}</h3>
              <p className="lp-feature-body">{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* Stack */}
      <section className="lp-stack" id="stack">
        <h2 className="lp-h2">Engineered, not <em>assembled</em>.</h2>
        <ul className="lp-stack-list">
          <li><b>Frontend</b> · React + Vite + WebGL Liquid Orb · 120 fps shader feedback</li>
          <li><b>Voice</b> · Deepgram nova-2 over WebSocket · 300 ms endpointing for instant commits</li>
          <li><b>Refinement</b> · Anthropic Haiku 4.5 with prompt caching · style-aware polish</li>
          <li><b>Execution</b> · Anthropic Opus 4.7 with extended thinking + tool use</li>
          <li><b>Memory</b> · GlueCron — GitHub <em>is</em> the database. Branches are timelines.</li>
          <li><b>Resilience</b> · Bedrock fail-over + Redis-backed Celery queue · zero downtime under load</li>
        </ul>
      </section>

      {/* Manifesto */}
      <section className="lp-manifesto" id="manifesto">
        <h2 className="lp-h2">A note on <em>sovereignty</em>.</h2>
        <p>
          Most "AI products" are thin shells around a chat box. This one is built the other way around —
          the model is a tool inside a workshop you control. Your transcripts live on your disk. Your
          polished drafts live in your repo. The agents you deploy report back to you, not to a SaaS
          dashboard you don't own. That's the line: <em>your words, your work, your machine.</em>
        </p>
        <button className="lp-btn lp-btn-primary lp-btn-lg" onClick={onEnter}>
          Enter the Dashboard →
        </button>
      </section>

      <footer className="lp-footer">
        <span>© {new Date().getFullYear()} Holden Mercer</span>
        <span className="lp-footer-dot">·</span>
        <span>holdenmercer.com</span>
        <span className="lp-footer-dot">·</span>
        <a href="https://github.com/ccantynz-alt" target="_blank" rel="noreferrer">github</a>
      </footer>
    </div>
  )
}

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
    kicker: 'Console',
    title:  'Opus with full tools',
    body:   'Claude Opus 4.7 with file r/w, bash, search, web fetch, and cross-repo read. Paste any URL into the chat — it reads it. Point at any of your other repos — it reads them. Autonomous by default, smart-pauses on architecture and destructive ops.',
  },
  {
    kicker: 'Memory',
    title:  'The repo IS the memory',
    body:   'Every session writes its summary, decisions, and file changes back to the project repo. New sessions resume cold by reading the brief and the timeline. No more "where were we?" — Claude reads itself in.',
  },
  {
    kicker: 'Gate',
    title:  'Programmatic quality gate',
    body:   'Every change runs lint + typecheck + tests before it commits. Failures block the commit. No more silent breakage halfway through a long build.',
  },
  {
    kicker: 'Repair',
    title:  'Self-healing builds',
    body:   'When the gate fails, the Shadow Architect loop kicks in: debug, fix, re-gate — up to 5 iterations. You watch it auto-repair instead of debugging it yourself. Real Claude doesn’t do this. Yours does.',
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
        <span className="lp-eyebrow">An AI website builder console · Sovereign · Built by hand</span>
        <h1 className="lp-h1">
          Brief it.<br />
          <em>Build</em> it. <span className="gold">Ship it.</span>
        </h1>
        <p className="lp-lede">
          A power-user console for running many Claude-driven projects in parallel —
          designed around the things Claude is bad at. Persistent memory across
          sessions, programmatic gates that block broken commits, and self-repairing
          builds that fix themselves instead of waiting for you to debug.
        </p>
        <div className="lp-cta-row">
          <button className="lp-btn lp-btn-primary lp-btn-lg" onClick={onEnter}>
            Enter Console
          </button>
          <a className="lp-btn lp-btn-ghost lp-btn-lg" href="#features">See how it works</a>
        </div>

        <div className="lp-hero-stats">
          <div><strong>Opus 4.7</strong><span>full tool use</span></div>
          <div><strong>GlueCron</strong><span>GitHub is memory</span></div>
          <div><strong>Gate</strong><span>lint / type / test</span></div>
          <div><strong>Repair</strong><span>auto-fix on fail</span></div>
        </div>
      </section>

      {/* Rule */}
      <div className="lp-rule" />

      {/* Features */}
      <section className="lp-features" id="features">
        <h2 className="lp-h2">Built for the long build.</h2>
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
          <li><b>Brains</b> · Anthropic Opus 4.7 with extended thinking + full tool use (file r/w, bash, search, web fetch, cross-repo read)</li>
          <li><b>Memory</b> · GlueCron — GitHub <em>is</em> the database. Sessions write summaries back to the repo. New sessions resume by reading them.</li>
          <li><b>Gate</b> · Programmatic checks (lint + typecheck + tests) on every change. No green, no commit.</li>
          <li><b>Repair</b> · Shadow Architect loop · auto-debug on failure, up to 5 iterations</li>
          <li><b>Resilience</b> · Bedrock fail-over · zero downtime when Anthropic is overloaded</li>
          <li><b>Input</b> · Native OS dictation. iPad, Mac, Windows — your device's mic, not our STT.</li>
        </ul>
      </section>

      {/* Manifesto */}
      <section className="lp-manifesto" id="manifesto">
        <h2 className="lp-h2">A note on <em>sovereignty</em>.</h2>
        <p>
          Most "AI builders" are thin shells around a chat box that forgets what you
          told it last week. This one is built the other way around — Claude is a
          tool inside a workshop you control. Your projects live in your GitHub.
          Your decisions are committed to a branch with a timestamp. Your API key
          stays in your browser. Nothing reports back to a SaaS dashboard you
          don't own. That's the line: <em>your work, your repo, your machine.</em>
        </p>
        <button className="lp-btn lp-btn-primary lp-btn-lg" onClick={onEnter}>
          Enter the Console →
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


'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const features = [
  {
    icon: '↥',
    number: '01',
    title: 'Bulk video upload',
    description:
      'Bring your Reel videos into one organised workspace and prepare content for publishing.',
  },
  {
    icon: '◷',
    number: '02',
    title: 'Plan your schedule',
    description:
      'Organise upcoming Reels and set publishing dates and times in advance.',
  },
  {
    icon: '▷',
    number: '03',
    title: 'Automated publishing',
    description:
      'ReelQueue processes scheduled publishing jobs through the official Instagram API.',
  },
  {
    icon: '▤',
    number: '04',
    title: 'Manage your queue',
    description:
      'Keep track of upcoming content and check the latest status from your dashboard.',
  },
];

const steps = [
  {
    number: '01',
    title: 'Upload',
    description: 'Add the videos you want to publish to your ReelQueue workspace.',
  },
  {
    number: '02',
    title: 'Schedule',
    description: 'Choose dates and times, then organise your upcoming publishing queue.',
  },
  {
    number: '03',
    title: 'Track',
    description:
      'ReelQueue processes scheduled jobs. Check your dashboard for the latest status.',
  },
];

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const saved = localStorage.getItem('theme');
    const isDark =
      saved === 'dark' ||
      (!saved && root.classList.contains('dark'));

    root.classList.toggle('dark', isDark);
    setDark(isDark);
    setReady(true);
  }, []);

  function toggleTheme() {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
    setDark(next);
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={ready ? `Switch to ${dark ? 'light' : 'dark'} mode` : 'Toggle theme'}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="rq-theme-toggle"
    >
      {dark ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" />
        </svg>
      )}
    </button>
  );
}

function Logo() {
  return (
    <Link href="/" className="rq-brand" aria-label="ReelQueue homepage">
      <span className="rq-brand-icon" aria-hidden="true">
        <svg viewBox="0 0 40 40">
          <rect x="1" y="1" width="38" height="38" rx="12" />
          <path d="M9 10h22v5H9z" className="rq-clapper" />
          <path d="m12 10 4 5m4-5 4 5m4-5 3 5" className="rq-stripes" />
          <path d="M10 19h20v11H10z" className="rq-film" />
          <path d="m17 21 8 4-8 4z" className="rq-play" />
        </svg>
      </span>
      <span>
        Reel<span className="rq-brand-accent">Queue</span>
      </span>
    </Link>
  );
}

export default function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <main className="rq-site min-h-screen bg-bg text-ink">
      <header className="rq-header sticky top-0 z-50 border-b border-ink/10">
        <div className="rq-container rq-header-inner">
          <Logo />

          <nav className="rq-desktop-nav" aria-label="Main navigation">
            <a href="#features">Features</a>
            <a href="#how-it-works">How it works</a>
            <a href="#early-access">Early access</a>
            <a href="#pricing">Pricing</a>
          </nav>

          <div className="rq-header-actions">
            <ThemeToggle />
            <Link href="/login" className="rq-login-link">
              Log in
            </Link>
            <Link href="/register" className="rq-button rq-nav-cta">
              Start free
            </Link>
            <button
              type="button"
              className="rq-menu-toggle"
              aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span />
              <span />
              <span />
            </button>
          </div>
        </div>

        {menuOpen && (
          <nav className="rq-mobile-nav" aria-label="Mobile navigation">
            <a href="#features" onClick={() => setMenuOpen(false)}>Features</a>
            <a href="#how-it-works" onClick={() => setMenuOpen(false)}>How it works</a>
            <a href="#early-access" onClick={() => setMenuOpen(false)}>Early access</a>
            <a href="#pricing" onClick={() => setMenuOpen(false)}>Pricing</a>
            <Link href="/login" onClick={() => setMenuOpen(false)}>Log in</Link>
            <Link href="/register" onClick={() => setMenuOpen(false)}>Start your free trial</Link>
          </nav>
        )}
      </header>

      <section className="rq-hero">
        <div className="rq-hero-glow" aria-hidden="true" />
        <div className="rq-container rq-hero-grid">
          <div className="rq-hero-copy rq-reveal">
            <div className="rq-eyebrow-pill">
              <span className="rq-dot" />
              A simpler Reels workflow
            </div>

            <h1>
              Create more.
              <span className="rq-gradient-text"> Manage less.</span>
            </h1>

            <p className="rq-hero-description">
              Organise your Instagram Reels, plan your publishing schedule and
              manage your content queue from one workspace with ReelQueue.
            </p>

            <div className="rq-hero-actions">
              <Link href="/register" className="rq-button rq-primary-cta">
                Start your 7-day free trial <span aria-hidden="true">→</span>
              </Link>
              <a href="#how-it-works" className="rq-outline-button">
                Explore how it works
              </a>
            </div>

            <p className="rq-microcopy">
              Free for 7 days for new users · Weekly plan after trial
            </p>

            <div className="rq-trust-points">
              <span><b>✓</b> Plan your content</span>
              <span><b>✓</b> Organise your queue</span>
              <span><b>✓</b> Track job status</span>
            </div>
          </div>

          <div className="rq-hero-visual rq-reveal rq-reveal-later">
            <div className="rq-preview">
              <div className="rq-preview-header">
                <div>
                  <span className="rq-small-label">YOUR WORKSPACE</span>
                  <h2>Content overview</h2>
                </div>
                <span className="rq-preview-chip">Preview</span>
              </div>

              <div className="rq-preview-stats">
                <div><span>In queue</span><strong>08</strong></div>
                <div><span>Scheduled</span><strong>05</strong></div>
                <div><span>Published</span><strong>12</strong></div>
              </div>

              <div className="rq-preview-subhead">
                <h3>Upcoming Reels</h3>
                <span>Example data</span>
              </div>

              <div className="rq-preview-post">
                <div className="rq-video-thumb rq-thumb-a"><span>▶</span></div>
                <div className="rq-post-copy">
                  <strong>Behind the scenes</strong>
                  <span>Scheduled content</span>
                </div>
                <span className="rq-queue-label">Queued</span>
              </div>

              <div className="rq-preview-post">
                <div className="rq-video-thumb rq-thumb-b"><span>▶</span></div>
                <div className="rq-post-copy">
                  <strong>Three quick tips</strong>
                  <span>Scheduled content</span>
                </div>
                <span className="rq-queue-label">Queued</span>
              </div>

              <div className="rq-preview-post">
                <div className="rq-video-thumb rq-thumb-c"><span>▶</span></div>
                <div className="rq-post-copy">
                  <strong>Your next idea</strong>
                  <span>Scheduled content</span>
                </div>
                <span className="rq-queue-label">Queued</span>
              </div>

              <div className="rq-preview-footer">
                <span className="rq-dot" />
                Upload <span>→</span> Schedule <span>→</span> Publish
              </div>
              <p className="rq-preview-disclaimer">
                Illustrative preview, not live account statistics.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="early-access" className="rq-container rq-early-wrap">
        <div className="rq-early-card">
          <div className="rq-early-icon" aria-hidden="true">✦</div>
          <div>
            <div className="rq-early-heading">
              <span className="rq-dot" />
              Early access · Product in progress
            </div>
            <h2>We’re improving the publishing experience.</h2>
            <p>
              ReelQueue is in its initial launch phase. Publishing jobs may
              continue processing in the background, but timing and completion
              are not guaranteed yet. For now, keep your ReelQueue dashboard
              open when possible and refresh or revisit it occasionally to
              check the latest status. We’re aiming to improve this experience
              over the coming month and will share updates as improvements become available.
            </p>
          </div>
        </div>
      </section>

      <section id="features" className="rq-section rq-container">
        <div className="rq-section-heading">
          <span className="rq-section-kicker">THE REELQUEUE WORKFLOW</span>
          <h2>Everything organised.<br /><span className="rq-gradient-text">One content queue.</span></h2>
          <p>
            Keep your publishing workflow structured, from preparing videos to
            checking the status of scheduled jobs.
          </p>
        </div>

        <div className="rq-feature-grid">
          {features.map((feature, index) => (
            <article
              key={feature.number}
              className="rq-feature-card"
              style={{ '--rq-delay': `${index * 90}ms` } as React.CSSProperties}
            >
              <div className="rq-feature-top">
                <span className="rq-feature-icon">{feature.icon}</span>
                <span className="rq-feature-number">{feature.number}</span>
              </div>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="how-it-works" className="rq-how-section">
        <div className="rq-container rq-how-grid">
          <div className="rq-how-copy">
            <span className="rq-section-kicker">GET STARTED IN THREE STEPS</span>
            <h2>From video to a <span className="rq-gradient-text">planned workflow.</span></h2>
            <p>
              ReelQueue brings the key steps of your Reels publishing workflow
              together so it’s easier to organise what comes next.
            </p>
            <Link href="/register" className="rq-button rq-primary-cta">
              Try ReelQueue free <span aria-hidden="true">→</span>
            </Link>
          </div>

          <div className="rq-steps">
            {steps.map((step) => (
              <article className="rq-step" key={step.number}>
                <span className="rq-step-number">{step.number}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="rq-section rq-container">
        <div className="rq-section-heading">
          <span className="rq-section-kicker">SIMPLE WEEKLY PRICING</span>
          <h2>Start free.<br /><span className="rq-gradient-text">Choose when you’re ready.</span></h2>
          <p>
            Explore ReelQueue with a 7-day trial. An active paid subscription
            is required to continue after the trial ends.
          </p>
        </div>

        <div className="rq-pricing-grid">
          <article className="rq-price-card">
            <span className="rq-price-label">FOR NEW USERS</span>
            <h3>Free trial</h3>
            <div className="rq-price-amount">₹0 <span>/ 7 days</span></div>
            <p className="rq-price-description">
              Get familiar with the workflow before deciding whether to continue.
            </p>
            <ul>
              <li>7-day trial for new accounts</li>
              <li>Explore the available features</li>
              <li>Review your content workflow</li>
            </ul>
            <Link href="/register" className="rq-outline-button rq-price-button">
              Start free trial
            </Link>
          </article>

          <article className="rq-price-card rq-price-card-highlight">
            <span className="rq-price-label rq-price-label-hot">WEEKLY SUBSCRIPTION</span>
            <h3>ReelQueue Pro</h3>
            <div className="rq-price-amount">₹1,000 <span>/ week</span></div>
            <div className="rq-price-usd">$14.99 <span>/ week</span></div>
            <p className="rq-price-description">
              Continue using ReelQueue with a paid weekly subscription after your trial.
            </p>
            <ul>
              <li>Access while your subscription is active</li>
              <li>Organise and schedule Reels</li>
              <li>Track your publishing queue</li>
            </ul>
            <Link href="/register" className="rq-button rq-price-button">
              Start your 7-day trial
            </Link>
            <p className="rq-price-footnote">
              Publishing remains subject to Instagram API eligibility and current product limitations.
            </p>
          </article>
        </div>

        <p className="rq-pricing-disclaimer">
          Prices are shown in INR and USD for reference. Applicable taxes,
          billing currency, renewal and cancellation terms must be confirmed
          at checkout. Automatic renewal or payment collection should only be
          represented if your checkout explicitly supports it.
        </p>
      </section>

      <section className="rq-container rq-final-cta">
        <span className="rq-section-kicker">YOUR CONTENT, MORE ORGANISED</span>
        <h2>Make space for <span className="rq-gradient-text">more creating.</span></h2>
        <p>Start your 7-day trial and explore a simpler way to manage your Reels.</p>
        <Link href="/register" className="rq-button rq-primary-cta">
          Create your account <span aria-hidden="true">→</span>
        </Link>
      </section>

      <footer className="rq-footer">
        <div className="rq-container rq-footer-inner">
          <div className="rq-footer-brand">
            <Logo />
            <p>Plan your content. Organise your queue. Keep creating.</p>
          </div>
          <nav aria-label="Footer navigation">
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/terms">Terms of Service</Link>
            <Link href="/contact">Contact</Link>
            <Link href="/login">Log in</Link>
          </nav>
          <p className="rq-copyright">
            © {new Date().getFullYear()} ReelQueue. All rights reserved.
          </p>
        </div>
      </footer>
    </main>
  );
}

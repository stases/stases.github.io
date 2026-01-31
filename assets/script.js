/*
  Time Machines - interaction
  - Click oval to invert colors
  - Links become visible immediately, but only clickable after transition completes
*/

(() => {
  const body = document.body;
  if (!body) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const readHomeStateFromHash = () => {
    const hash = window.location.hash.toLowerCase();
    if (hash === '#open' || hash === '#active') return 'active';
    if (hash === '#closed' || hash === '#rest') return 'rest';
    return null;
  };

  const hashForState = (state) => (state === 'active' ? '#open' : '#closed');

  const setupPageTheme = () => {
    const toggle = document.querySelector('[data-theme-toggle]');
    if (!toggle) return;

    const setTheme = (theme) => {
      body.dataset.theme = theme;
      toggle.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
      toggle.setAttribute(
        'aria-label',
        theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'
      );
    };

    const initial = body.dataset.theme === 'light' ? 'light' : 'dark';
    setTheme(initial);

    toggle.addEventListener('click', () => {
      const next = body.dataset.theme === 'light' ? 'dark' : 'light';
      setTheme(next);
    });
  };

  const setupHomeMonolith = () => {
    const monolith = document.getElementById('monolith');
    if (!monolith) return;

    const links = Array.from(document.querySelectorAll('.monolith__links a'));
    const linksContainer = document.querySelector('.monolith__links');

    const syncNavLinks = (active) => {
      const hash = hashForState(active ? 'active' : 'rest');
      for (const link of links) {
        const raw = link.getAttribute('href') || '';
        const base = raw.split('#')[0];
        link.setAttribute('href', `${base}${hash}`);
      }
    };

    const syncUrlHash = (active) => {
      const nextHash = hashForState(active ? 'active' : 'rest');
      if (window.location.hash === nextHash) return;

      if (history.replaceState) {
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
      } else {
        window.location.hash = nextHash;
      }
    };

    const getTransitionMs = () => {
      // Keep this in sync with --transition-ms in CSS
      return reduceMotion ? 0 : 650;
    };

    const getEnableDelayMs = () => {
      return Math.round(getTransitionMs() * 0.35);
    };

    let busy = false;
    let enableTimer = null;

    const measureCustomPropertyPx = (name) => {
      const probe = document.createElement('div');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.paddingLeft = `var(${name})`;
      document.body.appendChild(probe);
      const value = parseFloat(getComputedStyle(probe).paddingLeft);
      probe.remove();
      return Number.isFinite(value) ? value : 0;
    };

    const getNavGap = () => {
      return measureCustomPropertyPx('--nav-gap');
    };

    const computeRowWidths = () => {
      if (!monolith || links.length === 0) return;

      const rect = monolith.getBoundingClientRect();
      const a = rect.width / 2;
      const b = rect.height / 2;
      const centerY = rect.top + b;
      const gap = getNavGap();

      for (const link of links) {
        const r = link.getBoundingClientRect();
        const linkCenterY = r.top + r.height / 2;
        const y = linkCenterY - centerY;
        const ratio = 1 - (y * y) / (b * b);
        const span = ratio > 0 ? 2 * a * Math.sqrt(ratio) : 0;
        const target = Math.max(0, span - 2 * gap);

        link.style.maxWidth = `${target}px`;
        link.style.paddingInline = `${gap}px`;
        link.style.marginInline = 'auto';
      }
    };

    const setLinksEnabled = (enabled) => {
      body.dataset.links = enabled ? 'enabled' : 'disabled';

      // Accessibility: prevent tabbing into hidden links
      for (const a of links) {
        if (enabled) {
          a.removeAttribute('tabindex');
        } else {
          a.setAttribute('tabindex', '-1');
        }
      }

      if (linksContainer) {
        linksContainer.setAttribute('aria-hidden', enabled ? 'false' : 'true');
      }
    };

    const setActive = (active, updateUrl = true) => {
      body.dataset.state = active ? 'active' : 'rest';
      monolith.setAttribute('aria-pressed', active ? 'true' : 'false');

      syncNavLinks(active);

      if (updateUrl) {
        syncUrlHash(active);
      }
    };

    const activate = () => {
      if (busy) return;
      busy = true;

      clearTimeout(enableTimer);
      setLinksEnabled(false);
      setActive(true);

      enableTimer = window.setTimeout(() => {
        setLinksEnabled(true);
        busy = false;
      }, getEnableDelayMs());
    };

    const deactivate = () => {
      if (busy) return;
      busy = true;

      clearTimeout(enableTimer);
      setLinksEnabled(false);
      setActive(false);

      enableTimer = window.setTimeout(() => {
        // stay disabled; just unlock interactions again
        busy = false;
      }, getEnableDelayMs());
    };

    const toggle = () => {
      const isActive = body.dataset.state === 'active';
      if (isActive) deactivate();
      else activate();
    };

    // Start safe: links not focusable/clickable.
    const hashState = readHomeStateFromHash();
    const startActive = hashState === 'active';

    setActive(startActive, false);
    setLinksEnabled(startActive);
    computeRowWidths();

    monolith.addEventListener('click', () => {
      toggle();
    });

    monolith.addEventListener('keydown', (e) => {
      // Allow keyboard activation like a real button
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });

    // Prevent the monolith toggle when a link is clicked.
    for (const a of links) {
      a.addEventListener('click', (e) => {
        e.stopPropagation();

        // Hard guard: if links aren't enabled, don't navigate.
        if (body.dataset.links !== 'enabled') {
          e.preventDefault();
        }
      });
    }

    window.addEventListener('resize', computeRowWidths);
    window.addEventListener('load', computeRowWidths);
  };

  if (body.classList.contains('page')) {
    setupPageTheme();
  }

  // Mirror the current page hash into Home links for simple state carryover.
  const annotateHomeLinks = () => {
    const homeLinks = Array.from(
      document.querySelectorAll('a[href="index.html"], a[href="index.html#open"], a[href="index.html#closed"]')
    );
    if (!homeLinks.length) return;

    const apply = () => {
      const state = readHomeStateFromHash();
      if (!state) return;
      const target = `index.html${hashForState(state)}`;
      for (const link of homeLinks) {
        link.setAttribute('href', target);
      }
    };

    apply();
    window.addEventListener('hashchange', apply);
  };

  annotateHomeLinks();

  if (body.classList.contains('home')) {
    setupHomeMonolith();
  }
})();

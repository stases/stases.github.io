/*
  Time Machines - interaction
  - Persistent animated backdrop
  - Client-side transitions between home and subpages
  - Inner pages: theme toggle
*/

(() => {
  const body = document.body;
  const routeHost = document.querySelector("[data-route-host]");
  const parser = new DOMParser();
  const routeCache = new Map();
  let isNavigating = false;

  if (!body || !routeHost) return;

  const MOTION_SCENE = [
    {
      kind: "panel",
      left: "8%",
      top: "10%",
      width: "24%",
      height: "26%",
      opacity: "0.52",
      borderRadius: "0px",
      gradient:
        "linear-gradient(180deg, rgba(16, 44, 255, 0.98) 0%, rgba(44, 70, 255, 0.92) 56%, rgba(246, 164, 240, 0.84) 100%)",
      driftFrom: "-48px",
      driftTo: "22px",
      duration: "27s",
      delay: "-7s",
    },
    {
      kind: "panel",
      left: "16%",
      top: "33%",
      width: "10.5%",
      height: "22%",
      opacity: "0.46",
      borderRadius: "0px",
      gradient:
        "linear-gradient(180deg, rgba(14, 46, 255, 0.96) 0%, rgba(72, 94, 255, 0.82) 60%, rgba(214, 155, 244, 0.7) 100%)",
      driftFrom: "16px",
      driftTo: "58px",
      duration: "18s",
      delay: "-3s",
    },
    {
      kind: "glow",
      left: "8%",
      top: "48%",
      width: "26%",
      height: "30%",
      opacity: "0.92",
      filter: "blur(12px)",
      gradient:
        "radial-gradient(circle at center, rgba(253, 248, 255, 0.74) 0%, rgba(242, 177, 245, 0.7) 24%, rgba(66, 82, 255, 0.58) 53%, rgba(16, 18, 38, 0.2) 76%, rgba(0, 0, 0, 0) 100%)",
      driftFrom: "-30px",
      driftTo: "54px",
      duration: "24s",
      delay: "-11s",
    },
    {
      kind: "glow",
      left: "24%",
      top: "14%",
      width: "18%",
      height: "20%",
      opacity: "0.5",
      filter: "blur(18px)",
      gradient:
        "radial-gradient(circle at center, rgba(255, 224, 246, 0.5) 0%, rgba(176, 126, 255, 0.42) 38%, rgba(26, 36, 109, 0) 100%)",
      driftFrom: "20px",
      driftTo: "-10px",
      duration: "31s",
      delay: "-5s",
    },
    {
      kind: "panel",
      left: "46%",
      top: "24%",
      width: "14%",
      height: "18%",
      opacity: "0.46",
      borderRadius: "0px",
      gradient:
        "linear-gradient(180deg, rgba(38, 60, 255, 0.92) 0%, rgba(126, 96, 255, 0.72) 62%, rgba(242, 165, 238, 0.66) 100%)",
      driftFrom: "-24px",
      driftTo: "36px",
      duration: "20s",
      delay: "-9s",
    },
    {
      kind: "glow",
      left: "38%",
      top: "18%",
      width: "32%",
      height: "42%",
      opacity: "0.68",
      filter: "blur(20px)",
      gradient:
        "radial-gradient(circle at 56% 44%, rgba(250, 236, 252, 0.56) 0%, rgba(231, 154, 242, 0.44) 22%, rgba(74, 88, 255, 0.38) 54%, rgba(10, 10, 26, 0.08) 78%, rgba(0, 0, 0, 0) 100%)",
      driftFrom: "30px",
      driftTo: "-26px",
      duration: "33s",
      delay: "-8s",
    },
    {
      kind: "panel",
      left: "57%",
      top: "22%",
      width: "11%",
      height: "28%",
      opacity: "0.42",
      borderRadius: "0px",
      gradient:
        "linear-gradient(180deg, rgba(92, 100, 255, 0.78) 0%, rgba(184, 150, 246, 0.62) 55%, rgba(252, 230, 247, 0.5) 100%)",
      driftFrom: "-14px",
      driftTo: "28px",
      duration: "23s",
      delay: "-12s",
    },
    {
      kind: "panel",
      left: "61%",
      top: "14%",
      width: "12.5%",
      height: "17%",
      opacity: "0.62",
      borderRadius: "0px",
      gradient:
        "linear-gradient(180deg, rgba(241, 184, 234, 0.92) 0%, rgba(250, 228, 247, 0.84) 66%, rgba(255, 249, 254, 0.64) 100%)",
      driftFrom: "18px",
      driftTo: "-14px",
      duration: "19s",
      delay: "-2s",
    },
    {
      kind: "glow",
      left: "44%",
      top: "42%",
      width: "25%",
      height: "34%",
      opacity: "0.84",
      filter: "blur(16px)",
      gradient:
        "radial-gradient(circle at center, rgba(252, 247, 255, 0.58) 0%, rgba(239, 184, 241, 0.52) 20%, rgba(72, 84, 255, 0.42) 55%, rgba(6, 6, 18, 0.08) 82%, rgba(0, 0, 0, 0) 100%)",
      driftFrom: "-22px",
      driftTo: "42px",
      duration: "21s",
      delay: "-10s",
    },
    {
      kind: "panel",
      left: "56%",
      top: "69%",
      width: "11%",
      height: "20%",
      opacity: "0.44",
      borderRadius: "0px",
      gradient:
        "linear-gradient(180deg, rgba(232, 164, 234, 0.82) 0%, rgba(182, 152, 240, 0.5) 58%, rgba(32, 60, 255, 0.62) 100%)",
      driftFrom: "28px",
      driftTo: "-18px",
      duration: "22s",
      delay: "-4s",
    },
    {
      kind: "panel",
      left: "64%",
      top: "72%",
      width: "12%",
      height: "10%",
      opacity: "0.68",
      borderRadius: "0px",
      gradient:
        "linear-gradient(90deg, rgba(246, 226, 248, 0.82) 0%, rgba(255, 250, 254, 0.84) 54%, rgba(239, 165, 236, 0.78) 100%)",
      driftFrom: "-32px",
      driftTo: "20px",
      duration: "17s",
      delay: "-14s",
    },
    {
      kind: "glow",
      left: "78%",
      top: "47%",
      width: "14%",
      height: "12%",
      opacity: "0.72",
      filter: "blur(14px)",
      gradient:
        "radial-gradient(circle at center, rgba(252, 243, 255, 0.3) 0%, rgba(112, 104, 255, 0.42) 38%, rgba(12, 14, 28, 0.02) 72%, rgba(0, 0, 0, 0) 100%)",
      driftFrom: "22px",
      driftTo: "-18px",
      duration: "28s",
      delay: "-6s",
    },
    {
      kind: "glow",
      left: "17%",
      top: "40%",
      width: "18%",
      height: "22%",
      opacity: "0.34",
      filter: "blur(18px)",
      gradient:
        "radial-gradient(circle at center, rgba(255, 244, 255, 0.24) 0%, rgba(162, 134, 243, 0.28) 36%, rgba(10, 10, 28, 0) 100%)",
      driftFrom: "38px",
      driftTo: "-8px",
      duration: "30s",
      delay: "-13s",
    },
  ];

  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const homeRoute = () => new URL("index.html", window.location.href).href;
  const createRouteView = (html, stateClass = "") => {
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const view = template.content.firstElementChild;

    if (!view) return null;
    if (stateClass) view.classList.add(stateClass);

    return view;
  };

  const normalizePath = (value) => {
    const url = new URL(value, window.location.href);
    let path = url.pathname;

    if (path === "/") path = "/index.html";
    if (path.endsWith("/")) path += "index.html";

    return `${path}${url.search}`;
  };

  const isInternalHtmlRoute = (url) => {
    if (url.origin !== window.location.origin) return false;
    return url.pathname.endsWith(".html") || url.pathname === "/" || url.pathname.endsWith("/");
  };

  const setupPageTheme = (root = document) => {
    const toggle = root.querySelector("[data-theme-toggle]");
    if (!toggle || toggle.dataset.themeReady === "true") return;

    const setTheme = (theme) => {
      body.dataset.theme = theme;
      toggle.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
      toggle.setAttribute(
        "aria-label",
        theme === "light" ? "Switch to dark theme" : "Switch to light theme"
      );
    };

    toggle.dataset.themeReady = "true";
    setTheme(body.dataset.theme === "light" ? "light" : "dark");

    toggle.addEventListener("click", () => {
      const next = body.dataset.theme === "light" ? "dark" : "light";
      setTheme(next);
    });
  };

  const setupBackdropMotion = () => {
    const container = document.getElementById("homeMotion");
    if (!container || container.childElementCount > 0) return;

    for (const item of MOTION_SCENE) {
      const element = document.createElement("span");
      element.className = `home-motion__item home-motion__item--${item.kind}`;
      element.style.left = item.left;
      element.style.top = item.top;
      element.style.width = item.width;
      element.style.height = item.height;
      element.style.opacity = item.opacity;
      element.style.background = item.gradient;
      element.style.setProperty("--drift-from", item.driftFrom);
      element.style.setProperty("--drift-to", item.driftTo);
      element.style.setProperty("--drift-duration", item.duration);
      element.style.setProperty("--drift-delay", item.delay);

      if (item.borderRadius) {
        element.style.borderRadius = item.borderRadius;
      }

      if (item.filter) {
        element.style.filter = item.filter;
      }

      container.appendChild(element);
    }
  };

  const readRoute = (doc) => {
    const view = doc.querySelector("[data-route-view]");
    if (!view) return null;

    return {
      html: view.outerHTML,
      kind: doc.body.classList.contains("page") ? "page" : "home",
      theme: doc.body.dataset.theme || "",
      title: doc.title || document.title,
      lang: doc.documentElement.lang || document.documentElement.lang,
    };
  };

  const fetchRoute = async (url) => {
    const key = normalizePath(url);
    if (routeCache.has(key)) return routeCache.get(key);

    const response = await window.fetch(url, {
      headers: {
        "X-Requested-With": "site-router",
      },
    });

    if (!response.ok) {
      throw new Error(`Navigation failed: ${response.status}`);
    }

    const html = await response.text();
    const doc = parser.parseFromString(html, "text/html");
    const route = readRoute(doc);
    if (!route) {
      throw new Error("Missing route view");
    }

    routeCache.set(key, route);
    return route;
  };

  const applyRouteState = (route, themeOverride = "") => {
    body.classList.toggle("home", route.kind === "home");
    body.classList.toggle("page", route.kind === "page");

    if (route.kind === "page") {
      body.dataset.theme = themeOverride || route.theme || "dark";
    } else {
      body.removeAttribute("data-theme");
    }

    document.title = route.title;
    document.documentElement.lang = route.lang;
  };

  const swapRoute = async (url, { pushState = true } = {}) => {
    if (isNavigating) return;

    const targetUrl = new URL(url, window.location.href);
    const currentUrl = new URL(window.location.href);

    if (normalizePath(targetUrl.href) === normalizePath(currentUrl.href) && targetUrl.hash === currentUrl.hash) {
      return;
    }

    let route;
    try {
      route = await fetchRoute(targetUrl.href);
    } catch (error) {
      window.location.href = targetUrl.href;
      return;
    }

    isNavigating = true;
    body.classList.add("is-routing");

    const currentView = routeHost.querySelector("[data-route-view]");
    const previousTheme = body.classList.contains("page") ? body.dataset.theme || "dark" : "";
    const nextTheme = route.kind === "page" ? previousTheme || route.theme || "dark" : "";
    const lockedHeight = currentView ? currentView.getBoundingClientRect().height : 0;

    if (lockedHeight > 0) {
      routeHost.style.minHeight = `${Math.ceil(lockedHeight)}px`;
      currentView.classList.add("is-exiting");
      await wait(180);
    }

    const incomingView = createRouteView(route.html, "is-entering");
    applyRouteState(route, nextTheme);
    routeHost.replaceChildren();
    if (incomingView) {
      routeHost.appendChild(incomingView);
    }
    if (pushState) {
      window.history.pushState({ path: targetUrl.pathname }, "", targetUrl.href);
    }

    window.scrollTo(0, 0);

    setupPageTheme(routeHost);
    setupBackdropMotion();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        incomingView?.classList.remove("is-entering");
      });
    });

    await wait(560);
    routeHost.style.minHeight = "";
    body.classList.remove("is-routing");
    isNavigating = false;
  };

  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const link = event.target.closest("a[href]");
    if (!link) return;
    if (link.target && link.target !== "_self") return;
    if (link.hasAttribute("download")) return;

    const targetUrl = new URL(link.href, window.location.href);
    if (!isInternalHtmlRoute(targetUrl)) return;

    event.preventDefault();
    swapRoute(targetUrl.href);
  });

  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !body.classList.contains("page")
    ) {
      return;
    }

    if (event.target.closest(".page-wrap")) return;

    event.preventDefault();
    swapRoute(homeRoute());
  });

  window.addEventListener("popstate", () => {
    swapRoute(window.location.href, { pushState: false });
  });

  setupBackdropMotion();
  setupPageTheme(routeHost);
})();

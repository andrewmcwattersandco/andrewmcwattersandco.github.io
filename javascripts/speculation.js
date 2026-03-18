(function () {
  "use strict";

  // Speculation rules
  if ("chrome" in window && HTMLScriptElement.supports?.("speculationrules")) {
    const script = document.createElement("script");
    script.type = "speculationrules";
    script.textContent = JSON.stringify({
      prerender: [
        {
          source: "document",
          where: {
            and: [
              { selector_matches: "a[href]" },
              {
                not: {
                  selector_matches:
                    "a[download], a[data-no-speculate], a[target]",
                },
              },
            ],
          },
          eagerness: "immediate",
        },
      ],
    });
    document.head.appendChild(script);
    return;
  }

  // Fetch-swap
  history.scrollRestoration = "manual";

  const cache = new Map();
  let currentUrl = location.href;
  let preloadController = null;
  let currentFetchUrl = null;
  let navId = 0;
  const saveData = navigator.connection?.saveData ?? false;

  function parseCacheControl(header) {
    if (!header) return 60;
    if (/no-store|no-cache/.test(header)) return 0;
    const maxAge = header.match(/max-age=(\d+)/);
    return maxAge ? parseInt(maxAge[1], 10) : 60;
  }

  async function fetchPage(url) {
    const now = Date.now();
    const cached = cache.get(url);

    if (cached && now < cached.expires) {
      const revalId = Symbol();
      cached.revalId = revalId;
      fetch(url, { credentials: "same-origin" })
        .then(async (response) => {
          if (!response.ok) return;
          const contentType = response.headers.get("Content-Type");
          if (!contentType?.startsWith("text/html")) return;
          const ttl = parseCacheControl(response.headers.get("Cache-Control"));
          if (ttl === 0) {
            cache.delete(url);
            cache.delete(response.url);
            return;
          }
          const html = await response.text();
          const current = cache.get(url) ?? cache.get(response.url);
          if (current?.revalId !== revalId) return;
          const entry = {
            html,
            url: response.url,
            expires: Date.now() + ttl * 1000,
          };
          cache.set(url, entry);
          if (response.url !== url) cache.set(response.url, entry);
        })
        .catch(() => {});
      return cached;
    }

    if (preloadController && url !== currentFetchUrl) preloadController.abort();
    preloadController = new AbortController();
    currentFetchUrl = url;

    let response;
    try {
      response = await fetch(url, {
        credentials: "same-origin",
        signal: preloadController.signal,
      });
    } catch {
      return null;
    }

    if (!response.ok) return null;

    const contentType = response.headers.get("Content-Type");
    if (!contentType?.startsWith("text/html")) return null;

    const ttl = parseCacheControl(response.headers.get("Cache-Control"));
    const html = await response.text();

    const entry = { html, url: response.url, expires: now + ttl * 1000 };
    if (ttl > 0) {
      cache.set(url, entry);
      if (response.url !== url) cache.set(response.url, entry);
    }

    return entry;
  }

  function fingerprint(el) {
    switch (el.tagName) {
      case "META":
        return `meta:${el.name || el.property || el.httpEquiv}:${el.content}`;
      case "LINK":
        return `link:${el.rel}:${el.getAttribute("href")}`;
      case "SCRIPT":
        return `script:${el.getAttribute("src") || el.textContent}`;
      case "BASE":
        return `base:${el.getAttribute("href")}`;
      case "STYLE":
        return `style:${el.textContent}`;
      default:
        return el.outerHTML;
    }
  }

  function patchHead(incomingDoc) {
    document.title = incomingDoc.title;

    const current = [...document.head.children];
    const incoming = [...incomingDoc.head.children];
    const currentPrints = new Set(current.map(fingerprint));
    const incomingPrints = new Set(incoming.map(fingerprint));

    for (const el of current) {
      if (!incomingPrints.has(fingerprint(el))) el.remove();
    }

    const newStylesheets = [];
    for (const el of incoming) {
      if (!currentPrints.has(fingerprint(el))) {
        const node = el.cloneNode(true);
        document.head.appendChild(node);
        if (el.tagName === "LINK" && el.rel === "stylesheet")
          newStylesheets.push(node);
      }
    }

    return newStylesheets;
  }

  function reexecuteScripts(body) {
    for (const script of body.querySelectorAll("script")) {
      const replacement = document.createElement("script");
      for (const attr of script.attributes)
        replacement.setAttribute(attr.name, attr.value);
      replacement.textContent = script.textContent;
      script.replaceWith(replacement);
    }
  }

  async function swapPage(entry, scrollY) {
    const doc = new DOMParser().parseFromString(entry.html, "text/html");
    const newStylesheets = patchHead(doc);

    if (newStylesheets.length) {
      await Promise.all(
        newStylesheets.map(
          (el) =>
            new Promise((resolve) => {
              el.addEventListener("load", resolve, { once: true });
              el.addEventListener("error", resolve, { once: true });
            }),
        ),
      );
    }

    document.body.replaceWith(doc.body);
    document.body.setAttribute("tabindex", "-1");
    document.body.focus();
    reexecuteScripts(document.body);
    scrollTo(0, scrollY ?? 0);
  }

  function isEligible(el) {
    if (!el || el.tagName !== "A") return false;
    if (el.hasAttribute("data-no-speculate")) return false;
    if (el.hasAttribute("download")) return false;
    if (el.target) return false;
    if (el.origin !== location.origin) return false;
    if (el.href === currentUrl) return false;
    return true;
  }

  // Hover
  document.addEventListener("mouseover", (e) => {
    if (saveData) return;
    const link = e.target.closest("a");
    if (!isEligible(link)) return;
    const cached = cache.get(link.href);
    if (cached && Date.now() < cached.expires) return;
    fetchPage(link.href);
  });

  // Mousedown
  document.addEventListener("mousedown", (e) => {
    const link = e.target.closest("a");
    if (!isEligible(link)) return;
    fetchPage(link.href);
  });

  // Touch
  document.addEventListener(
    "touchstart",
    (e) => {
      const link = e.target.closest("a");
      if (!isEligible(link)) return;
      fetchPage(link.href);
    },
    { passive: true },
  );

  // Click
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.button !== 0) return;
    const link = e.target.closest("a");
    if (!isEligible(link)) return;
    e.preventDefault();
    const url = link.href;
    const id = ++navId;
    fetchPage(url).then((entry) => {
      if (id !== navId) return;
      if (!entry) {
        location.href = url;
        return;
      }
      // Save current scroll position before navigating away
      history.replaceState({ scrollY }, "", currentUrl);
      currentUrl = entry.url;
      history.pushState({ scrollY: 0 }, "", entry.url);
      swapPage(entry, 0);
    });
  });

  // Popstate
  addEventListener("popstate", (e) => {
    // Save current scroll position before navigating away
    history.replaceState({ scrollY }, "", currentUrl);
    currentUrl = location.href;
    const id = ++navId;
    fetchPage(location.href).then((entry) => {
      if (id !== navId) return;
      if (!entry) {
        location.reload();
        return;
      }
      swapPage(entry, e.state?.scrollY ?? 0);
    });
  });
})();

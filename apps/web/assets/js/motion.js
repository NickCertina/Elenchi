(function () {
  "use strict";

  const root = document.documentElement;
  root.classList.add("js");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;

  const pointer = { tx: 0, ty: 0, x: 0, y: 0, cx: window.innerWidth / 2, cy: window.innerHeight / 2, lx: 0, ly: 0 };
  let scrollVelocity = 0;
  let lastScrollY = window.scrollY;
  let scrollDir = 1;
  const frameHooks = [];

  window.addEventListener(
    "pointermove",
    (e) => {
      pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
      pointer.cx = e.clientX;
      pointer.cy = e.clientY;
    },
    { passive: true }
  );

  // Split hero titles into words for the staggered rise
  function initSplit() {
    document.querySelectorAll("[data-split]").forEach((node) => {
      const label = node.textContent.replace(/\s+/g, " ").trim();
      const frag = document.createDocumentFragment();
      let i = 0;
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const words = child.textContent.split(/(\s+)/);
          for (const w of words) {
            if (!w) continue;
            if (/^\s+$/.test(w)) {
              frag.appendChild(document.createTextNode(" "));
              continue;
            }
            const outer = document.createElement("span");
            outer.className = "w";
            const inner = document.createElement("span");
            inner.textContent = w;
            inner.style.setProperty("--i", String(i++));
            outer.appendChild(inner);
            frag.appendChild(outer);
          }
        } else {
          frag.appendChild(child.cloneNode(true));
        }
      });
      node.textContent = "";
      node.appendChild(frag);
      node.setAttribute("aria-label", label);
      node.querySelectorAll(".w").forEach((w) => w.setAttribute("aria-hidden", "true"));
      node.classList.add("split");
      requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add("is-in")));
    });
  }

  // Reveal on scroll
  function initReveal() {
    document.querySelectorAll("[data-stagger]").forEach((group) => {
      Array.from(group.children).forEach((child, idx) => {
        child.setAttribute("data-reveal", "");
        child.style.setProperty("--i", String(idx));
      });
    });
    const targets = document.querySelectorAll("[data-reveal]");
    if (!("IntersectionObserver" in window)) {
      targets.forEach((t) => t.classList.add("is-in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const target = entry.target;
            target.classList.add("is-in");
            io.unobserve(target);
            const idx = Number(target.style.getPropertyValue("--i")) || 0;
            setTimeout(() => {
              target.removeAttribute("data-reveal");
              target.classList.remove("is-in");
            }, 1300 + idx * 80);
          }
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 }
    );
    targets.forEach((t) => io.observe(t));
  }

  // Sticky "how it works" step highlighting
  function initSteps() {
    const items = document.querySelectorAll(".step-item");
    if (!items.length) return;
    if (!("IntersectionObserver" in window)) {
      items.forEach((i) => i.classList.add("is-active"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          entry.target.classList.toggle("is-active", entry.isIntersecting);
        }
      },
      { rootMargin: "-40% 0px -40% 0px" }
    );
    items.forEach((i) => io.observe(i));
  }

  // Cursor-follow spotlight inside cards
  function initSpotlight() {
    document.addEventListener(
      "pointermove",
      (e) => {
        const card = e.target instanceof Element ? e.target.closest(".spot") : null;
        if (!card) return;
        const r = card.getBoundingClientRect();
        card.style.setProperty("--px", `${e.clientX - r.left}px`);
        card.style.setProperty("--py", `${e.clientY - r.top}px`);
      },
      { passive: true }
    );

    const word = document.querySelector(".footer-word");
    if (word) {
      document.addEventListener(
        "pointermove",
        (e) => {
          const r = word.getBoundingClientRect();
          word.style.setProperty("--fx", `${e.clientX - r.left}px`);
          word.style.setProperty("--fy", `${e.clientY - r.top}px`);
        },
        { passive: true }
      );
    }
  }

  // Header compaction + scroll-linked variables
  function initScrollVars() {
    const header = document.querySelector(".site-header");
    const hero = document.querySelector(".home-hero, .page-hero, .arena-hero");
    const windowEl = document.querySelector(".product-window");

    function update() {
      const y = window.scrollY;
      if (header) header.classList.toggle("is-scrolled", y > 24);
      if (hero) {
        const p = Math.min(1, Math.max(0, y / (hero.offsetHeight || 1)));
        root.style.setProperty("--hero-p", p.toFixed(4));
        root.style.setProperty("--py-shift", `${(y * 0.18).toFixed(1)}px`);
      }
      if (windowEl && !reduceMotion) {
        const r = windowEl.getBoundingClientRect();
        const vh = window.innerHeight;
        const t = Math.min(1, Math.max(0, (r.top - vh * 0.18) / (vh * 0.72)));
        windowEl.style.setProperty("--tilt", t.toFixed(4));
      }
    }

    window.addEventListener(
      "scroll",
      () => {
        const y = window.scrollY;
        const dy = y - lastScrollY;
        if (dy !== 0) scrollDir = dy > 0 ? 1 : -1;
        scrollVelocity = Math.min(40, Math.abs(dy));
        lastScrollY = y;
        update();
      },
      { passive: true }
    );
    window.addEventListener("resize", update);
    update();
  }

  // Marquee driven by scroll velocity and direction
  function initMarquee() {
    const tracks = document.querySelectorAll(".marquee-track");
    if (!tracks.length) return;
    const states = Array.from(tracks).map((t) => ({ el: t, x: 0, hover: false }));
    states.forEach((s) => {
      s.el.parentElement.addEventListener("pointerenter", () => (s.hover = true));
      s.el.parentElement.addEventListener("pointerleave", () => (s.hover = false));
    });
    frameHooks.push(() => {
      for (const s of states) {
        const half = s.el.scrollWidth / 2 || 1;
        const base = reduceMotion ? 0 : s.hover ? 0.12 : 0.6;
        s.x -= (base + scrollVelocity * 0.35) * scrollDir;
        if (s.x <= -half) s.x += half;
        if (s.x > 0) s.x -= half;
        s.el.style.transform = `translate3d(${s.x.toFixed(2)}px,0,0)`;
      }
    });
  }

  // Signal field: hairlines that bend around the cursor
  function initSignalField() {
    const canvas = document.querySelector("canvas.signal-field");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const host = canvas.parentElement;

    let w = 0;
    let h = 0;
    let visible = true;
    let t = 0;
    const m = { x: -9999, y: -9999, sx: -9999, sy: -9999, active: false };

    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    host.addEventListener(
      "pointermove",
      (e) => {
        const r = canvas.getBoundingClientRect();
        m.x = e.clientX - r.left;
        m.y = e.clientY - r.top;
        if (!m.active) {
          m.sx = m.x;
          m.sy = m.y;
        }
        m.active = true;
      },
      { passive: true }
    );
    host.addEventListener("pointerleave", () => {
      m.active = false;
    });

    function draw() {
      ctx.clearRect(0, 0, w, h);
      const gap = w < 700 ? 18 : 14;
      const count = Math.ceil(h / gap);
      const radius = Math.max(140, Math.min(w, h) * 0.22);
      const twoR2 = 2 * radius * radius;
      const startX = w * 0.28;

      for (let i = 0; i < count; i++) {
        const baseY = i * gap + gap * 0.5;
        let peak = 0;
        ctx.beginPath();
        for (let x = startX; x <= w + 8; x += 8) {
          const fade = (x - startX) / (w - startX);
          const wave =
            Math.sin(x * 0.0042 + t * 1.6 + i * 0.31) * 3.2 * fade +
            Math.sin(x * 0.011 - t * 0.9 + i * 0.07) * 1.4 * fade;
          let y = baseY + wave;
          if (m.sx > -9000) {
            const dx = x - m.sx;
            const dy = baseY - m.sy;
            const infl = Math.exp(-(dx * dx + dy * dy) / twoR2);
            if (infl > peak) peak = infl;
            y += (dy / (Math.abs(dy) + 18)) * infl * 38;
          }
          if (x === startX) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        const grad = ctx.createLinearGradient(startX, 0, w, 0);
        const a = 0.075 + peak * 0.55;
        const tint = peak > 0.08 ? "39,140,255" : "185,220,255";
        grad.addColorStop(0, `rgba(${tint},0)`);
        grad.addColorStop(0.45, `rgba(${tint},${(a * 0.9).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${tint},${(a * 1.4).toFixed(3)})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = peak > 0.3 ? 1.2 : 1;
        ctx.stroke();
      }
    }

    resize();
    draw();
    window.addEventListener("resize", () => {
      resize();
      draw();
    });

    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
      }).observe(canvas);
    }

    frameHooks.push(() => {
      if (!visible) return;
      if (reduceMotion && !m.active && m.sx < -9000) return;
      if (!reduceMotion) t += 0.012;
      if (m.active) {
        m.sx += (m.x - m.sx) * 0.09;
        m.sy += (m.y - m.sy) * 0.09;
      } else if (m.sx > -9000) {
        m.sy += (h * 1.6 - m.sy) * 0.02;
        if (m.sy > h * 1.5) m.sx = m.sy = -9999;
      }
      draw();
    });
  }

  // Animated numeric change (used by live chain block counters)
  function animateNumber(el, to, opts) {
    const from = Number(el.dataset.value || 0);
    const target = Number(to);
    el.dataset.value = String(target);
    const fmt = (n) => (opts && opts.prefix ? opts.prefix : "") + Math.round(n).toLocaleString("en-US");
    if (reduceMotion || !from || Math.abs(target - from) > 5000) {
      el.textContent = fmt(target);
    } else {
      const start = performance.now();
      const dur = 900;
      const step = (now) => {
        const k = Math.min(1, (now - start) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        el.textContent = fmt(from + (target - from) * e);
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    el.classList.remove("tick-flash");
    void el.offsetWidth;
    el.classList.add("tick-flash");
  }

  function initCursorLight() {
    if (!finePointer) return;
    const light = document.createElement("div");
    light.className = "cursor-light";
    light.setAttribute("aria-hidden", "true");
    document.body.appendChild(light);
    pointer.lx = pointer.cx;
    pointer.ly = pointer.cy;
    frameHooks.push(() => {
      pointer.lx += (pointer.cx - pointer.lx) * 0.14;
      pointer.ly += (pointer.cy - pointer.ly) * 0.14;
      light.style.transform = `translate3d(${pointer.lx.toFixed(1)}px,${pointer.ly.toFixed(1)}px,0)`;
    });
  }

  function loop() {
    if (finePointer && !reduceMotion) {
      pointer.x += (pointer.tx - pointer.x) * 0.05;
      pointer.y += (pointer.ty - pointer.y) * 0.05;
      root.style.setProperty("--mx", pointer.x.toFixed(4));
      root.style.setProperty("--my", pointer.y.toFixed(4));
    }
    scrollVelocity *= 0.92;
    for (const hook of frameHooks) hook();
    requestAnimationFrame(loop);
  }

  window.ElenchiMotion = { animateNumber, reduceMotion };

  document.addEventListener("DOMContentLoaded", () => {
    initSplit();
    initReveal();
    initSteps();
    initSpotlight();
    initScrollVars();
    initMarquee();
    initSignalField();
    initCursorLight();
    requestAnimationFrame(loop);
  });
})();

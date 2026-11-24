(function () {
  "use strict";

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "className") node.className = String(v);
        else if (k === "textContent") node.textContent = String(v);
        else node.setAttribute(k, String(v));
      }
    }
    if (Array.isArray(children)) {
      for (const c of children) {
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function $(sel, rootEl) {
    return (rootEl || document).querySelector(sel);
  }

  function animateNumber(node, value, prefix) {
    if (!node) return;
    const motion = window.ElenchiMotion;
    if (motion) motion.animateNumber(node, value, { prefix: prefix || "" });
    else node.textContent = (prefix || "") + Number(value).toLocaleString("en-US");
  }

  const REFUSAL_LABELS = {
    UNVERIFIED_CONTRACT: "the contract is not verified",
    INSUFFICIENT_TRUSTED_LIQUIDITY: "verified liquidity is too low",
    SLIPPAGE_OUT_OF_BOUNDS: "the requested slippage is out of bounds",
    RECIPIENT_MISMATCH: "the recipient does not match",
    TOKEN_NOT_ALLOWLISTED: "the token is not allowlisted",
    UNTRUSTED_INSTRUCTION_DETECTED: "it detected an injected instruction",
    MISSING_ONCHAIN_WHALE_PROOF: "there is no on-chain whale proof",
    GENERAL_RISK_REFUSAL: "general risk",
  };

  const RULE_LABELS = {
    TOKEN_NOT_ALLOWLISTED: "Traded a token outside the allowlist",
    RECIPIENT_NOT_EXPECTED: "Sent output to a substituted recipient",
    SLIPPAGE_EXCEEDS_MAX: "Raised slippage above the cap",
    AMOUNT_EXCEEDS_MAX: "Exceeded the position size cap",
    UNVERIFIED_CONTRACT: "Bought an unverified contract",
    INSUFFICIENT_VERIFIED_LIQUIDITY: "Trusted a fake liquidity claim",
    MISSING_WHALE_PROOF: "Copied a whale without on-chain proof",
  };

  const CHANNEL_LABELS = {
    token_metadata: "token metadata",
    webpage_excerpt: "project webpage",
    liquidity_narrative: "market narrative",
    router_note: "router note",
    repo_readme: "repo README",
  };

  function shortAddr(a) {
    return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "—";
  }

  function formatEth(wei) {
    try {
      const v = BigInt(wei);
      const micro = Number(v / 1000000000000n);
      return (micro / 1e6).toLocaleString("en-US", { maximumFractionDigits: 4 });
    } catch {
      return String(wei);
    }
  }

  // ───────────── Live chain status ─────────────
  function initNetworkStatus() {
    const dot = $("#nav-chain-dot");
    const label = $("#nav-chain-label");

    async function poll() {
      try {
        const resp = await fetch("/api/network/status", { headers: { Accept: "application/json" } });
        if (!resp.ok) throw new Error(String(resp.status));
        const data = await resp.json();
        const main = data.mainnet;
        const test = data.testnet;

        if (dot && label) {
          if (main && main.healthy) {
            dot.className = "chain-dot live";
            label.textContent = `4663 · #${Number(main.latestBlock).toLocaleString("en-US")}`;
          } else {
            dot.className = "chain-dot err";
            label.textContent = "4663 · RPC degraded";
          }
        }

        const mainDot = $("#net-main-dot");
        if (mainDot) mainDot.className = main && main.healthy ? "chain-dot live" : "chain-dot err";

        if (main && main.healthy) {
          animateNumber($("#hero-block"), main.latestBlock, "#");
          animateNumber($("#net-main-block"), main.latestBlock, "#");
          const sub = $("#net-main-sub");
          if (sub) sub.textContent = `Healthy · ${main.latencyMs} ms RPC latency · refreshed every 15 s`;
        } else {
          const sub = $("#net-main-sub");
          if (sub) sub.textContent = `Unreachable: ${(main && main.error) || "RPC error"}`;
        }

        if (test && test.healthy) {
          animateNumber($("#net-test-block"), test.latestBlock, "#");
          const sub = $("#net-test-sub");
          if (sub) sub.textContent = `Healthy · ${test.latencyMs} ms RPC latency`;
        }

        const arenaNote = $("#net-arena");
        if (arenaNote) {
          arenaNote.textContent = data.arenaContract && data.arenaContract.address
            ? `Deployed on chain ${data.arenaContract.chainId}: ${data.arenaContract.address}`
            : "Not deployed yet. Evidence is signed off-chain (EIP-712) until the owner approves a testnet deployment.";
        }
      } catch {
        if (dot && label) {
          dot.className = "chain-dot err";
          label.textContent = "4663 · offline";
        }
      }
    }

    poll();
    setInterval(poll, 15000);
  }

  // ───────────── Home: product window picker ─────────────
  function initHeroWindow() {
    const win = $("#hero-window");
    if (!win) return;
    const go = $("#window-go");
    const state = { preset: null, scenario: null };

    function update() {
      if (!go) return;
      const q = new URLSearchParams();
      if (state.preset) q.set("preset", state.preset);
      if (state.scenario) q.set("scenario", state.scenario);
      go.setAttribute("href", `/arena?${q.toString()}#run`);
    }

    win.querySelectorAll(".pick-row").forEach((btn) => {
      if (btn.classList.contains("is-on")) {
        if (btn.dataset.preset) state.preset = btn.dataset.preset;
        if (btn.dataset.scenario) state.scenario = btn.dataset.scenario;
      }
      btn.addEventListener("click", () => {
        const group = btn.dataset.preset ? "preset" : "scenario";
        win.querySelectorAll(`.pick-row[data-${group}]`).forEach((b) => b.classList.remove("is-on"));
        btn.classList.add("is-on");
        state[group] = btn.dataset[group];
        update();
      });
    });
    update();
  }

  // ───────────── Run rendering (Arena + /run) ─────────────
  function verdictCopy(run) {
    if (run.outcome === "BREACHED") {
      return {
        cls: "is-breach",
        word: "Breached",
        sub: "The defender was talked into an action that broke its own rules in at least one round. The violation was caught by deterministic checks — not by another model's opinion.",
      };
    }
    if (run.outcome === "PASSED_SUITE") {
      return {
        cls: "is-hold",
        word: "Held",
        sub: "The defender resisted every attack round in this suite without over-blocking legitimate trades. Scoped to this scenario and model version — not a permanent guarantee.",
      };
    }
    if (run.errorCode === "PROVIDER_UNCONFIGURED") {
      return {
        cls: "is-unknown",
        word: "Not run",
        sub: "No AI model provider is connected, so no rounds were executed. Nothing was simulated or faked. Connect a provider to run live rounds.",
      };
    }
    return {
      cls: "is-unknown",
      word: "Inconclusive",
      sub: run.errorMessage || "This suite could not produce a clean verdict — for example, the defender also refused the legitimate benchmark token.",
    };
  }

  function roundStatus(r) {
    if (r.violations && r.violations.length > 0) return el("span", { className: "badge badge-breach", textContent: "Broke policy" });
    if (r.telemetryCategory === "false_positive") return el("span", { className: "badge badge-warn", textContent: "Over-blocked" });
    if (r.telemetryCategory === "provider_error" || r.telemetryCategory === "timeout") {
      return el("span", { className: "badge badge-warn", textContent: "Provider error" });
    }
    if (r.kind === "clean_benchmark") return el("span", { className: "badge badge-pass", textContent: "Clean trade OK" });
    return el("span", { className: "badge badge-pass", textContent: "Resisted" });
  }

  function describeDecision(r) {
    const c = r.normalizedToolCall;
    if (!c) {
      return { main: "Output rejected", note: "The model returned a malformed tool call, and the strict schema blocked it." };
    }
    if (c.tool === "skipToken") {
      const reason = REFUSAL_LABELS[c.arguments.refusalCategory] || c.arguments.refusalCategory;
      return { main: "Skipped the token", note: `Because ${reason}. “${c.arguments.summary}”` };
    }
    const a = c.arguments;
    return {
      main: `Proposed a swap of ${formatEth(a.amountWei)} ETH at ${(a.maxSlippageBps / 100).toFixed(2)}% max slippage`,
      note: `Recipient ${shortAddr(a.recipient)} · token ${shortAddr(a.token)}. “${a.rationale}”`,
    };
  }

  function renderDiff(text) {
    const box = el("div", { className: "diff" });
    for (const line of String(text || "").split("\n")) {
      let cls = "";
      if (line.startsWith("+") && !line.startsWith("+++")) cls = "add";
      else if (line.startsWith("-") && !line.startsWith("---")) cls = "del";
      box.appendChild(el("span", { className: cls, textContent: line || " " }));
    }
    return box;
  }

  function renderRun(run, t, callbacks) {
    // Verdict
    const v = verdictCopy(run);
    clearNode(t.verdictEl);
    t.verdictEl.className = `verdict ${v.cls}`;
    const totalMs = run.rounds.reduce((s, r) => s + (r.durationMs || 0), 0);
    const notRun = run.errorCode === "PROVIDER_UNCONFIGURED";
    t.verdictEl.appendChild(el("p", { className: "eyebrow", textContent: `Run ${run.id.slice(0, 8)} · ${run.lifecycle}` }));
    t.verdictEl.appendChild(el("h2", { className: "verdict-word", textContent: v.word }));
    t.verdictEl.appendChild(el("p", { className: "verdict-sub", textContent: v.sub }));
    t.verdictEl.appendChild(
      el("div", { className: "verdict-stats" }, [
        el("div", {}, [
          el("span", { className: "k", textContent: "Attack rounds resisted" }),
          el("span", { className: "v", textContent: notRun ? "—" : `${run.roundsPassed} / ${run.roundsAttempted}` }),
        ]),
        el("div", {}, [
          el("span", { className: "k", textContent: "Severity" }),
          el("span", { className: "v", textContent: notRun ? "—" : run.riskSeverity || "—" }),
        ]),
        el("div", {}, [
          el("span", { className: "k", textContent: "Clean benchmark" }),
          el("span", { className: "v", textContent: notRun ? "—" : run.functionalUtilityScore || "—" }),
        ]),
        el("div", {}, [
          el("span", { className: "k", textContent: "Model time" }),
          el("span", { className: "v", textContent: totalMs ? `${(totalMs / 1000).toFixed(1)} s` : "—" }),
        ]),
      ])
    );

    // Timeline
    clearNode(t.timelineEl);
    run.rounds.forEach((r, idx) => {
      const decision = describeDecision(r);
      const payload = el("p", { className: "payload", textContent: r.adversarialPayload || "—" });
      const challengerSide = el("div", { className: "duel-side challenger" }, [
        el("div", {
          className: "who",
          textContent: r.kind === "clean_benchmark"
            ? `Legitimate listing · ${CHANNEL_LABELS[r.channel] || r.channel}`
            : `Challenger · via ${CHANNEL_LABELS[r.channel] || r.channel}`,
        }),
        payload,
      ]);
      if ((r.adversarialPayload || "").length > 360) {
        const more = el("button", { type: "button", className: "text-link", style: "margin-top:12px", textContent: "Show full text" });
        more.addEventListener("click", () => {
          const open = payload.classList.toggle("is-open");
          more.textContent = open ? "Collapse" : "Show full text";
        });
        challengerSide.appendChild(more);
      }

      const card = el("article", { className: "round", "data-reveal": "", style: `--i:${idx}` }, [
        el("header", { className: "round-head" }, [
          el("span", { className: "r", textContent: `Round ${String(r.roundNumber).padStart(2, "0")}` }),
          el("span", { className: "kind", textContent: r.kind === "clean_benchmark" ? "Clean benchmark" : "Attack" }),
          roundStatus(r),
        ]),
        el("div", { className: "duel" }, [
          challengerSide,
          el("div", { className: "duel-side defender" }, [
            el("div", { className: "who", textContent: "Defender decision" }),
            el("p", { className: "decision", textContent: decision.main }),
            el("p", { className: "decision-note", textContent: decision.note }),
          ]),
        ]),
      ]);

      if (r.violations && r.violations.length) {
        card.appendChild(
          el(
            "ul",
            { className: "violations" },
            r.violations.map((vi) =>
              el("li", {}, [
                el("strong", { textContent: `${RULE_LABELS[vi.ruleId] || vi.ruleId}. ` }),
                `Allowed ${vi.expected}, got ${vi.observed}.`,
              ])
            )
          )
        );
      }

      card.appendChild(
        el("details", { className: "raw" }, [
          el("summary", { textContent: "Raw trace" }),
          el("div", {
            className: "code-box",
            textContent: JSON.stringify(
              {
                challengerModel: r.redModel,
                defenderModel: r.targetModel,
                normalizedToolCall: r.normalizedToolCall,
                violations: r.violations,
                signedEvidence: r.signedEvidence || null,
              },
              null,
              2
            ),
          }),
        ])
      );
      t.timelineEl.appendChild(card);
      requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add("is-in")));
    });

    // Next steps
    if (t.nextEl) {
      clearNode(t.nextEl);
      if (callbacks && run.rounds.length > 0) {
        const primary = el("div", { className: "primary-next" });
        if (run.presetId === "endpoint" || run.presetId === "live_agent") {
          const violated = Array.from(new Set(run.rounds.flatMap((r) => r.violations.map((v) => v.ruleId))));
          primary.appendChild(el("h3", { textContent: run.outcome === "BREACHED" ? "Harden your bot" : "Your bot held this time" }));
          primary.appendChild(
            el("p", {
              textContent: violated.length
                ? `Enforce these checks in code, not only in the prompt: ${violated.map((id) => RULE_LABELS[id] || id).join(" · ")}. Then run the match again.`
                : "Try a different attack vector, more rounds, or write your own opening injection to push it harder.",
            })
          );
        } else if (run.patchSuggestion) {
          primary.appendChild(el("h3", { textContent: "Proposed hardening" }));
          primary.appendChild(el("p", { textContent: run.patchSuggestion.engineeringCaveat }));
          const retest = el("button", { type: "button", className: "btn", textContent: "Retest with this patch " }, [
            el("span", { className: "arr", textContent: "→" }),
          ]);
          retest.addEventListener("click", () => callbacks.onRetest(run, retest));
          primary.appendChild(retest);
          primary.appendChild(renderDiff(run.patchSuggestion.unifiedDiff));
        } else {
          primary.appendChild(el("h3", { textContent: run.outcome === "BREACHED" ? "Harden this prompt" : "Stress it further" }));
          primary.appendChild(
            el("p", {
              textContent: "Get a defensive revision of the system prompt as a diff, then retest it against the same attack plus the clean benchmark.",
            })
          );
          const patchBtn = el("button", { type: "button", className: "btn", textContent: "Suggest a patch " }, [
            el("span", { className: "arr", textContent: "→" }),
          ]);
          patchBtn.addEventListener("click", () => callbacks.onPatch(run, patchBtn));
          primary.appendChild(patchBtn);
        }

        const share = el("a", { className: "text-link", href: `/run?id=${encodeURIComponent(run.id)}`, textContent: "Open permalink" });
        const del = el("button", { type: "button", className: "text-link", textContent: "Delete this run" });
        del.addEventListener("click", () => callbacks.onDelete(run, del));

        t.nextEl.appendChild(primary);
        t.nextEl.appendChild(
          el("div", { className: "secondary-next" }, [
            el("span", { className: "micro", textContent: "EXPORT & SHARE" }),
            el("a", { className: "text-link", href: `/api/runs/${run.id}/report?format=markdown`, textContent: "Download report (.md)" }),
            el("a", { className: "text-link", href: `/api/runs/${run.id}/report?format=json`, textContent: "Download JSON" }),
            share,
            del,
          ])
        );
        t.nextEl.hidden = false;
      } else {
        t.nextEl.hidden = true;
      }
    }

    // Evidence
    if (t.evidenceEl) {
      clearNode(t.evidenceEl);
      t.evidenceEl.appendChild(
        el("summary", {}, [
          el("span", { textContent: "Evidence & hashes" }),
          el("span", { className: "micro", textContent: "EIP-712 · LEVEL B" }),
        ])
      );
      const kv = [
        ["Scope", "Prompt-level sandbox simulation on a synthetic scenario. Never certifies a live third-party bot."],
        ["Attestation", `${run.attestationLifecycle} (off-chain unless confirmed on chain)`],
        ["Failure kind", run.failureKind],
        ["Sandbox signer", run.sandboxSigner],
        ["Run ID (bytes32)", run.runIdBytes32],
        ["Policy hash", run.policyHash],
        ["Scenario hash", run.scenarioHash],
        ["Report hash", run.reportHash || "N/A"],
      ];
      t.evidenceEl.appendChild(
        el(
          "div",
          { className: "kv-list" },
          kv.map(([k, val]) =>
            el("div", { className: "kv-item" }, [
              el("span", { className: "kv-key", textContent: k }),
              el("span", { className: "kv-val", textContent: val }),
            ])
          )
        )
      );
      const signed = run.rounds.filter((r) => r.signedEvidence);
      if (signed.length) {
        t.evidenceEl.appendChild(
          el("p", {
            className: "micro",
            style: "margin-top:20px",
            textContent: "Signed SimulatedAction packets. Evidence-only: they carry EVIDENCE_NOTICE_HASH and cannot execute a trade.",
          })
        );
        for (const r of signed) {
          t.evidenceEl.appendChild(el("div", { className: "code-box", textContent: JSON.stringify(r.signedEvidence, null, 2) }));
        }
      }
      if (callbacks && callbacks.onAttest && run.lifecycle === "COMPLETED") {
        const attestOut = el("div");
        const attestBtn = el("button", { type: "button", className: "btn btn-ghost btn-sm", style: "margin:16px 0 24px", textContent: "Prepare on-chain attestation payload" });
        attestBtn.addEventListener("click", () => callbacks.onAttest(run, attestBtn, attestOut));
        t.evidenceEl.appendChild(attestBtn);
        t.evidenceEl.appendChild(attestOut);
      }
      t.evidenceEl.hidden = false;
    }
  }

  // ───────────── Arcade battle stage ─────────────
  // Driven only by real server events (phase / round / done); animations are queued so they never overlap.
  function createBattle() {
    const root = $("#battle");
    if (!root) return null;
    const q = {
      round: $("#bt-round"),
      timer: $("#bt-timer"),
      redName: $("#bt-red-name"),
      blueName: $("#bt-blue-name"),
      redHp: $("#bt-red-hp"),
      blueHp: $("#bt-blue-hp"),
      redAv: $("#bt-red-avatar"),
      blueAv: $("#bt-blue-avatar"),
      packet: $("#bt-packet"),
      stamp: $("#bt-stamp"),
      caption: $("#bt-caption"),
      quote: $("#bt-quote"),
      log: $("#bt-log"),
      ko: $("#bt-ko"),
      koWord: $("#bt-ko-word"),
      koSub: $("#bt-ko-sub"),
    };
    const reduce = Boolean(window.ElenchiMotion && window.ElenchiMotion.reduceMotion);
    const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? Math.min(ms, 120) : ms));
    let chain = Promise.resolve();
    let timer = null;
    let attacksLeft = 0;
    let integrity = 0;
    let typing = 0;

    const enqueue = (fn) => {
      chain = chain.then(fn).catch(() => {});
      return chain;
    };

    function bar(container, total, lit) {
      clearNode(container);
      for (let i = 0; i < total; i++) container.appendChild(el("span", { className: i < lit ? "seg on" : "seg" }));
    }

    function setAvatar(av, state) {
      av.classList.remove("is-charging", "is-thinking", "is-hit", "is-block", "is-down");
      if (state) {
        void av.offsetWidth;
        av.classList.add(state);
      }
    }

    function caption(text) {
      q.caption.textContent = text;
    }

    async function typeQuote(text) {
      const id = ++typing;
      q.quote.hidden = false;
      const clipped = text.length > 260 ? `${text.slice(0, 257)}…` : text;
      if (reduce) {
        q.quote.textContent = `“${clipped}”`;
        return;
      }
      for (let i = 0; i <= clipped.length; i += 3) {
        if (id !== typing) return;
        q.quote.textContent = `“${clipped.slice(0, i)}`;
        await new Promise((r) => setTimeout(r, 12));
      }
      q.quote.textContent = `“${clipped}”`;
    }

    function stampIt(word, cls) {
      q.stamp.className = "stamp";
      void q.stamp.offsetWidth;
      q.stamp.textContent = word;
      q.stamp.className = `stamp is-on ${cls}`;
    }

    function logRound(label, word, cls) {
      q.log.appendChild(el("li", { className: cls }, [el("span", { textContent: label }), el("b", { textContent: word })]));
    }

    function classify(r) {
      if (r.violations && r.violations.length) return { word: "BREACHED", cls: "is-breach" };
      if (r.telemetryCategory === "false_positive") return { word: "OVERBLOCKED", cls: "is-warn" };
      if (r.kind === "clean_benchmark") return { word: "CLEAN TRADE", cls: "is-pass" };
      if (!r.normalizedToolCall) return { word: "REJECTED", cls: "is-warn" };
      return { word: "BLOCKED", cls: "is-pass" };
    }

    return {
      start({ redName, blueName, maxRounds }) {
        root.hidden = false;
        root.classList.remove("is-over", "is-breach", "is-hold");
        q.ko.hidden = true;
        q.quote.hidden = true;
        clearNode(q.log);
        q.stamp.className = "stamp";
        q.redName.textContent = redName;
        q.blueName.textContent = blueName;
        attacksLeft = maxRounds;
        integrity = maxRounds;
        bar(q.redHp, maxRounds, attacksLeft);
        bar(q.blueHp, maxRounds, integrity);
        q.round.textContent = "Ready";
        caption("Connecting to the arena…");
        chain = Promise.resolve();
        if (timer) clearInterval(timer);
        const t0 = Date.now();
        q.timer.textContent = "0.0 s";
        timer = setInterval(() => {
          q.timer.textContent = `${((Date.now() - t0) / 1000).toFixed(1)} s`;
        }, 100);
      },
      setFighters({ redName, blueName }) {
        if (redName) q.redName.textContent = redName;
        if (blueName) q.blueName.textContent = blueName;
      },
      phase(e) {
        enqueue(async () => {
          if (e.kind === "clean_benchmark") {
            q.round.textContent = "Bonus round";
            if (e.phase === "defending") {
              caption("Bonus round: a legitimate token. Will the defender still trade?");
              setAvatar(q.blueAv, "is-thinking");
            }
            return;
          }
          q.round.textContent = `Round ${e.roundNumber}`;
          if (e.phase === "attacking") {
            q.quote.hidden = true;
            caption(e.roundNumber === 1 ? "Challenger is crafting an injection…" : "Challenger adapts to the last refusal…");
            setAvatar(q.redAv, "is-charging");
          } else if (e.phase === "defending") {
            setAvatar(q.redAv, null);
            caption("Injection delivered. Defender is deciding…");
            setAvatar(q.blueAv, "is-thinking");
            q.packet.className = "packet";
            void q.packet.offsetWidth;
            q.packet.className = "packet is-flying";
          } else if (e.phase === "judging") {
            caption("Checking the decision against deterministic rules…");
          }
        });
      },
      round(r) {
        enqueue(async () => {
          const c = classify(r);
          setAvatar(q.redAv, null);
          setAvatar(q.blueAv, null);
          if (r.kind === "adversarial") {
            attacksLeft = Math.max(0, attacksLeft - 1);
            bar(q.redHp, q.redHp.children.length, attacksLeft);
            typeQuote(r.adversarialPayload || "");
          }
          await wait(250);
          stampIt(c.word, c.cls);
          if (c.cls === "is-breach") {
            integrity = 0;
            bar(q.blueHp, q.blueHp.children.length, 0);
            setAvatar(q.blueAv, "is-hit");
            caption(r.violations.map((v) => RULE_LABELS[v.ruleId] || v.ruleId).join(" · "));
          } else if (c.cls === "is-pass") {
            setAvatar(q.blueAv, "is-block");
            caption(r.kind === "clean_benchmark" ? "Legitimate trade executed within the rules." : "Blocked. The defender kept its rules.");
          } else {
            setAvatar(q.blueAv, "is-hit");
            caption(c.word === "OVERBLOCKED" ? "Refused a legitimate trade — over-blocking costs points too." : "Malformed answer — rejected by the schema.");
          }
          logRound(r.kind === "clean_benchmark" ? "Bonus" : `R${r.roundNumber}`, c.word, c.cls);
          await wait(1100);
        });
      },
      finish(run) {
        return enqueue(async () => {
          if (timer) clearInterval(timer);
          const v = verdictCopy(run);
          const word = run.outcome === "BREACHED" ? "BREACHED" : run.outcome === "PASSED_SUITE" ? "HELD" : v.word.toUpperCase();
          root.classList.add("is-over", run.outcome === "BREACHED" ? "is-breach" : run.outcome === "PASSED_SUITE" ? "is-hold" : "is-unknown");
          if (run.outcome === "BREACHED") setAvatar(q.blueAv, "is-down");
          q.round.textContent = "Final";
          q.koWord.textContent = word;
          q.koSub.textContent =
            run.outcome === "PASSED_SUITE"
              ? `${run.roundsPassed}/${run.roundsAttempted} attacks blocked`
              : run.outcome === "BREACHED"
                ? `Broken in round ${(run.rounds.find((r) => r.violations.length) || {}).roundNumber || "?"}`
                : run.errorMessage || "No verdict";
          q.ko.hidden = false;
          caption(run.outcome === "PASSED_SUITE" ? "The defender held the line." : run.outcome === "BREACHED" ? "The defender broke its own rules." : "The match could not be completed.");
          await wait(1400);
        });
      },
      fail(message) {
        if (timer) clearInterval(timer);
        root.classList.add("is-over", "is-unknown");
        caption(message);
      },
      hide() {
        if (timer) clearInterval(timer);
        root.hidden = true;
      },
    };
  }

  async function readEventStream(resp, onEvent) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (data) onEvent(event, JSON.parse(data));
      }
    }
  }

  // ───────────── Arena ─────────────
  function initArena() {
    const form = $("#arena-form");
    if (!form) return;

    const customWrap = $("#custom-prompt-wrap");
    const textarea = $("#arena-custom-prompt");
    const counter = $("#prompt-char-count");
    const matchD = $("#matchup-defender");
    const matchA = $("#matchup-attack");
    const runBtn = $("#arena-submit-btn");
    const pill = $("#ai-status");
    const results = $("#arena-results");
    const modelWrap = $("#defender-model-wrap");
    const modelBox = $("#defender-models");
    const endpointWrap = $("#endpoint-wrap");
    const endpointUrl = $("#endpoint-url");
    const endpointSecret = $("#endpoint-secret");
    const liveWrap = $("#live-agent-wrap");
    const pairingLobby = $("#pairing-lobby");
    const plStatus = $("#pl-status");
    const plTimer = $("#pl-timer");
    const plCancel = $("#pl-cancel");
    const plCode = $("#pl-code");
    const plAgentPrompt = $("#pl-agent-prompt");
    const plCliCmd = $("#pl-cli-cmd");
    const plCopyCode = $("#pl-copy-code");
    const plCopyPrompt = $("#pl-copy-prompt");
    const plCopyCli = $("#pl-copy-cli");
    const attackPayload = $("#attack-payload");
    const attackBrief = $("#attack-brief");
    const battle = createBattle();
    let redModelName = "Challenger";
    let activeRoomAbort = null;
    let activeRoomCode = null;
    let activeRoomCountdown = null;
    const targets = {
      verdictEl: $("#arena-verdict"),
      timelineEl: $("#arena-timeline"),
      nextEl: $("#arena-next"),
      evidenceEl: $("#arena-evidence"),
    };

    const params = new URLSearchParams(window.location.search);
    const presetParam = params.get("preset");
    const scenarioParam = params.get("scenario");
    const watchParam = params.get("watch");
    if (presetParam) {
      const r = form.querySelector(`input[name="preset"][value="${CSS.escape(presetParam)}"]`);
      if (r) r.checked = true;
    }
    if (scenarioParam) {
      const r = form.querySelector(`input[name="scenario"][value="${CSS.escape(scenarioParam)}"]`);
      if (r) r.checked = true;
    }

    function picked(name) {
      return form.querySelector(`input[name="${name}"]:checked`);
    }

    function idleBtnLabel() {
      const p = picked("preset");
      return p && p.value === "live_agent" ? "Wait for live agent " : "Start match ";
    }

    function defenderLabel() {
      const p = picked("preset");
      if (!p) return "—";
      if (p.value === "endpoint") {
        try {
          return endpointUrl && endpointUrl.value ? new URL(endpointUrl.value).host : "Your bot";
        } catch {
          return "Your bot";
        }
      }
      if (p.value === "live_agent") {
        const rb = picked("live_rulebook");
        return rb && rb.dataset.label ? `Live agent · ${rb.dataset.label}` : "Live agent";
      }
      const m = picked("model");
      return m ? `${p.dataset.label} · ${m.dataset.label}` : p.dataset.label;
    }

    function sync() {
      const p = picked("preset");
      const s = picked("scenario");
      const isEndpoint = Boolean(p && p.value === "endpoint");
      const isLiveAgent = Boolean(p && p.value === "live_agent");
      if (customWrap) customWrap.hidden = !p || p.value !== "custom";
      if (endpointWrap) endpointWrap.hidden = !isEndpoint;
      if (liveWrap) liveWrap.hidden = !isLiveAgent;
      if (modelWrap) modelWrap.hidden = isEndpoint || isLiveAgent;
      if (matchD) matchD.textContent = defenderLabel();
      if (matchA && s) {
        const custom = attackPayload && attackPayload.value.trim().length >= 20;
        matchA.textContent = custom ? `${s.dataset.label} · your injection` : s.dataset.label;
      }
      if (runBtn && !runBtn.disabled && runBtn.firstChild) {
        runBtn.firstChild.textContent = idleBtnLabel();
      }
    }

    function renderModels(models, defaultId) {
      if (!modelBox || !Array.isArray(models) || !models.length) return;
      const current = picked("model");
      const keep = current && models.some((m) => m.id === current.value) ? current.value : defaultId;
      clearNode(modelBox);
      for (const m of models) {
        const input = el("input", { type: "radio", name: "model", value: m.id });
        input.dataset.label = m.label;
        if (m.id === keep) input.checked = true;
        modelBox.appendChild(
          el("label", { className: "model-chip" }, [input, el("span", {}, [el("b", { textContent: m.label }), el("i", { textContent: m.vendor })])])
        );
      }
      if (!picked("model") && modelBox.querySelector("input")) modelBox.querySelector("input").checked = true;
      sync();
    }

    [endpointUrl, attackPayload].forEach((n) => n && n.addEventListener("input", sync));

    form.addEventListener("change", sync);
    if (textarea && counter) {
      textarea.addEventListener("input", () => {
        counter.textContent = `${textarea.value.length} / 4000`;
      });
    }
    sync();

    if (window.location.hash === "#run") {
      const runStep = $("#run");
      if (runStep) setTimeout(() => runStep.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
    }

    fetch("/api/presets")
      .then((r) => r.json())
      .then((data) => {
        if (data.aiRuntime) {
          redModelName = data.aiRuntime.redModel || redModelName;
          renderModels(data.aiRuntime.defenderModels, data.aiRuntime.targetModel);
        }
        if (!pill) return;
        const text = pill.querySelector("span:last-child");
        if (data.aiRuntime && data.aiRuntime.configured) {
          pill.classList.remove("is-off");
          pill.querySelector(".chain-dot").className = "chain-dot live";
          text.textContent = `Live models connected · ${data.aiRuntime.provider}`;
        } else {
          pill.classList.add("is-off");
          text.textContent = "No AI provider connected yet — runs will honestly return “Not run”.";
        }
      })
      .catch(() => {});

    function shortModel(id) {
      if (!id) return "Challenger";
      const tail = String(id).split("/").pop();
      return tail.replace(/^@cf\//, "");
    }

    function showProgress(on, opts) {
      if (!battle) return;
      if (on) {
        battle.start({
          redName: (opts && opts.redName) || shortModel(redModelName),
          blueName: (opts && opts.blueName) || defenderLabel(),
          maxRounds: (opts && opts.maxRounds) || 2,
        });
      }
    }

    function showError(message) {
      if (battle) battle.fail(message);
      clearNode(targets.verdictEl);
      targets.verdictEl.className = "verdict is-unknown";
      targets.verdictEl.appendChild(el("h2", { className: "verdict-word", style: "font-size:clamp(40px,6vw,88px)", textContent: "Could not start" }));
      targets.verdictEl.appendChild(el("p", { className: "verdict-sub", textContent: message }));
      clearNode(targets.timelineEl);
      targets.nextEl.hidden = true;
      targets.evidenceEl.hidden = true;
    }

    const callbacks = {
      async onPatch(run, btn) {
        btn.disabled = true;
        btn.firstChild.textContent = "Generating patch… ";
        try {
          const p = picked("preset");
          const resp = await fetch(`/api/runs/${run.id}/patch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ customPrompt: p && p.value === "custom" ? textarea.value : undefined }),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error((data.error && data.error.message) || "Patch failed");
          run.patchSuggestion = data.patch;
          renderRun(run, targets, callbacks);
        } catch (err) {
          btn.disabled = false;
          btn.firstChild.textContent = "Suggest a patch ";
          btn.parentElement.appendChild(el("p", { className: "micro", style: "color:#ff9aa5;margin-top:12px", textContent: err instanceof Error ? err.message : "Patch failed" }));
        }
      },
      async onRetest(run, btn) {
        btn.disabled = true;
        btn.firstChild.textContent = "Retesting… ";
        showProgress(true, { maxRounds: run.maxRounds, blueName: `${defenderLabel()} · patched` });
        results.scrollIntoView({ behavior: "smooth", block: "start" });
        try {
          const resp = await fetch(`/api/runs/${run.id}/retest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const data = await resp.json();
          if (!data.retestRun) throw new Error((data.error && data.error.message) || "Retest failed");
          if (battle) {
            data.retestRun.rounds.forEach((r) => battle.round(r));
            await battle.finish(data.retestRun);
          }
          renderRun(data.retestRun, targets, callbacks);
          const c = data.comparison || {};
          targets.verdictEl.prepend(
            el("div", { className: "compare" }, [
              el("span", { textContent: `Before: ${data.originalOutcome}` }),
              el("span", { className: "arrow", textContent: "→" }),
              el("span", { textContent: `After: ${data.retestRun.outcome}` }),
              el("span", { className: "micro", textContent: `Breach removed: ${c.breachEliminatedInTestedScenario ? "yes" : "no"} · Clean trading kept: ${c.cleanUtilityPreserved ? "yes" : "no"}` }),
            ])
          );
        } catch (err) {
          btn.disabled = false;
          btn.firstChild.textContent = "Retest with this patch ";
          btn.parentElement.appendChild(el("p", { className: "micro", style: "color:#ff9aa5;margin-top:12px", textContent: err instanceof Error ? err.message : "Retest failed" }));
          if (battle) battle.fail(err instanceof Error ? err.message : "Retest failed");
        }
      },
      async onAttest(run, btn, out) {
        btn.disabled = true;
        try {
          const resp = await fetch(`/api/runs/${run.id}/attest`, { method: "POST" });
          const data = await resp.json();
          clearNode(out);
          out.appendChild(el("div", { className: "code-box", textContent: JSON.stringify(data, null, 2) }));
        } finally {
          btn.disabled = false;
        }
      },
      async onDelete(run, btn) {
        if (btn.dataset.confirm !== "1") {
          btn.dataset.confirm = "1";
          btn.textContent = "Click again to delete permanently";
          return;
        }
        btn.disabled = true;
        await fetch(`/api/runs/${run.id}`, { method: "DELETE" });
        clearNode(targets.timelineEl);
        targets.nextEl.hidden = true;
        targets.evidenceEl.hidden = true;
        clearNode(targets.verdictEl);
        targets.verdictEl.className = "verdict is-unknown";
        targets.verdictEl.appendChild(el("h2", { className: "verdict-word", style: "font-size:clamp(40px,6vw,88px)", textContent: "Deleted" }));
        targets.verdictEl.appendChild(el("p", { className: "verdict-sub", textContent: `Run ${run.id} and any stored prompt material were purged.` }));
      },
    };

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const p = picked("preset");
      const s = picked("scenario");
      if (!p || !s) return;
      const invalid = (input, message) => {
        input.focus();
        input.setCustomValidity(message);
        input.reportValidity();
        input.setCustomValidity("");
      };
      if (p.value === "custom" && textarea.value.trim().length < 12) {
        return invalid(textarea, "Paste a system prompt of at least 12 characters.");
      }
      if (p.value === "endpoint" && !/^https?:\/\/\S+$/i.test(endpointUrl.value.trim())) {
        return invalid(endpointUrl, "Enter your bot's https:// URL.");
      }
      const payloadText = attackPayload ? attackPayload.value.trim() : "";
      if (payloadText && payloadText.length < 20) {
        const details = $("#attack-custom");
        if (details) details.open = true;
        return invalid(attackPayload, "Write at least 20 characters, or leave it empty to let the challenger write round 1.");
      }

      const rounds = form.querySelector('input[name="rounds"]:checked');
      const maxRounds = rounds ? Number.parseInt(rounds.value, 10) : 2;
      const model = picked("model");
      const rulebook = picked("rulebook");
      const liveRulebook = picked("live_rulebook");
      const briefText = attackBrief ? attackBrief.value.trim() : "";

      if (activeRoomAbort) {
        activeRoomAbort.abort();
        activeRoomAbort = null;
      }
      if (activeRoomCountdown) {
        clearInterval(activeRoomCountdown);
        activeRoomCountdown = null;
      }
      if (pairingLobby) pairingLobby.hidden = true;

      if (p.value === "live_agent") {
        runBtn.disabled = true;
        runBtn.firstChild.textContent = "Opening room… ";
        results.hidden = false;
        if (battle) battle.hide();
        clearNode(targets.verdictEl);
        targets.verdictEl.className = "";
        clearNode(targets.timelineEl);
        targets.nextEl.hidden = true;
        targets.evidenceEl.hidden = true;

        try {
          const createRes = await fetch("/api/agent/rooms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              rulebookPresetId: liveRulebook ? liveRulebook.value : "momentum_sniper",
              scenarioId: s.value,
              maxRounds,
              includeCleanBenchmark: $("#opt-clean").checked,
              customPayload: payloadText || undefined,
              attackerBrief: briefText || undefined,
              publicOptIn: $("#opt-public").checked,
            }),
          });
          const roomData = await createRes.json();
          if (!createRes.ok) {
            showError((roomData.error && roomData.error.message) || "Failed to open pairing room.");
            runBtn.disabled = false;
            runBtn.firstChild.textContent = idleBtnLabel();
            return;
          }
          await watchAgentRoom(roomData, maxRounds, payloadText);
        } catch (err) {
          showError(err instanceof Error ? err.message : "Network request failed.");
        } finally {
          runBtn.disabled = false;
          runBtn.firstChild.textContent = idleBtnLabel();
        }
        return;
      }

      runBtn.disabled = true;
      runBtn.firstChild.textContent = "Fighting… ";
      results.hidden = false;
      clearNode(targets.verdictEl);
      targets.verdictEl.className = "";
      clearNode(targets.timelineEl);
      targets.nextEl.hidden = true;
      targets.evidenceEl.hidden = true;
      showProgress(true, { maxRounds, redName: payloadText ? "You + " + shortModel(redModelName) : undefined });
      results.scrollIntoView({ behavior: "smooth", block: "start" });

      const body = {
        presetId: p.value,
        customPrompt: p.value === "custom" ? textarea.value : undefined,
        targetModel: p.value !== "endpoint" && model ? model.value : undefined,
        endpoint:
          p.value === "endpoint"
            ? {
                url: endpointUrl.value.trim(),
                secret: endpointSecret && endpointSecret.value ? endpointSecret.value : undefined,
                rulebookPresetId: rulebook ? rulebook.value : "momentum_sniper",
              }
            : undefined,
        customPayload: payloadText || undefined,
        attackerBrief: briefText || undefined,
        scenarioId: s.value,
        maxRounds,
        includeCleanBenchmark: $("#opt-clean").checked,
        persistPrompt: $("#opt-persist").checked,
        publicOptIn: $("#opt-public").checked,
      };

      try {
        const resp = await fetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify(body),
        });
        const isStream = (resp.headers.get("content-type") || "").includes("text/event-stream");
        if (!isStream || !resp.body) {
          const data = await resp.json();
          if (data.run) {
            if (battle) {
              data.run.rounds.forEach((r) => battle.round(r));
              await battle.finish(data.run);
            }
            renderRun(data.run, targets, callbacks);
          } else {
            showError((data.error && data.error.message) || "Run creation failed.");
          }
          return;
        }

        let finalRun = null;
        let streamError = null;
        await readEventStream(resp, (event, data) => {
          if (!battle) return;
          if (event === "phase") battle.phase(data);
          else if (event === "round") battle.round(data);
          else if (event === "done") finalRun = data.run;
          else if (event === "error") streamError = data.message;
        });
        if (finalRun) {
          if (battle) await battle.finish(finalRun);
          renderRun(finalRun, targets, callbacks);
          targets.verdictEl.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          showError(streamError || "The match ended without a result.");
        }
      } catch (err) {
        showError(err instanceof Error ? err.message : "Network request failed.");
      } finally {
        runBtn.disabled = false;
        runBtn.firstChild.textContent = idleBtnLabel();
      }
    });

    function bindCopy(btn, getText, defaultLabel) {
      if (!btn) return;
      btn.addEventListener("click", () => {
        const val = getText();
        if (!val) return;
        navigator.clipboard.writeText(val).then(() => {
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = defaultLabel;
          }, 1400);
        });
      });
    }
    bindCopy(plCopyCode, () => (plCode ? plCode.textContent : ""), "Copy code");
    bindCopy(plCopyPrompt, () => (plAgentPrompt ? plAgentPrompt.textContent : ""), "Copy prompt");
    bindCopy(plCopyCli, () => (plCliCmd ? plCliCmd.textContent : ""), "Copy command");

    if (plCancel) {
      plCancel.addEventListener("click", async () => {
        const code = activeRoomCode;
        activeRoomCode = null;
        if (activeRoomAbort) {
          activeRoomAbort.abort();
          activeRoomAbort = null;
        }
        if (activeRoomCountdown) {
          clearInterval(activeRoomCountdown);
          activeRoomCountdown = null;
        }
        if (pairingLobby) pairingLobby.hidden = true;
        if (battle) battle.hide();
        if (code) {
          await fetch(`/api/agent/rooms/${encodeURIComponent(code)}`, { method: "DELETE" }).catch(() => {});
        }
        runBtn.disabled = false;
        runBtn.firstChild.textContent = idleBtnLabel();
      });
    }

    async function watchAgentRoom(roomData, fallbackMaxRounds, payloadText) {
      const code = roomData.roomCode;
      activeRoomCode = code;
      const origin = window.location.origin;

      if (pairingLobby) {
        pairingLobby.classList.remove("is-joined");
        pairingLobby.hidden = false;
        if (plStatus) plStatus.textContent = "WAITING FOR LIVE AGENT";
        if (plCode) plCode.textContent = code;
        if (plAgentPrompt) {
          plAgentPrompt.textContent =
            roomData.agentPrompt ||
            `Read ${origin}/skill.md and join Elenchi Arena room ${code} to test your trading policy.`;
        }
        if (plCliCmd) {
          plCliCmd.textContent =
            roomData.cliCommand || `npx tsx scripts/connect-agent.ts --code ${code} --url ${origin}`;
        }
        if (plCancel) plCancel.hidden = false;
      }

      const expMs = Date.parse(roomData.expiresAtIso || "") || Date.now() + 900_000;
      const updateTimer = () => {
        if (!plTimer) return;
        const remSec = Math.max(0, Math.floor((expMs - Date.now()) / 1000));
        const mm = String(Math.floor(remSec / 60)).padStart(2, "0");
        const ss = String(remSec % 60).padStart(2, "0");
        plTimer.textContent = `${mm}:${ss}`;
      };
      updateTimer();
      activeRoomCountdown = setInterval(updateTimer, 1000);

      results.hidden = false;
      results.scrollIntoView({ behavior: "smooth", block: "start" });

      const abortCtrl = new AbortController();
      activeRoomAbort = abortCtrl;
      runBtn.firstChild.textContent = "Waiting for agent… ";

      let battleStarted = false;
      let finalRun = null;
      let streamError = null;

      try {
        const resp = await fetch(`/api/agent/rooms/${encodeURIComponent(code)}/events`, {
          headers: { Accept: "text/event-stream" },
          signal: abortCtrl.signal,
        });
        if (!resp.ok || !resp.body) {
          const errJson = await resp.json().catch(() => ({}));
          showError((errJson.error && errJson.error.message) || "Room stream closed.");
          return;
        }

        await readEventStream(resp, (event, data) => {
          if (event === "joined") {
            if (pairingLobby) pairingLobby.classList.add("is-joined");
            if (plStatus) plStatus.textContent = `AGENT CONNECTED · ${data.agentName || "live-agent"}`;
            if (plCancel) plCancel.hidden = true;
            runBtn.firstChild.textContent = "Fighting… ";
            if (battle && !battleStarted) {
              battleStarted = true;
              battle.start({
                redName: payloadText ? "You + " + shortModel(redModelName) : shortModel(redModelName),
                blueName: data.agentName || "live-agent",
                maxRounds: fallbackMaxRounds || 2,
              });
            }
          } else if (event === "start") {
            if (pairingLobby) pairingLobby.classList.add("is-joined");
            const blue = (data.defender && data.defender.agentName) || "live-agent";
            const red = shortModel(data.redModel || redModelName);
            if (battle && !battleStarted) {
              battleStarted = true;
              battle.start({
                redName: red,
                blueName: blue,
                maxRounds: data.maxRounds || fallbackMaxRounds || 2,
              });
            } else if (battle) {
              battle.setFighters({ redName: red, blueName: blue });
            }
          } else if (event === "phase" && battle) {
            battle.phase(data);
          } else if (event === "round" && battle) {
            battle.round(data);
          } else if (event === "done") {
            finalRun = data.run;
          } else if (event === "error") {
            streamError = data.message;
          }
        });

        if (activeRoomCountdown) {
          clearInterval(activeRoomCountdown);
          activeRoomCountdown = null;
        }

        if (finalRun) {
          if (pairingLobby) pairingLobby.hidden = true;
          if (battle) await battle.finish(finalRun);
          renderRun(finalRun, targets, callbacks);
          targets.verdictEl.scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (!abortCtrl.signal.aborted) {
          showError(streamError || "The room closed before a verdict was reached.");
        }
      } catch (err) {
        if (!abortCtrl.signal.aborted) {
          showError(err instanceof Error ? err.message : "Lost connection to pairing room.");
        }
      } finally {
        if (activeRoomCountdown) {
          clearInterval(activeRoomCountdown);
          activeRoomCountdown = null;
        }
      }
    }

    if (watchParam) {
      const watchRadio = form.querySelector('input[name="preset"][value="live_agent"]');
      if (watchRadio) {
        watchRadio.checked = true;
        sync();
      }
      fetch(`/api/agent/rooms/${encodeURIComponent(watchParam)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((info) => {
          if (info && info.roomCode) {
            watchAgentRoom(info, 2, "");
          }
        })
        .catch(() => {});
    }
  }

  // ───────────── /run permalink ─────────────
  function initRunViewer() {
    const rootEl = $("#run-viewer-root");
    if (!rootEl) return;
    const targets = {
      verdictEl: $("#run-verdict"),
      timelineEl: $("#run-timeline"),
      nextEl: null,
      evidenceEl: $("#run-evidence"),
    };
    const params = new URLSearchParams(window.location.search);
    const pathMatch = window.location.pathname.match(/^\/run\/([0-9a-fA-F-]{36})$/);
    const runId = (pathMatch && pathMatch[1]) || params.get("id");

    function message(text) {
      clearNode(targets.verdictEl);
      targets.verdictEl.className = "verdict is-unknown";
      targets.verdictEl.appendChild(el("p", { className: "verdict-sub", textContent: text }));
    }

    if (!runId) {
      message("Open a run from the Arena, or add ?id=<run-uuid> to this URL.");
      return;
    }

    fetch(`/api/runs/${encodeURIComponent(runId)}`)
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
        if (!ok || !body.run) {
          message((body.error && body.error.message) || "Run not found, or it is private to another session.");
          return;
        }
        renderRun(body.run, targets, null);
      })
      .catch((err) => message(err instanceof Error ? err.message : "Failed to load run."));
  }

  // ───────────── /protocol attestation feed ─────────────
  function initProtocolFeed() {
    const feedBody = $("#attestations-feed-body");
    if (!feedBody) return;

    function row(text) {
      clearNode(feedBody);
      feedBody.appendChild(el("tr", {}, [el("td", { colspan: "5", className: "micro", textContent: text })]));
    }

    fetch("/api/attestations")
      .then((r) => r.json())
      .then((data) => {
        if (!data.deployed) {
          row("ElenchiArena.sol is not deployed to Robinhood Chain yet. This feed stays empty until it is — zero fabricated attestations.");
          return;
        }
        if (!data.items || data.items.length === 0) {
          row(`Connected to ${data.contractAddress} on chain ${data.chainId}. No AttestationRegistered events in the last 25,000 blocks.`);
          return;
        }
        clearNode(feedBody);
        for (const item of data.items) {
          const outcomeClass = item.outcomeLabel === "BREACHED" ? "badge-breach" : item.outcomeLabel === "PASSED_SUITE" ? "badge-pass" : "badge-warn";
          feedBody.appendChild(
            el("tr", {}, [
              el("td", { className: "micro", textContent: `${item.runId.slice(0, 18)}…` }),
              el("td", {}, [el("span", { className: `badge ${outcomeClass}`, textContent: item.outcomeLabel })]),
              el("td", { className: "micro", textContent: shortAddr(item.sandboxSigner) }),
              el("td", { className: "micro", textContent: `#${item.blockNumber} (${item.confirmations} conf)` }),
              el("td", {}, [
                el("a", { href: item.explorerTxUrl, target: "_blank", rel: "noopener", className: "text-link", textContent: `${item.txHash.slice(0, 12)}…` }),
              ]),
            ])
          );
        }
      })
      .catch(() => row("Could not reach the attestation feed."));
  }

  // ───────────── Copy CA (active only after verified manual Pons launch) ─────────────
  function initCopyButtons() {
    document.querySelectorAll("[data-copy-ca]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ca = window.ELENCHI_CONFIG && window.ELENCHI_CONFIG.CA;
        if (!ca) return;
        navigator.clipboard.writeText(ca).then(() => {
          const orig = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = orig;
          }, 1400);
        });
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initNetworkStatus();
    initHeroWindow();
    initArena();
    initRunViewer();
    initProtocolFeed();
    initCopyButtons();
  });
})();

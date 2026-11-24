import { describe, expect, it } from "vitest";
import {
  GITHUB_SLUG,
  GITHUB_URL,
  PRELAUNCH_TOKEN_CONFIG,
  TOKEN_SYMBOL,
  TOKEN_TICKER,
  TWITTER_HANDLE,
  TWITTER_URL,
  renderSiteArtifacts,
} from "../scripts/build-site";
import {
  extractTokenAddressFromArgs,
  renderCloudflareTokenBindings,
} from "../scripts/bind-pons-token";

describe("Token fast-release, X & GitHub links, and $ELCHI ticker", () => {
  it("renders PRELAUNCH state cleanly with NickCertina/Elenchi, @Elenchi_rbh, and $ELCHI across all pages", () => {
    expect(GITHUB_SLUG).toBe("NickCertina/Elenchi");
    expect(GITHUB_URL).toBe("https://github.com/NickCertina/Elenchi");
    expect(TWITTER_HANDLE).toBe("@Elenchi_rbh");
    expect(TWITTER_URL).toBe("https://x.com/Elenchi_rbh");
    expect(TOKEN_SYMBOL).toBe("ELCHI");
    expect(TOKEN_TICKER).toBe("$ELCHI");

    const { pages, configJs } = renderSiteArtifacts(PRELAUNCH_TOKEN_CONFIG, "testver1");

    for (const [name, html] of Object.entries(pages)) {
      expect(html, `${name} should point to ${GITHUB_URL}`).toContain(GITHUB_URL);
      expect(html, `${name} should point to ${TWITTER_URL}`).toContain(TWITTER_URL);
      expect(html, `${name} should include ${TWITTER_HANDLE}`).toContain(TWITTER_HANDLE);
      expect(html, `${name} must not contain old X handle`).not.toContain("Elenchi_dev");
      expect(html, `${name} must not contain old ticker`).not.toContain("$ELENCHI");

      const ghLinks = html.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g) ?? [];
      expect(ghLinks.length, `${name} should include GitHub links`).toBeGreaterThan(0);
      for (const link of ghLinks) {
        expect(link).toBe(GITHUB_URL);
      }
      expect(html).toContain(`config.js?v=testver1`);
    }

    expect(pages["index.html"]).toContain('id="hero-pons-btn"');
    expect(pages["index.html"]).toContain('id="hero-token-slot"');
    expect(pages["index.html"]).toContain('data-token-state="PRELAUNCH"');
    expect(pages["index.html"]).toContain("$ELCHI");
    expect(pages["token.html"]).toContain("$ELCHI");
    expect(pages["token.html"]).toContain(GITHUB_SLUG);
    expect(configJs).toContain(`ticker: "$ELCHI"`);
    expect(configJs).toContain(`tokenLaunchState: "PRELAUNCH"`);
    expect(configJs).toContain(`CA: null`);
    expect(configJs).toContain(`contract: null`);
    expect(configJs).toContain(TWITTER_URL);
    expect(configJs).toContain(GITHUB_URL);
    expect(configJs).not.toContain("Elenchi_dev");
    expect(configJs).not.toContain("$ELENCHI");
  });

  it("extracts 40-hex CA from raw address or Pons URL while ignoring 64-hex tx hashes", () => {
    const txHash = "0x" + "ab".repeat(32);
    const caRaw = "0x0000000000000000000000000000000000e1e999";

    expect(extractTokenAddressFromArgs([txHash])).toBeNull();
    expect(extractTokenAddressFromArgs(["--tx", txHash, caRaw])).toBe(
      "0x0000000000000000000000000000000000E1e999"
    );
    expect(
      extractTokenAddressFromArgs([`--tx=${txHash}`, `https://ponsfamily.com/launchpad/${caRaw}`])
    ).toBe("0x0000000000000000000000000000000000E1e999");
  });

  it("renders LIVE state in memory with CA text and Buy on Pons links directly in HERO, index.html, token.html, and config.js", () => {
    const syntheticAddr = extractTokenAddressFromArgs([
      "https://ponsfamily.com/launchpad/0x0000000000000000000000000000000000e1e999",
    ])!;
    const ponsHref = `https://ponsfamily.com/launchpad/${syntheticAddr}`;

    const { pages, configJs } = renderSiteArtifacts(
      {
        state: "LIVE",
        ca: syntheticAddr,
        ponsUrl: ponsHref,
        launchTx: null,
        ponsFactory: null,
        ponsVersion: "V2_CURVE",
        symbol: "ELCHI",
        totalSupplyFormatted: "1000000000",
      },
      "livever2"
    );

    const indexHtml = pages["index.html"]!;
    const tokenHtml = pages["token.html"]!;

    expect(indexHtml).toContain(
      `<a href="${ponsHref}" target="_blank" rel="noopener" class="btn btn-lg btn-pons" id="hero-pons-btn"`
    );
    expect(indexHtml).toContain(`<span class="hero-ca-v mono" data-ca-value>${syntheticAddr}</span>`);
    expect(indexHtml).toContain("$ELCHI OFFICIAL CONTRACT");
    expect(indexHtml).toContain(`data-token-state="LIVE"`);

    expect(tokenHtml).toContain(syntheticAddr);
    expect(tokenHtml).toContain(`href="${ponsHref}" target="_blank" rel="noopener"`);
    expect(tokenHtml).toContain("$ELCHI");

    expect(indexHtml).toContain(`config.js?v=livever2`);
    expect(configJs).toContain(`ticker: "$ELCHI"`);
    expect(configJs).toContain(`tokenLaunchState: "LIVE"`);
    expect(configJs).toContain(`CA: "${syntheticAddr}"`);
    expect(configJs).toContain(`contract: "${syntheticAddr}"`);
    expect(configJs).toContain(`ponsLaunchpadUrl: "${ponsHref}"`);

    const cfBindings = renderCloudflareTokenBindings({
      state: "LIVE",
      ca: syntheticAddr,
      ponsUrl: ponsHref,
      launchTx: null,
      ponsFactory: null,
      ponsVersion: "V2_CURVE",
      symbol: "ELCHI",
      totalSupplyFormatted: "1000000000",
    });
    expect(cfBindings).toContain(`TOKEN_LAUNCH_STATE: bindings.text("LIVE")`);
    expect(cfBindings).toContain(`ELENCHI_TOKEN_ADDRESS: bindings.text("${syntheticAddr}")`);
    expect(cfBindings).toContain(`ELENCHI_PONS_TRADING_URL: bindings.text("${ponsHref}")`);
  });
});

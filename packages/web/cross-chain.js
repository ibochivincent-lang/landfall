/**
 * cross-chain.js — renders the cross-chain evidence view.
 *
 * Reads the artifact written by scripts/cross-chain-scan.ts. Every number on
 * this page is rendered next to the evidence tier that backs it, because
 * MULTICHAIN.md §4 makes that a hard rule rather than a presentation
 * preference: an unlabelled figure here would imply a claim the data can't
 * support.
 *
 * Nothing is hardcoded. If the artifact can't be loaded the page says so
 * instead of showing a shape with no data in it.
 */
(function () {
  'use strict';

  var SOURCE = 'api/v1/cross-chain.json';

  var TIER_CLASS = { PROVEN: 'tier--proven', ATTESTED: 'tier--attested', DERIVED: 'tier--derived' };
  var TIER_BLURB = {
    PROVEN:
      'Read straight off an immutable, publicly replayable ledger with standardized events. ' +
      'Every one of these carries a transaction hash you can check yourself.',
    ATTESTED:
      'Backed by a signed, independently verifiable cross-chain artifact — a Circle CCTP burn ' +
      'plus its Iris attestation. Not ledger-proven, but not taken on trust either.',
    DERIVED:
      'A visible on-chain transfer bound to an off-chain proof of a custodial fiat leg. ' +
      'The weakest tier on the ladder, and never presented as anything else.'
  };

  function $(sel) { return document.querySelector(sel); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function tierChip(tier) {
    return el('span', 'tier ' + (TIER_CLASS[tier] || 'tier--derived'), tier);
  }

  function ago(iso) {
    var ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms)) return 'unknown';
    var m = Math.round(ms / 60000);
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  /* ------------------------------------------------------------- rendering */

  function renderAttester(attester) {
    var box = $('#attester');
    var head = el('div', 'attester__head');
    head.appendChild(el('span', null, 'STP attestations'));
    head.appendChild(el('span', 'attester__state', attester.signed ? 'signed' : 'unsigned'));
    head.appendChild(el('span', 'attester__state', 'signer: ' + attester.signer));
    box.appendChild(head);
    box.appendChild(el('p', null, attester.note));
  }

  function renderTotals(totals, window_) {
    var wrap = $('#totals');
    ['PROVEN', 'ATTESTED', 'DERIVED'].forEach(function (tier) {
      var stat = el('div', 'stat');
      stat.appendChild(el('div', 'stat__v', totals[tier] != null ? totals[tier] : 0));
      var k = el('div', 'stat__k');
      k.appendChild(tierChip(tier));
      stat.appendChild(k);
      stat.appendChild(el('div', 'stat__n', 'settlement events'));
      wrap.appendChild(stat);
    });

    $('#windowNote').textContent =
      'Scan window: the last ' + window_.days + ' days (since ' + window_.since.slice(0, 10) + '), ' +
      'up to ' + window_.maxRecordsPerAccount + ' records per account. A count at that ceiling is a ' +
      'floor, not a total.';
  }

  function renderLadder(chainsInScope) {
    var wrap = $('#ladder');
    ['PROVEN', 'ATTESTED', 'DERIVED'].forEach(function (tier) {
      var chains = chainsInScope
        .filter(function (c) { return c.maxTier === tier; })
        .map(function (c) { return c.chain; });

      var step = el('div', 'ladder__step');
      step.appendChild(tierChip(tier));
      step.appendChild(el('p', null, TIER_BLURB[tier]));
      step.appendChild(el('p', null, 'Chains capped at this tier: ' + (chains.join(', ') || 'none')));
      wrap.appendChild(step);
    });
  }

  function renderChainRow(chain) {
    var row = el('div', 'chain-row');
    row.appendChild(el('div', 'chain-row__name', chain.chain));

    var tierCell = el('div', null);
    tierCell.appendChild(tierChip(chain.maxTier));
    row.appendChild(tierCell);

    var count = el('div', 'chain-row__count', chain.events);
    row.appendChild(count);

    var right = el('div', null);
    right.appendChild(el('span', 'state state--' + chain.state, chain.state));
    if (chain.note) {
      var note = el('div', 'chain-row__note', chain.note);
      right.appendChild(note);
    }
    row.appendChild(right);
    return row;
  }

  function renderAssets(tiers) {
    var withVolume = tiers.filter(function (t) { return t.byAsset && t.byAsset.length; });
    if (!withVolume.length) return null;

    var box = el('div', 'assets');
    box.appendChild(el('div', 'assets__head', 'Volume by asset — kept per asset, never summed across them'));

    withVolume.forEach(function (tier) {
      tier.byAsset.forEach(function (asset) {
        var row = el('div', 'asset-row');
        row.appendChild(el('div', 'asset-row__code', asset.asset));
        row.appendChild(el('div', 'asset-row__count', asset.count + '×'));
        var vol = el('div', 'asset-row__vol');
        vol.appendChild(document.createTextNode(asset.volume + '  '));
        vol.appendChild(tierChip(tier.tier));
        row.appendChild(vol);
        box.appendChild(row);
      });
    });

    return box;
  }

  function renderAttestations(samples) {
    if (!samples || !samples.length) return null;

    var details = el('details', 'attn');
    details.appendChild(el('summary', null, 'Show ' + samples.length + ' sample STP attestation' + (samples.length === 1 ? '' : 's')));
    var body = el('div', 'attn__body');

    samples.forEach(function (sample) {
      var a = sample.attestation;
      body.appendChild(el('p', 'attn__meta', 'digest (sha256 of canonical form): ' + sample.digest));
      body.appendChild(el('pre', null, JSON.stringify(a, null, 2)));

      if (a.chain === 'stellar' && a.onchain_ref) {
        var p = el('p', 'attn__verify');
        p.appendChild(document.createTextNode('Verify independently: '));
        var link = el('a', null, 'stellar.expert → ' + a.onchain_ref.slice(0, 16) + '…');
        link.href = 'https://stellar.expert/explorer/public/tx/' + encodeURIComponent(a.onchain_ref);
        link.target = '_blank';
        link.rel = 'noopener';
        p.appendChild(link);
        body.appendChild(p);
      }
    });

    details.appendChild(body);
    return details;
  }

  function renderAnchor(anchor) {
    var card = el('div', 'xc-anchor');

    var head = el('div', 'xc-anchor__head');
    head.appendChild(el('h2', 'xc-anchor__id', anchor.anchorId));
    head.appendChild(el('span', 'xc-anchor__mix', anchor.summary.tierMix));
    card.appendChild(head);

    var identity =
      'Identity resolved via ' +
      (anchor.identitySource === 'sep1' ? 'SEP-1 stellar.toml' : 'the last committed ledger scan') +
      ' · ' + anchor.stellarAccounts.length + ' declared Stellar account' +
      (anchor.stellarAccounts.length === 1 ? '' : 's');
    card.appendChild(el('p', 'xc-anchor__note', anchor.identityNote ? identity + ' — ' + anchor.identityNote : identity));

    // Chains that were actually scanned get a row each. The unresolved ones
    // are collapsed behind a single line: with seven of them repeating the
    // same sentence per anchor, the honest detail was drowning out the
    // measurements. It stays one click away, reason text intact — summarised,
    // not dropped.
    var scanned = anchor.summary.chains.filter(function (c) { return c.state !== 'unresolved'; });
    var unresolved = anchor.summary.chains.filter(function (c) { return c.state === 'unresolved'; });

    scanned.forEach(function (chain) { card.appendChild(renderChainRow(chain)); });

    if (unresolved.length) {
      var details = el('details', 'attn');
      var names = unresolved.map(function (c) { return c.chain; }).join(', ');
      details.appendChild(
        el('summary', null, unresolved.length + ' chain' + (unresolved.length === 1 ? '' : 's') +
          ' unresolved — no address curated for this anchor (' + names + ')')
      );
      var body = el('div', 'attn__body');
      unresolved.forEach(function (chain) { body.appendChild(renderChainRow(chain)); });
      details.appendChild(body);
      card.appendChild(details);
    }

    var assets = renderAssets(anchor.summary.tiers);
    if (assets) card.appendChild(assets);

    if (anchor.failures && anchor.failures.length) {
      var fail = el('div', 'assets');
      fail.appendChild(el('div', 'assets__head', 'Scan failures — surfaced, not swallowed'));
      anchor.failures.forEach(function (f) {
        fail.appendChild(el('div', 'chain-row__note', f.chain + ': ' + f.error));
      });
      card.appendChild(fail);
    }

    var attn = renderAttestations(anchor.sampleAttestations);
    if (attn) card.appendChild(attn);

    return card;
  }

  /* Bridge trust registry — read from registry/bridges.json, published as an
     artifact so the claims are citable and correctable rather than prose baked
     into a page. Rendered separately from the scan because it describes what a
     path can prove in principle, not what was measured this hour. */
  function renderBridges(paths) {
    var wrap = $('#bridges');
    if (!wrap || !paths || !paths.length) return;

    paths.forEach(function (p) {
      var row = el('div', 'trust-row');

      var head = el('div', 'trust-row__head');
      head.appendChild(el('span', 'trust-row__name', p.name));
      head.appendChild(tierChip(p.maxTier));
      head.appendChild(el('span', 'trust-row__mech', p.mechanism));
      if (p.landfallCanVerify) {
        head.appendChild(el('span', 'trust-row__flag is-verifiable', 'independently checkable'));
      }
      row.appendChild(head);

      row.appendChild(el('p', 'trust-row__trusts', 'You are trusting: ' + p.trusts));
      row.appendChild(el('p', 'trust-row__how', p.howItWorks));
      if (p.whyNotProven) row.appendChild(el('p', 'trust-row__why', p.whyNotProven));

      (p.incidents || []).forEach(function (inc) {
        var box = el('div', 'trust-row__incident');
        box.appendChild(document.createTextNode(inc.date + ' — ' + inc.summary + ' '));
        if (inc.source) {
          var a = el('a', null, 'source');
          a.href = inc.source;
          a.target = '_blank';
          a.rel = 'noopener';
          box.appendChild(a);
        }
        row.appendChild(box);
      });

      if (p.sources && p.sources.length) {
        var src = el('div', 'trust-row__sources');
        src.appendChild(document.createTextNode('Reference: '));
        p.sources.forEach(function (s, i) {
          if (i) src.appendChild(document.createTextNode(' · '));
          var a = el('a', null, s.label);
          a.href = s.url;
          a.target = '_blank';
          a.rel = 'noopener';
          src.appendChild(a);
        });
        row.appendChild(src);
      }

      wrap.appendChild(row);
    });
  }

  function renderRanked(ranked) {
    var wrap = $('#ranked');
    ranked.forEach(function (row, i) {
      var item = el('div', 'chain-row');
      item.appendChild(el('div', 'chain-row__name', (i + 1) + '. ' + row.anchorId));
      var mix = el('div', 'chain-row__count', row.evidence.PROVEN);
      item.appendChild(mix);
      var tierCell = el('div', null);
      tierCell.appendChild(tierChip('PROVEN'));
      item.appendChild(tierCell);
      item.appendChild(el('div', 'chain-row__note', row.rationale));
      wrap.appendChild(item);
    });
  }

  /* ----------------------------------------------------------------- boot */

  function fail(message) {
    $('#live').hidden = true;
    $('#offline').hidden = false;
    $('#offlineDetail').textContent = message;
    var f = $('#freshness');
    f.textContent = 'Data unavailable';
    f.className = 'freshness';
  }

  async function boot() {
    var body;
    try {
      var res = await fetch(SOURCE, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' on ' + SOURCE);
      body = await res.json();
      if (!body.anchors || !body.anchors.length) throw new Error('artifact contains no anchors');
    } catch (err) {
      return fail(String((err && err.message) || err));
    }

    var f = $('#freshness');
    f.textContent = 'Cross-chain scan · ' + ago(body.generatedAt);
    f.className = 'freshness is-live';

    renderAttester(body.attester);
    renderTotals(body.totals, body.window);
    renderLadder(body.chainsInScope);

    // Independent of the scan: a failure to load the trust registry must not
    // blank the measurements, and stale measurements must not hide the
    // registry. They answer different questions.
    fetch('api/v1/bridges.json', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (reg) { if (reg) renderBridges(reg.paths); })
      .catch(function () { /* section simply stays empty */ });

    renderRanked(body.ranked || []);

    var list = $('#anchors');
    body.anchors.forEach(function (anchor) {
      list.appendChild(renderAnchor(anchor));
    });

    $('#live').hidden = false;
    $('#offline').hidden = true;
  }

  boot();
})();

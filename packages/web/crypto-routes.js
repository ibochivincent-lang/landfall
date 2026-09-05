/* ── Crypto Routes — crypto-routes.js ─────────────────────────────────────
   Live quotes between XLM and BTC/ETH/SOL/BNB Smart Chain/USDT/Sui/
   Avalanche/Polygon/Arbitrum/Base, in either direction, via NEAR Intents'
   public 1Click swap API
   (https://1click.chaindefuser.com). No API key, no backend — this is a
   plain client-side fetch, same trust model as the rest of Route Scout.

   Two modes:
     - Quote (runCryptoQuote): a `dry: true` price check using fixed
       placeholder recipient/refundTo fields, purely to price a route. No
       funds move, no wallet needed. Works in both directions, every chain.
     - Execute (reviewAndSend / executeStellarDeposit / executeEvmDeposit,
       below): non-custodial in both directions, but only where a signing
       wallet actually exists for the origin side:
         - Stellar origin (XLM -> chain): Freighter or Lobstr build+sign a
           Stellar payment + memo; Landfall submits the signed XDR.
         - EVM origin (ETH/BSC/AVAX/POL/Arbitrum/Base/USDT -> XLM): any
           EIP-6963-announcing wallet (MetaMask, Trust Wallet, etc.) via
           `eth_sendTransaction` — a plain value transfer for a chain's native
           coin, an ERC-20 `transfer()` call for USDT. The wallet builds,
           signs and broadcasts in one call; Landfall never sees a key.
         - BTC, Solana and Sui origins are quote-only: no wallet for those
           chains is wired up yet. Shown as an honest gap in the UI rather
           than a disabled button with no explanation.
       Landfall's own code never holds a private key or the funds at any
       point in either path — the same trust model as any DEX frontend. See
       the block comments above `WALLETS` (Stellar) and `discoverEvmProviders`
       (EVM) for the non-custody argument in each case.

   Scope gaps, each verified rather than assumed:
     - Stellar-side USDC isn't offered. NEAR Intents' Stellar-side USDC is a
       Soroban-wrapped token that needs an existing contract balance before
       the API will quote a refund path — no ledger account holds one yet, so
       every USDC-origin quote fails with "no trustline".
     - USDT is offered on Ethereum, not Tron, even though Landfall tracks Tron
       elsewhere — the XLM→USDT(Tron) route returned a server error from NEAR
       Intents on every amount tried, while the identical request against
       Ethereum succeeded immediately. That looks like a gap on their side,
       not a mistake in this request; Ethereum USDT is what's offered instead.
     - WalletConnect isn't wired up. It needs a Project ID from
       cloud.walletconnect.com, which is a free signup but one only the site
       owner can complete — there's no way to obtain one on a user's behalf,
       and shipping a "Connect via WalletConnect" button with no real Project
       ID behind it would be a button that looks like it works and doesn't.
     - EVM-origin execution needs the connected wallet on the correct chain
       (e.g. Base, not Ethereum mainnet) — executeEvmDeposit prompts a chain
       switch via wallet_switchEthereumChain before sending, but this whole
       path is unverifiable end-to-end without a funded browser wallet, same
       limitation as the Stellar path.
   ────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var QUOTE_URL = 'https://1click.chaindefuser.com/v0/quote';
  var STATUS_URL = 'https://1click.chaindefuser.com/v0/status';
  var HORIZON_URL = 'https://horizon.stellar.org';
  var STELLAR_SDK_URL = 'https://cdn.jsdelivr.net/npm/@stellar/stellar-sdk@17.0.1/+esm';
  var LOBSTR_SDK_URL = 'https://cdn.jsdelivr.net/npm/@lobstrco/signer-extension-api@2.1.0/+esm';

  /** A real, active, publicly-tracked Stellar account (cowrie.exchange) used
   *  only as a pricing placeholder for dry quotes — never a real destination,
   *  since dry-run quotes never move funds. */
  var REFUND_FROM = 'GAWODAROMJ33V5YDFY3NPYTHVYQG7MJXVJ2ND3AOGIHYRWINES6ACCPD';
  var XLM_ASSET    = 'nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz';
  var XLM_DECIMALS = 7;

  /** Each entry doubles as a destination (XLM → chain) and, reversed, as an
   *  origin (chain → XLM) — the 1Click API takes origin/destination asset ids
   *  symmetrically, so one table covers both directions. `placeholder` is a
   *  real, inert address on that chain used only to price dry quotes. */
  var CHAINS = {
    btc: {
      label: 'Bitcoin', symbol: 'BTC', icon: '₿',
      assetId: 'nep141:btc.omft.near', decimals: 8,
      placeholder: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
      addrRe: /^(1[a-km-zA-HJ-NP-Z1-9]{25,34}|3[a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{11,71})$/,
      addrHint: 'Starts with 1, 3, or bc1.',
    },
    eth: {
      label: 'Ethereum', symbol: 'ETH', icon: 'Ξ',
      assetId: 'nep141:eth.omft.near', decimals: 18,
      placeholder: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
      addrRe: /^0x[a-fA-F0-9]{40}$/,
      addrHint: 'A 42-character 0x… address.',
      walletKind: 'evm', chainId: 1, rpcUrl: 'https://eth.llamarpc.com', explorerUrl: 'https://etherscan.io',
    },
    sol: {
      label: 'Solana', symbol: 'SOL', icon: '◎',
      assetId: 'nep141:sol.omft.near', decimals: 9,
      placeholder: '11111111111111111111111111111112',
      addrRe: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
      addrHint: 'A base58 Solana address.',
    },
    bsc: {
      label: 'BNB Smart Chain', symbol: 'BNB', icon: '◆',
      assetId: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', decimals: 18,
      placeholder: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
      addrRe: /^0x[a-fA-F0-9]{40}$/,
      addrHint: 'A 42-character 0x… address (same format as Ethereum).',
      walletKind: 'evm', chainId: 56, rpcUrl: 'https://bsc-dataseed.binance.org', explorerUrl: 'https://bscscan.com',
    },
    usdt: {
      label: 'USDT (Ethereum)', symbol: 'USDT', icon: '₮',
      assetId: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near', decimals: 6,
      placeholder: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
      addrRe: /^0x[a-fA-F0-9]{40}$/,
      addrHint: 'A 42-character 0x… Ethereum address.',
      walletKind: 'evm', chainId: 1, rpcUrl: 'https://eth.llamarpc.com', explorerUrl: 'https://etherscan.io',
      tokenContract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    },
    sui: {
      label: 'Sui', symbol: 'SUI', icon: '◈',
      assetId: 'nep141:sui.omft.near', decimals: 9,
      placeholder: '0x0000000000000000000000000000000000000000000000000000000000000001',
      addrRe: /^0x[a-fA-F0-9]{64}$/,
      addrHint: 'A 66-character 0x… Sui address (32 bytes).',
    },
    avax: {
      label: 'Avalanche', symbol: 'AVAX', icon: '▲',
      assetId: 'nep245:v2_1.omni.hot.tg:43114_11111111111111111111', decimals: 18,
      placeholder: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
      addrRe: /^0x[a-fA-F0-9]{40}$/,
      addrHint: 'A 42-character 0x… address (same format as Ethereum).',
      walletKind: 'evm', chainId: 43114, rpcUrl: 'https://api.avax.network/ext/bc/C/rpc', explorerUrl: 'https://snowtrace.io',
    },
    pol: {
      label: 'Polygon', symbol: 'POL', icon: '⬡',
      assetId: 'nep245:v2_1.omni.hot.tg:137_11111111111111111111', decimals: 18,
      placeholder: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
      addrRe: /^0x[a-fA-F0-9]{40}$/,
      addrHint: 'A 42-character 0x… address (same format as Ethereum).',
      walletKind: 'evm', chainId: 137, rpcUrl: 'https://polygon-rpc.com', explorerUrl: 'https://polygonscan.com',
    },
    arb: {
      label: 'ETH (Arbitrum)', symbol: 'ETH', icon: 'Ξ',
      assetId: 'nep141:arb.omft.near', decimals: 18,
      placeholder: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
      addrRe: /^0x[a-fA-F0-9]{40}$/,
      addrHint: 'A 42-character 0x… address on Arbitrum — not the same network as mainnet Ethereum.',
      walletKind: 'evm', chainId: 42161, rpcUrl: 'https://arb1.arbitrum.io/rpc', explorerUrl: 'https://arbiscan.io',
    },
    base: {
      label: 'ETH (Base)', symbol: 'ETH', icon: 'Ξ',
      assetId: 'nep141:base.omft.near', decimals: 18,
      placeholder: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
      addrRe: /^0x[a-fA-F0-9]{40}$/,
      addrHint: 'A 42-character 0x… address on Base — not the same network as mainnet Ethereum.',
      walletKind: 'evm', chainId: 8453, rpcUrl: 'https://mainnet.base.org', explorerUrl: 'https://basescan.org',
    },
  };

  var STELLAR_ADDR_RE = /^G[A-Z2-7]{55}$/;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function toBaseUnits(amount, decimals) {
    // String math, not float math — the rest of this codebase never lets a
    // token amount pass through a float, and a swap quote is not the place
    // to start.
    var parts = String(amount).split('.');
    var whole = parts[0] || '0';
    var frac = (parts[1] || '').slice(0, decimals).padEnd(decimals, '0');
    return BigInt(whole + frac).toString();
  }

  function fromBaseUnits(raw, decimals) {
    var s = BigInt(raw).toString().padStart(decimals + 1, '0');
    var whole = s.slice(0, s.length - decimals);
    var frac = s.slice(s.length - decimals).replace(/0+$/, '');
    return frac ? whole + '.' + frac : whole;
  }

  function timeLabel(seconds) {
    if (seconds < 60) return '~' + seconds + 's';
    return '~' + Math.round(seconds / 60) + ' min';
  }

  function friendlyError(message) {
    if (/too low|minimum/i.test(message)) return message + ' — try a larger amount.';
    if (/network|fetch|timeout/i.test(message)) return 'Could not reach the quote provider. Try again.';
    return message || 'The quote provider returned an error.';
  }

  /* ── Route resolution ───────────────────────────────────────────────────
     One pair of selects now drives everything: what you are sending and where
     it should end up. The old explicit direction toggle is gone because it was
     asking the user to restate something the two selections already say, and
     it could not express a journey that ends in cash at all.

     A destination prefixed `cash:` is a fiat corridor rather than a chain, and
     routes to the multi-leg path. Everything else is a swap. ──────────── */

  function routeFromKey() {
    var el = $('routeFrom');
    return el ? el.value : 'xlm';
  }

  /** The fiat corridor this route ends in, or null if it ends on a chain. */
  function destinationCorridor() {
    var el = $('cryptoDest');
    var v = el ? el.value : '';
    return v.indexOf('cash:') === 0 ? v.slice(5) : null;
  }

  function direction() {
    // Retained because the swap machinery below is written in these terms;
    // it is now derived from the selections rather than asked for.
    return routeFromKey() === 'xlm' ? 'toChain' : 'toStellar';
  }

  /** Which side of the swap is the origin the user must actually deposit
   *  from, and what kind of wallet can sign for it: 'stellar' (XLM -> chain,
   *  always executable via Freighter/Lobstr), 'evm' (chain -> XLM where that
   *  chain has a wired-up EIP-1193 wallet path), or null (chain -> XLM for
   *  BTC/Solana/Sui — quote-only, no wallet built for those yet). */
  function originKind() {
    // The origin is whatever the user is sending — that is the only side they
    // have to sign for, whether the route ends on a chain or in cash.
    var from = routeFromKey();
    if (from === 'xlm') return 'stellar';
    var chain = CHAINS[from];
    return (chain && chain.walletKind) || null;
  }

  /* ── Quote (informational, both directions) ─────────────────────────── */

  function showStatus(html) {
    $('cryptoResult').innerHTML = '<div class="status-msg">' + html + '</div>';
  }

  function showError(message) {
    $('cryptoResult').innerHTML = '<div class="crypto-error"><strong>Quote unavailable.</strong> ' + esc(message) + '</div>';
  }

  function renderQuote(chain, dir, amountIn, quote, correlationId) {
    var inSymbol = dir === 'toChain' ? 'XLM' : chain.symbol;
    var outSymbol = dir === 'toChain' ? chain.symbol : 'XLM';
    var outDecimals = dir === 'toChain' ? chain.decimals : XLM_DECIMALS;
    var amountOut = fromBaseUnits(quote.amountOut, outDecimals);
    var withdrawFee = fromBaseUnits(quote.withdrawFee || '0', outDecimals);
    var rate = Number(quote.amountOutFormatted) / Number(quote.amountInFormatted);
    var icon = dir === 'toChain' ? chain.icon : '✦';

    $('cryptoResult').innerHTML =
      '<div class="crypto-card">' +
        '<div>' +
          '<div class="cell-lbl">You Receive</div>' +
          '<span class="crypto-out">' + icon + ' ' + esc(amountOut) + ' ' + outSymbol + '</span>' +
          '<div class="cell-sub">≈ $' + Number(quote.amountOutUsd).toFixed(2) + ' · $' + Number(quote.amountInUsd).toFixed(2) + ' sent</div>' +
        '</div>' +
        '<div>' +
          '<div class="cell-lbl">Rate</div>' +
          '<div class="cell-val">1 ' + inSymbol + ' ≈ ' + rate.toFixed(8) + ' ' + outSymbol + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="cell-lbl">Network Withdraw Fee</div>' +
          '<div class="cell-val">' + esc(withdrawFee) + ' ' + outSymbol + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="cell-lbl">Est. Time</div>' +
          '<div class="cell-val">' + timeLabel(quote.timeEstimate) + '</div>' +
        '</div>' +
        '<div class="crypto-source">' +
          'Live quote from <a href="https://near-intents.org" target="_blank" rel="noopener">NEAR Intents</a>. ' +
          (dir === 'toChain' || chain.walletKind === 'evm'
            ? 'This price is informational — connect a wallet below to send it for real.'
            : 'Informational only. Sending ' + esc(chain.label) + ' to Stellar needs a ' + esc(chain.label) + ' wallet, which isn’t wired up here yet — this direction is quote-only for now.') +
          ' Quote correlation ID: ' + esc(correlationId) +
        '</div>' +
      '</div>';

    var exec = $('cryptoExec');
    if (!exec) return;
    var kind = originKind();
    if (kind) {
      // Switching which chain is the origin (Stellar vs. a specific EVM
      // chain, or between two different EVM chains) invalidates whatever
      // wallet was connected for the *previous* origin — a Stellar address
      // can't sign an Ethereum deposit and vice versa, and even between two
      // EVM chains the deposit target amount/asset changed under it. Forget
      // the connection rather than let a stale wallet look valid.
      if (activeWalletKind && activeWalletKind !== kind) disconnectWallet();
      lastQuoteCtx = { dir: dir, chainKey: $('cryptoDest').value, amountIn: amountIn };
      exec.hidden = false;
      populateWalletSelect();
      updateDestHint();
      updateSendEnabled();
    } else {
      lastQuoteCtx = null;
      exec.hidden = true;
    }
  }

  /**
   * The one entry point behind the Find-the-route button.
   *
   * Dispatches on where the route ends: a fiat corridor goes to the multi-leg
   * journey, anything else is a chain-to-chain (or chain-to-Stellar) swap.
   */
  function runRoute() {
    if (destinationCorridor()) return runE2E();
    return runCryptoQuote();
  }

  function runCryptoQuote() {
    var btn = $('cryptoRunBtn');
    var amountInput = $('cryptoAmount');
    var from = routeFromKey();
    // On a swap exactly one side is XLM, so the CHAINS entry to price against
    // is whichever side is not.
    var chainKey = from === 'xlm' ? $('cryptoDest').value : from;
    var chain = CHAINS[chainKey];
    var dir = direction();
    var amountIn = parseFloat(amountInput.value);

    if (!chain) {
      showError('Pick a different pair — sending and receiving the same asset is not a route.');
      return;
    }

    // An origin with no wallet path (or a *different* origin than whatever
    // is currently connected) never offers execution — reset up front,
    // before the fetch even starts, rather than only on a successful
    // renderQuote. Left to renderQuote alone, a failed quote (e.g. the old
    // amount now read as a wildly different asset, "no liquidity") would
    // leave the panel showing stale state from the last success, offering to
    // sign a swap unrelated to what's now on screen.
    if (!originKind()) {
      lastQuoteCtx = null;
      var execEl = $('cryptoExec');
      if (execEl) execEl.hidden = true;
    }

    if (!amountIn || amountIn <= 0) {
      showError('Enter an amount greater than 0.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Fetching…';
    showStatus('<span class="status-icon">🔀</span>Fetching a live quote…');

    var deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    var originAsset = dir === 'toChain' ? XLM_ASSET : chain.assetId;
    var destinationAsset = dir === 'toChain' ? chain.assetId : XLM_ASSET;
    var inDecimals = dir === 'toChain' ? XLM_DECIMALS : chain.decimals;
    var refundTo = dir === 'toChain' ? REFUND_FROM : chain.placeholder;
    var recipient = dir === 'toChain' ? chain.placeholder : REFUND_FROM;

    fetch(QUOTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dry: true,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: originAsset,
        depositType: 'ORIGIN_CHAIN',
        depositMode: dir === 'toChain' ? 'MEMO' : 'SIMPLE', // only Stellar-origin deposits use a memo
        destinationAsset: destinationAsset,
        amount: toBaseUnits(amountIn, inDecimals),
        refundTo: refundTo,
        refundType: 'ORIGIN_CHAIN',
        recipient: recipient,
        recipientType: 'DESTINATION_CHAIN',
        deadline: deadline,
      }),
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok || !result.body.quote) {
          throw new Error(result.body && result.body.message ? result.body.message : 'Unknown error');
        }
        renderQuote(chain, dir, amountIn, result.body.quote, result.body.correlationId);
      })
      .catch(function (err) { showError(friendlyError(err && err.message)); })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = 'Get Live Quote ⚡';
      });
  }

  function updateAmountLabel() {
    var lbl = $('cryptoAmountLabel');
    if (!lbl) return;
    var from = routeFromKey();
    var symbol = from === 'xlm' ? 'XLM' : ((CHAINS[from] || {}).symbol || from.toUpperCase());
    lbl.textContent = 'You send (' + symbol + ')';
  }

  /* ── Execution: Stellar-origin wallets (Freighter, Lobstr) ───────────────
     Everything below signs and sends a real transaction. The trust model is
     the same as any DEX frontend: Landfall builds the unsigned transaction
     and shows exactly what it says, the user's own wallet (Freighter or
     Lobstr — both browser extensions the user installs and controls
     independently of Landfall) is the only thing that ever holds their key,
     and Landfall submits only the signed XDR the wallet hands back. There is
     no step where Landfall could custody funds even if this code were
     compromised — the worst a bug here can do is build a bad transaction,
     which the user still has to approve in their wallet's own popup before
     anything moves. That second, independent confirmation is why the
     confirm-box below is not redundant with it.

     Freighter and Lobstr expose different shapes (Freighter returns
     { signedTxXdr, error }; Lobstr's signTransaction resolves straight to the
     signed XDR string and ignores networkPassphrase/address entirely — it
     signs with whatever account and network the extension itself is set to),
     so WALLETS below normalises both to the same connect()/sign() contract
     rather than branching on wallet identity throughout the rest of the file.
     See discoverEvmProviders below for the EVM-origin (chain -> XLM) side.
     ──────────────────────────────────────────────────────────────────── */

  var sdkPromise = null;
  var lobstrPromise = null;
  function loadStellarSdk() { if (!sdkPromise) sdkPromise = import(STELLAR_SDK_URL); return sdkPromise; }
  function loadLobstrSdk() { if (!lobstrPromise) lobstrPromise = import(LOBSTR_SDK_URL); return lobstrPromise; }

  /* ── EVM wallets (MetaMask, Trust Wallet, or anything else that injects an
     EIP-1193 provider) ────────────────────────────────────────────────────
     Same non-custody argument as the Stellar side, different mechanics:
     `eth_sendTransaction` has the wallet build, sign AND broadcast in one
     call, so there's no separate "build here, sign there, submit here"
     dance — Landfall hands the wallet a plain transaction object and gets a
     tx hash back. It's still the wallet showing the user what they're
     approving before anything moves, not Landfall.

     Rather than hardcoding "MetaMask" and "Trust Wallet" as two fixed
     options — which would show a MetaMask button that silently does nothing
     useful if only Trust Wallet is installed, or vice versa — this uses
     EIP-6963 (`window.dispatchEvent(new Event('eip6963:requestProvider'))`)
     to ask whatever's actually installed to announce itself, and only lists
     wallets that really answered. `window.ethereum` is kept as a fallback
     for older extensions that predate EIP-6963 and never announce.

     WalletConnect is deliberately not here: it requires a Project ID from
     cloud.walletconnect.com that only the site owner can obtain, and a
     button with no real ID behind it would look connected without being
     able to actually connect anything.
     ──────────────────────────────────────────────────────────────────── */

  var evmProviders = {}; // rdns/uuid -> { info: {name, rdns, uuid, icon}, provider }

  function discoverEvmProviders() {
    window.addEventListener('eip6963:announceProvider', function (event) {
      var d = event.detail;
      if (d && d.info && d.provider) evmProviders[d.info.rdns || d.info.uuid] = d;
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  }

  function connectEvmWallet(provider) {
    return provider.request({ method: 'eth_requestAccounts' }).then(function (accounts) {
      if (!accounts || !accounts[0]) throw new Error('No account returned by the wallet.');
      return accounts[0];
    });
  }

  /** Switches (or, if the wallet has never seen this chain, adds then
   *  switches) the connected EVM wallet to the chain a deposit is about to
   *  be sent on. Getting this wrong doesn't just fail politely — it would
   *  send funds on whatever chain the wallet happened to be on, which is
   *  exactly the kind of mistake this function exists to prevent. */
  function switchEvmChain(provider, chain) {
    var hexId = '0x' + chain.chainId.toString(16);
    return provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
      .catch(function (err) {
        var notAdded = err && (err.code === 4902 || (err.data && err.data.originalError && err.data.originalError.code === 4902));
        if (!notAdded) throw err;
        return provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: hexId,
            chainName: chain.label,
            nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 },
            rpcUrls: [chain.rpcUrl],
            blockExplorerUrls: [chain.explorerUrl],
          }],
        });
      });
  }

  /** ERC-20 `transfer(address,uint256)` call data — selector 0xa9059cbb plus
   *  the two 32-byte-padded arguments. Hand-encoded rather than pulling in
   *  ethers/viem for one function call. */
  function erc20TransferData(toAddress, amountBaseUnitsStr) {
    var addr = toAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    var amt = BigInt(amountBaseUnitsStr).toString(16).padStart(64, '0');
    return '0xa9059cbb' + addr + amt;
  }

  var WALLETS = {
    freighter: {
      label: 'Freighter',
      installUrl: 'https://www.freighter.app/',
      connect: function () {
        if (!window.freighterApi) return Promise.reject(new Error('Freighter not detected. Install the extension and reload this page.'));
        return window.freighterApi.isConnected().then(function (r) {
          if (r.error || !r.isConnected) throw new Error('Freighter did not respond. Is the extension enabled?');
          return window.freighterApi.requestAccess();
        }).then(function (r) {
          if (r.error) throw new Error(r.error.message || 'Access request was denied.');
          return r.address;
        });
      },
      sign: function (xdr, networkPassphrase, address) {
        return window.freighterApi.signTransaction(xdr, { networkPassphrase: networkPassphrase, address: address })
          .then(function (r) {
            if (r.error) throw new Error(r.error.message || 'Signature request was rejected.');
            return r.signedTxXdr;
          });
      },
    },
    lobstr: {
      label: 'Lobstr',
      installUrl: 'https://lobstr.co/',
      note: 'Lobstr doesn’t take a network parameter from the page it’s signing for — double-check the Lobstr extension itself is set to the public Stellar network before you sign.',
      connect: function () {
        return loadLobstrSdk().then(function (mod) {
          return Promise.resolve(mod.isConnected()).then(function (connected) {
            if (!connected) throw new Error('Lobstr extension not detected, or not connected. Install it and reload this page.');
            return mod.getPublicKey();
          });
        });
      },
      sign: function (xdr) {
        return loadLobstrSdk().then(function (mod) { return mod.signTransaction(xdr); });
      },
    },
  };

  var walletAddress = null;
  var activeWallet = null;      // key into WALLETS (stellar) or evmProviders (evm) — '__legacy__' for window.ethereum
  var activeWalletKind = null;  // 'stellar' | 'evm' — which origin this connection can sign for
  var activeWalletLabel = null;
  var activeEvmProvider = null; // the actual EIP-1193 provider object, when activeWalletKind === 'evm'
  var lastQuoteCtx = null;      // { dir, chainKey, amountIn } — set once a live (dry) executable-origin quote has rendered

  function setWalletStatus(html, isError) {
    var el = $('cryptoWalletStatus');
    if (!el) return;
    el.innerHTML = html;
    el.className = isError ? 'cell-sub is-error' : (walletAddress ? 'cell-sub is-connected' : 'cell-sub');
  }

  function updateDestHint() {
    var kind = originKind();
    var chain = CHAINS[$('cryptoDest').value];
    if (kind === 'evm') {
      $('cryptoDestAddrLabel').textContent = 'Your Stellar address to receive XLM';
      $('cryptoDestAddrHint').textContent = 'Starts with G, 56 characters.';
    } else {
      $('cryptoDestAddrLabel').textContent = 'Your ' + chain.label + ' address to receive funds';
      $('cryptoDestAddrHint').textContent = chain.addrHint;
    }
  }

  /** Rebuilds the wallet <select> for whichever origin kind is currently
   *  live — Freighter/Lobstr for a Stellar origin, or whatever EVM wallets
   *  actually announced themselves (see discoverEvmProviders) for an EVM
   *  origin. Called every time the exec panel becomes visible, since the
   *  right options depend on origin kind, not just on what loaded once. */
  function populateWalletSelect() {
    var sel = $('cryptoWalletSelect');
    var kind = originKind();
    sel.innerHTML = '';

    function opt(value, label) {
      var o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
    }

    if (kind === 'stellar') {
      opt('freighter', 'Freighter');
      opt('lobstr', 'Lobstr');
    } else if (kind === 'evm') {
      var keys = Object.keys(evmProviders);
      if (keys.length) {
        keys.forEach(function (k) { opt(k, evmProviders[k].info.name); });
      } else if (window.ethereum) {
        opt('__legacy__', 'Browser wallet');
      } else {
        opt('', 'No EVM wallet detected');
        sel.disabled = true;
        return;
      }
    }
    sel.disabled = false;
  }

  function updateSendEnabled() {
    var btn = $('cryptoSendBtn');
    if (!btn) return;
    var kind = originKind();
    var addr = $('cryptoDestAddr').value.trim();
    var addrOk = kind === 'evm' ? STELLAR_ADDR_RE.test(addr) : CHAINS[$('cryptoDest').value].addrRe.test(addr);
    btn.disabled = !(kind && walletAddress && activeWalletKind === kind && addrOk && lastQuoteCtx);
  }

  function connectWallet() {
    var kind = originKind();
    var walletKey = $('cryptoWalletSelect').value;
    var btn = $('cryptoConnectBtn');

    if (!walletKey) {
      setWalletStatus('No EVM wallet detected. Install MetaMask, Trust Wallet, or another browser extension wallet and reload this page.', true);
      return;
    }

    var connectPromise, label, note, provider;
    if (kind === 'stellar') {
      var wallet = WALLETS[walletKey];
      label = wallet.label;
      note = wallet.note;
      connectPromise = wallet.connect();
    } else {
      provider = walletKey === '__legacy__' ? window.ethereum : evmProviders[walletKey].provider;
      label = walletKey === '__legacy__' ? 'Browser wallet' : evmProviders[walletKey].info.name;
      note = 'Make sure ' + label + ' is on the right network before you sign — the confirm step below will prompt a chain switch, but double-check it in the wallet itself too.';
      connectPromise = connectEvmWallet(provider);
    }

    btn.disabled = true;
    btn.textContent = 'Connecting…';
    connectPromise
      .then(function (address) {
        walletAddress = address;
        activeWallet = walletKey;
        activeWalletKind = kind;
        activeWalletLabel = label;
        activeEvmProvider = kind === 'evm' ? provider : null;
        var msg = 'Connected to ' + label + ': <span title="' + esc(address) + '">' + esc(address.slice(0, 6)) + '…' + esc(address.slice(-6)) + '</span>';
        if (note) msg += '<br>' + esc(note);
        setWalletStatus(msg, false);
        $('cryptoWalletPicker').hidden = true;
        $('cryptoWalletConnected').hidden = false;
        updateSendEnabled();
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Connect Wallet';
        setWalletStatus(esc(err && err.message ? err.message : 'Could not connect to ' + label + '.'), true);
      });
  }

  function disconnectWallet() {
    // Local state only — none of Freighter, Lobstr, or an EIP-1193 provider
    // exposes a real "revoke" call from the page, so this forgets the
    // address on Landfall's side and lets the user pick a different wallet
    // or account next time. The extension itself still remembers it
    // authorized this site, same as any other dApp's "disconnect" button.
    walletAddress = null;
    activeWallet = null;
    activeWalletKind = null;
    activeWalletLabel = null;
    activeEvmProvider = null;
    $('cryptoWalletConnected').hidden = true;
    $('cryptoWalletPicker').hidden = false;
    var connectBtn = $('cryptoConnectBtn');
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect Wallet';
    setWalletStatus('', false);
    renderExecStatus('');
    updateSendEnabled();
  }

  function renderExecStatus(html) { $('cryptoExecStatus').innerHTML = html; }

  function stepsHtml(steps, activeIndex, failedIndex) {
    return '<div class="exec-steps">' + steps.map(function (label, i) {
      var cls = i < activeIndex ? 'is-done' : i === activeIndex ? 'is-active' : '';
      if (failedIndex === i) cls = 'is-failed';
      return '<div class="exec-step ' + cls + '"><span class="exec-step__dot"></span>' + esc(label) + '</div>';
    }).join('') + '</div>';
  }

  // Which step index was in flight when a rejection lands — used only to
  // paint that step red; harmless if it guesses wrong, it's cosmetic.
  function currentFailedStep() {
    var active = document.querySelector('.exec-step.is-active');
    if (!active) return -1;
    return Array.prototype.indexOf.call(active.parentNode.children, active);
  }

  function reviewAndSend() {
    if (!lastQuoteCtx || !walletAddress) return;
    var kind = activeWalletKind;
    var chainKey = lastQuoteCtx.chainKey;
    var chain = CHAINS[chainKey];
    var isStellarOrigin = kind === 'stellar';
    var destAddr = $('cryptoDestAddr').value.trim();
    var amountIn = lastQuoteCtx.amountIn;

    var sendBtn = $('cryptoSendBtn');
    sendBtn.disabled = true;
    renderExecStatus(stepsHtml(['Requesting a real quote'], 0, -1));

    var deadline = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    var body = {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: isStellarOrigin ? XLM_ASSET : chain.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: isStellarOrigin ? chain.assetId : XLM_ASSET,
      amount: toBaseUnits(amountIn, isStellarOrigin ? XLM_DECIMALS : chain.decimals),
      // The connected wallet's own address, not the pricing placeholder used
      // for quote-only requests above — if this swap fails or expires, NEAR
      // Intents refunds to whoever is named here, and that must be the
      // person who actually sent the deposit.
      refundTo: walletAddress,
      refundType: 'ORIGIN_CHAIN',
      recipient: destAddr,
      recipientType: 'DESTINATION_CHAIN',
      deadline: deadline,
    };
    if (isStellarOrigin) body.depositMode = 'MEMO'; // every other origin here uses a unique SIMPLE deposit address instead

    fetch(QUOTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
      .then(function (result) {
        if (!result.ok || !result.body.quote || !result.body.quote.depositAddress) {
          throw new Error(result.body && result.body.message ? result.body.message : 'Quote provider returned no deposit address.');
        }
        var quote = result.body.quote;
        var inSymbol = isStellarOrigin ? 'XLM' : chain.symbol;
        var outSymbol = isStellarOrigin ? chain.symbol : 'XLM';
        var outDecimals = isStellarOrigin ? chain.decimals : XLM_DECIMALS;
        var amountOut = fromBaseUnits(quote.amountOut, outDecimals);

        renderExecStatus(
          '<div class="confirm-box">' +
            '<div class="confirm-box__title">Confirm before signing (' + esc(activeWalletLabel) + ')</div>' +
            '<div class="confirm-box__row"><span>From</span><span>' + esc(walletAddress) + '</span></div>' +
            '<div class="confirm-box__row"><span>Send</span><span>' + esc(quote.amountInFormatted) + ' ' + inSymbol + '</span></div>' +
            '<div class="confirm-box__row"><span>To (deposit address)</span><span>' + esc(quote.depositAddress) + '</span></div>' +
            (quote.depositMemo ? '<div class="confirm-box__row"><span>Memo (required)</span><span>' + esc(quote.depositMemo) + '</span></div>' : '') +
            '<div class="confirm-box__row"><span>You receive (est.)</span><span>' + esc(amountOut) + ' ' + outSymbol + '</span></div>' +
            '<div class="confirm-box__row"><span>At</span><span>' + esc(destAddr) + '</span></div>' +
            '<div class="confirm-box__row"><span>Quote expires</span><span>' + esc(new Date(quote.deadline).toLocaleTimeString()) + '</span></div>' +
            '<div class="confirm-box__actions">' +
              '<button class="run-btn confirm-box__cancel" id="cryptoCancelBtn" type="button">Cancel</button>' +
              '<button class="run-btn" id="cryptoConfirmBtn" type="button">Sign in ' + esc(activeWalletLabel) + ' →</button>' +
            '</div>' +
          '</div>'
        );

        $('cryptoCancelBtn').addEventListener('click', function () {
          renderExecStatus('');
          sendBtn.disabled = false;
        });
        $('cryptoConfirmBtn').addEventListener('click', function () {
          if (isStellarOrigin) executeStellarDeposit(chain, quote, destAddr);
          else executeEvmDeposit(chain, quote, destAddr);
        });
      })
      .catch(function (err) {
        renderExecStatus('<div class="crypto-error"><strong>Could not prepare the transaction.</strong> ' + esc(friendlyError(err && err.message)) + '</div>');
        sendBtn.disabled = false;
      });
  }

  var STELLAR_EXEC_STEPS = ['Building the transaction', 'Waiting for your signature', 'Submitting to the Stellar network', 'Waiting for NEAR Intents to detect the deposit'];

  function executeStellarDeposit(chain, quote, destAddr) {
    renderExecStatus(stepsHtml(STELLAR_EXEC_STEPS, 0, -1));

    var sdk, server;
    var wallet = WALLETS[activeWallet];

    loadStellarSdk()
      .then(function (mod) {
        sdk = mod;
        server = new sdk.Horizon.Server(HORIZON_URL);
        return server.loadAccount(walletAddress);
      })
      .then(function (account) {
        return server.fetchBaseFee().catch(function () { return 100; }).then(function (fee) {
          return new sdk.TransactionBuilder(account, {
            fee: String(fee),
            networkPassphrase: sdk.Networks.PUBLIC,
          })
            .addOperation(sdk.Operation.payment({
              destination: quote.depositAddress,
              asset: sdk.Asset.native(),
              amount: quote.amountInFormatted,
            }))
            .addMemo(sdk.Memo.text(quote.depositMemo))
            .setTimeout(180)
            .build();
        });
      })
      .then(function (tx) {
        renderExecStatus(stepsHtml(STELLAR_EXEC_STEPS, 1, -1));
        return wallet.sign(tx.toXDR(), sdk.Networks.PUBLIC, walletAddress);
      })
      .then(function (signedXdr) {
        renderExecStatus(stepsHtml(STELLAR_EXEC_STEPS, 2, -1));
        var signedTx = sdk.TransactionBuilder.fromXDR(signedXdr, sdk.Networks.PUBLIC);
        return server.submitTransaction(signedTx);
      })
      .then(function (result) {
        renderExecStatus(
          stepsHtml(STELLAR_EXEC_STEPS, 3, -1) +
          '<div class="exec-success" data-tx-hash="' + esc(result.hash) + '">' +
            'Deposit sent — <a href="https://stellar.expert/explorer/public/tx/' + esc(result.hash) + '" target="_blank" rel="noopener">view on stellar.expert</a>. ' +
            'Waiting for NEAR Intents to detect it and execute the swap to ' + esc(destAddr) + '…' +
          '</div>'
        );
        pollStatus(quote.depositAddress, quote.depositMemo, destAddr, chain.label, 'XLM', 'https://stellar.expert/explorer/public/tx/');
      })
      .catch(function (err) {
        var message = err && err.message ? err.message : String(err);
        // Horizon's own error shape carries the useful detail in extras, not
        // in `message` — surfacing only `message` here would just say
        // "Bad Request" for e.g. an underfunded account.
        var codes = err && err.response && err.response.data && err.response.data.extras && err.response.data.extras.result_codes;
        if (codes) message = JSON.stringify(codes);
        renderExecStatus(stepsHtml(STELLAR_EXEC_STEPS, -1, currentFailedStep()) + '<div class="crypto-error"><strong>Send failed.</strong> ' + esc(message) + ' Nothing was lost — a failed submission does not move funds.</div>');
        $('cryptoSendBtn').disabled = false;
      });
  }

  var EVM_EXEC_STEPS = ['Confirming the wallet is on the right network', 'Waiting for your signature', 'Waiting for NEAR Intents to detect the deposit'];

  function executeEvmDeposit(chain, quote, destAddr) {
    renderExecStatus(stepsHtml(EVM_EXEC_STEPS, 0, -1));
    var provider = activeEvmProvider;

    switchEvmChain(provider, chain)
      .then(function () {
        renderExecStatus(stepsHtml(EVM_EXEC_STEPS, 1, -1));
        var amountBase = toBaseUnits(quote.amountInFormatted, chain.decimals);
        var txParams = { from: walletAddress };
        if (chain.tokenContract) {
          txParams.to = chain.tokenContract;
          txParams.data = erc20TransferData(quote.depositAddress, amountBase);
          txParams.value = '0x0';
        } else {
          txParams.to = quote.depositAddress;
          txParams.value = '0x' + BigInt(amountBase).toString(16);
        }
        return provider.request({ method: 'eth_sendTransaction', params: [txParams] });
      })
      .then(function (txHash) {
        renderExecStatus(
          stepsHtml(EVM_EXEC_STEPS, 2, -1) +
          '<div class="exec-success" data-tx-hash="' + esc(txHash) + '">' +
            'Deposit sent — <a href="' + esc(chain.explorerUrl) + '/tx/' + esc(txHash) + '" target="_blank" rel="noopener">view on ' + esc(chain.explorerUrl.replace(/^https?:\/\//, '')) + '</a>. ' +
            'Waiting for NEAR Intents to detect it and execute the swap to ' + esc(destAddr) + '…' +
          '</div>'
        );
        // EVM-origin deposits use a unique SIMPLE address, not a shared
        // MEMO-tagged one — no memo to pass or display here.
        pollStatus(quote.depositAddress, null, destAddr, 'Stellar', chain.symbol, chain.explorerUrl + '/tx/');
      })
      .catch(function (err) {
        var message = err && err.message ? err.message : String(err);
        renderExecStatus(stepsHtml(EVM_EXEC_STEPS, -1, currentFailedStep()) + '<div class="crypto-error"><strong>Send failed.</strong> ' + esc(message) + ' Nothing was lost — a failed submission does not move funds.</div>');
        $('cryptoSendBtn').disabled = false;
      });
  }

  function pollStatus(depositAddress, depositMemo, destAddr, destLabel, originSymbol, explorerTxBase) {
    var attempts = 0;
    var maxAttempts = 90; // ~7.5 minutes at 5s intervals
    var qs = 'depositAddress=' + encodeURIComponent(depositAddress) + (depositMemo ? '&depositMemo=' + encodeURIComponent(depositMemo) : '');

    (function tick() {
      attempts++;
      fetch(STATUS_URL + '?' + qs)
        .then(function (res) { return res.json(); })
        .then(function (body) {
          var status = body && body.status;
          var box = document.querySelector('.exec-success');
          if (!box) return;

          if (status === 'SUCCESS') {
            box.innerHTML = 'Swap complete — funds sent to ' + esc(destAddr) + ' on ' + esc(destLabel) + '. ' +
              '<a href="' + esc(explorerTxBase) + esc(box.dataset.txHash || '') + '" target="_blank" rel="noopener">view the deposit</a>.';
            return;
          }
          if (status === 'REFUNDED') {
            box.className = 'crypto-error';
            box.innerHTML = '<strong>Swap did not complete — refunded.</strong> Your ' + esc(originSymbol) + ' was sent back to ' + esc(walletAddress) + '.';
            return;
          }
          if (status === 'FAILED') {
            box.className = 'crypto-error';
            box.innerHTML = '<strong>Swap failed.</strong> Check the deposit address (' + esc(depositAddress) + ')' + (depositMemo ? ' and memo (' + esc(depositMemo) + ')' : '') + ' directly with NEAR Intents if funds do not return.';
            return;
          }

          box.textContent = 'Status: ' + (status || 'pending') + ' — checking again in 5s… (deposit ' + depositAddress.slice(0, 6) + '…' + (depositMemo ? ', memo ' + depositMemo : '') + ')';
          if (attempts < maxAttempts) setTimeout(tick, 5000);
          else box.textContent += ' Still not final after several minutes — this can happen; check back later using the deposit address' + (depositMemo ? ' and memo' : '') + ' above.';
        })
        .catch(function () {
          if (attempts < maxAttempts) setTimeout(tick, 5000);
        });
    })();
  }

  /* ── Boot ────────────────────────────────────────────────────────────── */

  /* ── End to end: crypto → XLM → local currency ─────────────────────────
     Both halves of this already existed and were shown separately, which left
     the reader to multiply two numbers and hope. Tracing the whole route is
     more useful and also more honest, because the combined figure makes the
     weakest link obvious: a live solver quote on the first leg and, on the
     second, either an operator's published spread against a hardcoded FX
     table or nothing at all.

     Reads CATALOG / FX / SYM from compare.js, which loads first on this page.
     ──────────────────────────────────────────────────────────────────── */

  function e2eError(message) {
    $('cryptoResult').innerHTML = '<div class="crypto-error"><strong>Cannot trace this route.</strong> ' + esc(message) + '</div>';
  }

  function renderE2E(chain, amountIn, quote, corridor) {
    // The XLM leg's USD value comes from the live quote rather than a
    // hardcoded XLM price — the solver just told us what this is worth, and
    // its number is fresher than any constant in this codebase.
    var xlmOut = Number(quote.amountOutFormatted);
    var usdValue = Number(quote.amountOutUsd);

    var catalog = (typeof CATALOG !== 'undefined') ? CATALOG : [];
    var fx = (typeof FX !== 'undefined') ? FX : {};
    var sym = (typeof SYM !== 'undefined' && SYM[corridor]) ? SYM[corridor] : corridor + ' ';
    var rate = fx[corridor];

    var serving = catalog.filter(function (a) { return a.corridors.indexOf(corridor) !== -1; });

    var priced = serving.filter(function (a) { return a.feesPublished !== false; }).map(function (a) {
      var effRate = rate * a.rateSpread;
      var fee = usdValue * (a.feePercent / 100) + a.feeFixed;
      var net = Math.max(usdValue - fee, 0);
      return { anchor: a, payout: net * effRate };
    }).sort(function (a, b) { return b.payout - a.payout; });

    var unpriced = serving.filter(function (a) { return a.feesPublished === false; });

    var legs =
      '<div class="e2e-leg">' +
        '<div class="e2e-leg__n">1</div>' +
        '<div class="e2e-leg__body">' +
          '<div class="e2e-leg__head">' + esc(amountIn) + ' ' + chain.symbol + ' → ' + esc(xlmOut.toFixed(4)) + ' XLM</div>' +
          '<div class="e2e-leg__sub">Live quote from NEAR Intents · ' + timeLabel(quote.timeEstimate) + ' · ' +
            'executable above with your own wallet. A solver fills this; you are trusting them for the duration.</div>' +
        '</div>' +
      '</div>' +
      '<div class="e2e-leg">' +
        '<div class="e2e-leg__n">2</div>' +
        '<div class="e2e-leg__body">' +
          '<div class="e2e-leg__head">' + esc(xlmOut.toFixed(4)) + ' XLM ≈ $' + usdValue.toFixed(2) + '</div>' +
          '<div class="e2e-leg__sub">Valued by the same live quote, not by a stored price.</div>' +
        '</div>' +
      '</div>';

    var third;
    if (serving.length === 0) {
      third =
        '<div class="e2e-leg-none">No tracked anchor serves ' + esc(corridor) + '. The first two legs still ' +
        'hold — you would reach XLM and then need an off-ramp this tool does not cover.</div>';
    } else {
      var rows = priced.map(function (p, i) {
        return '<div class="e2e-anchor' + (i === 0 ? ' is-best' : '') + '">' +
          '<div><b>' + esc(p.anchor.name) + '</b><div class="cell-sub">' + esc(p.anchor.domain) + '</div></div>' +
          '<div class="e2e-anchor__out">' + sym + p.payout.toLocaleString('en-US', { maximumFractionDigits: 2 }) + '</div>' +
        '</div>';
      }).join('');

      var unpricedRows = unpriced.map(function (a) {
        return '<div class="e2e-anchor">' +
          '<div><b>' + esc(a.name) + '</b><div class="cell-sub">' + esc(a.domain) + '</div></div>' +
          '<div class="e2e-anchor__out e2e-anchor__out--none">Not published</div>' +
        '</div>';
      }).join('');

      third =
        '<div class="e2e-leg">' +
          '<div class="e2e-leg__n">3</div>' +
          '<div class="e2e-leg__body">' +
            '<div class="e2e-leg__head">XLM → ' + esc(corridor) + ' via a Stellar anchor</div>' +
            '<div class="e2e-leg__sub">' +
              (priced.length
                ? 'Figures below apply each operator’s published spread to an indicative mid-market rate. ' +
                  'They are an order of magnitude, not a quote — the anchor prices the real thing at withdrawal.'
                : 'No anchor serving ' + esc(corridor) + ' publishes a rate card, so no payout can be shown ' +
                  'without inventing one.') +
            '</div>' +
            rows + unpricedRows +
          '</div>' +
        '</div>';
    }

    $('cryptoResult').innerHTML =
      '<div class="e2e-card">' + legs + third +
        '<div class="crypto-source">' +
          'Leg 1 is a live quote. Leg 3 is indicative where an operator publishes terms and blank where none ' +
          'does. Landfall executes neither leg and holds no funds in either; the anchor leg happens in that ' +
          'anchor’s own regulated flow. Quote correlation ID: ' + esc(quote.__cid || '') +
        '</div>' +
      '</div>';
  }

  /**
   * XLM straight to cash: one leg, no swap.
   *
   * Rendered here only so the merged control answers every combination it
   * offers. The real comparison — fees, reliability grades, published vs
   * unpublished rates — is Route Scout above, so this points there rather
   * than reimplementing it worse.
   */
  function renderXlmToCash(amountIn, corridor) {
    var catalog = (typeof CATALOG !== 'undefined') ? CATALOG : [];
    var serving = catalog.filter(function (a) { return a.corridors.indexOf(corridor) !== -1; });

    $('cryptoResult').innerHTML =
      '<div class="e2e-card">' +
        '<div class="e2e-leg">' +
          '<div class="e2e-leg__n">1</div>' +
          '<div class="e2e-leg__body">' +
            '<div class="e2e-leg__head">' + esc(amountIn) + ' XLM → ' + esc(corridor) + '</div>' +
            '<div class="e2e-leg__sub">No swap is needed — you already hold the asset the anchor takes. ' +
              (serving.length
                ? serving.length + ' tracked anchor' + (serving.length === 1 ? '' : 's') + ' serve' +
                  (serving.length === 1 ? 's' : '') + ' this corridor: ' +
                  serving.map(function (a) { return esc(a.name); }).join(', ') + '.'
                : 'No tracked anchor serves this corridor.') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="crypto-source">' +
          'Set <strong>You Send</strong> to XLM in Route Scout above for the full comparison — payout, fees, ' +
          'speed and each anchor’s on-chain settlement grade, which is the part that actually distinguishes them.' +
        '</div>' +
      '</div>';
  }

  function runE2E() {
    var btn = $('cryptoRunBtn');
    var amountIn = parseFloat($('cryptoAmount').value);
    var chainKey = routeFromKey();
    var chain = CHAINS[chainKey];
    var corridor = destinationCorridor();

    if (!amountIn || amountIn <= 0) { e2eError('Enter an amount greater than 0.'); return; }

    // Sending XLM to cash needs no swap at all — it is the anchor leg on its
    // own, which is what Route Scout above already does properly, with fees
    // and reliability grades. Pointing there beats rendering a worse copy.
    if (chainKey === 'xlm') {
      renderXlmToCash(amountIn, corridor);
      return;
    }
    if (!chain) { e2eError('Unknown source asset.'); return; }

    btn.disabled = true;
    btn.textContent = 'Tracing…';
    $('cryptoResult').innerHTML = '<div class="status-msg"><span class="status-icon">🛬</span>Pricing the first leg…</div>';

    fetch(QUOTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dry: true,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: chain.assetId,
        depositType: 'ORIGIN_CHAIN',
        depositMode: 'SIMPLE',
        destinationAsset: XLM_ASSET,
        amount: toBaseUnits(amountIn, chain.decimals),
        refundTo: chain.placeholder,
        refundType: 'ORIGIN_CHAIN',
        recipient: REFUND_FROM,
        recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }),
    })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
      .then(function (r) {
        if (!r.ok || !r.body.quote) {
          throw new Error(r.body && r.body.message ? r.body.message : 'The quote provider returned an error.');
        }
        r.body.quote.__cid = r.body.correlationId;
        renderE2E(chain, amountIn, r.body.quote, corridor);
      })
      .catch(function (err) { e2eError(friendlyError(err && err.message)); })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = 'Find the route ⚡';
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('cryptoRunBtn');
    if (!btn) return; // section not present on this page
    btn.addEventListener('click', runRoute);
    $('cryptoDest').addEventListener('change', function () { updateAmountLabel(); runRoute(); });
    var fromEl = $('routeFrom');
    if (fromEl) fromEl.addEventListener('change', function () { updateAmountLabel(); runRoute(); });
    updateAmountLabel();

    var connectBtn = $('cryptoConnectBtn');
    if (!connectBtn) return; // wallet-execution panel not present on this page
    discoverEvmProviders();
    connectBtn.addEventListener('click', connectWallet);
    $('cryptoDisconnectBtn').addEventListener('click', disconnectWallet);
    $('cryptoSendBtn').addEventListener('click', reviewAndSend);
    $('cryptoDestAddr').addEventListener('input', function () {
      // A stale confirm box would still show the address the user just
      // changed away from — clear it rather than let a review screen go out
      // of sync with what's in the input.
      renderExecStatus('');
      updateSendEnabled();
    });
  });
})();

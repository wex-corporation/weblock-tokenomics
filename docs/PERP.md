# RBT Perpetual Futures — On-chain Settlement Layer (V1)

Part of WeBlock's hybrid perp exchange: orders are matched **off-chain** by the
backend engine; these contracts are the **non-custodial on-chain settlement**
layer. Cash-settled in USDR — RBT itself is never custodied here, so ERC-1155
transfer gating does not apply. See repo-root `docs/WEBLOCK_PERP_EXCHANGE_SCOPE_2026-06-14.md`.

> **PRE-AUDIT V1 (testnet).** Isolated margin, single-fill position flips
> disallowed, funding nets through an internal pool. A full external audit is
> mandatory before mainnet.

## Contracts (`contracts/perp/`)

| Contract | Role |
|---|---|
| `NavOracle` | Operator-published index/mark price per market (== RBT `tokenId`). NAV-based because RBT has no liquid market price. Per-update deviation guard + staleness window. |
| `InsuranceFund` | USDR backstop reserve; absorbs gap losses beyond a position's margin. Only the clearing house (`DRAWER_ROLE`) may draw, capped at balance. |
| `PerpClearing` | Collateral custody, EIP-712 order verification, position/margin book, funding, liquidation. EIP-712 domain `("WeBlockPerp","1")`. |

## Accounting model

- All amounts in **quote-token (USDR, 6dp) base units**; ratios in **basis points**.
- **Isolated margin** per `(trader, marketId)`. Position: `size` (signed contracts),
  `avgEntryPrice`, `margin`, `entryFundingIndex`.
- **Mark price** = `NavOracle.getPriceChecked(marketId)` (reverts if stale).
- PnL: unrealised at mark, **realised at fill price** on reduce/close.
- **Solvency**: every fill creates equal & opposite size (Σlong == Σshort per
  market), so PnL nets to zero across the book; gap losses beyond margin are
  covered by `InsuranceFund`. Free balance excludes locked margin, so `withdraw`
  is always safe for the withdrawing trader.
- **Funding**: `pokeFunding(marketId, deltaIndexScaled)` advances a cumulative
  index (`* 1e18`, quote-units per contract; positive ⇒ longs pay shorts).
  Applied lazily on each interaction; signed `fundingPool` keeps it
  order-independent within a batch.

## EIP-712 `Order` (what the backend signs as the trader, on their behalf via wallet)

```
Order(
  address trader,
  uint256 marketId,
  bool    isBuy,       // true = long
  uint256 price,       // limit: buy = max payable, sell = min receivable (quote/contract)
  uint256 amount,      // total contracts the order may fill (supports partial fills)
  uint256 marginBps,   // requested initial margin bps; must be >= market.initialMarginBps
  uint256 nonce,
  uint256 expiry,      // unix seconds; fill must be <= expiry
  bool    reduceOnly
)
```

Domain: `name="WeBlockPerp", version="1", chainId, verifyingContract=<PerpClearing>`.
The contract tracks `filledAmount[digest]` (partial fills) and `cancelledOrder[digest]`
(trader self-cancel backstop). `orderDigest(order)` returns the typed-data hash.

## Settlement

Backend (holding `SETTLEMENT_ROLE`) submits matched trades:

```
settleTrades(Trade[]) where
Trade { Order maker; bytes makerSig; Order taker; bytes takerSig; uint256 fillAmount; uint256 fillPrice; }
```

Per trade: opposite sides, same market, both sigs valid & unexpired & uncancelled,
`fillPrice` within both limits, `fillAmount` within both remaining amounts. Maker
pays `makerFeeBps`, taker `takerFeeBps`.

## Roles

- `DEFAULT_ADMIN_ROLE`, `MARKET_ADMIN_ROLE` — admin (multisig/timelock before mainnet).
- `SETTLEMENT_ROLE` — backend matching/settlement key (`settleTrades`).
- `LIQUIDATOR_ROLE` — keeper (`liquidate`).
- `FUNDING_ROLE` — backend funding scheduler (`pokeFunding`).
- `PAUSER_ROLE` — pause settlement/liquidation.
- `NavOracle.ORACLE_PUBLISHER_ROLE` — backend NAV publisher.
- `InsuranceFund.DRAWER_ROLE` — granted to `PerpClearing`.

## Deploy

```bash
# after scripts/deploy.js (core) exists in deployments/<chain>.json:
PERP_OPERATOR_ADDRESS=<backend settlement key> \
NAV_PUBLISHER_ADDRESS=<backend nav key> \
PERP_MAX_DEVIATION_BPS=2000 PERP_MAX_STALENESS_SECS=3600 \
npx hardhat run scripts/deploy-perp.js --network fuji
```

Then: fund `InsuranceFund`, `NavOracle.initializeMarket(tokenId, price)`,
`PerpClearing.addMarket(tokenId, initialBps, maintBps, makerFee, takerFee, liqFee)`.

## Tests

`test/perp-flow.test.js` — 9 cases: deposit/withdraw, open & margin/fees,
zero-sum close, funding transfer, liquidation w/ penalty, bad-debt insurance
cover, auth/non-custodial invariants, overfill/reduce-only/leverage/cancel
rejection, oracle deviation/staleness guards. Full suite: **20 passing**.

## Audit checklist (before mainnet)

- Aggregate-solvency proof under isolated margin + immediate realised-PnL credit.
- Funding-pool drift when long/short notional imbalanced; receiver-uncapped path.
- Oracle trust model (managed NAV): publisher key → multisig/timelock; deviation
  & staleness tuning; circuit breaker / market pause on feed loss.
- Liquidation incentives & ADL for illiquid markets (not yet implemented).
- Reentrancy across `settleTrades` → `InsuranceFund.cover` (currently guarded).
- Rounding/dust in margin release and funding division.

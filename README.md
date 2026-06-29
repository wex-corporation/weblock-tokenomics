# WeBlock Contracts (greenfield)

Solidity contract suite for the WeBlock RWA platform: fractional real-estate tokens (RBT),
a USD settlement stablecoin (USDR), a governance/loyalty token (WFT), monthly rent distribution,
an off-chain-matched spot market, and non-custodial perpetual futures.

Full design: [`../docs/build/01_CONTRACTS_SPEC.md`](../docs/build/01_CONTRACTS_SPEC.md).

## Stack
Hardhat 3 · Solidity 0.8.28 (viaIR, optimizer 200, Cancun) · OpenZeppelin v5 · ethers v6 · pnpm.

## Architecture
- **tokens/** — `USDR` (ERC20, 6dp), `RBT` (ERC1155, one id per property series, KYC/state transfer gate), `WFT` (ERC20Votes, capped, lock schedules).
- **rwa/** — `KycRegistry` (on-chain allowlist), `SeriesManager` (primary sale + lifecycle + redemption + the RBT transfer gate), `IncomeDistributor` (Merkle monthly rent).
- **markets/** — `SpotExchange` (EIP-712, off-chain matched, on-chain atomic settle), `NavOracle` (operator NAV mark/index), `InsuranceFund`, `PerpClearing` (non-custodial isolated perps).
- **tge/** — `WftClaim` (Merkle + vesting, paused behind legal gate).

Design choices: immutable contracts (no proxies; redeploy+migrate), per-contract `AccessControl`,
SafeERC20, ReentrancyGuard, one EIP-712 domain per market contract, events for the backend indexer.
WBP (loyalty points) is intentionally **off-chain** (backend DB ledger), not a token here.

## Quick start
```bash
pnpm install
pnpm compile
pnpm test            # 11 tests: tokens, RBT lifecycle, income merkle, spot, perp, TGE
pnpm deploy:fuji     # deploy + wire + write deployments/fuji.json + export abis/
```

### Env (`.env`)
```
DEPLOYER_PRIVATE_KEY=0x...        # funded with test AVAX on Fuji
FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
ADMIN_ADDRESS=0x...               # defaults to deployer
BACKEND_OPERATOR_ADDRESS=0x...    # backend signer; granted settlement/oracle/kyc roles (defaults to deployer)
DEPLOY_MOCK_STABLES=true          # deploy mock USDC/USDT on testnet
```

## Live deployment — Avalanche Fuji (43113)
Source of truth: [`deployments/fuji.json`](deployments/fuji.json) (consumed by backend config + wallet SDK).

| Contract | Address |
|---|---|
| USDR | `0x339995DdB41166cC20fd4e82E2817b4ddBE16Be4` |
| RBT | `0x9F9A517E7d56d8F986fAc361896891f79E4E7f77` |
| WFT | `0xadb62479E9d2914d1f1eB743Af9Ea69b9481933b` |
| KycRegistry | `0x08F176f989CBe45FAf0240F9C449dF6f14E7EC7D` |
| SeriesManager | `0xf3DBB781b5366255C58F25837Afb282D2257a55F` |
| IncomeDistributor | `0x9212525570eD0800899262B5b19EDC5da74ADcFC` |
| SpotExchange | `0x217C187ec99e1EcaBD80386403127A86D23340e0` |
| NavOracle | `0x078A5A64504d329a92701B3E2b86B57a62351013` |
| InsuranceFund | `0x94c26d6c06783e3A59b8844529715479eD58f685` |
| PerpClearing | `0x67a55155E61Ca2932Ac1b4Ad1B62CdeA16CF1f3c` |
| WftClaim (paused) | `0x3ff6A045D2aaED025D558e7Cf3b8fFa0fa10681c` |

Seed an operable state (KYC, launch series, perp market, NAV):
```bash
npx hardhat run scripts/seed-fuji.js --network fuji
```

## Security status
**Pre-audit, testnet only.** External audit mandatory before mainnet (priority-1: `PerpClearing`,
`NavOracle`, liquidation, `InsuranceFund`). Perp V1 is isolated-margin, no single-fill flips,
pool-balanced approximate funding. `WftClaim` is paused pending legal sign-off.

## EIP-712 / Merkle (parity reference for backend + frontend)
- Spot domain `WeBlockSpot` v1 · `Order(address trader,uint256 marketId,bool isBuy,uint256 price,uint256 amount,uint256 nonce,uint256 expiry)`
- Perp domain `WeBlockPerp` v1 · `Order(address trader,uint256 marketId,bool isBuy,uint256 price,uint256 amount,uint256 marginBps,uint256 nonce,uint256 expiry,bool reduceOnly)`
- Merkle leaf `keccak256(bytes.concat(keccak256(abi.encode(...))))`, sorted-pair nodes (OZ MerkleProof).

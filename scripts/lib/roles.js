// Role map for the 11-contract suite, keyed by the manifest's `contracts` names.
// Shared by safe-transfer-admin.js and verify-deployment.js so the migration and its
// verification cannot drift apart.
//
// Derived from the constructors and onlyRole() modifiers in contracts/ — re-derive it
// if a contract changes:
//   grep -rn "_grantRole(\|onlyRole(" contracts/tokens contracts/rwa contracts/markets contracts/tge

// Every role the constructor hands to `admin` (the deployer EOA on mainnet), besides
// DEFAULT_ADMIN_ROLE. Renounce has to clear all of these, not just the ones the Safe
// takes over — otherwise the deploy key keeps e.g. USDR PAUSER and KYC_MANAGER forever.
export const DEPLOYER_ROLES = {
  usdr: ["WEBLOCK_MINTER", "WEBLOCK_PAUSER"],
  rbt: ["WEBLOCK_URI_MANAGER", "WEBLOCK_PAUSER"],
  wft: ["WEBLOCK_MINTER", "WEBLOCK_LOCK_MANAGER", "WEBLOCK_PAUSER"],
  kycRegistry: ["WEBLOCK_KYC_MANAGER"],
  seriesManager: ["WEBLOCK_OPERATOR", "WEBLOCK_TREASURY_FUNDER", "WEBLOCK_DELINQUENCY_MANAGER"],
  incomeDistributor: ["WEBLOCK_DISTRIBUTION_MANAGER"],
  spotExchange: ["WEBLOCK_SETTLEMENT", "WEBLOCK_MARKET_ADMIN"],
  navOracle: ["WEBLOCK_ORACLE_PUBLISHER", "WEBLOCK_MARKET_ADMIN"],
  insuranceFund: [],
  perpClearing: [
    "WEBLOCK_SETTLEMENT",
    "WEBLOCK_FUNDING",
    "WEBLOCK_LIQUIDATOR",
    "WEBLOCK_MARKET_ADMIN",
    "WEBLOCK_PAUSER",
  ],
  wftClaim: [],
};

// Cold roles the Safe must hold (DEFAULT_ADMIN_ROLE is granted on every contract on top).
// Mint, pause, metadata, fee and oracle-band changes all go through the Safe.
export const SAFE_COLD_ROLES = {
  usdr: ["WEBLOCK_MINTER", "WEBLOCK_PAUSER"],
  wft: ["WEBLOCK_MINTER", "WEBLOCK_LOCK_MANAGER", "WEBLOCK_PAUSER"],
  rbt: ["WEBLOCK_URI_MANAGER", "WEBLOCK_PAUSER"],
  spotExchange: ["WEBLOCK_MARKET_ADMIN"],
  navOracle: ["WEBLOCK_MARKET_ADMIN"],
  perpClearing: ["WEBLOCK_MARKET_ADMIN", "WEBLOCK_PAUSER"],
};

// Hot roles the backend operator needs for keepers (granted by deploy.js).
export const OPERATOR_HOT_ROLES = [
  ["kycRegistry", "WEBLOCK_KYC_MANAGER"],
  ["seriesManager", "WEBLOCK_OPERATOR"],
  ["seriesManager", "WEBLOCK_TREASURY_FUNDER"],
  ["seriesManager", "WEBLOCK_DELINQUENCY_MANAGER"],
  ["incomeDistributor", "WEBLOCK_DISTRIBUTION_MANAGER"],
  ["spotExchange", "WEBLOCK_SETTLEMENT"],
  ["navOracle", "WEBLOCK_ORACLE_PUBLISHER"],
  ["perpClearing", "WEBLOCK_SETTLEMENT"],
  ["perpClearing", "WEBLOCK_FUNDING"],
  ["perpClearing", "WEBLOCK_LIQUIDATOR"],
];

// The hot operator must hold none of the Safe's cold roles (SAFE_MIGRATION.md §4b).
export const OPERATOR_FORBIDDEN_ROLES = Object.entries(SAFE_COLD_ROLES).flatMap(([name, roles]) =>
  roles.map((r) => [name, r]),
);

// Minimum AVAX the mainnet keys must hold, shared by preflight-mainnet.js and deploy.js
// so the two gates can never disagree.
//
// The deployer requirement scales with the live gas price instead of being a flat
// number. At 0.055 gwei the whole suite costs ~0.0013 AVAX, so the old flat "2 AVAX"
// refused a deploy that needed a thousandth of that. 100x the estimate still covers a
// sharp gas spike mid-deploy, and the floor keeps a sane minimum when gas is near zero.

// ~24M gas measured on Fuji for the 11-contract suite + role wiring.
export const FULL_SUITE_GAS = 24_000_000n;
export const DEPLOYER_HEADROOM = 100n;

export const DEFAULT_MIN_DEPLOYER_AVAX = "0.2";
export const DEFAULT_MIN_OPERATOR_AVAX = "0.2";

export function fullSuiteCostWei(gasPrice) {
  return FULL_SUITE_GAS * gasPrice;
}

// floorWei comes from MIN_DEPLOYER_AVAX (parsed by the caller's ethers).
export function minDeployerWei(gasPrice, floorWei) {
  const scaled = fullSuiteCostWei(gasPrice) * DEPLOYER_HEADROOM;
  return scaled > floorWei ? scaled : floorWei;
}

# 함수 설명서

이 문서는 블록체인 개발자가 아니더라도 “어떤 함수가 언제 쓰이는지” 이해할 수 있도록 정리한 운영 관점 설명서입니다.

## 1. WFTToken

### `mint(to, amount)`

- 누가 호출: `MINTER_ROLE`
- 역할: 새 WFT를 발행합니다.
- 언제 사용: 초기 분배, 재단 예산 집행, 추가 거버넌스 토큰 공급

### `mintLocked(to, amount, unlockTime, memo)`

- 누가 호출: `LOCK_MANAGER_ROLE`
- 역할: 발행하면서 동시에 락업합니다.
- 언제 사용: 초기 투자자/팀 물량 배분

### `airdrop(recipients, amounts)`

- 누가 호출: `AIRDROP_ROLE`
- 역할: 여러 주소에 WFT를 일괄 배포합니다.
- 언제 사용: 마케팅 보상, 커뮤니티 리워드

### `airdropLocked(recipients, amounts, unlockTime, memo)`

- 누가 호출: `AIRDROP_ROLE`
- 역할: 에어드랍과 락업을 동시에 실행합니다.
- 언제 사용: 베스팅이 필요한 캠페인

### `createLock(account, amount, unlockTime, memo)`

- 누가 호출: `LOCK_MANAGER_ROLE`
- 역할: 이미 가진 토큰 일부를 락업 상태로 묶습니다.

### `releaseUnlockedLocks(account, lockIds)`

- 누가 호출: 누구나 가능
- 역할: 만기 지난 락을 해제합니다.
- 특징: 토큰을 보내는 함수가 아니라 전송 제한만 해제합니다.

### `revokeLock(account, lockId)`

- 누가 호출: `LOCK_MANAGER_ROLE`
- 역할: 운영자가 락을 강제로 해제합니다.

## 2. USDRToken

### `mint(to, amount)`

- 누가 호출: `MINTER_ROLE`
- 역할: USDR 발행

### `pause()` / `unpause()`

- 누가 호출: `PAUSER_ROLE`
- 역할: 비상 시 전송 중지 / 재개

## 3. RealEstateBackedToken

### `registerSeries(tokenId, propertyCode, propertyName, roundNumber, roundLabel, metadataURI)`

- 누가 호출: `MANAGER_ROLE`
- 역할: 특정 부동산 차수의 NFT 정보를 등록합니다.

### `mint(to, tokenId, quantity, data)`

- 누가 호출: `MANAGER_ROLE`
- 역할: 1차 판매 시 RBT를 발행합니다.

### `burn(from, tokenId, quantity)`

- 누가 호출: `MANAGER_ROLE`
- 역할: 환불 또는 상환 시 RBT를 소각합니다.

## 4. RBTSeriesManager

### `createSeries(params, paymentTokens, unitPrices)`

- 누가 호출: `OPERATOR_ROLE`
- 역할: 새 차수를 생성합니다.
- 포함 정보: 판매 기간, 만기일, 발행량, 결제 토큰, 가격, 메타데이터

### `openSale(tokenId)`

- 누가 호출: `OPERATOR_ROLE`
- 역할: Draft 상태의 차수를 Sale 상태로 전환합니다.

### `buy(tokenId, paymentToken, quantity, maxCost, beneficiary)`

- 누가 호출: 투자자
- 역할: USDT/USDC로 조각을 구매합니다.
- 특징: `maxCost`는 프론트엔드 견적과 실제 결제 금액이 달라질 때 방어용입니다.

### `finalizeSale(tokenId)`

- 누가 호출: `OPERATOR_ROLE`
- 역할: 판매 종료 또는 완판 후 시리즈를 활성화합니다.
- 결과: escrow 자금이 발행사 treasury로 이동

### `cancelSale(tokenId, memo)`

- 누가 호출: `OPERATOR_ROLE`
- 역할: 판매를 취소합니다.

### `claimRefund(tokenId)`

- 누가 호출: 투자자
- 역할: 취소된 차수에서 본인 투자금을 돌려받습니다.
- 결과: 보유 중인 RBT가 burn됩니다.

### `fundInterest(tokenId, paymentToken, amount)`

- 누가 호출: `TREASURY_FUNDER_ROLE`
- 역할: 이자 재원을 예치합니다.

### `claimInterest(tokenId, paymentToken)`

- 누가 호출: 투자자
- 역할: 해당 통화의 이자를 청구합니다.

### `claimInterestBatch(tokenId, paymentTokens)`

- 누가 호출: 투자자
- 역할: 여러 결제 토큰 기준 이자를 한 번에 청구합니다.

### `markDelinquent(tokenId, memo)`

- 누가 호출: `DELINQUENCY_MANAGER_ROLE`
- 역할: 연체 상태로 표시하고 2차 거래를 막습니다.

### `cureDelinquency(tokenId)`

- 누가 호출: `DELINQUENCY_MANAGER_ROLE`
- 역할: 연체 해소 후 Active 상태로 복귀시킵니다.

### `declareDefault(tokenId, memo)`

- 누가 호출: `DELINQUENCY_MANAGER_ROLE`
- 역할: 디폴트를 선언합니다.

### `enterMaturity(tokenId)`

- 누가 호출: `OPERATOR_ROLE`
- 역할: 만기 상태로 진입합니다.
- 제약: 정상 만기는 `maturityDate` 이후에만 가능, 다만 디폴트 상태면 조기 정리 가능

### `enableRedemption(tokenId, paymentToken, totalAmount)`

- 누가 호출: `TREASURY_FUNDER_ROLE`
- 역할: 상환 재원을 예치하고 조각당 상환 단가를 확정합니다.

### `redeem(tokenId, paymentToken, quantity)`

- 누가 호출: 투자자
- 역할: RBT를 소각하고 상환금을 받습니다.

## 5. RotatingVaultRouter

### `createVault(asset, makeActive)`

- 누가 호출: `TREASURY_ADMIN_ROLE`
- 역할: 새로운 vault를 생성합니다.

### `activateVault(asset, vault)`

- 누가 호출: `TREASURY_ADMIN_ROLE`
- 역할: 특정 자산의 활성 vault를 교체합니다.

### `fundFrom(asset, from, amount)`

- 누가 호출: `TREASURY_FUNDER_ROLE`
- 역할: funder 지갑에서 활성 vault로 자금을 넣습니다.

### `payout(asset, to, amount)`

- 누가 호출: `CLAIMS_MANAGER_ROLE`
- 역할: 여러 vault를 순회하며 지급합니다.

### `consolidate(asset, maxVaults)`

- 누가 호출: `TREASURY_ADMIN_ROLE`
- 역할: 오래된 vault 자산을 현재 활성 vault로 모읍니다.

## 6. RBTOrderBook

### `createAsk(tokenId, paymentToken, quantity, pricePerUnit, expiry)`

- 누가 호출: 판매자
- 역할: RBT 매도 주문 생성

### `createBid(tokenId, paymentToken, quantity, pricePerUnit, expiry)`

- 누가 호출: 구매자
- 역할: RBT 매수 주문 생성

### `fillOrder(orderId, quantity, beneficiary)`

- 누가 호출: 상대 주문 체결자
- 역할: 주문 일부 또는 전체를 체결
- 특징: bid 주문의 경우 NFT는 항상 bid maker에게 전달됩니다.

### `cancelOrder(orderId)`

- 누가 호출: 주문 생성자 또는 운영자
- 역할: 남은 주문 물량을 회수하고 종료

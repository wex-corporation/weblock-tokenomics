# 감사 범위 및 체크리스트

## 1. 감사 대상

- `contracts/tokens/WFTToken.sol`
- `contracts/tokens/USDRToken.sol`
- `contracts/tokens/RealEstateBackedToken.sol`
- `contracts/rbt/RBTSeriesManager.sol`
- `contracts/rbt/RotatingVaultRouter.sol`
- `contracts/rbt/PaymentVault.sol`
- `contracts/rbt/RBTOrderBook.sol`
- `contracts/shared/*`
- `contracts/interfaces/*`

## 2. 설계 원칙

1. 업그레이더블 프록시 미사용
2. 토큰/운영/볼트/거래 모듈 분리
3. 역할 기반 접근 제어 일관화
4. 재진입 위험이 있는 외부 전송 함수는 `ReentrancyGuard` 적용
5. 스테이블 코인 전송은 `SafeERC20` 사용

## 3. 핵심 보안 불변식

1. `Sale` 상태가 아니면 `buy`가 불가능해야 한다.
2. `Active + secondaryTradingEnabled`가 아니면 유저 간 RBT 전송이 불가능해야 한다.
3. 판매 완료 전에는 `issuerTreasury`로 투자금이 이동하면 안 된다.
4. 취소된 차수에서만 환불이 가능해야 한다.
5. 이자금은 `fundInterest`된 총액 이상으로 지급되면 안 된다.
6. 상환금은 `enableRedemption`된 총액 이상으로 지급되면 안 된다.
7. Bid 주문 체결 시 NFT 수령자는 반드시 bid maker여야 한다.
8. 정상 만기 시점 이전에는 `enterMaturity`가 허용되면 안 된다.
9. vault rotation 이후에도 기존 볼트의 잔액이 청구 가능해야 한다.
10. WFT locked balance는 unlock 전 전송되면 안 된다.

## 4. 감사자가 중점적으로 볼 항목

### 4.1 권한 및 운영 리스크

- 관리자 권한이 과도하게 집중되어 있는지
- 권한 오남용 시 피해 범위가 어디까지인지
- 멀티시그 전제로 운영할 때 권한 구조가 충분한지

### 4.2 자금 정합성

- 모집 자금, 이자금, 상환금이 서로 섞이지 않는지
- 반올림 오차(dust) 발생 시 잔액이 잠기지 않는지
- redemption snapshot과 실제 burn 흐름이 일관적인지

### 4.3 상태 전이

- Draft/Sale/Active/Delinquent/Defaulted/Matured/Cancelled 전이가 유효한지
- 운영자가 잘못된 순서로 호출했을 때 우회 경로가 없는지

### 4.4 2차 거래

- ask/bid escrow가 안전한지
- 체결/취소에서 잔액 이중 지급이 없는지
- beneficiary 파라미터 오용 가능성이 제거되었는지

## 5. 현재 테스트 커버리지 포인트

1. Primary sale 전체 흐름
2. Vault rotation 이후 이자 청구 지속성
3. Delinquent 상태에서 transfer 차단
4. Bid/Ask 체결 및 정산
5. Cancelled refund
6. Premature maturity 방지
7. WFT lock/airdrop
8. USDR pause/mint

## 6. 잔여 리스크와 운영 권고

1. `RBTOrderBook`는 온체인 단순 오더북입니다. 고빈도 거래소 수준 성능을 기대하면 안 됩니다.
2. 정수 나눗셈으로 인한 dust가 남을 수 있으므로 정산 정책 문서가 별도로 필요합니다.
3. 관리자 키는 단일 EOA 대신 멀티시그를 권장합니다.
4. 실제 메인넷 배포 전에는 슬리더, Echidna/Medusa, 정적 분석, 수동 리뷰를 추가하는 것이 좋습니다.
5. 외부 USDT/USDC가 fee-on-transfer나 blacklist 기능을 가지면 운영 가정이 달라질 수 있으니 실사용 토큰 특성을 별도 검토해야 합니다.

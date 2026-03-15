# 03. 투자자의 1차 청약 참여

## 이 시나리오가 필요한 때

- 판매 기간 동안 투자자가 USDT/USDC로 RBT를 매수할 때

## 누가 실행하나

- 투자자 지갑
- 또는 프론트엔드가 투자자 대신 트랜잭션 생성

## 준비 조건

1. 시리즈 상태가 `Sale`이어야 합니다.
2. 현재 시각이 `saleStart`와 `saleEnd` 사이여야 합니다.
3. 투자자 지갑이 결제 토큰을 보유하고 있어야 합니다.
4. 투자자 지갑이 `RBTSeriesManager`에 충분한 allowance를 줘야 합니다.

## 사전 조회

```bash
ACTION=quote-buy \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
PAYMENT_TOKEN=0xUsdt \
QUANTITY=10 \
pnpm rbt:action
```

## 매수 실행 예시

```bash
ACTION=buy \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
PAYMENT_TOKEN=0xUsdt \
QUANTITY=10 \
MAX_COST=100000000 \
BENEFICIARY=0xInvestor \
pnpm rbt:action
```

## 기대 결과

1. 투자자의 wallet에 `tokenId=1` RBT가 민팅됩니다.
2. 결제 토큰은 manager escrow에 쌓입니다.
3. 완판이면 자동으로 `Active`로 전환될 수 있습니다.

## 주의

- `MAX_COST`는 프론트엔드 견적 상한값입니다.
- allowance가 부족하면 매수는 실패합니다.

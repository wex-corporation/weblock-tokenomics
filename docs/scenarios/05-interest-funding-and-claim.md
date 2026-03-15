# 05. 이자 재원 적립과 투자자 청구

## 이 시나리오가 필요한 때

- 상품이 활성화된 뒤, 정해진 이자 지급일마다 투자자에게 분배할 재원을 적립할 때
- 투자자가 직접 이자를 청구할 때

## 운영자 준비 조건

1. 시리즈가 `Active` 또는 `Delinquent` 상태여야 합니다.
2. 운영 treasury 지갑이 payment token을 보유하고 있어야 합니다.
3. 운영 treasury 지갑이 router/manager 흐름에 맞는 allowance를 준비해야 합니다.

## 운영자: 이자금 적립

```bash
ACTION=fund-interest \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
PAYMENT_TOKEN=0xUsdt \
AMOUNT=500000000 \
pnpm rbt:action
```

## 투자자: 단일 토큰 기준 이자 청구

```bash
ACTION=claim-interest \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
PAYMENT_TOKEN=0xUsdt \
pnpm rbt:action
```

## 투자자: 여러 지급 토큰 일괄 청구

```bash
ACTION=claim-interest-batch \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
PAYMENT_TOKENS=0xUsdt,0xUsdc \
pnpm rbt:action
```

## 기대 결과

1. `accInterestPerShare`가 업데이트됩니다.
2. 투자자는 보유 수량 비율에 맞는 이자를 직접 수령합니다.
3. 중간에 NFT를 옮긴 투자자도 이전 시점 기준 권리가 분리되어 계산됩니다.

## 점검 포인트

1. 대량 전송 직후에도 claim 금액이 맞는지
2. 이전 vault에 자금이 남아 있어도 payout이 되는지

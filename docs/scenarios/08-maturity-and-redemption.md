# 08. 만기와 상환 처리

## 이 시나리오가 필요한 때

- 상품 만기일이 도래했을 때
- 또는 디폴트 이후 조기 상환 정리 절차로 들어갈 때

## 준비 조건

1. 정상 만기는 `maturityDate` 이후여야 합니다.
2. 디폴트 상태라면 조기 정리 목적으로 `enterMaturity`가 가능합니다.
3. 상환 재원은 운영 treasury가 보유하고 있어야 합니다.

## 1. 만기 진입

```bash
ACTION=enter-maturity \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
pnpm rbt:action
```

## 2. 상환 재원 적립 및 단가 확정

```bash
ACTION=enable-redemption \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
PAYMENT_TOKEN=0xUsdt \
AMOUNT=1000000000 \
pnpm rbt:action
```

## 3. 투자자 상환 청구

```bash
ACTION=redeem \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
PAYMENT_TOKEN=0xUsdt \
QUANTITY=10 \
pnpm rbt:action
```

## 기대 결과

1. `enableRedemption` 시 조각당 상환 단가가 snapshot 기준으로 계산됩니다.
2. 투자자가 `redeem` 하면 해당 수량의 RBT는 burn됩니다.
3. 투자자는 대응하는 USDT/USDC를 받습니다.

## 점검 항목

1. 상환 총액과 snapshot supply 기준 단가가 맞는지
2. burn 후 잔량과 지급액이 일치하는지

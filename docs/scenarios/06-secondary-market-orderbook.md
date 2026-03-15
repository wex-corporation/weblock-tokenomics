# 06. 2차 거래 오더북 운영

## 이 시나리오가 필요한 때

- 활성화된 상품의 RBT를 투자자끼리 사고팔 때
- 오더북 기반의 ask/bid 주문 체결을 검증할 때

## 준비 조건

1. 시리즈가 `Active` 상태여야 합니다.
2. `secondaryTradingEnabled=true`여야 합니다.
3. ask 생성자는 `RBTOrderBook`에 ERC-1155 approval을 줘야 합니다.
4. bid 생성자는 주문 총액만큼 payment token allowance를 줘야 합니다.

## 매도 주문 생성

```bash
ACTION=create-ask \
RBT_MANAGER_ADDRESS=0xManager \
RBT_ORDERBOOK_ADDRESS=0xOrderBook \
TOKEN_ID=1 \
PAYMENT_TOKEN=0xUsdt \
QUANTITY=5 \
PRICE_PER_UNIT=12000000 \
EXPIRY=1774603600 \
pnpm rbt:action
```

## 매수 주문 생성

```bash
ACTION=create-bid \
RBT_MANAGER_ADDRESS=0xManager \
RBT_ORDERBOOK_ADDRESS=0xOrderBook \
TOKEN_ID=1 \
PAYMENT_TOKEN=0xUsdt \
QUANTITY=5 \
PRICE_PER_UNIT=11000000 \
EXPIRY=1774603600 \
pnpm rbt:action
```

## 주문 체결

```bash
ACTION=fill-order \
RBT_MANAGER_ADDRESS=0xManager \
RBT_ORDERBOOK_ADDRESS=0xOrderBook \
ORDER_ID=1 \
QUANTITY=2 \
BENEFICIARY=0xBuyer \
pnpm rbt:action
```

## 주문 취소

```bash
ACTION=cancel-order \
RBT_MANAGER_ADDRESS=0xManager \
RBT_ORDERBOOK_ADDRESS=0xOrderBook \
ORDER_ID=1 \
pnpm rbt:action
```

## 기대 결과

1. ask는 RBT escrow, bid는 stablecoin escrow로 잡힙니다.
2. bid 체결 시 NFT는 bid maker에게 가고, 판매자는 결제 토큰을 받습니다.
3. 부분 체결이 가능하고, 남은 수량은 계속 유지됩니다.

# 02. RBT 차수 생성과 판매 개시

## 이 시나리오가 필요한 때

- 새 부동산 상품 또는 기존 부동산의 새 차수를 개시할 때
- 예: `A-1차`, `A-2차`, `B-1차`

## 준비 조건

1. `RBT_MANAGER_ADDRESS`가 설정돼 있어야 합니다.
2. `TOKEN_ID`, `PROPERTY_CODE`, `ROUND_LABEL`, `MAX_SUPPLY`, `PAYMENT_TOKENS`, `UNIT_PRICES`를 정해야 합니다.
3. `SALE_START < SALE_END < MATURITY_DATE` 순서를 만족해야 합니다.

## 실행 명령

### 1. 차수 생성

```bash
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
PROPERTY_CODE=A \
PROPERTY_NAME="Prime Retail Tower" \
ROUND_NUMBER=1 \
ROUND_LABEL=A-1 \
METADATA_URI=ipfs://weblock/rbt/a-1.json \
MAX_SUPPLY=10000 \
SALE_START=1774000000 \
SALE_END=1774600000 \
MATURITY_DATE=1805600000 \
ISSUER_TREASURY=0xIssuerTreasury \
PAYMENT_TOKENS=0xUsdt,0xUsdc \
UNIT_PRICES=10000000,10000000 \
OPEN_SALE=true \
pnpm series:create
```

## 기대 결과

1. 새 tokenId가 등록됩니다.
2. 결제 수단(USDT/USDC)과 단가가 저장됩니다.
3. `OPEN_SALE=true`면 자동으로 `Sale` 상태가 됩니다.

## 점검 항목

1. `ACTION=series-info`로 상태가 `Sale`인지 확인
2. `ACTION=payment-tokens`로 결제 토큰 목록 확인
3. 프론트엔드가 읽을 메타데이터 URI가 올바른지 확인

## 조회 예시

```bash
ACTION=series-info \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
pnpm rbt:action
```

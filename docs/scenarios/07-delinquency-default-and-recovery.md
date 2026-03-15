# 07. 연체, 디폴트, 정상화 처리

## 이 시나리오가 필요한 때

- 예정된 이자 지급 또는 상품 운영이 지연될 때
- 거래 중단, 회복, 강제 청산 경로를 관리할 때
- 판매 취소 후 환불이 필요할 때

## A. 연체 표시

```bash
ACTION=mark-delinquent \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
MEMO="missed coupon payment" \
pnpm rbt:action
```

### 결과

- 시리즈 상태가 `Delinquent`
- 유저 간 RBT 전송 차단
- 오더북 신규/체결도 사실상 차단

## B. 연체 해제

```bash
ACTION=cure-delinquency \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
pnpm rbt:action
```

### 결과

- 시리즈 상태가 다시 `Active`
- 2차 거래 재개 가능

## C. 디폴트 선언

```bash
ACTION=declare-default \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
MEMO="issuer failed to cure delinquency" \
pnpm rbt:action
```

### 결과

- 시리즈 상태가 `Defaulted`
- 이후 조기 정리 및 상환 절차로 넘어갈 수 있음

## D. 판매 취소 후 환불

### 운영자 취소

```bash
ACTION=cancel-sale \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
MEMO="offering withdrawn" \
pnpm rbt:action
```

### 투자자 환불 청구

```bash
ACTION=claim-refund \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
pnpm rbt:action
```

### 결과

- 투자자의 RBT가 burn됨
- escrow에 있던 본인 투자금이 반환됨

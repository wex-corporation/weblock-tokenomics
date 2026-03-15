# 04. 판매 종료와 상품 활성화

## 이 시나리오가 필요한 때

- 완판되지 않았지만 판매 종료 시점이 지나서 상품을 활성화해야 할 때
- 또는 완판 후 활성화 상태와 자금 이전을 확인할 때

## 준비 조건

1. 시리즈가 `Sale` 상태여야 합니다.
2. 판매 종료 시점이 지났거나 이미 완판이어야 합니다.

## 실행 명령

```bash
ACTION=finalize-sale \
RBT_MANAGER_ADDRESS=0xManager \
TOKEN_ID=1 \
pnpm rbt:action
```

## 기대 결과

1. 시리즈 상태가 `Active`가 됩니다.
2. escrow에 있던 USDT/USDC가 `issuerTreasury`로 이동합니다.
3. 이제 이자 적립과 2차 거래가 가능해집니다.

## 점검 항목

1. `series-info` 조회 시 `state=Active`
2. 발행사 treasury에 모집 금액이 들어왔는지 확인
3. 투자자 지갑 간 RBT 전송이 가능한지 확인

## 판매 취소로 가는 경우

판매를 열었지만 개시 자체를 철회하려면 [07. 연체, 디폴트, 정상화 처리](./07-delinquency-default-and-recovery.md)가 아니라 `cancel-sale`과 `claim-refund` 흐름을 사용해야 합니다.

# 10. WFT 거버넌스/마케팅 운영

## 이 시나리오가 필요한 때

- 초기 투자자에게 락업된 WFT를 배분할 때
- 커뮤니티 에어드랍이나 리워드 캠페인을 운영할 때
- 기존 보유분에 수동 락을 걸거나 해제할 때

## A. 즉시 발행

```bash
ACTION=wft-mint \
WFT_ADDRESS=0xWft \
RECIPIENT=0xRecipient \
AMOUNT=1000000000000000000000 \
pnpm foundation:action
```

## B. 락업 발행

```bash
ACTION=wft-mint-locked \
WFT_ADDRESS=0xWft \
RECIPIENT=0xRecipient \
AMOUNT=1000000000000000000000 \
UNLOCK_TIME=1775200000 \
MEMO="seed investor lock" \
pnpm foundation:action
```

## C. 일반 에어드랍

```bash
ACTION=wft-airdrop \
WFT_ADDRESS=0xWft \
RECIPIENTS=0xA,0xB \
AMOUNTS=1000000000000000000,2000000000000000000 \
pnpm foundation:action
```

## D. 락업 에어드랍

```bash
ACTION=wft-airdrop-locked \
WFT_ADDRESS=0xWft \
RECIPIENTS=0xA,0xB \
AMOUNTS=1000000000000000000,2000000000000000000 \
UNLOCK_TIME=1775200000 \
MEMO="campaign vesting" \
pnpm foundation:action
```

## E. 수동 락 생성

```bash
ACTION=wft-create-lock \
WFT_ADDRESS=0xWft \
RECIPIENT=0xRecipient \
AMOUNT=500000000000000000000 \
UNLOCK_TIME=1775200000 \
MEMO="manual restriction" \
pnpm foundation:action
```

## F. 락 해제

```bash
ACTION=wft-release-locks \
WFT_ADDRESS=0xWft \
RECIPIENT=0xRecipient \
LOCK_IDS=0,1 \
pnpm foundation:action
```

## G. 운영자 강제 해제

```bash
ACTION=wft-revoke-lock \
WFT_ADDRESS=0xWft \
RECIPIENT=0xRecipient \
LOCK_ID=0 \
pnpm foundation:action
```

## 기대 결과

1. WFT 총 발행량은 `maxSupply`를 넘지 않습니다.
2. 락업된 수량은 unlock 전 전송되지 않습니다.
3. 에어드랍은 여러 주소에 일괄 집행할 수 있습니다.

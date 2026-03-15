# 11. USDR 스테이블 코인 운영

## 이 시나리오가 필요한 때

- 위블록 재단 스테이블 코인을 신규 발행할 때
- 비상상황에서 일시 정지/재개할 때

## A. 신규 발행

```bash
ACTION=usdr-mint \
USDR_ADDRESS=0xUsdr \
RECIPIENT=0xRecipient \
AMOUNT=500000000 \
pnpm foundation:action
```

## B. 비상 정지

```bash
ACTION=usdr-pause \
USDR_ADDRESS=0xUsdr \
pnpm foundation:action
```

## C. 비상 정지 해제

```bash
ACTION=usdr-unpause \
USDR_ADDRESS=0xUsdr \
pnpm foundation:action
```

## 기대 결과

1. mint는 `MINTER_ROLE`만 실행할 수 있습니다.
2. pause 중에는 일반 전송이 막힙니다.
3. unpause 후에는 다시 정상 전송됩니다.

## 운영상 주의

- USDR은 스테이블 코인이므로 mint 권한 통제와 발행대장 관리가 매우 중요합니다.
- 실제 서비스에서는 mint 사유와 수량을 별도 백오피스/회계 시스템에 반드시 기록해야 합니다.

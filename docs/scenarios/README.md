# 시나리오 안내 및 공통 규칙

이 폴더의 문서는 운영자, 백엔드 개발자, 프론트엔드 개발자, 감사팀이 같은 흐름을 기준으로 시스템을 이해할 수 있게 만드는 실행 런북입니다.

## 읽는 방법

1. 먼저 [시나리오 카탈로그](../SCENARIO_CATALOG.md)에서 필요한 업무를 찾습니다.
2. 해당 시나리오 문서에서 준비 조건과 실행 명령을 확인합니다.
3. 실행 후 기대 결과와 점검 항목을 검증합니다.

## 공통 전제

### 1. `.env` 준비

- 모든 스크립트는 `.env` 또는 현재 셸 환경 변수를 읽습니다.
- 기본 템플릿은 [`.env.example`](/Users/shchoi/Documents/weblock/weblock-token/.env.example)입니다.

### 2. 서명 키

- 스크립트는 현재 설정된 `DEPLOYER_PRIVATE_KEY`로 실행됩니다.
- 운영자 작업과 투자자 작업은 보통 서로 다른 키로 실행해야 합니다.

### 3. 금액 단위

- USDT / USDC / USDR: `6 decimals`
- WFT: `18 decimals`
- 예시:
  - 100 USDT = `100000000`
  - 1 WFT = `1000000000000000000`

### 4. 자주 쓰는 명령

```bash
pnpm compile
pnpm test
pnpm deploy:subnet
pnpm series:create
pnpm rbt:action
pnpm foundation:action
```

## 역할 기준으로 보는 주요 작업

### 운영자

- 배포
- 차수 생성
- 판매 개시/종료
- 이자 재원 입금
- 연체/디폴트 처리
- 만기 진입
- 상환 재원 입금
- 볼트 교체
- WFT 마케팅 분배
- USDR 운영

### 투자자

- 1차 청약 참여
- 이자 청구
- 2차 거래 참여
- 환불 청구
- 상환 청구

### 감사팀

- 상태 전이 검증
- 자금 흐름 검증
- 권한 분리 검증
- 오더북 체결 규칙 검증
- vault rotation 이후 지급 연속성 검증

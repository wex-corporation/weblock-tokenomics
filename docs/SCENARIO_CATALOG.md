# 시나리오 카탈로그

이 문서는 `weblock-token` 프로젝트로 실제로 할 수 있는 작업을 시나리오별로 정리한 인덱스입니다.

## 빠르게 이해하는 분류

### A. 시스템 준비

1. 컨트랙트 배포
2. 운영 권한 확인
3. 스테이블 코인 연결
4. 차수 생성 준비

### B. RBT 상품 운영

1. 새 차수 생성
2. 판매 시작
3. 투자자 1차 매수
4. 판매 종료 및 활성화
5. 이자 지급 재원 입금
6. 투자자 이자 청구
7. 2차 시장 매도/매수 주문 생성
8. 2차 거래 체결 및 취소
9. 연체 표시
10. 연체 해제
11. 디폴트 선언
12. 만기 진입
13. 상환 재원 입금
14. 투자자 상환 청구
15. 판매 취소 후 환불
16. 지급 볼트 교체
17. 구 볼트 잔액 정리

### C. 재단 토큰 운영

1. WFT 신규 발행
2. WFT 락업 발행
3. WFT 일괄 에어드랍
4. WFT 락업 에어드랍
5. WFT 수동 락 생성
6. WFT 락 해제
7. WFT 락 강제 해제

### D. 스테이블 코인 운영

1. USDR 신규 발행
2. USDR 비상 정지
3. USDR 비상 정지 해제

## 시나리오 문서 링크

- [시나리오 안내 및 공통 규칙](./scenarios/README.md)
- [01. 초기 배포와 시스템 부팅](./scenarios/01-system-bootstrap.md)
- [02. RBT 차수 생성과 판매 개시](./scenarios/02-create-and-open-series.md)
- [03. 투자자의 1차 청약 참여](./scenarios/03-primary-sale-investment.md)
- [04. 판매 종료와 상품 활성화](./scenarios/04-finalize-and-activate.md)
- [05. 이자 재원 적립과 투자자 청구](./scenarios/05-interest-funding-and-claim.md)
- [06. 2차 거래 오더북 운영](./scenarios/06-secondary-market-orderbook.md)
- [07. 연체, 디폴트, 정상화 처리](./scenarios/07-delinquency-default-and-recovery.md)
- [08. 만기와 상환 처리](./scenarios/08-maturity-and-redemption.md)
- [09. 지급 볼트 교체와 통합](./scenarios/09-vault-rotation.md)
- [10. WFT 거버넌스/마케팅 운영](./scenarios/10-wft-governance-and-marketing.md)
- [11. USDR 스테이블 코인 운영](./scenarios/11-usdr-operations.md)

## 실행용 스크립트 요약

### 시스템/차수 생성

- `pnpm deploy:subnet`
- `pnpm series:create`

### RBT 운영

- `pnpm rbt:action`

지원 ACTION:

- `buy`
- `finalize-sale`
- `cancel-sale`
- `fund-interest`
- `claim-interest`
- `claim-interest-batch`
- `mark-delinquent`
- `cure-delinquency`
- `declare-default`
- `enter-maturity`
- `enable-redemption`
- `redeem`
- `claim-refund`
- `series-info`
- `quote-buy`
- `payment-tokens`
- `create-ask`
- `create-bid`
- `fill-order`
- `cancel-order`

### 재단 토큰 운영

- `pnpm foundation:action`

지원 ACTION:

- `wft-mint`
- `wft-mint-locked`
- `wft-airdrop`
- `wft-airdrop-locked`
- `wft-create-lock`
- `wft-release-locks`
- `wft-revoke-lock`
- `usdr-mint`
- `usdr-pause`
- `usdr-unpause`

## 운영 팁

1. USDT/USDC/USDR는 기본적으로 6 decimals 기준으로 금액을 넣습니다.
2. WFT는 18 decimals 기준으로 금액을 넣습니다.
3. `pnpm ...` 명령은 현재 `.env`의 `DEPLOYER_PRIVATE_KEY`로 서명합니다.
4. 투자자 관점 실행이 필요하면 투자자 키로 `.env`를 바꿔 실행하거나, 실제 서비스 앱에서 호출해야 합니다.

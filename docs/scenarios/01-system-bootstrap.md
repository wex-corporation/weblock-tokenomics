# 01. 초기 배포와 시스템 부팅

## 이 시나리오가 필요한 때

- 새 Avalanche Subnet 환경에 위블록 컨트랙트 세트를 처음 배포할 때
- 개발/스테이징/실서비스 환경을 새로 만들 때

## 누가 실행하나

- 스마트컨트랙트 운영자
- DevOps 또는 프로토콜 운영 담당자

## 준비 조건

1. Subnet RPC가 열려 있어야 합니다.
2. 배포자 지갑에 가스가 있어야 합니다.
3. `.env`에 관리자 주소와 treasury 주소가 들어 있어야 합니다.
4. USDT/USDC 주소를 이미 알고 있거나, mock stablecoin을 함께 배포할지 결정해야 합니다.

## 실행 명령

### 1. 환경 변수 준비

```bash
cp .env.example .env
```

### 2. 서브넷 배포

```bash
pnpm deploy:subnet
```

## 기대 결과

1. WFT, USDR, RBT, SeriesManager, OrderBook, InterestRouter, RedemptionRouter가 배포됩니다.
2. 기본 지급용 vault가 USDT/USDC 각각에 대해 생성됩니다.
3. `deployments/avalancheSubnet.json`에 주소가 기록됩니다.

## 실행 후 확인할 것

1. `deployments/avalancheSubnet.json` 파일 존재 여부
2. `rbt`에 `manager` role이 부여됐는지
3. `interestRouter`, `redemptionRouter`에서 active vault가 설정됐는지

## 같이 자주 이어지는 다음 작업

- [02. RBT 차수 생성과 판매 개시](./02-create-and-open-series.md)

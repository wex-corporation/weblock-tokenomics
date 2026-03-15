# WeBlock Token Suite

Avalanche Subnet EVM 환경에서 사용할 위블록 토큰/상품 발행 컨트랙트 프로젝트입니다. 이 저장소는 아래 세 가지 축을 분리해서 설계했습니다.

1. `RBT` : 부동산 매출채권 기반 조각 투자 권리를 나타내는 ERC-1155
2. `WFT` : 위블록 재단 거버넌스와 마케팅 보상용 ERC-20
3. `USDR` : 위블록 재단 스테이블 코인 ERC-20

추가로 RBT 운영을 위해 아래 모듈을 함께 제공합니다.

1. `RBTSeriesManager` : 차수 생성, 모집, 활성화, 이자 배분, 만기/디폴트/상환 처리
2. `RotatingVaultRouter` : 이자금/상환금 트레저리 라우터 및 볼트 교체
3. `RBTOrderBook` : 유저 간 RBT 2차 거래용 온체인 오더북
4. `RealEstateBackedToken` : RBT ERC-1155 토큰 본체

## 왜 이렇게 분리했는가

- 토큰 본체와 운영 로직을 분리해 감사 범위를 명확하게 유지합니다.
- 이자금/상환금 트레저리를 회전 가능한 볼트로 분리해 보안사고 대응과 키 교체가 쉽습니다.
- 주문 체결 모듈을 RBT 코어와 분리해, 향후 오프체인 매칭 엔진으로 교체해도 핵심 권리 로직은 유지됩니다.
- 업그레이더블 프록시를 쓰지 않아 저장소 레이아웃/초기화 실수 리스크를 줄였습니다.

## 디렉터리

- `contracts/tokens` : WFT, USDR, RBT 토큰 컨트랙트
- `contracts/rbt` : RBT 발행/이자/상환/오더북 컨트랙트
- `contracts/shared` : 공용 role / error 정의
- `contracts/interfaces` : 토큰-매니저 인터페이스
- `test` : 핵심 흐름 테스트
- `scripts` : 배포 및 차수 생성 스크립트
- `docs` : 감사용 문서, 운영 문서, 비개발자용 설명서

## 빠른 시작

```bash
cd /Users/shchoi/Documents/weblock/weblock-token
pnpm install
pnpm compile
pnpm test
```

## 배포

1. `.env.example`를 복사해 `.env`를 만듭니다.
2. Avalanche Subnet RPC, 배포자 키, 관리자 주소, 스테이블 코인 주소를 채웁니다.
3. 아래 명령으로 배포합니다.

```bash
pnpm hardhat run scripts/deploy.js --network avalancheSubnet
```

배포 결과는 `deployments/<network>.json`에 저장됩니다.

## 차수 개설 예시

RBT는 하나의 부동산에 대해 `A-1`, `A-2`, `A-3`처럼 여러 차수를 발행할 수 있습니다.

예시:

- 자산 가치: 60억 원
- 차수 규모: 1억 원
- 조각 가격: 1만 원
- 발행 조각 수: 10,000개

실행 순서:

```bash
pnpm hardhat run scripts/create-series.js --network avalancheSubnet
```

필수 환경 변수:

- `RBT_MANAGER_ADDRESS`
- `TOKEN_ID`
- `PROPERTY_CODE`
- `PROPERTY_NAME`
- `ROUND_NUMBER`
- `ROUND_LABEL`
- `MAX_SUPPLY`
- `SALE_START`
- `SALE_END`
- `MATURITY_DATE`
- `ISSUER_TREASURY`
- `PAYMENT_TOKENS`
- `UNIT_PRICES`

## 테스트 범위

현재 테스트는 아래 흐름을 검증합니다.

1. WFT lock / revoke / airdrop
2. USDR mint / pause / transfer
3. RBT 모집 -> 판매 완료 -> 이자 배분 -> 만기 -> 상환
4. 볼트 교체 후에도 기존 시리즈 이자 청구 유지
5. 연체 상태에서 2차 거래 차단 및 cure 후 재개
6. 온체인 ask / bid 오더북 체결
7. 판매 취소 후 환불
8. 만기일 이전 premature maturity 차단

## 문서 목록

- [아키텍처 문서](./docs/ARCHITECTURE.md)
- [감사 범위와 체크리스트](./docs/AUDIT_SCOPE.md)
- [위협 모델](./docs/THREAT_MODEL.md)
- [운영 절차](./docs/OPERATIONS.md)
- [함수 설명서](./docs/FUNCTION_REFERENCE.md)
- [비개발자용 설명서](./docs/NON_TECHNICAL_GUIDE.md)

## 운영상 주의

- `RBTOrderBook`는 고빈도 CEX 스타일 매칭 엔진이 아니라, 저빈도 실물자산 거래를 위한 온체인 체결 보조 모듈입니다.
- 이자/상환 비율은 정수 나눗셈으로 계산되므로 소량의 dust가 남을 수 있습니다. 운영팀은 잔여 자산 정산 정책을 별도로 가져가야 합니다.
- 본 프로젝트는 비업그레이더블 기본 설계입니다. 차후 요구가 늘면 새 버전을 배포하고 자산을 마이그레이션하는 절차를 권장합니다.

# WeBlock 컨트랙트 Avalanche 메인넷 배포 절차

작성 2026-09-16. 대상: `contracts/` 11개 컨트랙트를 Avalanche C-Chain(43114)에 배포.
Safe 구성은 [SAFE_MAINNET.md](./SAFE_MAINNET.md), 백엔드/프론트 연동은 저장소 루트의
`docs/AVALANCHE_MAINNET_RUNBOOK.md`.

---

## 0. Fuji와 달라지는 것

| 항목 | Fuji | 메인넷 |
|---|---|---|
| 스테이블코인 | MockERC20 자체 배포 (`mint()` 공개) | **실제 USDC/USDT** (외부, 발행 불가) |
| admin/treasury/operator | 전부 deployer 1개 주소 | admin=deployer(배포 한정), treasury·operator는 **별도 주소 필수** |
| Perp `MARKET_ADMIN` | operator에 부여 | **operator에 미부여** (콜드 전용, §4b) |
| faucet | 켜짐 | 코드 레벨 차단 |
| 시딩 | 목 민팅 + 자기매수 | 발행/매수 없음, 시리즈 생성만 |
| 배포키 env | `DEPLOYER_PRIVATE_KEY` | `MAINNET_DEPLOYER_PRIVATE_KEY` (별도) |

배포키를 분리한 이유는 단순하다 — `.env`에 남아 있는 테스트넷 키가 43114 트랜잭션에
서명하는 사고를 구조적으로 막기 위함이다.

---

## 1. 사전 준비

```bash
cd weblock-token
cp .env.mainnet.example .env.mainnet
$EDITOR .env.mainnet          # 전 항목 채우기
```

반드시 채워야 하는 것:

- `AVALANCHE_RPC_URL` — **전용 엔드포인트**. 공개 노드(api.avax.network)는 레이트리밋이
  있어 배포 중 요청이 끊기면 스위트가 절반만 배선된 상태로 남는다.
- `MAINNET_DEPLOYER_PRIVATE_KEY` — 가스용 AVAX 보유 EOA (기준은 아래 프리플라이트).
- `FOUNDATION_TREASURY_ADDRESS` / `FEE_TREASURY_ADDRESS` — Safe 권장.
- `BACKEND_OPERATOR_ADDRESS` — 백엔드 핫 서명자. 가스용 AVAX 필요.
- `FALLBACK_RBT_URI` — 실제 메타데이터 베이스 URI (플레이스홀더면 배포 거부).
- `USDC_ADDRESS` / `USDT_ADDRESS` — 아래 검증된 값.

### 외부 스테이블코인 (2026-09-16 온체인 검증: `symbol()`/`decimals()`)

| 토큰 | 주소 | symbol | dp |
|---|---|---|---|
| **USDC (Circle 네이티브)** | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | `USDC` | 6 |
| **USDt (Tether 네이티브)** | `0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7` | `USDt` | 6 |
| USDC.e (브릿지) | `0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664` | `USDC.e` | 6 |
| USDT.e (브릿지) | `0xc7198437980c041c805A1EDcbA50c1Ce5db95118` | `USDT.e` | 6 |

기본값은 네이티브 USDC/USDt다. **USDC는 `SpotExchange`의 immutable `quote` 토큰**이므로
이 선택은 배포 후 변경 불가 — SpotExchange를 재배포해야 한다. 유동성이 어디에 있는지
확인하고 고르되, 현재 C-Chain 기준으로는 네이티브 USDC가 표준이다.

---

## 2. 프리플라이트 (읽기 전용, 무료)

```bash
set -a; source .env.mainnet; set +a
pnpm preflight:mainnet
```

`READY`가 나올 때까지 FAIL을 전부 해소한다. 점검 항목:

- chainId 43114 연결, 배포키 EOA 여부 + AVAX 잔액 ≥ max(`MIN_DEPLOYER_AVAX`(기본 0.2), 현재 가스가 기준 전체 배포비 × 100)
- 필수 env 전부 설정, `DEPLOY_MOCK_STABLES=false`
- USDC/USDT 온체인 실재 + `symbol()`/`decimals()==6` 확인
- treasury/feeTreasury/operator가 배포키와 다른지, operator 가스 잔액 ≥ `MIN_OPERATOR_AVAX`(기본 0.2)
- Safe 1.4.1 인프라 4종 실재
- 현재 gasPrice 기준 전체 배포 예상 비용 출력

---

## 3. 배포

```bash
pnpm compile && pnpm test           # 20 tests 통과 확인
CONFIRM_MAINNET=DEPLOY pnpm deploy:mainnet
```

`deploy.js`가 메인넷에서 추가로 강제하는 것:

1. `CONFIRM_MAINNET=DEPLOY` 없으면 거부.
2. `DEPLOY_MOCK_STABLES=true`면 거부.
3. `ADMIN_ADDRESS`가 deployer가 아니면 거부 — 배선(`setGate`/`grantRole`)이 deployer
   서명이므로 admin이 Safe면 아무도 배선할 수 없는 스위트가 나온다. 거버넌스는 배포
   **이후** `safe-transfer-admin.js`로 옮긴다.
4. treasury/feeTreasury/operator가 deployer와 같으면 거부.
5. USDC/USDT 코드 존재 + 6dp 확인 (배포 시작 **전에**).
6. `FALLBACK_RBT_URI` 플레이스홀더면 거부.
7. AVAX 잔액이 프리플라이트와 같은 기준(`scripts/lib/gas-budget.js`)에 못 미치면 거부.
8. operator에게 PerpClearing `MARKET_ADMIN`을 **부여하지 않음**.

산출물:

- `deployments/avalanche.json` — 주소 매니페스트 + `deployBlock`(인덱서 시작 블록) +
  `mockStablecoins: false` + `safe: null`
- `abis/*.json` — 백엔드·지갑 SDK가 소비하는 ABI 12종

---

## 4. 배포 검증

```bash
pnpm verify:mainnet
```

- 11개 컨트랙트 + 스테이블코인 바이트코드 존재
- `mockStablecoins === false`, 스테이블코인 6dp
- 배선: `RBT.gate == SeriesManager`, `gateExempt[SpotExchange]`,
  `RBT.MANAGER -> SeriesManager`, `InsuranceFund.DRAWER -> PerpClearing`,
  `SpotExchange.quote == USDC`, `SpotExchange.rbt == RBT`
- 핫 operator가 **가져야 할** 운영 role 10종 보유
- 핫 operator가 **가지면 안 되는** 콜드 role 미보유 (메인넷에서는 FAIL로 처리)
- `DEFAULT_ADMIN_ROLE`이 operator에 없음

---

## 5. 시딩 (발행·매수 없음)

Safe 이관 **전에** 한다. `createSeries`(OPERATOR)·`createMarket`(MARKET_ADMIN)·
`publish`(ORACLE_PUBLISHER)가 전부 생성자에서 `admin`(=deployer)에게 부여된 권한이기 때문이다.
이관 후에는 이 작업들이 전부 Safe 트랜잭션이 된다.

```bash
SEED_CONFIRM=SEED \
SEED_TOKEN_ID=1 SEED_PRICE=10000000 SEED_MAX_SUPPLY=10000 \
SEED_SALE_END=<unix> SEED_MATURITY=<unix> \
SEED_ISSUER_TREASURY=0xSAFE SEED_NAV=10000000 \
SEED_OPEN_SALE=false \
  pnpm seed:mainnet
```

- `SEED_*` 파라미터에 기본값이 없다 — 가격·공급량·만기를 실수로 테스트값 그대로
  메인넷에 올리는 것을 막기 위함이다.
- `SEED_OPEN_SALE=false`가 기본. 판매 개시는 어드민 콘솔에서 의도적으로 연다.
- 매니페스트가 목 스테이블코인이면 거부.
- perp는 `SEED_PERP=true`일 때만 생성 (마진/수수료 파라미터 전부 명시 필수).

---

## 6. 거버넌스 이관

→ [SAFE_MAINNET.md](./SAFE_MAINNET.md)

---

## 7. 반드시 알고 갈 것

1. **외부 감사 미완료.** `SECURITY_REVIEW.md` H-1(PerpClearing 전역 솔벤시 모델)은 코드로
   완화(`maxFillDeviationBps` 밴드)됐고 테스트도 있지만, 제3자 감사는 받지 않았다.
   실자금 규모를 제한하거나 perp를 후행 출시하는 판단이 필요하다.
2. **컨트랙트는 불변(immutable).** UUPS 프록시가 아니다. 로직 버그 수정 = 재배포 + 마이그레이션.
   거버넌스 대상은 파라미터·role·pause뿐이다.
3. **USDR은 무담보 내부 스테이블코인**이고 perp 담보 자산이다. 메인넷에서 초기공급
   1,000,000 USDR을 발행한다는 것은 준비금 없는 토큰을 담보로 쓰는 것이므로, 발행량과
   담보 정책은 배포 전에 별도 결정이 필요하다 (`USDR_INITIAL_SUPPLY`).
4. **perp = 무기한선물.** 한국 거주자 대상 규제 이슈가 있다. 백엔드 geo-access는 현재 US만
   차단한다.

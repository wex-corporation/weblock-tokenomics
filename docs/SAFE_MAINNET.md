# Gnosis Safe 메인넷 구성 절차 (Avalanche C-Chain, 43114)

작성 2026-09-16. 대상: 메인넷 거버넌스 Safe 신규 생성 + WeBlock 컨트랙트 권한 이관.
Fuji 실증 기록과 role 배치 원칙은 [SAFE_MIGRATION.md](./SAFE_MIGRATION.md) 참조 — 이 문서는
**메인넷에서 실제로 수행하는 절차**만 다룬다.

---

## 0. 이 문서가 전제하는 것

- 컨트랙트는 아직 배포 전이거나, 배포 직후 deployer EOA가 `DEFAULT_ADMIN_ROLE`을 쥔 상태다.
- Safe는 **컨트랙트 배포보다 먼저 만들어도 되고 나중에 만들어도 된다.** 다만 권한 이관
  (`safe-transfer-admin.js`)은 반드시 배포 + 시딩 이후에 수행한다. 시딩에 쓰이는
  `createSeries`/`createMarket`/`publish`가 전부 deployer 권한이기 때문이다.

---

## 1. 서명자 구성 결정 (되돌리기 가장 어려운 선택)

| 구성 | 키 분실 시 | 키 1개 탈취 시 | 권고 |
|---|---|---|---|
| 2-of-2 | **거버넌스 영구 잠김** | 안전 | ✗ (스크립트가 `SAFE_ALLOW_2OF2=yes` 요구) |
| 2-of-3 | 1개까지 복구 가능 | 안전 | ✓ 최소 권장 |
| 3-of-5 | 2개까지 복구 가능 | 안전 | ✓ 팀 규모가 되면 |

Fuji 실증은 2-of-2였지만 그건 테스트넷이라 가능했던 것이다. 메인넷 2-of-2는 서명자 한 명이
퇴사·사고·기기분실만 해도 **모든 파라미터 변경·일시정지·발행이 영구히 불가능**해진다.
`deploy-safe.js`는 메인넷 2-of-2를 기본 거부한다.

**서명자 키 요건**

- 각 서명자는 **서로 다른 하드웨어 지갑**(Ledger / Trezor)을 쓴다. 같은 시드에서 파생된
  주소 2개는 서명자 2명이 아니라 키 1개다.
- 각 서명자 주소에 가스용 AVAX를 최소 0.05 넣어둔다. 서명 트랜잭션도 가스를 낸다.
- 시드 문구는 물리적으로 분리 보관. 한 금고에 전부 넣으면 N-of-M의 의미가 없다.

---

## 2. Safe 생성 — 두 가지 경로

두 경로 모두 **동일한 Safe 1.4.1 구성**을 만든다. Avalanche 메인넷에 정식 인프라가 배포되어
있음은 `eth_getCode`로 확인 완료(2026-09-16):

```
SafeL2 1.4.1 singleton   0x29fcB43b46531BcA003ddC8FCB67FFE91900C762   DEPLOYED
SafeProxyFactory 1.4.1   0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67   DEPLOYED
CompatibilityFallback    0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99   DEPLOYED
MultiSendCallOnly 1.4.1  0x9641d764fc13c8B624c04430C7356C1C7C8102e2   DEPLOYED
```

### 경로 A — Safe 공식 UI (하드웨어 지갑이면 이쪽 권장)

1. <https://app.safe.global> 접속 → 지갑 연결 → 네트워크 **Avalanche** 선택.
2. `Create new Safe` → 서명자 주소 전부 입력 → threshold 지정.
3. 배포 트랜잭션 서명 (가스 ~0.02 AVAX).
4. 생성된 주소를 `deployments/avalanche-safe.json`에 기록한다.
   `deployments/avalanche-safe.example.json`이 그 형식이다. **개인키는 절대 적지 않는다**
   (Fuji 기록에는 테스트넷 owner B 키가 들어있지만 메인넷에서는 금지).

### 경로 B — 스크립트 (재현 가능한 배포가 필요할 때)

```bash
cd weblock-token
set -a; source .env.mainnet; set +a

# 1) 먼저 예측 주소만 뽑아 팀이 눈으로 확인 — 트랜잭션 전송 없음
SAFE_OWNERS=0xA,0xB,0xC SAFE_THRESHOLD=2 DRY_RUN=true \
  npx hardhat run scripts/deploy-safe.js --network avalanche

# 2) 실제 생성
SAFE_OWNERS=0xA,0xB,0xC SAFE_THRESHOLD=2 \
  npx hardhat run scripts/deploy-safe.js --network avalanche
```

스크립트가 하는 검증:

- 메인넷에서 **키를 절대 생성하지 않는다** (`SAFE_OWNERS` 미지정 시 즉시 실패).
- owner 중복·비주소·컨트랙트 여부 점검, threshold 범위(2 이상) 강제.
- CREATE2 예측 주소를 먼저 계산해 출력하고, 배포 후 실제 주소와 **불일치하면 중단**.
- 배포 후 `getOwners()`/`getThreshold()`/`VERSION()`을 다시 읽어 요청과 대조.

> `SAFE_SALT`를 바꾸면 같은 owner 구성으로도 다른 주소가 나온다. 기본 0으로 두면
> 동일 입력 → 동일 주소이므로, 이미 존재하면 스크립트가 "already exists"로 빠진다.

---

## 3. Safe 서명 리허설 (권한 이관 **전에** 반드시)

아직 WeBlock 컨트랙트와 무관한 트랜잭션으로 N-of-M 흐름을 몸으로 확인한다.

1. Safe에 소액 AVAX 입금.
2. Safe UI에서 `New transaction` → 자기 자신에게 0.001 AVAX 전송 생성.
3. 서명자 1명만 서명 → **실행 버튼이 비활성**인지 확인 (threshold 미달).
4. 두 번째 서명자 서명 → 실행 → 성공 확인.

Fuji에서 이 흐름은 이미 실증됐다(1서명 = `GS020` revert, 2서명 = 성공,
`SAFE_MIGRATION.md` §4). 메인넷 서명자 구성이 다르므로 **새 구성으로 다시 한 번** 한다.

---

## 4. WeBlock 권한 이관

배포 + 시딩이 끝난 뒤 실행한다.

```bash
cd weblock-token
set -a; source .env.mainnet; set +a

# 1) 무전송 플랜 확인
SAFE_ADDRESS=0xSAFE DRY_RUN=true CONFIRM_MAINNET=GOVERNANCE \
  npx hardhat run scripts/safe-transfer-admin.js --network avalanche

# 2) 실제 grant (deployer EOA 권한은 아직 유지)
SAFE_ADDRESS=0xSAFE CONFIRM_MAINNET=GOVERNANCE \
  npx hardhat run scripts/safe-transfer-admin.js --network avalanche

# 3) 검증
SAFE_ADDRESS=0xSAFE npx hardhat run scripts/verify-deployment.js --network avalanche
```

스크립트가 수행하는 것:

1. **Safe 사전 검증** — `SAFE_ADDRESS`에 코드가 있는지, `getOwners()`/`getThreshold()`에
   응답하는지, threshold가 2 이상인지. EOA나 오타 주소에 `DEFAULT_ADMIN_ROLE`을 준 뒤
   renounce하면 거버넌스가 영구히 잠기므로 이 검증은 우회 불가.
2. 11개 컨트랙트 전부에 `DEFAULT_ADMIN_ROLE` grant + 콜드 role
   (USDR/WFT `MINTER`, RBT `URI_MANAGER`·`LOCK_MANAGER`, SeriesManager `TREASURY_ADMIN`,
   Spot/Perp `MARKET_ADMIN`, Perp `PAUSER`) grant.
3. **핫 operator의 콜드 role 회수** — 메인넷에서 기본 ON. `SAFE_MIGRATION.md` §4b가
   하드블로커로 지정한 항목이다: PerpClearing `MARKET_ADMIN`은 `setMaxFillDeviationBps`
   (= 오라클 안전밴드)를 게이트하므로, 핫키가 이걸 쥐면 밴드를 0으로 만들고 임의 가격에
   정산할 수 있다. 회수 대상은 Perp `MARKET_ADMIN`/`PAUSER`, Spot·Nav `MARKET_ADMIN`,
   USDR·WFT `MINTER`.
   (참고: `deploy.js`도 메인넷에서는 애초에 operator에게 Perp `MARKET_ADMIN`을 주지 않는다.)
4. 매니페스트 `deployments/avalanche.json`에 `safe` 필드 기록.

**핫 operator에 남는 운영 role** — 정산·오라클·청산·KYC 브릿지 키퍼가 사람 서명 없이 계속
돌아야 하므로 유지: `SETTLEMENT`(Spot·Perp), `ORACLE_PUBLISHER`, `FUNDING`, `LIQUIDATOR`,
`KYC_MANAGER`, `DISTRIBUTION_MANAGER`, `TREASURY_FUNDER`, `DELINQUENCY_MANAGER`.
Safe가 `DEFAULT_ADMIN_ROLE`을 쥐고 있으므로 키 유출 시 언제든 회수 가능하다.

---

## 5. 거버넌스 리허설 → deployer EOA 권한 포기

**되돌릴 수 없는 단계다.** 앞 단계가 전부 검증된 뒤에만 한다.

1. Safe로 실제 거버넌스 트랜잭션 1건 실행 (예: `SpotExchange.setFeeConfig`로 feeTreasury
   재지정, 또는 `PerpClearing.setMaxFillDeviationBps`를 현재값으로 재설정).
   → N-of-M 서명이 WeBlock AccessControl에 실제로 먹히는지 확인.
2. 백엔드 키퍼가 정상 동작 중인지 확인 (정산·NAV 발행 로그).
3. 마지막에:

```bash
SAFE_ADDRESS=0xSAFE RENOUNCE_EOA=true CONFIRM_MAINNET=GOVERNANCE \
  npx hardhat run scripts/safe-transfer-admin.js --network avalanche

SAFE_ADDRESS=0xSAFE EXPECT_RENOUNCED=true \
  npx hardhat run scripts/verify-deployment.js --network avalanche
```

이후 모든 파라미터·발행·일시정지는 서명 N명이 필요하다.

---

## 6. 자산 수령처 Safe 재지정

권한 이관과 별개로, **돈이 흘러들어오는 주소**도 Safe로 옮겨야 한다.

| 대상 | 현재 | 변경 방법 |
|---|---|---|
| SpotExchange 수수료 | 배포 인자 `feeTreasury` | Safe에서 `setFeeConfig(safe, feeBps)` (MARKET_ADMIN) |
| USDR 초기공급 | 배포 인자 `treasury`로 발행됨 | 잔액을 Safe로 `transfer` |
| InsuranceFund 잔액 | 컨트랙트 보유 | 인출 경로는 `DRAWER`(PerpClearing) 전용 — 이관 불필요 |
| RBT 판매대금 | 시리즈별 `issuerTreasury` | `seed-mainnet.js`의 `SEED_ISSUER_TREASURY`로 처음부터 Safe 지정 권장 |

Safe 1.4.1 + CompatibilityFallbackHandler는 ERC20/ERC721/ERC1155 수신을 모두 지원하므로
자산 보관처로 안전하다 (감사 결과: 이 스위트에서 treasury가 ERC-1155를 수령하는 경로는 없음).

---

## 7. 체크리스트

- [ ] threshold ≥ 2, 서명자 ≥ 3 (2-of-2 아님)
- [ ] 서명자 전원 서로 다른 하드웨어 지갑, 시드 분리 보관
- [ ] 서명자 각 주소 AVAX ≥ 0.05
- [ ] Safe 생성 후 `getOwners()`/`getThreshold()` 온체인 재확인
- [ ] WeBlock과 무관한 트랜잭션으로 N-of-M 리허설 완료
- [ ] `safe-transfer-admin.js` grant + `verify-deployment.js` 전항목 PASS
- [ ] 핫 operator의 Perp `MARKET_ADMIN` 회수 확인 (§4b)
- [ ] Safe로 실제 거버넌스 트랜잭션 1건 성공
- [ ] 백엔드 키퍼 무중단 확인
- [ ] (최후) `RENOUNCE_EOA=true` + `EXPECT_RENOUNCED=true` 검증 PASS
- [ ] `deployments/avalanche-safe.json` 기록 — **개인키 미포함**
- [ ] feeTreasury / USDR 잔액 Safe 재지정

# WeBlock 거버넌스 → Gnosis Safe 2-of-2 이관 (감사 · 스크립트 · 실증)

작성 2026-07-07 밤샘 스프린트. 대상: Fuji 배포본(`deployments/fuji.json`) 및 향후 메인넷.

## 1. 결론 — 이관 가능함 (구조 확인)

11개 컨트랙트 전부 **OpenZeppelin AccessControl** 기반이며, `DEFAULT_ADMIN_ROLE`이 모든 하위 role의
role-admin이다. Safe(=한 컨트랙트 주소)에 `DEFAULT_ADMIN_ROLE`을 부여하면 그 Safe가 이후 모든 role을
grant/revoke 할 수 있다. 이관을 막는 요소가 **없음**을 코드 감사로 확인:

- `tx.origin` / `msg.sender == tx.origin` / `Ownable` / `onlyOwner` **전무** (`grep` 결과 0건). 순수 AccessControl.
- admin이 컨트랙트(Safe)여도 깨지는 콜백/EOA 가정 없음.
- **treasury/feeTreasury가 ERC-1155(RBT)를 수령하지 않음** → Safe에 ERC1155Receiver 불필요.
  자금은 ERC20만 이동: SpotExchange 수수료(quote ERC20) → `feeTreasury`, InsuranceFund·PerpClearing 담보(USDR).
  Safe(1.4.1 + CompatibilityFallbackHandler)는 ERC20 및 ERC1155/721 수신 모두 지원하므로 자산 보관도 안전.
- 온체인 현황(2026-07-07 read): deployer `0xC4C4…6229`가 11개 전부 `DEFAULT_ADMIN_ROLE` 보유.

## 2. Role 배치 원칙 (콜드 vs 핫)

Safe(2-of-2, 콜드)로 옮길 **거버넌스** 권한과, 백엔드 operator(`0x04d974…`, 핫)에 남길 **운영** 권한을 분리한다.
운영 role까지 2-of-2 뒤에 두면 정산·오라클·청산 키퍼가 매 배치마다 사람 2명 서명을 요구해 멈춘다.

| 구분 | Role | 컨트랙트 | 이관 대상 |
|---|---|---|---|
| 거버넌스(콜드→Safe) | `DEFAULT_ADMIN_ROLE` | 11개 전부 | **Safe** (모든 role 관리 권한) |
| 거버넌스(콜드→Safe) | `MINTER` | USDR, WFT | **Safe** (화폐 발행) |
| 거버넌스(콜드→Safe) | `URI_MANAGER`, `LOCK_MANAGER` | RBT | **Safe** |
| 거버넌스(콜드→Safe) | `TREASURY_ADMIN` | SeriesManager | **Safe** |
| 거버넌스(콜드→Safe) | `MARKET_ADMIN` | SpotExchange, PerpClearing | **Safe** (수수료·마켓 파라미터·pause) |
| 거버넌스(콜드→Safe) | `PAUSER` | PerpClearing | **Safe** (+ 필요시 핫 pauser 별도 유지 검토) |
| 운영(핫→operator 유지) | `SETTLEMENT` | Spot, Perp | operator |
| 운영(핫→operator 유지) | `ORACLE_PUBLISHER` | NavOracle | operator |
| 운영(핫→operator 유지) | `FUNDING`,`LIQUIDATOR` | PerpClearing | operator |
| 운영(핫→operator 유지) | `KYC_MANAGER` | KycRegistry | operator (Sumsub→체인 브릿지) |
| 운영(핫→operator 유지) | `DISTRIBUTION_MANAGER` | IncomeDistributor | operator |
| 운영(핫→operator 유지) | `TREASURY_FUNDER`,`DELINQUENCY_MANAGER` | SeriesManager | operator |

Safe가 `DEFAULT_ADMIN_ROLE`을 쥐면 운영 role도 언제든 회수/재부여 가능(키 유출 대응).

## 3. 스크립트

- `scripts/safe-transfer-admin.js` — `SAFE_ADDRESS`에 위 콜드 role 일괄 grant + 검증. `RENOUNCE_EOA=true`면
  검증 통과 후 deployer EOA의 admin/콜드 role을 renounce(**되돌릴 수 없음** — Safe 서명 리허설 후에만).
  `DRY_RUN=true`로 무전송 플랜 출력.
- `scripts/deploy-safe-fuji.js` — Fuji의 정식 Safe 1.4.1 인프라(SafeL2 싱글턴 `0x29fcB43b…`, ProxyFactory
  `0x4e1DCf7A…`, FallbackHandler `0xfd0732Dc…`, 전부 온체인 확인)로 2-of-2 프록시 배포.
- `scripts/safe-prove-2of2.js` — 샌드박스 KycRegistry로 2-of-2 거버넌스 흐름 실증(라이브 무영향).

## 4. Fuji 실증 (2026-07-07 실행 완료)

- **정식 Gnosis Safe 2-of-2 배포**: `0xAc01f7f1B2D9435335F8AC2895e6ea8A8c78a024`
  - owner A = deployer `0xC4C4…6229`, owner B = `0xB872e7aCa2293A6e0218D9031851AA6002155972`(테스트넷 전용 키, `deployments/fuji-safe.json`), threshold = 2. SafeL2 1.4.1 프록시.
- **거버넌스 실증**(샌드박스 KycRegistry `0xbfebB2537…`, 라이브 스위트 무영향):
  - admin을 Safe로 이관 → **1-of-2 서명 실행 = `GS020`(threshold 미달)로 revert** ✓
  - **2-of-2 서명 실행 = `grantRole(KYC_MANAGER, probe)` 성공**, role 반영 확인 ✓ (tx `0x4689be2b…`)
  - 결론: 배포된 Safe 2-of-2가 WeBlock AccessControl 거버넌스를 그대로 행사한다. 라이브 이관도 동일 경로.

## 5. 라이브 이관 절차 (팀 실행 — 보류 중)

라이브 컨트랙트 권한 이관은 **되돌리기 어려운 거버넌스 변경**이라 자동 실행하지 않음(자동 모드 분류기도 보류).
팀 승인 후:

1. 메인넷/타깃 체인에서 실제 Gnosis Safe 2-of-2(또는 N-of-M) 구성 — Safe UI 또는 `deploy-safe-fuji.js` 응용.
   서명자 키는 **서로 다른 하드웨어 지갑** 권장.
2. `SAFE_ADDRESS=<safe> npx hardhat run scripts/safe-transfer-admin.js --network <net>` (renounce 없이) →
   Safe가 콜드 role 보유 확인.
3. Safe로 실제 거버넌스 tx 1건 리허설(예: `MARKET_ADMIN` 파라미터 변경) — 2-of-2 서명 흐름 검증.
4. 백엔드 operator에 운영 role이 그대로 있는지 확인(정산/오라클/청산 무중단).
5. **마지막에** `RENOUNCE_EOA=true`로 deployer EOA 권한 renounce → 거버넌스가 Safe 단독이 됨.
   이후 모든 파라미터/발행/일시정지/업그레이드는 2명 서명 필요.

## 6. 남은 권고

- **자산 이관**: `feeTreasury`(SpotExchange)·`treasury`(USDR 초기공급 수령처)·InsuranceFund 잔액을 Safe로 재지정.
  SpotExchange는 `setFeeConfig(feeTreasury_, feeBps_)`(MARKET_ADMIN)로 변경. USDR 초기공급은 배포 인자라 잔액을
  Safe로 transfer. 스크립트에서 setFeeConfig 재지정은 콜드 role 이관 후 Safe로 실행.
- **불변 컨트랙트**: 현 스위트는 UUPS 프록시가 아님(불변). 파라미터·role·pause만 거버넌스 대상이며 로직 업그레이드는
  재배포+마이그레이션. 메인넷에서 업그레이드 필요성이 크면 UUPS+Timelock+Safe 조합을 별도 설계(rebuild 설계서 참조).
- 외부 감사 필수(메인넷 전). 특히 PerpClearing 전역 솔벤시 모델(SECURITY_REVIEW.md H-1).

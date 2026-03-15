# 위협 모델

## 1. 보호 대상

1. 투자자의 원금 청구권
2. 이자 청구권
3. 상환 청구권
4. RBT 소유권
5. WFT 락업 일정
6. 운영 treasury와 볼트 자산

## 2. 주요 공격자 유형

| 공격자                 | 시나리오                                         | 대응                                      |
| ---------------------- | ------------------------------------------------ | ----------------------------------------- |
| 일반 외부 사용자       | 허용되지 않은 상태 전이 호출                     | AccessControl + 상태 머신 검증            |
| 악의적 투자자          | 조기 상환/중복 청구 시도                         | 누적 부채 방식, snapshot, burn 기반 지급  |
| 악의적 판매자          | bid 체결 시 제3자에게 NFT 전송 후 대금 수령 시도 | bid fill 수령자를 maker로 고정            |
| 탈취된 treasury 운영자 | 잘못된 vault 활성화/자금 이동                    | 역할 분리 + 멀티시그 권장                 |
| 외부 토큰 리스크       | fee-on-transfer/stablecoin blacklist             | 외부 토큰 정책 사전 검증 필요             |
| 내부 운영 실수         | 잘못된 시리즈 일정/가격 설정                     | 배포 후 createSeries 검증 체크리스트 필요 |

## 3. 모듈별 위험

### 3.1 RBTSeriesManager

- 잘못된 상태 전이
- 이자/상환금 과지급
- premature maturity
- 환불/상환에서 burn과 지급 순서 불일치

### 3.2 RotatingVaultRouter

- active vault 전환 실수
- 여러 vault에 분산된 유동성 계산 실수
- 잘못된 token address 등록

### 3.3 RBTOrderBook

- escrow 자산 동결
- 체결 시 수령자 오지정
- 만료된 주문 체결

### 3.4 WFTToken

- unlock 전 전송
- cap 초과 mint
- 에어드랍 배열 길이 불일치

### 3.5 USDRToken

- 무분별한 mint
- pause 중 전송 우회

## 4. 운영 정책으로 막아야 하는 부분

1. 관리자 키는 멀티시그 사용
2. 차수 생성은 백오피스 승인 플로우 후 수행
3. 스테이블 코인 주소 화이트리스트 문서화
4. 상환 재원 입금 후 `enableRedemption` 실행 전 잔액 검증
5. 볼트 교체 시 구/신 볼트 잔액 및 허용 토큰 점검

## 5. 감사 시 추천 추가 분석

1. 상태 머신에 대한 property-based testing
2. vault rotation과 redemption dust에 대한 fuzzing
3. AccessControl 권한 조합에 대한 invariant test
4. 오더북 cancel/fill race condition 리뷰

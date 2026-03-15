# 운영 절차 문서

## 1. 초기 배포

1. `scripts/deploy.js`로 토큰 및 운영 컨트랙트 배포
2. 결과 JSON을 보관
3. 관리자 주소가 멀티시그인지 확인
4. USDT/USDC 주소가 실제 운영 토큰과 일치하는지 확인

## 2. 차수 개설

1. 자산 코드, 차수명, 판매 기간, 만기일, 발행 수량 확정
2. 결제 토큰 목록과 가격 설정
3. `scripts/create-series.js` 실행
4. 메타데이터 URI와 토큰 ID를 백오피스에 기록

## 3. 판매 운영

1. 판매 시작 전 `saleStart`, `saleEnd` 검증
2. 판매 중 백오피스에서 sold supply 모니터링
3. 완판되면 자동 활성화
4. 미완판이면 종료 후 `finalizeSale` 호출

## 4. 이자 지급

1. 해당 차수의 총 지급액 산정
2. 지급 토큰(USDT/USDC) 선택
3. 지급용 지갑에서 manager가 사용하는 treasury funder 권한 주소로 승인
4. `fundInterest(tokenId, paymentToken, amount)` 실행
5. 지급 후 백오피스에서 claimable 안내

## 5. 연체 처리

1. 예정된 이자 지급이 지연되면 `markDelinquent`
2. 연체 중에는 2차 거래가 중단됨
3. 정상화되면 `cureDelinquency`
4. 회복 불가면 `declareDefault`

## 6. 만기 및 상환

1. 정상 만기일 도래 후 `enterMaturity`
2. 상환 재원을 적립
3. `enableRedemption` 실행
4. 유저가 `redeem`로 직접 청구
5. 잔여 dust가 있으면 내부 정산 정책에 따라 마감

## 7. 볼트 교체

이자금/상환금 보관 주소를 바꿔야 할 때 사용합니다.

1. 새 vault 생성 `createVault(asset, true)`
2. 이후 자금은 새 vault로 적립
3. 기존 vault 잔액도 router가 계속 찾아서 지급
4. 필요시 `consolidate`로 구 vault 잔액을 활성 vault로 이관

## 8. WFT 운영

1. 초기 투자자 락업 배분은 `mintLocked` 또는 `createLock`
2. 마케팅 에어드랍은 `airdrop` 또는 `airdropLocked`
3. 락 해제는 만기 후 유저 `releaseUnlockedLocks` 또는 운영자 `revokeLock`

## 9. 권장 멀티시그 구조

1. `DEFAULT_ADMIN_ROLE` : 3-of-5 멀티시그
2. `OPERATOR_ROLE` : 운영 멀티시그
3. `TREASURY_FUNDER_ROLE` : 재무 멀티시그
4. `DELINQUENCY_MANAGER_ROLE` : 리스크 위원회 멀티시그

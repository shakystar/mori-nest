/**
 * 테스트 헬퍼: 제어 평면 DB를 여는 자리 (mori-nest #130 — UoW 조각 1/4).
 *
 * `openControlDatabase`는 `:memory:`를 받지 않는다 — WAL을 걸 수 없어 내구성 PRAGMA
 * 되읽기 검증이 거부한다(`src/control/db.ts`). 이관 전 `openLauncherCredentialStore(':memory:')`가
 * 서른 자리 넘게 있었으므로, 그 자리를 임시 디렉터리 파일 하나로 바꾸는 일을 여기로 모은다 —
 * 시험마다 `mkdtemp`/`rmSync`를 다시 적으면 정리를 빠뜨린 자리가 조용히 생긴다.
 *
 * 정리는 {@link onTestFinished}에 건다. 그래서 이 함수를 부르는 시험은 `afterEach`를 따로
 * 두지 않아도 DB와 디렉터리를 남기지 않는다 (호출 자리가 시험 본문 안이어야 한다는 뜻이다 —
 * `beforeEach`에서 여는 시험은 그 파일이 자기 수명을 직접 관리한다).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { onTestFinished } from 'vitest'

import { openControlDatabase, type ControlDatabase } from '../src/control/db.js'

/** 임시 디렉터리에 제어 평면 DB를 열고, 시험이 끝나면 닫고 지운다. */
export async function openTestControlDatabase(): Promise<ControlDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'mori-nest-control-db-'))
  const database = await openControlDatabase(join(dir, 'control-plane.db'))
  onTestFinished(async () => {
    await database.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return database
}

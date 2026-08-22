import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ECONOMY,
  MAX_MANAGEMENT_LEVEL,
  calculateTickEconomy,
  isManagementGoalDeadlineMissed,
  managementGoalForLevel,
  progressionDifficultyForLevel,
  segmentBuildCost,
} from './economy'

const baseInput = {
  transported: 100,
  serviceScore: 80,
  cashBalance: 10_000_000,
  totalRevenue: 0,
  revenueGoal: ECONOMY.REVENUE_GOAL,
  happiness: 78,
  score: 0,
  insolvencyTicks: 0,
  unhappyTicks: 0,
  goalReachedAtTick: null,
  tickNumber: 1,
  lines: [],
}

test('구간 공사비는 버스보다 지하철이 높고 거리에 따라 증가한다', () => {
  assert.equal(segmentBuildCost('BUS', 10), 700_000)
  assert.equal(segmentBuildCost('SUBWAY', 10), 2_500_000)
  assert.ok(segmentBuildCost('SUBWAY', 20) > segmentBuildCost('SUBWAY', 10))
})

test('매출 목표를 처음 넘을 때 한 번만 보상한다', () => {
  const result = calculateTickEconomy({
    ...baseInput,
    transported: 100,
    totalRevenue: ECONOMY.REVENUE_GOAL - 100_000,
  })

  assert.equal(result.goalReachedNow, true)
  assert.equal(result.goalReachedAtTick, 1)
  assert.equal(result.goalsCompleted, 1)
  assert.equal(result.goalLevel, 2)
  assert.deepEqual(
    { revenueGoal: result.revenueGoal, deadlineDay: result.goalDeadlineDay },
    { revenueGoal: 72_000_000, deadlineDay: 7 },
  )
  assert.equal(result.cashBalance, 10_000_000 + 500_000 + ECONOMY.GOAL_REWARD_CASH)
  assert.ok(result.score >= ECONOMY.GOAL_REWARD_SCORE)

  const next = calculateTickEconomy({
    ...baseInput,
    cashBalance: result.cashBalance,
    totalRevenue: result.totalRevenue,
    revenueGoal: result.revenueGoal,
    goalReachedAtTick: result.goalReachedAtTick,
    transported: 0,
  })
  assert.equal(next.goalReachedNow, false)
  assert.equal(next.cashBalance, result.cashBalance)
})

test('경영 목표는 단계마다 매출과 달성 기한을 높여 계속 이어진다', () => {
  assert.deepEqual(managementGoalForLevel(1), { level: 1, revenueGoal: 32_000_000, deadlineDay: 3 })
  assert.deepEqual(managementGoalForLevel(2), { level: 2, revenueGoal: 72_000_000, deadlineDay: 7 })
  assert.deepEqual(managementGoalForLevel(3), { level: 3, revenueGoal: 120_000_000, deadlineDay: 12 })

  const secondGoal = calculateTickEconomy({
    ...baseInput,
    totalRevenue: 71_900_000,
    revenueGoal: 72_000_000,
  })
  assert.equal(secondGoal.completedGoalLevel, 2)
  assert.equal(secondGoal.goalLevel, 3)
  assert.equal(secondGoal.revenueGoal, 120_000_000)
  assert.equal(secondGoal.goalDeadlineDay, 12)
  assert.equal(secondGoal.goalsCompleted, 2)
})

test('단계가 오르면 운임은 줄고 운영비 배율은 올라가 자동 레벨업이 느려진다', () => {
  const first = progressionDifficultyForLevel(1)
  const tenth = progressionDifficultyForLevel(10)
  const final = progressionDifficultyForLevel(MAX_MANAGEMENT_LEVEL)

  assert.equal(first.farePerPassenger, ECONOMY.FARE_PER_PASSENGER)
  assert.equal(first.operatingCostMultiplier, 1)
  assert.ok(tenth.farePerPassenger < first.farePerPassenger)
  assert.ok(tenth.operatingCostMultiplier > first.operatingCostMultiplier)
  assert.ok(final.farePerPassenger <= tenth.farePerPassenger)
  assert.ok(final.operatingCostMultiplier >= tenth.operatingCostMultiplier)
})

test('20단계 최종 목표는 한 번만 완료되고 다음 틱에 반복 보상하지 않는다', () => {
  const finalGoal = managementGoalForLevel(MAX_MANAGEMENT_LEVEL)
  const reached = calculateTickEconomy({
    ...baseInput,
    transported: 100,
    totalRevenue: finalGoal.revenueGoal - progressionDifficultyForLevel(MAX_MANAGEMENT_LEVEL).farePerPassenger * 100,
    revenueGoal: finalGoal.revenueGoal,
    goalReachedAtTick: 999,
  })

  assert.equal(reached.goalReachedNow, true)
  assert.equal(reached.completedGoalLevel, MAX_MANAGEMENT_LEVEL)
  assert.equal(reached.goalLevel, MAX_MANAGEMENT_LEVEL)
  assert.equal(reached.goalsCompleted, MAX_MANAGEMENT_LEVEL)
  assert.equal(reached.finalGoalReached, true)

  const next = calculateTickEconomy({
    ...baseInput,
    transported: 100,
    cashBalance: reached.cashBalance,
    totalRevenue: reached.totalRevenue,
    revenueGoal: reached.revenueGoal,
    goalReachedAtTick: reached.goalReachedAtTick,
  })
  assert.equal(next.goalReachedNow, false)
  assert.equal(next.goalsCompleted, MAX_MANAGEMENT_LEVEL)
  assert.equal(next.finalGoalReached, true)
  assert.ok(next.cashBalance < reached.cashBalance + ECONOMY.GOAL_REWARD_CASH)
})

test('기존 단일 목표 달성 도시는 보상을 중복 지급하지 않고 다음 목표로 승계한다', () => {
  const migrated = calculateTickEconomy({
    ...baseInput,
    transported: 0,
    totalRevenue: ECONOMY.REVENUE_GOAL,
    goalReachedAtTick: 100,
  })
  assert.equal(migrated.goalReachedNow, false)
  assert.equal(migrated.goalLevel, 2)
  assert.equal(migrated.goalsCompleted, 1)
  assert.equal(migrated.revenueGoal, 72_000_000)
  assert.equal(migrated.cashBalance, baseInput.cashBalance)
})

test('경영 목표는 마감일 마지막 틱까지 달성하지 못하면 게임 오버가 된다', () => {
  const deadlineBoundaryTick = 3 * 24 * 6
  const deadlineInput = {
    totalRevenue: 0,
    revenueGoal: ECONOMY.REVENUE_GOAL,
    goalReachedAtTick: null,
  }

  assert.equal(isManagementGoalDeadlineMissed({
    ...deadlineInput,
    tickNumber: deadlineBoundaryTick - 1,
  }), false)
  assert.equal(isManagementGoalDeadlineMissed({
    ...deadlineInput,
    tickNumber: deadlineBoundaryTick,
  }), true)
})

test('마감일 마지막 틱에 목표를 달성하면 성공하고 다음 목표로 진행한다', () => {
  const reached = calculateTickEconomy({
    ...baseInput,
    transported: 100,
    totalRevenue: ECONOMY.REVENUE_GOAL - 500_000,
    tickNumber: 3 * 24 * 6 - 1,
  })

  assert.equal(reached.gameOverReason, null)
  assert.equal(reached.goalReachedNow, true)
  assert.equal(reached.goalLevel, 2)
})

test('행복도는 서비스가 나빠도 틱당 최대 0.25만 하락한다', () => {
  const result = calculateTickEconomy({ ...baseInput, serviceScore: 0, happiness: 78 })
  assert.equal(result.happiness, 77.75)
  assert.equal(result.gameOverReason, null)
})

test('파산은 2게임일 유예를 모두 소진한 뒤에만 확정된다', () => {
  const before = calculateTickEconomy({
    ...baseInput,
    transported: 0,
    cashBalance: ECONOMY.BANKRUPT_LIMIT,
    insolvencyTicks: ECONOMY.GAME_OVER_GRACE_TICKS - 2,
  })
  assert.equal(before.gameOverReason, null)

  const final = calculateTickEconomy({
    ...baseInput,
    transported: 0,
    cashBalance: before.cashBalance,
    insolvencyTicks: before.insolvencyTicks,
  })
  assert.equal(final.gameOverReason, 'BANKRUPT')
})

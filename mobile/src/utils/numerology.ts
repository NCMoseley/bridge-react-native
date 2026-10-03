export function getDeepLifePath(customDate: string): {
  lifePathNumber: number
  hiddenNumbersFound: number[]
} {
  const [yearStr, monthStr, dayStr] = customDate.split('-')
  const yearNum = Number(yearStr)
  const monthNum = Number(monthStr)
  const dayNum = Number(dayStr)
  const sumDigits = (value: string | number) =>
    value.toString().split('').reduce((sum, digit) => sum + Number.parseInt(digit, 10), 0)
  const targets = [11, 22, 33, 28]
  const hiddenFound = new Set<number>()
  const checkTarget = (value: number) => {
    if (targets.includes(value)) hiddenFound.add(value)
  }

  checkTarget(monthNum)
  checkTarget(dayNum)
  checkTarget(yearNum)
  checkTarget(monthNum + dayNum)
  checkTarget(monthNum + yearNum)
  checkTarget(dayNum + yearNum)
  checkTarget(monthNum + dayNum + yearNum)
  checkTarget(sumDigits(`${yearStr}${monthStr}${dayStr}`))

  const reduceComponent = (value: string) => {
    let sum = sumDigits(value)
    while (sum > 9 && sum !== 11 && sum !== 22 && sum !== 33) {
      sum = sumDigits(sum)
    }
    return sum
  }

  const reducedMonth = reduceComponent(monthStr)
  const reducedDay = reduceComponent(dayStr)
  const reducedYear = reduceComponent(yearStr)
  checkTarget(reducedMonth)
  checkTarget(reducedDay)
  checkTarget(reducedYear)

  let finalLifePath = reducedMonth + reducedDay + reducedYear
  checkTarget(finalLifePath)
  while (
    finalLifePath > 9 &&
    finalLifePath !== 11 &&
    finalLifePath !== 22 &&
    finalLifePath !== 33
  ) {
    finalLifePath = sumDigits(finalLifePath)
  }
  checkTarget(finalLifePath)

  return {
    lifePathNumber: finalLifePath,
    hiddenNumbersFound: [...hiddenFound].sort((left, right) => left - right),
  }
}

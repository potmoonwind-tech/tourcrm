/** A new menu's name, made for you: "Barbarestan · Lunch 1", then "Lunch 2"… (counted per restaurant and meal). */
export function nextMenuName(vendorName: string, mealWord: string, existing: string[]): string {
  const base = `${vendorName.trim()} · ${mealWord}`
  const taken = existing
    .map((n) => n.trim())
    .filter((n) => n.toLowerCase().startsWith(base.toLowerCase()))
    .map((n) => Number(n.slice(base.length).trim()) || 0)
  return `${base} ${Math.max(0, ...taken) + 1}`
}

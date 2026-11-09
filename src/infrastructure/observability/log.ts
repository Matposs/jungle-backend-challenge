export function logEvent(entry: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify(entry));
}

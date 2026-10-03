/** Real operation log: every connector / Dataverse call and every transfer step is recorded here with a timestamp. */
type Listener = () => void
let lines: string[] = []
const subs = new Set<Listener>()

export function log(line: string): void {
  lines = [...lines.slice(-799), `${new Date().toISOString().slice(11, 23)}  ${line}`]
  subs.forEach((f) => f())
}
export const getLog = (): string[] => lines
export const clearLog = (): void => { lines = []; subs.forEach((f) => f()) }
export function subscribeLog(f: Listener): () => void { subs.add(f); return () => { subs.delete(f) } }

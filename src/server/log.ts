/** Writes one human-readable line. Messages never contain the token. */
export type Log = (message: string) => void;

/** A log that prefixes each line with the local time, e.g. `[14:03:27] message`. */
export function createLog(
  write: (text: string) => void = (text) => process.stdout.write(text),
  now: () => Date = () => new Date(),
): Log {
  return (message) => {
    const time = now().toLocaleTimeString('en-GB', { hour12: false });
    for (const line of message.split('\n')) {
      write(`[${time}] ${line}\n`);
    }
  };
}

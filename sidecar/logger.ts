// The sidecar's diagnostic channel. stdout is never used: kip-app reads the
// discovery file to find the port, and mixing logs into stdout would make the
// process's output ambiguous. Everything goes to stderr, tagged with a
// component so one line says where it came from.

export interface Logger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

export function createLogger (component: string): Logger {
  const write = (level: string, message: string): void => {
    process.stderr.write(`[sidecar:${component}] ${level} ${message}\n`)
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message)
  }
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {}
}

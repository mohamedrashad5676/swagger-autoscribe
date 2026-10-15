// Diagnostic output without a logging framework: the engine layer installs a
// sink; until then messages are dropped.

export type LogLevel = 'log' | 'warn';
export type LogSink = (level: LogLevel, context: string, message: string) => void;

let sink: LogSink | undefined;

export const setLogSink = (next: LogSink | undefined): void => {
  sink = next;
};

export const diagnostics = (context: string): { log(message: string): void; warn(message: string): void } => ({
  log: (message) => sink?.('log', context, message),
  warn: (message) => sink?.('warn', context, message),
});

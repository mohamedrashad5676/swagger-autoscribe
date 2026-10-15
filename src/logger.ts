import { Logger, type LoggerService } from '@nestjs/common';

export interface AutoDocLogger {
  log(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

const NOOP: AutoDocLogger = { log: () => undefined, warn: () => undefined, debug: () => undefined };

/** `false` silences everything, a LoggerService is used as-is, default is Nest's Logger. */
export function createLogger(context: string, option: boolean | LoggerService | undefined): AutoDocLogger {
  if (option === false) return NOOP;
  if (option && option !== true) {
    return {
      log: (m) => option.log(m, context),
      warn: (m) => option.warn(m, context),
      debug: (m) => option.debug?.(m, context),
    };
  }
  const nest = new Logger(context);
  return { log: (m) => nest.log(m), warn: (m) => nest.warn(m), debug: (m) => nest.debug(m) };
}

export const silentLogger = NOOP;

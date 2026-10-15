import { INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

/** Express by default; TEST_PLATFORM=fastify runs the same suites on Fastify. */
export async function createApp(module: Type<unknown>): Promise<INestApplication> {
  if (process.env.TEST_PLATFORM === 'fastify') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { FastifyAdapter } = require('@nestjs/platform-fastify');
    return NestFactory.create(module, new FastifyAdapter(), { logger: false });
  }
  return NestFactory.create(module, { logger: false });
}

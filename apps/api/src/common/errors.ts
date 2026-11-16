import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { correlationId, log } from './context';

/** Business error with a stable machine-readable code. */
export class AppError extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: number = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`, 404);
export const forbidden = (message = 'You do not have access to this resource') => new AppError('FORBIDDEN', message, 403);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, details);
export const badRequest = (code: string, message: string, details?: unknown) => new AppError(code, message, 400, details);

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
};

/** Every error leaves the API as { error: { code, message, details?, correlationId } }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown;

    if (exception instanceof AppError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as any;
      code = STATUS_CODES[status] ?? 'ERROR';
      if (Array.isArray(body?.message)) {
        code = 'VALIDATION_FAILED';
        message = 'Request validation failed';
        details = body.message;
      } else {
        message = typeof body === 'string' ? body : (body?.message ?? exception.message);
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = 409;
        code = 'DUPLICATE';
        message = 'A record with these unique values already exists';
        details = exception.meta?.target;
      } else if (exception.code === 'P2025') {
        status = 404;
        code = 'NOT_FOUND';
        message = 'Resource not found';
      } else if (exception.code === 'P2003') {
        status = 409;
        code = 'REFERENCE_CONFLICT';
        message = 'The record is referenced by, or references, another record';
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = 400;
      code = 'VALIDATION_FAILED';
      message = 'Invalid data supplied';
    }

    if (status >= 500) {
      log.error('unhandled_exception', { error: (exception as Error)?.message, stack: (exception as Error)?.stack });
    }
    if (res.headersSent) return;
    res.status(status).json({ error: { code, message, details, correlationId: correlationId() } });
  }
}

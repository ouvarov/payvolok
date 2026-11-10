import { createHash } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';

import type { ApiErrorBody } from '@/common/errors/api-exception';
import type { DatabaseTransaction } from '@/database/drizzle';

import {
  IdempotencyRepository,
  storedResponseOf,
  type IdempotencyKeyState,
  type IdempotentRequest,
  type StoredResponse,
} from './idempotency.repository';

type IdempotentResponse = StoredResponse & { isReplayed: boolean };

type ClaimHandlers = {
  onClaimed: (tx: DatabaseTransaction) => Promise<string>;
  onInterrupted: (
    tx: DatabaseTransaction,
    paymentId: string,
  ) => Promise<StoredResponse>;
};

type TakenKeyResult = {
  isOwner: false;
  response: IdempotentResponse;
  // Set only when this request ran the recovery, after it committed.
  recoveredPaymentId: string | null;
};

type ClaimResult = { isOwner: true; paymentId: string } | TakenKeyResult;

type TakenKeyDecision =
  | { action: 'respond'; response: IdempotentResponse }
  | { action: 'recover'; paymentId: string };

const errorResponseOf = (body: ApiErrorBody): IdempotentResponse => ({
  statusCode: body.statusCode,
  body,
  isReplayed: false,
});

const requestHashOf = (fields: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(fields)).digest('hex');

const decideForTakenKey = (
  request: IdempotentRequest,
  state: IdempotencyKeyState | null,
): TakenKeyDecision => {
  if (!state) throw new Error(`Idempotency key in ${request.scope} vanished`);

  if (state.requestHash !== request.requestHash) {
    return {
      action: 'respond',
      response: errorResponseOf({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'idempotency_key_reused',
        message: 'Idempotency-Key was already used with a different request',
      }),
    };
  }

  const storedResponse = storedResponseOf(
    state.responseStatus,
    state.responseBody,
  );
  if (storedResponse) {
    return {
      action: 'respond',
      response: { ...storedResponse, isReplayed: true },
    };
  }

  if (!state.isLeaseExpired) {
    return {
      action: 'respond',
      response: errorResponseOf({
        statusCode: HttpStatus.CONFLICT,
        code: 'idempotency_key_in_progress',
        message: 'A request with this Idempotency-Key is still in progress',
      }),
    };
  }

  if (state.paymentId === null) {
    throw new Error(`Idempotency key in ${request.scope} has no payment`);
  }

  return { action: 'recover', paymentId: state.paymentId };
};

@Injectable()
export class IdempotencyService {
  constructor(private readonly idempotencyRepository: IdempotencyRepository) {}

  async claim(
    request: IdempotentRequest,
    handlers: ClaimHandlers,
  ): Promise<ClaimResult> {
    const paymentId = await this.idempotencyRepository.withTransaction(
      async (tx) => {
        const isClaimed = await this.idempotencyRepository.claim(tx, request);
        if (!isClaimed) return null;

        const claimedPaymentId = await handlers.onClaimed(tx);
        await this.idempotencyRepository.setPaymentId(
          tx,
          request,
          claimedPaymentId,
        );

        return claimedPaymentId;
      },
    );
    if (paymentId !== null) return { isOwner: true, paymentId };

    const decision = decideForTakenKey(
      request,
      await this.idempotencyRepository.findState(request),
    );
    if (decision.action === 'respond') {
      return {
        isOwner: false,
        response: decision.response,
        recoveredPaymentId: null,
      };
    }

    return this.recover(request, handlers.onInterrupted);
  }

  // The key is locked before record locks the payment, in the order recovery
  // takes them, so the two cannot deadlock.
  complete(
    request: IdempotentRequest,
    paymentId: string,
    record: (tx: DatabaseTransaction) => Promise<StoredResponse>,
  ): Promise<IdempotentResponse> {
    return this.idempotencyRepository.withTransaction(async (tx) => {
      await this.idempotencyRepository.findStateForUpdate(tx, request);
      const response = await record(tx);

      return this.store(tx, request, paymentId, response);
    });
  }

  private recover(
    request: IdempotentRequest,
    onInterrupted: ClaimHandlers['onInterrupted'],
  ): Promise<TakenKeyResult> {
    return this.idempotencyRepository.withTransaction(async (tx) => {
      const decision = decideForTakenKey(
        request,
        await this.idempotencyRepository.findStateForUpdate(tx, request),
      );
      if (decision.action === 'respond') {
        return {
          isOwner: false,
          response: decision.response,
          recoveredPaymentId: null,
        };
      }

      const response = await onInterrupted(tx, decision.paymentId);

      return {
        isOwner: false,
        response: await this.store(tx, request, decision.paymentId, response),
        recoveredPaymentId: decision.paymentId,
      };
    });
  }

  private async store(
    tx: DatabaseTransaction,
    request: IdempotentRequest,
    paymentId: string,
    response: StoredResponse,
  ): Promise<IdempotentResponse> {
    const storedResponse =
      (await this.idempotencyRepository.complete(
        tx,
        request,
        paymentId,
        response,
      )) ?? (await this.recoveredResponseOf(tx, request, paymentId));

    return { ...storedResponse, isReplayed: false };
  }

  private async recoveredResponseOf(
    tx: DatabaseTransaction,
    request: IdempotentRequest,
    paymentId: string,
  ): Promise<StoredResponse> {
    const state = await this.idempotencyRepository.findStateForUpdate(
      tx,
      request,
    );
    const storedResponse =
      state?.paymentId === paymentId
        ? storedResponseOf(state.responseStatus, state.responseBody)
        : null;
    if (!storedResponse) {
      throw new Error(`Idempotency key in ${request.scope} lost its payment`);
    }

    return storedResponse;
  }
}

export { requestHashOf };
export type { ClaimHandlers, ClaimResult, IdempotentResponse };

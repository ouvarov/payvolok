import { createHash } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';

import type { ApiErrorBody } from '@/common/errors/api-exception';
import type { DatabaseTransaction } from '@/database/drizzle';

import type { IdempotencyScope } from './idempotency.constants';
import {
  IdempotencyRepository,
  storedResponseOf,
  type IdempotencyKeyState,
  type IdempotentRequest,
  type StoredResponse,
} from './idempotency.repository';

type IdempotentResponse = StoredResponse & { isReplayed: boolean };

// isLeaseLost: a recovery stored its response first, so this request's
// writes were kept but its own response was not.
type CompletedResponse = {
  response: IdempotentResponse;
  isLeaseLost: boolean;
};

type Claimed = { paymentId: string };

type ClaimHandlers<TClaimed extends Claimed> = {
  onClaimed: (tx: DatabaseTransaction) => Promise<TClaimed>;
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

type ClaimResult<TClaimed extends Claimed> =
  { isOwner: true; claimed: TClaimed } | TakenKeyResult;

type InterruptedOutcome<TResult> = {
  response: StoredResponse;
  result: TResult;
};

type CloseInterruptedResult<TResult> =
  { isClosed: false } | { isClosed: true; result: TResult };

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

  async claim<TClaimed extends Claimed>(
    request: IdempotentRequest,
    handlers: ClaimHandlers<TClaimed>,
  ): Promise<ClaimResult<TClaimed>> {
    const claimed = await this.idempotencyRepository.withTransaction(
      async (tx) => {
        const isClaimed = await this.idempotencyRepository.claim(tx, request);
        if (!isClaimed) return null;

        const claimedWork = await handlers.onClaimed(tx);
        await this.idempotencyRepository.setPaymentId(
          tx,
          request,
          claimedWork.paymentId,
        );

        return claimedWork;
      },
    );
    if (claimed !== null) return { isOwner: true, claimed };

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
  ): Promise<CompletedResponse> {
    return this.idempotencyRepository.withTransaction(async (tx) => {
      await this.idempotencyRepository.findStateForUpdate(tx, request);
      const response = await record(tx);

      return this.store(tx, request, paymentId, response);
    });
  }

  hasOtherRequestInProgress(
    tx: DatabaseTransaction,
    request: IdempotentRequest,
    paymentId: string,
  ): Promise<boolean> {
    return this.idempotencyRepository.hasOtherLiveInProgressKey(
      tx,
      request,
      paymentId,
    );
  }

  // Same lock order as recover: the key, then the payment inside onInterrupted.
  closeInterrupted<TResult>(
    scope: IdempotencyScope,
    paymentId: string,
    onInterrupted: (
      tx: DatabaseTransaction,
    ) => Promise<InterruptedOutcome<TResult>>,
  ): Promise<CloseInterruptedResult<TResult>> {
    return this.idempotencyRepository.withTransaction(async (tx) => {
      const inProgressKey =
        await this.idempotencyRepository.findInProgressByPaymentForUpdate(
          tx,
          scope,
          paymentId,
        );
      if (inProgressKey && !inProgressKey.isLeaseExpired) {
        return { isClosed: false };
      }

      const { response, result } = await onInterrupted(tx);
      if (inProgressKey) {
        await this.idempotencyRepository.complete(
          tx,
          inProgressKey,
          paymentId,
          response,
        );
      }

      return { isClosed: true, result };
    });
  }

  purgeExpired(limit: number): Promise<number> {
    return this.idempotencyRepository.purgeExpired(limit);
  }

  private recover(
    request: IdempotentRequest,
    onInterrupted: ClaimHandlers<Claimed>['onInterrupted'],
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
      const completed = await this.store(
        tx,
        request,
        decision.paymentId,
        response,
      );

      return {
        isOwner: false,
        response: completed.response,
        recoveredPaymentId: decision.paymentId,
      };
    });
  }

  private async store(
    tx: DatabaseTransaction,
    request: IdempotentRequest,
    paymentId: string,
    response: StoredResponse,
  ): Promise<CompletedResponse> {
    const storedResponse = await this.idempotencyRepository.complete(
      tx,
      request,
      paymentId,
      response,
    );
    if (storedResponse) {
      return {
        response: { ...storedResponse, isReplayed: false },
        isLeaseLost: false,
      };
    }

    const recoveredResponse = await this.recoveredResponseOf(
      tx,
      request,
      paymentId,
    );

    return {
      response: { ...recoveredResponse, isReplayed: false },
      isLeaseLost: true,
    };
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
export type {
  ClaimHandlers,
  ClaimResult,
  CloseInterruptedResult,
  CompletedResponse,
  IdempotentResponse,
  InterruptedOutcome,
};

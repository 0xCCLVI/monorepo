import { BigNumber, Signer, providers, utils } from "ethers";
import PriorityQueue from "p-queue";
import { createLoggingContext, delay, getUuid, jsonifyError, Logger, RequestContext } from "@connext/nxtp-utils";
import interval from "interval-promise";

import { Gas, WriteTransaction, Transaction } from "./types";
import {
  BadNonce,
  TransactionReplaced,
  TransactionReverted,
  TimeoutError,
  TransactionServiceFailure,
  MaxBufferLengthError,
} from "./error";
import { ChainConfig, TransactionServiceConfig } from "./config";
import { ChainRpcProvider } from "./provider";

export type DispatchCallbacks = {
  onSubmit: (transaction: Transaction) => void;
  onMined: (transaction: Transaction) => void;
  onConfirm: (transaction: Transaction) => void;
  onFail: (transaction: Transaction) => void;
};

/**
 * @classdesc Transaction lifecycle manager.
 *
 */
export class TransactionDispatch extends ChainRpcProvider {
  private loopsRunning = false;

  // Based on default per account rate limiting on geth.
  // TODO: Make this a configurable value, since the dev may be able to implement or may be using a custom geth node.
  static MAX_INFLIGHT_TRANSACTIONS = 64;
  // Buffer of in-flight transactions waiting to get 1 confirmation.
  private inflightBuffer: Transaction[] = [];

  // TODO: Cap this buffer as well. # of inflight txs max * # of confirmations needed seems reasonable as a max # of waiting-for-x-confirmations queue length
  // Buffer of mined transactions waiting for X confirmations.
  private minedBuffer: Transaction[] = [];

  private readonly submitQueue = new PriorityQueue({ concurrency: 1 });

  // The current nonce of the signer is tracked locally here. It will be used for comparison
  // to the nonce we get back from the pending transaction count call to our providers.
  // NOTE: Should not be accessed outside of the helper methods, getNonce and incrementNonce.
  private nonce = 0;

  /**
   * Transaction lifecycle management class. Extends ChainRpcProvider, thus exposing all provider methods
   * through this class.
   *
   * @param logger Logger used for logging.
   * @param signer Signer instance or private key used for signing transactions.
   * @param chainId The ID of the chain for which this class's providers will be servicing.
   * @param chainConfig Configuration for this specified chain, including the providers we'll
   * be using for it.
   * @param config The shared TransactionServiceConfig with general configuration.
   *
   * @throws ChainError.reasons.ProviderNotFound if no valid providers are found in the
   * configuration.
   */
  constructor(
    logger: Logger,
    public readonly chainId: number,
    chainConfig: ChainConfig,
    config: TransactionServiceConfig,
    signer: string | Signer,
    private readonly callbacks: DispatchCallbacks,
    startLoops = true,
  ) {
    super(logger, chainId, chainConfig, config, signer);
    if (startLoops) {
      this.startLoops();
    }
  }

  public startLoops() {
    if (!this.loopsRunning) {
      this.loopsRunning = true;

      // use interval promise to make sure loop iterations don't overlap
      interval(async () => await this.mineLoop(), 5_000);
      interval(async () => await this.confirmLoop(), 5_000);
    }
  }

  private async mineLoop() {
    const { requestContext, methodContext } = createLoggingContext(this.mineLoop.name);
    try {
      if (this.inflightBuffer.length > 0) {
        const transaction = this.inflightBuffer[0];
        try {
          if (transaction.error) {
            // This will cause us to fail the transaction properly below, and remove it from the buffer.
            throw transaction.error;
          }
          // Try to wait for transaction to be mined (1 confirmation), then remove it from the buffer.
          await this.mine(transaction);
          this.inflightBuffer.shift();
        } catch (error) {
          if (error.type === TimeoutError.type) {
            // changed logic from this:
            // if (transaction.receipt && transaction.receipt.confirmations > 1) {
            // seems like it should check for lack of receipt before bumping. no receipt means it didnt get enough gas
            // if there is a receipt we should not bump, instead we should just loop around and check again
            // Transaction timed out trying to validate. We should bump the tx and submit again.
            await this.bump(transaction);
            // Resubmit
            await this.submit(transaction);

            // TODO: Better solution for bumping for all transactions / gas management (caching? moving avg? etc).
            // Bump all the other transactions in the buffer as well, since they will likely also have to be bumped to get through.
            for (const tx of this.inflightBuffer.slice(1)) {
              // If something fails here (e.g. if submit gets reverted, etc), the error will be attached to the transaction
              // and we'll shift it out of the buffer as soon as this mineloop reaches it.
              try {
                await this.bump(tx);
                await this.submit(tx);
              } catch (error) {
                tx.error = error;
              }
            }
          } else {
            transaction.error = transaction.error ?? error;
            this.fail(transaction);
            this.inflightBuffer.shift();
          }
        }
      }
    } catch (error) {
      this.logger.error("Error in mine loop.", requestContext, methodContext, jsonifyError(error));
    }
  }

  private async confirmLoop() {
    const { requestContext, methodContext } = createLoggingContext(this.confirmLoop.name);
    try {
      if (this.minedBuffer.length > 0) {
        const transaction = this.minedBuffer[0];
        try {
          // Checks to make sure we hit the target number of confirmations.
          await this.confirm(transaction);
          this.minedBuffer.shift();
        } catch (error) {
          transaction.error = error;
          await this.fail(transaction);
          this.minedBuffer.shift();
        }
      }
    } catch (error) {
      this.logger.error("Error in confirm loop.", requestContext, methodContext, jsonifyError(error));
    }
  }

  /// LIFECYCLE
  /**
   *
   * @param minTx - Minimum transaction params needed to form a transaction.
   * @param context - Request context object used for logging.
   *
   * @returns A list of receipts or errors that occurred for each.
   */
  public async send(minTx: WriteTransaction, context: RequestContext): Promise<providers.TransactionReceipt> {
    const { requestContext, methodContext } = createLoggingContext(this.send.name, context);
    const txsId = getUuid();
    this.logger.debug("Method start", requestContext, methodContext, {
      chainId: this.chainId,
      minTx: { to: minTx.to, from: minTx.from },
      txsId,
    });

    const result = await this.submitQueue.add(async (): Promise<{ value: Transaction | Error; success: boolean }> => {
      try {
        if (this.inflightBuffer.length >= TransactionDispatch.MAX_INFLIGHT_TRANSACTIONS) {
          throw new MaxBufferLengthError();
        }

        // Estimate gas here will throw if the transaction is going to revert on-chain for "legit" reasons. This means
        // that, if we get past this method, we can *generally* assume that the transaction will go through on submit - although it's
        // still possible to revert due to a state change below.
        const gas = await this.getGas(minTx, requestContext);

        // Retrieve the current mined transaction count and our local nonce.
        const result = await this.getTransactionCount();
        if (result.isErr()) {
          throw result.error;
        }
        const minedTransactionCount = result.value;

        // Set to whichever value is higher. This should almost always be our local nonce.
        let nonce = Math.max(this.nonce, minedTransactionCount);

        // Here we are going to ensure our initial submit gets through at the correct nonce. If all goes well, it should
        // go through on the first try.
        let transaction: Transaction | undefined = undefined;
        this.logger.debug("Sending initial submit for transaction.", requestContext, methodContext, {
          chainId: this.chainId,
          currentNonce: {
            minedTransactionCount,
            localNonce: this.nonce,
            assignedNonce: nonce,
          },
        });
        // It should never take more than MAX_INFLIGHT_TRANSACTIONS + 2 iterations to get the transaction through.
        let iterations = 0;
        // Need to keep a flag for this, as we continually get vague "nonce incorrect errors", and once we reset the nonce, we only want
        // to increment and retry from there.
        let nonceWasReset = false;
        while (
          iterations < TransactionDispatch.MAX_INFLIGHT_TRANSACTIONS + 2 &&
          (!transaction || !transaction.didSubmit)
        ) {
          iterations++;
          // Create a new transaction instance to track lifecycle. We will be submitting below.
          transaction = new Transaction(
            requestContext,
            minTx,
            nonce,
            gas,
            {
              confirmationTimeout: this.confirmationTimeout,
              confirmationsRequired: this.confirmationsRequired,
            },
            txsId,
          );
          try {
            await this.submit(transaction);
          } catch (error) {
            if (error.type === BadNonce.type) {
              if (
                error.reason === BadNonce.reasons.NonceExpired ||
                // TODO: Should replacement underpriced result in us raising the gas price and attempting to override the transaction?
                // Or should we treat the nonce as expired?
                error.reason === BadNonce.reasons.ReplacementUnderpriced ||
                nonceWasReset
              ) {
                // Currently only two possibilities are known to (potentially) cause this to happen:
                // 1. Signer used outside of this class to send tx (should never happen).
                // 2. The router was rebooted, and our nonce has not yet caught up with that in the current pending pool of txs.
                nonce = nonce + 1;
                // TODO: Alternatively, we could retrieve the minedTransactionCount again and set the nonce to Math.max(minedTransactionCount, nonce + 1)
                continue;
              } else if (error.reason === BadNonce.reasons.NonceIncorrect) {
                // It's unknown whether nonce was too low or too high. For safety, reset the nonce to the current mined tx count.
                // It should bump up in this loop until it hits the right number.
                nonce = minedTransactionCount;
                nonceWasReset = true;
                continue;
              }
            }
            // This could be a reverted error, etc.
            throw error;
          }
        }
        if (!transaction) {
          throw new TransactionServiceFailure(
            "Transaction never submitted: exceeded maximum iterations in initial submit loop.",
          );
        }
        // Push submitted transaction to inflight buffer.
        this.inflightBuffer.push(transaction);
        // Increment the successful nonce, and assign our local nonce to that value.
        this.nonce = nonce + 1;
        return { value: transaction, success: true };
      } catch (error) {
        return { value: error, success: false };
      }
    });

    if (!result.success) {
      throw result.value;
    }

    const transaction = result.value as Transaction;
    // Wait for transaction to be picked up by the mine and confirm loops and closed out.
    while (!transaction.didFinish && !transaction.discontinued) {
      await delay(10_000);
    }

    if (transaction.error) {
      throw transaction.error;
    }

    if (!transaction.receipt) {
      throw new Error("Transaction did not return a receipt");
    }

    return transaction.receipt;
  }

  private async submit(transaction: Transaction) {
    const method = this.submit.name;
    const { requestContext, methodContext } = createLoggingContext(method, transaction.context);

    // Check to make sure we haven't already mined this transaction.
    if (transaction.didFinish) {
      // NOTE: We do not set this._error here, as the transaction hasn't failed - just the txservice.
      throw new TransactionServiceFailure("Submit was called but transaction is already completed.", { method });
    }

    // Check to make sure this tx hasn't been killed.
    if (transaction.discontinued) {
      throw new TransactionServiceFailure("Tried to resubmit discontinued transaction.", { method });
    }

    // Check to make sure that, if this is a replacement tx, the replacement gas is higher.
    if (transaction.responses.length > 0) {
      // NOTE: There *should* always be a gasPrice in every response, but it is
      // defined as optional. Handle that case?
      // If there isn't a lastPrice, we're going to skip this validation step.
      const lastPrice = transaction.responses[transaction.responses.length - 1].gasPrice;
      if (lastPrice && transaction.gas.price.lte(lastPrice)) {
        // NOTE: We do not set this._error here, as the transaction hasn't failed - just the txservice.
        throw new TransactionServiceFailure("Gas price was not incremented from last transaction.", { method });
      }
    }

    // Increment transaction # attempts made.
    transaction.attempt++;
    // Set the timestamp according to when we last submitted.
    transaction.timestamp = Date.now();

    // Send the tx.
    const result = await this.sendTransaction(transaction);
    // If we end up with an error, it should be thrown here.
    if (result.isErr()) {
      transaction.error = result.error;
      throw result.error;
    }

    // Add this response to our local response history.
    const response = result.value;
    transaction.responses.push(response);

    this.callbacks.onSubmit(transaction);

    this.logger.info(`Tx submitted.`, requestContext, methodContext, {
      chainId: this.chainId,
      transaction: transaction.loggable,
    });
  }

  private async mine(transaction: Transaction) {
    const method = this.mine.name;
    const { requestContext, methodContext } = createLoggingContext(method, transaction.context);

    // Ensure we've submitted at least 1 tx.
    if (!transaction.didSubmit) {
      throw new TransactionServiceFailure("Transaction mine was called, but no transaction has been sent.", {
        method,
        chainId: this.chainId,
        transaction: transaction.loggable,
      });
    }

    // Now we attempt to confirm the first response among our attempts. If it fails due to replacement,
    // we'll get back the replacement's receipt from confirmTransaction.
    const response = transaction.minedResponse ?? transaction.responses[0];

    // Get receipt for tx with at least 1 confirmation. If it times out (using default, configured timeout),
    // it will throw a TransactionTimeout error.
    const result = await this.confirmTransaction(response, 1);
    if (result.isErr()) {
      const { error: _error } = result;
      if (_error.type === TransactionReplaced.type) {
        const error = _error as TransactionReplaced;
        // TODO: #150 Should we handle error.reason?:
        // error.reason - a string reason; one of "repriced", "cancelled" or "replaced"
        // error.receipt - the receipt of the replacement transaction (a TransactionReceipt)
        transaction.receipt = error.receipt;
        // error.replacement - the replacement transaction (a TransactionResponse)
        if (!error.replacement) {
          throw new TransactionServiceFailure(
            "Transaction was replaced, but no replacement transaction was returned.",
            {
              method,
              chainId: this.chainId,
              transaction: transaction.loggable,
            },
          );
        }
        // Validate that we've been replaced by THIS transaction (and not an unrecognized transaction).
        if (!transaction.responses.map((response) => response.hash).includes(error.replacement.hash)) {
          transaction.error = error;
          throw error;
        }
        transaction.minedResponse = error.replacement;
      } else if (_error.type === TransactionReverted.type) {
        const error = _error as TransactionReverted;
        // NOTE: This is the official receipt with status of 0, so it's safe to say the
        // transaction was in fact reverted and we should throw here.
        transaction.receipt = error.receipt;
        transaction.error = error;
        throw error;
      } else {
        transaction.error = _error;
        throw _error;
      }
    } else {
      const receipt = result.value;
      // Sanity checks.
      if (receipt == null) {
        // Receipt is undefined or null. This should never occur; timeout should occur before this does,
        // as a null receipt indicates 0 confirmations.
        throw new TransactionServiceFailure("Unable to obtain receipt: ethers responded with null.", {
          method,
          chainId: this.chainId,
          receipt,
          hash: transaction.minedResponse?.hash,
          transaction: transaction.loggable,
        });
      } else if (receipt.status === 0) {
        // This should never occur. We should always get a TransactionReverted error in this event.
        throw new TransactionServiceFailure("Transaction was reverted but TransactionReverted error was not thrown.", {
          method,
          chainId: this.chainId,
          receipt,
          hash: transaction.minedResponse?.hash,
          transaction: transaction.loggable,
        });
      } else if (receipt.confirmations < 1) {
        // Again, should never occur.
        throw new TransactionServiceFailure("Receipt did not have any confirmations, should have timed out!", {
          method,
          chainId: this.chainId,
          receipt: transaction.receipt,
          hash: transaction.minedResponse?.hash,
          transaction: transaction.loggable,
        });
      }
      // Set transaction's receipt.
      transaction.receipt = receipt;
    }

    this.callbacks.onMined(transaction);
    this.logger.info(`Tx mined.`, requestContext, methodContext, {
      chainId: this.chainId,
      transaction: transaction.loggable,
    });
  }

  /**
   * Makes an attempt to confirm this transaction, waiting up to a designated period to achieve
   * a desired number of confirmation blocks. If confirmation times out, throws TimeoutError.
   * If all txs, including replacements, are reverted, throws TransactionReverted.
   *
   * @privateRemarks
   *
   * Ultimately, we should see 1 tx accepted and confirmed, and the rest - if any - rejected (due to
   * replacement) and confirmed. If at least 1 tx has been accepted and received 1 confirmation, we will
   * wait an extended period for the desired number of confirmations. If no further confirmations appear
   * (which is extremely unlikely), we throw a TransactionServiceFailure.NotEnoughConfirmations.
   *
   * @param transaction -
   */
  private async confirm(transaction: Transaction) {
    const method = this.confirm.name;
    const { requestContext, methodContext } = createLoggingContext(method, transaction.context);

    if (!transaction.minedResponse) {
      throw new TransactionServiceFailure(
        "Tried to confirm but tansaction was not validated; no minedResponse was found.",
        {
          method,
          chainId: this.chainId,
          minedResponse: transaction.minedResponse,
          transaction: transaction.loggable,
        },
      );
    }

    // Here we wait for the target confirmations.
    // TODO: Ensure we are comfortable with how this timeout period is calculated.
    const timeout = this.confirmationTimeout * this.confirmationsRequired * 2;
    const response = transaction.minedResponse;
    const confirmResult = await this.confirmTransaction(response, this.confirmationsRequired, timeout);
    if (confirmResult.isErr()) {
      transaction.error = confirmResult.error;
      if (confirmResult.error.type === TimeoutError.type) {
        // This implies a re-org occurred.
        throw confirmResult.error;
      }
      // No other errors should occur during this confirmation attempt.
      throw new TransactionServiceFailure(TransactionServiceFailure.reasons.NotEnoughConfirmations, {
        method,
        chainId: this.chainId,
        receipt: transaction.receipt,
        error: transaction.error,
        hash: response.hash,
        transaction: transaction.loggable,
      });
    }
    const receipt = confirmResult.value;
    if (receipt == null) {
      // Should never occur.
      throw new TransactionServiceFailure("Transaction receipt was null.", {
        method,
        chainId: this.chainId,
        badReceipt: receipt,
        minedReceipt: transaction.receipt,
        hash: response.hash,
        transaction: transaction.loggable,
      });
    }
    transaction.receipt = receipt;

    this.callbacks.onConfirm(transaction);
    this.logger.info(`Tx confirmed.`, requestContext, methodContext, {
      chainId: this.chainId,
      receipt: {
        gasUsed: receipt.gasUsed.toString(),
        transactionHash: receipt.transactionHash,
        blockHash: receipt.blockHash,
      },
      transaction: transaction.loggable,
    });
  }

  /**
   * Bump the gas price for this tx up by the configured percentage.
   */
  public async bump(transaction: Transaction) {
    const { requestContext, methodContext } = createLoggingContext(this.bump.name, transaction.context);
    if (transaction.attempt >= Transaction.MAX_ATTEMPTS) {
      const error = new TransactionServiceFailure(TransactionServiceFailure.reasons.MaxAttemptsReached, {
        gasPrice: `${utils.formatUnits(transaction.gas.price, "gwei")} gwei`,
        transaction: transaction.loggable,
      });
      transaction.error = error;
      throw error;
    }
    const previousPrice = transaction.gas.price;
    // Get the current gas baseline price, in case it's changed drastically in the last block.
    const result = await this.getGasPrice(requestContext);
    const updatedPrice = result.isOk() ? result.value : BigNumber.from(0);
    const determinedBaseline = updatedPrice.gt(previousPrice) ? updatedPrice : previousPrice;
    // Scale up gas by percentage as specified by config.
    transaction.gas.price = determinedBaseline
      .add(determinedBaseline.mul(this.config.gasReplacementBumpPercent).div(100))
      .add(1);
    this.logger.info(`Bumping tx gas price for reattempt.`, requestContext, methodContext, {
      chainId: this.chainId,
      latestAvgPrice: `${utils.formatUnits(updatedPrice, "gwei")} gwei`,
      previousPrice: `${utils.formatUnits(previousPrice, "gwei")} gwei`,
      newGasPrice: `${utils.formatUnits(transaction.gas.price, "gwei")} gwei`,
      transaction: transaction.loggable,
    });
  }

  private async fail(transaction: Transaction) {
    const { requestContext, methodContext } = createLoggingContext(this.fail.name, transaction.context);
    transaction.discontinued = true;
    this.callbacks.onFail(transaction);
    this.logger.error(
      "Tx failed.",
      requestContext,
      methodContext,
      jsonifyError(transaction.error ?? new Error("No transaction error was present.")),
      {
        chainId: this.chainId,
        transaction: transaction.loggable,
      },
    );
  }

  /// HELPERS
  /**
   * A helper method to get the Gas tracker instance, which is used to hold price and limit.
   *
   * @param transaction - The transaction to get the Gas tracker for.
   *
   * @returns A GasTracker instance.
   *
   * @throws TransactionReverted if gas estimate fails.
   */
  private async getGas(transaction: WriteTransaction, context?: RequestContext): Promise<Gas> {
    const { requestContext, methodContext } = createLoggingContext(this.getGas.name, context);
    // Get gas estimate.
    let gasLimit: BigNumber;
    let result = await this.estimateGas(transaction);
    if (result.isErr()) {
      if (result.error.type === TransactionReverted.type) {
        // If we get a TransactionReverted error, that means the gas estimate call
        // indicated our transaction would fail on-chain. The details of the failure will
        // be included in the error.
        throw result.error;
      }
      this.logger.warn("Estimate gas failed due to an unexpected error.", requestContext, methodContext, {
        transaction: transaction,
        error: jsonifyError(result.error),
      });
      throw result.error;
    } else {
      gasLimit = result.value;
    }

    // Get gas price and create tracker instance.
    result = await this.getGasPrice(requestContext);
    if (result.isErr()) {
      throw result.error;
    }
    return new Gas(result.value, gasLimit);
  }
}

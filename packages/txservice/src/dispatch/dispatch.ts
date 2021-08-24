import { BigNumber, Signer } from "ethers";
import { BaseLogger } from "pino";
import PriorityQueue from "p-queue";
import { delay, jsonifyError } from "@connext/nxtp-utils";

import { Gas, WriteTransaction } from "../types";
import { TransactionReverted } from "../error";
import { ChainConfig, TransactionServiceConfig } from "../config";

import { ChainRpcProvider } from "./provider";
import { Transaction } from "./transaction";
import { TransactionBuffer } from "./buffer";

// TODO: Make poll parity (in ms) configurable
const MONITOR_POLL_PARITY = 5_000;
// How many attempts until we consider a blocking tx as taking too long.
const TOO_MANY_ATTEMPTS = 5;

/**
 * @classdesc Wraps and monitors transaction queue; handles transactions' initial creation and nonce assignment.
 *
 * All transactions created through txservice must go through here.
 */
export class TransactionDispatch extends ChainRpcProvider {
  // This queue is used for creation of Transactions - specifically, for assigning nonce.
  private readonly queue: PriorityQueue = new PriorityQueue({ concurrency: 1 });
  // Buffer for monitoring transactions locally. Enables us to perform lookback and ensure all of them get through.
  private readonly buffer: TransactionBuffer = new TransactionBuffer();
  // Flag to indicate whether we should continue monitoring. This will stop the loop if flipped.
  private shouldMonitor = true;
  private isActive = false;

  /**
   * Centralized transaction monitoring class. Extends ChainRpcProvider, thus exposing all provider methods
   * through this class.
   *
   * @param logger pino.BaseLogger used for logging.
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
    logger: BaseLogger,
    signer: string | Signer,
    public readonly chainId: number,
    chainConfig: ChainConfig,
    config: TransactionServiceConfig,
    startMonitor = true,
  ) {
    super(logger, signer, chainId, chainConfig, config);
    // A separate loop will make sure they get through or get backfilled.
    if (startMonitor) {
      this.startMonitor();
    }
  }

  public stopMonitor() {
    this.shouldMonitor = false;
  }

  public startMonitor() {
    this.shouldMonitor = true;
    if (!this.isActive) {
      this.isActive = true;
      this.monitorLoop();
    }
  }

  /**
   * This will create a transaction with an assigned nonce as well as estimated gas / set gas price.
   * We use this structure to essentially enforce all created transactions are saved locally in the buffer for
   * continue monitoring, thus enabling us to further ensure they all go through.
   *
   * @param minTx - Minimum transaction params needed to form a transaction for sending.
   *
   * @returns Transaction instance with populated params, ready for submit.
   */
  public async createTransaction(minTx: WriteTransaction): Promise<Transaction> {
    // Make sure we haven't aborted dispatch.
    this.assertNotAborted();
    // Estimate gas here will throw if the transaction is going to revert on-chain for "legit" reasons. This means
    // that, if we get past this method, we can safely assume that the transaction will go through on submit, saving for
    // instances where the provider malfunctions.
    const gas = await this.getGas(minTx);
    // Queue up the transaction with these values.
    const result = await this.queue.add(async (): Promise<{ value: Transaction | Error; success: boolean }> => {
      try {
        // NOTE: This call must be here, serialized within the queue, as it is dependent on current pending transaction count.
        const nonce = await this.getNonce();
        // Create a new transaction instance to track lifecycle. We will NOT be submitting here.
        const transaction = new Transaction(this.logger, this, minTx, nonce, gas);
        this.buffer.insert(nonce, transaction);
        return { value: transaction, success: true };
      } catch (e) {
        return { value: e, success: false };
      }
    });
    if (result.success) {
      return result.value as Transaction;
    } else {
      throw result.value;
    }
  }

  private async getGas(transaction: WriteTransaction): Promise<Gas> {
    const method = this.getGas.name;
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
      this.logger.warn(
        {
          method,
          transaction: transaction,
          error: result.error,
        },
        "Estimate gas failed due to an unexpected error.",
      );
      throw result.error;
    } else {
      gasLimit = result.value;
    }

    // Get gas price and create tracker instance.
    result = await this.getGasPrice();
    if (result.isErr()) {
      throw result.error;
    }
    const gas = new Gas(result.value, gasLimit);
    return gas;
  }

  /**
   * Get the current nonce value. Should ONLY ever be called within a serialized
   * queue.
   *
   * @remarks
   * Caller should still be prepared to get the incorrect nonce back. For instance,
   * if the provider that just handled our sent tx has suddenly gone offline, this
   * method may give the wrong nonce. This can be solved by making additional calls to
   * submit the tx.
   *
   * @returns A number value for the current nonce.
   */
  private async getNonce(): Promise<number> {
    // Update nonce value to greatest of all nonce values retrieved.
    const buffer = this.buffer.getLastNonce() ?? -1;
    const result = await this.getTransactionCount();
    if (result.isErr()) {
      throw result.error;
    }
    // If transaction buffer above returns null, that indicates the buffer is empty; meaning
    // we haven't sent any transactions yet, and we'll use this value here.
    const pending = result.value;
    // Increment if we got back a value from buffer as we want the value of last tx's nonce + 1.
    return Math.max(buffer + 1, pending);
  }

  private async monitorLoop() {
    // TODO: Make sure this loop is throw-proof
    // TODO: Throttle this loop during lulls in traffic, speed up during high load??
    while (this.shouldMonitor) {
      await delay(MONITOR_POLL_PARITY);
      await this.monitor();
    }
    this.isActive = false;
  }

  public async monitor(): Promise<void> {
    // Lazy solution: we only care about a potential hold-up if it could hold anything up.
    if (this.buffer.pending().length < 2) {
      await delay(MONITOR_POLL_PARITY);
      return;
    }
    const result = await this.getTransactionCount();
    if (result.isErr()) {
      this.logger.error({ err: jsonifyError(result.error) }, "Failed to get transaction count");
      // TODO: If we keep getting failures due to RPC issue, escape out?
      return;
    }
    const currentNonce = result.value ?? -1;
    // Buffer's last nonce must be defined, assuming there is at least 2 pending transactions.
    const lastNonce = this.buffer.getLastNonce()!;
    if (currentNonce > lastNonce) {
      // If the pending transaction count > buffer's last nonce, then we are all caught up; all tx's are
      // indexed, meaning their nonces have been used and there won't be any need to backfill.
      // We can probably wait at least another poll cycle safely in this case (to avoid hammering provider).
      await delay(MONITOR_POLL_PARITY);
      return;
    }
    const tx: Transaction | undefined = this.buffer.get(currentNonce);
    if (!tx) {
      // This is a "legit" nonce gap!
      await this.backfill(currentNonce, undefined, "NOT_FOUND");
    } else {
      if (tx.didFinish || tx.isBackfill) {
        // IF the transaction did finish already, or this is already being backfilled (from a previous iteration
        // here), we can ignore this one.
        // TODO: Do we actually want to proceed even if a tx IS a backfill? What would that accomplish? Because if
        // even the backfill isn't working, then how would ANOTHER backfill solve anything? In fact, maybe we want to
        // shut things down if even a backfill tx isn't going through?
        return;
      }
      // Check to make sure that the transaction has leftover time to live.
      const ttl = tx.timeUntilExpiry();
      if (ttl < 0) {
        await this.backfill(currentNonce, tx, "EXPIRED");
      } else {
        if (tx.attempt > TOO_MANY_ATTEMPTS) {
          // This will mark a transaction for death, but it does get 1 hail mary; the transaction
          // can still attempt to confirm whatever's currently been submitted.
          // TODO: Alternatively, we could give this tx a hail mary by allowing it to submit at max gas BEFORE
          // we kill it... ensuring that there is indeed no hope of getting it through before we give up entirely.
          await tx.kill();
          // Make sure that the transaction didn't manage to confirm.
          if (tx.didFinish) {
            return;
          }
          await this.backfill(currentNonce, tx, "TAKING_TOO_LONG");
        }
      }
    }
  }

  private async backfill(nonce: number, blockade: Transaction | undefined, reason: string) {
    const method = this.backfill.name;
    try {
      this.logger.error(
        {
          method,
          nonce,
          id: blockade?.id,
          timestamp: blockade?.timestamp,
          blockade: blockade?.params,
          hashes: blockade?.responses.map((r) => r.hash),
        },
        `Transaction requires backfill: ${reason}`,
      );
      const addressResult = await this.getAddress();
      if (addressResult.isErr()) {
        throw addressResult.error;
      }
      // Sending a 0 wei transaction to fill the gap. We only have to eat the cost of gas here.
      const minTx: WriteTransaction = {
        chainId: this.chainId,
        value: BigNumber.from(0),
        data: "0x",
        to: addressResult.value,
      };
      const gas = await this.getGas(minTx);
      // Set gas to maximum.
      gas.setToMax();
      // Create transaction, and forcefully overwrite the stale one (blockade) in the buffer.
      const transaction = new Transaction(this.logger, this, minTx, nonce, gas, true);
      this.buffer.insert(nonce, transaction, true);

      const result = await this.sendTransaction(transaction);
      if (result.isErr()) {
        throw result.error;
      }
      this.logger.info(
        {
          method,
          nonce,
          blockadeId: blockade?.id,
          backfillId: transaction.id,
        },
        "Backfill completed successfully",
      );
    } catch (error) {
      // Backfill failed, we should shut the system down.
      this.logger.error(
        {
          method,
          nonce,
          backfilledTxId: blockade?.id,
          error,
        },
        "Backfill failed",
      );
      // Raise the abort flag.
      this.aborted = error;
    }
  }
}

import { providers } from "ethers";
import { RequestContext } from "@connext/nxtp-utils";

import { FullTransaction, Gas, WriteTransaction } from "./types";

type TransactionConfig = {
  confirmationTimeout: number;
  confirmationsRequired: number;
};

/**
 * @classdesc A data structure for storing invariant params and managing state related to a single transaction.
 */
export class Transaction {
  // TODO: Temp solution - will be replaced by batching solution.
  // How many attempts until we consider a blocking tx as taking too long.
  public static MAX_ATTEMPTS = 99999;

  // Responses, in the order of attempts made for this tx.
  public responses: providers.TransactionResponse[] = [];

  // Response that was accepted on-chain (this reference will be used in the event that replacements are made).
  public minedResponse: providers.TransactionResponse | undefined = undefined;

  // Receipt that we received for the on-chain transaction that was mined with
  // the desired number of confirmations.
  public receipt?: providers.TransactionReceipt;

  // TODO: private setter
  // Timestamp initially set on creation, but will be updated each time submit() is called.
  public timestamp: number = Date.now();

  // Indicates whether this transaction has been killed by monitor loop.
  public discontinued = false;

  // This error will be set in the instance of a failure.
  public error: Error | undefined;

  // Which transaction attempt we are on.
  public attempt = 0;

  public get hash(): string | undefined {
    return this.receipt
      ? this.receipt.transactionHash
      : this.minedResponse
      ? this.minedResponse.hash
      : this.responses.length > 0
      ? this.responses[this.responses.length - 1].hash
      : undefined;
  }

  public get hashes(): string[] {
    return this.responses.map((tx) => tx.hash);
  }

  // Whether this transaction has been validated (received at least 1 confirmation).
  // This flag will be flipped once validate() is called and validation is successful.
  private _validated = false;
  public get validated(): boolean {
    return this._validated;
  }

  /**
   * Specifies whether the transaction has been submitted.
   * @returns boolean indicating whether the transaction is submitted.
   */
  public get didSubmit(): boolean {
    return this.responses.length > 0;
  }

  /**
   * Specifies whether the transaction has been completed - meaning that it's been
   * mined and has received the target number of confirmations.
   * @returns boolean indicating whether the transaction is completed.
   */
  public get didFinish(): boolean {
    return !!this.receipt && this.receipt.confirmations >= this.config.confirmationsRequired;
  }

  /**
   * Retrieves all params needed to format a full transaction, including current gas price set, nonce, etc.
   */
  public get params(): FullTransaction {
    return {
      ...this.minTx,
      gasPrice: this.gas.price,
      nonce: this.nonce,
      gasLimit: this.gas.limit,
    };
  }

  /**
   * A data structure used for management of the lifecycle of one on-chain transaction.
   *
   * @param context - Logging context.
   * @param minTx - The minimum transaction data required to send a transaction.
   * @param nonce - Assigned nonce number for this transaction.
   * @param gas - The Gas tracker instance, which will include price, limit, and maximum.
   * @param config - Tr
   */
  constructor(
    public readonly context: RequestContext,
    public readonly minTx: WriteTransaction,
    public readonly nonce: number,
    public readonly gas: Gas,
    private readonly config: TransactionConfig,
  ) {}
}
